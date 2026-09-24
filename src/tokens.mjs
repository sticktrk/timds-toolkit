// Derive design tokens from a built artifact's stylesheets.
//
// A TimDS design system declares its brand once, as CSS custom properties, and
// every surface it ships consumes those. Agents and pipelines need the same
// values without parsing CSS or maintaining a hand-copied JSON file that
// drifts. This module reads the stylesheets the built pages actually load,
// harvests every custom property by scope, resolves `var()` chains, and
// classifies the results so `tokens.json` can sit beside `index.json` as a
// generated, contract-shaped view of the brand.
//
// Nothing here is design-system specific: the parser keys on CSS syntax alone
// and the scope model (a selector under optional conditional at-rules) is how
// the cascade already works.

import { derivedFilePath, readDerivedLayer } from "./derived.mjs";
import { attr, byTag, findAll, parseHtml } from "./html.mjs";

export const TOKENS_SCHEMA_VERSION = 1;

/**
 * The brand roles every consumer can ask for by name, with the token names
 * that fill each one by convention when `timds.json brand.roles` does not say
 * otherwise. Candidates are tried in order against the document scope and
 * must have the role's kind. The vocabulary mirrors the video contract's
 * brand block so one name means one thing everywhere.
 */
export const BRAND_ROLES = Object.freeze({
  "color.background": ["--color-background", "--color-canvas", "--background", "--canvas", "--color-bg", "--bg"],
  "color.panel": ["--color-panel", "--color-surface", "--panel", "--surface"],
  "color.accent": ["--color-accent", "--accent", "--color-primary", "--primary", "--brand"],
  "color.text": ["--color-text", "--color-ink", "--text", "--ink", "--color-fg", "--fg"],
  "color.muted": ["--color-muted", "--color-text-muted", "--muted", "--text-muted"],
  "font.display": ["--font-display", "--font-heading", "--font-headline", "--font-serif", "--display"],
  "font.body": ["--font-body", "--font-text", "--font-sans", "--body"],
  "font.ui": ["--font-ui", "--font-sans", "--font-body", "--ui"],
});
const ROLE_KINDS = Object.freeze({ color: "color", font: "font-family" });
const ROLE_PATTERN = /^(color|font)\.[a-z][a-z0-9-]*$/;
const TOKEN_NAME_PATTERN = /^--[a-zA-Z0-9_-]+$/;

const MAX_RESOLUTION_DEPTH = 16;
// `@layer` orders the cascade but does not condition it, so it never makes a
// scope conditional.
const TRANSPARENT_AT_RULES = new Set(["layer"]);
const GENERIC_FONT_FAMILIES = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif",
  "ui-monospace", "ui-rounded", "emoji", "math", "fangsong",
]);

/* ── stylesheet discovery ───────────────────────────────────────────────── */

const isExternal = (value) => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value);

/**
 * The stylesheets a page loads: `<link rel="stylesheet">` targets in document
 * order and the text of every inline `<style>`. Resolution against the
 * artifact is the caller's job; this only reads the markup.
 */
export function stylesheetReferences(html) {
  const document = parseHtml(html);
  const links = byTag(document, "link")
    .filter((node) => String(attr(node, "rel") ?? "").toLowerCase().split(/\s+/).includes("stylesheet"))
    .map((node) => String(attr(node, "href") ?? "").trim())
    .filter((href) => href && !isExternal(href));
  // The HTML parser keeps <style> as raw text; the visible-text helpers skip
  // it on purpose, so read its text children directly.
  const inline = findAll(document, (node) => node.tag === "style")
    .map((node) => (node.children ?? []).filter((child) => child.type === "text").map((child) => child.value).join(""))
    .filter((text) => text.trim());
  return { links, inline };
}

/** `@import` targets of a stylesheet, relative to that stylesheet. */
export function importReferences(css) {
  const references = [];
  const pattern = /@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?[^;]*;/gi;
  for (const match of css.matchAll(pattern)) {
    if (!isExternal(match[1])) references.push(match[1]);
  }
  return references;
}

/* ── CSS scanning ───────────────────────────────────────────────────────── */

/**
 * A minimal block scanner: enough CSS structure to find custom property
 * declarations and the selector / at-rule chain each one sits under. Strings,
 * parentheses, and comments are respected so a `;` inside `url(data:…)` or a
 * quoted font name never splits a declaration.
 */
function scanBlocks(css) {
  const root = { prelude: null, declarations: [], children: [] };
  const stack = [root];
  let buffer = "";
  let index = 0;
  let parenDepth = 0;

  const flushDeclaration = () => {
    const text = buffer.trim();
    buffer = "";
    if (!text) return;
    const colon = text.indexOf(":");
    if (colon <= 0) return;
    const name = text.slice(0, colon).trim();
    if (!name.startsWith("--")) return;
    const value = text.slice(colon + 1).replace(/!important\s*$/i, "").trim();
    stack[stack.length - 1].declarations.push({ name, value });
  };

  while (index < css.length) {
    const char = css[index];
    if (char === "/" && css[index + 1] === "*") {
      const end = css.indexOf("*/", index + 2);
      index = end === -1 ? css.length : end + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const end = closingQuote(css, index);
      buffer += css.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth = Math.max(0, parenDepth - 1);
    if (parenDepth === 0) {
      if (char === "{") {
        const block = { prelude: buffer.trim(), declarations: [], children: [] };
        buffer = "";
        stack[stack.length - 1].children.push(block);
        stack.push(block);
        index += 1;
        continue;
      }
      if (char === "}") {
        flushDeclaration();
        if (stack.length > 1) stack.pop();
        index += 1;
        continue;
      }
      if (char === ";") {
        flushDeclaration();
        index += 1;
        continue;
      }
    }
    buffer += char;
    index += 1;
  }
  flushDeclaration();
  return root;
}

function closingQuote(css, start) {
  const quote = css[start];
  for (let index = start + 1; index < css.length; index += 1) {
    if (css[index] === "\\") {
      index += 1;
      continue;
    }
    if (css[index] === quote) return index;
  }
  return css.length - 1;
}

const normalizeSelector = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

/** `:root` and `html` are the document scope: what every page inherits with no condition. */
function isBaseSelector(selector) {
  return selector.split(",").map((part) => part.trim().toLowerCase()).some((part) => part === ":root" || part === "html");
}

/**
 * Every custom property a stylesheet declares, with the selector and the
 * conditional at-rule chain it sits under. Order follows the source.
 */
export function parseCssTokens(css, { source = "" } = {}) {
  const records = [];
  const visit = (block, selector, condition) => {
    for (const declaration of block.declarations) {
      if (!selector) continue; // a custom property outside any rule has no scope
      records.push({
        name: declaration.name,
        value: declaration.value,
        selector,
        condition,
        base: isBaseSelector(selector) && condition.length === 0,
        source,
      });
    }
    for (const child of block.children) {
      const prelude = normalizeSelector(child.prelude);
      if (prelude.startsWith("@")) {
        const atName = prelude.slice(1).split(/[\s(]/, 1)[0].toLowerCase();
        // Conditional groups nest rules; other at-rules (`@font-face`, `@property`)
        // hold ordinary declarations that are not scoped tokens.
        if (!child.children.length && atName !== "media" && atName !== "supports" && atName !== "container") continue;
        const nextCondition = TRANSPARENT_AT_RULES.has(atName) ? condition : [...condition, prelude];
        visit(child, selector, nextCondition);
        continue;
      }
      // CSS nesting: a nested selector still scopes its declarations under
      // the outer one; the outer selector text is kept for citation.
      visit(child, selector ? `${selector} ${prelude}` : prelude, condition);
    }
  };
  visit(scanBlocks(css), "", []);
  return records;
}

/* ── var() resolution ───────────────────────────────────────────────────── */

/** Parse `var(--name, fallback)` starting at `start` (index of `var(`). */
function readVar(value, start) {
  let depth = 0;
  for (let index = start + 3; index < value.length; index += 1) {
    const char = value[index];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        const inner = value.slice(start + 4, index);
        const comma = inner.indexOf(",");
        const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
        const fallback = comma === -1 ? null : inner.slice(comma + 1).trim();
        return { end: index + 1, fallback, name };
      }
    }
  }
  return null;
}

/**
 * Substitute every `var()` in `value` using `lookup(name)`; a missing token
 * uses its fallback, and one with neither is left as written and reported.
 */
export function substituteVars(value, lookup, state = { depth: 0, references: new Set(), unresolved: new Set() }) {
  if (state.depth > MAX_RESOLUTION_DEPTH) return value;
  let output = "";
  let index = 0;
  while (index < value.length) {
    const start = value.indexOf("var(", index);
    if (start === -1) {
      output += value.slice(index);
      break;
    }
    output += value.slice(index, start);
    const parsed = readVar(value, start);
    if (!parsed || !parsed.name.startsWith("--")) {
      output += value.slice(start, start + 4);
      index = start + 4;
      continue;
    }
    state.references.add(parsed.name);
    const replacement = lookup(parsed.name);
    const nested = { ...state, depth: state.depth + 1 };
    if (replacement !== undefined) {
      output += substituteVars(replacement, lookup, nested);
    } else if (parsed.fallback !== null) {
      output += substituteVars(parsed.fallback, lookup, nested);
    } else {
      state.unresolved.add(parsed.name);
      output += value.slice(start, parsed.end);
    }
    index = parsed.end;
  }
  return output;
}

const scopeKey = (record) => `${record.condition.join(" ")}||${record.selector}`;

/**
 * Resolve every record's `var()` chain. A reference resolves in the record's
 * own scope first, then in the document scope (`:root`, unconditional) — the
 * same order the cascade applies when a theme scope overrides a base token.
 * Later declarations in the same scope win, as in CSS.
 */
export function resolveTokens(records) {
  const byScope = new Map();
  const base = new Map();
  for (const record of records) {
    const key = scopeKey(record);
    if (!byScope.has(key)) byScope.set(key, new Map());
    byScope.get(key).set(record.name, record.value);
    if (record.base) base.set(record.name, record.value);
  }
  return records.map((record) => {
    const own = byScope.get(scopeKey(record));
    const lookup = (name) => (own.has(name) ? own.get(name) : base.get(name));
    const state = { depth: 0, references: new Set(), unresolved: new Set() };
    const resolved = substituteVars(record.value, lookup, state).replace(/\s+/g, " ").trim();
    return {
      ...record,
      resolved,
      kind: classifyToken(resolved),
      references: [...state.references],
      ...(state.unresolved.size ? { unresolved: [...state.unresolved] } : {}),
    };
  });
}

/* ── classification ─────────────────────────────────────────────────────── */

const COLOR_HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const COLOR_FUNCTION = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(/i;
const LENGTH = /^-?(?:\d+|\d*\.\d+)(?:px|r?em|%|v[wh]|[sdl]v[wh]|vmin|vmax|ch|ex|pt|pc|cm|mm|in|q)$/i;
const NUMBER = /^-?(?:\d+|\d*\.\d+)$/;
const DURATION = /^(?:\d+|\d*\.\d+)m?s$/i;

/** A coarse kind so a consumer can ask for "the colors" without knowing token names. */
export function classifyToken(value) {
  const text = String(value ?? "").trim();
  if (!text) return "other";
  const lower = text.toLowerCase();
  if (COLOR_HEX.test(text) || COLOR_FUNCTION.test(text) || lower === "transparent" || lower === "currentcolor") return "color";
  if (/gradient\(/i.test(text)) return "gradient";
  const families = text.split(",").map((part) => part.trim().replace(/^["']|["']$/g, "").toLowerCase());
  if (families.some((family) => GENERIC_FONT_FAMILIES.has(family))) return "font-family";
  if (LENGTH.test(text) || /^(?:clamp|calc|min|max)\(/i.test(text)) return "length";
  if (DURATION.test(text)) return "duration";
  if (NUMBER.test(text)) return "number";
  if (/^cubic-bezier\(|^(?:ease|ease-in|ease-out|ease-in-out|linear|steps\()/i.test(text)) return "easing";
  return "other";
}

/* ── brand roles ────────────────────────────────────────────────────────── */

/** `timds.json brand.roles`: role name → custom property name, validated. */
export function normalizeBrandRoles(input) {
  if (input === undefined || input === null) return {};
  if (!input || Array.isArray(input) || typeof input !== "object") throw new Error("timds.json brand.roles must be an object of role → token name");
  const roles = {};
  for (const [role, token] of Object.entries(input)) {
    if (!ROLE_PATTERN.test(role)) throw new Error(`timds.json brand.roles ${role} must be color.<name> or font.<name>`);
    const name = String(token ?? "").trim();
    if (!TOKEN_NAME_PATTERN.test(name)) throw new Error(`timds.json brand.roles ${role} must name a CSS custom property such as --color-accent`);
    roles[role] = name;
  }
  return roles;
}

export const roleKind = (role) => ROLE_KINDS[role.split(".")[0]];

/**
 * Fill every brand role from the document scope: an explicit mapping first,
 * then the convention candidates. An explicit mapping that names a missing
 * token, or one of the wrong kind, is an error — the manifest is wrong, not
 * the stylesheet. A core role nothing fills is reported, not fatal, so a
 * system can adopt the vocabulary at its own pace.
 */
export function resolveBrandRoles(tokens, mapping = {}) {
  const base = new Map();
  for (const token of tokens) if (token.base) base.set(token.name, token); // later declarations win, as in CSS
  const roles = {};
  const errors = [];
  const missing = [];
  const names = [...new Set([...Object.keys(BRAND_ROLES), ...Object.keys(mapping)])];
  for (const role of names) {
    const kind = roleKind(role);
    const explicit = mapping[role];
    if (explicit) {
      const token = base.get(explicit);
      if (!token) errors.push(`brand role ${role} is mapped to ${explicit}, which no loaded stylesheet declares on :root`);
      else if (token.kind !== kind) errors.push(`brand role ${role} is mapped to ${explicit}, which resolves to ${token.resolved} (${token.kind}), not a ${kind}`);
      else roles[role] = { token: token.name, value: token.resolved, kind: token.kind, source: "manifest" };
      continue;
    }
    const candidate = (BRAND_ROLES[role] ?? []).map((name) => base.get(name)).find((token) => token && token.kind === kind);
    if (candidate) roles[role] = { token: candidate.name, value: candidate.resolved, kind: candidate.kind, source: "convention" };
    else missing.push(role);
  }
  return { roles, errors, missing };
}

/** Where extract writes the derived tokens for a workspace, beside index.json. */
export const derivedTokensPath = (designSystemRoot, manifest) => derivedFilePath(designSystemRoot, manifest, "tokens");

/** The derived tokens document for a workspace, or null when extract has not run. */
export const readDerivedTokens = async (designSystemRoot, manifest) => (await readDerivedLayer(designSystemRoot, manifest)).tokens;

/* ── document ───────────────────────────────────────────────────────────── */

/**
 * The `tokens.json` document: every resolved token with its scope and source,
 * plus the stylesheets it was read from, stamped with the system version so
 * a consumer can pin what it read.
 */
export function buildTokensDocument({ manifest, stylesheets, records, roles: mapping = manifest.brand?.roles ?? {} }) {
  const tokens = resolveTokens(records);
  const brand = resolveBrandRoles(tokens, mapping);
  if (brand.errors.length) throw new Error(`timds.json brand.roles does not match the built stylesheets:\n${brand.errors.map((error) => `- ${error}`).join("\n")}`);
  const scopes = [];
  const seen = new Map();
  for (const token of tokens) {
    const key = scopeKey(token);
    if (!seen.has(key)) {
      seen.set(key, { selector: token.selector, condition: token.condition, base: token.base, count: 0 });
      scopes.push(seen.get(key));
    }
    seen.get(key).count += 1;
  }
  const kinds = {};
  for (const token of tokens) kinds[token.kind] = (kinds[token.kind] ?? 0) + 1;
  return {
    schemaVersion: TOKENS_SCHEMA_VERSION,
    system: { id: manifest.systemId, name: manifest.name, version: manifest.version },
    count: tokens.length,
    kinds,
    roles: brand.roles,
    ...(brand.missing.length ? { missingRoles: brand.missing } : {}),
    stylesheets,
    scopes,
    tokens,
  };
}

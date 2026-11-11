// The two-way check of a site that lives inside its Design System's
// workspace (`site/` beside `timds.json`, no pin).
//
// `consumer check` guards a product's design surface against the system it
// pins. In a workspace the site reads the system's stylesheets and tokens
// from their source paths, so the check also runs the other way: it finds a
// site edit that introduces a style the system does not have, rewrites what
// has exactly one right answer, and returns the rest as structured findings
// for an agent to resolve in the same change by ADDING to the system (a new
// token, a new class). It never proposes changing an existing token's value
// or an existing class's rules.
//
// What the system has:
//   - Its stylesheets: the `.css` files `timds.json bundle.include` names (what
//     a website loads from the published system), `src/styles/system.css`
//     when it exists (the starter's stylesheet, the one the website designs
//     link and the EmDash scaffold imports), every stylesheet a scanned site
//     file imports from inside the workspace but outside the site, and their
//     relative `@import`s. The viewer's own chrome (`viewer.css`) and preview
//     engine (`canvas.css`) count only when one of those names them. An
//     explicit `stylesheets` list replaces the discovery.
//   - Its tokens: the custom properties of those stylesheets plus, for a
//     system on the starter build, the `tokens.json` compile (`--group-name`,
//     `{group.name}` references as `var()`), resolved together. Only the
//     document scope (`:root`/`html`, unconditional) offers a rewrite: a theme
//     or media-scoped value would change what the other scopes render.
//   - Its classes: every class a system stylesheet declares (`declaredClasses`,
//     the rule the website-designs check uses).
//
// What is scanned: site files that match the app's design surface or its
// protected globs (protected wins), skipping node_modules, dist, .astro,
// .wrangler, dot-directories and git-ignored paths. `.css` files whole; in
// `.astro`, `.html`, `.jsx`, `.tsx`, `.vue` and `.svelte` files the `<style>`
// blocks (not those with a non-CSS `lang`), static `style="..."` attributes
// and static class names: quoted `class`/`className` values (Svelte/Vue
// `{...}` interpolations and any name touching one are skipped), a
// `className`/`class:list` expression that is one string literal, and in a
// `class:list` the string elements of an array and the keys of an object.
// Every other expression is dynamic and never guessed at. JSX style objects,
// `:style`/`:class` bindings and preprocessor languages are not read.
//
// What is flagged:
//   - Color literals in declaration values: hex (3, 4, 6, 8 digits), `rgb()`,
//     `rgba()`, `hsl()`, `hsla()` (compared as 8-bit RGBA, so `#FFF`,
//     `#ffffff` and `rgb(255 255 255)` are one value), the other CSS color
//     functions without a `var()` inside (compared as written), and CSS named
//     colors in properties that take a color (never in custom properties,
//     where a bare word may be any keyword). `transparent`, `currentColor`
//     and the CSS-wide keywords are never findings. A function that contains
//     `var()` is partly the system's already and is left alone.
//   - `font-family` stacks that name a family (a stack of generic families or
//     a keyword is not a finding), compared family by family, unquoted and
//     case-insensitively. The `font` shorthand is not read.
//   - A site declaration of a custom property the system declares
//     (`token-override`): the site would be changing a system token.
//   - A class used in site markup, or declared in a site stylesheet, that no
//     system stylesheet declares. There is no allowlist.
// Lengths, numbers, durations and everything else are never flagged.
//
// Literal placement: a literal in the fallback of `var(--system-token, ...)`
// is dead code and skipped; a fallback of a site variable, a literal inside
// `color-mix()` or a gradient, and a literal in a site custom property's
// value are checked like any other value. Declarations in `@font-face`,
// `@property`, `@counter-style`, `@font-palette-values` and
// `@font-feature-values` are skipped: `var()` is not valid there.
//
// One right answer: a literal whose value exactly one document-scope token
// holds is rewritten to `var(--that-token)` when `fix` is true, in a file of
// the design surface; it is reported as a rewrite either way (`applied`).
// Several tokens with the value (an alias chain included) are an
// `ambiguous-literal` finding listing the candidates; no token is a
// `literal` finding; a unique match in a protected file is a `literal`
// finding naming the token. Rewrites replace only the literal's span, so
// every other byte stays, and a second run finds nothing to rewrite. A file
// is written only when it changed, and a failed write restores the files
// already written. The Design System is never written.

import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

import { matchesPattern as matchesBundlePattern, normalizeBundleConfig } from "./bundle.mjs";
import { gitIgnoredPaths, matchesGlob } from "./consumer.mjs";
import { applyWritesWithRollback, compileTokenCss } from "./consumer-scaffold.mjs";
import { runsStarterBuild } from "./consumer-scaffold-workspace.mjs";
import { hasContractGroups, readContractGroups } from "./contract-groups.mjs";
import { declaredClasses } from "./designs.mjs";
import { classifyToken, importReferences, parseCssTokens, resolveTokens } from "./tokens.mjs";

/** The version of the result and finding shapes `checkWorkspaceSite` returns. */
export const WORKSPACE_CHECK_SCHEMA_VERSION = 1;

/** The finding kinds, in the order the text report lists them. */
export const WORKSPACE_FINDING_KINDS = Object.freeze(["literal", "ambiguous-literal", "token-override", "class"]);

// The starter stylesheet, as `inspectDesignSystem` in consumer-scaffold.mjs
// recognises it (that constant is not exported).
const STARTER_STYLESHEET = "src/styles/system.css";
const MAX_IMPORT_DEPTH = 8;

const MARKUP_EXTENSIONS = new Set([".astro", ".html", ".jsx", ".tsx", ".vue", ".svelte"]);
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".astro", ".wrangler"]);
const DESCRIPTOR_AT_RULES = new Set(["font-face", "property", "counter-style", "font-palette-values", "font-feature-values"]);
const CSS_WIDE_KEYWORDS = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);
// The generic families `classifyToken` in tokens.mjs recognises (that set is not exported).
const GENERIC_FONT_FAMILIES = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif",
  "ui-monospace", "ui-rounded", "emoji", "math", "fangsong",
]);
const COLOR_PROPERTY = /^(?:color|background(?:-color)?|border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?(?:-color)?|outline(?:-color)?|box-shadow|text-shadow|text-decoration(?:-color)?|caret-color|accent-color|column-rule(?:-color)?|fill|stroke|stop-color|flood-color|lighting-color|scrollbar-color|text-emphasis(?:-color)?|-webkit-text-(?:fill|stroke)-color)$/i;

const NAMED_COLORS = new Map(`aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff beige:f5f5dc bisque:ffe4c4
black:000000 blanchedalmond:ffebcd blue:0000ff blueviolet:8a2be2 brown:a52a2a burlywood:deb887 cadetblue:5f9ea0 chartreuse:7fff00
chocolate:d2691e coral:ff7f50 cornflowerblue:6495ed cornsilk:fff8dc crimson:dc143c cyan:00ffff darkblue:00008b darkcyan:008b8b
darkgoldenrod:b8860b darkgray:a9a9a9 darkgreen:006400 darkgrey:a9a9a9 darkkhaki:bdb76b darkmagenta:8b008b darkolivegreen:556b2f
darkorange:ff8c00 darkorchid:9932cc darkred:8b0000 darksalmon:e9967a darkseagreen:8fbc8f darkslateblue:483d8b darkslategray:2f4f4f
darkslategrey:2f4f4f darkturquoise:00ced1 darkviolet:9400d3 deeppink:ff1493 deepskyblue:00bfff dimgray:696969 dimgrey:696969
dodgerblue:1e90ff firebrick:b22222 floralwhite:fffaf0 forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc ghostwhite:f8f8ff gold:ffd700
goldenrod:daa520 gray:808080 green:008000 greenyellow:adff2f grey:808080 honeydew:f0fff0 hotpink:ff69b4 indianred:cd5c5c indigo:4b0082
ivory:fffff0 khaki:f0e68c lavender:e6e6fa lavenderblush:fff0f5 lawngreen:7cfc00 lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080
lightcyan:e0ffff lightgoldenrodyellow:fafad2 lightgray:d3d3d3 lightgreen:90ee90 lightgrey:d3d3d3 lightpink:ffb6c1 lightsalmon:ffa07a
lightseagreen:20b2aa lightskyblue:87cefa lightslategray:778899 lightslategrey:778899 lightsteelblue:b0c4de lightyellow:ffffe0 lime:00ff00
limegreen:32cd32 linen:faf0e6 magenta:ff00ff maroon:800000 mediumaquamarine:66cdaa mediumblue:0000cd mediumorchid:ba55d3
mediumpurple:9370db mediumseagreen:3cb371 mediumslateblue:7b68ee mediumspringgreen:00fa9a mediumturquoise:48d1cc mediumvioletred:c71585
midnightblue:191970 mintcream:f5fffa mistyrose:ffe4e1 moccasin:ffe4b5 navajowhite:ffdead navy:000080 oldlace:fdf5e6 olive:808000
olivedrab:6b8e23 orange:ffa500 orangered:ff4500 orchid:da70d6 palegoldenrod:eee8aa palegreen:98fb98 paleturquoise:afeeee
palevioletred:db7093 papayawhip:ffefd5 peachpuff:ffdab9 peru:cd853f pink:ffc0cb plum:dda0dd powderblue:b0e0e6 purple:800080
rebeccapurple:663399 red:ff0000 rosybrown:bc8f8f royalblue:4169e1 saddlebrown:8b4513 salmon:fa8072 sandybrown:f4a460 seagreen:2e8b57
seashell:fff5ee sienna:a0522d silver:c0c0c0 skyblue:87ceeb slateblue:6a5acd slategray:708090 slategrey:708090 snow:fffafa
springgreen:00ff7f steelblue:4682b4 tan:d2b48c teal:008080 thistle:d8bfd8 tomato:ff6347 turquoise:40e0d0 violet:ee82ee wheat:f5deb3
white:ffffff whitesmoke:f5f5f5 yellow:ffff00 yellowgreen:9acd32`.split(/\s+/).map((entry) => entry.split(":")));

const toPosix = (value) => String(value).split(path.sep).join("/");
const isInside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/* ── colors ─────────────────────────────────────────────────────────────── */

const clampByte = (value) => Math.max(0, Math.min(255, Math.round(value)));
const rgbaKey = (r, g, b, a = 255) => `rgba(${clampByte(r)},${clampByte(g)},${clampByte(b)},${clampByte(a)})`;

function parseNumber(text, percentScale) {
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%?)$/i.exec(text.trim());
  if (!match) return null;
  const value = Number(match[1]);
  return match[2] ? (value / 100) * percentScale : value;
}

function parseHue(text) {
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+))(deg|grad|rad|turn)?$/i.exec(text.trim());
  if (!match) return null;
  const value = Number(match[1]);
  const unit = (match[2] || "deg").toLowerCase();
  const degrees = unit === "grad" ? value * 0.9 : unit === "rad" ? (value * 180) / Math.PI : unit === "turn" ? value * 360 : value;
  return ((degrees % 360) + 360) % 360;
}

/** The arguments of `rgb()`/`hsl()` in either syntax: `[c1, c2, c3, alpha|null]`, or null. */
function colorArguments(inner) {
  const [main, slash, ...rest] = inner.split("/");
  if (rest.length) return null;
  const parts = main.includes(",") ? main.split(",").map((part) => part.trim()) : main.trim().split(/\s+/);
  if (slash !== undefined) {
    if (parts.length !== 3 || main.includes(",")) return null;
    return [...parts, slash.trim()];
  }
  if (parts.length === 3) return [...parts, null];
  if (parts.length === 4 && main.includes(",")) return parts;
  return null;
}

/**
 * A color literal as one comparable key (`rgba(r,g,b,a)` in bytes), or null
 * when the text is not a hex, `rgb()`, `hsl()` or named color this module can
 * convert.
 */
export function normalizeColor(text) {
  const value = String(text ?? "").trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(value);
  if (hex) {
    const digits = hex[1].length <= 4 ? [...hex[1]].map((digit) => digit + digit).join("") : hex[1];
    const bytes = digits.match(/../g).map((pair) => Number.parseInt(pair, 16));
    return rgbaKey(bytes[0], bytes[1], bytes[2], bytes[3] ?? 255);
  }
  if (NAMED_COLORS.has(value)) return normalizeColor(`#${NAMED_COLORS.get(value)}`);
  const fn = /^(rgba?|hsla?)\(([^()]*)\)$/.exec(value);
  if (!fn) return null;
  const args = colorArguments(fn[2]);
  if (!args) return null;
  const alpha = args[3] === null ? 1 : parseNumber(args[3], 1);
  if (alpha === null) return null;
  if (fn[1].startsWith("rgb")) {
    const channels = args.slice(0, 3).map((part) => parseNumber(part, 255));
    if (channels.some((channel) => channel === null)) return null;
    return rgbaKey(channels[0], channels[1], channels[2], alpha * 255);
  }
  const hue = parseHue(args[0]);
  const saturation = parseNumber(args[1], 100);
  const lightness = parseNumber(args[2], 100);
  if (hue === null || saturation === null || lightness === null) return null;
  const s = Math.max(0, Math.min(100, saturation)) / 100;
  const l = Math.max(0, Math.min(100, lightness)) / 100;
  const f = (n) => {
    const k = (n + hue / 30) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return rgbaKey(f(0) * 255, f(8) * 255, f(4) * 255, alpha * 255);
}

/** The key a color literal is compared by: the RGBA bytes when convertible, else its text without case or spacing. */
const colorKey = (literal) => normalizeColor(literal) ?? `text:${literal.toLowerCase().replace(/\s+/g, " ").replace(/\s*([(),/])\s*/g, "$1").trim()}`;

/* ── fonts ──────────────────────────────────────────────────────────────── */

function splitStack(value) {
  const families = [];
  let current = "";
  let quote = null;
  for (const char of value) {
    if (quote) {
      if (char === quote) quote = null;
      current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === ",") {
      families.push(current);
      current = "";
    } else current += char;
  }
  families.push(current);
  return families.map((family) => family.trim().replace(/^["']|["']$/g, "").replace(/\s+/g, " ").trim().toLowerCase());
}

/** A font-family stack as one comparable key, or null when it names no family (generic families and keywords only). */
export function fontStackKey(value) {
  const text = String(value ?? "").trim();
  if (!text || /var\(/i.test(text)) return null;
  const families = splitStack(text);
  if (families.some((family) => !family)) return null;
  if (families.every((family) => GENERIC_FONT_FAMILIES.has(family) || CSS_WIDE_KEYWORDS.has(family))) return null;
  return families.join(",");
}

/* ── masking ────────────────────────────────────────────────────────────── */

// Masking replaces a span with spaces (newlines kept) so offsets still point
// into the original text.
const blank = (text) => text.replace(/[^\n\r]/g, " ");
const maskRange = (text, start, end) => text.slice(0, start) + blank(text.slice(start, end)) + text.slice(end);

function maskCssComments(css) {
  return css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, blank);
}

/** Index after the string starting at `start` (the quote), tolerating escapes and an unterminated string. */
function stringEnd(text, start) {
  const quote = text[start];
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === "\\") index += 1;
    else if (text[index] === quote) return index + 1;
    else if (quote !== "`" && text[index] === "\n") return index;
  }
  return text.length;
}

/** Index after the `)` matching the `(` at `open`, or -1. */
function matchingParen(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' || char === "'") {
      index = stringEnd(text, index) - 1;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

/** A declaration value with strings and `url()` contents blanked. */
function maskValue(value) {
  let masked = value;
  for (let index = 0; index < masked.length; index += 1) {
    const char = masked[index];
    if (char === '"' || char === "'") {
      const end = stringEnd(masked, index);
      masked = maskRange(masked, index, end);
      index = end - 1;
    }
  }
  for (const match of masked.matchAll(/url\(/gi)) {
    const end = matchingParen(masked, match.index + 3);
    masked = maskRange(masked, match.index + 4, end === -1 ? masked.length : end - 1);
  }
  return masked;
}

/* ── CSS scanning with offsets ──────────────────────────────────────────── */

/**
 * The rules and declarations of a stylesheet, each with offsets into `css`.
 * Rules: `{ prelude, start }` for every selector block. Declarations:
 * `{ name, value, valueStart, nameStart, atRules }` where `atRules` lists the
 * enclosing at-rule names. Comments, strings and parentheses are respected;
 * declarations outside any block (an inline style attribute) are kept.
 */
function scanCss(css) {
  const text = maskCssComments(css);
  const rules = [];
  const declarations = [];
  const stack = [{ atRules: [] }];
  let segmentStart = 0;
  let depth = 0;
  const flush = (end) => {
    const segment = text.slice(segmentStart, end);
    const colon = segment.indexOf(":");
    if (colon > 0) {
      const name = segment.slice(0, colon).trim();
      if (/^(?:--[\w-]*|-?[a-zA-Z_][\w-]*)$/.test(name)) {
        const nameStart = segmentStart + segment.indexOf(name);
        let valueStart = segmentStart + colon + 1;
        let valueEnd = end;
        while (valueStart < valueEnd && /\s/.test(text[valueStart])) valueStart += 1;
        while (valueEnd > valueStart && /\s/.test(text[valueEnd - 1])) valueEnd -= 1;
        const important = /\s*!\s*important$/i.exec(text.slice(valueStart, valueEnd));
        if (important) valueEnd -= important[0].length;
        declarations.push({ name, nameStart, value: css.slice(valueStart, valueEnd), valueStart, atRules: stack.at(-1).atRules });
      }
    }
    segmentStart = end + 1;
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' || char === "'") {
      index = stringEnd(text, index) - 1;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    if (depth) continue;
    if (char === "{") {
      const raw = text.slice(segmentStart, index);
      const prelude = raw.trim();
      const start = segmentStart + raw.indexOf(prelude);
      const parent = stack.at(-1);
      if (prelude.startsWith("@")) {
        const atName = prelude.slice(1).split(/[\s({]/, 1)[0].toLowerCase();
        stack.push({ atRules: [...parent.atRules, atName] });
      } else {
        rules.push({ prelude: css.slice(start, start + prelude.length), start });
        stack.push({ atRules: parent.atRules });
      }
      segmentStart = index + 1;
    } else if (char === "}") {
      flush(index);
      if (stack.length > 1) stack.pop();
    } else if (char === ";") flush(index);
  }
  flush(text.length);
  return { rules, declarations };
}

/** The classes a selector names, each with its offset in the selector. */
function selectorClasses(prelude) {
  let masked = prelude;
  for (let index = 0; index < masked.length; index += 1) {
    if (masked[index] === '"' || masked[index] === "'") {
      const end = stringEnd(masked, index);
      masked = maskRange(masked, index, end);
      index = end - 1;
    }
  }
  masked = masked.replace(/\[[^\]]*\]/g, blank);
  return [...masked.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((match) => ({ name: match[1], offset: match.index }));
}

/* ── the Design System ──────────────────────────────────────────────────── */

async function readText(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (caught) {
    if (caught?.code === "ENOENT" || caught?.code === "EISDIR") return null;
    throw caught;
  }
}

/** `.css` files under the Design System that a bundle include pattern names, never inside the site. */
async function bundleStylesheets(designSystemRoot, siteRoot, manifest) {
  let config;
  try {
    config = normalizeBundleConfig(manifest.bundle);
  } catch {
    return []; // the system's own check reports a malformed bundle
  }
  if (!config) return [];
  const found = new Set();
  const visit = async (relative) => {
    const absolute = path.join(designSystemRoot, ...relative.split("/"));
    if (isInside(siteRoot, absolute)) return;
    const stat = await fs.lstat(absolute).catch(() => null);
    if (!stat) return;
    if (stat.isFile()) {
      if (relative.endsWith(".css") && config.include.some((pattern) => matchesBundlePattern(relative, pattern))
        && !config.exclude.some((pattern) => matchesBundlePattern(relative, pattern))) found.add(relative);
      return;
    }
    if (!stat.isDirectory()) return;
    for (const entry of await fs.readdir(absolute)) {
      if (entry.startsWith(".") || entry === "node_modules") continue;
      await visit(relative ? `${relative}/${entry}` : entry);
    }
  };
  for (const pattern of config.include) {
    const segments = pattern.split("/");
    const fixed = [];
    for (const segment of segments) {
      if (/[*?]/.test(segment)) break;
      fixed.push(segment);
    }
    await visit(fixed.join("/"));
  }
  return [...found].sort();
}

/** The `{group.name}` references the viewer's compile turns into `var()`, applied before `compileTokenCss`. */
function referencedTokens(tokens) {
  const out = {};
  for (const [group, entries] of Object.entries(tokens ?? {})) {
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
    out[group] = Object.fromEntries(Object.entries(entries).map(([name, token]) => [name, typeof token?.value === "string"
      ? { ...token, value: token.value.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (_match, reference) => `var(--${reference.replace(/[^a-z0-9-]/gi, "-").toLowerCase()})`) }
      : token]));
  }
  return out;
}

/** The first tokens.json group whose values are of `kind`, for a suggestion; `fallback` when none is. */
function tokenGroupOf(tokens, kind, fallback) {
  for (const [group, entries] of Object.entries(tokens ?? {})) {
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
    if (Object.values(entries).some((token) => typeof token?.value === "string" && classifyToken(token.value) === kind)) return group;
  }
  return fallback;
}

/**
 * What the Design System offers a site: its stylesheets, the classes they
 * declare, and the document-scope tokens indexed by color and font value.
 */
async function readSystem({ designSystemRoot, siteRoot, siteImports, stylesheets }) {
  const manifestText = await readText(path.join(designSystemRoot, "timds.json"));
  if (manifestText === null) throw new Error(`${designSystemRoot} has no timds.json, so it is not a TimDS Design System workspace`);
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (caught) {
    throw new Error(`timds.json could not be read as JSON: ${caught.message}`);
  }

  const entries = stylesheets
    ? stylesheets.map((stylesheet) => path.posix.normalize(toPosix(stylesheet)))
    : [...new Set([
      ...await bundleStylesheets(designSystemRoot, siteRoot, manifest),
      ...(existsSync(path.join(designSystemRoot, STARTER_STYLESHEET)) ? [STARTER_STYLESHEET] : []),
      ...siteImports,
    ])];

  const sheets = [];
  const seen = new Set();
  const load = async (relative, depth) => {
    if (seen.has(relative) || depth > MAX_IMPORT_DEPTH || relative.startsWith("../")) return;
    seen.add(relative);
    const absolute = path.join(designSystemRoot, ...relative.split("/"));
    if (isInside(siteRoot, absolute)) return;
    const css = await readText(absolute);
    if (css === null) return;
    for (const reference of importReferences(css)) {
      if (reference.startsWith("/")) continue;
      await load(path.posix.normalize(path.posix.join(path.posix.dirname(relative), reference.split(/[?#]/, 1)[0])), depth + 1);
    }
    sheets.push({ path: relative, css });
  };
  for (const entry of entries) await load(entry, 0);

  // A starter-build system compiles its tokens to tokens.css at build time.
  // The authored source is the tokens/ groups when the system keeps them
  // (tokens.json is then a generated view that only `timds check` refreshes),
  // so a token an agent just added to a group is seen at once.
  const starterBuild = runsStarterBuild(manifest);
  let tokensJson = null;
  let tokenGroups = false;
  if (starterBuild) {
    if (await hasContractGroups(designSystemRoot)) {
      try {
        tokensJson = { ...(await readContractGroups(designSystemRoot)).tokens };
        tokenGroups = true;
      } catch (caught) {
        throw new Error(`the Design System's tokens/ groups could not be read: ${caught.message}`);
      }
    } else {
      const text = await readText(path.join(designSystemRoot, "tokens.json"));
      if (text !== null) {
        try {
          tokensJson = JSON.parse(text);
        } catch (caught) {
          throw new Error(`tokens.json could not be read as JSON: ${caught.message}`);
        }
      }
    }
  }
  const tokenFile = (group) => (tokenGroups ? `tokens/${String(group).replaceAll(".", "/")}.json` : "tokens.json");

  const records = [];
  if (tokensJson) records.push(...parseCssTokens(compileTokenCss(referencedTokens(tokensJson)), { source: tokenGroups ? "tokens/" : "tokens.json" }));
  for (const sheet of sheets) records.push(...parseCssTokens(sheet.css, { source: sheet.path }));
  const resolved = resolveTokens(records);

  const tokenNames = new Set(resolved.map((record) => record.name));
  const base = new Map();
  for (const record of resolved) if (record.base) base.set(record.name, record);
  const colors = new Map();
  const fonts = new Map();
  const add = (index, key, name) => {
    if (!index.has(key)) index.set(key, new Set());
    index.get(key).add(name);
  };
  for (const [name, record] of base) {
    const value = record.resolved;
    const isColor = record.kind === "color" || normalizeColor(value) !== null;
    if (isColor && !/^(?:transparent|currentcolor)$/i.test(value) && !/var\(/i.test(value)) add(colors, colorKey(value), name);
    if (record.kind === "font-family" || (name.startsWith("--font") && record.kind === "other")) {
      const key = fontStackKey(value);
      if (key) add(fonts, key, name);
    }
  }

  const classes = new Set();
  for (const sheet of sheets) for (const name of declaredClasses(sheet.css)) classes.add(name);

  const tokenSheet = sheets.find((sheet) => parseCssTokens(sheet.css).some((record) => record.base));
  const classSheet = sheets.find((sheet) => sheet.path === STARTER_STYLESHEET) ?? sheets.find((sheet) => declaredClasses(sheet.css).size) ?? sheets[0];
  const where = {
    color: tokensJson
      ? { file: tokenFile(tokenGroupOf(tokensJson, "color", "color")), group: tokenGroupOf(tokensJson, "color", "color"), grouped: tokenGroups }
      : { file: tokenSheet?.path ?? classSheet?.path ?? STARTER_STYLESHEET, group: null },
    font: tokensJson
      ? { file: tokenFile(tokenGroupOf(tokensJson, "font-family", "font")), group: tokenGroupOf(tokensJson, "font-family", "font"), grouped: tokenGroups }
      : { file: tokenSheet?.path ?? classSheet?.path ?? STARTER_STYLESHEET, group: null },
    classes: classSheet?.path ?? STARTER_STYLESHEET,
  };

  return {
    stylesheets: sheets.map((sheet) => sheet.path),
    tokensJson: Boolean(tokensJson),
    tokenNames,
    colors,
    fonts,
    classes,
    where,
  };
}

/* ── the site ───────────────────────────────────────────────────────────── */

const isScannable = (relative) => {
  const extension = path.posix.extname(relative).toLowerCase();
  return extension === ".css" || MARKUP_EXTENSIONS.has(extension);
};

async function walkSite(siteRoot) {
  const files = [];
  const visit = async (directory, relative) => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) continue;
        await visit(path.join(directory, entry.name), child);
      } else if (entry.isFile() && isScannable(child)) files.push(child);
    }
  };
  await visit(siteRoot, "");
  return files;
}

/** Stylesheets a site file imports, as paths relative to the Design System when they resolve inside it and outside the site. */
function systemImports(relative, text, { siteRoot, designSystemRoot }) {
  const references = new Set(importReferences(text));
  for (const match of text.matchAll(/\bimport\s+(?:[\w*{}\s,]+\s+from\s+)?["']([^"']+?\.css)(?:\?[^"']*)?["']/g)) references.add(match[1]);
  const found = [];
  for (const reference of references) {
    if (!reference.startsWith(".")) continue;
    const absolute = path.resolve(siteRoot, path.dirname(relative), reference.split(/[?#]/, 1)[0]);
    if (isInside(siteRoot, absolute) || !isInside(designSystemRoot, absolute)) continue;
    found.push(toPosix(path.relative(designSystemRoot, absolute)));
  }
  return found;
}

/* ── markup ─────────────────────────────────────────────────────────────── */

/** Astro frontmatter, HTML comments and `<script>` bodies blanked, so neither is read as markup. */
function maskMarkup(text, extension) {
  let masked = text;
  if (extension === ".astro") {
    const frontmatter = /^(﻿?\s*)---[^\n]*\n(?:[\s\S]*?\n)?---[^\n]*(?:\n|$)/.exec(masked);
    if (frontmatter) masked = maskRange(masked, frontmatter[1].length, frontmatter[0].length);
  }
  masked = masked.replace(/<!--[\s\S]*?(?:-->|$)/g, blank);
  for (const match of [...masked.matchAll(/<script\b[^>]*>([\s\S]*?)(?:<\/script\s*>|$)/gi)]) {
    const start = match.index + match[0].indexOf(">") + 1;
    masked = maskRange(masked, start, start + match[1].length);
  }
  return masked;
}

/** The `<style>` blocks of a markup file: `{ start, css }`, those in a non-CSS language skipped. */
function styleBlocks(masked, text) {
  const blocks = [];
  for (const match of masked.matchAll(/<style\b([^>]*)>([\s\S]*?)(?:<\/style\s*>|$)/gi)) {
    const lang = /\blang\s*=\s*["']?([\w-]+)/i.exec(match[1]);
    const start = match.index + match[0].indexOf(">") + 1;
    blocks.push({ start, css: text.slice(start, start + match[2].length), skipped: Boolean(lang && !/^(?:css|postcss)$/i.test(lang[1])) });
  }
  return blocks;
}

/** Index after the `}` matching the `{` at `open`, strings and template literals respected, or -1. */
function matchingBrace(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' || char === "'" || char === "`") {
      index = stringEnd(text, index) - 1;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

/** The end of the tag opened at `start` (index after `>`), quotes and `{...}` expressions respected, or -1. */
function tagEnd(text, start) {
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' || char === "'") {
      const end = text.indexOf(char, index + 1);
      if (end === -1) return -1;
      index = end;
    } else if (char === "{") {
      const end = matchingBrace(text, index);
      if (end === -1) return -1;
      index = end - 1;
    } else if (char === ">") return index + 1;
    else if (char === "<") return -1;
  }
  return -1;
}

/** Class names in a quoted attribute value, each with its offset; names touching a `{...}` interpolation are skipped. */
function staticClassTokens(value, offset) {
  let masked = value;
  for (let index = masked.indexOf("{"); index !== -1; index = masked.indexOf("{", index + 1)) {
    const end = matchingBrace(masked, index);
    masked = masked.slice(0, index) + "\0".repeat((end === -1 ? masked.length : end) - index) + (end === -1 ? "" : masked.slice(end));
  }
  return [...masked.matchAll(/[^\s]+/g)]
    .filter((match) => !match[0].includes("\0"))
    .map((match) => ({ name: match[0], offset: offset + match.index }));
}

/** The string literals and object keys of a `class:list`/`className` expression that are class names for certain. */
function expressionClassTokens(expression, offset, { list }) {
  const trimmed = expression.trim();
  const single = /^(["'`])([^"'`$]*)\1$/.exec(trimmed);
  if (single) return staticClassTokens(single[2], offset + expression.indexOf(trimmed) + 1);
  if (!list) return [];
  const tokens = [];
  const stack = [];
  const significant = (from, step) => {
    for (let index = from; index >= 0 && index < expression.length; index += step) if (!/\s/.test(expression[index])) return expression[index];
    return "";
  };
  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index];
    if (char === "[" || char === "{" || char === "(") stack.push(char);
    else if (char === "]" || char === "}" || char === ")") stack.pop();
    else if (char === '"' || char === "'" || char === "`") {
      const end = stringEnd(expression, index);
      const body = expression.slice(index + 1, end - 1);
      const container = stack.at(-1);
      const before = significant(index - 1, -1);
      const after = significant(end, 1);
      const element = container === "[" && "[,".includes(before) && ",]".includes(after);
      const key = container === "{" && "{,".includes(before) && after === ":";
      if ((element || key) && !body.includes("${")) tokens.push(...staticClassTokens(body, offset + index + 1));
      index = end - 1;
    } else if (/[A-Za-z_$]/.test(char) && (index === 0 || !/[\w$-]/.test(expression[index - 1]))) {
      const word = /^[A-Za-z_$][\w$-]*/.exec(expression.slice(index))[0];
      const container = stack.at(-1);
      if (container === "{" && "{,".includes(significant(index - 1, -1)) && significant(index + word.length, 1) === ":") {
        tokens.push({ name: word, offset: offset + index });
      }
      index += word.length - 1;
    }
  }
  return tokens;
}

/** Every static class use and style attribute in a markup file. */
function markupAttributes(masked, text) {
  const classes = [];
  const styles = [];
  for (const match of masked.matchAll(/<([a-zA-Z][\w:.-]*)/g)) {
    const end = tagEnd(masked, match.index);
    if (end === -1) continue;
    const tag = masked.slice(match.index, end);
    for (const attribute of tag.matchAll(/(?<=\s)(class:list|className|class|style)\s*=\s*(["'{])/g)) {
      const name = attribute[1];
      const open = match.index + attribute.index + attribute[0].length - 1;
      if (attribute[2] === "{") {
        if (name === "style") continue;
        const close = matchingBrace(text, open);
        if (close === -1) continue;
        classes.push(...expressionClassTokens(text.slice(open + 1, close - 1), open + 1, { list: name === "class:list" }));
        continue;
      }
      if (name === "class:list") continue;
      const close = text.indexOf(attribute[2], open + 1);
      if (close === -1) continue;
      const value = text.slice(open + 1, close);
      if (name === "style") {
        if (!value.includes("{")) styles.push({ start: open + 1, css: value });
      } else classes.push(...staticClassTokens(value, open + 1));
    }
  }
  return { classes, styles };
}

/* ── the check ──────────────────────────────────────────────────────────── */

function position(text, offset) {
  let line = 1;
  let lineStart = 0;
  for (let index = text.indexOf("\n"); index !== -1 && index < offset; index = text.indexOf("\n", index + 1)) {
    line += 1;
    lineStart = index + 1;
  }
  return { line, column: offset - lineStart + 1 };
}

/** The color literals of a declaration value with their offsets, the fallbacks of system tokens skipped. */
function colorLiterals(declaration, system) {
  const masked = maskValue(declaration.value);
  const excluded = [];
  for (const match of masked.matchAll(/var\(/gi)) {
    const end = matchingParen(masked, match.index + 3);
    if (end === -1) continue;
    const inner = masked.slice(match.index + 4, end - 1);
    const comma = inner.indexOf(",");
    if (comma !== -1 && system.tokenNames.has(inner.slice(0, comma).trim())) excluded.push([match.index + 4 + comma + 1, end - 1]);
  }
  const taken = [];
  const overlaps = (ranges, start, end) => ranges.some(([from, to]) => start < to && end > from);
  const free = (start, end) => !overlaps(excluded, start, end) && !overlaps(taken, start, end);
  const literals = [];
  for (const match of masked.matchAll(/(?<![\w-])(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi)) {
    const end = matchingParen(masked, match.index + match[1].length);
    if (end === -1) continue;
    const text = declaration.value.slice(match.index, end);
    const usable = free(match.index, end) && !/var\(/i.test(text);
    taken.push([match.index, end]); // nothing inside a color function is read on its own
    if (usable) literals.push({ offset: match.index, text });
  }
  for (const match of masked.matchAll(/(?<![\w&-])#([0-9a-fA-F]{3,8})(?![\w-])/g)) {
    if (![3, 4, 6, 8].includes(match[1].length)) continue;
    if (!free(match.index, match.index + match[0].length)) continue;
    literals.push({ offset: match.index, text: match[0] });
  }
  if (!declaration.name.startsWith("--") && COLOR_PROPERTY.test(declaration.name)) {
    for (const match of masked.matchAll(/(?<![\w#.-])([a-zA-Z]+)(?![\w(-])/g)) {
      if (!NAMED_COLORS.has(match[1].toLowerCase())) continue;
      if (!free(match.index, match.index + match[0].length)) continue;
      literals.push({ offset: match.index, text: match[0] });
    }
  }
  return literals.sort((left, right) => left.offset - right.offset);
}

function tokenHome(where) {
  if (!where.group) return `the :root block of ${where.file}`;
  return where.grouped
    ? `${where.file} (it compiles to --${where.group}-<name>; tokens.json is generated from tokens/, so never edit it)`
    : `tokens.json, group "${where.group}" (it compiles to --${where.group}-<name>)`;
}

function suggestedVar(where) {
  return where.group ? `--${where.group}-<name>` : "--<name>";
}

/**
 * Check a site that lives in its Design System's workspace against the
 * system, rewriting each literal that equals exactly one system token and
 * returning the rest as findings. See the module comment for what counts.
 *
 * @param {object} options
 * @param {string} options.siteRoot absolute path of the site folder
 * @param {string} options.designSystemRoot absolute path of the Design System (holds timds.json)
 * @param {string[]} options.designSurface the app's design-surface globs, relative to the site
 * @param {string[]} [options.protected] the app's protected globs, relative to the site
 * @param {boolean} [options.fix] write the rewrites (default true)
 * @param {string[]|null} [options.files] site-relative paths to limit the scan to; null scans the whole surface
 * @param {string[]|null} [options.stylesheets] Design-System-relative stylesheets to treat as the system's instead of discovering them
 * @param {(file: string, content: string) => Promise<void>} [options.writeFile] the writer (tests inject a failing one)
 */
export async function checkWorkspaceSite({
  siteRoot: siteRootInput,
  designSystemRoot: designSystemRootInput,
  designSurface = [],
  protected: protectedGlobs = [],
  fix = true,
  files = null,
  stylesheets = null,
  writeFile = undefined,
} = {}) {
  if (!siteRootInput || !designSystemRootInput) throw new Error("checkWorkspaceSite needs siteRoot and designSystemRoot");
  const siteRoot = path.resolve(siteRootInput);
  const designSystemRoot = path.resolve(designSystemRootInput);

  const candidates = (await walkSite(siteRoot)).filter((relative) => protectedGlobs.some((glob) => matchesGlob(relative, glob))
    || designSurface.some((glob) => matchesGlob(relative, glob)));
  const ignored = new Set((await gitIgnoredPaths(siteRoot, candidates)).map((entry) => toPosix(entry.path)));
  const readable = candidates.filter((relative) => !ignored.has(relative));
  const texts = new Map();
  for (const relative of readable) {
    const text = await readText(path.join(siteRoot, ...relative.split("/")));
    if (text !== null) texts.set(relative, text);
  }

  const siteImports = new Set();
  for (const [relative, text] of texts) for (const found of systemImports(relative, text, { siteRoot, designSystemRoot })) siteImports.add(found);
  const system = await readSystem({ designSystemRoot, siteRoot, siteImports: [...siteImports].sort(), stylesheets });

  const only = files ? new Set(files.map((file) => path.posix.normalize(toPosix(file)).replace(/^\.\//, ""))) : null;
  const scanned = [...texts.keys()].filter((relative) => !only || only.has(relative));

  const rewrites = [];
  const findings = [];
  const writes = [];

  for (const relative of scanned) {
    const text = texts.get(relative);
    const editable = !protectedGlobs.some((glob) => matchesGlob(relative, glob));
    const extension = path.posix.extname(relative).toLowerCase();
    const edits = [];
    const reportedClasses = new Set();
    const at = (offset) => ({ file: relative, ...position(text, offset) });

    const classFinding = (name, offset, declared) => {
      if (system.classes.has(name) || reportedClasses.has(name)) return;
      reportedClasses.add(name);
      findings.push({
        kind: "class",
        ...at(offset),
        class: name,
        suggestion: `Add a .${name} rule to ${system.where.classes} in the Design System${declared ? ", moving this rule's declarations there," : ""} without changing any existing rule; then ${declared ? "remove the rule from the site and keep" : "keep"} class="${name}" in the site. If the system already has a class for this, use that class instead.`,
      });
    };

    const checkCss = (css, base) => {
      const { rules, declarations } = scanCss(css);
      for (const rule of rules) {
        for (const { name, offset } of selectorClasses(rule.prelude)) classFinding(name, base + rule.start + offset, true);
      }
      for (const declaration of declarations) {
        if (declaration.atRules.some((name) => DESCRIPTOR_AT_RULES.has(name))) continue;
        if (declaration.name.startsWith("--") && system.tokenNames.has(declaration.name)) {
          findings.push({
            kind: "token-override",
            ...at(base + declaration.nameStart),
            property: declaration.name,
            value: declaration.value,
            suggestion: `The site redefines the system token ${declaration.name}. Remove this declaration; the system's value applies. If the site needs a different value, add a new token to ${tokenHome(system.where.color)} and use it here instead.`,
          });
          continue;
        }
        const property = declaration.name;
        const valueOffset = base + declaration.valueStart;
        if (property.toLowerCase() === "font-family") {
          const key = fontStackKey(declaration.value);
          if (!key) continue;
          const names = [...(system.fonts.get(key) ?? [])].sort();
          handleLiteral({ property, offset: valueOffset, literal: declaration.value, names, kind: "font", declaration });
          continue;
        }
        for (const literal of colorLiterals(declaration, system)) {
          const names = [...(system.colors.get(colorKey(literal.text)) ?? [])].sort();
          handleLiteral({ property, offset: valueOffset + literal.offset, literal: literal.text, names, kind: "color", declaration, within: literal.offset });
        }
      }
    };

    const handleLiteral = ({ property, offset, literal, names, kind, declaration, within = 0 }) => {
      const where = kind === "font" ? system.where.font : system.where.color;
      const after = (replacement) => `${property}: ${declaration.value.slice(0, within)}${replacement}${declaration.value.slice(within + literal.length)}`;
      if (names.length === 1 && editable) {
        const to = `var(${names[0]})`;
        rewrites.push({ ...at(offset), property, from: literal, to, token: names[0], applied: Boolean(fix) });
        edits.push({ start: offset, end: offset + literal.length, to });
        return;
      }
      if (names.length === 1) {
        findings.push({
          kind: "literal",
          ...at(offset),
          property,
          value: literal,
          candidates: names,
          suggestion: `${literal} is the value of the system token ${names[0]}, but this file is protected, so it is not rewritten. Nothing needs adding to the Design System; change the line to \`${after(`var(${names[0]})`)}\`.`,
        });
        return;
      }
      if (names.length > 1) {
        findings.push({
          kind: "ambiguous-literal",
          ...at(offset),
          property,
          value: literal,
          candidates: names,
          suggestion: `${names.length} system tokens hold ${literal} (${names.join(", ")}). Pick the one whose role this is and change the line to \`${after("var(<chosen token>)")}\`; nothing needs adding to the Design System. If no candidate's role fits, add a new token for this role to ${tokenHome(where)} and use it.`,
        });
        return;
      }
      const description = kind === "font" ? "font stack" : "color";
      findings.push({
        kind: "literal",
        ...at(offset),
        property,
        value: literal,
        candidates: [],
        suggestion: `No system token holds this ${description}. Add a token with the value ${literal} to ${tokenHome(where)}, named for its role and without changing any existing token, then change the line to \`${after(`var(${suggestedVar(where)})`)}\`.`,
      });
    };

    if (extension === ".css") {
      checkCss(text, 0);
    } else {
      const masked = maskMarkup(text, extension);
      let markup = masked;
      for (const block of styleBlocks(masked, text)) {
        markup = maskRange(markup, block.start, block.start + block.css.length);
        if (!block.skipped) checkCss(block.css, block.start);
      }
      const { classes, styles } = markupAttributes(markup, text);
      for (const style of styles) checkCss(style.css, style.start);
      for (const { name, offset } of classes) classFinding(name, offset, false);
    }

    if (fix && edits.length) {
      let output = text;
      for (const edit of edits.sort((left, right) => right.start - left.start)) output = output.slice(0, edit.start) + edit.to + output.slice(edit.end);
      if (output !== text) writes.push({ path: relative, content: output });
    }
  }

  const changedFiles = writes.length
    ? await applyWritesWithRollback(siteRoot, writes, writeFile ? { writeFile } : {})
    : [];

  const order = (left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column;
  return {
    schemaVersion: WORKSPACE_CHECK_SCHEMA_VERSION,
    rewrites: rewrites.sort(order),
    findings: findings.sort(order),
    changedFiles,
    scanned,
    system: {
      stylesheets: system.stylesheets,
      tokensJson: system.tokensJson,
      tokenCount: system.tokenNames.size,
      classCount: system.classes.size,
    },
  };
}

/**
 * The text block the CLI prints for a workspace check result. `prefix` is put
 * before each file path (the site folder relative to where the reader is).
 */
export function formatWorkspaceFindings(result, { prefix = "" } = {}) {
  const lines = [];
  const where = (entry) => `${prefix}${entry.file}:${entry.line}:${entry.column}`;
  const applied = result.rewrites.filter((rewrite) => rewrite.applied);
  const pending = result.rewrites.filter((rewrite) => !rewrite.applied);
  const scanned = `${result.scanned.length} site file${result.scanned.length === 1 ? "" : "s"}`;
  if (!result.rewrites.length && !result.findings.length) {
    return `Two-way check: ${scanned} use only what the Design System declares.`;
  }
  lines.push(`Two-way check against the Design System (${scanned}):`);
  if (applied.length) {
    lines.push(`Rewrote ${applied.length} literal${applied.length === 1 ? "" : "s"} to the system token with the same value:`);
    for (const rewrite of applied) lines.push(`  ${where(rewrite)} ${rewrite.property}: ${rewrite.from} -> ${rewrite.to}`);
  }
  if (pending.length) {
    lines.push(`${pending.length} literal${pending.length === 1 ? " equals" : "s equal"} exactly one system token; run timds consumer check without --no-fix to rewrite, or change ${pending.length === 1 ? "it" : "them"} by hand:`);
    for (const rewrite of pending) lines.push(`  ${where(rewrite)} ${rewrite.property}: ${rewrite.from} -> ${rewrite.to}`);
  }
  if (result.findings.length) {
    lines.push(`${result.findings.length} finding${result.findings.length === 1 ? "" : "s"} to resolve in this change by adding to the Design System (never change an existing token's value or an existing class's rules):`);
    for (const kind of WORKSPACE_FINDING_KINDS) {
      for (const finding of result.findings.filter((entry) => entry.kind === kind)) {
        const subject = kind === "class" ? `class .${finding.class}` : `${kind} ${finding.property}: ${finding.value}`;
        lines.push(`  ${where(finding)} ${subject}`);
        lines.push(`    ${finding.suggestion}`);
      }
    }
  }
  return lines.join("\n");
}

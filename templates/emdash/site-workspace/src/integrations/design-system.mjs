// How this site reads the Design System it sits in: an Astro integration that
// runs in Node while `astro dev` serves and while `astro build` builds, never
// in the Worker.
//
// The Design System is the nearest folder above the site that holds
// timds.json. Nothing is copied out of it into the site's source and nothing
// is pinned: every value below is read from the system's own files when the
// site builds, so a change to the system is a change to the site on the next
// build, and `astro dev` picks it up on the next request.
//
//   virtual:timds/design-system   the system's name and the website design
//                                 named in astro.config.mjs: each page of it
//                                 that is not an article, topic or list route,
//                                 filled the way the system's own renderer
//                                 fills it (layout.html around the page, the
//                                 {{name}}, {{description}}, {{version}} and
//                                 {{title}} placeholders) and the shell the
//                                 article routes render inside. Root-relative
//                                 links get Astro's `base`, so the site works
//                                 under the workspace's /site mount.
//   /styles/, /scripts/, /assets/ the system's src/ folders of those names, at
//                                 the URLs its own build serves them from, so
//                                 the design's <link href="/styles/system.css">
//                                 resolves in the site too
//   /tokens.css                   (a system on the starter build) tokens.json,
//                                 or the tokens/ groups, compiled by the rule
//                                 the system's build uses (`--group-name` on
//                                 :root, a `{group.name}` reference as
//                                 `var(--group-name)`)
//
// A form in the design that posts (`<form method="post">`) needs a handler in
// the site: a module under the site's src/forms/ named for the address it
// posts to (src/forms/contact.ts for /contact, src/forms/index.ts for /)
// that exports POST. The virtual module lists those handlers, and the
// middleware this integration registers (forms-middleware.mjs, the rule in
// form-dispatch.mjs) calls one for a POST to its address before Astro picks
// a page, so a site page at the same address (/articles) never takes it. The
// catch-all route answers 405 to any other method it does not serve. A posting form whose address has no
// handler is rendered disabled, with a line saying it is not connected yet,
// so a visitor is never offered a Send button that sends nothing. Which forms
// have a handler is decided from the site's files each time the module is
// built, in development and in the build alike, by parsing each module with
// the parser of the Vite the site's Astro runs on (`parseAst`) and reading
// its real exports: a comment or a string that mentions POST is not one. The
// middleware still checks that the POST it imports is a function.
// Vite is loaded only when the integration runs, so this file imports in
// plain Node with nothing installed.
//
// In development the files are served from disk on every request; the build
// writes them into the client output, where the Worker's static assets serve
// them. The page data is baked into the server bundle at build time, because
// the Worker has no filesystem.
//
// The token rule and the page-file rule mirror the TimDS toolkit: the
// starter build's token compile (`--group-name`, lower case, anything outside
// a-z, 0-9 and - as -, and `{group.name}` references as `var()`) and the
// designs catalog's file names (`about.html` and `about.default.html` are the
// default state of /about, `contact.sent.html` a named state). Keep them in
// step; the toolkit's tests compare them.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultPageFiles, inNamespace, readSectionRouteFiles, sectionRouteInventory } from "./section-routes.mjs";

import { COMPOSITION_CONTRACT, compositionFile, compositionRouteInventory, divisionInputsRoot, readDivisionComposition, retainComposition } from "./composition.mjs";
import { compositionSourceContexts, moduleImportReferences } from "./source-contexts.mjs";

export const VIRTUAL_MODULE = "virtual:timds/design-system";
const RESOLVED_MODULE = `\0${VIRTUAL_MODULE}`;
/** The folders under the system's src/ that its build serves at the same name. */
export const STATIC_DIRECTORIES = ["assets", "scripts", "styles"];
/** Default section when the renderer is used without a site's declaration. */
const DEFAULT_SECTIONS = [{ collection: "articles", prefix: "/articles/", label: "Articles", singularLabel: "Article", feed: true, urlPattern: "/articles/{slug}/" }];
/** Stands in for the page title in the article shell until a request fills it. */
export const TITLE_MARKER = "\u0000timds-title\u0000";
const CONTENT_MARKER = "\u0000timds-content\u0000";
const PLACEHOLDER = /\{\{\s*([a-z]+)\s*\}\}/g;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export { DEFAULT_STATE, defaultPageFiles, pageRoute } from "./section-routes.mjs";
/** The folder of the site, under src/, whose modules handle the design's posting forms. */
export const FORMS_DIRECTORY = "forms";
const FORM_HANDLER_EXTENSIONS = [".ts", ".mjs", ".js"];
/** Shown inside a posting form that has no handler in the site yet. */
export const FORM_NOT_CONNECTED = "This form is not connected yet, so it cannot send anything.";
const CONTENT_TYPES = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".otf": "font/otf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const escapeHtml = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

const decodeEntities = (value) => value
  .replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&amp;/g, "&");

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

/** The nearest folder strictly above `siteRoot` that holds timds.json, or null. */
export function findDesignSystem(siteRoot) {
  let current = path.dirname(path.resolve(siteRoot));
  while (true) {
    if (existsSync(path.join(current, "timds.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** True when the system runs the starter build, which writes tokens.css from the tokens. */
export function runsStarterBuild(manifest) {
  const build = manifest?.workspace?.build;
  if (!Array.isArray(build)) return false;
  const command = build.join(" ");
  return command === "node scripts/build.mjs" || command === "timds-cli run scripts/build.mjs";
}

/** The system's tokens by group: the tokens/ groups when the system keeps them, else tokens.json. */
export function readTokens(systemRoot) {
  if (existsSync(path.join(systemRoot, ".timds", "contract-layout.json")) && existsSync(path.join(systemRoot, "tokens"))) {
    const tokens = {};
    const walk = (directory, prefix) => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
        if (entry.isDirectory()) walk(path.join(directory, entry.name), `${prefix}${entry.name}.`);
        else if (entry.isFile() && entry.name.endsWith(".json")) tokens[`${prefix}${entry.name.slice(0, -5)}`] = readJson(path.join(directory, entry.name));
      }
    };
    walk(path.join(systemRoot, "tokens"), "");
    return tokens;
  }
  return existsSync(path.join(systemRoot, "tokens.json")) ? readJson(path.join(systemRoot, "tokens.json")) : {};
}

const cssName = (name) => `--${name}`.replace(/[^a-z0-9-]/gi, "-").toLowerCase();

/**
 * The tokens as the `:root` block the starter build writes to tokens.css:
 * `--group-name` for each token, and a `{group.name}` reference in a value as
 * `var(--group-name)`. The starter build refuses a token without a non-empty
 * string value; here it is left out, so a mistake the system's own check
 * reports does not stop the site's development server.
 */
export function compileTokenCss(tokens) {
  const declarations = [];
  for (const [group, entries] of Object.entries(tokens)) {
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
    for (const [name, token] of Object.entries(entries)) {
      if (typeof token?.value !== "string" || !token.value.trim()) continue;
      const value = token.value.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (_match, reference) => `var(${cssName(reference)})`);
      declarations.push(`  ${cssName(`${group}-${name}`)}: ${value};`);
    }
  }
  return `:root {\n${declarations.sort().join("\n")}\n}\n`;
}

// Script bodies are JavaScript or data, not placeholders or links.
function outsideScripts(html, transform) {
  let end = 0;
  let result = "";
  for (const match of html.matchAll(/(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>|$)/gi)) {
    result += transform(html.slice(end, match.index) + match[1]) + match[2] + match[3];
    end = match.index + match[0].length;
  }
  return result + transform(html.slice(end));
}

/** Fill the placeholders a design may use; one the system's renderer does not know is left as written. */
export function fill(template, values) {
  return outsideScripts(template, (markup) => markup.replace(PLACEHOLDER, (match, name) => (Object.hasOwn(values, name) ? values[name] : match)));
}

/** `base` as a prefix: "" for "/", "/site" for "/site" or "/site/". */
export function basePrefix(base) {
  return String(base || "/").replace(/\/+$/, "");
}

// Elements whose content is text, never markup: a tag-like string in them is
// not a tag.
const RAW_TEXT_ELEMENTS = new Set(["iframe", "noembed", "noframes", "plaintext", "script", "style", "textarea", "title", "xmp"]);

/**
 * The tags of an HTML document, in order, the way a browser's tokenizer
 * splits them: comments, doctypes and the bodies of raw-text elements
 * (script, style, textarea, title, ...) are skipped, and each start tag's
 * attributes carry their value as written (double-quoted, single-quoted or
 * unquoted) with its offsets, so a caller can rewrite one value in place.
 * Text inside another attribute's value is part of that value, never an
 * attribute of its own.
 */
export function htmlTags(html) {
  const tags = [];
  const length = html.length;
  let index = 0;
  while (index < length) {
    const open = html.indexOf("<", index);
    if (open === -1) break;
    if (html.startsWith("<!--", open)) {
      const close = html.indexOf("-->", open + 4);
      index = close === -1 ? length : close + 3;
      continue;
    }
    const next = html[open + 1];
    if (next === "!" || next === "?") {
      const close = html.indexOf(">", open + 2);
      index = close === -1 ? length : close + 1;
      continue;
    }
    if (next === "/" && /[a-z]/i.test(html[open + 2] || "")) {
      const close = html.indexOf(">", open + 2);
      const name = html.slice(open + 2).match(/^[^\s/>]+/)[0].toLowerCase();
      index = close === -1 ? length : close + 1;
      tags.push({ type: "end", name, start: open, end: index });
      continue;
    }
    if (!/[a-z]/i.test(next || "")) {
      index = open + 1;
      continue;
    }
    const name = html.slice(open + 1).match(/^[^\s/>]+/)[0];
    let cursor = open + 1 + name.length;
    const attributes = [];
    let selfClosing = false;
    while (cursor < length) {
      while (cursor < length && /[\s/]/.test(html[cursor])) {
        selfClosing = html[cursor] === "/";
        cursor += 1;
      }
      if (cursor >= length || html[cursor] === ">") break;
      selfClosing = false;
      const nameMatch = html.slice(cursor).match(/^[^\s/>=]+|^=[^\s/>=]*/);
      const attributeName = nameMatch[0];
      const attribute = { name: attributeName.toLowerCase(), start: cursor, value: "", valueStart: -1, valueEnd: -1, quote: null };
      cursor += attributeName.length;
      let after = cursor;
      while (after < length && /\s/.test(html[after])) after += 1;
      if (html[after] === "=") {
        after += 1;
        while (after < length && /\s/.test(html[after])) after += 1;
        const quote = html[after];
        if (quote === '"' || quote === "'") {
          const close = html.indexOf(quote, after + 1);
          attribute.quote = quote;
          attribute.valueStart = after + 1;
          attribute.valueEnd = close === -1 ? length : close;
          cursor = close === -1 ? length : close + 1;
        } else {
          const value = html.slice(after).match(/^[^\s>]*/)[0];
          attribute.valueStart = after;
          attribute.valueEnd = after + value.length;
          cursor = attribute.valueEnd;
        }
        attribute.value = html.slice(attribute.valueStart, attribute.valueEnd);
      }
      attribute.end = cursor;
      attributes.push(attribute);
    }
    const tagEnd = Math.min(length, cursor + 1);
    const lower = name.toLowerCase();
    tags.push({ type: "start", name: lower, start: open, end: tagEnd, attributes, selfClosing });
    index = tagEnd;
    if (RAW_TEXT_ELEMENTS.has(lower)) {
      const closing = new RegExp(`</${lower}(?=[\\s/>]|$)`, "ig");
      closing.lastIndex = index;
      const found = closing.exec(html);
      index = found ? found.index : length;
    }
  }
  return tags;
}

/** The decoded value of a start tag's attribute, or undefined when it has none. */
function attributeValue(tag, name) {
  const attribute = tag.attributes.find((candidate) => candidate.name === name);
  return attribute ? decodeEntities(attribute.value) : undefined;
}

/**
 * Apply edits to the markup: each `{ start, end, text }` replaces that span.
 * Edits never overlap; they are applied from the end so offsets hold.
 */
function applyEdits(html, edits) {
  let result = html;
  for (const edit of [...edits].sort((left, right) => right.start - left.start || right.end - left.end)) {
    result = `${result.slice(0, edit.start)}${edit.text}${result.slice(edit.end)}`;
  }
  return result;
}

/** A replacement for one attribute's value, quoted when an unquoted value would no longer be one. */
function valueEdit(attribute, value) {
  if (attribute.quote || /^[^\s"'=<>`]+$/.test(value)) return { start: attribute.valueStart, end: attribute.valueEnd, text: value };
  return { start: attribute.valueStart, end: attribute.valueEnd, text: `"${value.replaceAll('"', "&quot;")}"` };
}

/** The attributes holding one URL each that `applyBase` rewrites; srcset holds a list. */
export const URL_ATTRIBUTES = ["action", "formaction", "href", "poster", "src"];

/**
 * Put `base` in front of every root-relative reference in the markup's start
 * tags: the URL attributes (`URL_ATTRIBUTES`) and each srcset candidate,
 * double-quoted, single-quoted or unquoted. External, protocol-relative,
 * fragment and query references are left as written, and so is a reference
 * that already starts with the base, text in comments and raw-text bodies
 * (script, style, textarea, ...), and every other attribute's value.
 */
export function applyBase(html, base) {
  const prefix = basePrefix(base);
  if (!prefix) return html;
  const rebase = (value) => {
    if (!value.startsWith("/") || value.startsWith("//")) return value;
    if (value === prefix || value.startsWith(`${prefix}/`) || value.startsWith(`${prefix}?`) || value.startsWith(`${prefix}#`)) return value;
    return `${prefix}${value}`;
  };
  const edits = [];
  for (const tag of htmlTags(html)) {
    if (tag.type !== "start") continue;
    for (const attribute of tag.attributes) {
      if (attribute.valueStart === -1) continue;
      let value = attribute.value;
      if (URL_ATTRIBUTES.includes(attribute.name)) value = rebase(value.trim()) === value.trim() ? value : value.replace(value.trim(), rebase(value.trim()));
      else if (attribute.name === "srcset") value = value.split(",").map((candidate) => candidate.replace(/^(\s*)(\S+)/, (_whole, space, url) => `${space}${rebase(url)}`)).join(",");
      else continue;
      if (value !== attribute.value) edits.push(valueEdit(attribute, value));
    }
  }
  return applyEdits(html, edits);
}

/** The attributes of one start tag (the text after its name) as an object, entities decoded so Astro escapes them once. */
export function parseAttributes(source) {
  const [tag] = htmlTags(`<x ${String(source || "")}>`);
  const attributes = {};
  for (const attribute of tag?.attributes ?? []) attributes[attribute.name] = decodeEntities(attribute.value);
  return attributes;
}

/**
 * A whole HTML document in the parts a layout component renders: the
 * attributes of <html> and <body>, the inner HTML of <head> and of <body>.
 * A fragment with no <body> is all body.
 */
export function splitDocument(html) {
  const htmlTag = html.match(/<html\b([^>]*)>/i);
  const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head\s*>/i);
  const body = html.match(/<body\b([^>]*)>([\s\S]*?)(?:<\/body\s*>|$)/i);
  if (!body) return { htmlAttributes: parseAttributes(htmlTag?.[1]), head: head ? head[1].trim() : "", bodyAttributes: {}, body: html.trim() };
  return {
    htmlAttributes: parseAttributes(htmlTag?.[1]),
    head: head ? head[1].trim() : "",
    bodyAttributes: parseAttributes(body[1]),
    body: body[2].trim(),
  };
}

/** The names a binding pattern declares (`POST`, `{ POST }`, `[POST]`, `{ a: POST = x }`, `...POST`). */
function patternNames(pattern) {
  if (!pattern) return [];
  switch (pattern.type) {
    case "Identifier": return [pattern.name];
    case "ObjectPattern": return pattern.properties.flatMap((property) => patternNames(property.type === "RestElement" ? property.argument : property.value));
    case "ArrayPattern": return pattern.elements.flatMap((element) => patternNames(element));
    case "AssignmentPattern": return patternNames(pattern.left);
    case "RestElement": return patternNames(pattern.argument);
    default: return [];
  }
}

/** True for an initializer that is plainly not a function: none, a literal, a template, an object, an array, or undefined. */
function plainValue(init) {
  if (!init) return true;
  if (init.type === "Identifier") return init.name === "undefined";
  return ["ArrayExpression", "Literal", "ObjectExpression", "TemplateLiteral"].includes(init.type);
}

/**
 * True when a parsed module (an ESTree Program, as Vite's `parseAst` or any
 * ESTree parser returns it) exports a value named POST: `export function
 * POST`, `export const POST = ...` (a destructured one too), `export {
 * handler as POST }`, or `export { POST } from "./elsewhere"`. A type-only
 * export, a `declare`, `export * from` (whose names this module does not
 * spell out), a default export, and `export const POST` with a value that is
 * plainly not a function (none, a literal, an object, ...) are not. What a
 * re-export or a call returns is known only when the module runs, so the
 * catch-all route checks that again before it calls POST.
 */
export function exportsPost(program) {
  for (const node of program?.body ?? []) {
    if (node.type !== "ExportNamedDeclaration" || node.exportKind === "type") continue;
    const declaration = node.declaration;
    if (declaration) {
      if (declaration.declare) continue;
      if ((declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") && declaration.id?.name === "POST") return true;
      if (declaration.type === "VariableDeclaration" && declaration.declarations.some((declarator) => patternNames(declarator.id).includes("POST") && !(declarator.id.type === "Identifier" && plainValue(declarator.init)))) return true;
      continue;
    }
    for (const specifier of node.specifiers ?? []) {
      if (specifier.exportKind === "type") continue;
      if ((specifier.exported?.name ?? specifier.exported?.value) === "POST") return true;
    }
  }
  return false;
}

/**
 * A module parser for `formHandlers`: `parseAst` of the Vite that the site's
 * Astro depends on, resolved from the site's own `astro` (never from
 * whatever else happens to be installed). Rejects with the fix when the
 * site's dependencies are not installed.
 */
export async function loadModuleParser(siteRoot) {
  let vite;
  try {
    const astro = createRequire(path.join(siteRoot, "package.json")).resolve("astro/package.json");
    vite = createRequire(astro).resolve("vite");
  } catch {
    throw new Error(`The design system integration reads the site's form handlers with the Vite that Astro runs on, and found no astro install in ${siteRoot}. Run npm ci in ${siteRoot}.`);
  }
  const { parseAst } = await import(pathToFileURL(vite).href);
  return (code, file) => parseAst(code, { lang: /\.(?:ts|tsx|jsx)$/.exec(file)?.[0].slice(1) ?? "js" }, file);
}

async function loadCompositionImportParser(siteRoot) {
  const astro = createRequire(path.join(siteRoot, "package.json")).resolve("astro/package.json");
  const vite = createRequire(astro).resolve("vite");
  const { parseSync } = await import(pathToFileURL(createRequire(vite).resolve("rolldown/utils")).href);
  return (text, file) => {
    const lang = /\.(?:mts|cts)$/.test(file) ? "ts" : /\.(?:ts|tsx|jsx)$/.exec(file)?.[0].slice(1) ?? "js";
    const result = parseSync(file, text, { lang, sourceType: /\.(?:cjs|cts)$/.test(file) ? "commonjs" : "module" });
    // Astro frontmatter permits top-level return and await together. Keep the
    // complete module AST; only its return-placement diagnostic is inapplicable.
    const errors = result.errors.filter((error) => !(file.endsWith(".astro.ts") && error.message === "A 'return' statement can only be used within a function body."));
    if (errors.length) throw new Error(`Composition source ${file} could not be parsed.`);
    return moduleImportReferences(result.program);
  };
}

/**
 * The site's form handlers: every module under src/forms/ that exports
 * POST (`exportsPost` on the module as `parse` reads it), by the address it
 * handles (`contact.ts` and `contact/index.ts` are /contact, `index.ts` is
 * /). A module that does not export POST, or that does not parse (reported
 * through `warn`), handles nothing. Two modules for one address are refused.
 */
export function formHandlers(siteRoot, { parse, warn = () => {} }) {
  const folder = path.join(siteRoot, "src", FORMS_DIRECTORY);
  const handlers = new Map();
  const walk = (directory, prefix) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(file, [...prefix, entry.name]);
        continue;
      }
      const extension = FORM_HANDLER_EXTENSIONS.find((candidate) => entry.name.endsWith(candidate));
      if (!entry.isFile() || !extension || entry.name.endsWith(".d.ts")) continue;
      let program;
      try {
        program = parse(readFileSync(file, "utf8"), file);
      } catch (caught) {
        warn(`${path.relative(siteRoot, file)} does not parse, so it handles no form until it does: ${String(caught?.message ?? caught).split("\n")[0]}`);
        continue;
      }
      if (!exportsPost(program)) continue;
      const name = entry.name.slice(0, -extension.length);
      const route = `/${(name === "index" ? prefix : [...prefix, name]).join("/")}`;
      if (handlers.has(route)) throw new Error(`${path.relative(siteRoot, file)} and ${path.relative(siteRoot, handlers.get(route))} both handle POST ${route}; keep one`);
      handlers.set(route, file);
    }
  };
  walk(folder, []);
  return handlers;
}

/**
 * The address a form posts to, as a route of this site ("/contact"), from
 * its action resolved against the page's route; null when it cannot be
 * told, and `external` when it posts to another origin.
 */
export function formTarget(action, route) {
  const origin = "http://site.invalid";
  const raw = String(action ?? "").trim();
  if (!raw && !route) return null;
  let url;
  try {
    url = new URL(raw || route, `${origin}${route || "/"}`);
  } catch {
    return null;
  }
  if (url.origin !== origin) return "external";
  return url.pathname.replace(/\/+$/, "") || "/";
}

/** The method a submission uses: the submitter's formmethod, else the form's method, else GET. */
function submissionMethod(value) {
  return String(value ?? "").trim().toLowerCase() === "post" ? "post" : "get";
}

/** True for a control that submits its form: a button (submit unless typed otherwise), or an input of type submit or image. */
function isSubmitter(tag) {
  const type = String(attributeValue(tag, "type") ?? "").trim().toLowerCase();
  if (tag.name === "button") return type === "" || type === "submit";
  return tag.name === "input" && (type === "submit" || type === "image");
}

const FORM_CONTROLS = new Set(["button", "fieldset", "input", "select", "textarea"]);

/**
 * Every form in the markup that would POST to an address of this site with
 * no handler in `handled`, rendered disabled: each control gets `disabled`,
 * the form `data-timds-form="not-connected"`, and a paragraph says the form
 * is not connected yet. A form's POSTs are its own submission when its
 * method is post (Enter in a field, and each button without overrides) and
 * each submit button's or image input's, with its `formmethod` and
 * `formaction` in place of the form's; one that has no handler disables the
 * whole form. Addresses are read with the same tag parser as `applyBase`
 * (`formTarget`), from double-quoted, single-quoted or unquoted values. A
 * POST to another origin is the design's own wiring and is left alone.
 * Attributes and a plain paragraph only, so the page uses no class the
 * Design System does not declare.
 */
export function disableUnconnectedForms(html, { route = null, handled = new Set() } = {}) {
  const edits = [];
  let form = null;
  const close = () => {
    if (!form) return;
    const unhandled = form.posts.some((target) => target !== "external" && !(target && handled.has(target)));
    if (unhandled) {
      edits.push({ start: form.tag.end - 1, end: form.tag.end - 1, text: ' data-timds-form="not-connected"' });
      edits.push({ start: form.tag.end, end: form.tag.end, text: `<p role="note">${FORM_NOT_CONNECTED}</p>` });
      for (const control of form.controls) {
        if (control.attributes.some((attribute) => attribute.name === "disabled")) continue;
        const at = control.selfClosing && html[control.end - 2] === "/" ? control.end - 2 : control.end - 1;
        edits.push({ start: at, end: at, text: " disabled" });
      }
    }
    form = null;
  };
  for (const tag of htmlTags(html)) {
    if (tag.type === "end" && tag.name === "form") close();
    if (tag.type !== "start") continue;
    if (tag.name === "form") {
      close();
      const method = submissionMethod(attributeValue(tag, "method"));
      const action = attributeValue(tag, "action");
      form = { tag, method, action, controls: [], posts: method === "post" ? [formTarget(action, route)] : [] };
      continue;
    }
    if (!form || !FORM_CONTROLS.has(tag.name)) continue;
    form.controls.push(tag);
    if (!isSubmitter(tag)) continue;
    const formmethod = attributeValue(tag, "formmethod");
    const method = formmethod === undefined || !formmethod.trim() ? form.method : submissionMethod(formmethod);
    if (method !== "post") continue;
    const formaction = attributeValue(tag, "formaction");
    form.posts.push(formTarget(formaction === undefined ? form.action : formaction, route));
  }
  close();
  return applyEdits(html, edits);
}

function pageTitle(html, fallback) {
  const heading = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i);
  const text = heading ? decodeEntities(heading[1].replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim() : "";
  return text || fallback;
}

/**
 * The website design `designId` of the system at `systemRoot`, rendered for
 * the site: every default page not on an article route, and the shell the
 * article routes render inside. With a layout.html the shell is the layout;
 * without one (full-document pages) it is the home page, or the first page,
 * with the content of its <main> (else of its <body>) taken out. `forms` is
 * the set of addresses the site handles a POST to (`formHandlers`); every
 * other posting form is rendered disabled (`disableUnconnectedForms`).
 */
export function renderWorkspaceDesign(systemRoot, { design: designId, base = "/", forms = new Set(), sections = DEFAULT_SECTIONS, sectionsContract = 2, pageFiles = [], publicFiles = [], symlinks = [], resolvedRoutes = [] }) {
  const manifest = readJson(path.join(systemRoot, "timds.json"));
  const system = {
    id: String(manifest.systemId || ""),
    name: String(manifest.name || manifest.systemId || "Design System"),
    description: String(manifest.description || ""),
    version: String(manifest.version || ""),
  };
  const values = { name: escapeHtml(system.name), description: escapeHtml(system.description), version: escapeHtml(system.version) };
  if (!ID.test(String(designId || ""))) throw new Error(`The design system integration needs the id of a website design under src/designs/ (got ${JSON.stringify(designId)}); set it in astro.config.mjs.`);
  const directory = path.join(systemRoot, "src", "designs", designId);
  if (!existsSync(path.join(directory, "design.json"))) throw new Error(`The Design System at ${systemRoot} has no website design ${designId} (src/designs/${designId}/design.json); name one it has in astro.config.mjs.`);
  const declared = readJson(path.join(directory, "design.json"));
  const titles = new Map(Object.entries(declared.pages ?? {}).map(([route, page]) => [`/${route.replace(/^\/+|\/+$/g, "")}`, typeof page === "string" ? page : page?.title]));
  const layoutFile = path.join(directory, "layout.html");
  const layout = existsSync(layoutFile) ? readFileSync(layoutFile, "utf8") : null;
  const files = [layoutFile, path.join(directory, "design.json")];

  const handled = new Set(forms);
  const defaults = defaultPageFiles(path.join(directory, "pages"));
  const metadata = new Map(Object.entries(declared.pages ?? {}).map(([route, page]) => [`/${route.replace(/^\/+|\/+$/g, "")}`, page]));
  const inventory = sectionRouteInventory(sections, defaults.map(([route]) => ({ route, ...(metadata.get(route)?.site !== undefined ? { site: metadata.get(route).site } : {}) })), { version: sectionsContract, pageFiles, publicFiles, symlinks, resolvedRoutes });
  const publicRoutes = new Set(inventory.pages.map((page) => page.route));
  const pages = [];
  for (const [route, relative] of defaults) {
    if (!publicRoutes.has(route)) continue;
    const file = path.join(directory, "pages", ...relative.split("/"));
    files.push(file);
    const authored = readFileSync(file, "utf8");
    const title = titles.get(route) || pageTitle(authored, route);
    const content = fill(authored, values);
    const document = layout === null ? content : fill(layout, { ...values, title: escapeHtml(title), content: content.trim() });
    pages.push({ route, title, source: `src/designs/${designId}/pages/${relative}`, ...splitDocument(applyBase(disableUnconnectedForms(document, { route, handled }), base)) });
  }

  pages.sort((left, right) => left.route.localeCompare(right.route));

  let shellDocument;
  if (layout !== null) {
    shellDocument = fill(layout, { ...values, title: TITLE_MARKER, content: CONTENT_MARKER });
  } else {
    const home = (defaults.find(([route]) => route === "/") ?? defaults[0])?.[1];
    const source = home ? fill(readFileSync(path.join(directory, "pages", ...home.split("/")), "utf8"), values) : `<main>${CONTENT_MARKER}</main>`;
    shellDocument = /<main\b[^>]*>[\s\S]*?<\/main\s*>/i.test(source)
      ? source.replace(/(<main\b[^>]*>)[\s\S]*?(<\/main\s*>)/i, (_match, open, close) => `${open}${CONTENT_MARKER}${close}`)
      : source.replace(/(<body\b[^>]*>)[\s\S]*?(<\/body\s*>)/i, (_match, open, close) => `${open}${CONTENT_MARKER}${close}`);
    if (!shellDocument.includes(CONTENT_MARKER)) shellDocument = `${shellDocument}${CONTENT_MARKER}`;
    shellDocument = /<title\b[^>]*>[\s\S]*?<\/title\s*>/i.test(shellDocument)
      ? shellDocument.replace(/(<title\b[^>]*>)[\s\S]*?(<\/title\s*>)/i, (_match, open, close) => `${open}${TITLE_MARKER} · ${values.name}${close}`)
      : shellDocument.replace(/<\/head\s*>/i, (close) => `<title>${TITLE_MARKER} · ${values.name}</title>${close}`);
  }
  const parts = splitDocument(applyBase(disableUnconnectedForms(shellDocument, { handled }), base));
  const [before, after = ""] = parts.body.split(CONTENT_MARKER);
  const shell = {
    htmlAttributes: parts.htmlAttributes,
    head: parts.head,
    bodyAttributes: parts.bodyAttributes,
    before,
    after,
    describes: /<meta\b[^>]*\bname\s*=\s*["']?description\b/i.test(parts.head),
  };
  return { system, design: { id: designId, title: String(declared.title || designId), layout: layout !== null }, pages, shell, files, inventory };
}

/** Resolve the styles linked by the selected reference design without rendering its pages. */
export function divisionStyles(systemRoot, { design }, input) {
  if (input) {
    const designs = input.designs.filter((entry) => entry?.id === design);
    if (designs.length !== 1 || !Array.isArray(designs[0].pages)) throw new Error(`The pinned sibling release does not have a unique ${design} reference design.`);
    const pages = designs[0].pages;
    const home = pages.find((page) => page?.route === "/") ?? pages[0];
    const state = Array.isArray(home?.states) && home.states.find((entry) => entry?.name === "default");
    if (typeof state?.html !== "string") throw new Error(`Pinned sibling reference design ${design} requires a default home or first page state.`);
    const suffix = `/designs/${design}/`;
    const artifactPrefix = typeof designs[0].url === "string" && designs[0].url.endsWith(suffix) ? designs[0].url.slice(0, -suffix.length) : "";
    return readStylesheetLinks(state.html, (href) => {
      if (!href.startsWith("/") || href.startsWith("//")) throw new Error(`Sibling reference design ${design} links an unsupported stylesheet: ${href}.`);
      const published = href.split(/[?#]/, 1)[0];
      const relative = artifactPrefix && published.startsWith(`${artifactPrefix}/`) ? published.slice(artifactPrefix.length + 1) : published.slice(1);
      if (!relative.toLowerCase().endsWith(".css") || !input.files.has(`files/${relative}`)) throw new Error(`Sibling reference design ${design} links a missing verified stylesheet: ${href}.`);
      return `${input.assetPrefix}/${relative}`;
    });
  }
  const tokensCss = runsStarterBuild(readJson(path.join(systemRoot, "timds.json")));
  const directory = `src/designs/${design}`;
  compositionFile(systemRoot, `${directory}/design.json`);
  const layout = compositionFile(systemRoot, `${directory}/layout.html`, { optional: true });
  const pages = compositionFile(systemRoot, `${directory}/pages`, { optional: true, directory: true });
  const defaults = pages ? defaultPageFiles(pages, { strict: true, literalRoutes: false }) : [];
  const home = (defaults.find(([route]) => route === "/") ?? defaults[0])?.[1];
  const shell = layout ?? (home && compositionFile(systemRoot, `${directory}/pages/${home}`));
  if (!shell) throw new Error(`Division reference design ${design} requires a layout or default page.`);
  return readStylesheetLinks(readFileSync(shell, "utf8"), (href) => {
    const pathname = href.split(/[?#]/, 1)[0];
    if (pathname === "/tokens.css" && tokensCss) return pathname;
    if (!/^\/styles\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.css$/i.test(pathname)) {
      throw new Error(`Division reference design ${design} must link local Design System styles: ${href}.`);
    }
    compositionFile(systemRoot, `src${pathname}`);
    return pathname;
  });
}

function readStylesheetLinks(markup, resolve) {
  const styles = [];
  for (const tag of htmlTags(markup)) {
    if (tag.type !== "start" || tag.name !== "link" || !attributeValue(tag, "rel")?.toLowerCase().split(/\s+/).includes("stylesheet")) continue;
    const href = attributeValue(tag, "href")?.trim();
    if (!href) continue;
    const media = attributeValue(tag, "media")?.trim() || null;
    styles.push({ href: resolve(href), media });
  }
  return styles;
}

/** Page links follow the division mount when it owns the target. Asset URLs stay separate. */
function divisionMarkup(html, { division, page, pages, sections, forms, base, input }) {
  const edits = [];
  const assetUrl = (url) => /^(?:\/)?(?:(?:styles|assets|fonts|scripts)\/|tokens\.css(?:[?#]|$))/.test(url);
  const rebase = (raw, tag, name) => {
    if (!raw || /^(?:[#?]|[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)) return raw;
    if (assetUrl(raw)) {
      const relative = raw.replace(/^\//, "");
      if (!input) return `/${relative}`;
      const file = relative.split(/[?#]/, 1)[0];
      if (!input.files.has(`files/${file}`)) throw new Error(`Division page ${page.source} links a missing verified asset: ${raw}.`);
      return `${input.assetPrefix}/${relative}`;
    }
    const anchor = name === "href" && ["a", "area"].includes(tag);
    if (!raw.startsWith("/") || !(anchor || name === "action" || name === "formaction")) return raw;
    const [pathname] = raw.split(/[?#]/, 1);
    if (inNamespace(pathname, division.prefix)) return raw;
    const mounted = `${division.prefix.slice(0, -1)}${pathname}`;
    const mountedRoute = mounted.replace(/\/+$/, "");
    const section = sections.find(({ prefix }) => inNamespace(mounted, prefix));
    if (pages.has(mountedRoute) || section || forms.has(mountedRoute)) {
      const suffix = raw.slice(pathname.length);
      const sectionPage = section && mountedRoute !== `${section.prefix}rss.xml`;
      const trailingSlash = pages.has(mountedRoute) || sectionPage || mounted.endsWith("/");
      return `${mountedRoute}${trailingSlash ? "/" : ""}${suffix}`;
    }
    return raw;
  };
  for (const tag of htmlTags(html)) {
    if (tag.type !== "start") continue;
    if (["html", "head", "body", "base", "style"].includes(tag.name) || tag.name === "link" && attributeValue(tag, "rel")?.toLowerCase().split(/\s+/).includes("stylesheet")) {
      throw new Error(`Division page ${page.source} must be an HTML fragment using its selected layout and styles.`);
    }
    for (const attribute of tag.attributes) {
      if (attribute.valueStart === -1) continue;
      const { name, value } = attribute;
      let next;
      if (URL_ATTRIBUTES.includes(name)) next = value.replace(value.trim(), rebase(value.trim(), tag.name, name));
      else if (name === "srcset") next = value.split(",").map((part) => part.replace(/^(\s*)(\S+)/, (_all, space, url) => `${space}${rebase(url, tag.name, "src")}`)).join(",");
      if (next !== undefined && next !== value) edits.push(valueEdit(attribute, next));
    }
  }
  const htmlWithLinks = applyEdits(html, edits);
  return applyBase(disableUnconnectedForms(htmlWithLinks, { route: `${page.route}/`, handled: forms }), base);
}

function renderDivisions({ siteRoot, systemRoot, base, forms, composition, routes, sections, publicFiles, main }) {
  const contexts = Object.create(null);
  const prefix = basePrefix(base);
  const mainStyles = new Set();
  const tokensCss = runsStarterBuild(readJson(path.join(systemRoot, "timds.json")));
  for (const markup of [...main.pages.map(({ head, body }) => `${head}\n${body}`), main.shell.head, main.shell.before, main.shell.after]) {
    readStylesheetLinks(markup, (href) => {
      const url = href.split(/[?#]/, 1)[0];
      const route = prefix && url.startsWith(`${prefix}/`) ? url.slice(prefix.length) : url;
      if (route === "/tokens.css" && tokensCss || /^\/styles\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.css$/i.test(route)) {
        mainStyles.add(route);
      }
      return route;
    });
  }
  const assets = [...mainStyles].map((path) => ({ path, division: null }));
  const pages = [];
  for (const division of composition.divisions) {
    const layout = readFileSync(compositionFile(siteRoot, division.layout), "utf8");
    const slots = htmlTags(layout).filter((tag) => tag.type === "start" && tag.name === "slot");
    if (!slots.some((slot) => attributeValue(slot, "name") === "head") || !slots.some((slot) => !attributeValue(slot, "name"))) {
      throw new Error(`Division layout ${division.layout} must define head and default slots.`);
    }
    readStylesheetLinks(layout, (href) => {
      if (/^\/(?:styles\/|tokens\.css(?:[?#]|$)|timds-dependencies\/)/.test(href)) {
        throw new Error(`Division layout ${division.layout} must use the selected context's Design System styles.`);
      }
    });
    const input = composition.inputs.get(division.system);
    const styles = divisionStyles(systemRoot, division, input);
    const hrefs = new Set(styles.map(({ href }) => href));
    for (const href of hrefs) {
      if (publicFiles.includes(`public${href}`)) throw new Error(`A public file shadows the division stylesheet ${href}.`);
      assets.push({ path: href, division: division.id });
    }
    contexts[division.id] = { prefix: division.prefix, system: division.system, design: division.design, assetPrefix: input?.assetPrefix ?? "", styles };
    const ownedSections = sections.filter(({ collection }) => composition.collectionContexts.get(collection) === division.id);
    for (const page of composition.pages.values()) {
      if (page.division !== division.id) continue;
      const html = readFileSync(compositionFile(siteRoot, page.source), "utf8");
      pages.push({
        ...page,
        title: pageTitle(html, page.route),
        htmlAttributes: {},
        head: "",
        bodyAttributes: {},
        body: divisionMarkup(html, { division, page, pages: composition.pages, sections: ownedSections, forms, base, input }),
      });
    }
  }
  return { pages, contexts, inputs: composition.inputs, composition: retainComposition(composition, routes, assets), collectionContexts: Object.fromEntries(composition.collectionContexts) };
}

/**
 * One file of the system's src/<directory>/, named by its path segments as
 * they are on disk (no decoding: a file may be called `50%.svg`), or null.
 */
export function readStaticFile(systemRoot, directory, segments) {
  if (!STATIC_DIRECTORIES.includes(directory) || !segments.length) return null;
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || /[\\/\0]/.test(segment))) return null;
  const folder = path.join(systemRoot, "src", directory);
  const file = path.join(folder, ...segments);
  if (!file.startsWith(`${folder}${path.sep}`) || !existsSync(file) || !statSync(file).isFile()) return null;
  return { body: readFileSync(file), type: CONTENT_TYPES[path.extname(file).toLowerCase()] || "application/octet-stream" };
}

/**
 * The file a development request path names (`/styles/system.css`,
 * `/assets/50%25.svg`, `/tokens.css`), or null. This is the HTTP boundary:
 * each segment is URL-decoded here, then judged, so an encoded slash or dot
 * cannot name a file outside the system's folder of that name.
 */
export function requestStaticFile(systemRoot, pathname, tokensCss) {
  if (tokensCss && pathname === "/tokens.css") return { body: compileTokenCss(readTokens(systemRoot)), type: CONTENT_TYPES[".css"] };
  const [, directory, ...encoded] = pathname.split("/");
  let segments;
  try {
    segments = encoded.map(decodeURIComponent);
  } catch {
    return null;
  }
  return readStaticFile(systemRoot, directory, segments);
}

/** Every file of the system's static folders as [folder, on-disk segments], sorted. */
export function listStaticFiles(systemRoot) {
  const files = [];
  const walk = (directory, folder, segments) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(directory, entry.name), folder, [...segments, entry.name]);
      else if (entry.isFile()) files.push([folder, [...segments, entry.name]]);
    }
  };
  for (const folder of STATIC_DIRECTORIES) walk(path.join(systemRoot, "src", folder), folder, []);
  return files.sort((left, right) => [left[0], ...left[1]].join("/").localeCompare([right[0], ...right[1]].join("/")));
}

/**
 * Copy the system's static folders, and tokens.css on the starter build,
 * into the build's client output under their names on disk. Returns how
 * many files were written.
 */
export async function writeStaticFiles(systemRoot, clientDirectory, tokensCss) {
  let count = 0;
  if (tokensCss) {
    await mkdir(clientDirectory, { recursive: true });
    await writeFile(path.join(clientDirectory, "tokens.css"), compileTokenCss(readTokens(systemRoot)));
    count += 1;
  }
  for (const [folder, segments] of listStaticFiles(systemRoot)) {
    const found = readStaticFile(systemRoot, folder, segments);
    if (!found) throw new Error(`Could not read src/${folder}/${segments.join("/")} of the Design System at ${systemRoot}.`);
    const target = path.join(clientDirectory, folder, ...segments);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, found.body);
    count += 1;
  }
  return count;
}

/** Publish the staged styles and their relative assets under a release-specific namespace. */
async function writeDependencyFiles(inputs, clientDirectory) {
  let count = 0;
  for (const { files, assetPrefix } of inputs.values()) {
    for (const [file, bytes] of files) {
      if (!file.startsWith("files/")) continue;
      const target = path.join(clientDirectory, assetPrefix.slice(1), file.slice(6));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: "wx" });
      count++;
    }
  }
  return count;
}

function requestDependencyFile(inputs, pathname) {
  for (const { files, assetPrefix } of inputs?.values() ?? []) {
    if (!pathname.startsWith(`${assetPrefix}/`)) continue;
    const body = files.get(`files/${pathname.slice(assetPrefix.length + 1)}`);
    if (!body) return null;
    return { body, type: CONTENT_TYPES[path.extname(pathname).toLowerCase()] || "application/octet-stream" };
  }
  return null;
}

/**
 * The virtual module's source: the rendered design and the site's form
 * handlers, each as the file the route's log names (relative to the site)
 * and a loader.
 */
export function virtualModuleSource(rendered, handlers, siteRoot, inventory = {}) {
  const forms = [...handlers].map(([route, file]) => `  ${JSON.stringify(route)}: { file: ${JSON.stringify(path.relative(siteRoot, file).split(path.sep).join("/"))}, load: () => import(${JSON.stringify(file.split(path.sep).join("/"))}) },`);
  const layouts = (rendered.composition?.divisions ?? []).map(({ id, layout }) =>
    `  ${JSON.stringify(id)}: () => import(${JSON.stringify(path.join(siteRoot, layout).split(path.sep).join("/"))}),`);
  return [
    `export const system = ${JSON.stringify(rendered.system)};`,
    `export const design = ${JSON.stringify(rendered.design)};`,
    `export const pages = ${JSON.stringify(rendered.pages.map(({ route, title, htmlAttributes, head, bodyAttributes, body, division }) => ({ route, title, htmlAttributes, head, bodyAttributes, body, ...(division ? { division } : {}) })))};`,
    `export const divisionContexts = ${JSON.stringify(rendered.contexts ?? {})};`,
    `export const collectionContexts = ${JSON.stringify(rendered.collectionContexts ?? {})};`,
    `export const divisionLayouts = {\n${layouts.join("\n")}${layouts.length ? "\n" : ""}};`,
    `export const mainLayout = () => import(${JSON.stringify(path.join(siteRoot, "src/layouts/Base.astro").split(path.sep).join("/"))});`,
    `export const mainPage = () => import(${JSON.stringify(path.join(siteRoot, "src/components/DesignPage.astro").split(path.sep).join("/"))});`,
    `export const shell = ${JSON.stringify(rendered.shell)};`,
    `export const titleMarker = ${JSON.stringify(TITLE_MARKER)};`,
    `export const sectionsContract = ${JSON.stringify(inventory.sectionsContract ?? 2)};`,
    `export const sections = ${JSON.stringify(inventory.sections ?? DEFAULT_SECTIONS)};`,
    `export const sectionSchema = ${JSON.stringify(inventory.sectionSchema ?? null)};`,
    `export const routeError = ${JSON.stringify(inventory.routeError ?? null)};`,
    `export const forms = {\n${forms.join("\n")}${forms.length ? "\n" : ""}};`,
  ].join("\n");
}

/**
 * The integration. `design` is the id of the website design the site's pages
 * and article shell come from (a folder under the system's src/designs/).
 */
export default function designSystem({ design }) {
  let systemRoot;
  let siteRoot;
  let base = "/";
  let clientDirectory;
  let tokensCss = false;
  let parse;
  let parseImports;
  let logger;
  let development = false;
  let hostAcknowledged = false;
  let routeFilesOptions;
  let resolvedRoutes = [];
  let lastRendered;
  let lastHandlers = new Map();
  let lastInputs;
  let routeError = null;
  let viteServer;
  const api = {};
  // Astro strips extra integration properties while resolving config. Other
  // integrations capture this function from the original configuration and
  // call it after setup to read the populated inventory.
  const publicApi = {
    getSections: () => api,
    getComposition: () => lastRendered?.composition ?? null,
    acknowledgeHostedSections(contract) {
      if (contract?.template !== 5 || contract?.tracking !== 1 || contract?.workspace !== 3 || contract?.sections !== 2 || contract?.composition !== COMPOSITION_CONTRACT) throw new Error("Hosted discovery must support template 5, workspace 3, sections 2, composition 1 and tracking 1.");
      hostAcknowledged = true;
      return true;
    },
  };
  const invalidate = () => {
    if (!viteServer) return;
    for (const environment of Object.values(viteServer.environments ?? {})) {
      const module = environment.moduleGraph?.getModuleById(RESOLVED_MODULE);
      if (!module) continue;
      environment.moduleGraph.invalidateModule(module);
      environment.hot?.send({ type: "full-reload" });
    }
    viteServer.ws.send({ type: "full-reload" });
  };
  const render = ({ revalidateRoutes = false } = {}) => {
    try {
      const handlers = formHandlers(siteRoot, { parse, warn: (message) => logger.warn(message) });
      const routeFiles = { ...readSectionRouteFiles(siteRoot, routeFilesOptions), resolvedRoutes };
      const composition = readDivisionComposition(siteRoot, api.sections, { previousInputs: revalidateRoutes ? lastInputs : null });
      const rendered = renderWorkspaceDesign(systemRoot, { design, base, forms: handlers.keys(), sections: api.sections, sectionsContract: api.sectionsContract, ...routeFiles });
      if (composition) {
        const sources = compositionSourceContexts(siteRoot, composition, api.sections, { htmlTags, parseImports, routeFiles });
        const routes = compositionRouteInventory(composition, rendered.inventory, handlers.keys(), routeFiles);
        const divisions = renderDivisions({ siteRoot, systemRoot, base, forms: new Set(handlers.keys()), composition, routes, sections: api.sections, publicFiles: routeFiles.publicFiles, main: rendered });
        Object.assign(rendered, { ...divisions, pages: [...rendered.pages, ...divisions.pages] });
        rendered.files.push(...[...sources.texts.keys()].map((file) => path.join(siteRoot, file)));
      }
      lastInputs = composition ? { systemsKey: composition.systemsKey, inputs: composition.inputs, dependencies: composition.dependencies } : null;
      lastRendered = rendered;
      lastHandlers = handlers;
      routeError = null;
      return rendered;
    } catch (error) {
      if (!development || !lastRendered) throw error;
      const message = `Site route inventory is invalid: ${error.message}`;
      if (routeError !== message) logger.error(`${message} Public routes return 503 until corrected.`);
      routeError = message;
      return lastRendered;
    }
  };
  return {
    name: "timds-design-system",
    api: publicApi,
    hooks: {
      "astro:config:setup": async ({ config, command, updateConfig, addMiddleware, injectRoute, addWatchFile, logger: integrationLogger }) => {
        siteRoot = fileURLToPath(config.root);
        logger = integrationLogger;
        development = command === "dev";
        routeFilesOptions = { pagesDirectory: path.join(fileURLToPath(config.srcDir), "pages"), publicDirectory: fileURLToPath(config.publicDir) };
        const sectionsModule = path.join(siteRoot, "src/lib/articles/sections.mjs");
        const sectionsFile = path.join(siteRoot, "sections.json");
        const schemaFile = path.join(siteRoot, "section-schema.json");
        const seedFile = path.join(siteRoot, "seed/seed.json");
        // These are Astro configuration inputs: its restart rebuilds injected
        // routes and keeps the previous configuration when a saved pair is
        // temporarily invalid. A Vite-only restart keeps the old route table.
        for (const file of [sectionsModule, sectionsFile, schemaFile, seedFile]) addWatchFile(file);
        const helpers = await import(`${pathToFileURL(sectionsModule).href}?modified=${statSync(sectionsModule).mtimeMs}`);
        const declaration = readJson(sectionsFile);
        if (declaration.schemaVersion !== 2) throw new Error("sections.json must use declaration schemaVersion 2.");
        const sections = helpers.normalizeSections(declaration);
        const model = helpers.normalizeSectionSchema(readJson(schemaFile));
        helpers.validateSectionSeed(readJson(seedFile), sections, model);
        Object.assign(api, { sectionsContract: declaration.schemaVersion, sections, sectionSchema: helpers.sectionSchemaFor(sections, model) });
        for (const section of sections) {
          injectRoute({ pattern: section.prefix, entrypoint: path.join(siteRoot, "src/routes/articles/index.astro"), prerender: false });
          injectRoute({ pattern: `${section.prefix}[slug]`, entrypoint: path.join(siteRoot, "src/routes/articles/entry.astro"), prerender: false });
          if (section.feed) injectRoute({ pattern: `${section.prefix}rss.xml`, entrypoint: path.join(siteRoot, "src/routes/articles/rss.xml.ts"), prerender: false });
        }
        parse = await loadModuleParser(siteRoot);
        parseImports = await loadCompositionImportParser(siteRoot);
        systemRoot = findDesignSystem(siteRoot);
        if (!systemRoot) throw new Error(`No folder above ${siteRoot} holds timds.json. This site reads the Design System it sits in; keep it inside that Design System's folder.`);
        base = config.base || "/";
        if (config.trailingSlash === "never" && existsSync(path.join(siteRoot, "divisions.json"))) throw new Error("Site divisions require trailing slash support.");
        tokensCss = runsStarterBuild(readJson(path.join(systemRoot, "timds.json")));
        render();
        // Ahead of page routing, after EmDash's own middleware (registered
        // earlier, also "pre"), so a handler sees the request as a page would.
        addMiddleware({ entrypoint: new URL("./forms-middleware.mjs", import.meta.url), order: "pre" });
        updateConfig({
          vite: {
            // The design's files live above the site's root, which Vite serves
            // only from folders it is told about.
            server: { fs: { allow: [siteRoot, systemRoot] } },
            plugins: [{
              name: "timds-design-system",
              resolveId(id) {
                return id === VIRTUAL_MODULE ? RESOLVED_MODULE : undefined;
              },
              load(id) {
                if (id !== RESOLVED_MODULE) return undefined;
                const rendered = render();
                for (const file of rendered.files) this.addWatchFile(file);
                return virtualModuleSource(rendered, lastHandlers, siteRoot, { ...api, routeError });
              },
              configureServer(server) {
                viteServer = server;
                // The design lives above the site's root, where Vite does not
                // watch: watch it, and rebuild the module on any change to it
                // (a page added or removed changes the routes, not one file).
                // A form handler added or removed changes which forms are
                // enabled, so src/forms/ rebuilds it too.
                const manifestFile = path.join(systemRoot, "timds.json");
                const formsDirectory = path.join(siteRoot, "src", FORMS_DIRECTORY);
                const publicDirectory = routeFilesOptions.publicDirectory;
                const divisionsDirectory = path.join(siteRoot, "src/divisions");
                const divisionsFile = path.join(siteRoot, "divisions.json");
                const layoutsDirectory = path.join(siteRoot, "src/layouts");
                const systemDesigns = path.join(systemRoot, "src/designs");
                const watchedDirectories = [systemDesigns, formsDirectory, publicDirectory, divisionsDirectory, layoutsDirectory, path.join(siteRoot, "src"), divisionInputsRoot(siteRoot)];
                server.watcher.add([...watchedDirectories, manifestFile, divisionsFile]);
                const reload = (file) => {
                  if (file !== manifestFile && file !== divisionsFile && !watchedDirectories.some((directory) => file === directory || file.startsWith(`${directory}${path.sep}`))) return;
                  render();
                  invalidate();
                };
                for (const event of ["add", "change", "unlink", "addDir", "unlinkDir"]) server.watcher.on(event, reload);
                server.middlewares.use((request, response, next) => {
                  const url = new URL(request.url || "/", "http://localhost");
                  const prefix = basePrefix(base);
                  // Under a base the request may reach this before or after
                  // Vite takes the base off; both name the same file.
                  const pathname = prefix && url.pathname.startsWith(`${prefix}/`) ? url.pathname.slice(prefix.length) : url.pathname;
                  const sectionRequest = [...api.sections.map((section) => section.prefix), "/topics/"].some((namespace) => pathname === namespace.slice(0, -1) || pathname.startsWith(namespace));
                  const composed = Boolean(lastRendered?.composition) || existsSync(path.join(siteRoot, "divisions.json"));
                  const dividedRequest = lastRendered?.composition?.divisions.some(({ prefix }) => inNamespace(pathname, prefix));
                  if (sectionRequest || dividedRequest) {
                    // Vite can serve public assets before Astro middleware,
                    // and a removed asset may not emit another route event.
                    // Recheck here so a collision cannot bypass the guard or
                    // leave it stuck until an unrelated page is requested.
                    const previousError = routeError;
                    render({ revalidateRoutes: !routeError });
                    if (previousError !== routeError) invalidate();
                  }
                  if (routeError && (sectionRequest || composed && !pathname.startsWith("/_emdash/"))) {
                    response.writeHead(503, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
                    response.end("Site route configuration needs correction.");
                    return;
                  }
                  const found = requestDependencyFile(lastRendered?.inputs, pathname) ?? requestStaticFile(systemRoot, pathname, tokensCss);
                  if (!found) return next();
                  response.writeHead(200, { "Content-Type": found.type, "Cache-Control": "no-store" });
                  response.end(found.body);
                });
              },
            }],
          },
        });
      },
      "astro:routes:resolved": ({ routes }) => {
        // Astro invokes this again when a native page route is added or removed.
        // Validate the same inventory used by consumer check and preview before
        // a file route can take precedence over an injected collection route.
        // Astro's pattern omits base; its patternRegex includes it. Resolve
        // component paths against the site so owned pairs compare identically.
        resolvedRoutes = routes.map((route) => ({ ...route, entrypoint: path.relative(siteRoot, path.resolve(siteRoot, route.entrypoint)).split(path.sep).join("/") }));
        render();
        invalidate();
      },
      "astro:config:done": ({ config }) => {
        if (config.integrations.some((integration) => integration.name === "timds-host-discovery") && !hostAcknowledged) throw new Error("Hosted discovery has not acknowledged template 5, workspace 3, sections 2, composition 1 and tracking 1. Update the host before building this site.");
        clientDirectory = fileURLToPath(config.build.client);
      },
      "astro:build:done": async ({ logger }) => {
        const localCount = await writeStaticFiles(systemRoot, clientDirectory, tokensCss);
        const dependencyCount = await writeDependencyFiles(lastRendered?.inputs ?? new Map(), clientDirectory);
        const count = localCount + dependencyCount;
        logger.info(`Wrote ${count} Design System file${count === 1 ? "" : "s"} from ${systemRoot} into the build`);
      },
    },
  };
}

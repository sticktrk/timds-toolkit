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
// that exports POST. The virtual module lists those handlers for the
// catch-all route, which calls one for a POST to its address and answers 405
// to any other method it does not serve. A posting form whose address has no
// handler is rendered disabled, with a line saying it is not connected yet,
// so a visitor is never offered a Send button that sends nothing. Which forms
// have a handler is decided from the site's files each time the module is
// built, in development and in the build alike.
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
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VIRTUAL_MODULE = "virtual:timds/design-system";
const RESOLVED_MODULE = `\0${VIRTUAL_MODULE}`;
/** The folders under the system's src/ that its build serves at the same name. */
export const STATIC_DIRECTORIES = ["assets", "scripts", "styles"];
/** Routes the article templates serve; a design page there is a sample of a template, never a page. */
export const ARTICLE_ROUTE = /^\/(?:articles|topics)(?:\/|$)/;
/** Stands in for the page title in the article shell until a request fills it. */
export const TITLE_MARKER = "\u0000timds-title\u0000";
const CONTENT_MARKER = "\u0000timds-content\u0000";
const PLACEHOLDER = /\{\{\s*([a-z]+)\s*\}\}/g;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** The state a page file with no state in its name has, as the designs catalog names it. */
export const DEFAULT_STATE = "default";
/** The folder of the site, under src/, whose modules handle the design's posting forms. */
export const FORMS_DIRECTORY = "forms";
const FORM_HANDLER_EXTENSIONS = [".ts", ".mjs", ".js"];
const EXPORTS_POST = /\bexport\s+(?:async\s+)?(?:function\s*\*?|const|let|var)\s+POST\b|\bexport\s*\{[^}]*\bPOST\b[^}]*\}/;
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
  ".png": "image/png",
  ".svg": "image/svg+xml",
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

/**
 * Put `base` in front of every root-relative reference in the markup (href,
 * src, action, poster, and each srcset candidate). External, protocol-relative,
 * fragment and query references are left as written, and so is a reference
 * that already starts with the base.
 */
export function applyBase(html, base) {
  const prefix = basePrefix(base);
  if (!prefix) return html;
  const rebase = (value) => {
    if (!value.startsWith("/") || value.startsWith("//")) return value;
    if (value === prefix || value.startsWith(`${prefix}/`) || value.startsWith(`${prefix}?`) || value.startsWith(`${prefix}#`)) return value;
    return `${prefix}${value}`;
  };
  return outsideScripts(html, (markup) => markup
    .replace(/(\s(?:href|src|action|poster)\s*=\s*)("([^"]*)"|'([^']*)')/gi, (_match, name, _quoted, double, single) => {
      const value = double ?? single;
      const quote = double === undefined ? "'" : '"';
      return `${name}${quote}${rebase(value)}${quote}`;
    })
    .replace(/(\ssrcset\s*=\s*)("([^"]*)"|'([^']*)')/gi, (_match, name, _quoted, double, single) => {
      const value = double ?? single;
      const quote = double === undefined ? "'" : '"';
      const candidates = value.split(",").map((candidate) => candidate.replace(/^(\s*)(\S+)/, (_whole, space, url) => `${space}${rebase(url)}`));
      return `${name}${quote}${candidates.join(",")}${quote}`;
    }));
}

/** The attributes of one start tag as an object, entities decoded so Astro escapes them once. */
export function parseAttributes(source) {
  const attributes = {};
  for (const match of String(source || "").matchAll(/([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    attributes[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
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

function htmlFiles(directory, prefix = "") {
  if (!existsSync(directory)) return [];
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...htmlFiles(path.join(directory, entry.name), relative));
    else if (entry.isFile() && entry.name.endsWith(".html")) found.push(relative);
  }
  return found;
}

/**
 * The route of a page file's default state, by the designs catalog's rule:
 * `about.html` and `about.default.html` are the default of /about,
 * `index.html` the default of its folder's route. A named state
 * (`contact.sent.html`), or a name the catalog refuses (`a.b.c.html`), is
 * null.
 */
export function pageRoute(relative) {
  const segments = relative.split("/");
  const parts = segments.pop().replace(/\.html$/, "").split(".");
  if (parts.length > 2) return null;
  const [name, state = DEFAULT_STATE] = parts;
  if (state !== DEFAULT_STATE) return null;
  return `/${(name === "index" ? segments : [...segments, name]).join("/")}`;
}

/**
 * The page files of a design's pages/ folder that are a route's default
 * state, as [route, relative file] pairs. Two files for one route
 * (`about.html` and `about.default.html`) are refused, as the catalog
 * refuses them.
 */
export function defaultPageFiles(pagesDirectory) {
  const byRoute = new Map();
  for (const relative of htmlFiles(pagesDirectory)) {
    const route = pageRoute(relative);
    if (!route) continue;
    if (byRoute.has(route)) throw new Error(`pages/${relative} and pages/${byRoute.get(route)} both describe route ${route}; keep one`);
    byRoute.set(route, relative);
  }
  return [...byRoute];
}

/**
 * The site's form handlers: every module under src/forms/ that exports POST,
 * by the address it handles (`contact.ts` and `contact/index.ts` are
 * /contact, `index.ts` is /). A module that does not export POST handles
 * nothing. Two modules for one address are refused.
 */
export function formHandlers(siteRoot) {
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
      if (!EXPORTS_POST.test(readFileSync(file, "utf8"))) continue;
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

/**
 * Every `<form method="post">` in the markup whose address (`formTarget`)
 * has no handler in `handled`, rendered disabled: each control gets
 * `disabled`, the form `data-timds-form="not-connected"`, and a paragraph
 * says the form is not connected yet. Attributes and a plain paragraph only,
 * so the page uses no class the Design System does not declare. A form that
 * posts to another origin is the design's own wiring and is left alone.
 */
export function disableUnconnectedForms(html, { route = null, handled = new Set() } = {}) {
  return outsideScripts(html, (markup) => markup.replace(/<form\b([^>]*)>([\s\S]*?)(<\/form\s*>|$)/gi, (whole, attributes, inner, close) => {
    const parsed = parseAttributes(attributes);
    if (String(parsed.method || "").trim().toLowerCase() !== "post") return whole;
    const target = formTarget(parsed.action, route);
    if (target === "external" || (target && handled.has(target))) return whole;
    const disabled = inner.replace(/<(input|button|select|textarea|fieldset)\b([^>]*?)(\/?)>/gi, (tag, name, rest, selfClosing) => (
      /(?:^|\s)disabled(?:\s|=|$)/i.test(rest) ? tag : `<${name}${rest} disabled${selfClosing}>`
    ));
    return `<form${attributes} data-timds-form="not-connected"><p role="note">${FORM_NOT_CONNECTED}</p>${disabled}${close}`;
  }));
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
export function renderWorkspaceDesign(systemRoot, { design: designId, base = "/", forms = new Set() }) {
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
  const titles = new Map(Object.entries(declared.pages ?? {}).map(([route, page]) => [route.length > 1 ? `/${route.replace(/^\/+|\/+$/g, "")}` : "/", typeof page === "string" ? page : page?.title]));
  const layoutFile = path.join(directory, "layout.html");
  const layout = existsSync(layoutFile) ? readFileSync(layoutFile, "utf8") : null;
  const files = [layoutFile, path.join(directory, "design.json")];

  const handled = new Set(forms);
  const defaults = defaultPageFiles(path.join(directory, "pages"));
  const pages = [];
  for (const [route, relative] of defaults) {
    if (ARTICLE_ROUTE.test(route)) continue;
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
  return { system, design: { id: designId, title: String(declared.title || designId), layout: layout !== null }, pages, shell, files };
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

/** The virtual module's source: the rendered design and the site's form handlers. */
export function virtualModuleSource(rendered, handlers) {
  const forms = [...handlers].map(([route, file]) => `  ${JSON.stringify(route)}: () => import(${JSON.stringify(file.split(path.sep).join("/"))}),`);
  return [
    `export const system = ${JSON.stringify(rendered.system)};`,
    `export const design = ${JSON.stringify(rendered.design)};`,
    `export const pages = ${JSON.stringify(rendered.pages.map(({ route, title, htmlAttributes, head, bodyAttributes, body }) => ({ route, title, htmlAttributes, head, bodyAttributes, body })))};`,
    `export const shell = ${JSON.stringify(rendered.shell)};`,
    `export const titleMarker = ${JSON.stringify(TITLE_MARKER)};`,
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
  return {
    name: "timds-design-system",
    hooks: {
      "astro:config:setup": ({ config, updateConfig }) => {
        siteRoot = fileURLToPath(config.root);
        systemRoot = findDesignSystem(siteRoot);
        if (!systemRoot) throw new Error(`No folder above ${siteRoot} holds timds.json. This site reads the Design System it sits in; keep it inside that Design System's folder.`);
        base = config.base || "/";
        tokensCss = runsStarterBuild(readJson(path.join(systemRoot, "timds.json")));
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
                const handlers = formHandlers(siteRoot);
                const rendered = renderWorkspaceDesign(systemRoot, { design, base, forms: handlers.keys() });
                for (const file of rendered.files) this.addWatchFile(file);
                return virtualModuleSource(rendered, handlers);
              },
              configureServer(server) {
                // The design lives above the site's root, where Vite does not
                // watch: watch it, and rebuild the module on any change to it
                // (a page added or removed changes the routes, not one file).
                // A form handler added or removed changes which forms are
                // enabled, so src/forms/ rebuilds it too.
                const designDirectory = path.join(systemRoot, "src", "designs", design);
                const manifestFile = path.join(systemRoot, "timds.json");
                const formsDirectory = path.join(siteRoot, "src", FORMS_DIRECTORY);
                server.watcher.add([designDirectory, manifestFile, formsDirectory]);
                const reload = (file) => {
                  if (file !== manifestFile && !file.startsWith(`${designDirectory}${path.sep}`) && !file.startsWith(`${formsDirectory}${path.sep}`)) return;
                  for (const environment of Object.values(server.environments ?? {})) {
                    const module = environment.moduleGraph?.getModuleById(RESOLVED_MODULE);
                    if (!module) continue;
                    environment.moduleGraph.invalidateModule(module);
                    environment.hot?.send({ type: "full-reload" });
                  }
                  server.ws.send({ type: "full-reload" });
                };
                for (const event of ["add", "change", "unlink"]) server.watcher.on(event, reload);
                server.middlewares.use((request, response, next) => {
                  const url = new URL(request.url || "/", "http://localhost");
                  const prefix = basePrefix(base);
                  // Under a base the request may reach this before or after
                  // Vite takes the base off; both name the same file.
                  const pathname = prefix && url.pathname.startsWith(`${prefix}/`) ? url.pathname.slice(prefix.length) : url.pathname;
                  const found = requestStaticFile(systemRoot, pathname, tokensCss);
                  if (!found) return next();
                  response.writeHead(200, { "Content-Type": found.type, "Cache-Control": "no-store" });
                  response.end(found.body);
                });
              },
            }],
          },
        });
      },
      "astro:config:done": ({ config }) => {
        clientDirectory = fileURLToPath(config.build.client);
      },
      "astro:build:done": async ({ logger }) => {
        const count = await writeStaticFiles(systemRoot, clientDirectory, tokensCss);
        logger.info(`Wrote ${count} Design System file${count === 1 ? "" : "s"} from ${systemRoot} into the build`);
      },
    },
  };
}

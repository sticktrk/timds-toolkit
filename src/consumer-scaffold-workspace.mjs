// `timds consumer scaffold emdash --workspace`: put a complete EmDash site in
// `site/` of a Design System workspace, reading the system from its source.
//
// The site is the shared EmDash template set (templates/emdash/site/ and
// site-cloudflare/: the seed, the article, topic and feed routes, the
// Portable Text serializer, src/live.config.ts, the Worker entry and the
// writer's contract) with templates/emdash/site-workspace/ on top: the Astro
// and Worker configuration, the layout and pages, the integration that reads
// the Design System (src/integrations/design-system.mjs), the lockfile, the
// guidance and the workspace handover. Generated beside them:
//
//   package.json          private, exact versions from templates/emdash/
//                         site.json, so the three modes share one list; the
//                         site is its own package, not an npm workspace of
//                         the root, and declares no toolkit
//   timds.consumer.json   the workspace form, `designSystem: { workspace:
//                         true, systemId }` with no path and no version, and
//                         the crawl preview with the design pairs
//   .timds/emdash.json    the template version, platform, mode and the
//                         sha256 of every template file written, and what
//                         was written outside the site (below)
//
// Outside the site, where the system's own guidance is, it adds the two
// consumer skills, rendered for the site's manifest (consumer-init.mjs
// `consumerSkillFiles`, with the site's folder from the repository root and
// the workspace's installation mode), to the repository root's
// `.agents/skills/` beside the system's skills, and one delimited section to
// the system's `AGENTS.md` (created when there is none) that says where the
// site is and which change goes where. The record lists them as
// `workspaceFiles` (repository-relative path to sha256) and
// `workspaceSections` (repository-relative path to the section's marker and
// the sha256 of the section), so a later update can refresh them and
// removing the site can find them. A skill folder that holds anything else
// is refused; one that holds exactly the planned bytes is kept; a section
// that is already there is left as it is.
//
// Nothing is pinned and nothing is copied out of the system: the pages are
// built from the system's website design and its stylesheets and tokens are
// read from their source paths when the site builds. The mode asks nothing
// and runs no generator, so one toolkit release writes the same bytes for the
// same workspace: every name is derived from the system's id. Every refusal
// comes before the first write, a failed write removes what the run wrote,
// and only then, unless --skip-install, `npm ci` runs in the site.
//
// Boundary: everything written is product source of the site and its
// system; of the system's files only `AGENTS.md` gains its section, and
// nothing else is written outside `site/`. They are outside the Design
// System's managed set: `upgrade` never touches the site folder, the two
// consumer skills or the section.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, promises as fs } from "node:fs";
import path from "node:path";

import { CONSUMER_MANIFEST_FILE, CONSUMER_SKILL_NAMES, validateConsumerManifest } from "./consumer.mjs";
import { normalizeSections, normalizeSectionSchema, createSectionSeed, validateSectionSeed, isSectionRoute, writerSectionTable } from "../templates/emdash/site/src/lib/articles/sections.mjs";
import { sectionRouteInventory, readSectionRouteFiles } from "../templates/emdash/site-workspace/src/integrations/section-routes.mjs";
import { compositionRouteInventory, readDivisionComposition } from "../templates/emdash/site-workspace/src/integrations/composition.mjs";
import { divisionStyles } from "../templates/emdash/site-workspace/src/integrations/design-system.mjs";
import { WORKSPACE_SITE_AGENTS_MARKER, WORKSPACE_SITE_DIRECTORY, WORKSPACE_SITE_MOUNT } from "./workspace-site.mjs";

/** The template directory the workspace mode lays over the shared set. */
export const WORKSPACE_TEMPLATE_DIRECTORY = "site-workspace";
/** The layout the article routes import, relative to the site root. */
export const WORKSPACE_LAYOUT = "src/layouts/Base.astro";
/** The app the manifest declares for the site. */
export const WORKSPACE_APP_NAME = "site";
/** The template files that are generated or edited by npm, never compared by hash. */
const UNHASHED = new Set(["package-lock.json"]);
const DEV_PORT = 4380;
const DEV_SEED_ROUTE = "/_emdash/api/setup/dev-bypass";
const LOCKFILE = "package-lock.json";
const DEFAULT_SECTIONS = normalizeSections(JSON.parse(readFileSync(new URL("../templates/emdash/site/sections.json", import.meta.url), "utf8")));
const CONTENT_PROFILES = new Set(["portable-text", "html"]);
// Injected routes share these modules regardless of their declared prefix.
function articleRouteFiles(sections) {
  return Object.fromEntries([
    ...sections.flatMap((section) => [[section.prefix.slice(0, -1), "src/routes/articles/index.astro"], [`${section.prefix}[slug]`, "src/routes/articles/entry.astro"]]),
    ["/topics/[slug]", "src/pages/topics/[slug].astro"],
  ]);
}
const STATIC_DIRECTORIES = ["assets", "scripts", "styles"];
/** The system's guidance file that gains the site's section, relative to the Design System root. */
const AGENTS_FILE = "AGENTS.md";
/** The marker of that section: `<!-- timds:emdash-site -->` opens it and `<!-- /timds:emdash-site -->` closes it. */
export const WORKSPACE_AGENTS_MARKER = WORKSPACE_SITE_AGENTS_MARKER;
const AGENTS_SECTION_TEMPLATE = "AGENTS-workspace-site.md";

const toJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (content) => createHash("sha256").update(content).digest("hex");

function slug(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "site";
}

async function readJsonFile(filePath, label) {
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (caught) {
    if (caught?.code === "ENOENT") return null;
    throw caught;
  }
  try {
    return JSON.parse(text);
  } catch (caught) {
    throw new Error(`${label} is not valid JSON (${caught.message}); fix it, then rerun`);
  }
}

/** True when the system runs the starter build, which writes tokens.css from the tokens. */
export function runsStarterBuild(manifest) {
  const build = manifest?.workspace?.build;
  if (!Array.isArray(build)) return false;
  const command = build.join(" ");
  return command === "node scripts/build.mjs" || command === "timds-cli run scripts/build.mjs";
}

/**
 * The Design System root the workspace commands would use for `rootInput`:
 * the repository root (a hosted session, the git top level, or the nearest
 * folder holding timds.json or design-system/timds.json) when it is a
 * standalone system, else its embedded design-system/ folder. Null when
 * neither holds timds.json.
 */
export async function resolveWorkspaceRoot(rootInput) {
  const requested = path.resolve(rootInput || process.cwd());
  const info = await fs.stat(requested).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`--root ${rootInput || requested} is not a directory. Run the workspace mode in a Design System workspace (the folder that holds timds.json), or name it with --root PATH.`);
  const { findRepositoryRoot } = await import("./core.mjs");
  // Both roots are canonical (symlinks resolved, as git reports its top
  // level), so a path from one to the other never crosses a symlink: a
  // --root spelled through /var on macOS must still put the site at site/.
  const repoRoot = await fs.realpath(await findRepositoryRoot(requested));
  for (const candidate of [repoRoot, path.join(repoRoot, "design-system")]) {
    if (!existsSync(path.join(candidate, "timds.json"))) continue;
    const designSystemRoot = await fs.realpath(candidate);
    return { repoRoot, designSystemRoot, layout: designSystemRoot === repoRoot ? "standalone" : "embedded" };
  }
  return null;
}

/** The website design the site is built from: the one with a home page, `website` first, else the first in order. */
export function selectWebsiteDesign(designs, sections = DEFAULT_SECTIONS) {
  const pageRoutes = (design) => design.pages.map((page) => page.route).filter((route) => !isSectionRoute(route, sections));
  const withHome = designs.filter((design) => pageRoutes(design).includes("/"));
  const candidates = withHome.length ? withHome : designs.filter((design) => pageRoutes(design).length || design.layout);
  return candidates.find((design) => design.id === "website") ?? candidates[0] ?? null;
}

/** Resolve only the exported configuration's literal integration, without running it. */
async function literalWorkspaceDesign(text, file, required) {
  const { default: ts } = await import("typescript");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const invalid = () => { throw new Error(`${file} must expose one literal designSystem({ design: "<id>" }) in its exported integrations for consumer checks and previews.`); };
  if (source.parseDiagnostics.length) invalid();
  const bindings = new Map();
  let integration = null, configHelper = null;
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text.endsWith("/integrations/design-system.mjs")) integration = statement.importClause?.name?.text ?? integration;
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === "astro/config") {
      const imports = statement.importClause?.namedBindings;
      if (imports && ts.isNamedImports(imports)) configHelper = imports.elements.find((item) => (item.propertyName ?? item.name).text === "defineConfig")?.name.text ?? configHelper;
    }
    if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const) for (const item of statement.declarationList.declarations) if (ts.isIdentifier(item.name) && item.initializer) bindings.set(item.name.text, item.initializer);
  }
  const unwrap = (node, seen = new Set()) => {
    if (!node) return node;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return unwrap(node.expression, seen);
    if (ts.isIdentifier(node) && bindings.has(node.text)) {
      if (seen.has(node.text)) invalid();
      return unwrap(bindings.get(node.text), new Set([...seen, node.text]));
    }
    return node;
  };
  const property = (object, name) => {
    if (!object || !ts.isObjectLiteralExpression(object) || object.properties.some((item) => ts.isSpreadAssignment(item) || item.name && ts.isComputedPropertyName(item.name))) invalid();
    const matches = object.properties.filter((item) => item.name && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && item.name.text === name);
    if (matches.length > 1) invalid();
    const item = matches[0];
    if (!item) return null;
    if (!ts.isPropertyAssignment(item) && !ts.isShorthandPropertyAssignment(item)) invalid();
    return unwrap(ts.isPropertyAssignment(item) ? item.initializer : item.name);
  };
  const exports = source.statements.filter((node) => ts.isExportAssignment(node) && !node.isExportEquals);
  if (exports.length !== 1) invalid();
  let config = unwrap(exports[0].expression);
  if (ts.isCallExpression(config)) {
    if (!configHelper || !ts.isIdentifier(config.expression) || config.expression.text !== configHelper || config.arguments.length !== 1) invalid();
    config = unwrap(config.arguments[0]);
  }
  const integrations = property(config, "integrations");
  if (!integrations && !required) return null;
  if (!integrations || !ts.isArrayLiteralExpression(integrations)) invalid();
  const calls = integrations.elements.map((item) => unwrap(item));
  if (calls.some((item) => ts.isSpreadElement(item))) invalid();
  if (!integration) invalid();
  const selected = calls.filter((item) => ts.isCallExpression(item) && ts.isIdentifier(item.expression) && item.expression.text === integration);
  if (selected.length !== 1) invalid();
  if (selected[0].arguments.length !== 1) invalid();
  const value = property(unwrap(selected[0].arguments[0]), "design");
  if (value === null) invalid();
  if (!ts.isStringLiteral(value) && !ts.isNoSubstitutionTemplateLiteral(value)) invalid();
  return value.text;
}

/** Read the scaffold's literal design selection without executing the site's configuration. */
export async function selectWorkspaceDesign({ siteRoot, designSystemRoot, designs, sections = DEFAULT_SECTIONS }) {
  designs ??= (await (await import("./designs.mjs")).readDesignCatalog(designSystemRoot)).designs;
  for (const file of ["astro.config.mjs", "astro.config.js", "astro.config.ts", "astro.config.mts", "astro.config.cjs", "astro.config.cts"]) {
    const text = await fs.readFile(path.join(siteRoot, file), "utf8").catch((caught) => {
      if (caught?.code === "ENOENT" || caught?.code === "EISDIR") return null;
      throw caught;
    });
    if (text === null) continue;
    const selection = await literalWorkspaceDesign(text, file, existsSync(path.join(siteRoot, "sections.json")) || existsSync(path.join(siteRoot, ".timds/emdash.json")));
    if (selection === null) break;
    const entry = designs.find((design) => design.id === selection);
    if (!entry) {
      const ids = designs.map((design) => design.id);
      throw new Error(`The site's ${file} renders the website design "${selection}", but the Design System has no src/designs/${selection}/design.json. Name one it has${ids.length ? ` (${ids.join(", ")})` : ""} in ${file}, or add that design to the system.`);
    }
    return { id: entry.id, entry, selectedBy: file };
  }
  const entry = selectWebsiteDesign(designs, sections);
  if (!entry) throw new Error("The two-way check reads the styles the site loads from the website design it renders inside, and the Design System has none (src/designs/<id>/ with a layout.html or pages/index.html). Add one with timds designs init, then name it in the site's astro.config.mjs as designSystem({ design: \"<id>\" }).");
  return { id: entry.id, entry, selectedBy: "catalog" };
}

/**
 * What a workspace site's pages load from the design they render inside: the
 * design's shell (its layout.html, else its home page, as the site
 * integration builds the article shell) and that shell's stylesheet links, in
 * order. Each link is `{ href, path }` with `path` the system-relative file
 * the integration serves for it (`/styles/x.css` is `src/styles/x.css`), or
 * `{ href: "/tokens.css", tokens: true }` for the compiled tokens; a link the
 * site does not serve is left out. Each link also carries `media`: its
 * `media` attribute, or null when it has none or it is `all`. `stylesheets` maps every served href,
 * `@import`s included, to its text, and `inline` lists the shell's `<style>`
 * blocks. A design with neither layout nor pages loads nothing.
 */
export async function designShellStylesheets(designSystemRoot, design) {
  const { stylesheetReferences } = await import("./tokens.mjs");
  const page = design.pages.find((entry) => entry.route === "/") ?? design.pages[0];
  const shell = design.layout ?? page?.states[0]?.path ?? null;
  const html = shell ? await fs.readFile(shell, "utf8") : "";
  const references = stylesheetReferences(html);
  // The `media` of each link, in the order stylesheetReferences lists them
  // (same filter), so a conditional sheet can be told apart.
  const { attr, byTag, parseHtml } = await import("./html.mjs");
  const medias = byTag(parseHtml(html), "link")
    .filter((node) => String(attr(node, "rel") ?? "").toLowerCase().split(/\s+/).includes("stylesheet"))
    .map((node) => ({ href: String(attr(node, "href") ?? "").trim(), media: String(attr(node, "media") ?? "").trim() }))
    .filter((link) => link.href && !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(link.href))
    .map((link) => (/^(?:all)?$/i.test(link.media) ? null : link.media));
  const links = [];
  for (const [index, href] of references.links.map((entry) => path.posix.normalize(entry.split(/[?#]/, 1)[0])).entries()) {
    const media = medias[index] ?? null;
    if (href === "/tokens.css") links.push({ href, tokens: true, media });
    else {
      // An href is a URL: decode each segment once, as the site's dev server
      // does, and keep the file inside its folder.
      const [, directory, ...encoded] = href.split("/");
      let rest;
      try {
        rest = encoded.map((segment) => decodeURIComponent(segment));
      } catch {
        continue;
      }
      if (rest.some((segment) => !segment || segment === "." || segment === ".." || /[\\/\0]/.test(segment))) continue;
      if (STATIC_DIRECTORIES.includes(directory) && rest.length && existsSync(path.join(designSystemRoot, "src", directory, ...rest))) links.push({ href, path: ["src", directory, ...rest].join("/"), media });
    }
  }
  return {
    shell: shell && path.relative(designSystemRoot, shell).split(path.sep).join("/"),
    links,
    inline: references.inline,
    stylesheets: await linkedStylesheets(designSystemRoot, html),
  };
}

/** Stylesheet links in `html` that resolve to a file the site serves from the system's src/. */
async function linkedStylesheets(designSystemRoot, html) {
  const { stylesheetReferences, importReferences } = await import("./tokens.mjs");
  const queue = stylesheetReferences(html).links.map((href) => href.split(/[?#]/, 1)[0]).filter((href) => href.startsWith("/") && !href.startsWith("//"));
  const found = new Map();
  while (queue.length) {
    const href = path.posix.normalize(queue.shift());
    if (found.has(href)) continue;
    const [, directory, ...rest] = href.split("/");
    if (!STATIC_DIRECTORIES.includes(directory) || !rest.length) continue;
    const css = await fs.readFile(path.join(designSystemRoot, "src", directory, ...rest), "utf8").catch(() => null);
    if (css === null) continue;
    found.set(href, css);
    for (const reference of importReferences(css)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(reference) || reference.startsWith("//")) continue;
      queue.push(reference.startsWith("/") ? reference : path.posix.join(path.posix.dirname(href), reference));
    }
  }
  return found;
}

/** Class names the markup of one template file and the components it imports use, from `class="..."` literals. */
async function templateClasses(templatesRoot, relative, seen = new Set()) {
  if (seen.has(relative)) return new Set();
  seen.add(relative);
  const text = await fs.readFile(path.join(templatesRoot, "site", ...relative.split("/")), "utf8").catch(() => null);
  if (text === null) return new Set();
  const classes = new Set();
  for (const match of text.matchAll(/\bclass="([^"{}]*)"/g)) for (const name of match[1].split(/\s+/).filter(Boolean)) classes.add(name);
  for (const match of text.matchAll(/^import\s+\w+\s+from\s+"(\.{1,2}\/[^"]+\.astro)";/gm)) {
    const imported = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
    for (const name of await templateClasses(templatesRoot, imported, seen)) classes.add(name);
  }
  return classes;
}

/**
 * Each article route with the classes its markup uses that the design's
 * stylesheets do not declare: a route listed here has no port to this
 * system yet. The routes are still installed.
 */
export async function articleRoutePorts({ designSystemRoot, design, templatesRoot, sections = DEFAULT_SECTIONS }) {
  const { declaredClasses } = await import("./designs.mjs");
  const sheets = (await designShellStylesheets(designSystemRoot, design)).stylesheets;
  const declared = new Set();
  for (const css of sheets.values()) for (const name of declaredClasses(css)) declared.add(name);
  const routes = [];
  for (const [route, file] of Object.entries(articleRouteFiles(sections))) {
    const used = [...await templateClasses(templatesRoot, file)].sort();
    const missing = used.filter((name) => !declared.has(name));
    routes.push({ route, file, classes: used, missing });
  }
  return { stylesheets: [...sheets.keys()].sort(), routes };
}

/** The site's package.json, from the template set's version list. */
export function workspacePackageJson(set, { name }) {
  const sorted = (entries) => Object.fromEntries(Object.entries(entries).sort(([left], [right]) => left.localeCompare(right)));
  return {
    name,
    private: true,
    type: "module",
    ...structuredClone(set.package),
    scripts: { ...set.workspace.scripts },
    dependencies: sorted({ ...set.dependencies.all, ...set.dependencies.cloudflare, ...set.workspace.dependencies }),
    devDependencies: sorted({ ...set.devDependencies.all, ...set.devDependencies.cloudflare, ...set.workspace.devDependencies }),
  };
}

/** Preview section routes follow sections.json; an own design wins, then the stock article design. */
export function sectionPreview(preview, sections, design, options = {}) {
  // The consumer manifest accepts trailing-slash aliases; compare canonical
  // paths in the effective preview while leaving its authored bytes alone.
  const routePath = (route) => route === "/" ? route : route.replace(/\/+$/, "");
  preview = { ...preview, routes: (preview.routes || []).map(routePath), designs: Object.fromEntries(Object.entries(preview.designs || {}).map(([route, reference]) => [routePath(route), routePath(reference)])) };
  const inventory = sectionRouteInventory(sections, design?.pages ?? [], options);
  const available = new Set(inventory.references.map((page) => page.route));
  const templateRoute = (route) => available.has(route) || isSectionRoute(route, sections) || ["/articles", "/articles/example-article"].includes(route);
  const authored = new Map(Object.entries(preview.designs || {}).filter(([route, reference]) => available.has(reference) && (inventory.pages.some((page) => page.route === route) || sections.some(({ prefix }) => route === prefix.slice(0, -1) || route.startsWith(prefix) && /^[^/]+$/.test(route.slice(prefix.length))) || /^\/topics\/[^/]+$/.test(route))));
  const routes = (preview.routes || []).filter((route) => authored.has(route) || !templateRoute(route));
  const designs = Object.fromEntries(Object.entries(preview.designs || {}).filter(([route]) => authored.has(route) || !templateRoute(route)));
  for (const page of inventory.pages) if (page.route !== "/404") { routes.push(page.route); designs[page.route] ??= page.route; }
  for (const item of inventory.sections) {
    for (const [route, fallback] of [[item.list, "/articles"], [item.sample, "/articles/example-article"]]) {
      routes.push(route);
      const reference = available.has(route) ? route : available.has(fallback) ? fallback : null;
      if (reference) designs[route] ??= reference;
    }
  }
  // Keep the default ordering, with the shared topic sample after section samples.
  const topic = "/topics/example-topic";
  if (available.has(topic)) designs[topic] ??= topic;
  return { ...preview, routes: [...new Set([...routes.filter((route) => route !== topic), ...((preview.routes || []).includes(topic) || available.has(topic) ? [topic] : [])])], designs };
}

/** Read only JSON data: consumer check and preview never execute the site's code. */
export async function readWorkspaceSectionDeclaration(siteRoot) {
  const declaration = await readJsonFile(path.join(siteRoot, "sections.json"), "sections.json");
  if (declaration === null) {
    // Workspace consumers need not be EmDash sites; an EmDash record requires the current declaration.
    if (!await readJsonFile(path.join(siteRoot, ".timds/emdash.json"), ".timds/emdash.json")) return null;
    throw new Error("sections.json is missing; restore its declaration before checking or previewing the site");
  }
  return { schemaVersion: declaration.schemaVersion, sections: normalizeSections(declaration) };
}

export async function readWorkspaceSections(siteRoot) {
  return (await readWorkspaceSectionDeclaration(siteRoot))?.sections ?? null;
}

export async function checkWorkspaceSectionSeed(siteRoot, sections) {
  const model = normalizeSectionSchema(await readJsonFile(path.join(siteRoot, "section-schema.json"), "section-schema.json"));
  const seed = await readJsonFile(path.join(siteRoot, "seed/seed.json"), "seed/seed.json");
  if (!seed) throw new Error("seed/seed.json is missing; run npm run sections:sync in the site");
  validateSectionSeed(seed, sections, model);
}

/** Derive preview inputs without rewriting the consumer manifest or its review boundary. */
export async function workspaceSectionApps(siteRoot, apps, systemRoot) {
  const declaration = await readWorkspaceSectionDeclaration(siteRoot);
  if (!declaration) return apps;
  const { sections, schemaVersion: version } = declaration;
  const routeFiles = readSectionRouteFiles(siteRoot);
  const composition = readDivisionComposition(siteRoot, sections);
  const catalog = systemRoot ? await (await import("./designs.mjs")).readDesignCatalog(systemRoot) : { designs: [] };
  const design = systemRoot ? (await selectWorkspaceDesign({ siteRoot, designSystemRoot: systemRoot, designs: catalog.designs, sections })).entry : null;
  const inventory = composition && sectionRouteInventory(sections, design?.pages ?? [], { version, ...routeFiles });
  const composedRoutes = composition && compositionRouteInventory(composition, inventory, [], routeFiles);
  if (composition) {
    if (!systemRoot) throw new Error("Site divisions require a workspace Design System.");
    for (const division of composition.divisions) divisionStyles(systemRoot, division, composition.inputs.get(division.system));
  }
  const result = {};
  for (const [name, app] of Object.entries(apps)) {
    if (app.cwd !== ".") { result[name] = app; continue; }
    const selectedPair = (reference) => !design || reference.split(":")[0] === design.id;
    const rawPreview = {
      ...app.preview,
      routes: (app.preview.routes || []).filter((route) => !app.preview.designs?.[route] || selectedPair(app.preview.designs[route])),
      designs: Object.fromEntries(Object.entries(app.preview.designs || {}).filter(([, reference]) => selectedPair(reference)).map(([route, reference]) => [route, reference.split(":").slice(1).join(":")])),
    };
    const preview = sectionPreview(rawPreview, sections, design, { version, ...routeFiles });
    preview.designs = Object.fromEntries(Object.entries(preview.designs).map(([route, reference]) => [route, `${design?.id}:${reference}`]));
    if (composition) {
      const byId = new Map(composition.divisions.map((division) => [division.id, division]));
      const pair = (route, divisionId, candidates) => {
        delete preview.designs[route];
        const division = byId.get(divisionId);
        if (division.system !== "main") return;
        const reference = catalog.designs.find(({ id }) => id === division.design);
        const paired = candidates.find((candidate) => reference?.pages.some(({ route }) => route === candidate));
        if (paired) preview.designs[route] = `${division.design}:${paired}`;
      };
      for (const { path, division, kind } of composedRoutes) {
        if (kind !== "page" || !division) continue;
        const page = composition.pages.get(path.replace(/\/+$/, ""));
        preview.routes.push(page.route);
        pair(page.route, division, [page.local]);
      }
      for (const { section, list, sample } of inventory.sections) {
        const division = composition.collectionContexts.get(section.collection);
        if (!division) continue;
        const mount = byId.get(division).prefix.slice(0, -1);
        const local = (route) => route.startsWith(`${mount}/`) ? route.slice(mount.length) : route;
        pair(list, division, [local(list), list, "/articles"]);
        pair(sample, division, [local(sample), sample, "/articles/example-article"]);
      }
      preview.routes = [...new Set(preview.routes)];
    }
    result[name] = { ...app, preview };
  }
  return result;
}

/** `site/timds.consumer.json`: the workspace form, one root app previewed from a seeded local database. */
export function workspaceConsumerManifest({ systemId, design, preview, sections = DEFAULT_SECTIONS, sectionsContract = 2 }) {
  preview = sectionPreview(preview, sections, design, { version: sectionsContract });
  const designRoutes = new Set(design.pages.map((page) => page.route));
  const pages = sectionRouteInventory(sections, design.pages, { version: sectionsContract }).pages.map((page) => page.route).filter((route) => route !== "/404");
  const routes = [...new Set(["/", ...pages, ...preview.routes])];
  const designs = {};
  for (const route of routes) {
    const designRoute = Object.hasOwn(preview.designs, route) ? preview.designs[route] : route;
    if (designRoutes.has(designRoute)) designs[route] = `${design.id}:${designRoute}`;
  }
  const manifest = {
    schemaVersion: 1,
    designSystem: { workspace: true, systemId },
    apps: {
      [WORKSPACE_APP_NAME]: {
        cwd: ".",
        install: ["npm", "ci", "--no-audit", "--no-fund"],
        preview: {
          // --ignore-lock keeps astro dev in the foreground when an agent starts it.
          // No --port: astro.config reads TIMDS_SITE_PORT (the dev server's free
          // port) and listens on DEV_PORT without it, as consumer preview expects.
          serve: ["npm", "run", "dev", "--", "--host", "127.0.0.1", "--ignore-lock"],
          port: DEV_PORT,
          // The preview needs content: waiting on the seed route loads it.
          ready: preview.ready,
          routes,
          discover: { from: ["/"], limit: 40, exclude: [...preview.discoverExclude] },
          viewports: ["desktop", "phone"],
          schemes: ["light", "dark"],
          ...(Object.keys(designs).length ? { designs } : {}),
        },
        designSurface: ["src/layouts/**", "src/components/**", "src/styles/**", "src/pages/**", "src/routes/**", "src/divisions/**", "public/**"],
      },
    },
  };
  validateConsumerManifest(manifest);
  return manifest;
}

/**
 * Plan the site for the Design System at `designSystemRoot`: every file and
 * its bytes, decided without writing anything. Refuses a system with no
 * website design to build pages from.
 */
export async function planWorkspaceSite(designSystemRoot, { templatesRoot, repoRoot = designSystemRoot, defaultBranch = "main", contentProfile = "portable-text" }) {
  if (!CONTENT_PROFILES.has(contentProfile)) throw new Error("--content-profile must be portable-text or html.");
  const { planEmdashTemplates, readEmdashTemplateSet } = await import("./consumer-scaffold.mjs");
  const manifest = await readJsonFile(path.join(designSystemRoot, "timds.json"), "timds.json");
  const systemId = String(manifest?.systemId || "").trim();
  if (!systemId) throw new Error(`${path.join(designSystemRoot, "timds.json")} has no systemId, so it is not a TimDS Design System. Run the workspace mode in a Design System workspace.`);
  const systemName = String(manifest.name || systemId);

  const { readDesignCatalog } = await import("./designs.mjs");
  const catalog = await readDesignCatalog(designSystemRoot);
  const declaration = await readJsonFile(path.join(templatesRoot, "site", "sections.json"), "sections.json");
  const sections = normalizeSections(declaration);
  const sectionsContract = declaration.schemaVersion;
  const design = selectWebsiteDesign(catalog.designs, sections);
  if (!design) {
    throw new Error(`The Design System ${systemId} has no website design under src/designs/ with a page to build, so the site would have no pages and no layout for its articles. Add one (timds designs init writes the starter's sample design), then rerun. Nothing was written.`);
  }
  const set = await readEmdashTemplateSet(templatesRoot);
  const name = `${slug(systemId).slice(0, 58).replace(/-+$/, "")}-site`;
  const siteRoot = path.join(designSystemRoot, WORKSPACE_SITE_DIRECTORY);
  // The site's folder from the repository root: site, or design-system/site in an embedded system.
  const siteFolder = path.relative(repoRoot, siteRoot).split(path.sep).join("/");
  const installation = await readJsonFile(path.join(designSystemRoot, ".timds", "installation.json"), ".timds/installation.json").catch(() => null);
  const binary = installation?.mode === "binary";
  const siteCheck = `${binary ? "timds-cli" : "npm run timds --"} consumer check --root ${siteFolder}`;
  const plan = await planEmdashTemplates(siteRoot, {
    platform: "cloudflare",
    layout: WORKSPACE_LAYOUT,
    siteName: systemName,
    templatesRoot,
    overlay: WORKSPACE_TEMPLATE_DIRECTORY,
    renames: set.workspace.renames,
    placeholders: {
      // No origin is committed: the site reads EMDASH_SITE_URL at run time.
      __SITE_URL__: "",
      // Written into TypeScript strings and Markdown: keep it to one plain line.
      __SITE_NAME__: JSON.stringify(systemName.replace(/\s+/g, " ")).slice(1, -1),
      __SYSTEM_ID__: systemId,
      __SYSTEM_NAME__: systemName.replace(/\s+/g, " "),
      __DESIGN_ID__: design.id,
      __WORKER_NAME__: name,
      __PACKAGE_NAME__: name,
      __SITE_CHECK__: siteCheck,
    },
  });
  const seedFile = plan.files.find((file) => file.path === "seed/seed.json");
  const schemaFile = plan.files.find((file) => file.path === "section-schema.json");
  const schema = JSON.parse(String(schemaFile.content));
  if (contentProfile === "html") {
    const extraFields = await readJsonFile(path.join(templatesRoot, "content-profile-html.json"), "content-profile-html.json");
    if (!Array.isArray(extraFields)) throw new Error("The html content profile must declare its optional fields.");
    schema.fields.push(...extraFields);
    schemaFile.content = toJson(normalizeSectionSchema(schema));
  }
  const model = normalizeSectionSchema(schema);
  seedFile.content = toJson(createSectionSeed(JSON.parse(String(seedFile.content)), sections, model));
  const writerFile = plan.files.find((file) => file.path === "docs/content-api.md");
  writerFile.content = String(writerFile.content)
    .replace("<!-- timds:content-profile -->", () => `This site selected the \`${contentProfile}\` profile at scaffold time.`)
    .replace(/<!-- timds:sections -->[\s\S]*?<!-- \/timds:sections -->/, () => writerSectionTable(sections));
  const packageJson = workspacePackageJson(set, { name });
  const ports = await articleRoutePorts({ designSystemRoot, design, templatesRoot, sections });
  const siteManifest = workspaceConsumerManifest({ systemId, design, preview: set.preview, sections, sectionsContract });
  const files = [...plan.files.map(({ path: file, content }) => ({ path: file, content })),
    { path: "package.json", content: toJson(packageJson) },
    { path: CONSUMER_MANIFEST_FILE, content: toJson(siteManifest) }];
  const hashed = Object.fromEntries(plan.files
    .filter((file) => !UNHASHED.has(file.path))
    .map((file) => [file.path, sha256(file.content)])
    .sort(([left], [right]) => left.localeCompare(right)));
  const root = await planWorkspaceRootFiles({ repoRoot, designSystemRoot, templatesRoot, siteFolder, siteManifest, designId: design.id, binary, siteCheck, defaultBranch });
  const record = { template: set.version, platform: "cloudflare", mode: "workspace", contentProfile, files: hashed, workspaceFiles: root.workspaceFiles, workspaceSections: root.workspaceSections };
  const { EMDASH_RECORD_PATH } = await import("./consumer-scaffold.mjs");
  files.push({ path: EMDASH_RECORD_PATH, content: toJson(record) });
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    set,
    systemId,
    systemName,
    sections,
    design: {
      id: design.id,
      layout: Boolean(design.layout),
      pages: sectionRouteInventory(sections, design.pages, { version: sectionsContract }).pages.map((page) => page.route),
    },
    tokens: runsStarterBuild(manifest),
    packageJson,
    manifest: siteManifest,
    record,
    ports,
    files,
    siteFolder,
    rootFiles: root.writes,
  };
}

async function listFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await fs.readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(directory, relative));
    else files.push({ relative, file: entry.isFile() });
  }
  return files;
}

/** The section of `text` between the marker comments, both included; to the end of the text when it is not closed. */
function agentsSection(text) {
  const start = text.indexOf(`<!-- ${WORKSPACE_AGENTS_MARKER} -->`);
  if (start === -1) return null;
  const closing = `<!-- /${WORKSPACE_AGENTS_MARKER} -->`;
  const end = text.indexOf(closing, start);
  if (end === -1) return text.slice(start);
  const after = end + closing.length;
  return text.slice(start, text[after] === "\n" ? after + 1 : after);
}

/**
 * What the site adds outside its folder, decided without writing: the two
 * consumer skills under the repository root's `.agents/skills/` and the
 * section in the system's `AGENTS.md`. `writes` are repository-relative.
 * Refuses a skill folder (or `.agents`, `.agents/skills`) that is a link or
 * not a directory, a skill folder that holds anything but the planned bytes,
 * and an `AGENTS.md` that is not a regular file.
 */
export async function planWorkspaceRootFiles({ repoRoot, designSystemRoot, templatesRoot, siteFolder, siteManifest, designId, binary = false, siteCheck, defaultBranch = "main" }) {
  const { consumerSkillFiles } = await import("./consumer-init.mjs");
  const skills = await consumerSkillFiles(siteManifest, { siteFolder, defaultBranch, ...(binary ? { mode: "binary" } : {}) });
  const writes = [];
  const workspaceFiles = {};
  for (const directory of [".agents", ".agents/skills"]) {
    const info = await fs.lstat(path.join(repoRoot, directory)).catch(() => null);
    if (info && !info.isDirectory()) throw new Error(`${path.join(repoRoot, directory)} is not a directory, so the consumer skills cannot be added beside the system's. Fix it, then rerun. Nothing was written.`);
  }
  for (const name of CONSUMER_SKILL_NAMES) {
    const skillFolder = `.agents/skills/${name}`;
    const planned = skills.filter((file) => file.path.startsWith(`${skillFolder}/`));
    for (const file of planned) workspaceFiles[file.path] = sha256(file.content);
    const absolute = path.join(repoRoot, skillFolder);
    const info = await fs.lstat(absolute).catch(() => null);
    if (!info) {
      writes.push(...planned);
      continue;
    }
    const refuse = (reason) => new Error(`${absolute} already exists and ${reason}. The workspace scaffold installs the ${name} skill rendered for this site there and never writes over another; move the folder aside (it may be a consumer skill rendered for another manifest, or an edited one), then rerun. Nothing was written.`);
    if (!info.isDirectory()) throw refuse("is not a directory");
    const present = await listFiles(absolute);
    const expected = new Map(planned.map((file) => [file.path.slice(skillFolder.length + 1), file.content]));
    if (present.length !== expected.size || present.some((entry) => !entry.file || !expected.has(entry.relative))) throw refuse("holds other files");
    for (const entry of present) {
      if (!(await fs.readFile(path.join(absolute, ...entry.relative.split("/")))).equals(Buffer.from(expected.get(entry.relative)))) throw refuse("differs from the skill rendered for this site");
    }
    // Exactly the planned bytes: kept, and recorded as the scaffold's.
  }

  const agentsPath = path.join(designSystemRoot, AGENTS_FILE);
  const agentsRelative = path.relative(repoRoot, agentsPath).split(path.sep).join("/");
  const agentsInfo = await fs.lstat(agentsPath).catch(() => null);
  if (agentsInfo && !agentsInfo.isFile()) throw new Error(`${agentsPath} is not a regular file, so the site's section cannot be added to it. Fix it, then rerun. Nothing was written.`);
  const agents = agentsInfo ? await fs.readFile(agentsPath, "utf8") : "";
  let section = agentsSection(agents);
  if (section === null) {
    const skillsPath = `${path.relative(designSystemRoot, path.join(repoRoot, ".agents", "skills")).split(path.sep).join("/")}/`;
    section = (await fs.readFile(path.join(templatesRoot, AGENTS_SECTION_TEMPLATE), "utf8"))
      .replaceAll("__DESIGN_ID__", () => designId)
      .replaceAll("__CHECK_COMMAND__", () => siteCheck)
      .replaceAll("__SKILLS_PATH__", () => skillsPath);
    const kept = agents.replace(/\s*$/, "");
    writes.push({ path: agentsRelative, content: `${kept}${kept ? "\n\n" : ""}${section}` });
  }
  const sorted = (entries) => Object.fromEntries(Object.entries(entries).sort(([left], [right]) => left.localeCompare(right)));
  return {
    writes,
    workspaceFiles: sorted(workspaceFiles),
    workspaceSections: { [agentsRelative]: { marker: WORKSPACE_AGENTS_MARKER, sha256: sha256(section) } },
  };
}

async function defaultRunInstall(cwd) {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn("npm", ["ci", "--no-audit", "--no-fund"], { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: error.message }));
    child.on("close", (code) => resolve({ code: Number(code ?? -1), stdout, stderr }));
  });
}

/**
 * `timds consumer scaffold emdash --workspace`: write the site into
 * `<Design System root>/site`. Refuses, before anything is written, a folder
 * that is not a Design System workspace, a `site/` that exists and is not an
 * empty directory, and a system with no website design. Returns what was
 * written, the record, and the article routes with no port to the system yet.
 */
export async function scaffoldWorkspaceEmdashSite(rootInput, {
  skipInstall = false,
  contentProfile,
  templatesRoot,
  writeFile,
  runInstall = defaultRunInstall,
  output = () => {},
} = {}) {
  const { EMDASH_TEMPLATES_ROOT, applyWritesWithRollback } = await import("./consumer-scaffold.mjs");
  const templates = templatesRoot ?? EMDASH_TEMPLATES_ROOT;
  const workspace = await resolveWorkspaceRoot(rootInput);
  if (!workspace) {
    throw new Error(`${path.resolve(rootInput || process.cwd())} is not in a Design System workspace: neither its repository root nor that root's design-system/ folder holds timds.json. Run the workspace mode in a Design System workspace (or name one with --root PATH); to create a separate site repository, run timds consumer scaffold emdash without --workspace.`);
  }
  const { designSystemRoot } = workspace;
  const siteRoot = path.join(designSystemRoot, WORKSPACE_SITE_DIRECTORY);
  const existing = await fs.lstat(siteRoot).catch(() => null);
  if (existing && (!existing.isDirectory() || (await fs.readdir(siteRoot)).length)) {
    throw new Error(`${siteRoot} already exists${existing.isDirectory() ? " and is not empty" : " and is not a directory"}. The workspace mode writes a new site there and never writes over one; move it aside (or remove an earlier site), then rerun. Nothing was written.`);
  }

  const { consumerDefaultBranch } = await import("./consumer-init.mjs");
  const plan = await planWorkspaceSite(designSystemRoot, { templatesRoot: templates, repoRoot: workspace.repoRoot, defaultBranch: await consumerDefaultBranch(workspace.repoRoot), contentProfile });
  output(`Writing the EmDash site (template version ${plan.set.version}, cloudflare) into ${siteRoot}, built from the ${plan.design.id} design of ${plan.systemId}...`);
  // One rollback for both: a failed write removes the site and restores the root files.
  await applyWritesWithRollback(workspace.repoRoot, [
    ...plan.files.map((file) => ({ path: `${plan.siteFolder}/${file.path}`, content: file.content })),
    ...plan.rootFiles,
  ], writeFile ? { writeFile } : {});
  const written = plan.files.map((file) => `${WORKSPACE_SITE_DIRECTORY}/${file.path}`);
  const workspaceFiles = plan.rootFiles.map((file) => file.path);
  const noPort = plan.ports.routes.filter((route) => route.missing.length);

  output(`Wrote ${written.length} files under ${WORKSPACE_SITE_DIRECTORY}/:`);
  for (const file of written) output(`  ${file}`);
  output("");
  output(workspaceFiles.length
    ? `Wrote beside the system's own guidance (from the repository root), recorded in ${WORKSPACE_SITE_DIRECTORY}/.timds/emdash.json:`
    : `The consumer skills and the ${AGENTS_FILE} section were already in place; recorded in ${WORKSPACE_SITE_DIRECTORY}/.timds/emdash.json.`);
  for (const file of workspaceFiles) output(`  ${file}`);
  output("");
  output(`Pages built from src/designs/${plan.design.id}/: ${plan.design.pages.join(", ") || "none"}${plan.design.layout ? "" : " (the design has no layout.html: the article routes render inside its home page, with the content of its <main> taken out)"}`);
  if (noPort.length) {
    output("");
    output("No port yet: these article routes use classes the system's stylesheets do not declare. They are installed and render unstyled until the system declares them (the timds-update-design-system skill ports them):");
    for (const route of noPort) output(`  ${route.route} (${route.file}): ${route.missing.join(", ")}`);
  }

  if (!skipInstall) {
    output("");
    output(`Running npm ci in ${WORKSPACE_SITE_DIRECTORY}/...`);
    const installed = await runInstall(siteRoot);
    if (installed.code !== 0) {
      const tail = (installed.stderr || installed.stdout || "").trim().split("\n").slice(-20).join("\n");
      throw new Error(`npm ci failed in ${siteRoot}:\n${tail}\nThe site's files are already in place; fix the error and run npm ci there. Do not rerun the scaffold, which refuses a site folder that is not empty.`);
    }
  }

  const todos = [
    ...(skipInstall ? [`Run npm ci in ${WORKSPACE_SITE_DIRECTORY}/ (the lockfile is written)`] : []),
    `Run the Design System's dev server at the workspace root (npm run timds -- dev): it serves the system at / and the site at ${WORKSPACE_SITE_MOUNT}/ on one port, loads the sample articles, and prints the EmDash admin's address`,
    `To run the site alone at /, run npm run dev in ${WORKSPACE_SITE_DIRECTORY}/ and open ${DEV_SEED_ROUTE}?redirect=${plan.sections[0].prefix} once: it loads the sample articles into the local database`,
    ...noPort.map((route) => `${route.route} has no port to this system yet: add ${route.missing.join(", ")} to the system's stylesheets (or port the route to classes it has), with the timds-update-design-system skill`),
    `Deploying is in ${WORKSPACE_SITE_DIRECTORY}/docs/emdash-handover.md: npm run worker writes an uploadable Worker with no credentials to ${WORKSPACE_SITE_DIRECTORY}/dist/worker`,
    `Review the diff and commit the site with the system, with the consumer skills under .agents/skills/ and the site's section in ${AGENTS_FILE}`,
  ];
  output("");
  output("For the developer to confirm:");
  for (const item of todos) output(`- ${item}`);

  return {
    designSystemRoot,
    siteRoot,
    layout: workspace.layout,
    systemId: plan.systemId,
    design: plan.design,
    tokens: plan.tokens,
    template: plan.set.version,
    platform: "cloudflare",
    mode: "workspace",
    written,
    workspaceFiles,
    record: plan.record,
    manifest: plan.manifest,
    noPort: noPort.map(({ route, file, missing }) => ({ route, file, missing })),
    stylesheets: plan.ports.stylesheets,
    todos,
  };
}

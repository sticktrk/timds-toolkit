// Tests of the workspace site's design system integration
// (templates/emdash/site-workspace/src/integrations/design-system.mjs). The
// site is its own package and cannot import the toolkit, so the integration
// mirrors two toolkit rules: the starter build's token compile and the
// designs catalog's page-file names. These tests hold each mirror to the
// toolkit's own output, and cover the static-file copy and the posting forms.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { initializeRepository } from "./core.mjs";
import { EMDASH_TEMPLATES_ROOT, compileTokenCss as toolkitTokenCss } from "./consumer-scaffold.mjs";
import { DEFAULT_STATE, readDesignCatalog } from "./designs.mjs";
import { renderSite } from "./viewer.mjs";

const SITE_TEMPLATE = path.join(EMDASH_TEMPLATES_ROOT, "site-workspace");
const integration = await import(path.join(SITE_TEMPLATE, "src", "integrations", "design-system.mjs"));
const {
  FORM_NOT_CONNECTED,
  compileTokenCss,
  defaultPageFiles,
  applyBase,
  disableUnconnectedForms,
  exportsPost,
  htmlTags,
  loadModuleParser,
  parseAttributes,
  formHandlers,
  formTarget,
  listStaticFiles,
  pageRoute,
  readStaticFile,
  readTokens,
  renderWorkspaceDesign,
  requestStaticFile,
  virtualModuleSource,
  writeStaticFiles,
} = integration;

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "timds-site-integration-"));
  t.after(() => fs.rm(directory, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 }));
  return fs.realpath(directory);
}

async function write(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, typeof content === "string" || Buffer.isBuffer(content) ? content : `${JSON.stringify(content, null, 2)}\n`);
}

/** A Design System workspace exactly as `timds init --standalone` writes it. */
async function starterWorkspace(directory) {
  await fs.mkdir(directory, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: directory, stdio: "ignore" });
  await initializeRepository(directory, { standalone: true, name: "Sample", systemId: "sample/core" });
  return directory;
}

// One starter workspace for the tests that only read it or change their own copy of its tokens.
let sharedWorkspace;
test.before(async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "timds-site-integration-shared-")));
  sharedWorkspace = await starterWorkspace(path.join(directory, "ws"));
});
test.after(() => fs.rm(path.dirname(sharedWorkspace), { force: true, recursive: true, maxRetries: 5, retryDelay: 50 }));

// A token document with everything the starter build compiles: references
// to other tokens (dotted and nested), names that need the --group-name
// rewrite, groups nested in folders, and a value that names no token.
const TOKEN_GROUPS = {
  color: {
    blue: { value: "#2457d6", description: "Base blue." },
    accent: { value: "{color.blue}" },
    "Accent Soft": { value: "color-mix(in srgb, {color.blue} 20%, {color.surface_Raised})" },
    surface_Raised: { value: "#ffffff" },
  },
  space: { "4": { value: "1rem" }, gutter: { value: "calc({space.4} * 2)" } },
  "brand.type": { body: { value: "{font.body}" } },
  font: { body: { value: "\"Sample Sans\", system-ui, sans-serif" } },
  motion: { quick: { value: "{motion.unknown-ref} 120ms" }, braces: { value: "{not a reference}" } },
};

async function writeTokenGroups(workspace, groups) {
  await fs.rm(path.join(workspace, "tokens"), { recursive: true, force: true });
  for (const [group, entries] of Object.entries(groups)) {
    // A dotted group lives in a folder: tokens/brand/type.json is brand.type.
    await write(path.join(workspace, "tokens", ...group.split(".").slice(0, -1), `${group.split(".").at(-1)}.json`), entries);
  }
}

test("the site compiles tokens, references included, exactly as the starter build does", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "ws");
  await fs.cp(sharedWorkspace, workspace, { recursive: true });

  // The tokens/ groups, with a nested folder, beside the starter's own (its pages table them).
  const groups = { ...readTokens(sharedWorkspace), ...TOKEN_GROUPS, color: { ...readTokens(sharedWorkspace).color, ...TOKEN_GROUPS.color } };
  await writeTokenGroups(workspace, groups);
  const viewer = (await renderSite(workspace)).tokenCss;
  assert.equal(compileTokenCss(readTokens(workspace)), viewer);
  assert.match(viewer, /--color-accent: var\(--color-blue\);/);
  assert.match(viewer, /--color-accent-soft: color-mix\(in srgb, var\(--color-blue\) 20%, var\(--color-surface-raised\)\);/);
  assert.match(viewer, /--brand-type-body: var\(--font-body\);/);
  assert.match(viewer, /--space-gutter: calc\(var\(--space-4\) \* 2\);/);
  assert.match(viewer, /--motion-braces: \{not a reference\};/);

  // tokens.json, on a system without the contract layout.
  await fs.rm(path.join(workspace, ".timds", "contract-layout.json"));
  await fs.rm(path.join(workspace, "tokens"), { recursive: true });
  await write(path.join(workspace, "tokens.json"), groups);
  assert.deepEqual(readTokens(workspace), groups);
  assert.equal(compileTokenCss(readTokens(workspace)), (await renderSite(workspace)).tokenCss);
  // The toolkit's own copy of the rule (the scaffold and the two-way check read tokens through it).
  assert.equal(toolkitTokenCss(groups), compileTokenCss(readTokens(workspace)));

  // The starter's own tokens, as the stock build wrote them.
  assert.equal(compileTokenCss(readTokens(sharedWorkspace)), await fs.readFile(path.join(sharedWorkspace, "dist", "tokens.css"), "utf8"));
});

test("a token the starter build refuses is left out by the site, which keeps serving", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "ws");
  await fs.cp(sharedWorkspace, workspace, { recursive: true });
  await writeTokenGroups(workspace, { ...readTokens(sharedWorkspace), extra: { ink: { value: "#111111" }, broken: { value: 12 }, empty: { value: " " } } });
  await assert.rejects(renderSite(workspace), /Token extra\.broken must have a non-empty string value/);
  const css = compileTokenCss(readTokens(workspace));
  assert.match(css, /--extra-ink: #111111;/);
  assert.doesNotMatch(css, /--extra-broken|--extra-empty/);
});

const PAGE = (title) => `<h1>${title}</h1>\n`;
const CATALOG_FILES = [
  "index.html",
  "about.default.html",
  "contact.html",
  "contact.sent.html",
  "pricing.html",
  "pricing.annual.html",
  "company/index.html",
  "company/team.default.html",
  "company/team.expanded.html",
  "help/faq/index.default.html",
];

/** A minimal Design System with one website design whose pages are `files`. */
async function designSystem(root, files, { layout = true } = {}) {
  await write(path.join(root, "timds.json"), { name: "Sample", systemId: "sample/core" });
  await write(path.join(root, "src/designs/site/design.json"), { title: "Site" });
  if (layout) await write(path.join(root, "src/designs/site/layout.html"), "<!doctype html><html lang=\"en\"><head><title>{{title}}</title></head><body><main>{{content}}</main></body></html>\n");
  for (const file of files) await write(path.join(root, "src/designs/site/pages", file), PAGE(file));
  return root;
}

test("page files follow the designs catalog's default-state rule", async (t) => {
  assert.equal(pageRoute("about.html"), "/about");
  assert.equal(pageRoute("about.default.html"), "/about");
  assert.equal(pageRoute("contact.sent.html"), null);
  assert.equal(pageRoute("index.html"), "/");
  assert.equal(pageRoute("index.default.html"), "/");
  assert.equal(pageRoute("company/index.html"), "/company");
  assert.equal(pageRoute("company/team.default.html"), "/company/team");
  assert.equal(pageRoute("company/team.expanded.html"), null);
  assert.equal(pageRoute("a.b.c.html"), null);

  const root = await designSystem(await temporaryDirectory(t), CATALOG_FILES);
  // The site serves exactly the catalog's default states, from the same files.
  const catalog = await readDesignCatalog(root);
  const design = catalog.designs.find((candidate) => candidate.id === "site");
  const expected = design.pages.map((page) => {
    const state = page.states.find((candidate) => candidate.name === DEFAULT_STATE);
    return [page.route, path.relative(path.join(root, "src/designs/site/pages"), state.path).split(path.sep).join("/")];
  }).sort();
  assert.deepEqual(defaultPageFiles(path.join(root, "src/designs/site/pages")).sort(), expected);

  const rendered = renderWorkspaceDesign(root, { design: "site" });
  assert.deepEqual(rendered.pages.map((page) => page.route), ["/", "/about", "/company", "/company/team", "/contact", "/help/faq", "/pricing"]);
  const about = rendered.pages.find((page) => page.route === "/about");
  assert.equal(about.source, "src/designs/site/pages/about.default.html");
  assert.match(about.body, /<h1>about\.default\.html<\/h1>/);

  // The shell of a layout-less design is its home page, found by the same rule.
  const bare = await designSystem(await temporaryDirectory(t), ["index.default.html", "about.html"], { layout: false });
  assert.match(renderWorkspaceDesign(bare, { design: "site" }).shell.before, /^<h1>index\.default\.html<\/h1>/);
});

test("two files for one route are refused, as the designs catalog refuses them", async (t) => {
  const root = await designSystem(await temporaryDirectory(t), ["index.html", "about.html", "about.default.html"]);
  await assert.rejects(readDesignCatalog(root), /both describe route \/about/);
  assert.throws(() => renderWorkspaceDesign(root, { design: "site" }), /pages\/about\.html and pages\/about\.default\.html both describe route \/about; keep one|pages\/about\.default\.html and pages\/about\.html both describe route \/about; keep one/);
});

test("the build copies static files by their names on disk, percent signs included", async (t) => {
  const root = await temporaryDirectory(t);
  const system = path.join(root, "system");
  const svg = Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"/>\n");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  await write(path.join(system, "src/assets/50%.svg"), svg);
  await write(path.join(system, "src/assets/a%2fb.png"), png);
  await write(path.join(system, "src/assets/icons/%41.svg"), svg);
  await write(path.join(system, "src/styles/system.css"), ".x { color: var(--color-ink); }\n");
  await write(path.join(system, "tokens.json"), { color: { ink: { value: "#111111" }, text: { value: "{color.ink}" } } });

  assert.deepEqual(listStaticFiles(system), [
    ["assets", ["50%.svg"]],
    ["assets", ["a%2fb.png"]],
    ["assets", ["icons", "%41.svg"]],
    ["styles", ["system.css"]],
  ]);
  assert.deepEqual(readStaticFile(system, "assets", ["50%.svg"]).body, svg);
  assert.equal(readStaticFile(system, "assets", ["50%.svg"]).type, "image/svg+xml");

  const client = path.join(root, "client");
  assert.equal(await writeStaticFiles(system, client, true), 5);
  assert.deepEqual(await fs.readFile(path.join(client, "assets", "50%.svg")), svg);
  assert.deepEqual(await fs.readFile(path.join(client, "assets", "a%2fb.png")), png);
  assert.deepEqual(await fs.readFile(path.join(client, "assets", "icons", "%41.svg")), svg);
  assert.equal(await fs.readFile(path.join(client, "tokens.css"), "utf8"), ":root {\n  --color-ink: #111111;\n  --color-text: var(--color-ink);\n}\n");
  assert.equal(await writeStaticFiles(system, path.join(root, "client-no-tokens"), false), 4);

  // The on-disk reader takes segments as they are and judges them.
  assert.equal(readStaticFile(system, "assets", ["..", "tokens.json"]), null);
  assert.equal(readStaticFile(system, "assets", ["icons/%41.svg"]), null);
  assert.equal(readStaticFile(system, "media", ["50%.svg"]), null);
});

test("a development request is URL-decoded once, then held inside the folder", async (t) => {
  const root = await temporaryDirectory(t);
  const system = path.join(root, "system");
  const svg = Buffer.from("<svg/>");
  await write(path.join(system, "src/assets/50%.svg"), svg);
  await write(path.join(system, "src/assets/a%2fb.png"), svg);
  await write(path.join(system, "src/assets/sample name.svg"), svg);
  await write(path.join(system, "src/secret.txt"), "secret");
  await write(path.join(system, "tokens.json"), { color: { ink: { value: "#111111" }, text: { value: "{color.ink}" } } });

  assert.deepEqual(requestStaticFile(system, "/assets/50%25.svg", false).body, svg);
  assert.deepEqual(requestStaticFile(system, "/assets/a%252fb.png", false).body, svg);
  assert.deepEqual(requestStaticFile(system, "/assets/sample%20name.svg", false).body, svg);
  // An encoded slash, dot-dot or backslash never leaves the folder, and a bad escape is no file.
  assert.equal(requestStaticFile(system, "/assets/a%2fb.png", false), null);
  assert.equal(requestStaticFile(system, "/assets/..%2fsecret.txt", false), null);
  assert.equal(requestStaticFile(system, "/assets/%2e%2e/secret.txt", false), null);
  assert.equal(requestStaticFile(system, "/assets/..%5csecret.txt", false), null);
  assert.equal(requestStaticFile(system, "/assets/50%.svg", false), null);
  assert.equal(requestStaticFile(system, "/assets/%00", false), null);
  assert.equal(requestStaticFile(system, "/secret.txt", false), null);
  assert.equal(requestStaticFile(system, "/tokens.css", false), null);
  assert.equal(requestStaticFile(system, "/tokens.css", true).body, ":root {\n  --color-ink: #111111;\n  --color-text: var(--color-ink);\n}\n");
});

const POSTING_PAGE = `<!doctype html><html lang="en"><head><title>Contact</title></head><body>
<form class="form" action="/contact" method="post">
  <label for="name">Name</label>
  <input id="name" name="name" type="text">
  <input name="token" type="hidden" />
  <select name="topic"><option>One</option></select>
  <textarea name="message"></textarea>
  <button class="button" type="submit">Send</button>
</form>
<form action="/search" method="get"><input name="q"><button>Search</button></form>
<form action="https://forms.example.test/submit" method="POST"><button>Elsewhere</button></form>
<script>const html = '<form method="post"><button>x</button></form>';</script>
</body></html>`;

test("a posting form with no handler is rendered disabled, and one with a handler is left alone", () => {
  const disabled = disableUnconnectedForms(POSTING_PAGE, { route: "/contact", handled: new Set() });
  assert.match(disabled, /<form class="form" action="\/contact" method="post" data-timds-form="not-connected"><p role="note">This form is not connected yet, so it cannot send anything\.<\/p>/);
  assert.match(disabled, /<input id="name" name="name" type="text" disabled>/);
  assert.match(disabled, /<input name="token" type="hidden"  disabled\/>/);
  assert.match(disabled, /<select name="topic" disabled>/);
  assert.match(disabled, /<textarea name="message" disabled>/);
  assert.match(disabled, /<button class="button" type="submit" disabled>Send<\/button>/);
  // GET forms, forms posting to another origin, and script bodies are the design's own.
  assert.match(disabled, /<form action="\/search" method="get"><input name="q"><button>Search<\/button><\/form>/);
  assert.match(disabled, /<form action="https:\/\/forms\.example\.test\/submit" method="POST"><button>Elsewhere<\/button><\/form>/);
  assert.match(disabled, /const html = '<form method="post"><button>x<\/button><\/form>';/);
  // The notice adds no class the Design System would have to declare.
  assert.equal(disabled.match(/class="/g).length, POSTING_PAGE.match(/class="/g).length);
  assert.ok(FORM_NOT_CONNECTED.length < 80);

  assert.equal(disableUnconnectedForms(POSTING_PAGE, { route: "/contact", handled: new Set(["/contact"]) }), POSTING_PAGE);
  // A form with no action posts to its own page.
  const own = '<form method="post"><button>Go</button></form>';
  assert.equal(disableUnconnectedForms(own, { route: "/contact", handled: new Set(["/contact"]) }), own);
  assert.match(disableUnconnectedForms(own, { route: "/about", handled: new Set(["/contact"]) }), /<button disabled>Go<\/button>/);
  // An already disabled control is not disabled twice.
  assert.equal(disableUnconnectedForms('<form method="post"><button disabled>Go</button></form>', {}), `<form method="post" data-timds-form="not-connected"><p role="note">${FORM_NOT_CONNECTED}</p><button disabled>Go</button></form>`);

  assert.equal(formTarget("/contact", "/"), "/contact");
  assert.equal(formTarget("/contact/?ref=footer#form", "/"), "/contact");
  assert.equal(formTarget("", "/contact"), "/contact");
  assert.equal(formTarget(undefined, "/"), "/");
  assert.equal(formTarget("subscribe", "/news/latest"), "/news/subscribe");
  assert.equal(formTarget("//elsewhere.test/x", "/"), "external");
  assert.equal(formTarget("", null), null);
});

// An ESTree parser for the tests, standing in for Vite's parseAst (which the
// site has and the toolkit does not): Node strips the TypeScript, and acorn,
// reached through the toolkit's own dependencies, parses the rest.
const acorn = (() => {
  let require = createRequire(import.meta.url);
  for (const name of ["@remotion/cli", "@remotion/bundler", "webpack"]) require = createRequire(require.resolve(`${name}/package.json`));
  return require("acorn");
})();
const parse = (code, file) => acorn.parse(file.endsWith(".ts") ? stripTypeScriptTypes(code) : code, { ecmaVersion: "latest", sourceType: "module" });
const exportsPostIn = (code, file = "handler.ts") => exportsPost(parse(code, file));

test("a module handles a form only when it really exports POST, never when a comment or string mentions it", () => {
  // The reviewer's draft: a TODO that spells the export out, and no export.
  assert.equal(exportsPostIn("// TODO: export async function POST({ request }) { ... }\nexport async function GET() { return new Response(null); }\n"), false);
  assert.equal(exportsPostIn("/* export const POST = handler; */\nexport {};\n"), false);
  assert.equal(exportsPostIn("const note = \"export async function POST\";\nconst other = `export { POST }`;\nexport { note };\n"), false);
  assert.equal(exportsPostIn("const pattern = /export const POST/;\nexport default pattern;\n"), false);
  assert.equal(exportsPostIn("export default { POST: () => new Response(null) };\n"), false);
  assert.equal(exportsPostIn("export * from \"./elsewhere\";\n"), false);
  assert.equal(exportsPostIn("export const POST = undefined;\n"), false);
  assert.equal(exportsPostIn("export let POST;\n"), false);
  assert.equal(exportsPostIn("export const POST = \"soon\";\n"), false);
  assert.equal(exportsPostIn("export const POST = { later: true };\n"), false);
  assert.equal(exportsPostIn("export async function GET() {}\nexport const POSTED = 1;\n"), false);

  // Every real way to export it.
  assert.equal(exportsPostIn("import type { APIContext } from \"astro\";\nexport async function POST({ request }: APIContext): Promise<Response> { return new Response(null); }\n"), true);
  assert.equal(exportsPostIn("export const POST = async () => new Response(null);\n"), true);
  assert.equal(exportsPostIn("export const POST = makeHandler();\n"), true);
  assert.equal(exportsPostIn("async function handler() { return new Response(null); }\nexport { handler as POST };\n"), true);
  assert.equal(exportsPostIn("export { POST } from \"./shared\";\n"), true);
  assert.equal(exportsPostIn("export { send as POST, GET } from \"./shared\";\n"), true);
  assert.equal(exportsPostIn("export const { POST } = handlers;\n"), true);
  assert.equal(exportsPostIn("export class POST {}\n"), true);

  // TypeScript-only exports, as Vite's parser reports them, are not values.
  assert.equal(exportsPost({ type: "Program", body: [{ type: "ExportNamedDeclaration", exportKind: "type", specifiers: [{ exported: { type: "Identifier", name: "POST" } }] }] }), false);
  assert.equal(exportsPost({ type: "Program", body: [{ type: "ExportNamedDeclaration", exportKind: "value", specifiers: [{ exportKind: "type", exported: { type: "Identifier", name: "POST" } }] }] }), false);
  assert.equal(exportsPost({ type: "Program", body: [{ type: "ExportNamedDeclaration", declaration: { type: "FunctionDeclaration", declare: true, id: { type: "Identifier", name: "POST" } }, specifiers: [] }] }), false);
});

test("form handlers are the modules under src/forms/ that export POST, by address", async (t) => {
  const site = await temporaryDirectory(t);
  assert.deepEqual([...formHandlers(site, { parse })], []);
  await write(path.join(site, "src/forms/contact.ts"), "import type { APIContext } from \"astro\";\nexport async function POST({ request }: APIContext) { return new Response(null, { status: 204 }); }\n");
  await write(path.join(site, "src/forms/index.mjs"), "const POST = () => new Response(null);\nexport { POST };\n");
  await write(path.join(site, "src/forms/support/request/index.js"), "export const POST = () => new Response(null);\n");
  await write(path.join(site, "src/forms/drafts.ts"), "// TODO: export async function POST({ request }) once the store exists\nexport async function GET() { return new Response(null); }\n");
  await write(path.join(site, "src/forms/types.d.ts"), "export declare function POST(): Response;\n");
  await write(path.join(site, "src/forms/notes.md"), "export const POST\n");
  await write(path.join(site, "src/forms/broken.ts"), "export const POST = (\n");
  const warnings = [];
  const handlers = formHandlers(site, { parse, warn: (message) => warnings.push(message) });
  assert.deepEqual([...handlers.keys()].sort(), ["/", "/contact", "/support/request"]);
  assert.equal(handlers.get("/contact"), path.join(site, "src/forms/contact.ts"));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^src\/forms\/broken\.ts does not parse, so it handles no form until it does/);

  const source = virtualModuleSource({ system: {}, design: {}, pages: [], shell: {} }, handlers, site);
  const absolute = JSON.stringify(path.join(site, "src/forms/contact.ts").split(path.sep).join("/"));
  assert.ok(source.includes(`"/contact": { file: "src/forms/contact.ts", load: () => import(${absolute}) },`), source);
  assert.match(virtualModuleSource({ system: {}, design: {}, pages: [], shell: {} }, new Map(), site), /export const forms = \{\n\};$/);

  await write(path.join(site, "src/forms/contact/index.ts"), "export const POST = () => new Response(null);\n");
  assert.throws(() => formHandlers(site, { parse }), /both handle POST \/contact; keep one/);
});

test("the module parser is the Vite of the site's own Astro, and its absence is explained", async (t) => {
  const site = await temporaryDirectory(t);
  await write(path.join(site, "package.json"), { name: "sample-site", private: true });
  await assert.rejects(loadModuleParser(site), /found no astro install in .*Run npm ci in/);
  // A Vite installed beside the site, but not Astro's, is not used.
  await write(path.join(site, "node_modules/astro/package.json"), { name: "astro", version: "0.0.0" });
  await write(path.join(site, "node_modules/astro/node_modules/vite/package.json"), { name: "vite", version: "0.0.0", type: "module", exports: { ".": "./index.js" } });
  await write(path.join(site, "node_modules/astro/node_modules/vite/index.js"), "export const parseAst = (code, options, file) => ({ type: \"Program\", body: [], seen: [code, options, file] });\n");
  await write(path.join(site, "node_modules/vite/package.json"), { name: "vite", version: "0.0.0", type: "module", exports: { ".": "./index.js" } });
  await write(path.join(site, "node_modules/vite/index.js"), "export const parseAst = () => { throw new Error(\"the hoisted vite\"); };\n");
  const parseWith = await loadModuleParser(site);
  assert.deepEqual(parseWith("export {}", "/x/contact.ts").seen, ["export {}", { lang: "ts" }, "/x/contact.ts"]);
  assert.deepEqual(parseWith("export {}", "/x/contact.mjs").seen[1], { lang: "js" });
});

const BASED = (html) => applyBase(html, "/site");

test("one tag parser reads and rebases every URL attribute, quoted or not", () => {
  // Unquoted, single- and double-quoted values of every URL attribute.
  assert.equal(BASED("<form method=post action=/contact><button formaction=/other>Go</button></form>"), "<form method=post action=/site/contact><button formaction=/site/other>Go</button></form>");
  assert.equal(BASED("<a href=/about>a</a><img src=/assets/a.png><video poster='/p.jpg'></video><link href=\"/styles/system.css\">"), "<a href=/site/about>a</a><img src=/site/assets/a.png><video poster='/site/p.jpg'></video><link href=\"/site/styles/system.css\">");
  assert.equal(BASED("<img srcset=\"/a.png 1x, /b.png 2x\"><img srcset='/c.png 1x'>"), "<img srcset=\"/site/a.png 1x, /site/b.png 2x\"><img srcset='/site/c.png 1x'>");
  // Already based, external, protocol-relative, fragment, query and relative references stay.
  const kept = "<a href=/site/about>1</a><a href=/site>2</a><a href=https://elsewhere.test/x>3</a><a href=//cdn.test/x>4</a><a href=#top>5</a><a href=?q=1>6</a><a href=about>7</a>";
  assert.equal(BASED(kept), kept);
  // URL-looking text in another attribute's value, comments and raw-text bodies is not a reference.
  const text = "<a title=\"action=/x href=/y\" data-note='src=/z' href=/about>t</a><!-- <a href=/c> --><textarea><a href=/raw></textarea><script>const a = '<a href=/s>';</script><style>a[href=\"/q\"] { color: red; }</style><title>see href=/t</title>";
  assert.equal(BASED(text), text.replace("href=/about>", "href=/site/about>"));
  // An unquoted value is quoted only when the rebased one could not stay unquoted (never, for a plain path).
  assert.equal(BASED("<a href=/a&amp;b>x</a>"), "<a href=/site/a&amp;b>x</a>");
  assert.equal(applyBase("<a href=/x>", "/"), "<a href=/x>");

  // The same parser reads attributes for the document's parts.
  assert.deepEqual(parseAttributes(" lang=en class='page wide' data-x=\"a &amp; b\" hidden"), { lang: "en", class: "page wide", "data-x": "a & b", hidden: "" });
  assert.deepEqual(htmlTags("<p title='a>b'>x</p>").map((tag) => [tag.type, tag.name]), [["start", "p"], ["end", "p"]]);
});

test("forms are judged by the same parser, unquoted actions and submit buttons included", () => {
  const handled = new Set(["/contact"]);
  // The reviewer's form: unquoted, handled, enabled, and posting under the base.
  const unquoted = "<form method=post action=/contact><input name=email><button>Send</button></form>";
  assert.equal(disableUnconnectedForms(unquoted, { route: "/contact", handled }), unquoted);
  assert.equal(BASED(disableUnconnectedForms(unquoted, { route: "/contact", handled })), "<form method=post action=/site/contact><input name=email><button>Send</button></form>");
  assert.match(disableUnconnectedForms(unquoted, { route: "/contact", handled: new Set() }), /^<form method=post action=\/contact data-timds-form="not-connected"><p role="note">[^<]+<\/p><input name=email disabled><button disabled>Send<\/button><\/form>$/);
  // A submit button that posts elsewhere is judged by its own formaction and formmethod.
  assert.match(disableUnconnectedForms("<form method=post action=/contact><button>Send</button><button formaction=/unhandled>Other</button></form>", { route: "/", handled }), /not-connected/);
  assert.match(disableUnconnectedForms("<form action=/search><button formmethod=post formaction=/unhandled>Save</button></form>", { route: "/", handled }), /not-connected/);
  assert.doesNotMatch(disableUnconnectedForms("<form action=/search><button formmethod=post formaction=/contact>Save</button></form>", { route: "/", handled }), /not-connected/);
  // The form's own submission (Enter in a field) still posts to its action.
  assert.match(disableUnconnectedForms("<form method=post action=/unhandled><button formaction=/contact>Only this</button></form>", { route: "/", handled }), /not-connected/);
  assert.doesNotMatch(disableUnconnectedForms("<form method=post action=/contact><button type=button formaction=/unhandled>Not a submitter</button></form>", { route: "/", handled }), /not-connected/);
  assert.doesNotMatch(disableUnconnectedForms("<form action=/search><button>Search</button></form>", { route: "/", handled: new Set() }), /not-connected/);
  // An action in another attribute's text, or in a raw-text body, is not the form's.
  assert.match(disableUnconnectedForms("<form title=\"action=/contact\" method=post><button>Go</button></form>", { route: "/about", handled }), /not-connected/);
  assert.doesNotMatch(disableUnconnectedForms("<textarea><form method=post action=/x></form></textarea><script>'<form method=post>'</script>", { route: "/", handled: new Set() }), /not-connected/);
});

test("the starter's contact form renders disabled until the site handles it", () => {
  const without = renderWorkspaceDesign(sharedWorkspace, { design: "website", base: "/site" });
  const contact = without.pages.find((page) => page.route === "/contact");
  assert.match(contact.body, /<form class="form" action="\/site\/contact" method="post" data-timds-form="not-connected"><p role="note">/);
  assert.match(contact.body, /type="submit" disabled>Send<\/button>/);
  assert.doesNotMatch(without.pages.find((page) => page.route === "/about").body, /not-connected/);

  const wired = renderWorkspaceDesign(sharedWorkspace, { design: "website", base: "/site", forms: new Map([["/contact", "/x.ts"]]).keys() });
  const enabled = wired.pages.find((page) => page.route === "/contact");
  assert.doesNotMatch(enabled.body, /not-connected|disabled/);
  assert.match(enabled.body, /<form class="form" action="\/site\/contact" method="post">/);
});

test("the catch-all route answers 405 to a POST, and the handlers are dispatched ahead of it by middleware", async () => {
  const route = await fs.readFile(path.join(SITE_TEMPLATE, "src/pages/[...page].astro"), "utf8");
  assert.match(route, /import \{ pages, mainPage \} from "virtual:timds\/design-system";/);
  assert.match(route, /if \(method !== "GET" && method !== "HEAD"\)/);
  assert.match(route, /status: 405/);
  assert.match(route, /Allow: "GET, HEAD"/);
  assert.doesNotMatch(route, /import \{[^}]*\bforms\b|\bforms\[|\.load\(\)/, "the catch-all no longer dispatches a POST; the middleware does");
  // The integration registers the dispatch ahead of page routing.
  const source = await fs.readFile(path.join(SITE_TEMPLATE, "src/integrations/design-system.mjs"), "utf8");
  assert.match(source, /addMiddleware\(\{ entrypoint: new URL\("\.\/forms-middleware\.mjs", import\.meta\.url\), order: "pre" \}\);/);
  const middleware = await fs.readFile(path.join(SITE_TEMPLATE, "src/integrations/forms-middleware.mjs"), "utf8");
  assert.match(middleware, /import \{ forms, routeError \} from "virtual:timds\/design-system";/);
  assert.match(middleware, /const dispatch = formDispatch\(forms, import\.meta\.env\.BASE_URL\);/);
  assert.match(middleware, /dispatch\(context, \(\) => routeError/);
  const types = await fs.readFile(path.join(SITE_TEMPLATE, "src/design-system.d.ts"), "utf8");
  assert.match(types, /export const forms: Record<string,/);
  for (const doc of ["AGENTS.md", "DESIGN_SYSTEM.md", "docs/emdash-handover.md"]) {
    assert.match(await fs.readFile(path.join(SITE_TEMPLATE, doc), "utf8"), /src\/forms\//, `${doc} says where a form handler goes`);
  }
});

test("hosted discovery acknowledges the current contract while standalone configuration remains available", () => {
  const config = { integrations: [{ name: "timds-host-discovery" }], build: { client: new URL("file:///tmp/timds-example-client/") } };
  const hosted = integration.default({ design: "website" });
  assert.throws(() => hosted.hooks["astro:config:done"]({ config }), /not acknowledged/);
  assert.throws(() => hosted.api.acknowledgeHostedSections({ template: 2, workspace: 2, sections: 1 }), /must support template 4/);
  assert.equal(hosted.api.acknowledgeHostedSections({ template: 4, workspace: 3, sections: 2, composition: 1 }), true);
  assert.doesNotThrow(() => hosted.hooks["astro:config:done"]({ config }));
  const standalone = integration.default({ design: "website" });
  assert.doesNotThrow(() => standalone.hooks["astro:config:done"]({ config: { ...config, integrations: [] } }));
});

const { formDispatch, formRoute } = await import(path.join(SITE_TEMPLATE, "src", "integrations", "form-dispatch.mjs"));

/** A request context as Astro's middleware gets it, enough for the dispatch. */
const requestContext = (method, url) => ({ request: new Request(url, { method }), url: new URL(url) });

test("a POST to a handler's address reaches the handler before any page, at the root and under a base", async (t) => {
  assert.equal(formRoute("/articles", "/"), "/articles");
  assert.equal(formRoute("/articles/", "/"), "/articles");
  assert.equal(formRoute("/", "/"), "/");
  assert.equal(formRoute("/site/articles", "/site/"), "/articles");
  assert.equal(formRoute("/site/articles/", "/site"), "/articles");
  assert.equal(formRoute("/site", "/site/"), "/");
  assert.equal(formRoute("/site/", "/site/"), "/");
  // Astro's development server routes a path without the base to the same page.
  assert.equal(formRoute("/articles", "/site/"), "/articles");
  assert.equal(formRoute("/sitemap", "/site/"), "/sitemap");

  const calls = [];
  const forms = {
    "/articles": { file: "src/forms/articles.mjs", load: async () => ({ POST: async (context) => { calls.push(context.url.pathname); return new Response("handled", { status: 201 }); } }) },
    "/draft": { file: "src/forms/draft.mjs", load: async () => ({ POST: undefined }) },
  };
  const page = () => new Response("the article list", { status: 200 });
  for (const base of ["/", "/site/"]) {
    const dispatch = formDispatch(forms, base);
    const prefix = base === "/" ? "" : "/site";
    // The article list never answers a POST its address has a handler for.
    const handled = await dispatch(requestContext("POST", `http://site.test${prefix}/articles`), page);
    assert.equal(handled.status, 201);
    assert.equal(await handled.text(), "handled");
    assert.equal((await dispatch(requestContext("POST", `http://site.test${prefix}/articles/`), page)).status, 201);
    // A GET, and a POST with no handler, go on to the site's routes.
    assert.equal(await (await dispatch(requestContext("GET", `http://site.test${prefix}/articles`), page)).text(), "the article list");
    assert.equal(await (await dispatch(requestContext("POST", `http://site.test${prefix}/privacy`), page)).text(), "the article list");
  }
  assert.deepEqual(calls, ["/articles", "/articles/", "/site/articles", "/site/articles/"]);

  // A handler whose POST is not a function answers 405 and names its module, never the page.
  const errors = [];
  t.mock.method(console, "error", (message) => errors.push(message));
  const refused = await formDispatch(forms, "/")(requestContext("POST", "http://site.test/draft"), page);
  assert.equal(refused.status, 405);
  assert.equal(refused.headers.get("Allow"), "GET, HEAD");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^src\/forms\/draft\.mjs handles the forms that post to \/draft, but its POST export is not a function \(it is undefined\)/);
});

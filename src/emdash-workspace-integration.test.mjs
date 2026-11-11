// Tests of the workspace site's design system integration
// (templates/emdash/site-workspace/src/integrations/design-system.mjs). The
// site is its own package and cannot import the toolkit, so the integration
// mirrors two toolkit rules: the starter build's token compile and the
// designs catalog's page-file names. These tests hold each mirror to the
// toolkit's own output, and cover the static-file copy and the posting forms.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  disableUnconnectedForms,
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

test("form handlers are the modules under src/forms/ that export POST, by address", async (t) => {
  const site = await temporaryDirectory(t);
  assert.deepEqual([...formHandlers(site)], []);
  await write(path.join(site, "src/forms/contact.ts"), "import type { APIContext } from \"astro\";\nexport async function POST({ request }: APIContext) { return new Response(null, { status: 204 }); }\n");
  await write(path.join(site, "src/forms/index.mjs"), "const POST = () => new Response(null);\nexport { POST };\n");
  await write(path.join(site, "src/forms/support/request/index.js"), "export const POST = () => new Response(null);\n");
  await write(path.join(site, "src/forms/drafts.ts"), "// Not wired yet: export async function GET\nexport async function GET() { return new Response(null); }\n");
  await write(path.join(site, "src/forms/types.d.ts"), "export declare function POST(): Response;\n");
  await write(path.join(site, "src/forms/notes.md"), "export const POST\n");
  const handlers = formHandlers(site);
  assert.deepEqual([...handlers.keys()].sort(), ["/", "/contact", "/support/request"]);
  assert.equal(handlers.get("/contact"), path.join(site, "src/forms/contact.ts"));

  const source = virtualModuleSource({ system: {}, design: {}, pages: [], shell: {} }, handlers);
  assert.match(source, new RegExp(`"/contact": \\(\\) => import\\(${JSON.stringify(path.join(site, "src/forms/contact.ts").split(path.sep).join("/")).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\),`));
  assert.match(virtualModuleSource({ system: {}, design: {}, pages: [], shell: {} }, new Map()), /export const forms = \{\n\};$/);

  await write(path.join(site, "src/forms/contact/index.ts"), "export const POST = () => new Response(null);\n");
  assert.throws(() => formHandlers(site), /both handle POST \/contact; keep one/);
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

test("the catch-all route answers 405 to a POST it has no handler for and passes one it has to the handler", async () => {
  const route = await fs.readFile(path.join(SITE_TEMPLATE, "src/pages/[...page].astro"), "utf8");
  assert.match(route, /import \{ forms, pages \} from "virtual:timds\/design-system";/);
  assert.match(route, /if \(method !== "GET" && method !== "HEAD"\)/);
  assert.match(route, /status: 405/);
  assert.match(route, /Allow: allow/);
  assert.match(route, /return POST\(/);
  const types = await fs.readFile(path.join(SITE_TEMPLATE, "src/design-system.d.ts"), "utf8");
  assert.match(types, /export const forms: Record<string,/);
  for (const doc of ["AGENTS.md", "DESIGN_SYSTEM.md", "docs/emdash-handover.md"]) {
    assert.match(await fs.readFile(path.join(SITE_TEMPLATE, doc), "utf8"), /src\/forms\//, `${doc} says where a form handler goes`);
  }
});

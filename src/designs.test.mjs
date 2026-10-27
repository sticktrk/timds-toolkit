import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_STATE,
  buildDesigns,
  checkDesigns,
  declaredClasses,
  designsDirectory,
  designsDocument,
  findDesignPage,
  journeyWarnings,
  readDesignCatalog,
  renderDesigns,
  rewriteDesignRoutes,
} from "./designs.mjs";
import { collectDesignReferenceFiles } from "./artifact.mjs";
import { extractArtifact } from "./extract.mjs";

const MANIFEST = { systemId: "client/system", name: "Client & Co", description: "The system.", version: "1.2.3", artifact: { entry: "index.html" } };

const SYSTEM_CSS = `/* .commented { } */
.wrap { width: min(100% - 2 * var(--space-6), 76rem); }
.hero h1 { font-size: 2.5rem; }
.hero, .section { padding: 1.5rem 0; }
.button { content: ".not-a-class"; background: url(.also-not.png); }
.button--secondary:hover { color: var(--x); }
.form .field > input { line-height: 1.5; }
@import "/styles/extra.css";
`;
const EXTRA_CSS = ".notice { padding: 1rem; }\n";

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "timds-designs-"));
  t.after(() => fs.rm(directory, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 }));
  return fs.realpath(directory);
}

async function write(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, ...relative.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
}

/** A system with one design: a layout, three routes, and a contact "sent" state. */
async function fixture(t, { entry = "index.html" } = {}) {
  const root = await temporaryDirectory(t);
  const prefix = path.posix.dirname(entry) === "." ? "" : `${path.posix.dirname(entry)}/`;
  await write(root, {
    "timds.json": JSON.stringify({ ...MANIFEST, artifact: { entry } }),
    [`dist/${prefix}index.html`]: "<main><h1>System</h1></main>",
    [`dist/${prefix}styles/system.css`]: SYSTEM_CSS,
    [`dist/${prefix}styles/extra.css`]: EXTRA_CSS,
    "src/designs/site/design.json": JSON.stringify({ title: "Marketing site", summary: "The public site.", pages: { "/": { title: "Home" } } }),
    "src/designs/site/layout.html": `<!doctype html>\n<html><head><title>{{title}} · {{name}}</title><link rel="stylesheet" href="${prefix ? `/${prefix.slice(0, -1)}` : ""}/styles/system.css"></head>\n<body><nav><a href="/">Home</a> <a href="/about/">About</a> <a href="/contact#form">Contact</a></nav>\n<main class="wrap">{{content}}</main></body></html>\n`,
    "src/designs/site/pages/index.html": '<section class="hero"><h1>A promise.</h1><p>{{description}}</p><a class="button" href="/contact?from=home">Go</a></section>\n',
    "src/designs/site/pages/about/index.html": '<section class="section"><h1>About</h1><img src="/assets/team.jpg" alt="Team"></section>\n',
    "src/designs/site/pages/contact.html": '<section class="section"><h1>Contact</h1><form class="form" action="/contact"><div class="field"><input></div><button class="button button--secondary">Send</button></form></section>\n',
    "src/designs/site/pages/contact.sent.html": '<section class="section"><h1>Thanks</h1><div class="notice">Sent. <a href="/">Home</a></div></section>\n',
    [`dist/${prefix}assets/team.jpg`]: "jpg",
  });
  return root;
}

test("reads the catalog from file names: routes, states, declared titles, and a stable order", async (t) => {
  const root = await fixture(t);
  const catalog = await readDesignCatalog(root);
  assert.equal(catalog.exists, true);
  assert.deepEqual(catalog.designs.map((design) => design.id), ["site"]);
  const [site] = catalog.designs;
  assert.equal(site.title, "Marketing site");
  assert.match(site.layout, /layout\.html$/);
  assert.deepEqual(site.pages.map((page) => [page.route, page.title, page.states.map((state) => state.name)]), [
    ["/", "Home", ["default"]],
    ["/about", null, ["default"]],
    ["/contact", null, ["default", "sent"]],
  ]);
  assert.equal(site.pages[2].states[1].source, "src/designs/site/pages/contact.sent.html");

  const none = await readDesignCatalog(await temporaryDirectory(t));
  assert.deepEqual([none.exists, none.designs], [false, []]);
});

test("refuses a catalog that breaks the file-name contract, naming the file", async (t) => {
  const cases = [
    [{ "src/designs/Bad Name/design.json": "{}" }, /Bad Name.*lowercase words/],
    [{ "src/designs/x/design.json": '{"summary":"no title"}', "src/designs/x/pages/index.html": "<h1>x</h1>" }, /design\.json needs a title/],
    [{ "src/designs/x/design.json": '{"title":"X"}' }, /pages\/ has no pages/],
    [{ "src/designs/x/design.json": '{"title":"X"}', "src/designs/x/pages/a.b.c.html": "<h1>x</h1>" }, /must be named <route>\.html or <route>\.<state>\.html/],
    [{ "src/designs/x/design.json": '{"title":"X"}', "src/designs/x/pages/index.html": "<h1>x</h1>", "src/designs/x/pages/orders.empty.html": "<h1>x</h1>" }, /route \/orders .* has states .* but no default page; author pages\/orders\.html first/],
    [{ "src/designs/x/design.json": '{"title":"X"}', "src/designs/x/pages/about.html": "<h1>x</h1>", "src/designs/x/pages/about/index.html": "<h1>x</h1>" }, /both describe route \/about/],
    [{ "src/designs/x/design.json": '{"title":"X"}', "src/designs/x/pages/about.index.html": "<h1>x</h1>" }, /a state may not be named index/],
    [{ "src/designs/x/design.json": '{"title":"X","pages":{"/missing":"Nope"}}', "src/designs/x/pages/index.html": "<h1>x</h1>" }, /names the route \/missing, which has no page/],
    [{ "src/designs/x/design.json": '{"title":"X"}', "src/designs/x/pages/Weird/index.html": "<h1>x</h1>" }, /directory "Weird" must be lowercase/],
  ];
  for (const [files, pattern] of cases) {
    const root = await temporaryDirectory(t);
    await write(root, files);
    await assert.rejects(readDesignCatalog(root), pattern);
  }
});

test("renders pages into the layout, titles them, and rewrites only the design's own routes", async (t) => {
  const root = await fixture(t);
  const rendered = await renderDesigns({ designSystemRoot: root, manifest: MANIFEST });
  assert.equal(rendered.url, "/designs/");
  assert.equal(rendered.outputDirectory, "designs");
  assert.deepEqual([rendered.pageCount, rendered.stateCount], [3, 4]);
  assert.deepEqual([...rendered.files.keys()].sort(), [
    "designs/_directory.css",
    "designs/index.html",
    "designs/site/about/index.html",
    "designs/site/contact/index.html",
    "designs/site/contact/sent.html",
    "designs/site/index.html",
  ]);

  const home = rendered.files.get("designs/site/index.html");
  assert.match(home, /<title>Home · Client &amp; Co<\/title>/, "the declared title names the page");
  assert.match(home, /<p>The system\.<\/p>/, "manifest placeholders fill in the fragment");
  assert.match(home, /<a href="\/designs\/site\/">Home<\/a>/);
  assert.match(home, /<a href="\/designs\/site\/about\/">About<\/a>/, "a trailing slash still matches the route");
  assert.match(home, /<a href="\/designs\/site\/contact\/#form">Contact<\/a>/, "the fragment survives");
  assert.match(home, /href="\/designs\/site\/contact\/\?from=home"/, "the query survives");
  assert.match(home, /href="\/styles\/system\.css"/, "a stylesheet is not a route");

  const [site] = rendered.designs;
  assert.deepEqual(site.pages.map((page) => [page.route, page.title, page.url]), [
    ["/", "Home", "/designs/site/"],
    ["/about", "About", "/designs/site/about/"],
    ["/contact", "Contact", "/designs/site/contact/"],
  ]);
  const sent = site.pages[2].states[1];
  assert.deepEqual([sent.name, sent.title, sent.url, sent.output], ["sent", "Thanks", "/designs/site/contact/sent.html", "designs/site/contact/sent.html"]);
  assert.deepEqual(site.pages[1].states[0].references, ["/assets/team.jpg", "/styles/system.css"]);

  const directory = rendered.files.get("designs/index.html");
  assert.match(directory, /<h2 id="design-site"><a href="\/designs\/site\/">Marketing site<\/a><\/h2>/);
  assert.match(directory, /<td><code>\/contact<\/code><\/td><td><a class="td-directory-page" href="\/designs\/site\/contact\/">Contact<\/a><\/td><td><div class="td-directory-states"><a href="\/designs\/site\/contact\/sent\.html">sent<\/a>/);
  assert.match(directory, /<link rel="stylesheet" href="\/styles\/system\.css">/, "the directory page loads what the designs load");

  assert.equal(await renderDesigns({ designSystemRoot: await temporaryDirectory(t), manifest: MANIFEST }), null);
});

test("an artifact entry in a subdirectory places the designs and their urls under it", async (t) => {
  const root = await fixture(t, { entry: "design-system/index.html" });
  const rendered = await renderDesigns({ designSystemRoot: root, manifest: { ...MANIFEST, artifact: { entry: "design-system/index.html" } } });
  assert.equal(rendered.outputDirectory, "design-system/designs");
  assert.ok(rendered.files.has("design-system/designs/site/contact/sent.html"));
  assert.equal(rendered.designs[0].pages[0].url, "/design-system/designs/site/");
  assert.match(rendered.files.get("design-system/designs/site/index.html"), /href="\/design-system\/designs\/site\/about\/"/);
});

test("rewriteDesignRoutes leaves external, protocol-relative, and foreign references alone", () => {
  const html = '<a href="/">a</a><a href="//cdn/x">b</a><a href="https://x/">c</a><a href="/other">d</a><img src="/about/"><form action="/about?x#y">';
  assert.equal(
    rewriteDesignRoutes(html, ["/", "/about"], "", "site"),
    '<a href="/designs/site/">a</a><a href="//cdn/x">b</a><a href="https://x/">c</a><a href="/other">d</a><img src="/designs/site/about/"><form action="/designs/site/about/?x#y">',
  );
});

test("a layout without {{content}} and an unknown placeholder stop the render", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, "src/designs/site/layout.html"), "<html><body>no slot</body></html>");
  await assert.rejects(renderDesigns({ designSystemRoot: root, manifest: MANIFEST }), /src\/designs\/site\/layout\.html must contain \{\{content\}\}/);
  await fs.writeFile(path.join(root, "src/designs/site/layout.html"), "<html><body>{{content}}{{nope}}</body></html>");
  await assert.rejects(renderDesigns({ designSystemRoot: root, manifest: MANIFEST }), /layout\.html uses the unknown placeholder \{\{nope\}\}/);
});

test("buildDesigns writes the artifact files, reads the manifest itself, and clears stale output", async (t) => {
  const root = await fixture(t);
  await write(root, { "dist/designs/site/stale/index.html": "old" });
  const built = await buildDesigns(root);
  assert.deepEqual([built.pageCount, built.stateCount, built.written.length], [3, 4, 6]);
  await assert.rejects(fs.access(path.join(root, "dist/designs/site/stale/index.html")));
  assert.match(await fs.readFile(path.join(root, "dist/designs/site/contact/sent.html"), "utf8"), /<title>Thanks · Client &amp; Co<\/title>/);
  assert.deepEqual(await buildDesigns(await temporaryDirectory(t)), { designs: [], journeyCount: 0, pageCount: 0, stateCount: 0, written: [] });
});

test("declaredClasses reads selectors and ignores comments, strings, url(), and numbers", () => {
  assert.deepEqual([...declaredClasses(SYSTEM_CSS)].sort(), ["button", "button--secondary", "field", "form", "hero", "section", "wrap"]);
  assert.deepEqual([...declaredClasses("a { margin: 0.5rem 1.25em } .x{}")], ["x"]);
});

test("checkDesigns passes a design that uses only what the system defines, following @import", async (t) => {
  const root = await fixture(t);
  const result = await checkDesigns({ designSystemRoot: root, manifest: MANIFEST });
  assert.deepEqual({ ...result, warnings: result.warnings.length }, { enabled: true, designCount: 1, pageCount: 3, stateCount: 4, journeyCount: 0, warnings: 1 });
  assert.match(result.warnings[0], /^design site has 3 pages and states on \/contact but src\/designs\/site\/design\.json declares no journeys; add "journeys"/, "pages a visitor moves through with no journey are a warning, never a failure");
  assert.deepEqual(await checkDesigns({ designSystemRoot: await temporaryDirectory(t), manifest: MANIFEST }), { enabled: false, designCount: 0, pageCount: 0, stateCount: 0, journeyCount: 0, warnings: [] });
});

test("checkDesigns lists every portability problem with its source file", async (t) => {
  const root = await fixture(t);
  await write(root, {
    "src/designs/site/pages/about/index.html": [
      '<section class="section mystery"><h1>About</h1>',
      '<script>alert(1)</script>',
      '<style>.x{}</style>',
      '<p style="color:red" onclick="go()">Hi</p>',
      '<img src="team.jpg" alt=""><a href="javascript:void(0)">x</a>',
      "</section>",
    ].join("\n"),
    "src/designs/site/pages/bare.html": '<h1 class="mystery">Bare</h1><link rel="stylesheet" href="/styles/missing.css">',
  });
  await fs.writeFile(path.join(root, "src/designs/site/layout.html"), "<html><body>{{content}}</body></html>");
  let message = "";
  await assert.rejects(checkDesigns({ designSystemRoot: root, manifest: MANIFEST }), (error) => {
    message = error.message;
    return /^Website designs must use only what the system defines:/.test(message);
  });
  const about = "src/designs/site/pages/about/index.html";
  for (const expected of [
    `${about}: contains 1 <style> element`,
    `${about}: 1 element has a style attribute`,
    `${about}: links no local stylesheet`,
    `${about}: uses relative references (team.jpg)`,
    "src/designs/site/pages/bare.html: links /styles/missing.css, which the built artifact does not contain",
    "src/designs/site/pages/bare.html: uses classes the linked stylesheets do not declare (mystery)",
  ]) {
    assert.ok(message.includes(expected), `expected "${expected}" in:\n${message}`);
  }
  // With no stylesheet linked the class list is meaningless, so unknown classes are not also reported for that page.
  assert.ok(!message.includes(`${about}: uses classes`), message);
});

test("the designs document carries every state's HTML, and the directory and lookup read it", async (t) => {
  const root = await fixture(t);
  const rendered = await renderDesigns({ designSystemRoot: root, manifest: MANIFEST });
  const document = designsDocument(rendered, MANIFEST);
  assert.deepEqual([document.schemaVersion, document.system, document.base, document.url], [1, { id: "client/system", name: "Client & Co", version: "1.2.3" }, null, "/designs/"]);
  assert.deepEqual([document.designCount, document.pageCount, document.stateCount], [1, 3, 4]);
  assert.match(document.designs[0].pages[2].states[1].html, /Sent\. <a href="\/designs\/site\/">Home<\/a>/);

  assert.deepEqual(designsDirectory(document), [{
    id: "site",
    title: "Marketing site",
    summary: "The public site.",
    url: "/designs/site/",
    pageCount: 3,
    pages: [
      { route: "/", title: "Home", url: "/designs/site/", states: ["default"] },
      { route: "/about", title: "About", url: "/designs/site/about/", states: ["default"] },
      { route: "/contact", title: "Contact", url: "/designs/site/contact/", states: ["default", "sent"] },
    ],
    journeys: [],
  }]);
  assert.deepEqual(designsDirectory(null), []);
  assert.deepEqual(designsDirectory({ designs: [{ id: "old", title: "Old", url: "/designs/old/", pages: [] }] })[0].journeys, [], "a document written before journeys lists none");

  assert.equal(findDesignPage(document, "site", "/contact", "sent").state.title, "Thanks");
  assert.equal(findDesignPage(document, "site", "contact/").state.name, DEFAULT_STATE, "routes normalize");
  assert.equal(findDesignPage(document, "site", "/").page.title, "Home");
  assert.equal(findDesignPage(document, "site", "/nope").page, null);
  assert.equal(findDesignPage(document, "site", "/contact", "empty").state, null);
  assert.equal(findDesignPage(document, "other", "/").design, null);
});

test("extraction keeps designs out of the guidance pages and writes designs.json beside index.json", async (t) => {
  const root = await fixture(t);
  await buildDesigns(root, { manifest: MANIFEST });
  const designs = await renderDesigns({ designSystemRoot: root, manifest: MANIFEST });
  const result = await extractArtifact({ artifactRoot: path.join(root, "dist"), manifest: { ...MANIFEST, brand: { guidance: {}, roles: {} }, machine: {} }, designs });
  assert.deepEqual(result.pages.map((page) => page.id), ["index"], "design pages are not guidance");
  assert.deepEqual(result.index.designs, { url: "/designs.json", count: 1, pages: 3, states: 4, journeys: 0 });
  const written = JSON.parse(await fs.readFile(path.join(root, "dist/designs.json"), "utf8"));
  assert.equal(written.designs[0].id, "site");
  assert.match(await fs.readFile(path.join(root, "dist/llms.txt"), "utf8"), /^Website designs: \/designs\.json — whole pages/m);
  await assert.rejects(fs.access(path.join(root, "dist/designs/site/index.md")), "no Markdown mirror is written for a design page");

  const without = await extractArtifact({ artifactRoot: path.join(root, "dist"), manifest: { ...MANIFEST, brand: { guidance: {}, roles: {} }, machine: {} }, write: false });
  assert.equal(without.index.designs, undefined);
  assert.ok(without.pages.some((page) => page.id.startsWith("designs/")), "without the rendered set the walk sees the built pages as pages");
});


test("interactive designs retain scripts and handlers and publish their local script files", async (t) => {
  const root = await fixture(t);
  const inline = `<script>globalThis.designRan = true; const template = '{{custom}} <a href="/about">About</a>';</script>`;
  const script = "document.querySelector('button').addEventListener('click', () => {});";
  await write(root, {
    "src/designs/site/pages/index.html": `<h1>Interactive</h1><button class="button" onclick="this.textContent='Done'">Go</button><a href="javascript:void(0)">Action</a>${inline}<script src="/assets/interactions.js?v=1" defer></script><script type="module" src="/assets/module.mjs"></script>`,
    "dist/assets/interactions.js": script,
    "dist/assets/module.mjs": "export const ready = true;",
  });
  assert.equal((await checkDesigns({ designSystemRoot: root, manifest: MANIFEST })).pageCount, 3);
  const rendered = await renderDesigns({ designSystemRoot: root, manifest: MANIFEST });
  const html = rendered.files.get("designs/site/index.html");
  assert.ok(html.includes(inline), "inline JavaScript is not evaluated, templated, or route-rewritten");
  assert.equal(globalThis.designRan, undefined, "rendering and checking never execute authored scripts");
  assert.ok(html.includes(`onclick="this.textContent='Done'"`));
  const document = designsDocument(rendered, MANIFEST);
  assert.deepEqual(document.designs[0].pages[0].states[0].references, ["/assets/interactions.js", "/assets/module.mjs", "/styles/system.css"]);
  const files = await collectDesignReferenceFiles(document, path.join(root, "dist"));
  assert.equal(await fs.readFile(files.get("assets/interactions.js").localPath, "utf8"), script);
  assert.equal(files.get("assets/module.mjs").contentType, "text/javascript; charset=utf-8");
  await fs.rm(path.join(root, "dist/assets/interactions.js"));
  await assert.rejects(collectDesignReferenceFiles(document, path.join(root, "dist")), /Website designs reference \/assets\/interactions.js but the artifact has no/);
});

test("script references still follow the artifact's site-absolute path convention", async (t) => {
  const root = await fixture(t);
  await fs.appendFile(path.join(root, "src/designs/site/pages/index.html"), '<script src="interactions.js"></script>');
  await assert.rejects(checkDesigns({ designSystemRoot: root, manifest: MANIFEST }), /uses relative references \(interactions.js\)/);
});


test("the directory ships scoped chrome after the original stylesheet order, without changing design pages", async (t) => {
  const root = await fixture(t);
  const layoutPath = path.join(root, "src/designs/site/layout.html");
  await fs.writeFile(layoutPath, (await fs.readFile(layoutPath, "utf8")).replace('</head>', '<link rel="stylesheet" href="/styles/aaa.css"></head>'));
  const rendered = await renderDesigns({ designSystemRoot: root, manifest: MANIFEST });
  const directory = rendered.files.get("designs/index.html");
  assert.ok(directory.indexOf('/styles/system.css') < directory.indexOf('/styles/aaa.css'), "the authored cascade order is preserved");
  assert.ok(directory.indexOf('/styles/aaa.css') < directory.indexOf('/designs/_directory.css'), "directory chrome overrides broad site selectors");
  assert.match(directory, /body class="timds-design-directory"/);
  assert.match(directory, /1 design · 3 pages/);
  assert.match(directory, /scope="col"/);
  assert.match(directory, /Client &amp; Co/);
  assert.match(rendered.files.get("designs/_directory.css"), /@media \(max-width: 40rem\)/);
  assert.doesNotMatch(rendered.files.get("designs/site/index.html"), /_directory\.css|timds-design-directory/);
});

test("the directory supports nested entries, empty catalogs, and designs without a home route", async (t) => {
  const root = await fixture(t, { entry: "design-system/index.html" });
  let rendered = await renderDesigns({ designSystemRoot: root });
  assert.match(rendered.files.get("design-system/designs/index.html"), /href="\/design-system\/designs\/_directory\.css"/);
  assert.ok(rendered.files.has("design-system/designs/_directory.css"));
  await fs.rm(path.join(root, "src/designs/site/pages/index.html"));
  await write(root, { "src/designs/site/design.json": JSON.stringify({ title: "Secondary pages" }) });
  rendered = await renderDesigns({ designSystemRoot: root });
  assert.match(rendered.files.get("design-system/designs/index.html"), /href="\/design-system\/designs\/site\/about\/" aria-label="Open Secondary pages"/);
  await fs.rm(path.join(root, "src/designs/site"), { recursive: true });
  rendered = await renderDesigns({ designSystemRoot: root });
  assert.match(rendered.files.get("design-system/designs/index.html"), /No website designs yet/);
});

/** The fixture's design.json with a two-step journey: home, then the contact form and its sent state, with a branch. */
const JOURNEY = {
  id: "get-in-touch",
  title: "Getting in touch",
  summary: "Home, then the form.",
  steps: [
    { title: "Arrive", summary: "Most visitors start at home.", screens: [{ page: "/", note: "The headline & the call to action." }] },
    {
      title: "Write",
      screens: [{ page: "contact/", label: "The form" }, { page: "/contact", state: "sent" }],
      branches: [{ page: "/about", label: "Reads about us first", note: "When the visitor is not sure yet." }],
    },
  ],
};

async function journeyFixture(t, journeys = [JOURNEY], { entry } = {}) {
  const root = await fixture(t, entry ? { entry } : {});
  await write(root, { "src/designs/site/design.json": JSON.stringify({ title: "Marketing site", summary: "The public site.", pages: { "/": { title: "Home" } }, journeys }) });
  return root;
}

test("journeys resolve against the design's pages, with labels defaulting to the page title and state", async (t) => {
  const root = await journeyFixture(t);
  const [site] = (await readDesignCatalog(root)).designs;
  assert.deepEqual(site.journeys, [{
    id: "get-in-touch",
    title: "Getting in touch",
    summary: "Home, then the form.",
    steps: [
      { title: "Arrive", summary: "Most visitors start at home.", screens: [{ page: "/", state: "default", label: null, note: "The headline & the call to action." }], branches: [] },
      {
        title: "Write",
        summary: "",
        screens: [{ page: "/contact", state: "default", label: "The form", note: null }, { page: "/contact", state: "sent", label: null, note: null }],
        branches: [{ page: "/about", state: "default", label: "Reads about us first", note: "When the visitor is not sure yet." }],
      },
    ],
  }]);
  const rendered = await renderDesigns({ designSystemRoot: root, manifest: MANIFEST });
  assert.equal(rendered.journeyCount, 1);
  const [journey] = rendered.designs[0].journeys;
  assert.deepEqual([journey.url, journey.output, journey.stepCount, journey.screenCount], ["/designs/site/journeys/get-in-touch/", "designs/site/journeys/get-in-touch/index.html", 2, 4]);
  assert.deepEqual(journey.steps[1].screens.map((screen) => [screen.label, screen.title, screen.url]), [
    ["The form", "Contact", "/designs/site/contact/"],
    ["Contact · sent", "Thanks", "/designs/site/contact/sent.html"],
  ]);
  assert.equal(journey.steps[0].screens[0].label, "Home", "a default state's label is the page title");
});

test("a journey renders a storyboard of the live pages at phone width, numbered in visitor order, with branches marked or", async (t) => {
  const root = await journeyFixture(t);
  const rendered = await renderDesigns({ designSystemRoot: root, manifest: MANIFEST });
  const storyboard = rendered.files.get("designs/site/journeys/get-in-touch/index.html");
  assert.ok(storyboard, "one page per journey under the design's journeys/ directory");
  assert.match(storyboard, /<title>Getting in touch · Marketing site · Client &amp; Co<\/title>/);
  assert.match(storyboard, /<body class="timds-design-directory timds-design-journey">/);
  assert.match(storyboard, /<link rel="stylesheet" href="\/styles\/system\.css">[\s\S]*<link rel="stylesheet" href="\/designs\/_directory\.css">/, "the storyboard loads what the designs load, then the toolkit chrome");
  assert.match(storyboard, /<a class="td-directory-back" href="\/designs\/">← All designs<\/a>/);
  assert.match(storyboard, /<p class="td-directory-eyebrow"><a href="\/designs\/site\/">Marketing site<\/a> · 2 steps · 4 screens<\/p>\s*<h1>Getting in touch<\/h1>\s*<p class="td-directory-lede">Home, then the form\.<\/p>/);
  assert.match(storyboard, /<section class="td-journey-step" aria-labelledby="step-1">\s*<div class="td-journey-step-head">\s*<p class="td-directory-eyebrow">Step 1 of 2<\/p>\s*<h2 id="step-1">Arrive<\/h2>\s*<p class="td-directory-summary">Most visitors start at home\.<\/p>/);
  assert.match(storyboard, /<ol class="td-journey-screens" start="1">\s*<li class="td-journey-screen">\s*<span class="td-journey-badge" aria-hidden="true">1<\/span>/);
  assert.match(storyboard, /<div class="td-journey-frame"><iframe src="\/designs\/site\/" title="Home" loading="lazy" tabindex="-1"><\/iframe><a class="td-journey-open" href="\/designs\/site\/" aria-label="Open Home at full size"><\/a><\/div>/);
  assert.match(storyboard, /<figcaption><b>Home<\/b><span>The headline &amp; the call to action\.<\/span><a href="\/designs\/site\/"><code>\/<\/code><\/a><\/figcaption>/);
  assert.match(storyboard, /<ol class="td-journey-screens" start="2">[\s\S]*>2<\/span>[\s\S]*>3<\/span>/, "numbers count through the journey, not per step");
  assert.match(storyboard, /<iframe src="\/designs\/site\/contact\/sent\.html" title="Contact · sent"[\s\S]*?<figcaption><b>Contact · sent<\/b><a href="\/designs\/site\/contact\/sent\.html"><code>\/contact · sent<\/code><\/a><\/figcaption>/);
  assert.match(storyboard, /<p class="td-journey-or">Or, instead<\/p>\s*<ul class="td-journey-screens td-journey-screens--branch">\s*<li class="td-journey-screen td-journey-screen--branch">\s*<span class="td-journey-badge" aria-hidden="true">or<\/span>[\s\S]*?<b>Or: Reads about us first<\/b><span>When the visitor is not sure yet\.<\/span>/);
  assert.doesNotMatch(storyboard.split('aria-labelledby="step-1"')[1].split('aria-labelledby="step-2"')[0], /td-journey-or/, "a step without branches has no or row");
  assert.equal((storyboard.match(/<iframe /g) ?? []).length, 4);

  const css = rendered.files.get("designs/_directory.css");
  assert.match(css, /--journey-width: 390px; --journey-height: 693px; --journey-scale: \.62/);
  assert.match(css, /\.td-journey-frame iframe \{[^}]*transform: scale\(var\(--journey-scale\)\); transform-origin: 0 0;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);

  const directory = rendered.files.get("designs/index.html");
  assert.match(directory, /<div class="td-directory-journeys" aria-label="Journeys of Marketing site">\s*<p class="td-directory-journeys-label">Journeys: the screens in the order a visitor meets them<\/p>\s*<a class="td-directory-journey" href="\/designs\/site\/journeys\/get-in-touch\/">\s*<b>Getting in touch<\/b>\s*<span>Home, then the form\.<\/span>\s*<span class="td-directory-journey-meta">2 steps · 4 screens · Open storyboard/);
  assert.ok(directory.indexOf("td-directory-journeys") < directory.indexOf("td-directory-table-wrap"), "the cards sit above the route table");
  assert.doesNotMatch((await renderDesigns({ designSystemRoot: await fixture(t), manifest: MANIFEST })).files.get("designs/index.html"), /td-directory-journeys/, "a design without journeys has no card row");

  const built = await buildDesigns(root, { manifest: MANIFEST });
  assert.equal(built.journeyCount, 1);
  await fs.access(path.join(root, "dist/designs/site/journeys/get-in-touch/index.html"));

  const nested = await journeyFixture(t, [JOURNEY], { entry: "design-system/index.html" });
  const under = await renderDesigns({ designSystemRoot: nested, manifest: { ...MANIFEST, artifact: { entry: "design-system/index.html" } } });
  assert.equal(under.designs[0].journeys[0].url, "/design-system/designs/site/journeys/get-in-touch/");
  assert.match(under.files.get("design-system/designs/site/journeys/get-in-touch/index.html"), /<iframe src="\/design-system\/designs\/site\/contact\/sent\.html"/);
});

test("designs.json and the directory carry each journey's screens in visitor order with resolved references", async (t) => {
  const root = await journeyFixture(t);
  const rendered = await renderDesigns({ designSystemRoot: root, manifest: MANIFEST });
  const document = designsDocument(rendered, MANIFEST);
  assert.equal(document.journeyCount, 1);
  assert.deepEqual(document.designs[0].journeys, [{
    id: "get-in-touch",
    title: "Getting in touch",
    summary: "Home, then the form.",
    url: "/designs/site/journeys/get-in-touch/",
    stepCount: 2,
    screenCount: 4,
    steps: [
      { title: "Arrive", summary: "Most visitors start at home.", screens: [{ route: "/", state: "default", label: "Home", note: "The headline & the call to action.", url: "/designs/site/" }], branches: [] },
      {
        title: "Write",
        summary: "",
        screens: [
          { route: "/contact", state: "default", label: "The form", note: null, url: "/designs/site/contact/" },
          { route: "/contact", state: "sent", label: "Contact · sent", note: null, url: "/designs/site/contact/sent.html" },
        ],
        branches: [{ route: "/about", state: "default", label: "Reads about us first", note: "When the visitor is not sure yet.", url: "/designs/site/about/" }],
      },
    ],
  }]);
  const [listing] = designsDirectory(JSON.parse(JSON.stringify(document)));
  assert.deepEqual(listing.journeys, [{
    id: "get-in-touch",
    title: "Getting in touch",
    summary: "Home, then the form.",
    url: "/designs/site/journeys/get-in-touch/",
    stepCount: 2,
    screenCount: 4,
    steps: [
      { title: "Arrive", summary: "Most visitors start at home.", screens: [{ route: "/", state: "default", label: "Home", note: "The headline & the call to action.", url: "/designs/site/" }] },
      {
        title: "Write",
        screens: [
          { route: "/contact", state: "default", label: "The form", url: "/designs/site/contact/" },
          { route: "/contact", state: "sent", label: "Contact · sent", url: "/designs/site/contact/sent.html" },
        ],
        branches: [{ route: "/about", state: "default", label: "Reads about us first", note: "When the visitor is not sure yet.", url: "/designs/site/about/" }],
      },
    ],
  }]);
  for (const step of listing.journeys[0].steps) {
    for (const screen of [...step.screens, ...(step.branches ?? [])]) {
      assert.equal(findDesignPage(document, "site", screen.route, screen.state).state.url, screen.url, "every listed screen is a page state read_design can return");
    }
  }
  const checked = await checkDesigns({ designSystemRoot: root, manifest: MANIFEST });
  assert.deepEqual([checked.journeyCount, checked.warnings], [1, []]);
});

test("bad journey references, duplicate ids, empty journeys, and a reserved route fail with the field named", async (t) => {
  const design = (journeys) => ({ "src/designs/site/design.json": JSON.stringify({ title: "Marketing site", journeys }) });
  const step = (screens, extra = {}) => ({ title: "Step", screens, ...extra });
  const cases = [
    [design({}), /design\.json journeys must be an array of journeys/],
    [design(["x"]), /journeys\[0\] must be an object with id, title, and steps/],
    [design([{ id: "Bad Id", title: "X", steps: [step([{ page: "/" }])] }]), /journeys\[0\] id "Bad Id" must be lowercase words joined by hyphens/],
    [design([{ id: "a", title: "A", steps: [step([{ page: "/" }])] }, { id: "a", title: "B", steps: [step([{ page: "/" }])] }]), /declares the journey a twice; give each journey its own id/],
    [design([{ id: "a", steps: [step([{ page: "/" }])] }]), /journeys\[0\] \(a\) needs a title/],
    [design([{ id: "a", title: "A", summary: 1, steps: [step([{ page: "/" }])] }]), /\(a\) summary must be a string/],
    [design([{ id: "a", title: "A" }]), /\(a\) needs steps: at least one step with at least one screen/],
    [design([{ id: "a", title: "A", steps: [] }]), /\(a\) needs steps/],
    [design([{ id: "a", title: "A", steps: [{ screens: [{ page: "/" }] }] }]), /\(a\) steps\[0\] needs a title/],
    [design([{ id: "a", title: "A", steps: [step([])] }]), /\(a\) steps\[0\] needs screens: at least one \{ "page": "\/route" \}/],
    [design([{ id: "a", title: "A", steps: [step([{}])] }]), /steps\[0\] screens\[0\] needs a page: one of the design's routes \(\/, \/about, \/contact\)/],
    [design([{ id: "a", title: "A", steps: [step([{ page: "/pricing" }])] }]), /steps\[0\] screens\[0\] names the route \/pricing, which the design has no page for; routes: \/, \/about, \/contact/],
    [design([{ id: "a", title: "A", steps: [step([{ page: "/contact", state: "error" }])] }]), /screens\[0\] names state "error" of \/contact, which that route does not have; states: default, sent/],
    [design([{ id: "a", title: "A", steps: [step([{ page: "/" }], { branches: [] })] }]), /steps\[0\] branches must list at least one screen a visitor meets instead, or be left out/],
    [design([{ id: "a", title: "A", steps: [step([{ page: "/" }], { branches: [{ page: "/about", state: "x" }] })] }]), /steps\[0\] branches\[0\] names state "x" of \/about/],
    [design([{ id: "a", title: "A", steps: [step([{ page: "/", label: 3 }])] }]), /screens\[0\] label must be a string/],
    [{ "src/designs/site/pages/journeys/index.html": "<h1>x</h1>" }, /pages\/journeys\/index\.html: the route \/journeys is reserved for journey storyboards \(\/designs\/site\/journeys\/<journey>\/\); name the route differently/],
    [{ "src/designs/site/pages/journeys/kit.html": "<h1>x</h1>" }, /route \/journeys\/kit is reserved for journey storyboards/],
  ];
  for (const [files, pattern] of cases) {
    const root = await fixture(t);
    await write(root, files);
    await assert.rejects(readDesignCatalog(root), pattern);
  }
});

test("check warns when a route's states are shown by no journey, and stays quiet for a single page", async (t) => {
  const root = await journeyFixture(t, [{ id: "look", title: "Look around", steps: [{ title: "Read", screens: [{ page: "/about" }] }] }]);
  const checked = await checkDesigns({ designSystemRoot: root, manifest: MANIFEST });
  assert.deepEqual(checked.warnings, ["design site has states on /contact that no journey in src/designs/site/design.json shows; add the route as a screen or branch of the step where a visitor meets it"]);
  const single = { id: "one", title: "One", summary: "", url: "/designs/one/", pages: [{ route: "/", title: "Home", url: "/designs/one/", states: [{ name: "default" }] }], journeys: [] };
  assert.deepEqual(journeyWarnings([single]), []);
  const states = { ...single, pages: [{ ...single.pages[0], states: [{ name: "default" }, { name: "signed-in" }] }] };
  assert.match(journeyWarnings([states])[0], /^design one has states on \/ but src\/designs\/one\/design\.json declares no journeys/);
});

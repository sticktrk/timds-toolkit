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
  assert.deepEqual(await buildDesigns(await temporaryDirectory(t)), { designs: [], pageCount: 0, stateCount: 0, written: [] });
});

test("declaredClasses reads selectors and ignores comments, strings, url(), and numbers", () => {
  assert.deepEqual([...declaredClasses(SYSTEM_CSS)].sort(), ["button", "button--secondary", "field", "form", "hero", "section", "wrap"]);
  assert.deepEqual([...declaredClasses("a { margin: 0.5rem 1.25em } .x{}")], ["x"]);
});

test("checkDesigns passes a design that uses only what the system defines, following @import", async (t) => {
  const root = await fixture(t);
  const result = await checkDesigns({ designSystemRoot: root, manifest: MANIFEST });
  assert.deepEqual(result, { enabled: true, designCount: 1, pageCount: 3, stateCount: 4 });
  assert.deepEqual(await checkDesigns({ designSystemRoot: await temporaryDirectory(t), manifest: MANIFEST }), { enabled: false, designCount: 0, pageCount: 0, stateCount: 0 });
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
  }]);
  assert.deepEqual(designsDirectory(null), []);

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
  assert.deepEqual(result.index.designs, { url: "/designs.json", count: 1, pages: 3, states: 4 });
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

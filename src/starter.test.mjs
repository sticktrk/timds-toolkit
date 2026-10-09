import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  declaredPageIds,
  formatFormatsJson,
  formatSiteJson,
  insertStylesheetLinks,
  legacyStarterFileHashes,
  mergeFormatCatalog,
  mergeSiteModel,
  planStockFile,
  starterManagedFragments,
  starterPlumbingFiles,
  syncStarter,
  template,
} from "./starter.mjs";

const fixtureRoot = fileURLToPath(new URL("./fixtures/starter-before-formats/", import.meta.url));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

test("the catalog serializers reproduce the starter's own formatting byte for byte", async () => {
  for (const name of ["starter/src/site.json", "starter-history/site-1.json", "starter-history/site-2.json"]) {
    const text = await template(name);
    assert.equal(formatSiteJson(JSON.parse(text)), text, name);
  }
  const formats = await template("starter/src/formats.json");
  assert.equal(formatFormatsJson(JSON.parse(formats)), formats);
  // Fields the starter never uses still serialize, inline, in declaration order.
  assert.equal(formatSiteJson({ title: "Docs", views: [{ id: "a", label: "A", icon: { set: "x", name: "y" }, pages: [{ slug: "", title: "Home", tags: ["one", "two"] }] }] }),
    '{\n  "title": "Docs",\n  "views": [\n    {\n      "id": "a",\n      "label": "A",\n      "icon": { "set": "x", "name": "y" },\n      "pages": [\n        { "slug": "", "title": "Home", "tags": ["one", "two"] }\n      ]\n    }\n  ]\n}\n');
});

test("the pre-format-catalog fixture is byte-identical to stock files earlier releases scaffolded", async () => {
  for (const relative of ["scripts/build.mjs", "scripts/check.mjs", "scripts/viewer.mjs"]) {
    const hash = sha256(await fs.readFile(path.join(fixtureRoot, relative), "utf8"));
    assert.ok(legacyStarterFileHashes.get(relative).includes(hash), `${relative} is a recognized stock version`);
  }
  // Every file the sync manages has a stock template to compare against.
  for (const [relative, templateName] of [...starterPlumbingFiles, ...starterManagedFragments]) {
    assert.ok((await template(templateName)).length > 0, relative);
  }
});

test("mergeSiteModel appends what the client lacks, advances untouched stock fields, and keeps edits", () => {
  const previous = { views: [
    { id: "brand", label: "Brand", blurb: "Core", pages: [{ slug: "logo", title: "Logo", planned: true }] },
    { id: "web", label: "Web", blurb: "Interface system", pages: [{ slug: "spacing", title: "Spacing" }, { slug: "layout", title: "Layout", planned: true }] },
  ] };
  const next = { views: [
    { id: "brand", label: "Brand", blurb: "Core essentials", pages: [{ slug: "logo", title: "Logo", summary: "Each lockup.", planned: true }] },
    { id: "web", label: "Web DS", blurb: "Web & email system", pages: [{ slug: "spacing", title: "Spacing & shape" }, { slug: "layout", title: "Layout", planned: true }, { slug: "email", title: "Email", planned: true }] },
    { id: "print", label: "Print DS", blurb: "Print system", pages: [{ slug: "", title: "Overview" }, { slug: "letterheads", title: "Letterheads", planned: true }] },
  ] };
  const current = { views: [
    { id: "brand", label: "Our brand", blurb: "Core", pages: [{ slug: "logo", title: "Logo", planned: true }, { slug: "mascot", title: "Mascot" }] },
    { id: "video", label: "Video", pages: [{ slug: "", title: "Video" }] },
    { id: "web", label: "Web", blurb: "Our interfaces", pages: [{ slug: "layout", title: "Layout" }, { slug: "spacing", title: "Spacing" }] },
  ] };
  const { changes, site } = mergeSiteModel(current, next, [previous], { fragmentExists: (id) => id === "print" });
  assert.deepEqual(site.views.map((view) => view.id), ["brand", "video", "web", "print"], "client order is kept and new views go last");
  assert.deepEqual(site.views[0], { id: "brand", label: "Our brand", blurb: "Core essentials", pages: [{ slug: "logo", title: "Logo", summary: "Each lockup.", planned: true }, { slug: "mascot", title: "Mascot" }] });
  assert.deepEqual(site.views[1], current.views[1], "a view the scaffold does not know is untouched");
  assert.deepEqual(site.views[2], { id: "web", label: "Web DS", blurb: "Our interfaces", pages: [
    { slug: "layout", title: "Layout" },
    { slug: "spacing", title: "Spacing & shape" },
    { slug: "email", title: "Email", planned: true },
  ] }, "an authored page stays authored, a reordered page stays where the client put it, and a new page follows its stock predecessor");
  assert.deepEqual(site.views[3], { id: "print", label: "Print DS", blurb: "Print system", pages: [{ slug: "", title: "Overview" }, { slug: "letterheads", title: "Letterheads", planned: true }] }, "an added view's overview is authored only when its fragment exists");
  // brand.label was renamed against a stock value that has not moved, so it is kept silently; web.blurb is kept and reported because the scaffold's own value changed.
  assert.deepEqual(changes, {
    addedPages: ["web/email"],
    addedViews: ["print"],
    advanced: ["brand.blurb", "brand/logo.summary", "web.label", "web/spacing.title"],
    kept: [{ current: "Our interfaces", path: "web.blurb", stock: "Web & email system" }],
  });
  assert.deepEqual(current.views[2].pages.length, 2, "the input is not mutated");

  // Without a fragment, an added overview is planned; with `authoredPages`, a still-stock planned page becomes authored.
  const bare = mergeSiteModel({ views: [] }, next, [previous]);
  assert.equal(bare.site.views[2].pages[0].planned, true);
  const authored = mergeSiteModel({ views: [{ id: "print", label: "Print DS", blurb: "Print system", pages: [{ slug: "", title: "Overview", planned: true }] }] }, next, [previous], { authoredPages: new Set(["print"]) });
  assert.equal(authored.site.views[0].pages[0].planned, undefined);
  assert.deepEqual(authored.changes.advanced, ["print.planned"]);
  // A view no baseline knows is reported in full once, an undeclared field included; once it is in the baseline, only a stock value that moved is reported again.
  const own = { views: [{ id: "print", label: "Printed matter", pages: [{ slug: "", title: "Overview" }, { slug: "letterheads", title: "Letterheads", planned: true }] }] };
  assert.deepEqual(mergeSiteModel(own, next, [previous]).changes.kept, [
    { current: "Printed matter", path: "print.label", stock: "Print DS" },
    { current: undefined, path: "print.blurb", stock: "Print system" },
  ]);
  assert.deepEqual(mergeSiteModel(own, next, [next]).changes.kept, []);
  assert.deepEqual([...declaredPageIds(site)], ["brand/logo", "brand/mascot", "video", "web/layout", "web/spacing", "web/email", "print", "print/letterheads"]);
});

test("mergeFormatCatalog admits a format only with a declared page and an unused id, and keeps client fields", () => {
  const next = {
    $comment: "Stock note.",
    print: { unit: "in", formats: {
      letterhead: { name: "Letterhead", width: 8.5, height: 11, page: "print/letterheads" },
      poster: { name: "Poster", width: 18, height: 24, page: "print/posters" },
    } },
    social: { unit: "px", formats: { square: { name: "Square", width: 1080, height: 1080, page: "social/posts" } } },
  };
  const previous = { $comment: "Old note.", print: { unit: "in", formats: { letterhead: { name: "Letterhead", width: 8.5, height: 11, page: "print/letterheads" } } } };
  const current = {
    $comment: "Old note.",
    print: { unit: "in", formats: { letterhead: { name: "Letterhead", width: 8.5, height: 11, page: "print/letterheads", stock: "Cotton" } } },
    swag: { unit: "in", formats: { square: { name: "Sticker", width: 3, height: 3, page: "print/stickers" } } },
  };
  const declared = new Set(["print/letterheads", "print/stickers", "social/posts"]);
  const { catalog, changes } = mergeFormatCatalog(current, next, [previous], declared);
  assert.deepEqual(catalog, {
    $comment: "Stock note.",
    print: { unit: "in", formats: { letterhead: { name: "Letterhead", width: 8.5, height: 11, page: "print/letterheads", stock: "Cotton" } } },
    swag: current.swag,
  }, "the note advances, the client's extra field and group stay, and nothing inadmissible is added");
  assert.deepEqual(changes, {
    addedFormats: [],
    addedGroups: [],
    advanced: ["$comment"],
    kept: [],
    skipped: [
      { id: "print.poster", reason: 'its page "print/posters" is not declared in src/site.json' },
      { id: "social.square", reason: "the id is already used by the swag group" },
      { id: "social", reason: "none of its formats has a declared page" },
    ],
  });
  // A client edit to a stock field is kept; an unchanged one advances. The edit is reported only when the stock value itself moved.
  const edited = mergeFormatCatalog(
    { print: { unit: "in", formats: { letterhead: { name: "Our letterhead", width: 8.5, height: 11, page: "print/letterheads" } } } },
    { print: { unit: "in", formats: { letterhead: { name: "Letterhead", width: 8.5, height: 11.5, page: "print/letterheads" } } } },
    [previous],
    declared,
  );
  assert.deepEqual(edited.changes.kept, [], "a rename against an unmoved stock name was reported when it was made, not on every sync");
  assert.deepEqual(edited.changes.advanced, ["print.letterhead.height"]);
  assert.deepEqual(edited.catalog.print.formats.letterhead, { name: "Our letterhead", width: 8.5, height: 11.5, page: "print/letterheads" });
  const moved = mergeFormatCatalog(
    { print: { unit: "in", formats: { letterhead: { name: "Our letterhead", width: 8.5, height: 11, page: "print/letterheads" } } } },
    { print: { unit: "in", formats: { letterhead: { name: "Letterhead sheet", width: 8.5, height: 11, page: "print/letterheads" } } } },
    [previous],
    declared,
  );
  assert.deepEqual(moved.changes.kept, [{ current: "Our letterhead", path: "print.letterhead.name", stock: "Letterhead sheet" }]);
  // Without any baseline (a format catalog from before the record), every divergence is reported once.
  assert.deepEqual(mergeFormatCatalog({ $comment: "Ours." }, { $comment: "Stock note." }, [], declared).changes.kept, [{ current: "Ours.", path: "$comment", stock: "Stock note." }]);
  // A catalog the sync creates starts with the stock notes and every admissible format.
  const created = mergeFormatCatalog(null, next, [next], new Set(["print/letterheads", "print/posters", "social/posts"]));
  assert.deepEqual(Object.keys(created.catalog), ["$comment", "print", "social"]);
  assert.deepEqual(created.changes.kept, []);
  assert.deepEqual(created.changes.addedFormats, ["print.letterhead", "print.poster", "social.square"]);
});

test("insertStylesheetLinks adds a missing stock link beside its neighbours and reports a head it cannot place it in", async () => {
  const stock = await template("starter/src/layout.html");
  const withoutCanvas = stock.replace(/\n\s*<link rel="stylesheet" href="\/styles\/canvas\.css">/, "");
  const restored = insertStylesheetLinks(withoutCanvas, stock);
  assert.equal(restored.html, stock);
  assert.deepEqual([restored.inserted, restored.unplaced], [["/styles/canvas.css"], []]);
  const current = insertStylesheetLinks(stock, stock);
  assert.deepEqual([current.html === stock, current.inserted, current.unplaced], [true, [], []]);
  // Links keep their own indentation, and tokens.css and system.css are never added: they are the client's shell.
  const compact = '<head>\n<link rel="stylesheet" href="/styles/viewer.css">\n</head>';
  assert.equal(insertStylesheetLinks(compact, stock).html, '<head>\n<link rel="stylesheet" href="/styles/canvas.css">\n<link rel="stylesheet" href="/styles/viewer.css">\n</head>');
  const foreign = insertStylesheetLinks('<head><link rel="stylesheet" href="/theme.css"></head>', stock);
  assert.deepEqual([foreign.inserted, foreign.unplaced], [[], ["/styles/canvas.css", "/styles/viewer.css"]]);
  // A link with a cache-busting query or single quotes is the same link, so it is neither duplicated nor used as a worse anchor.
  const busted = "<head>\n<link rel=\"stylesheet\" href=\"/styles/canvas.css?v=2\">\n<link rel='stylesheet' href='/styles/viewer.css'>\n</head>";
  assert.deepEqual([insertStylesheetLinks(busted, stock).html === busted, insertStylesheetLinks(busted, stock).inserted], [true, []]);
  const bustedOnly = "<head>\n<link rel=\"stylesheet\" href=\"/styles/viewer.css?v=3\">\n</head>";
  assert.equal(insertStylesheetLinks(bustedOnly, stock).html, "<head>\n<link rel=\"stylesheet\" href=\"/styles/canvas.css\">\n<link rel=\"stylesheet\" href=\"/styles/viewer.css?v=3\">\n</head>");
});

test("planStockFile recognizes stock files by hash and replaces a customized one only with force", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "timds-starter-"));
  t.after(() => fs.rm(directory, { force: true, recursive: true }));
  const target = path.join(directory, "viewer.mjs");
  assert.deepEqual(await planStockFile(target, "new\n"), { current: null, status: "created", write: true });
  await fs.writeFile(target, "old\n");
  assert.deepEqual(await planStockFile(target, "new\n", { knownHashes: [sha256("old\n")] }), { current: "old\n", status: "updated", write: true });
  assert.deepEqual(await planStockFile(target, "new\n"), { current: "old\n", status: "customized", write: false });
  assert.deepEqual(await planStockFile(target, "new\n", { force: true }), { current: "old\n", forced: true, status: "updated", write: true });
  await fs.writeFile(target, "new\n");
  assert.deepEqual(await planStockFile(target, "new\n"), { current: "new\n", status: "current", write: false });
});

test("syncStarter restores every file and the record when the check fails afterwards", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "timds-starter-"));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  await fs.cp(fixtureRoot, root, { recursive: true });
  const walk = async (directory, into = new Map()) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file, into);
      else into.set(path.relative(root, file), await fs.readFile(file, "utf8"));
    }
    return into;
  };
  const before = await walk(root);
  await assert.rejects(
    syncStarter({ check: async () => { throw new Error("the viewer build failed"); }, designSystemRoot: root, version: "0.0.0" }),
    /Starter sync was rolled back because the workspace check failed afterwards: the viewer build failed/,
  );
  const after = await walk(root);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), "no created file survives the rollback");
  for (const [relative, text] of before) assert.equal(after.get(relative), text, relative);
  await assert.rejects(fs.access(path.join(root, ".timds", "starter.json")), /ENOENT/);
  // Without a check the same sync lands, and a second sync has nothing to write.
  const first = await syncStarter({ designSystemRoot: root, version: "0.0.0" });
  assert.ok(first.adopted && first.written.length > 0 && first.recordWritten && first.check === null);
  const second = await syncStarter({ designSystemRoot: root, version: "0.0.0" });
  assert.deepEqual([second.adopted, second.written, second.recordWritten, second.check], [false, [], false, null]);
  assert.ok(second.files.every((file) => file.status === "current"), JSON.stringify(second.files));
  await assert.rejects(syncStarter({ designSystemRoot: path.join(root, "src"), version: "0.0.0" }), /not a starter-based Design System/);
});

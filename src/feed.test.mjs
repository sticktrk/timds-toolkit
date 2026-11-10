import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { feedOffshoot, describeFeed } from "./feed.mjs";
import { loadOffshootSource, shootOffshoot } from "./offshoots.mjs";
import { initializeRepository, runCli, runWithOutputSink } from "./core.mjs";
import { syncStarter } from "./starter.mjs";

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const identity = { systemId: "example/core", sourceId: "00000000-0000-4000-8000-000000000001", version: "1.0.0", commit: "1".repeat(40) };
const site = { views: [{ id: "web", label: "Web DS", blurb: "Interfaces", pages: [{ slug: "", title: "Overview" }] }] };
const formats = { web: { unit: "px", formats: { screen: { name: "Screen", width: 1000, height: 800, safe: 20, page: "web" } } } };
const script = "// parent plumbing one\n";
const nextScript = "// parent plumbing two\n";
const sourceFile = (file, text, mode = "100644") => ({ path: file, mode, encoding: "base64", content: Buffer.from(text).toString("base64") });

async function write(root, file, text) {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), text);
}
const read = (root, file) => fs.readFile(path.join(root, file), "utf8");
const readJson = async (root, file) => JSON.parse(await read(root, file));

async function fixture(t, { plumbing = "toolkit", mode = "full", git = false, stockFiles = {}, extra = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "timds-feed-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const baselineSite = mode === "full" ? structuredClone(site) : { views: [{ id: "web", label: "Web DS", pages: [{ slug: "", title: "Overview", planned: true }] }] };
  const parent = { schemaVersion: 1, ...identity, mode, baseline: { site: baselineSite, formats }, ...(stockFiles ? { files: stockFiles } : {}) };
  const texts = {
    ".timds/parent.json": json(parent),
    ".timds/starter.json": json({ schemaVersion: 1, version: "0.1.0", plumbing, level: 1, declined: [], baseline: { site: { views: [] }, formats: {} }, files: { "scripts/build.mjs": hash(script), "src/pages/web/index.html": hash("<h1>Child</h1>\n") } }),
    "src/site.json": json(baselineSite), "src/formats.json": json(formats),
    "scripts/build.mjs": script, "src/pages/web/index.html": "<h1>Child</h1>\n",
    "src/layout.html": "<main>{{content}}</main>\n", "src/styles/system.css": ".child {}\n",
    "tokens.json": '{"color":{"brand":{"value":"red"}}}\n', "media.json": '{"schemaVersion":2,"assets":[]}\n',
    ...extra,
  };
  for (const [file, text] of Object.entries(texts)) await write(root, file, text);
  if (git) {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "Fixture"], { cwd: root });
  }
  return { root, parent, texts };
}

function nextSource({ version = "1.1.0", commit = "2".repeat(40), build = nextScript, stock = null } = {}) {
  const nextSite = structuredClone(site);
  Object.assign(nextSite.views[0], { label: "Web System", blurb: "Interfaces and email" });
  nextSite.views[0].pages[0].title = "Web overview";
  nextSite.views[0].pages.push({ slug: "buttons", title: "Buttons", summary: "Parent copy" });
  const nextFormats = structuredClone(formats);
  Object.assign(nextFormats.web.formats.screen, { name: "Interface screen", width: 1200 });
  return { parent: { ...identity, version, commit }, files: [
    sourceFile("timds.json", json({ systemId: identity.systemId, version })), sourceFile("src/site.json", json(nextSite)), sourceFile("src/formats.json", json(nextFormats)),
    sourceFile(".timds/starter.json", json({ schemaVersion: 1, plumbing: "toolkit", version: "0.1.1", level: 1, declined: [], files: { "scripts/build.mjs": hash(build), "src/pages/web/index.html": hash("<h1>Parent</h1>\n") } })),
    sourceFile("scripts/build.mjs", build), sourceFile("src/pages/web/index.html", "<h1>Parent</h1>\n"),
    sourceFile("src/pages/web/buttons.html", "<h1>Parent button</h1>\n"),
    sourceFile("src/styles/system.css", ".parent {}\n"), sourceFile("src/layout.html", "<body>Parent</body>\n"),
    sourceFile("tokens.json", "{}\n"),
  ].filter((file) => !stock || !Object.hasOwn(stock, file.path)).concat(stock ? [
    ...Object.entries(stock).map(([file, text]) => sourceFile(file, text)),
    sourceFile(".timds/stock.json", json({ schemaVersion: 1, paths: Object.keys(stock) })),
  ] : []) };
}

// Two parent releases declaring stock, and a child shot from the first that
// holds a graft that shades a parent change, one that does not, a deleted
// stock page, and unmodified stock; the second release adds a stock page.
const page = (file) => `src/pages/web/${file}.html`;
const releaseOne = { [page("graft")]: "<h1>Graft one</h1>\n", [page("plain")]: "<h1>Plain one</h1>\n", [page("gone")]: "<h1>Gone one</h1>\n", [page("kept")]: "<h1>Kept</h1>\n", "src/styles/system.css": ".parent {}\n" };
const releaseTwo = { ...releaseOne, [page("graft")]: "<h1>Graft two</h1>\n", [page("plain")]: "<h1>Plain two</h1>\n", [page("gone")]: "<h1>Gone two</h1>\n", [page("buttons")]: "<h1>Parent button</h1>\n" };
const childStock = { [page("graft")]: "<h1>Child graft</h1>\n", [page("plain")]: releaseOne[page("plain")], [page("kept")]: "<h1>Child kept</h1>\n", "src/styles/system.css": releaseOne["src/styles/system.css"] };
const releaseOneHashes = Object.fromEntries(Object.entries(releaseOne).map(([file, text]) => [file, hash(text)]));
const baselineSource = () => nextSource({ version: identity.version, commit: identity.commit, stock: releaseOne });
const stockFixture = (t, options = {}) => fixture(t, { stockFiles: releaseOneHashes, extra: childStock, ...options });

async function assertStockOutcome(root, report, { adopted = false } = {}) {
  const status = Object.fromEntries(report.stock.map((entry) => [entry.path, entry.status]));
  assert.deepEqual(status, { [page("graft")]: "customized", [page("plain")]: "updated", [page("gone")]: "customized", [page("kept")]: "customized", "src/styles/system.css": "current", [page("buttons")]: "created" });
  for (const entry of report.stock) assert.deepEqual(report.files.find((file) => file.path === entry.path), entry, entry.path);
  assert.deepEqual(report.grafts.map(({ path: file, shades }) => [file, shades]), [[page("graft"), true], [page("gone"), true], [page("kept"), false]]);
  assert.match(report.grafts.find((graft) => graft.path === page("gone")).note, /removed in this system.*never recreated/);
  assert.equal(report.adopted, adopted);
  assert.equal(await read(root, page("graft")), childStock[page("graft")]);
  assert.equal(await read(root, page("kept")), childStock[page("kept")]);
  assert.equal(await read(root, page("plain")), releaseTwo[page("plain")]);
  assert.equal(await read(root, page("buttons")), releaseTwo[page("buttons")]);
  assert.equal((await fs.stat(path.join(root, page("buttons")))).mode & 0o777, 0o644);
  await assert.rejects(fs.access(path.join(root, page("gone"))), { code: "ENOENT" });
  const buttons = (await readJson(root, "src/site.json")).views[0].pages.find((entry) => entry.slug === "buttons");
  assert.equal(buttons.planned, undefined, "the created stock page is authored in the catalog");
  const record = await readJson(root, ".timds/parent.json");
  assert.deepEqual(record.files, {
    [page("graft")]: hash(releaseOne[page("graft")]), [page("gone")]: hash(releaseOne[page("gone")]), [page("kept")]: hash(releaseOne[page("kept")]),
    [page("plain")]: hash(releaseTwo[page("plain")]), [page("buttons")]: hash(releaseTwo[page("buttons")]), "src/styles/system.css": hash(releaseOne["src/styles/system.css"]),
  });
  assert.deepEqual(report.parent.files, record.files);
  const lines = describeFeed(report).join("\n");
  assert.match(lines, /Your graft shades the parent's change at src\/pages\/web\/graft\.html; kept\. Accept the parent's version by editing the file\./);
  assert.match(lines, /shades the parent's change at src\/pages\/web\/gone\.html; removed in this system/);
  assert.doesNotMatch(lines, /shades the parent's change at src\/pages\/web\/kept\.html/);
  assert.match(lines, /New stock page from the parent: src\/pages\/web\/buttons\.html, catalog page web\/buttons/);
}

test("feed advances unchanged fields, preserves grafts and authored source, and records the new baseline", async (t) => {
  const { root, texts } = await fixture(t);
  const childSite = structuredClone(site);
  childSite.views[0].label = "Our web";
  const childFormats = structuredClone(formats);
  childFormats.web.formats.screen.name = "Our screen";
  await write(root, "src/site.json", json(childSite));
  await write(root, "src/formats.json", json(childFormats));
  let checks = 0;
  const source = nextSource();
  const report = await feedOffshoot({ designSystemRoot: root, source, check: async () => { checks++; return { machine: { warnings: [] } }; } });
  assert.equal(checks, 1);
  assert.deepEqual((await readJson(root, "src/site.json")).views[0], { id: "web", label: "Our web", blurb: "Interfaces and email", pages: [{ slug: "", title: "Web overview" }, { slug: "buttons", title: "Buttons", summary: "Parent copy", planned: true }] });
  assert.equal((await readJson(root, "src/formats.json")).web.formats.screen.width, 1200);
  assert.equal((await readJson(root, "src/formats.json")).web.formats.screen.name, "Our screen");
  assert.equal(await read(root, "scripts/build.mjs"), script, "feed carries no code: the child keeps its own plumbing");
  assert.ok(!report.files.some((file) => file.path === "scripts/build.mjs"));
  assert.equal((await readJson(root, ".timds/parent.json")).version, "1.1.0");
  for (const file of [".timds/starter.json", "src/pages/web/index.html", "src/layout.html", "src/styles/system.css", "tokens.json", "media.json"]) assert.equal(await read(root, file), texts[file], file);
  await assert.rejects(fs.access(path.join(root, "src/pages/web/buttons.html")), { code: "ENOENT" });
  assert.deepEqual((await readJson(root, ".timds/starter.json")).baseline, { site: { views: [] }, formats: {} }, "the seed baseline stays separate");
  assert.match(describeFeed(report).join("\n"), /Your graft shades the parent's change at web.label/);
  const again = await feedOffshoot({ designSystemRoot: root, source, check: async () => { throw new Error("must not check an unchanged feed"); } });
  assert.deepEqual(again.written, []);
  assert.deepEqual(again.files.filter((file) => file.path.startsWith(".timds/")).map((file) => [file.path, file.status]), [[".timds/parent.json", "current"]]);
  assert.ok(again.files.every((file) => file.status === "current"));
  assert.doesNotMatch(describeFeed(again).join("\n"), /\bupdated\b/);
  assert.deepEqual(again.site.kept, []);
  assert.deepEqual(again.formats.kept, []);
});

test("feed accepts additive parent export fields while persisting only the lineage contract", async (t) => {
  for (const mode of ["full", "structure"]) {
    const { root, parent } = await fixture(t, { mode });
    const source = nextSource();
    const expectedIdentity = structuredClone(source.parent);
    Object.assign(source.parent, { schemaVersion: 7, mode: "future-mode", releaseMetadata: { published: true }, baseline: "export metadata" });
    await feedOffshoot({ designSystemRoot: root, source });
    const actual = await readJson(root, ".timds/parent.json");
    assert.deepEqual(Object.keys(actual).sort(), ["schemaVersion", "systemId", "sourceId", "version", "commit", "mode", "baseline", "files"].sort());
    assert.deepEqual({ systemId: actual.systemId, sourceId: actual.sourceId, version: actual.version, commit: actual.commit }, expectedIdentity);
    assert.equal(actual.schemaVersion, 1);
    assert.equal(actual.mode, parent.mode);
    assert.equal(source.parent.releaseMetadata.published, true, "the exported source is not mutated");
  }
});

test("no-op feed --json reports unchanged bookkeeping records as current", async (t) => {
  const { root } = await fixture(t);
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "timds-feed-source-"));
  t.after(() => fs.rm(sourceRoot, { recursive: true, force: true }));
  for (const file of nextSource().files) await write(sourceRoot, file.path, Buffer.from(file.content, "base64"));
  execFileSync("git", ["init", "-q"], { cwd: sourceRoot });
  execFileSync("git", ["add", "."], { cwd: sourceRoot });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "Parent release"], { cwd: sourceRoot });
  const source = await loadOffshootSource(sourceRoot, { local: true, sourceId: identity.sourceId });
  await feedOffshoot({ designSystemRoot: root, source });
  await write(root, "timds.json", json({ systemId: "example/child", name: "Child", version: "1.0.0" }));
  const output = [];
  await runWithOutputSink((line) => output.push(line), () => runCli(["feed", "--root", root, "--from", sourceRoot, "--json"]));
  const report = JSON.parse(output.join("\n"));
  assert.deepEqual(report.written, []);
  assert.equal(report.recordWritten, false);
  assert.equal(report.check, null);
  assert.ok(report.files.every((file) => file.status === "current"));
  assert.deepEqual(report.files.filter((file) => file.path.startsWith(".timds/")).map((file) => [file.path, file.status]), [[".timds/parent.json", "current"]]);
});

test("structure feed retains neutral structure catalogs without parent prose or bodies", async (t) => {
  const { root } = await fixture(t, { mode: "structure" });
  const report = await feedOffshoot({ designSystemRoot: root, source: nextSource() });
  const actual = await readJson(root, "src/site.json");
  assert.deepEqual(actual.views[0], { id: "web", label: "Web System", pages: [{ slug: "", title: "Web overview", planned: true }, { slug: "buttons", title: "Buttons", planned: true }] });
  assert.equal(JSON.stringify((await readJson(root, ".timds/parent.json")).baseline).includes("Parent copy"), false);
  assert.equal(report.parent.mode, "structure");
});

test("feed writes no plumbing: a child keeps its own whatever the parent recorded, in either plumbing mode", async (t) => {
  for (const plumbing of ["toolkit", "recorded"]) {
    const { root, texts } = await fixture(t, { plumbing });
    const source = nextSource();
    source.files.push(sourceFile("src/scripts/compose.js", "// parent composer\n"), sourceFile("src/styles/viewer.css", "/* parent chrome */\n"));
    const report = await feedOffshoot({ designSystemRoot: root, source });
    assert.equal(await read(root, "scripts/build.mjs"), texts["scripts/build.mjs"], plumbing);
    for (const file of ["src/scripts/compose.js", "src/styles/viewer.css"]) await assert.rejects(fs.access(path.join(root, file)), { code: "ENOENT" }, file);
    assert.equal(await read(root, ".timds/starter.json"), texts[".timds/starter.json"], "the starter record is the toolkit's, not the parent's");
    assert.ok(report.files.every((file) => ![...["scripts/", "src/scripts/", "src/styles/viewer.css", "src/styles/canvas.css"]].some((prefix) => file.path.startsWith(prefix))), JSON.stringify(report.files));
  }
});

test("a parent's declared stock that is toolkit plumbing is accepted, reported, never written and never recorded", async (t) => {
  const { root, texts } = await fixture(t, { stockFiles: { "src/styles/viewer.css": hash("/* recorded by an earlier shoot */\n") } });
  await write(root, "src/styles/viewer.css", "/* the child's chrome */\n");
  const source = nextSource({ stock: { "src/styles/viewer.css": "/* the parent's chrome */\n", [page("buttons")]: "<h1>Parent button</h1>\n" } });
  const report = await feedOffshoot({ designSystemRoot: root, source });
  const expected = { path: "src/styles/viewer.css", status: "skipped", note: "toolkit plumbing: the parent declares it as stock, but feed never writes plumbing (only upgrade does), so it was not fed" };
  assert.deepEqual(report.stock.find((entry) => entry.path === "src/styles/viewer.css"), expected);
  assert.deepEqual(report.files.find((entry) => entry.path === "src/styles/viewer.css"), expected);
  assert.ok(!report.written.includes("src/styles/viewer.css"));
  assert.equal(await read(root, "src/styles/viewer.css"), "/* the child's chrome */\n");
  assert.deepEqual((await readJson(root, ".timds/parent.json")).files, { [page("buttons")]: hash("<h1>Parent button</h1>\n") }, "no stock hash is recorded for plumbing, and an earlier one is dropped");
  assert.match(describeFeed(report).join("\n"), /Not fed: src\/styles\/viewer\.css is toolkit plumbing/);
  assert.equal(await read(root, ".timds/starter.json"), texts[".timds/starter.json"]);
});

test("feed refuses a child or a parent release below the starter floor before writing anything", async (t) => {
  const { root, texts } = await fixture(t);
  const record = JSON.parse(texts[".timds/starter.json"]);
  delete record.level;
  await write(root, ".timds/starter.json", json(record));
  await assert.rejects(feedOffshoot({ designSystemRoot: root, source: nextSource() }), (error) => error.failureCode === "below_floor" && /This offshoot predates starter levels/.test(error.message));
  for (const [file, text] of Object.entries(texts)) if (file !== ".timds/starter.json") assert.equal(await read(root, file), text, file);
  await write(root, ".timds/starter.json", texts[".timds/starter.json"]);
  const old = nextSource();
  const stock = old.files.find((file) => file.path === ".timds/starter.json");
  const parentRecord = JSON.parse(Buffer.from(stock.content, "base64").toString());
  delete parentRecord.level;
  stock.content = Buffer.from(json(parentRecord)).toString("base64");
  await assert.rejects(feedOffshoot({ designSystemRoot: root, source: old }), (error) => error.failureCode === "below_floor" && /The parent release example\/core 1\.1\.0 predates starter levels/.test(error.message));
  for (const [file, text] of Object.entries(texts)) assert.equal(await read(root, file), text, file);
});

test("failed feed restores all source files and both records", async (t) => {
  const { root, texts } = await fixture(t);
  await assert.rejects(feedOffshoot({ designSystemRoot: root, source: nextSource(), check: async () => { throw new Error("fixture build failed"); } }), /Feed was rolled back.*fixture build failed/);
  for (const [file, text] of Object.entries(texts)) assert.equal(await read(root, file), text, file);
});

test("feed refuses an older parent release before changing files or the baseline", async (t) => {
  const { root, texts } = await fixture(t);
  await assert.rejects(feedOffshoot({ designSystemRoot: root, source: nextSource({ version: "0.9.0" }) }), /1\.0\.0; 0\.9\.0 is older/);
  for (const [file, text] of Object.entries(texts)) assert.equal(await read(root, file), text, file);
  await feedOffshoot({ designSystemRoot: root, source: nextSource({ version: "2026.10.29-2" }) });
  const baseline = await read(root, ".timds/parent.json");
  await assert.rejects(feedOffshoot({ designSystemRoot: root, source: nextSource({ version: "2026.10.29-1" }) }), /2026\.10\.29-2; 2026\.10\.29-1 is older/);
  assert.equal(await read(root, ".timds/parent.json"), baseline);
});

test("feed refuses dirty writes, mismatched identity and symlink targets", async (t) => {
  const { root, texts } = await fixture(t, { git: true, mode: "structure" });
  await write(root, "src/site.json", `${texts["src/site.json"]}\n`);
  await assert.rejects(feedOffshoot({ designSystemRoot: root, source: nextSource() }), /Feed refuses to run over uncommitted changes/);
  assert.equal(await read(root, "scripts/build.mjs"), script);
  await write(root, "src/site.json", texts["src/site.json"]);
  const mismatch = nextSource(); mismatch.parent.sourceId = "00000000-0000-4000-8000-000000000002";
  await assert.rejects(feedOffshoot({ designSystemRoot: root, source: mismatch }), /different parent system or source/);
  await fs.rm(path.join(root, "src/formats.json"));
  await fs.symlink("../tokens.json", path.join(root, "src/formats.json"));
  await assert.rejects(feedOffshoot({ designSystemRoot: root, source: nextSource() }), /regular file without symbolic links/);
  assert.equal(await read(root, "tokens.json"), texts["tokens.json"]);
});

test("ordinary starter sync updates only plumbing in an offshoot and preserves parent and structural baselines", async (t) => {
  const { root, texts } = await fixture(t);
  const originalRecord = await readJson(root, ".timds/starter.json");
  await syncStarter({ designSystemRoot: root, version: "0.1.999" });
  for (const file of [".timds/parent.json", "src/site.json", "src/formats.json", "src/pages/web/index.html", "src/layout.html", "src/styles/system.css", "tokens.json", "media.json"]) assert.equal(await read(root, file), texts[file], file);
  const nextRecord = await readJson(root, ".timds/starter.json");
  assert.deepEqual(nextRecord.baseline, originalRecord.baseline);
  assert.equal(nextRecord.files["src/pages/web/index.html"], originalRecord.files["src/pages/web/index.html"]);
  assert.equal(nextRecord.version, "0.1.999");
  await assert.rejects(fs.access(path.join(root, "src/pages/use/index.html")), { code: "ENOENT" });
});

test("offshoot starter sync maintains layout stylesheet links with full rollback", async (t) => {
  const { root, texts } = await fixture(t);
  const layout = '<!doctype html>\n<head>\n<link rel="stylesheet" href="/styles/viewer.css">\n</head>\n<body><header>Child shell</header><span class="appbar__version">v{{version}}</span><main>{{content}}</main></body>\n';
  await write(root, "src/layout.html", layout);
  await assert.rejects(syncStarter({ designSystemRoot: root, version: "0.1.999", check: async () => { throw new Error("layout build failed"); } }), /rolled back.*layout build failed/);
  assert.equal(await read(root, "src/layout.html"), layout);
  assert.equal(await read(root, ".timds/starter.json"), texts[".timds/starter.json"]);
  const report = await syncStarter({ designSystemRoot: root, version: "0.1.999" });
  const updated = await read(root, "src/layout.html");
  assert.match(updated, /<link rel="stylesheet" href="\/styles\/canvas\.css">/);
  assert.match(updated, /<header>Child shell<\/header>/);
  assert.ok(report.written.includes("src/layout.html"));
  for (const file of [".timds/parent.json", "src/site.json", "src/formats.json", "src/pages/web/index.html"]) assert.equal(await read(root, file), texts[file], file);
  assert.deepEqual((await readJson(root, ".timds/starter.json")).baseline, JSON.parse(texts[".timds/starter.json"]).baseline);
  await assert.rejects(fs.access(path.join(root, "src/pages/use/index.html")), { code: "ENOENT" });
});

test("feed refreshes declared stock by recorded hash, keeps grafts, creates new stock pages and advances hashes", async (t) => {
  const { root } = await stockFixture(t);
  let checks = 0;
  const source = nextSource({ stock: releaseTwo });
  const report = await feedOffshoot({ designSystemRoot: root, source, check: async () => { checks++; return { ok: true }; } });
  assert.equal(checks, 1);
  await assertStockOutcome(root, report);
  for (const file of [page("plain"), page("buttons"), ".timds/parent.json", "src/site.json"]) assert.ok(report.written.includes(file), file);
  for (const file of [page("graft"), page("kept"), page("gone"), "src/styles/system.css"]) assert.ok(!report.written.includes(file), file);

  const again = await feedOffshoot({ designSystemRoot: root, source, check: async () => { throw new Error("must not check an unchanged feed"); } });
  assert.deepEqual(again.written, []);
  assert.ok(again.stock.filter((entry) => entry.status !== "customized").every((entry) => entry.status === "current"));
  assert.deepEqual(again.stock.filter((entry) => entry.status === "customized").map((entry) => entry.path), [page("graft"), page("gone"), page("kept")]);

  // Reverting a graft to the bytes last written for it makes it stock again.
  await write(root, page("graft"), releaseOne[page("graft")]);
  const reverted = await feedOffshoot({ designSystemRoot: root, source });
  assert.equal(reverted.stock.find((entry) => entry.path === page("graft")).status, "updated");
  assert.equal(await read(root, page("graft")), releaseTwo[page("graft")]);
  // A child copy that already equals the parent's bytes is current and its hash advances.
  const { root: matching } = await stockFixture(t, { extra: { ...childStock, [page("kept")]: releaseTwo[page("kept")], [page("graft")]: releaseTwo[page("graft")] } });
  const advanced = await feedOffshoot({ designSystemRoot: matching, source });
  assert.equal(advanced.stock.find((entry) => entry.path === page("graft")).status, "current");
  assert.equal((await readJson(matching, ".timds/parent.json")).files[page("graft")], hash(releaseTwo[page("graft")]));
});

test("a graft first met without a recorded hash remembers the parent's bytes it was offered", async (t) => {
  const childPage = "<h1>Child button</h1>\n";
  const offered = { [page("buttons")]: "<h1>Parent button</h1>\n" };
  const source = nextSource({ stock: offered });
  const buttonsPage = async (root) => (await readJson(root, "src/site.json")).views[0].pages.find((entry) => entry.slug === "buttons");

  // The child authored the page itself before the parent declared that path.
  const { root } = await fixture(t, { stockFiles: {}, extra: { [page("buttons")]: childPage } });
  const first = await feedOffshoot({ designSystemRoot: root, source });
  assert.deepEqual(first.stock, [{ path: page("buttons"), status: "customized", note: "your graft; kept over the parent's change" }]);
  assert.deepEqual(first.grafts.map(({ path: file, shades, removed }) => [file, shades, removed]), [[page("buttons"), true, undefined]]);
  assert.equal(await read(root, page("buttons")), childPage);
  assert.deepEqual((await readJson(root, ".timds/parent.json")).files, { [page("buttons")]: hash(offered[page("buttons")]) }, "the offered version is recorded");
  assert.equal((await buttonsPage(root)).planned, true);

  // Deleting it afterwards is a removed graft: never recreated, still planned.
  await fs.rm(path.join(root, page("buttons")));
  const removed = await feedOffshoot({ designSystemRoot: root, source });
  assert.deepEqual(removed.stock.map((entry) => [entry.path, entry.status]), [[page("buttons"), "customized"]]);
  assert.deepEqual(removed.grafts.map(({ path: file, shades, removed: gone }) => [file, shades, gone]), [[page("buttons"), false, true]]);
  await assert.rejects(fs.access(path.join(root, page("buttons"))), { code: "ENOENT" });
  assert.equal((await buttonsPage(root)).planned, true, "the committed deletion stays planned");
  assert.doesNotMatch(describeFeed(removed).join("\n"), /shades the parent's change at src\/pages\/web\/buttons\.html/);

  // Reverting it to the parent's bytes makes it stock again.
  await write(root, page("buttons"), offered[page("buttons")]);
  const reverted = await feedOffshoot({ designSystemRoot: root, source });
  assert.equal(reverted.stock.find((entry) => entry.path === page("buttons")).status, "current");
  assert.deepEqual(reverted.grafts, []);

  // A kept first-met graft shades only when the parent's bytes move again.
  const { root: kept } = await fixture(t, { stockFiles: {}, extra: { [page("buttons")]: childPage } });
  await feedOffshoot({ designSystemRoot: kept, source });
  const same = await feedOffshoot({ designSystemRoot: kept, source });
  assert.deepEqual(same.grafts.map(({ path: file, shades }) => [file, shades]), [[page("buttons"), false]]);
  assert.doesNotMatch(describeFeed(same).join("\n"), /shades the parent's change at src\/pages\/web\/buttons\.html/);
  const moved = await feedOffshoot({ designSystemRoot: kept, source: nextSource({ version: "1.2.0", commit: "3".repeat(40), stock: { [page("buttons")]: "<h1>Parent button two</h1>\n" } }) });
  assert.deepEqual(moved.grafts.map(({ path: file, shades }) => [file, shades]), [[page("buttons"), true]]);
  assert.match(describeFeed(moved).join("\n"), /Your graft shades the parent's change at src\/pages\/web\/buttons\.html; kept\./);
  assert.equal(await read(kept, page("buttons")), childPage);
  assert.equal((await readJson(kept, ".timds/parent.json")).files[page("buttons")], hash(offered[page("buttons")]), "a kept graft keeps the hash recorded for it");
});

test("feed refuses a child whose lock selects an older toolkit before changing any file", async (t) => {
  const pkg = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
  const lock = (version) => json({ name: "child", lockfileVersion: 3, requires: true, packages: { "": { name: "child" }, [`node_modules/${pkg.name}`]: { version } } });
  const { root, texts } = await stockFixture(t, { extra: { ...childStock, "package-lock.json": lock("0.1.400") } });
  await assert.rejects(feedOffshoot({ designSystemRoot: root, source: nextSource({ stock: releaseTwo }), check: async () => { throw new Error("must not check"); } }), (error) => error.message.includes("selects toolkit 0.1.400") && error.message.includes(`timds upgrade --version ${pkg.version}`));
  for (const [file, text] of Object.entries(texts)) assert.equal(await read(root, file), text, file);
  await assert.rejects(fs.access(path.join(root, page("buttons"))), { code: "ENOENT" });
  await write(root, "package-lock.json", lock(pkg.version));
  const report = await feedOffshoot({ designSystemRoot: root, source: nextSource({ stock: releaseTwo }) });
  await assertStockOutcome(root, report);
});

test("a failed check rolls back refreshed and created stock with both records", async (t) => {
  const { root, texts } = await stockFixture(t);
  await assert.rejects(feedOffshoot({ designSystemRoot: root, source: nextSource({ stock: releaseTwo }), check: async () => { throw new Error("stock build failed"); } }), /rolled back.*stock build failed/);
  for (const [file, text] of Object.entries(texts)) assert.equal(await read(root, file), text, file);
  await assert.rejects(fs.access(path.join(root, page("buttons"))), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(root, page("gone"))), { code: "ENOENT" });
});

test("a structure offshoot un-plans the catalog page of a stock fragment the feed creates", async (t) => {
  const { root } = await stockFixture(t, { mode: "structure" });
  const report = await feedOffshoot({ designSystemRoot: root, source: nextSource({ stock: releaseTwo }) });
  const pages = (await readJson(root, "src/site.json")).views[0].pages;
  assert.equal(pages.find((entry) => entry.slug === "buttons").planned, undefined);
  assert.equal(pages.find((entry) => entry.slug === "").planned, true, "pages without a created fragment stay planned");
  assert.ok(report.site.advanced.includes("web/buttons.planned"));
});

test("a record shot before stock hashes adopts them from its baseline release on the first feed", async (t) => {
  const { root, texts } = await stockFixture(t, { stockFiles: null });
  const source = nextSource({ stock: releaseTwo });
  await assert.rejects(feedOffshoot({ designSystemRoot: root, source }), /predates stock hashes.*example\/core 1\.0\.0 at 1{40}.*--baseline-file/);
  for (const [file, text] of Object.entries(texts)) assert.equal(await read(root, file), text, file);
  const moved = baselineSource(); moved.parent.commit = "9".repeat(40);
  await assert.rejects(feedOffshoot({ designSystemRoot: root, source, baseline: moved }), /baseline is not the release .*commit differs/);
  for (const [file, text] of Object.entries(texts)) assert.equal(await read(root, file), text, file);
  const report = await feedOffshoot({ designSystemRoot: root, source, baseline: baselineSource() });
  await assertStockOutcome(root, report, { adopted: true });
  assert.match(describeFeed(report).join("\n"), /Adopted stock hashes/);
  const next = await feedOffshoot({ designSystemRoot: root, source, check: async () => { throw new Error("must not check an unchanged feed"); } });
  assert.equal(next.adopted, false, "a record with files never reads a baseline again");
  assert.deepEqual(next.written, []);
});

test("a record with empty stock hashes never needs a baseline", async (t) => {
  const { root } = await fixture(t);
  const report = await feedOffshoot({ designSystemRoot: root, source: nextSource({ stock: { [page("buttons")]: "<h1>Parent button</h1>\n" } }) });
  assert.equal(report.adopted, false);
  assert.deepEqual(report.stock, [{ path: page("buttons"), status: "created" }]);
  assert.deepEqual((await readJson(root, ".timds/parent.json")).files, { [page("buttons")]: hash("<h1>Parent button</h1>\n") });
});

const runnerSourceId = "11111111-1111-4111-8111-111111111111";
const gitIn = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
async function exportSource(root, file) {
  const source = await loadOffshootSource(root, { sourceId: runnerSourceId });
  await fs.writeFile(file, json({ apiVersion: 1, ...source }));
  return source;
}

async function runnerFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "timds-feed-runner-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const parentRoot = path.join(directory, "parent"), child = path.join(directory, "child");
  await fs.mkdir(parentRoot);
  gitIn(parentRoot, "init", "-q", "-b", "main"); gitIn(parentRoot, "config", "user.email", "test@example.com"); gitIn(parentRoot, "config", "user.name", "Test");
  await runWithOutputSink(() => {}, () => initializeRepository(parentRoot, { standalone: true, systemId: "example/core", name: "Example Core" }));
  await write(parentRoot, ".timds/stock.json", json({ schemaVersion: 1, paths: ["src/pages/brand/color.html", "src/styles/system.css"] }));
  gitIn(parentRoot, "add", "--all"); gitIn(parentRoot, "commit", "-qm", "Parent release one");
  const one = path.join(directory, "one.json"), two = path.join(directory, "two.json");
  const first = await exportSource(parentRoot, one);
  await shootOffshoot({ destination: child, source: first, systemId: "example/child" });
  gitIn(child, "config", "user.email", "test@example.com"); gitIn(child, "config", "user.name", "Test");
  gitIn(child, "add", "--all"); gitIn(child, "commit", "-qm", "Child");
  const color = `${await read(parentRoot, "src/pages/brand/color.html")}\n<p>Parent release two.</p>\n`;
  await write(parentRoot, "src/pages/brand/color.html", color);
  gitIn(parentRoot, "add", "--all"); gitIn(parentRoot, "commit", "-qm", "Parent release two");
  const second = await exportSource(parentRoot, two);
  await write(child, ".timds/session.json", "{}\n");
  const previous = process.env.TIMDS_HOSTED_RUNNER;
  t.after(() => { if (previous === undefined) delete process.env.TIMDS_HOSTED_RUNNER; else process.env.TIMDS_HOSTED_RUNNER = previous; });
  return { parentRoot, child, one, two, first, second, color };
}

async function runFeed(args) {
  const output = [];
  await runWithOutputSink((line) => output.push(line), () => runCli(["feed", ...args]));
  return JSON.parse(output.join("\n"));
}

/** Run a `feed --json` that must refuse, and return the `error.code` its `{ ok: false }` document carries. */
async function feedFailure(args, expected) {
  const output = [];
  await assert.rejects(runWithOutputSink((line) => output.push(line), () => runCli(["feed", ...args])), expected);
  const receipt = JSON.parse(output.join("\n"));
  assert.equal(receipt.ok, false);
  return receipt.error.code;
}

test("the host runner feeds a hosted workspace from a source export and reports everything it records", async (t) => {
  const { child, two, first, second, color } = await runnerFixture(t);
  delete process.env.TIMDS_HOSTED_RUNNER;
  await assert.rejects(runFeed(["--root", child, "--source-file", two, "--json"]), /not available in a hosted session.*TIMDS_HOSTED_RUNNER=1/);
  await assert.rejects(runFeed(["--root", child, "--source-file", two, "--from", child, "--json"]), /Usage: timds feed[\s\S]*cannot be combined with --from/);
  await assert.rejects(runFeed(["--root", child, "--source-file", two, "--version", "latest"]), /cannot be combined/);
  await assert.rejects(runFeed(["--root", child, "--baseline-file", two]), /--baseline-file requires --source-file/);
  process.env.TIMDS_HOSTED_RUNNER = "1";
  const report = await runFeed(["--root", child, "--source-file", two, "--json"]);
  assert.equal(await read(child, "src/pages/brand/color.html"), color);
  assert.deepEqual(report.stock, [{ path: "src/pages/brand/color.html", status: "updated" }, { path: "src/styles/system.css", status: "current" }]);
  assert.deepEqual(report.grafts, []);
  assert.equal(report.adopted, false);
  assert.ok(report.check, "the workspace check ran");
  assert.ok(Array.isArray(report.files) && report.site && report.formats && Array.isArray(report.written));
  assert.deepEqual({ ...report.parent, baseline: undefined, files: undefined }, { ...report.previousParent, baseline: undefined, files: undefined, commit: second.parent.commit });
  assert.equal(report.previousParent.commit, first.parent.commit);
  assert.equal(report.parent.files["src/pages/brand/color.html"], hash(color));
  assert.ok(report.written.includes("src/pages/brand/color.html") && report.written.includes(".timds/parent.json"));
});

test("the host runner adopts stock hashes for an older child through --baseline-file", async (t) => {
  const { child, one, two, color } = await runnerFixture(t);
  const record = await readJson(child, ".timds/parent.json");
  delete record.files;
  await write(child, ".timds/parent.json", json(record));
  gitIn(child, "commit", "-qam", "Record before stock hashes");
  process.env.TIMDS_HOSTED_RUNNER = "1";
  assert.equal(await feedFailure(["--root", child, "--source-file", two, "--json"], /predates stock hashes[\s\S]*--baseline-file/), "baseline_required");
  assert.equal(await feedFailure(["--root", child, "--source-file", two, "--baseline-file", two, "--json"], /baseline is not the release .*commit differs/), "parent_mismatch");
  const report = await runFeed(["--root", child, "--source-file", two, "--baseline-file", one, "--json"]);
  assert.equal(report.adopted, true);
  assert.equal(await read(child, "src/pages/brand/color.html"), color);
  assert.deepEqual(Object.keys((await readJson(child, ".timds/parent.json")).files).sort(), ["src/pages/brand/color.html", "src/styles/system.css"]);
});

test("feed --json names a system without a parent record as not_offshoot", async (t) => {
  const { child, two } = await runnerFixture(t);
  await fs.rm(path.join(child, ".timds/parent.json"));
  process.env.TIMDS_HOSTED_RUNNER = "1";
  assert.equal(await feedFailure(["--root", child, "--source-file", two, "--json"], /no parent to feed/), "not_offshoot");
});

test("feed --from reads the recorded release from the local parent to adopt stock hashes", async (t) => {
  const { parentRoot, child, color } = await runnerFixture(t);
  await fs.rm(path.join(child, ".timds/session.json"));
  const record = await readJson(child, ".timds/parent.json");
  delete record.files;
  await write(child, ".timds/parent.json", json(record));
  gitIn(child, "commit", "-qam", "Record before stock hashes");
  const report = await runFeed(["--root", child, "--from", parentRoot, "--source-id", runnerSourceId, "--json"]);
  assert.equal(report.adopted, true);
  assert.equal(await read(child, "src/pages/brand/color.html"), color);
  assert.deepEqual(report.stock.map((entry) => entry.status), ["updated", "current"]);
});

test("a child fed from a parent whose recorded plumbing differs keeps its own byte for byte, runs its after-build commands, and reports its level", async (t) => {
  const { parentRoot, child } = await runnerFixture(t);
  await fs.rm(path.join(child, ".timds/session.json"));
  // The child declares an extra build step; the parent moves its own plumbing
  // (as a release on another toolkit would) and records it.
  const manifest = await readJson(child, "timds.json");
  await write(child, "timds.json", json({ ...manifest, workspace: { ...manifest.workspace, after: { build: [["node", "-e", "require('fs').appendFileSync('after.log', 'ran\\n')"]] } } }));
  gitIn(child, "add", "--all"); gitIn(child, "commit", "-qm", "Child build step");
  const plumbing = ["scripts/build.mjs", "scripts/check.mjs", "scripts/dev.mjs", "src/scripts/compose.js", "src/styles/canvas.css", "src/styles/viewer.css"];
  const before = Object.fromEntries(await Promise.all(plumbing.map(async (file) => [file, await fs.readFile(path.join(child, file))])));
  const parentRecord = await readJson(parentRoot, ".timds/starter.json");
  for (const file of ["scripts/build.mjs", "src/scripts/compose.js", "src/styles/viewer.css"]) {
    const moved = `${await read(parentRoot, file)}\n// the parent's toolkit release\n`;
    await write(parentRoot, file, moved);
    parentRecord.files[file] = hash(moved);
  }
  await write(parentRoot, ".timds/starter.json", json(parentRecord));
  gitIn(parentRoot, "add", "--all"); gitIn(parentRoot, "commit", "-qm", "Parent on another toolkit release");
  const report = await runFeed(["--root", child, "--from", parentRoot, "--source-id", runnerSourceId, "--json"]);
  for (const file of plumbing) assert.ok((await fs.readFile(path.join(child, file))).equals(before[file]), file);
  assert.ok(!report.files.some((file) => plumbing.includes(file.path)), JSON.stringify(report.files));
  assert.ok(report.check, "the feed's own check ran the child's build");
  assert.match(await read(child, "after.log"), /ran/, "the child's workspace.after.build ran");
  const output = [];
  await runWithOutputSink((line) => output.push(line), () => runCli(["starter", "status", "--root", child, "--json"]));
  assert.deepEqual(JSON.parse(output.join("\n")), { starter: "starter", plumbing: "toolkit", level: 1, current: 1, floor: 1, belowFloor: false, behind: 0, pending: [], declined: [], conflicts: [] });
  await assert.rejects(runWithOutputSink(() => {}, () => runCli(["feed", "--root", child, "--from", parentRoot, "--force", "scripts/build.mjs"])), /Feed carries no code/);
});

/** Leave a committed tokens.json aggregate stale, so any default workspace load would rewrite it. */
async function staleAggregates(root) {
  const group = await readJson(root, "tokens/space.json");
  group["1"].value = "0.3rem";
  await write(root, "tokens/space.json", json(group));
}
const cleanTree = (root, label) => assert.equal(gitIn(root, "status", "--porcelain", "--untracked-files=all"), "", `${label} wrote nothing`);
const belowFloor = (error) => error.failureCode === "below_floor" && /predates starter levels/.test(error.message);

test("feed refuses a child or a parent below the floor without touching either tree, stale aggregates included", async (t) => {
  const { parentRoot, child } = await runnerFixture(t);
  await fs.rm(path.join(child, ".timds/session.json"));
  await staleAggregates(child);
  gitIn(child, "add", "--all"); gitIn(child, "commit", "-qm", "A stale aggregate");
  // The parent's release predates starter levels.
  const parentRecord = await readJson(parentRoot, ".timds/starter.json");
  delete parentRecord.level;
  await write(parentRoot, ".timds/starter.json", json(parentRecord));
  gitIn(parentRoot, "add", "--all"); gitIn(parentRoot, "commit", "-qm", "A parent from before starter levels");
  await assert.rejects(runWithOutputSink(() => {}, () => runCli(["feed", "--root", child, "--from", parentRoot, "--source-id", runnerSourceId])), belowFloor);
  cleanTree(child, "feed from a below-floor parent");
  cleanTree(parentRoot, "feed from a below-floor parent (parent)");
  assert.equal(await feedFailure(["--root", child, "--from", parentRoot, "--source-id", runnerSourceId, "--json"], /predates starter levels/), "below_floor");
  cleanTree(child, "feed --json from a below-floor parent");
  // The child predates starter levels.
  const childRecord = await readJson(child, ".timds/starter.json");
  delete childRecord.level;
  await write(child, ".timds/starter.json", json(childRecord));
  gitIn(child, "add", "--all"); gitIn(child, "commit", "-qm", "A child from before starter levels");
  await assert.rejects(runWithOutputSink(() => {}, () => runCli(["feed", "--root", child, "--from", parentRoot, "--source-id", runnerSourceId])), (error) => belowFloor(error) && /This offshoot predates/.test(error.message));
  cleanTree(child, "feed into a below-floor child");
});

test("shoot records no stock hash for a declared plumbing path, and feed reports it as not fed", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "timds-feed-plumbing-stock-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const parentRoot = path.join(directory, "parent"), child = path.join(directory, "child");
  await fs.mkdir(parentRoot);
  gitIn(parentRoot, "init", "-q", "-b", "main"); gitIn(parentRoot, "config", "user.email", "test@example.com"); gitIn(parentRoot, "config", "user.name", "Test");
  await runWithOutputSink(() => {}, () => initializeRepository(parentRoot, { standalone: true, systemId: "example/core", name: "Example Core" }));
  await write(parentRoot, ".timds/stock.json", json({ schemaVersion: 1, paths: ["src/pages/brand/color.html", "src/styles/viewer.css"] }));
  gitIn(parentRoot, "add", "--all"); gitIn(parentRoot, "commit", "-qm", "Parent declares a plumbing path as stock");
  await shootOffshoot({ destination: child, source: await loadOffshootSource(parentRoot, { sourceId: runnerSourceId }), systemId: "example/child" });
  assert.deepEqual(Object.keys((await readJson(child, ".timds/parent.json")).files), ["src/pages/brand/color.html"]);
  gitIn(child, "config", "user.email", "test@example.com"); gitIn(child, "config", "user.name", "Test");
  gitIn(child, "add", "--all"); gitIn(child, "commit", "-qm", "Child");
  const childChrome = await read(child, "src/styles/viewer.css");
  await write(parentRoot, "src/styles/viewer.css", `${await read(parentRoot, "src/styles/viewer.css")}\n/* the parent's chrome */\n`);
  gitIn(parentRoot, "add", "--all"); gitIn(parentRoot, "commit", "-qm", "Parent changes its chrome");
  const report = await runFeed(["--root", child, "--from", parentRoot, "--source-id", runnerSourceId, "--json"]);
  assert.deepEqual(report.stock.find((entry) => entry.path === "src/styles/viewer.css"), { path: "src/styles/viewer.css", status: "skipped", note: "toolkit plumbing: the parent declares it as stock, but feed never writes plumbing (only upgrade does), so it was not fed" });
  assert.equal(await read(child, "src/styles/viewer.css"), childChrome);
  assert.deepEqual(Object.keys((await readJson(child, ".timds/parent.json")).files), ["src/pages/brand/color.html"]);
});

test("shoot refuses a parent below the starter floor without touching it, stale aggregates included", async (t) => {
  const { parentRoot, directory } = await (async () => { const fixture = await runnerFixture(t); return { ...fixture, directory: path.dirname(fixture.parentRoot) }; })();
  const record = await readJson(parentRoot, ".timds/starter.json");
  delete record.level;
  await write(parentRoot, ".timds/starter.json", json(record));
  await staleAggregates(parentRoot);
  gitIn(parentRoot, "add", "--all"); gitIn(parentRoot, "commit", "-qm", "A parent from before starter levels");
  const cliDestination = path.join(directory, "cli-child");
  await assert.rejects(runWithOutputSink(() => {}, () => runCli(["shoot", parentRoot, "--system-id", "example/cli-child", "--source-id", runnerSourceId, "--root", cliDestination])), belowFloor);
  await assert.rejects(fs.access(cliDestination), { code: "ENOENT" });
  cleanTree(parentRoot, "shoot from a below-floor parent");
  const source = await loadOffshootSource(parentRoot, { sourceId: runnerSourceId });
  const destination = path.join(directory, "too-old-child");
  await assert.rejects(shootOffshoot({ destination, source, systemId: "example/too-old" }), (error) => error.failureCode === "below_floor");
  await assert.rejects(fs.access(destination), { code: "ENOENT" });
});

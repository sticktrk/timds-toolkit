import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { feedOffshoot, describeFeed } from "./feed.mjs";
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

async function fixture(t, { plumbing = "toolkit", mode = "full", git = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "timds-feed-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const baselineSite = mode === "full" ? structuredClone(site) : { views: [{ id: "web", label: "Web DS", pages: [{ slug: "", title: "Overview", planned: true }] }] };
  const parent = { schemaVersion: 1, ...identity, mode, baseline: { site: baselineSite, formats } };
  const texts = {
    ".timds/parent.json": json(parent),
    ".timds/starter.json": json({ schemaVersion: 1, version: "0.1.0", plumbing, baseline: { site: { views: [] }, formats: {} }, files: { "scripts/build.mjs": hash(script), "src/pages/web/index.html": hash("<h1>Child</h1>\n") } }),
    "src/site.json": json(baselineSite), "src/formats.json": json(formats),
    "scripts/build.mjs": script, "src/pages/web/index.html": "<h1>Child</h1>\n",
    "src/layout.html": "<main>{{content}}</main>\n", "src/styles/system.css": ".child {}\n",
    "tokens.json": '{"color":{"brand":{"value":"red"}}}\n', "media.json": '{"schemaVersion":2,"assets":[]}\n',
  };
  for (const [file, text] of Object.entries(texts)) await write(root, file, text);
  if (git) {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "Fixture"], { cwd: root });
  }
  return { root, parent, texts };
}

function nextSource({ version = "1.1.0", commit = "2".repeat(40), build = nextScript } = {}) {
  const nextSite = structuredClone(site);
  Object.assign(nextSite.views[0], { label: "Web System", blurb: "Interfaces and email" });
  nextSite.views[0].pages[0].title = "Web overview";
  nextSite.views[0].pages.push({ slug: "buttons", title: "Buttons", summary: "Parent copy" });
  const nextFormats = structuredClone(formats);
  Object.assign(nextFormats.web.formats.screen, { name: "Interface screen", width: 1200 });
  return { parent: { ...identity, version, commit }, files: [
    sourceFile("timds.json", json({ systemId: identity.systemId, version })), sourceFile("src/site.json", json(nextSite)), sourceFile("src/formats.json", json(nextFormats)),
    sourceFile(".timds/starter.json", json({ schemaVersion: 1, plumbing: "toolkit", version: "0.1.1", files: { "scripts/build.mjs": hash(build), "src/pages/web/index.html": hash("<h1>Parent</h1>\n") } })),
    sourceFile("scripts/build.mjs", build), sourceFile("src/pages/web/index.html", "<h1>Parent</h1>\n"),
    sourceFile("src/pages/web/buttons.html", "<h1>Parent button</h1>\n"),
    sourceFile("src/styles/system.css", ".parent {}\n"), sourceFile("src/layout.html", "<body>Parent</body>\n"),
    sourceFile("tokens.json", "{}\n"),
  ] };
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
  assert.equal(await read(root, "scripts/build.mjs"), nextScript);
  assert.equal((await readJson(root, ".timds/parent.json")).version, "1.1.0");
  for (const file of ["src/pages/web/index.html", "src/layout.html", "src/styles/system.css", "tokens.json", "media.json"]) assert.equal(await read(root, file), texts[file], file);
  await assert.rejects(fs.access(path.join(root, "src/pages/web/buttons.html")), { code: "ENOENT" });
  assert.deepEqual((await readJson(root, ".timds/starter.json")).baseline, { site: { views: [] }, formats: {} }, "the seed baseline stays separate");
  assert.match(describeFeed(report).join("\n"), /Your graft shades the parent's change at web.label/);
  const again = await feedOffshoot({ designSystemRoot: root, source, check: async () => { throw new Error("must not check an unchanged feed"); } });
  assert.deepEqual(again.written, []);
  assert.deepEqual(again.site.kept, []);
  assert.deepEqual(again.formats.kept, []);
});

test("structure feed retains neutral structure catalogs without parent prose or bodies", async (t) => {
  const { root } = await fixture(t, { mode: "structure" });
  const report = await feedOffshoot({ designSystemRoot: root, source: nextSource() });
  const actual = await readJson(root, "src/site.json");
  assert.deepEqual(actual.views[0], { id: "web", label: "Web System", pages: [{ slug: "", title: "Web overview", planned: true }, { slug: "buttons", title: "Buttons", planned: true }] });
  assert.equal(JSON.stringify((await readJson(root, ".timds/parent.json")).baseline).includes("Parent copy"), false);
  assert.equal(report.parent.mode, "structure");
});

test("feed preserves recorded plumbing grafts unless explicitly named, while toolkit plumbing advances", async (t) => {
  const { root } = await fixture(t, { plumbing: "recorded" });
  await write(root, "scripts/build.mjs", "// child's engine change\n");
  const source = nextSource();
  const kept = await feedOffshoot({ designSystemRoot: root, source });
  assert.equal(kept.files.find((file) => file.path === "scripts/build.mjs").status, "customized");
  assert.equal(await read(root, "scripts/build.mjs"), "// child's engine change\n");
  await assert.rejects(feedOffshoot({ designSystemRoot: root, source, force: ["src/pages/web/index.html"] }), /authored content is never replaced/);
  await feedOffshoot({ designSystemRoot: root, source, force: ["scripts/build.mjs"] });
  assert.equal(await read(root, "scripts/build.mjs"), nextScript);
  const { root: owned } = await fixture(t);
  await write(owned, "scripts/build.mjs", "// local toolkit change\n");
  const updated = await feedOffshoot({ designSystemRoot: owned, source });
  assert.match(updated.files.find((file) => file.path === "scripts/build.mjs").note, /local change was replaced/);
  assert.equal(await read(owned, "scripts/build.mjs"), nextScript);
});

test("full feed keeps unverified parent plumbing authored while feeding catalogs, even with force", async (t) => {
  const { root } = await fixture(t);
  const authored = "// full child's authored engine\n";
  await write(root, "scripts/build.mjs", authored);
  const source = nextSource();
  source.files.find((file) => file.path === "scripts/build.mjs").content = Buffer.from("// parent's authored engine\n").toString("base64");
  const report = await feedOffshoot({ designSystemRoot: root, source });
  assert.equal(await read(root, "scripts/build.mjs"), authored);
  assert.equal((await readJson(root, "src/formats.json")).web.formats.screen.width, 1200);
  assert.equal((await readJson(root, ".timds/parent.json")).version, "1.1.0");
  assert.match(report.files.find((file) => file.path === "scripts/build.mjs").note, /parent's authored plumbing; never copied/);
  const before = await read(root, ".timds/parent.json");
  await assert.rejects(feedOffshoot({ designSystemRoot: root, source, force: ["scripts/build.mjs"] }), /--force cannot replace authored parent plumbing/);
  assert.equal(await read(root, "scripts/build.mjs"), authored);
  assert.equal(await read(root, ".timds/parent.json"), before);
});

test("failed feed restores all source files and both records", async (t) => {
  const { root, texts } = await fixture(t);
  await assert.rejects(feedOffshoot({ designSystemRoot: root, source: nextSource(), check: async () => { throw new Error("fixture build failed"); } }), /Feed was rolled back.*fixture build failed/);
  for (const [file, text] of Object.entries(texts)) assert.equal(await read(root, file), text, file);
});

test("feed preserves source plumbing executable modes and rolls mode changes back with the check", async (t) => {
  const { root, texts } = await fixture(t);
  const source = nextSource();
  source.files.find((file) => file.path === "scripts/build.mjs").mode = "100755";
  const stock = source.files.find((file) => file.path === ".timds/starter.json");
  const record = JSON.parse(Buffer.from(stock.content, "base64").toString());
  record.files["scripts/task.mjs"] = hash("#!/usr/bin/env node\n");
  stock.content = Buffer.from(json(record)).toString("base64");
  source.files.push(sourceFile("scripts/task.mjs", "#!/usr/bin/env node\n", "100755"));
  await assert.rejects(feedOffshoot({ designSystemRoot: root, source, check: async () => { throw new Error("failed mode check"); } }), /rolled back.*failed mode check/);
  assert.equal((await fs.stat(path.join(root, "scripts/build.mjs"))).mode & 0o777, 0o644);
  assert.equal(await read(root, "scripts/build.mjs"), texts["scripts/build.mjs"]);
  await assert.rejects(fs.access(path.join(root, "scripts/task.mjs")), { code: "ENOENT" });
  await feedOffshoot({ designSystemRoot: root, source });
  for (const file of ["scripts/build.mjs", "scripts/task.mjs"]) assert.equal((await fs.stat(path.join(root, file))).mode & 0o777, 0o755, file);
  const next = nextSource({ version: "1.2.0", commit: "3".repeat(40) });
  // The script bytes are unchanged; a regular/executable transition still feeds.
  await feedOffshoot({ designSystemRoot: root, source: next });
  assert.equal((await fs.stat(path.join(root, "scripts/build.mjs"))).mode & 0o777, 0o644);
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

test("feed refuses dirty writes, mismatched identity, corrupt parent plumbing and symlink targets", async (t) => {
  const { root, texts } = await fixture(t, { git: true, mode: "structure" });
  await write(root, "src/site.json", `${texts["src/site.json"]}\n`);
  await assert.rejects(feedOffshoot({ designSystemRoot: root, source: nextSource() }), /Feed refuses to run over uncommitted changes/);
  assert.equal(await read(root, "scripts/build.mjs"), script);
  await write(root, "src/site.json", texts["src/site.json"]);
  const mismatch = nextSource(); mismatch.parent.sourceId = "00000000-0000-4000-8000-000000000002";
  await assert.rejects(feedOffshoot({ designSystemRoot: root, source: mismatch }), /different parent system or source/);
  const corrupt = nextSource(); corrupt.files.find((file) => file.path === "scripts/build.mjs").content = Buffer.from("unrecorded engine").toString("base64");
  await assert.rejects(feedOffshoot({ designSystemRoot: root, source: corrupt }), /customized recorded plumbing/);
  await fs.rm(path.join(root, "scripts/build.mjs"));
  await fs.symlink("../tokens.json", path.join(root, "scripts/build.mjs"));
  await assert.rejects(feedOffshoot({ designSystemRoot: root, source: nextSource() }), /cannot write through a symbolic link/);
  assert.equal(await read(root, "tokens.json"), texts["tokens.json"]);
});

test("feed checks prospective dirty writes before customization prompts and ignores unrelated authored edits", async (t) => {
  const { root, texts } = await fixture(t, { git: true, plumbing: "recorded" });
  await write(root, "scripts/build.mjs", "// committed child engine\n");
  execFileSync("git", ["add", "scripts/build.mjs"], { cwd: root });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "Customize engine"], { cwd: root });
  await write(root, "src/site.json", `${texts["src/site.json"]}\n`);
  let prompts = 0;
  const decideCustomized = async () => { prompts++; return "replace"; };
  await assert.rejects(feedOffshoot({ designSystemRoot: root, source: nextSource(), decideCustomized }), /Feed refuses to run over uncommitted changes/);
  assert.equal(prompts, 0);
  assert.equal(await read(root, "scripts/build.mjs"), "// committed child engine\n");
  assert.equal(await read(root, ".timds/parent.json"), texts[".timds/parent.json"]);
  await write(root, "src/site.json", texts["src/site.json"]);
  await write(root, "src/pages/web/index.html", "<h1>Uncommitted authored page</h1>\n");
  const report = await feedOffshoot({ designSystemRoot: root, source: nextSource(), decideCustomized });
  assert.equal(prompts, 1);
  assert.equal(await read(root, "scripts/build.mjs"), nextScript);
  assert.equal(await read(root, "src/pages/web/index.html"), "<h1>Uncommitted authored page</h1>\n");
  assert.equal((await readJson(root, ".timds/starter.json")).files["scripts/build.mjs"], hash(nextScript));
  assert.equal(report.files.filter((file) => file.path === "scripts/build.mjs").length, 1);
});

test("feed rechecks dirty writes after a customization decision", async (t) => {
  const { root, texts } = await fixture(t, { git: true, plumbing: "recorded" });
  await write(root, "scripts/build.mjs", "// committed child engine\n");
  execFileSync("git", ["add", "scripts/build.mjs"], { cwd: root });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "Customize engine"], { cwd: root });
  await assert.rejects(feedOffshoot({ designSystemRoot: root, source: nextSource(), decideCustomized: async () => {
    await write(root, "src/site.json", `${texts["src/site.json"]}\n`);
    return "replace";
  } }), /Feed refuses to run over uncommitted changes/);
  assert.equal(await read(root, "scripts/build.mjs"), "// committed child engine\n");
  assert.equal(await read(root, ".timds/parent.json"), texts[".timds/parent.json"]);
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

test("offshoot starter sync maintains layout plumbing links and version chip with full rollback", async (t) => {
  const { root, texts } = await fixture(t);
  const layout = '<!doctype html>\n<head>\n<link rel="stylesheet" href="/styles/viewer.css">\n</head>\n<body><header>Child shell</header><span class="appbar__version">v{{version}}</span><main>{{content}}</main></body>\n';
  await write(root, "src/layout.html", layout);
  await assert.rejects(syncStarter({ designSystemRoot: root, version: "0.1.999", check: async () => { throw new Error("layout build failed"); } }), /rolled back.*layout build failed/);
  assert.equal(await read(root, "src/layout.html"), layout);
  assert.equal(await read(root, ".timds/starter.json"), texts[".timds/starter.json"]);
  const report = await syncStarter({ designSystemRoot: root, version: "0.1.999" });
  const updated = await read(root, "src/layout.html");
  assert.match(updated, /<link rel="stylesheet" href="\/styles\/canvas\.css">/);
  assert.match(updated, /<a class="appbar__version" href="\/changelog\/" title="Changelog">v\{\{version\}\}<\/a>/);
  assert.match(updated, /<header>Child shell<\/header>/);
  assert.ok(report.written.includes("src/layout.html"));
  for (const file of [".timds/parent.json", "src/site.json", "src/formats.json", "src/pages/web/index.html"]) assert.equal(await read(root, file), texts[file], file);
  assert.deepEqual((await readJson(root, ".timds/starter.json")).baseline, JSON.parse(texts[".timds/starter.json"]).baseline);
  await assert.rejects(fs.access(path.join(root, "src/pages/use/index.html")), { code: "ENOENT" });
});

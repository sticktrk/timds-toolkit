// Starter levels end to end. This release declares no step (level 1, floor
// 1), so the interpreter and the command path are proven with test-only
// steps in their published JSON form, put in effect through
// `withStarterDefinition`, which no CLI flag or environment variable reaches.
// Also: the stub scripts in every resolution mode, the build's declared
// extension point, and check's warnings.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkWorkspace, initializeRepository, runCli, runWithOutputSink, upgradeRepository, validateManifest, workspaceCommandEnvironment } from "./core.mjs";
import { describeToolkitRelease, renderToolkitManagedFiles } from "./release-metadata.mjs";
import { runStarterSteps, validateStarterSteps } from "./starter-steps.mjs";
import { describeStarterSteps, readStarterRecord, syncStarter, withStarterDefinition } from "./starter.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const quiet = (task) => runWithOutputSink(() => {}, task);
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const legacyScript = "// a script an earlier release shipped\n";

/**
 * Three test steps above the floor, in the release metadata's JSON shape,
 * covering every operation and every requirement: a code step that retires a
 * file, a defaults step that moves two Use page fields while the Use page is
 * stock, and a visible, declinable defaults step that sets `home`.
 */
const definition = Object.freeze({
  level: 4,
  floor: 1,
  steps: [
    { level: 2, id: "retire-legacy-script", layer: "code", visible: false, declinable: false,
      starters: ["starter", "brand-kit"],
      requires: [],
      operations: [{ op: "remove-file", path: "src/scripts/legacy.js", sha256: [sha256(legacyScript)] }] },
    { level: 3, id: "retitle-use", layer: "defaults", visible: false, declinable: false,
      starters: ["starter"],
      requires: [{ check: "stock-file", path: "src/pages/use/index.html" }],
      operations: [
        { op: "set-page-field", page: "use", field: "title", value: "Begin", from: ["Start"] },
        { op: "set-page-field", page: "use", field: "group", value: "Front", from: [null] },
      ] },
    { level: 4, id: "home-landing", layer: "defaults", visible: true, declinable: true,
      starters: ["starter"],
      requires: [
        { check: "authored-page", page: "use" },
        { check: "page-field", page: "use", field: "layout", equals: "landing" },
      ],
      operations: [{ op: "set-site-field", field: "home", value: "use", from: [null] }] },
  ],
});
const steps = JSON.parse(JSON.stringify(definition.steps));
const levels = (definitionToUse = definition) => (task) => withStarterDefinition(definitionToUse, task);
const withSteps = levels();

async function scaffold(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "timds-levels-")));
  t.after(() => fs.rm(root, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 }));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "levels@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Levels Test"], { cwd: root });
  await quiet(() => initializeRepository(root, { standalone: true, ...options }));
  const read = (relative) => fs.readFile(path.join(root, relative), "utf8");
  const write = async (relative, text) => { await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await fs.writeFile(path.join(root, relative), text); };
  const commit = (message) => { execFileSync("git", ["add", "--all"], { cwd: root }); execFileSync("git", ["commit", "-q", "--allow-empty", "-m", message], { cwd: root }); };
  const exists = (relative) => fs.access(path.join(root, relative)).then(() => true, () => false);
  const site = async () => JSON.parse(await read("src/site.json"));
  const editSite = async (edit) => { const value = await site(); edit(value); await write("src/site.json", json(value)); };
  commit("Scaffold");
  return { root, read, write, commit, exists, site, editSite };
}

/** A fresh level-1 scaffold the test steps have work on: the retired script at its listed bytes and, optionally, no home. */
async function behind(t, { home = true, options = {} } = {}) {
  const system = await scaffold(t, options);
  await system.write("src/scripts/legacy.js", legacyScript);
  if (!home) await system.editSite((value) => { delete value.home; });
  system.commit("A system the test steps are ahead of");
  return system;
}

const usePage = (value) => value.views.find((view) => view.id === "use").pages.find((page) => !page.slug);
const outcomes = (run) => run.results.map((result) => [result.step, result.outcome]);
async function captureJson(argv) {
  const lines = [];
  await runWithOutputSink((line) => lines.push(line), () => runCli(argv));
  return JSON.parse(lines.join("\n"));
}

/** An interpreter state over a fresh scaffold's tree, with this release's rendered managed bytes as stock. */
async function interpreterState(system, kind = "starter") {
  const rendered = await renderToolkitManagedFiles({ starter: kind });
  const stock = new Map(rendered.files.map((file) => [file.path, Buffer.from(file.content)]));
  return {
    site: await system.site(),
    read: (relative) => { try { return readFileSync(path.join(system.root, relative)); } catch { return null; } },
    stock: (relative) => stock.get(relative) ?? null,
  };
}

test("this release is level 1 and floor 1 with no steps, published in the contract's shape", async () => {
  for (const starter of ["starter", "brand-kit"]) {
    const release = await describeToolkitRelease({ starter });
    assert.equal(release.starter, starter, "the starter field keeps naming the selected kind");
    assert.deepEqual(release.starterSteps, { level: 1, floor: 1, steps: [] });
  }
  const rendered = await renderToolkitManagedFiles();
  for (const relative of ["scripts/build.mjs", "scripts/check.mjs", "scripts/dev.mjs"]) assert.equal(rendered.files.find((file) => file.path === relative).policy, "starter-plumbing", relative);
  assert.equal(rendered.files.find((file) => file.path === "src/pages/use/index.html").policy, "stock-fragment");
  assert.ok(!rendered.files.some((file) => ["scripts/viewer.mjs", "scripts/brand-kit.mjs"].includes(file.path)));
  const pkg = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal(pkg.hostContract, 2);
  assert.equal(pkg.exports["./viewer"], "./src/viewer.mjs");
  // The test definition is published the same way while it is in effect, and only then.
  assert.deepEqual(await withSteps(() => describeToolkitRelease()).then((release) => release.starterSteps), JSON.parse(JSON.stringify(definition)));
  assert.deepEqual(describeStarterSteps(), { level: 1, floor: 1, steps: [] });
  // Declared steps cover floor + 1 through level, with exactly the contract's keys.
  assert.throws(() => validateStarterSteps(steps.slice(1), { floor: 1, level: 4 }), /2 steps from 2 to 4|3 steps from 2 to 4/);
  assert.throws(() => validateStarterSteps(steps, { floor: 2, level: 5 }), /must have level 3/);
  assert.throws(() => validateStarterSteps([{ ...steps[0], extra: true }, ...steps.slice(1)], { floor: 1, level: 4 }), /must have exactly level, id, layer/);
  assert.throws(() => validateStarterSteps([{ ...steps[0], operations: [{ op: "move-file", path: "x" }] }, ...steps.slice(1)], { floor: 1, level: 4 }), /exactly|unknown operation/);
  assert.throws(() => validateStarterSteps([steps[0], { ...steps[1], operations: [{ op: "set-page-field", page: "use", field: "slug", value: "x", from: [null] }] }, steps[2]], { floor: 1, level: 4 }), /may not set a page's slug/);
  assert.throws(() => validateStarterSteps([steps[0], steps[1], { ...steps[2], operations: [{ op: "set-site-field", field: "home", value: null, from: [null] }] }], { floor: 1, level: 4 }), /never clears a field/);
});

test("the interpreter, from the steps' JSON, follows the six outcome rules for every operation and requirement", async (t) => {
  const system = await behind(t, { home: false });
  const state = await interpreterState(system);

  // Rules 2 and 5: effective operations of a step that is not visible apply; rule 6: a visible one stops, pending.
  const upgrade = runStarterSteps(steps, state, { level: 1 });
  assert.deepEqual(outcomes(upgrade), [["retire-legacy-script", "applied"], ["retitle-use", "applied"], ["home-landing", "pending"]]);
  assert.deepEqual([upgrade.level, upgrade.stopped, upgrade.remove], [3, { step: "home-landing", reason: "visible" }, ["src/scripts/legacy.js"]]);
  assert.deepEqual([usePage(upgrade.site).title, usePage(upgrade.site).group, upgrade.site.home], ["Begin", "Front", undefined]);
  assert.deepEqual(upgrade.results[1].changes, [{ op: "set-page-field", field: "use.title", from: "Start", to: "Begin" }, { op: "set-page-field", field: "use.group", from: null, to: "Front" }]);
  // Rule 6: accepted, it applies; declined, it settles as declined with nothing written.
  const accepted = runStarterSteps(steps, state, { level: 1, accept: new Set(["home-landing"]) });
  assert.deepEqual([accepted.level, outcomes(accepted).at(-1), accepted.site.home], [4, ["home-landing", "applied"], "use"]);
  const declined = runStarterSteps(steps, state, { level: 1, declined: ["home-landing"] });
  assert.deepEqual([declined.level, outcomes(declined).at(-1), declined.site.home], [4, ["home-landing", "declined"], undefined]);
  // Rule 4: a visible step with nothing to change settles without a decision, and so does a removal of an absent file.
  const settled = runStarterSteps(steps, { ...state, site: { ...state.site, home: "brand" }, read: (relative) => (relative === "src/scripts/legacy.js" ? null : state.read(relative)) }, { level: 1 });
  assert.deepEqual([settled.level, outcomes(settled), settled.results[0].changes, settled.results[2].kept], [4, [["retire-legacy-script", "applied"], ["retitle-use", "applied"], ["home-landing", "applied"]], [], [{ op: "set-site-field", field: "home", current: "brand", value: "use" }]]);
  // Rule 2: a field holding another value is kept and reported, and the step still settles.
  const own = structuredClone(state.site);
  usePage(own).title = "Our front door";
  const kept = runStarterSteps(steps, { ...state, site: own }, { level: 1, accept: new Set(["home-landing"]) });
  assert.deepEqual([kept.level, usePage(kept.site).title, usePage(kept.site).group, kept.results[1].kept.map((entry) => entry.field)], [4, "Our front door", "Front", ["use.title"]]);
  // Rule 3: a file to remove holding other bytes is the only conflict; the level stops below it.
  const customized = runStarterSteps(steps, { ...state, read: (relative) => (relative === "src/scripts/legacy.js" ? Buffer.from("// ours\n") : state.read(relative)) }, { level: 1, accept: new Set(["home-landing"]) });
  assert.deepEqual([customized.level, customized.stopped, customized.conflicts, customized.remove], [1, { step: "retire-legacy-script", reason: "conflict" }, [{ step: "retire-legacy-script", path: "src/scripts/legacy.js", reason: "customized" }], []]);
  const forced = runStarterSteps(steps, { ...state, read: (relative) => (relative === "src/scripts/legacy.js" ? Buffer.from("// ours\n") : state.read(relative)) }, { level: 1, force: new Set(["src/scripts/legacy.js"]) });
  assert.deepEqual([forced.remove, forced.results[0].changes], [["src/scripts/legacy.js"], [{ op: "remove-file", path: "src/scripts/legacy.js", forced: true }]]);
  // Rule 1, each requirement: a page that is not the stock bytes, a planned page, and a field that differs each skip their step unchanged.
  const notStock = runStarterSteps(steps, { ...state, read: (relative) => (relative === "src/pages/use/index.html" ? Buffer.from("<h1>Our own</h1>\n") : state.read(relative)) }, { level: 2 });
  assert.deepEqual([outcomes(notStock)[0], notStock.results[0].requirement, usePage(notStock.site).title], [["retitle-use", "skipped"], { check: "stock-file", path: "src/pages/use/index.html" }, "Start"]);
  const plannedSite = structuredClone(state.site);
  usePage(plannedSite).planned = true;
  const planned = runStarterSteps(steps, { ...state, site: plannedSite }, { level: 3 });
  assert.deepEqual([planned.level, outcomes(planned), planned.results[0].requirement.check, planned.site.home], [4, [["home-landing", "skipped"]], "authored-page", undefined]);
  const pageLayout = structuredClone(state.site);
  usePage(pageLayout).layout = "page";
  const otherLayout = runStarterSteps(steps, { ...state, site: pageLayout }, { level: 3 });
  assert.deepEqual([otherLayout.level, otherLayout.results[0].requirement.check, otherLayout.site.home], [4, "page-field", undefined]);
  // Rule 1, layers and kinds: an offshoot takes code steps only; a brand kit takes no ordinary-starter defaults step.
  for (const options of [{ offshoot: true }, { starter: "brand-kit" }]) {
    const run = runStarterSteps(steps, state, { level: 1, accept: new Set(["home-landing"]), ...options });
    assert.deepEqual([run.level, outcomes(run), run.remove, run.site.home], [4, [["retire-legacy-script", "applied"], ["retitle-use", "skipped"], ["home-landing", "skipped"]], ["src/scripts/legacy.js"], undefined], JSON.stringify(options));
  }
});

test("upgrade, starter sync and starter migrate apply the steps the interpreter computes from their JSON", async (t) => {
  const system = await behind(t, { home: false });
  const expected = runStarterSteps(steps, await interpreterState(system), { level: 1, accept: new Set(["home-landing"]) });
  // upgrade applies everything that is not visible and stops at the visible step.
  const upgraded = await withSteps(() => quiet(() => upgradeRepository(system.root)));
  assert.deepEqual(upgraded.starter.levels.steps.map((step) => [step.step, step.outcome]), [["retire-legacy-script", "applied"], ["retitle-use", "applied"], ["home-landing", "pending"]]);
  assert.equal(await system.exists("src/scripts/legacy.js"), false);
  assert.deepEqual([usePage(await system.site()).title, (await system.site()).home], ["Begin", undefined], "upgrade never applies a visible step with something to change");
  const status = await withSteps(() => captureJson(["starter", "status", "--root", system.root, "--json"]));
  assert.deepEqual(status, { starter: "starter", plumbing: "toolkit", level: 3, current: 4, floor: 1, belowFloor: false, behind: 1, pending: [{ level: 4, id: "home-landing", visible: true, declinable: true }], declined: [], conflicts: [] });
  const doctor = await withSteps(() => captureJson(["doctor", "--root", system.root, "--json"]));
  assert.deepEqual({ ...doctor.starter, state: undefined, version: undefined }, { ...status, state: undefined, version: undefined }, "doctor --json carries the same starter section");
  system.commit("Upgrade");
  const checked = await withSteps(() => quiet(() => checkWorkspace(system.root)));
  assert.ok(checked.machine.warnings.some((warning) => /home-landing \(level 4\) changes what visitors see and waits for a decision/.test(warning)), checked.machine.warnings.join("\n"));
  // starter sync, like upgrade, never accepts.
  const synced = await withSteps(() => quiet(() => runCli(["starter", "sync", "--root", system.root])));
  assert.deepEqual([synced.levels.level, synced.levels.stopped], [3, { step: "home-landing", reason: "visible" }]);
  // migrate --accept applies it; the result is the interpreter's, byte for byte in the site model.
  const migrated = await withSteps(() => captureJson(["starter", "migrate", "--accept", "home-landing", "--root", system.root, "--json"]));
  assert.deepEqual([migrated.ok, migrated.levels.level, migrated.starter.behind, migrated.starter.pending], [true, 4, 0, []]);
  assert.deepEqual(await system.site(), expected.site);
  assert.deepEqual((await readStarterRecord(system.root)).level, expected.level);
});

test("migrate --decline records the decision, and a declined or settled step reads as current", async (t) => {
  const system = await behind(t, { home: false });
  await withSteps(() => quiet(() => upgradeRepository(system.root)));
  system.commit("Upgrade");
  await assert.rejects(withSteps(() => quiet(() => runCli(["starter", "migrate", "--decline", "retitle-use", "--root", system.root]))), /cannot be declined/);
  await assert.rejects(withSteps(() => quiet(() => runCli(["starter", "migrate", "--accept", "no-such-step", "--root", system.root]))), /Unknown starter step "no-such-step"/);
  await assert.rejects(withSteps(() => quiet(() => runCli(["starter", "migrate", "--accept", "home-landing", "--decline", "home-landing", "--root", system.root]))), /both accepted and declined/);
  const declined = await withSteps(() => captureJson(["starter", "migrate", "--decline", "home-landing", "--root", system.root, "--json"]));
  assert.deepEqual([declined.starter.level, declined.starter.behind, declined.starter.declined, declined.starter.pending], [4, 0, ["home-landing"], []]);
  assert.equal((await system.site()).home, undefined);
  assert.deepEqual((await readStarterRecord(system.root)).declined, ["home-landing"]);
  system.commit("Decline");
  await assert.rejects(withSteps(() => quiet(() => runCli(["starter", "migrate", "--accept", "home-landing", "--root", system.root]))), /was declined/);

  // A system that already has home settles the visible step on upgrade with nothing changed and nothing to decide.
  const own = await behind(t);
  const upgraded = await withSteps(() => quiet(() => upgradeRepository(own.root)));
  assert.deepEqual([upgraded.starter.levels.level, upgraded.starter.levels.steps.at(-1).outcome, (await own.site()).home, upgraded.starter.status.declined], [4, "applied", "use", []]);
});

test("a conflict stops the level below its step; the brand kit and a customized Use page skip the defaults steps", async (t) => {
  const system = await behind(t);
  await system.write("src/scripts/legacy.js", "// our own\n");
  await system.write("src/pages/use/index.html", `${await system.read("src/pages/use/index.html")}\n<p>Our own words.</p>\n`);
  system.commit("Own script and Use page");
  const kept = await withSteps(() => quiet(() => upgradeRepository(system.root)));
  assert.deepEqual([kept.starter.levels.level, kept.starter.status.conflicts], [1, [{ step: "retire-legacy-script", path: "src/scripts/legacy.js", reason: "customized" }]]);
  assert.equal(await system.read("src/scripts/legacy.js"), "// our own\n");
  system.commit("Upgrade");
  const checked = await withSteps(() => quiet(() => checkWorkspace(system.root)));
  assert.ok(checked.machine.warnings.some((warning) => /Starter step retire-legacy-script cannot settle: src\/scripts\/legacy\.js is customized/.test(warning)), checked.machine.warnings.join("\n"));
  // Resolved by hand (the file removed), the next upgrade settles every step; the Use page is the system's own, so its step is skipped.
  await fs.rm(path.join(system.root, "src/scripts/legacy.js"));
  system.commit("Resolve the conflict");
  const resolved = await withSteps(() => quiet(() => upgradeRepository(system.root)));
  assert.deepEqual(resolved.starter.levels.steps.map((step) => [step.step, step.outcome]), [["retire-legacy-script", "applied"], ["retitle-use", "skipped"], ["home-landing", "applied"]]);
  assert.deepEqual([resolved.starter.levels.level, usePage(await system.site()).title], [4, "Start"]);

  const kit = await behind(t, { options: { starter: "brand-kit" } });
  const synced = await withSteps(() => quiet(() => syncStarter({ designSystemRoot: kit.root, version: "0.0.0" })));
  assert.deepEqual([synced.levels.level, synced.levels.steps.map((step) => step.outcome)], [4, ["applied", "skipped", "skipped"]]);
  assert.equal(await kit.exists("src/scripts/legacy.js"), false);
});

test("a fresh scaffold records the level in effect, and init under this release records level 1", async (t) => {
  const system = await scaffold(t);
  assert.deepEqual([(await readStarterRecord(system.root)).level, (await readStarterRecord(system.root)).declined], [1, []]);
  const ahead = await withSteps(async () => scaffold(t));
  assert.equal((await readStarterRecord(ahead.root)).level, 4);
});

test("starter migrate and status run inside a hosted session workspace", async (t) => {
  const system = await behind(t, { home: false, options: { provider: "hosted", portalUrl: "https://host.example.com" } });
  await system.write(".timds/session.json", json({ sessionId: "00000000-0000-4000-8000-000000000000" }));
  const status = await withSteps(() => captureJson(["starter", "status", "--root", system.root, "--json"]));
  assert.deepEqual([status.level, status.behind], [1, 3]);
  const migrated = await withSteps(() => captureJson(["starter", "migrate", "--accept", "home-landing", "--root", system.root, "--json"]));
  assert.deepEqual([migrated.ok, migrated.starter.level, migrated.starter.behind], [true, 4, 0]);
  assert.equal((await system.site()).home, "use");
});

test("workspace.after.build runs after the stock build in build, check and dev, and a failing command fails the build", async (t) => {
  const system = await scaffold(t);
  const manifest = JSON.parse(await system.read("timds.json"));
  const withAfter = (commands) => system.write("timds.json", json({ ...manifest, workspace: { ...manifest.workspace, after: { build: commands } } }));
  const mark = ["node", "-e", "require('fs').appendFileSync('after.log', require('fs').existsSync('dist/index.html') ? 'after-dist\\n' : 'no-dist\\n')"];
  await withAfter([mark, ["node", "-e", "require('fs').appendFileSync('after.log', 'second\\n')"]]);
  await quiet(() => checkWorkspace(system.root));
  assert.equal(await system.read("after.log"), "after-dist\nsecond\n", "in order, from the root, after the build");
  execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: system.root, env: workspaceCommandEnvironment(), stdio: "ignore" });
  assert.equal(await system.read("after.log"), "after-dist\nsecond\nafter-dist\nsecond\n");
  // dev builds, runs the commands, then serves.
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/dev.mjs"], { cwd: system.root, env: { ...workspaceCommandEnvironment(), PORT: "0" } });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; if (/Starter viewer: http/.test(out)) child.kill(); });
    child.on("exit", () => (/Running after build/.test(out) ? resolve() : reject(new Error(out))));
  });
  assert.match(await system.read("after.log"), /^(after-dist\nsecond\n){3}$/);
  await withAfter([["node", "-e", "process.exit(4)"]]);
  await assert.rejects(quiet(() => checkWorkspace(system.root)), /workspace\.after\.build command "node -e process\.exit\(4\)" failed with exit code 4/);
  assert.throws(() => validateManifest({ ...manifest, workspace: { ...manifest.workspace, after: { build: "node x" } } }), /workspace\.after\.build must be a list of commands/);
  assert.throws(() => validateManifest({ ...manifest, workspace: { ...manifest.workspace, after: { dev: [] } } }), /supports only build/);
});

test("the stub scripts resolve the renderer from an installed package without any help", async (t) => {
  const system = await scaffold(t);
  await fs.mkdir(path.join(system.root, "node_modules/@dtconcepts"), { recursive: true });
  await fs.symlink(packageRoot, path.join(system.root, "node_modules/@dtconcepts/timds"));
  const { TIMDS_VIEWER_MODULE: _unused, ...env } = process.env;
  await fs.rm(path.join(system.root, "dist"), { recursive: true, force: true });
  const out = execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: system.root, env, encoding: "utf8" });
  assert.match(out, /Built starter viewer with \d+ pages/);
  assert.match(out, /Built 2 design pages/);
  assert.match(execFileSync(process.execPath, ["scripts/check.mjs"], { cwd: system.root, env, encoding: "utf8" }), /Validated \d+ token groups/);
  // Before the first install a direct run says what is missing.
  await fs.rm(path.join(system.root, "node_modules"), { recursive: true });
  assert.throws(() => execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: system.root, env, stdio: "pipe" }), /Cannot find package '@dtconcepts\/timds'/);
});

test("check warns when a view is labelled like the viewer's own Designs link", async (t) => {
  const system = await scaffold(t);
  const site = JSON.parse(await system.read("src/site.json"));
  site.views.find((view) => view.id === "web").label = "Designs";
  await system.write("src/site.json", json(site));
  const checked = await quiet(() => checkWorkspace(system.root));
  assert.ok(checked.machine.warnings.some((warning) => /labels the view web "Designs", the same as the viewer's own Designs link/.test(warning)), checked.machine.warnings.join("\n"));
});


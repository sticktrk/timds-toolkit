// Starter levels end to end: the declared steps, the interpreter that applies
// them, the commands (upgrade, starter sync, migrate, status), check's
// warnings, the stub scripts in every resolution mode, and the build's
// declared extension point.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkWorkspace, initializeRepository, runCli, runWithOutputSink, upgradeRepository, validateManifest, workspaceCommandEnvironment } from "./core.mjs";
import { describeToolkitRelease, renderToolkitManagedFiles } from "./release-metadata.mjs";
import { runStarterSteps } from "./starter-steps.mjs";
import { STARTER_LEVEL, describeStarterSteps, readStarterRecord, starterSteps, syncStarter } from "./starter.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
// The copied renderer as the last release that copied it shipped it.
const fixtureScripts = fileURLToPath(new URL("./fixtures/starter-renderer-0.1.496/", import.meta.url));
const quiet = (task) => runWithOutputSink(() => {}, task);
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const earlierSummary = "Make a post, an ad, or an email on brand in a chat, then every way in: the pages, one URL for any AI tool, the machine-readable layer, MCP, a pinned bundle, and the website designs.";

async function scaffold(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "timds-levels-")));
  t.after(() => fs.rm(root, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 }));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "levels@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Levels Test"], { cwd: root });
  await quiet(() => initializeRepository(root, { standalone: true, ...options }));
  const read = (relative) => fs.readFile(path.join(root, relative), "utf8");
  const write = async (relative, text) => { await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await fs.writeFile(path.join(root, relative), text); };
  const commit = (message) => { execFileSync("git", ["add", "--all"], { cwd: root }); execFileSync("git", ["commit", "-qm", message], { cwd: root }); };
  const exists = (relative) => fs.access(path.join(root, relative)).then(() => true, () => false);
  return { root, read, write, commit, exists };
}

/**
 * Rewind a fresh scaffold to a system a release before starter levels left:
 * no level in its record, its copied renderer at released bytes, and the Use
 * view's own page still titled "Compose" without the landing layout or home.
 */
async function rewindToLevelZero(system, { home = undefined, title = "Compose", summary = earlierSummary } = {}) {
  const record = JSON.parse(await system.read(".timds/starter.json"));
  delete record.level;
  delete record.declined;
  record.plumbing = "recorded";
  await system.write(".timds/starter.json", json(record));
  for (const name of ["build", "check", "dev", "viewer", "brand-kit"]) await fs.copyFile(path.join(fixtureScripts, `${name}.mjs`), path.join(system.root, "scripts", `${name}.mjs`));
  const site = JSON.parse(await system.read("src/site.json"));
  if (home === undefined) delete site.home; else site.home = home;
  const use = site.views.find((view) => view.id === "use").pages.find((page) => !page.slug);
  use.title = title;
  use.summary = summary;
  delete use.layout;
  // The starter's own serializer, so the sync's merge has nothing to reformat.
  const { formatSiteJson } = await import("./starter.mjs");
  await system.write("src/site.json", formatSiteJson(site));
  system.commit("A system from before starter levels");
}

const usePage = (site) => site.views.find((view) => view.id === "use").pages.find((page) => !page.slug);

test("the release metadata publishes exactly the steps the toolkit applies, in the contract's shape", async () => {
  for (const starter of ["starter", "brand-kit"]) {
    const release = await describeToolkitRelease({ starter });
    assert.equal(release.starter, starter, "the starter field keeps naming the selected kind");
    assert.deepEqual(release.starterSteps, JSON.parse(JSON.stringify({ level: STARTER_LEVEL, floor: 0, steps: starterSteps })));
    assert.equal(release.starterSteps.steps.length, release.starterSteps.level);
    release.starterSteps.steps.forEach((step, index) => {
      assert.equal(step.level, index + 1);
      assert.deepEqual(Object.keys(step), ["level", "id", "layer", "visible", "declinable", "starters", "requires", "operations"]);
    });
  }
  const steps = describeStarterSteps().steps;
  assert.deepEqual(steps.map((step) => [step.id, step.layer, step.visible, step.declinable]), [["renderer-package", "code", false, false], ["use-start-title", "defaults", false, false], ["home-landing", "defaults", true, true]]);
  // Step 2 moves the Use page to the values the stock site model has now.
  const stock = usePage(JSON.parse(readFileSync(path.join(packageRoot, "templates/starter/src/site.json"), "utf8")));
  for (const operation of steps[1].operations) assert.equal(operation.value, stock[operation.field], operation.field);
  // Every released copy of the retired renderer is removable, the last one included.
  const removals = Object.fromEntries(steps[0].operations.map((operation) => [operation.path, operation.sha256]));
  assert.ok(removals["scripts/viewer.mjs"].includes("f9e15c77e9593279402ae2554c1ece963af8688f944cada74c5144a701b04737"));
  assert.ok(removals["scripts/brand-kit.mjs"].includes("89b43dd0a1dc5e2a6c8ef598b9ae0581ceb37bd554754aeff942b048e0b12965"));
  // The host vouches stock-file from the rendered managed set.
  const rendered = await renderToolkitManagedFiles();
  for (const relative of ["scripts/build.mjs", "scripts/check.mjs", "scripts/dev.mjs"]) assert.equal(rendered.files.find((file) => file.path === relative).policy, "starter-plumbing", relative);
  assert.equal(rendered.files.find((file) => file.path === "src/pages/use/index.html").policy, "stock-fragment");
  // An offshoot takes code steps only; a kit takes no defaults step. Both settle them as skipped.
  const empty = { site: { views: [] }, read: () => null, stock: () => null };
  for (const options of [{ offshoot: true }, { starter: "brand-kit" }]) {
    const run = runStarterSteps(steps, empty, { accept: new Set(["home-landing"]), ...options });
    assert.deepEqual([run.level, run.results.map((result) => result.outcome)], [3, ["applied", "skipped", "skipped"]], JSON.stringify(options));
  }
  const pkg = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal(pkg.hostContract, 2);
  assert.equal(pkg.exports["./viewer"], "./src/viewer.mjs");
});

test("every declared step, run from its published JSON by the interpreter, gives what the command path writes", async (t) => {
  const system = await scaffold(t, { name: "Interpreter" });
  await rewindToLevelZero(system);
  const release = JSON.parse(JSON.stringify(await describeToolkitRelease()));
  const rendered = await renderToolkitManagedFiles();
  const stockBytes = new Map(rendered.files.map((file) => [file.path, Buffer.from(file.content)]));
  const state = {
    site: JSON.parse(await system.read("src/site.json")),
    read: (relative) => { try { return readFileSync(path.join(system.root, relative)); } catch { return null; } },
    stock: (relative) => stockBytes.get(relative) ?? null,
  };
  const expected = runStarterSteps(release.starterSteps.steps, state, { accept: new Set(["home-landing"]) });
  assert.deepEqual(expected.results.map((result) => [result.step, result.outcome]), [["renderer-package", "applied"], ["use-start-title", "applied"], ["home-landing", "applied"]]);
  assert.deepEqual(expected.remove, ["scripts/viewer.mjs", "scripts/brand-kit.mjs"]);

  const lines = [];
  await runWithOutputSink((line) => lines.push(line), () => runCli(["starter", "migrate", "--accept", "home-landing", "--root", system.root, "--json"]));
  const report = JSON.parse(lines.join("\n"));
  assert.equal(report.ok, true);
  assert.deepEqual(JSON.parse(await system.read("src/site.json")), expected.site, "the command wrote the interpreter's site");
  for (const relative of expected.remove) assert.equal(await system.exists(relative), false, relative);
  assert.deepEqual([report.levels.level, (await readStarterRecord(system.root)).level], [expected.level, expected.level]);
  assert.deepEqual([report.starter.level, report.starter.behind, report.starter.renderer, report.starter.pending], [3, 0, "package", []]);
  assert.deepEqual(usePage(expected.site), { ...usePage(state.site), title: "Start", summary: release.starterSteps.steps[1].operations[1].value, layout: "landing" });
  assert.equal(expected.site.home, "use");
});

test("upgrade retitles a stock Use page, removes the stock copied renderer with the same output, and stops at home-landing", async (t) => {
  const system = await scaffold(t);
  await rewindToLevelZero(system);
  const before = await quiet(() => checkWorkspace(system.root));
  const builtBefore = await system.read("dist/brand/color/index.html");
  const statusBefore = JSON.parse(await captureJson(["starter", "status", "--root", system.root, "--json"]));
  assert.deepEqual([statusBefore.level, statusBefore.behind, statusBefore.renderer, statusBefore.pending.map((step) => step.id)], [0, 3, "copied", ["renderer-package", "use-start-title", "home-landing"]]);
  assert.ok(before.machine.warnings.some((warning) => /timds upgrade or timds starter sync settles renderer-package, use-start-title/.test(warning)), before.machine.warnings.join("\n"));

  const upgraded = await quiet(() => upgradeRepository(system.root));
  assert.deepEqual(upgraded.starter.levels.steps.map((step) => [step.step, step.outcome]), [["renderer-package", "applied"], ["use-start-title", "applied"], ["home-landing", "pending"]]);
  const site = JSON.parse(await system.read("src/site.json"));
  assert.deepEqual([usePage(site).title, usePage(site).layout, site.home], ["Start", "landing", undefined], "upgrade never sets home");
  assert.equal(await system.exists("scripts/viewer.mjs"), false);
  assert.equal(await system.read("dist/brand/color/index.html"), builtBefore, "the package renderer builds the page the copied one did");
  const status = JSON.parse(await captureJson(["starter", "status", "--root", system.root, "--json"]));
  assert.deepEqual(status, { starter: "starter", plumbing: "recorded", level: 2, current: 3, floor: 0, behind: 1, renderer: "package", kept: [], pending: [{ level: 3, id: "home-landing", visible: true, declinable: true }], declined: [], conflicts: [] });
  const doctor = JSON.parse(await captureJson(["doctor", "--root", system.root, "--json"]));
  assert.deepEqual({ ...doctor.starter, state: undefined, version: undefined }, { ...status, state: undefined, version: undefined }, "doctor --json carries the same starter section");
  system.commit("Upgrade");
  const checked = await quiet(() => checkWorkspace(system.root));
  assert.ok(checked.machine.warnings.some((warning) => /home-landing \(level 3\) changes what visitors see and waits for a decision/.test(warning)));

  // Declining records the decision and the system reads as current.
  const declined = JSON.parse(await captureJson(["starter", "migrate", "--decline", "home-landing", "--root", system.root, "--json"]));
  assert.deepEqual([declined.starter.level, declined.starter.behind, declined.starter.declined, declined.starter.pending], [3, 0, ["home-landing"], []]);
  assert.equal(JSON.parse(await system.read("src/site.json")).home, undefined);
  assert.deepEqual((await readStarterRecord(system.root)).declined, ["home-landing"]);
  system.commit("Decline the landing as home");
  await assert.rejects(quiet(() => runCli(["starter", "migrate", "--decline", "use-start-title", "--root", system.root])), /cannot be declined/);
  await assert.rejects(quiet(() => runCli(["starter", "migrate", "--accept", "no-such-step", "--root", system.root])), /Unknown starter step "no-such-step"/);
});

test("a system's own Use title and its own home settle their steps unchanged", async (t) => {
  const system = await scaffold(t);
  await rewindToLevelZero(system, { home: "brand", title: "Our front door", summary: "Ours." });
  const synced = await quiet(() => syncStarter({ designSystemRoot: system.root, version: "0.0.0" }));
  assert.deepEqual(synced.levels.steps.map((step) => [step.step, step.outcome]), [["renderer-package", "applied"], ["use-start-title", "applied"], ["home-landing", "applied"]]);
  assert.deepEqual(synced.levels.steps[1].kept.map((kept) => kept.field), ["use.title", "use.summary"], "the authored title and summary are kept and reported");
  const site = JSON.parse(await system.read("src/site.json"));
  assert.deepEqual([usePage(site).title, usePage(site).layout, site.home], ["Our front door", "landing", "brand"]);
  assert.deepEqual([synced.status.level, synced.status.behind, synced.status.pending], [3, 0, []], "a visible step with nothing to change needs no decision");
});

test("a Use page that is the system's own skips use-start-title; a customized build keeps the renderer at level 0", async (t) => {
  const system = await scaffold(t);
  await rewindToLevelZero(system);
  await system.write("src/pages/use/index.html", `${await system.read("src/pages/use/index.html")}\n<p>Our own words.</p>\n`);
  await system.write("scripts/build.mjs", `${await system.read("scripts/build.mjs")}\n// one extra step\n`);
  system.commit("Own page and build");
  const kept = await quiet(() => syncStarter({ designSystemRoot: system.root, version: "0.0.0", check: () => checkWorkspace(system.root) }));
  assert.deepEqual(kept.written, [".timds/starter.json"].filter(() => false), "nothing of the kept renderer moves");
  const checkedKept = await quiet(() => checkWorkspace(system.root));
  assert.equal(await system.exists("scripts/viewer.mjs"), true);
  assert.match(await system.read("scripts/build.mjs"), /one extra step/);
  const status = JSON.parse(await captureJson(["starter", "status", "--root", system.root, "--json"]));
  assert.deepEqual([status.level, status.renderer, status.kept, status.conflicts], [0, "kept", ["scripts/build.mjs"], [{ step: "renderer-package", path: "scripts/build.mjs", reason: "renderer_kept" }]]);
  assert.ok(checkedKept.machine.warnings.some((warning) => /The copied renderer is kept \(scripts\/build\.mjs\)/.test(warning)), "the kept renderer still builds and checks, with a warning");
  // Once the extra step is a declared command, --force gives the build back to the package.
  system.commit("Kept");
  const forced = await quiet(() => runCli(["starter", "sync", "--force", "scripts/build.mjs", "--root", system.root]));
  assert.deepEqual(forced.levels.steps.map((step) => [step.step, step.outcome]), [["renderer-package", "applied"], ["use-start-title", "skipped"], ["home-landing", "skipped"]], "the Use page is its own, so neither defaults step applies");
  assert.equal(JSON.parse(await system.read("src/site.json")).home, undefined);
  assert.deepEqual([forced.status.level, forced.status.renderer], [3, "package"]);
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

test("starter migrate and status run inside a hosted session workspace", async (t) => {
  const system = await scaffold(t, { provider: "hosted", portalUrl: "https://host.example.com" });
  await rewindToLevelZero(system);
  await system.write(".timds/session.json", json({ sessionId: "00000000-0000-4000-8000-000000000000" }));
  const status = JSON.parse(await captureJson(["starter", "status", "--root", system.root, "--json"]));
  assert.equal(status.level, 0);
  const migrated = JSON.parse(await captureJson(["starter", "migrate", "--accept", "home-landing", "--root", system.root, "--json"]));
  assert.deepEqual([migrated.ok, migrated.starter.level, migrated.starter.behind], [true, 3, 0]);
  assert.equal(JSON.parse(await system.read("src/site.json")).home, "use");
});

async function captureJson(argv) {
  const lines = [];
  await runWithOutputSink((line) => lines.push(line), () => runCli(argv));
  return lines.join("\n");
}

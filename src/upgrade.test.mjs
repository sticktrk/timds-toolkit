import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {promises as fs} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {initializeRepository, loadWorkspace, upgradeRepository} from "./core.mjs";
import {upgradeToRelease, validateLockedRuntime} from "./upgrade.mjs";

const toolkit = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
const makeLock = (version = toolkit.version) => ({lockfileVersion: 3, packages: {
  "": {devDependencies: {"@dtconcepts/timds": "0.1.x"}},
  "node_modules/@dtconcepts/timds": {version},
  ...Object.fromEntries(Object.entries(toolkit.dependencies).filter(([name]) => ["react", "react-dom", "remotion"].includes(name) || name.startsWith("@remotion/")).map(([name, version]) => [`node_modules/${name}`, {version}])),
}});

test("the locked graph rejects duplicate and mismatched React, Remotion, and toolkit releases", () => {
  assert.equal(validateLockedRuntime(makeLock(), toolkit).toolkit, toolkit.version);
  for (const [name, version] of [["react", "18.0.0"], ["@remotion/renderer", "4.0.1"], ["@dtconcepts/timds", "0.1.0"]]) {
    const lock = makeLock(); lock.packages[`node_modules/other/node_modules/${name}`] = {version};
    assert.throws(() => validateLockedRuntime(lock, toolkit), /dependency graph.*(?:expected|multiple installations)/u);
  }
  const missing = makeLock(); delete missing.packages["node_modules/react"];
  assert.throws(() => validateLockedRuntime(missing, toolkit), /missing react/u);
  const duplicate = makeLock(); duplicate.packages["node_modules/other/node_modules/react"] = {version:toolkit.dependencies.react};
  assert.throws(() => validateLockedRuntime(duplicate, toolkit), /multiple installations/u);
});

async function repository(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "timds-upgrade-"));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  execFileSync("git", ["init", "-b", "main"], {cwd: root, stdio: "ignore"});
  execFileSync("git", ["config", "user.name", "TimDS Test"], {cwd: root});
  execFileSync("git", ["config", "user.email", "test@example.com"], {cwd: root});
  await initializeRepository(root, {standalone: true});
  await fs.writeFile(path.join(root, "package-lock.json"), JSON.stringify(makeLock()));
  execFileSync("git", ["add", "--all"], {cwd: root});
  execFileSync("git", ["commit", "-m", "Initialize"], {cwd: root, stdio: "ignore"});
  return root;
}

test("explicit dependency selection keeps the bounded line and synchronizes using the selected CLI", async (t) => {
  const root = await repository(t), workspace = await loadWorkspace(root);
  const before = await fs.readFile(workspace.manifestPath, "utf8"), calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "git") return {stdout: ""};
    if (args[0] === "view") return {stdout: JSON.stringify(toolkit)};
    if (args[0] === "install") {
      const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
      assert.equal(pkg.devDependencies[toolkit.name], toolkit.version);
      const lock = makeLock(); lock.packages[""].devDependencies[toolkit.name] = toolkit.version;
      await fs.writeFile(path.join(root, "package-lock.json"), JSON.stringify(lock));
    }
    return {stdout: ""};
  };
  const result = await upgradeToRelease(workspace, {version: toolkit.version, ownRuntime: true, run});
  assert.equal(result.version, toolkit.version);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, "package.json"))).devDependencies[toolkit.name], "0.1.x");
  assert.equal(JSON.parse(await fs.readFile(path.join(root, "package-lock.json"))).packages[""].devDependencies[toolkit.name], "0.1.x");
  assert.equal(await fs.readFile(workspace.manifestPath, "utf8"), before);
  assert.deepEqual(calls.slice(-3), [["npm", "run", "timds", "--", "upgrade"], ["npm", "run", "timds", "--", "dependencies", "check"], ["npm", "run", "timds", "--", "check"]]);
  await assert.rejects(upgradeToRelease(workspace, {version: "latest", run}), /exact stable/u);
  const shuffled = async (command, args, options) => args[0] === "view"
    ? {stdout: JSON.stringify([toolkit, {...toolkit, version:"0.1.1"}])} : run(command, args, options);
  assert.equal((await upgradeToRelease(workspace, {version:"0.1.x", run:shuffled})).version, toolkit.version);
  const failingInstall = async (command, args, options) => args[0] === "install" ? Promise.reject(new Error("Registry failed")) : run(command, args, options);
  await assert.rejects(upgradeToRelease(workspace, {version:toolkit.version, run:failingInstall}), /Registry failed/u);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, "package.json"))).devDependencies[toolkit.name], "0.1.x");
});

test("adopted automation follows package releases and preserves authored source and defaults", async (t) => {
  const root = await repository(t);
  await fs.mkdir(path.join(root, "video"));
  await fs.writeFile(path.join(root, "video", "remotion.tsx"), "// Client source\n");
  await fs.writeFile(path.join(root, ".timds", "defaults.json"), '{"overrides":["publishing.targetDefaults.shortBridge"]}\n');
  execFileSync("git", ["add", "--all"], {cwd: root});
  execFileSync("git", ["commit", "-m", "Client policy"], {cwd: root, stdio: "ignore"});
  await upgradeRepository(root, {dependencyPrs: true});
  const recordPath = path.join(root, ".timds", "installation.json");
  const record = JSON.parse(await fs.readFile(recordPath));
  assert.equal(record.dependencyAutomation, "upgrade-pr-v1");
  assert.ok(record.managedFiles[".github/workflows/timds-upgrade.yml"]);
  execFileSync("git", ["add", "--all"], {cwd: root});
  execFileSync("git", ["commit", "-m", "Adopt automation"], {cwd: root, stdio: "ignore"});
  await upgradeRepository(root);
  assert.equal(await fs.readFile(path.join(root, "video", "remotion.tsx"), "utf8"), "// Client source\n");
  assert.equal(await fs.readFile(path.join(root, ".timds", "defaults.json"), "utf8"), '{"overrides":["publishing.targetDefaults.shortBridge"]}\n');
  const workflow = path.join(root, ".github", "workflows", "timds-upgrade.yml");
  await fs.writeFile(workflow, "name: Custom\n");
  await assert.rejects(upgradeRepository(root), /Refusing to replace customized/u);
  assert.equal(await fs.readFile(workflow, "utf8"), "name: Custom\n");
});

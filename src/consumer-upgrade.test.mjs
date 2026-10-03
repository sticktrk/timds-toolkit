import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { initializeConsumer, upgradeConsumer } from "./consumer-init.mjs";
import { checkConsumer } from "./consumer.mjs";
import { runCli, runWithOutputSink } from "./core.mjs";
import { upgradeConsumerToRelease } from "./upgrade.mjs";

const toolkit = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
const releaseLine = toolkit.version.replace(/^(\d+\.\d+)\.\d+.*$/, "$1.x");
const sha256 = (content) => createHash("sha256").update(content).digest("hex");
const quiet = () => {};
const PREVIEW_WORKFLOW = ".github/workflows/timds-consumer-preview.yml";
const DESIGNER_WORKFLOW = ".github/workflows/timds-designer-change.yml";
const SKILL = ".agents/skills/timds-consume-design-system/SKILL.md";
const readTemplate = (name) => fs.readFile(new URL(`../templates/${name}`, import.meta.url), "utf8");

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "protocol.file.allow=always", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const readJson = async (filePath) => JSON.parse(await fs.readFile(filePath, "utf8"));

async function initRepo(directory) {
  await fs.mkdir(directory, { recursive: true });
  git(directory, "init", "-b", "main");
  git(directory, "config", "user.email", "timds-test@example.com");
  git(directory, "config", "user.name", "TimDS Test");
}

/** A product with one app and a real design-system submodule, adopted with `consumer init` and committed. */
async function createConsumer(t, { initialize = true, portalUrl } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "timds-consumer-upgrade-")));
  t.after(() => fs.rm(root, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 }));
  const designSystem = path.join(root, "design-system-source");
  await initRepo(designSystem);
  await writeJson(path.join(designSystem, "timds.json"), { schemaVersion: 2, systemId: "acme/core", name: "Acme", version: "1.0.0" });
  await writeJson(path.join(designSystem, "tokens.json"), {});
  git(designSystem, "add", ".");
  git(designSystem, "commit", "-m", "Release 1.0.0");

  const product = path.join(root, "product");
  await initRepo(product);
  await writeJson(path.join(product, "web", "package.json"), { name: "web", scripts: { dev: "astro dev" }, dependencies: { astro: "5.0.0" } });
  await writeJson(path.join(product, "web", "package-lock.json"), { lockfileVersion: 3 });
  await fs.mkdir(path.join(product, "web", "src", "styles"), { recursive: true });
  await fs.writeFile(path.join(product, "web", "src", "styles", "site.css"), "a {}\n", "utf8");
  git(product, "add", "web");
  git(product, "submodule", "add", "../design-system-source", "design-system");
  git(product, "commit", "-m", "Initial");
  if (initialize) {
    await initializeConsumer(product, { skipInstall: true, output: quiet, ...(portalUrl ? { portalUrl } : {}) });
    git(product, "add", "--all");
    git(product, "commit", "-m", "Adopt TimDS");
  }
  return product;
}

/** Rewind managed files to what an older release would have installed, recording their hashes as that install did. */
async function simulateOlderRelease(product, { version = "0.1.0", files = {} } = {}) {
  const installationPath = path.join(product, ".timds", "installation.json");
  const installation = await readJson(installationPath);
  for (const [relative, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(product, relative)), { recursive: true });
    await fs.writeFile(path.join(product, relative), content, "utf8");
    installation.consumer.managedFiles[relative] = sha256(content);
  }
  installation.consumer.version = version;
  await writeJson(installationPath, installation);
}

async function assertNoDesignSystemTooling(product) {
  for (const relative of [
    ".agents/skills/timds-edit-design-system",
    ".agents/skills/timds-create-video",
    ".github/workflows/timds-design-system.yml",
    ".github/workflows/timds-upgrade.yml",
    "design-system/.timds",
    "design-system/.agents",
  ]) {
    await assert.rejects(fs.access(path.join(product, relative)), `${relative} must not appear in a product repository`);
  }
}

test("upgrade refreshes unmodified managed files from the installed templates and leaves the manifest alone", async (t) => {
  const product = await createConsumer(t);
  await simulateOlderRelease(product, {
    files: {
      [PREVIEW_WORKFLOW]: "name: TimDS consumer preview (older release)\n",
      [SKILL]: "---\nname: timds-consume-design-system\n---\nOlder skill.\n",
      // A file an older release shipped and this one no longer does.
      ".agents/skills/timds-consume-design-system/retired.md": "Retired.\n",
    },
  });
  git(product, "add", "--all");
  git(product, "commit", "-m", "Older TimDS release");
  git(product, "checkout", "-b", "timds-upgrade");
  const manifestBefore = await fs.readFile(path.join(product, "timds.consumer.json"));
  const packageBefore = await fs.readFile(path.join(product, "package.json"));

  const lines = [];
  const result = await upgradeConsumer(path.join(product, "web"), { output: (line) => lines.push(line) });
  const output = lines.join("\n");
  assert.equal(result.previousVersion, "0.1.0");
  assert.equal(result.version, toolkit.version);
  assert.match(output, new RegExp(`Toolkit: 0\\.1\\.0 -> ${toolkit.version.replaceAll(".", "\\.")}`));
  assert.match(output, /refreshed \.github\/workflows\/timds-consumer-preview\.yml/);
  assert.match(output, /refreshed \.agents\/skills\/timds-consume-design-system\/SKILL\.md/);
  assert.match(output, /unchanged \.github\/workflows\/timds-designer-change\.yml/);
  assert.match(output, /removed {3}\.agents\/skills\/timds-consume-design-system\/retired\.md/);
  assert.match(output, /unchanged \.claude\/launch\.json entry "web"/);

  assert.equal(await fs.readFile(path.join(product, PREVIEW_WORKFLOW), "utf8"), await readTemplate("timds-consumer-preview.yml"));
  assert.equal(await fs.readFile(path.join(product, DESIGNER_WORKFLOW), "utf8"), await readTemplate("timds-designer-change.yml"));
  assert.match(await fs.readFile(path.join(product, SKILL), "utf8"), /### `web`/);
  await assert.rejects(fs.access(path.join(product, ".agents/skills/timds-consume-design-system/retired.md")));
  assert.deepEqual(await fs.readFile(path.join(product, "timds.consumer.json")), manifestBefore);
  assert.deepEqual(await fs.readFile(path.join(product, "package.json")), packageBefore);
  await assertNoDesignSystemTooling(product);

  const installation = (await readJson(path.join(product, ".timds", "installation.json"))).consumer;
  assert.equal(installation.version, toolkit.version);
  assert.equal(installation.managedFiles[".agents/skills/timds-consume-design-system/retired.md"], undefined);
  for (const [relative, hash] of Object.entries(installation.managedFiles)) {
    assert.equal(hash, sha256(await fs.readFile(path.join(product, relative), "utf8")), relative);
  }

  // A second run changes nothing.
  const again = await upgradeConsumer(product, { output: quiet });
  assert.ok(again.files.every((file) => file.status === "unchanged"));

  // The upgrade-shaped diff passes the consumer scope check.
  git(product, "add", "--all");
  git(product, "commit", "-m", "Upgrade TimDS");
  const checked = await checkConsumer(product, { base: "main" });
  assert.equal(checked.status, "passed", checked.errors.join("\n"));
  assert.ok(checked.changes.some((change) => change.path === PREVIEW_WORKFLOW));
  assert.ok(checked.changes.every((change) => change.status === "allowed"));
});

test("upgrade refuses a locally modified managed file unless forced", async (t) => {
  const product = await createConsumer(t);
  await simulateOlderRelease(product, { files: { [DESIGNER_WORKFLOW]: "name: older\n" } });
  const workflowPath = path.join(product, PREVIEW_WORKFLOW);
  await fs.appendFile(workflowPath, "# local tweak\n", "utf8");
  const installationBefore = await fs.readFile(path.join(product, ".timds", "installation.json"), "utf8");

  await assert.rejects(
    upgradeConsumer(product, { output: quiet }),
    /Refusing to replace customized TimDS consumer files:\n- \.github\/workflows\/timds-consumer-preview\.yml\nReview them, or rerun timds upgrade with --force/,
  );
  // Nothing was written: not the edited file, not the unmodified one, not the record.
  assert.match(await fs.readFile(workflowPath, "utf8"), /# local tweak/);
  assert.equal(await fs.readFile(path.join(product, DESIGNER_WORKFLOW), "utf8"), "name: older\n");
  assert.equal(await fs.readFile(path.join(product, ".timds", "installation.json"), "utf8"), installationBefore);

  const lines = [];
  await upgradeConsumer(product, { force: true, output: (line) => lines.push(line) });
  assert.equal(await fs.readFile(workflowPath, "utf8"), await readTemplate("timds-consumer-preview.yml"));
  assert.equal(await fs.readFile(path.join(product, DESIGNER_WORKFLOW), "utf8"), await readTemplate("timds-designer-change.yml"));
  assert.match(lines.join("\n"), /refreshed \.github\/workflows\/timds-consumer-preview\.yml/);
});

test("upgrade applies the entry rules to launch and MCP entries and keeps foreign ones", async (t) => {
  const product = await createConsumer(t, { portalUrl: "https://portal.example.test" });
  const launchPath = path.join(product, ".claude", "launch.json");
  const mcpPath = path.join(product, ".mcp.json");
  const installationPath = path.join(product, ".timds", "installation.json");

  // An older release wrote a different web entry (recorded), and the user added their own entries.
  const launch = await readJson(launchPath);
  const older = { ...launch.configurations[0], port: 9999 };
  const foreignLaunch = { name: "storybook", runtimeExecutable: "npm", runtimeArgs: ["run", "storybook"], port: 6006 };
  await writeJson(launchPath, { ...launch, configurations: [foreignLaunch, older] });
  const mcp = await readJson(mcpPath);
  const foreignServer = { command: "npx", args: ["other-mcp"] };
  await writeJson(mcpPath, { ...mcp, mcpServers: { other: foreignServer, ...mcp.mcpServers } });
  const installation = await readJson(installationPath);
  installation.consumer.launchConfigurations.web = sha256(JSON.stringify(older));
  await writeJson(installationPath, installation);

  const lines = [];
  const result = await upgradeConsumer(product, { output: (line) => lines.push(line) });
  assert.deepEqual(result.launchConfigurations, [{ name: "web", status: "refreshed" }]);
  assert.deepEqual(result.mcpServers, [{ name: "timds-design-system-read", status: "unchanged" }]);
  const refreshed = await readJson(launchPath);
  assert.deepEqual(refreshed.configurations[0], foreignLaunch);
  assert.equal(refreshed.configurations[1].port, 4321);
  // The portal the managed server already points at is kept.
  assert.equal((await readJson(mcpPath)).mcpServers["timds-design-system-read"].url, "https://portal.example.test/api/timds/mcp/read");

  // Customized entries are kept (reported as refused) without --force, replaced with it.
  refreshed.configurations[1].port = 4400;
  await writeJson(launchPath, refreshed);
  const customizedMcp = await readJson(mcpPath);
  customizedMcp.mcpServers["timds-design-system-read"].headers = { Authorization: "Bearer ${MY_TOKEN}" };
  await writeJson(mcpPath, customizedMcp);
  const keptLines = [];
  const kept = await upgradeConsumer(product, { output: (line) => keptLines.push(line) });
  assert.deepEqual(kept.launchConfigurations, [{ name: "web", status: "refused" }]);
  assert.deepEqual(kept.mcpServers, [{ name: "timds-design-system-read", status: "refused" }]);
  assert.match(keptLines.join("\n"), /refused {3}\.claude\/launch\.json entry "web" \(customized; rerun timds upgrade --force to replace it\)/);
  assert.match(keptLines.join("\n"), /refused {3}\.mcp\.json server "timds-design-system-read"/);
  assert.equal((await readJson(launchPath)).configurations[1].port, 4400);
  assert.deepEqual(await readJson(mcpPath), customizedMcp);

  await upgradeConsumer(product, { force: true, output: quiet });
  const forcedLaunch = await readJson(launchPath);
  assert.deepEqual(forcedLaunch.configurations[0], foreignLaunch);
  assert.equal(forcedLaunch.configurations[1].port, 4321);
  const forcedMcp = await readJson(mcpPath);
  assert.deepEqual(forcedMcp.mcpServers.other, foreignServer);
  assert.deepEqual(forcedMcp.mcpServers["timds-design-system-read"].headers, { Authorization: "Bearer ${TIMDS_ACCESS_TOKEN}" });
  assert.equal(forcedMcp.mcpServers["timds-design-system-read"].url, "https://portal.example.test/api/timds/mcp/read");
});

test("upgrade refuses a consumer that was never initialized", async (t) => {
  const product = await createConsumer(t, { initialize: false });
  await assert.rejects(upgradeConsumer(product, { output: quiet }), /No timds\.consumer\.json at .*Run timds consumer init/);
  await writeJson(path.join(product, "timds.consumer.json"), {
    schemaVersion: 1,
    designSystem: { path: "design-system", systemId: "acme/core" },
    apps: { web: { cwd: "web", preview: { serve: ["npm", "run", "dev"], port: 4321, routes: ["/"] }, designSurface: ["src/styles/**"] } },
  });
  await assert.rejects(upgradeConsumer(product, { output: quiet }), /no TimDS consumer installation record[\s\S]*Run timds consumer init first/);
  await assert.rejects(
    runWithOutputSink(quiet, () => runCli(["upgrade", "--root", product])),
    /no TimDS consumer installation record/,
  );
  await assert.rejects(fs.access(path.join(product, ".agents")));
  await assert.rejects(fs.access(path.join(product, ".timds")));
});

test("timds upgrade routes a consumer repository away from the design-system upgrade", async (t) => {
  const product = await createConsumer(t);
  await simulateOlderRelease(product, { files: { [PREVIEW_WORKFLOW]: "name: older\n" } });
  const lines = [];
  const result = await runWithOutputSink((line) => lines.push(line), () => runCli(["upgrade", "--root", path.join(product, "web")]));
  assert.equal(result.repoRoot, product);
  assert.match(lines.join("\n"), /TimDS consumer files upgraded for/);
  assert.match(lines.join("\n"), /refreshed \.github\/workflows\/timds-consumer-preview\.yml/);
  assert.equal(await fs.readFile(path.join(product, PREVIEW_WORKFLOW), "utf8"), await readTemplate("timds-consumer-preview.yml"));
  await assertNoDesignSystemTooling(product);

  for (const flag of ["--own-runtime", "--auto-release", "--dependency-prs"]) {
    await assert.rejects(
      runWithOutputSink(quiet, () => runCli(["upgrade", "--root", product, flag])),
      new RegExp(`${flag} applies only to Design System repositories`),
    );
  }
  await assert.rejects(
    runWithOutputSink(quiet, () => runCli(["upgrade", "--root", product, "--version", toolkit.version, "--own-runtime"])),
    /--own-runtime applies only to Design System repositories/,
  );

  await writeJson(path.join(product, "timds.json"), { schemaVersion: 2, systemId: "confused/core" });
  await assert.rejects(
    runWithOutputSink(quiet, () => runCli(["upgrade", "--root", product])),
    /has both timds\.json \(a Design System\) and timds\.consumer\.json/,
  );
  await assertNoDesignSystemTooling(product);
});

test("upgrade --version selects the release under the bounded line and refreshes with the new CLI", async (t) => {
  const product = await createConsumer(t);
  const lockPath = path.join(product, "package-lock.json");
  const packagePath = path.join(product, "package.json");
  const makeLock = (requirement, version) => ({
    lockfileVersion: 3,
    packages: { "": { devDependencies: { [toolkit.name]: requirement } }, [`node_modules/${toolkit.name}`]: { version } },
  });
  await writeJson(lockPath, makeLock(releaseLine, "0.1.0"));
  await simulateOlderRelease(product, { files: { [PREVIEW_WORKFLOW]: "name: older\n" } });
  git(product, "add", "--all");
  git(product, "commit", "-m", "Lockfile at an older release");
  const manifestBefore = await fs.readFile(path.join(product, "timds.consumer.json"));

  const calls = [];
  const run = async (command, args, options) => {
    calls.push([command, ...args]);
    assert.equal(options.cwd, product);
    if (command === "git") return { stdout: "" };
    if (args[0] === "view") return { stdout: JSON.stringify(toolkit) };
    if (args[0] === "install") {
      assert.equal((await readJson(packagePath)).devDependencies[toolkit.name], toolkit.version, "the exact release resolves first");
      await writeJson(lockPath, makeLock(toolkit.version, toolkit.version));
    }
    // The newly installed CLI's upgrade (simulated in-process).
    if (args[0] === "run" && args.includes("upgrade")) await upgradeConsumer(product, { force: args.includes("--force"), output: quiet });
    return { stdout: "" };
  };
  const result = await upgradeConsumerToRelease(product, { version: toolkit.version, run });
  assert.equal(result.version, toolkit.version);
  assert.deepEqual(calls.map((call) => call.slice(0, 3).join(" ")), [
    "git status --porcelain",
    `npm view ${toolkit.name}@${toolkit.version}`,
    "npm install --ignore-scripts",
    "npm ci",
    "npm run timds",
  ]);
  assert.deepEqual(calls.at(-1), ["npm", "run", "timds", "--", "upgrade"]);
  assert.equal((await readJson(packagePath)).devDependencies[toolkit.name], releaseLine);
  const lock = await readJson(lockPath);
  assert.equal(lock.packages[""].devDependencies[toolkit.name], releaseLine);
  assert.equal(lock.packages[`node_modules/${toolkit.name}`].version, toolkit.version);
  assert.equal(await fs.readFile(path.join(product, PREVIEW_WORKFLOW), "utf8"), await readTemplate("timds-consumer-preview.yml"));
  assert.equal((await readJson(path.join(product, ".timds", "installation.json"))).consumer.version, toolkit.version);
  assert.deepEqual(await fs.readFile(path.join(product, "timds.consumer.json")), manifestBefore);
  await assertNoDesignSystemTooling(product);

  // The same guards as a Design System upgrade.
  await assert.rejects(upgradeConsumerToRelease(product, { version: "0.2.0", run }), /exact stable 0\.1\.x release/);
  const dirty = async (command, args, options) => (command === "git" ? { stdout: " M web/src/styles/site.css\n" } : run(command, args, options));
  await assert.rejects(upgradeConsumerToRelease(product, { version: toolkit.version, run: dirty }), /require a clean working tree/);
  const wrongLock = async (command, args, options) => {
    if (args[0] === "install") {
      await writeJson(lockPath, makeLock(toolkit.version, "0.1.0"));
      return { stdout: "" };
    }
    return run(command, args, options);
  };
  await assert.rejects(upgradeConsumerToRelease(product, { version: toolkit.version, run: wrongLock }), /resolves @dtconcepts\/timds to 0\.1\.0/);
  assert.equal((await readJson(packagePath)).devDependencies[toolkit.name], releaseLine, "the bounded requirement is always restored");
});

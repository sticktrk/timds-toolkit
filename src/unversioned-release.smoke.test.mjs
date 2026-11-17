// Exercise the stock release commands and the shell steps consumers actually
// run, with local Git repositories and a stand-in for publication's JSON output.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";

const templates = new URL("../templates/", import.meta.url);
const workflows = await Promise.all(["timds-standalone.yml", "timds-standalone-binary.yml"].map(async (name) => ({ name, document: YAML.parse(await fs.readFile(new URL(name, templates), "utf8")) })));
const updater = YAML.parse(await fs.readFile(new URL("update-consumer-submodule.yml", templates), "utf8"));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const notes = "# Changelog\n\n## Unreleased\n\n- Foundations: add a page.\n";
const version = "2026.11.17-1";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "timds-unversioned-release-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const repository = path.join(root, "repository");
  await fs.mkdir(path.join(repository, "scripts"), { recursive: true });
  for (const name of ["check-versions.mjs", "prepare-merge-release.mjs", "release.mjs"]) await fs.copyFile(new URL(`starter/scripts/${name}`, templates), path.join(repository, "scripts", name));
  await fs.writeFile(path.join(repository, "timds.json"), json({ schemaVersion: 1, systemId: "example/core", name: "Example" }));
  await fs.writeFile(path.join(repository, "package.json"), json({ name: "example", version, scripts: { "check:versions": "node scripts/check-versions.mjs" } }));
  await fs.writeFile(path.join(repository, "package-lock.json"), json({ version, packages: { "": { version } } }));
  await fs.writeFile(path.join(repository, "CHANGELOG.md"), notes);
  git(repository, "init", "-q", "-b", "main");
  git(repository, "config", "user.name", "TimDS Test");
  git(repository, "config", "user.email", "timds-test@example.com");
  git(repository, "add", ".");
  git(repository, "commit", "-q", "-m", "Unversioned source");
  const bin = path.join(root, "bin");
  await fs.mkdir(bin);
  await executable(path.join(bin, "timds-cli"), '#!/bin/sh\nif [ "$1" = run ]; then shift; exec node "$@"; fi\nprintf "%s\\n" "$PUBLICATION_JSON"\n');
  return { root, repository, env: { PATH: `${bin}:${process.env.PATH}` }, bin };
}

async function executable(file, text) {
  await fs.writeFile(file, text);
  await fs.chmod(file, 0o755);
}

const run = (cwd, command, args, env = {}) => spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
const command = (cwd, script, args = []) => run(cwd, process.execPath, [`scripts/${script}.mjs`, ...args]);
const success = (result) => assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
const step = (document, job, name) => document.jobs[job].steps.find((entry) => entry.name === name).run;
const shell = (cwd, script, env) => run(cwd, "bash", ["-c", script], env);
async function files(cwd) {
  return Promise.all(["timds.json", "package.json", "package-lock.json", "CHANGELOG.md"].map((name) => fs.readFile(path.join(cwd, name), "utf8")));
}

test("stock release commands preserve an unversioned source and allow an explicit return to versioning", async (t) => {
  const { repository, root } = await fixture(t);
  for (const declared of [undefined, null]) {
    await fs.writeFile(path.join(repository, "timds.json"), json({ systemId: "example/core", ...(declared === null ? { version: null } : {}) }));
    const before = await files(repository);
    success(command(repository, "check-versions"));
    const hand = command(repository, "release");
    success(hand);
    assert.match(hand.stdout, /declares no version; nothing to prepare/);
    const output = path.join(root, `prepare-${String(declared)}.txt`);
    success(command(repository, "prepare-merge-release", ["--previous", version, "--github-output", output]));
    assert.equal(await fs.readFile(output, "utf8"), "changed=false\nversion=\n");
    assert.deepEqual(await files(repository), before);
  }

  await fs.writeFile(path.join(repository, "timds.json"), json({ systemId: "example/core", version }));
  await fs.writeFile(path.join(repository, "CHANGELOG.md"), `${notes}\n## ${version}\n\n- Start named releases.\n`);
  const before = await files(repository);
  const output = path.join(root, "restored.txt");
  success(command(repository, "prepare-merge-release", ["--previous", "", "--github-output", output]));
  assert.equal(await fs.readFile(output, "utf8"), `changed=false\nversion=${version}\n`);
  success(command(repository, "check-versions"));
  assert.deepEqual(await files(repository), before);
  for (const prior of ["undefined", "not-a-version"]) {
    const invalid = command(repository, "prepare-merge-release", ["--previous", prior]);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /Invalid Design System version/);
  }
  await fs.writeFile(path.join(repository, "CHANGELOG.md"), notes);
  const missingNotes = command(repository, "prepare-merge-release", ["--previous", ""]);
  assert.notEqual(missingNotes.status, 0);
  assert.match(missingNotes.stderr, /has no section for explicitly advanced version/);
});

for (const { name, document } of workflows) test(`${name} prepares without a version and carries only a published host label to consumers`, async (t) => {
  const { root, repository, env, bin } = await fixture(t);
  const prepare = step(document, "prepare-release", "Prepare the merged release");
  for (const prior of [undefined, null]) {
    await fs.writeFile(path.join(repository, "timds.json"), json({ systemId: "example/core", ...(prior === null ? { version: null } : {}) }));
    await fs.writeFile(path.join(repository, "CHANGELOG.md"), notes);
    git(repository, "add", "timds.json", "CHANGELOG.md");
    if (git(repository, "diff", "--cached", "--name-only")) git(repository, "commit", "-q", "-m", "Prior unversioned source");
    const beforeSha = git(repository, "rev-parse", "HEAD");
    const output = path.join(root, `workflow-${String(prior)}.txt`);
    const before = await files(repository);
    success(shell(repository, prepare, { ...env, EVENT_NAME: "push", BEFORE_SHA: beforeSha, RELEASE_NOTE: "Add a page", GITHUB_OUTPUT: output }));
    assert.match(await fs.readFile(output, "utf8"), /changed=false\nversion=\n$/);
    assert.deepEqual(await files(repository), before);

    await fs.writeFile(path.join(repository, "timds.json"), json({ systemId: "example/core", version }));
    await fs.writeFile(path.join(repository, "CHANGELOG.md"), `${notes}\n## ${version}\n\n- Start named releases.\n`);
    const restored = await files(repository);
    const restoredOutput = path.join(root, `workflow-restored-${String(prior)}.txt`);
    success(shell(repository, prepare, { ...env, EVENT_NAME: "push", BEFORE_SHA: beforeSha, RELEASE_NOTE: "Start named releases", GITHUB_OUTPUT: restoredOutput }));
    assert.match(await fs.readFile(restoredOutput, "utf8"), new RegExp(`changed=false\\nversion=${version.replaceAll(".", "\\.")}\\n$`));
    assert.deepEqual(await files(repository), restored);
  }
  await fs.writeFile(path.join(repository, "timds.json"), json({ systemId: "example/core" }));
  const dispatchOutput = path.join(root, "dispatch.txt");
  success(shell(repository, prepare, { ...env, EVENT_NAME: "workflow_dispatch", BEFORE_SHA: "", GITHUB_OUTPUT: dispatchOutput }));
  assert.match(await fs.readFile(dispatchOutput, "utf8"), /version=\n$/);

  // Both publication commands produce the same public JSON interface. The
  // binary's run subcommand executes the real output-parsing script above.
  await executable(path.join(bin, "npm"), '#!/bin/sh\nprintf "%s\\n" "$PUBLICATION_JSON"\n');
  const publication = step(document, "publish", "Publish or stage the portal release and verify the public root");
  for (const [status, label] of [["published", "release-opaque_17"], ["published", undefined], ["awaiting-operator", "candidate-17"]]) {
    const output = path.join(root, `publication-${status}-${String(label)}.txt`);
    success(shell(repository, publication, { ...env, PUBLICATION_JSON: json({ status, ...(label ? { version: label } : {}) }), RUNNER_TEMP: root, GITHUB_OUTPUT: output }));
    assert.equal(await fs.readFile(output, "utf8"), `published=${status === "published"}\nversion=${status === "published" ? label ?? "" : ""}\n`);
  }
  assert.equal(document.jobs["pin-consumer"].with.version, "${{ needs.publish.outputs.version }}");
  assert.match(document.jobs["pin-consumer"].if, /needs\.publish\.outputs\.published == 'true'/);
});

test("the consumer workflow accepts host labels, preserves a fixed pin without one, and advances an unversioned submodule by SHA", async (t) => {
  const { root, repository, env, bin } = await fixture(t);
  const verify = step(updater, "update-consumer", "Verify release metadata");
  const sha = git(repository, "rev-parse", "HEAD");
  for (const label of ["", "release-opaque_17"]) {
    const output = path.join(root, `verify-${label || "commit"}.txt`);
    success(shell(repository, verify, { ...env, INPUT_SHA: sha, INPUT_VERSION: label, GITHUB_OUTPUT: output }));
    assert.equal(await fs.readFile(output, "utf8"), `sha=${sha}\nversion=${label}\n`);
  }
  for (const label of ["current", "latest", "label\nchanged=true"]) assert.notEqual(shell(repository, verify, { ...env, INPUT_SHA: sha, INPUT_VERSION: label, GITHUB_OUTPUT: path.join(root, "invalid.txt") }).status, 0);

  const update = step(updater, "update-consumer", "Update the Design System pin");
  await fs.writeFile(path.join(repository, "timds.consumer.json"), json({ designSystem: { version: "old-label" } }));
  git(repository, "add", ".");
  git(repository, "commit", "-q", "-m", "Published consumer pin");
  await executable(path.join(bin, "npm"), "#!/bin/sh\nexit 88\n");
  const fixedOutput = path.join(root, "fixed-pin.txt");
  const fixed = shell(repository, update, { ...env, DESIGN_SYSTEM_SHA: sha, DESIGN_SYSTEM_VERSION: "", SUBMODULE_PATH: "design-system", GITHUB_OUTPUT: fixedOutput });
  success(fixed);
  assert.match(fixed.stdout, /no release label; keeping the fixed published pin old-label/);
  assert.equal(await fs.readFile(fixedOutput, "utf8"), "changed=false\n");
  assert.equal(git(repository, "status", "--porcelain"), "");

  await fs.rm(path.join(repository, "timds.consumer.json"));
  git(repository, "add", "-u");
  git(repository, "update-index", "--add", "--cacheinfo", `160000,${"a".repeat(40)},design-system`);
  git(repository, "commit", "-q", "-m", "Submodule consumer");
  const remote = path.join(root, "remote.git");
  execFileSync("git", ["init", "--bare", "-q", remote]);
  git(repository, "remote", "add", "origin", remote);
  git(repository, "push", "-q", "origin", "main");
  const output = path.join(root, "submodule.txt");
  success(shell(repository, update, { ...env, DESIGN_SYSTEM_SHA: sha, DESIGN_SYSTEM_VERSION: "", SUBMODULE_PATH: "design-system", UPDATE_BRANCH: "automation/update-design-system", GITHUB_OUTPUT: output }));
  assert.equal(await fs.readFile(output, "utf8"), "mode=submodule\nchanged=true\n");
  assert.equal(git(repository, "ls-tree", "HEAD", "design-system").split(/\s+/)[2], sha);
  assert.equal(git(repository, "log", "-1", "--format=%s"), `chore: update design system to ${sha}`);
});

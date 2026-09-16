import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const realNpm = execFileSync("which", ["npm"], { encoding: "utf8" }).trim();

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "timds-release-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const remote = path.join(root, "remote.git");
  const bin = path.join(root, "bin");
  const log = path.join(root, "commands.jsonl");
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Release test",
    GIT_AUTHOR_EMAIL: "release@example.test",
    GIT_COMMITTER_NAME: "Release test",
    GIT_COMMITTER_EMAIL: "release@example.test",
    npm_config_sign_git_tag: "false",
    RELEASE_TEST_REAL_NPM: realNpm,
    RELEASE_TEST_LOG: log,
  };
  const git = (args, cwd = repo) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  await fs.mkdir(path.join(repo, "scripts"), { recursive: true });
  await fs.mkdir(bin);
  await fs.copyFile(new URL("../../scripts/release.sh", import.meta.url), path.join(repo, "scripts/release.sh"));
  const pkg = { name: "@dtconcepts/timds", version: "0.1.7" };
  await fs.writeFile(path.join(repo, "package.json"), JSON.stringify(pkg));
  await fs.writeFile(path.join(repo, "package-lock.json"), JSON.stringify({
    ...pkg, lockfileVersion: 3, requires: true, packages: { "": pkg },
  }));
  // Registry, validation, and GitHub calls stay offline; versioning and pushes
  // use real npm and Git against a temporary bare repository.
  await fs.writeFile(path.join(bin, "npm"), `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
appendFileSync(process.env.RELEASE_TEST_LOG, JSON.stringify(["npm", ...args]) + "\\n");
if (args[0] === "view") process.exit(1);
if (args[0] === "test") {
  if (process.env.RELEASE_TEST_ADVANCE_MASTER) {
    const result = spawnSync("git", ["push", "origin", "master"], { cwd: process.env.RELEASE_TEST_ADVANCE_MASTER, stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status || 1);
  }
  process.exit(process.env.RELEASE_TEST_FAIL === "test" ? 1 : 0);
}
if (args[0] === "run" && args[1] === "pack:check") process.exit(process.env.RELEASE_TEST_FAIL === "pack" ? 1 : 0);
if (args[0] === "version") {
  const result = spawnSync(process.env.RELEASE_TEST_REAL_NPM, args, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
process.exit(99);
`, { mode: 0o755 });
  await fs.writeFile(path.join(bin, "gh"), `#!/usr/bin/env node
require("node:fs").appendFileSync(process.env.RELEASE_TEST_LOG, JSON.stringify(["gh", ...process.argv.slice(2)]) + "\\n");
`, { mode: 0o755 });
  git(["init", "--bare", remote], root);
  git(["init", "-b", "master"]);
  git(["add", "."]);
  git(["commit", "-m", "Initial version"]);
  git(["remote", "add", "origin", remote]);
  git(["push", "-u", "origin", "master"]);
  return {
    root, repo, remote, git,
    run: (args = ["--yes"], extraEnv = {}) => spawnSync("bash", ["scripts/release.sh", ...args], {
      cwd: repo, env: { ...env, ...extraEnv }, encoding: "utf8",
    }),
    calls: async () => (await fs.readFile(log, "utf8")).trim().split("\n").map(JSON.parse),
  };
}

test("release bumps the manifest and lockfile, pushes the exact tag, and creates a release", async (t) => {
  const f = await fixture(t);
  f.git(["tag", "-a", "unrelated-local-tag", "-m", "Keep local"]);
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const file of ["package.json", "package-lock.json"]) {
    const pkg = JSON.parse(await fs.readFile(path.join(f.repo, file), "utf8"));
    assert.equal(pkg.version, "0.1.8");
    if (pkg.packages) assert.equal(pkg.packages[""].version, "0.1.8");
  }
  const sha = f.git(["rev-parse", "HEAD"]);
  assert.equal(f.git(["rev-parse", "master"], f.remote), sha);
  assert.equal(f.git(["rev-parse", "v0.1.8^{}"], f.remote), sha);
  assert.equal(f.git(["tag", "--list"], f.remote), "v0.1.8");
  assert.equal(f.git(["status", "--porcelain"]), "");
  const calls = await f.calls();
  assert.deepEqual(calls.slice(1, 4).map((call) => call.slice(0, 3)), [
    ["npm", "test"], ["npm", "run", "pack:check"], ["npm", "version", "0.1.8"],
  ]);
  assert.deepEqual(calls.at(-1), ["gh", "release", "create", "v0.1.8", "--verify-tag", "--title", "TimDS 0.1.8", "--generate-notes"]);
});

for (const mode of ["dry-run", "test", "pack"]) {
  test(`release leaves both repositories unchanged after ${mode}`, async (t) => {
    const f = await fixture(t);
    const before = f.git(["rev-parse", "HEAD"]);
    const result = f.run(mode === "dry-run" ? ["--dry-run"] : ["--yes"], { RELEASE_TEST_FAIL: mode });
    assert.equal(result.status, mode === "dry-run" ? 0 : 1, result.stdout + result.stderr);
    assert.equal(f.git(["rev-parse", "HEAD"]), before);
    assert.equal(f.git(["rev-parse", "master"], f.remote), before);
    assert.equal(f.git(["tag", "--list"], f.remote), "");
    assert.equal(f.git(["status", "--porcelain"]), "");
    assert.ok(!(await f.calls()).some(([tool, command]) => tool === "gh" || command === "version"));
  });
}

test("a concurrent master update rejects the entire push and never creates a release", async (t) => {
  const f = await fixture(t);
  const peer = path.join(f.root, "peer");
  f.git(["clone", "--branch", "master", f.remote, peer], f.root);
  f.git(["commit", "--allow-empty", "-m", "Concurrent change"], peer);
  const remoteHead = f.git(["rev-parse", "HEAD"], peer);
  const result = f.run(["--yes"], { RELEASE_TEST_ADVANCE_MASTER: peer });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /atomic push failed/);
  assert.equal(f.git(["rev-parse", "master"], f.remote), remoteHead);
  assert.equal(f.git(["tag", "--list"], f.remote), "");
  assert.ok(!(await f.calls()).some(([tool]) => tool === "gh"));
});

test("release validation accepts the created tag for a manual run and rejects mismatches", async () => {
  const pkg = JSON.parse(await fs.readFile(new URL("../../package.json", import.meta.url), "utf8"));
  for (const [tag, ref, status] of [
    [`v${pkg.version}`, "master", 0],
    ["", `v${pkg.version}`, 0],
    ["v0.0.0", `v${pkg.version}`, 1],
    ["", "master", 1],
  ]) {
    const result = spawnSync(process.execPath, [new URL("./check-release.mjs", import.meta.url).pathname], {
      env: { ...process.env, RELEASE_TAG: tag, GITHUB_REF_NAME: ref }, encoding: "utf8",
    });
    assert.equal(result.status, status, result.stdout + result.stderr);
  }
});

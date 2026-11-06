import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {promises as fs} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {initializeRepository, upgradeRepository} from "./core.mjs";
import {STARTER_RECORD_FILE} from "./starter.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/u, "");
const toolkitVersion = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")).version;
const starterFixtureRoot = fileURLToPath(new URL("./fixtures/starter-before-formats/", import.meta.url));

// The workflow's "Open or refresh the review PR" step, as bash, with a gh stub
// that logs its calls. The repository's node_modules carries this package, the
// way `npm ci` leaves it on the runner, so the step's import of the upgrade
// write boundary resolves to the toolkit under test.
async function scaffold(t, {standalone = true} = {}) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "timds-pr-automation-"));
  t.after(() => fs.rm(scratch, {recursive: true, force: true}));
  const root = path.join(scratch, "repository"), remote = path.join(scratch, "remote.git"), bin = path.join(scratch, "bin");
  await fs.mkdir(root); await fs.mkdir(bin);
  const git = (args) => execFileSync("git", args, {cwd: root, stdio: "pipe"});
  execFileSync("git", ["init", "--bare", remote], {stdio: "ignore"});
  git(["init", "-b", "main"]); git(["config", "user.name", "TimDS Test"]); git(["config", "user.email", "test@example.com"]);
  await initializeRepository(root, {standalone});
  await fs.mkdir(path.join(root, "node_modules", "@dtconcepts"), {recursive: true});
  await fs.symlink(packageRoot, path.join(root, "node_modules", "@dtconcepts", "timds"), "dir");
  const gh = path.join(bin, "gh"), log = path.join(scratch, "gh.log");
  await fs.writeFile(gh, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$GH_TEST_LOG"\nif [ "$2" = list ]; then printf '%s' "$GH_TEST_NUMBER"; fi\nif [ "$2" = create ] || [ "$2" = edit ]; then\n  while [ "$#" -gt 0 ]; do\n    if [ "$1" = --body-file ]; then shift; cat "$1" >> "$GH_TEST_LOG"; fi\n    shift\n  done\nfi\n`);
  await fs.chmod(gh, 0o755);
  const workflow = await fs.readFile(new URL("../templates/timds-upgrade.yml", import.meta.url), "utf8");
  const step = workflow.split("      - name: Open or refresh the review PR\n")[1].split("      - name: Report failed adoption\n")[0];
  const script = step.split("        run: |\n")[1].split("\n").map((line) => line.startsWith("          ") ? line.slice(10) : line).join("\n");
  const run = (number) => execFileSync("bash", ["-c", script], {cwd: root, env:{...process.env, PATH:`${bin}:${process.env.PATH}`, BASE_BRANCH:"main", RUNNER_TEMP:scratch, GH_TEST_LOG:log, GH_TEST_NUMBER:number}, stdio:"pipe"});
  const commit = (message) => { git(["add", "--all"]); git(["commit", "-m", message]); };
  const branchFiles = () => git(["diff", "--name-only", "main...timds/dependency-upgrade"]).toString().trim().split("\n").filter(Boolean);
  const reset = () => {
    git(["switch", "main"]); git(["branch", "-D", "timds/dependency-upgrade"]);
    // A new Actions checkout has no tracking ref for the prior upgrade branch.
    try { git(["update-ref", "-d", "refs/remotes/origin/timds/dependency-upgrade"]); } catch {}
  };
  return {root, remote, git, run, log, commit, branchFiles, reset};
}

test("opt-in automation opens and refreshes a reviewable dependency PR", async (t) => {
  const {root, remote, git, run, log, commit, branchFiles, reset} = await scaffold(t);
  commit("Initial"); git(["remote", "add", "origin", remote]); git(["push", "origin", "main"]);
  const packagePath = path.join(root, "package.json");
  const original = JSON.parse(await fs.readFile(packagePath));
  await fs.writeFile(packagePath, `${JSON.stringify({...original, description:"First upgrade"}, null, 2)}\n`);
  run("");
  assert.match(await fs.readFile(log, "utf8"), /pr create --draft/u);
  assert.match(await fs.readFile(log, "utf8"), new RegExp(`Upgrade TimDS to ${toolkitVersion.replaceAll(".", "\\.")}`, "u"));
  assert.deepEqual(branchFiles(), ["package.json"]);
  reset();
  await fs.writeFile(packagePath, `${JSON.stringify({...original, description:"Refreshed upgrade"}, null, 2)}\n`);
  run("12");
  assert.match(await fs.readFile(log, "utf8"), /pr edit 12/u);
  assert.match(await fs.readFile(log, "utf8"), /exact committed lockfile/u);
  reset();
  // Embedded layouts commit dist/; `timds check` rebuilds and re-extracts it, and the
  // extracted index records the engine version. That is not authored source.
  const ignorePath = path.join(root, ".gitignore");
  await fs.writeFile(ignorePath, (await fs.readFile(ignorePath, "utf8")).replace(/^dist\/\n/mu, ""));
  commit("Track the built artifact");
  await fs.mkdir(path.join(root, "dist"), {recursive: true});
  await fs.writeFile(path.join(root, "dist", "index.json"), `{"video":{"engine":{"version":"${toolkitVersion}"}}}\n`);
  run("12");
  assert.deepEqual(branchFiles(), ["dist/index.json"]);
  reset();
  await fs.rm(path.join(root, "dist"), {recursive: true});
  await fs.writeFile(path.join(root, "src", "index.html"), "Unreviewed source change\n");
  assert.throws(() => run("12"), /Checks changed authored files: src\/index\.html/u);
});

test("an upgrade of a starter-adopted system opens its PR: the starter sync's writes are inside the allowlist", async (t) => {
  const {root, remote, git, run, log, commit, branchFiles} = await scaffold(t);
  // A system scaffolded and adopted under an earlier release: its files are the
  // earlier starter's stock (scripts, catalogs, layout, no format catalog or
  // asset views), while its record says the toolkit owns the plumbing.
  const record = JSON.parse(await fs.readFile(path.join(root, STARTER_RECORD_FILE), "utf8"));
  await fs.cp(starterFixtureRoot, root, {force: true, recursive: true});
  for (const relative of ["src/formats.json", "scripts/brand-kit.mjs", "src/scripts/compose.js", "src/styles/canvas.css", "src/pages/digital", "src/pages/print", "src/pages/social", "src/pages/use"]) {
    await fs.rm(path.join(root, relative), {force: true, recursive: true});
  }
  await fs.writeFile(path.join(root, STARTER_RECORD_FILE), `${JSON.stringify({...record, version: "0.1.1"}, null, 2)}\n`);
  commit("Scaffold adopted under an earlier release"); git(["remote", "add", "origin", remote]); git(["push", "origin", "main"]);
  // The upgrade the workflow runs: it syncs the adopted starter on the way.
  const upgraded = await upgradeRepository(root);
  const written = upgraded.starter.files.filter((file) => file.status !== "current").map((file) => file.path);
  assert.ok(written.includes("src/formats.json") && written.includes("src/pages/use/compose.html") && written.includes("scripts/viewer.mjs"), written.join(", "));
  const changed = git(["status", "--porcelain", "--untracked-files=all"]).toString().trimEnd().split("\n").filter(Boolean).map((line) => line.slice(3));
  assert.ok(changed.includes(STARTER_RECORD_FILE) && changed.includes("src/site.json") && changed.includes("src/layout.html"), changed.join(", "));
  // Every path the sync wrote is one the workflow allows, so the PR opens.
  run("");
  assert.match(await fs.readFile(log, "utf8"), /pr create --draft/u);
  const files = branchFiles();
  for (const file of [STARTER_RECORD_FILE, "src/site.json", "src/formats.json", "src/layout.html", "src/pages/use/compose.html", "scripts/viewer.mjs"]) assert.ok(files.includes(file), file);
  assert.ok(!files.some((file) => file.startsWith("src/pages/brand/") || file === "src/index.html"), files.join(", "));
});

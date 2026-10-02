import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {promises as fs} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {initializeRepository} from "./core.mjs";

test("opt-in automation opens and refreshes a reviewable dependency PR", async (t) => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "timds-pr-automation-"));
  t.after(() => fs.rm(scratch, {recursive: true, force: true}));
  const root = path.join(scratch, "repository"), remote = path.join(scratch, "remote.git"), bin = path.join(scratch, "bin");
  await fs.mkdir(root); await fs.mkdir(bin);
  const git = (args) => execFileSync("git", args, {cwd: root, stdio: "pipe"});
  execFileSync("git", ["init", "--bare", remote], {stdio: "ignore"});
  git(["init", "-b", "main"]); git(["config", "user.name", "TimDS Test"]); git(["config", "user.email", "test@example.com"]);
  await initializeRepository(root, {standalone: true});
  await fs.mkdir(path.join(root, "node_modules", "@dtconcepts", "timds"), {recursive:true});
  await fs.writeFile(path.join(root, "node_modules", "@dtconcepts", "timds", "package.json"), '{"version":"0.1.900000"}');
  git(["add", "--all"]); git(["commit", "-m", "Initial"]); git(["remote", "add", "origin", remote]); git(["push", "origin", "main"]);
  const gh = path.join(bin, "gh"), log = path.join(scratch, "gh.log");
  await fs.writeFile(gh, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$GH_TEST_LOG"\nif [ "$2" = list ]; then printf '%s' "$GH_TEST_NUMBER"; fi\nif [ "$2" = create ] || [ "$2" = edit ]; then\n  while [ "$#" -gt 0 ]; do\n    if [ "$1" = --body-file ]; then shift; cat "$1" >> "$GH_TEST_LOG"; fi\n    shift\n  done\nfi\n`);
  await fs.chmod(gh, 0o755);
  const workflow = await fs.readFile(new URL("../templates/timds-upgrade.yml", import.meta.url), "utf8");
  const step = workflow.split("      - name: Open or refresh the review PR\n")[1].split("      - name: Report failed adoption\n")[0];
  const script = step.split("        run: |\n")[1].split("\n").map((line) => line.startsWith("          ") ? line.slice(10) : line).join("\n");
  const run = (number) => execFileSync("bash", ["-c", script], {cwd: root, env:{...process.env, PATH:`${bin}:${process.env.PATH}`, BASE_BRANCH:"main", RUNNER_TEMP:scratch, GH_TEST_LOG:log, GH_TEST_NUMBER:number}, stdio:"pipe"});
  const packagePath = path.join(root, "package.json");
  const original = JSON.parse(await fs.readFile(packagePath));
  await fs.writeFile(packagePath, `${JSON.stringify({...original, description:"First upgrade"}, null, 2)}\n`);
  run("");
  assert.match(await fs.readFile(log, "utf8"), /pr create --draft/u);
  assert.equal(git(["diff", "--name-only", "main...timds/dependency-upgrade"]).toString().trim(), "package.json");
  git(["switch", "main"]); git(["branch", "-D", "timds/dependency-upgrade"]);
  // A new Actions checkout has no tracking ref for the prior upgrade branch.
  git(["update-ref", "-d", "refs/remotes/origin/timds/dependency-upgrade"]);
  await fs.writeFile(packagePath, `${JSON.stringify({...original, description:"Refreshed upgrade"}, null, 2)}\n`);
  run("12");
  assert.match(await fs.readFile(log, "utf8"), /pr edit 12/u);
  assert.match(await fs.readFile(log, "utf8"), /exact committed lockfile/u);
  git(["switch", "main"]); git(["branch", "-D", "timds/dependency-upgrade"]);
  // Embedded layouts commit dist/; `timds check` rebuilds and re-extracts it, and the
  // extracted index records the engine version. That is not authored source.
  const ignorePath = path.join(root, ".gitignore");
  await fs.writeFile(ignorePath, (await fs.readFile(ignorePath, "utf8")).replace(/^dist\/\n/mu, ""));
  git(["add", "--all"]); git(["commit", "-m", "Track the built artifact"]);
  await fs.mkdir(path.join(root, "dist"), {recursive: true});
  await fs.writeFile(path.join(root, "dist", "index.json"), '{"video":{"engine":{"version":"0.1.900000"}}}\n');
  run("12");
  assert.equal(git(["diff", "--name-only", "main...timds/dependency-upgrade"]).toString().trim(), "dist/index.json");
  git(["switch", "main"]); git(["branch", "-D", "timds/dependency-upgrade"]);
  await fs.rm(path.join(root, "dist"), {recursive: true});
  await fs.writeFile(path.join(root, "src", "index.html"), "Unreviewed source change\n");
  assert.throws(() => run("12"), /Checks changed authored files/u);
});

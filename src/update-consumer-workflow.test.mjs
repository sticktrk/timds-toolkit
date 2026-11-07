// The stock "Update Design System consumer" workflow, step by step as bash:
// it must accept the dated Design System versions releases carry, and move a
// published pin with the consumer's own toolkit, whether that is the npm
// package or the binary executable.
import assert from "node:assert/strict";
import {execFileSync, spawnSync} from "node:child_process";
import {promises as fs} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const workflow = await fs.readFile(new URL("../templates/update-consumer-submodule.yml", import.meta.url), "utf8");
const binaryInstall = await fs.readFile(new URL("../templates/consumer-binary-install.yml", import.meta.url), "utf8");

function stepScript(name) {
  const step = workflow.split(`      - name: ${name}\n`)[1].split("\n      - name: ")[0];
  return step.split("        run: |\n")[1].split("\n").map((line) => line.startsWith("          ") ? line.slice(10) : line).join("\n");
}

const git = (cwd, ...args) => execFileSync("git", args, {cwd, encoding: "utf8"}).trim();
async function repository(t, files) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "timds-consumer-workflow-"));
  t.after(() => fs.rm(scratch, {recursive: true, force: true}));
  const root = path.join(scratch, "repository");
  await fs.mkdir(root);
  git(root, "init", "-q", "-b", "main"); git(root, "config", "user.name", "TimDS Test"); git(root, "config", "user.email", "test@example.com");
  for (const [relative, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, relative)), {recursive: true});
    await fs.writeFile(path.join(root, relative), typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  git(root, "add", "--all"); git(root, "commit", "-q", "-m", "Initial");
  return {scratch, root};
}

function runStep(name, {cwd, env}) {
  return spawnSync("bash", ["-c", stepScript(name)], {cwd, env: {...process.env, ...env}, encoding: "utf8"});
}

test("release metadata accepts a dated Design System version and still a legacy one", async (t) => {
  const {scratch, root} = await repository(t, {"timds.json": {version: "2026.11.06-1"}});
  const output = path.join(scratch, "output.txt");
  const verify = (version, sha = git(root, "rev-parse", "HEAD")) => runStep("Verify release metadata", {cwd: root, env: {INPUT_SHA: sha, INPUT_VERSION: version, GITHUB_OUTPUT: output}});
  assert.equal(verify("2026.11.06-1").status, 0);
  assert.match(await fs.readFile(output, "utf8"), /^sha=[0-9a-f]{40}\nversion=2026\.11\.06-1$/mu);
  for (const invalid of ["2026.11.06-0", "2026.11.6-1", "v2026.11.06-1", "1.2", "latest", "2026.11.06-1; echo"]) {
    const result = verify(invalid);
    assert.notEqual(result.status, 0, invalid);
    assert.match(result.stdout, /Invalid version/u, invalid);
  }
  // A commit declaring another version is refused the way it always was.
  const mismatch = verify("2026.11.07-1");
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stdout, /Commit declares 2026\.11\.06-1, expected 2026\.11\.07-1/u);
  await fs.writeFile(path.join(root, "timds.json"), '{"version":"1.2.3"}\n');
  git(root, "commit", "-q", "-am", "Legacy version");
  assert.equal(verify("1.2.3").status, 0);
});

// A PATH of stubs: the consumer's toolkits are logged, never run, and the
// executable download is served from the stub so the verified install runs.
async function stubs(scratch, {asset}) {
  const bin = path.join(scratch, "bin"), log = path.join(scratch, "calls.log"), home = path.join(scratch, "home");
  await fs.mkdir(bin); await fs.mkdir(home);
  const write = async (name, content) => { await fs.writeFile(path.join(bin, name), content); await fs.chmod(path.join(bin, name), 0o755); };
  // consumer update VERSION moves the pin the way the real command does.
  const update = `node -e 'const f="timds.consumer.json";const m=JSON.parse(require("fs").readFileSync(f,"utf8"));m.designSystem.version=process.argv[1];require("fs").writeFileSync(f,JSON.stringify(m,null,2)+"\\n")'`;
  await write("npm", `#!/bin/sh\nprintf 'npm %s\\n' "$*" >> "$CALLS_LOG"\nif [ "$1" = run ]; then shift 3; [ "$1" = -- ] && shift; if [ "$1" = consumer ] && [ "$2" = update ]; then ${update} "$3"; fi; fi\n`);
  await write("curl", `#!/bin/sh\nprintf 'curl %s\\n' "$*" >> "$CALLS_LOG"\nout=""; url=""\nwhile [ "$#" -gt 0 ]; do case "$1" in --output) shift; out="$1";; http*) url="$1";; esac; shift; done\ncase "$url" in\n  */SHA256SUMS) (cd "$(dirname "$out")" && shasum -a 256 "${asset}") > "$out";;\n  *) printf '%s' "$TIMDS_CLI_STUB" > "$out";;\nesac\n`);
  await write("sha256sum", "#!/bin/sh\nexec shasum -a 256 \"$@\"\n");
  const cliStub = `#!/bin/sh\nprintf 'timds-cli %s\\n' "$*" >> "$CALLS_LOG"\nif [ "$1" = consumer ] && [ "$2" = update ]; then ${update} "$3"; fi\n`;
  return {bin, log, home, env: {PATH: `${bin}:${process.env.PATH}`, CALLS_LOG: log, HOME: home, TIMDS_CLI_STUB: cliStub}};
}

async function pinUpdate(t, {installation}) {
  const {scratch, root} = await repository(t, {
    "timds.consumer.json": {schemaVersion: 1, designSystem: {path: "design-system", systemId: "example/core", version: "2026.10.01-1"}, apps: {}},
    ".timds/installation.json": installation,
  });
  const remote = path.join(scratch, "remote.git");
  execFileSync("git", ["init", "--bare", "-q", remote]);
  git(root, "remote", "add", "origin", remote); git(root, "push", "-q", "origin", "main");
  const {log, env} = await stubs(scratch, {asset: "timds-cli-v0.2.3-linux-x64"});
  const output = path.join(scratch, "output.txt");
  const result = runStep("Update the Design System pin", {cwd: root, env: {...env, RUNNER_TEMP: scratch, GITHUB_OUTPUT: output, DESIGN_SYSTEM_SHA: "0".repeat(40), DESIGN_SYSTEM_VERSION: "2026.11.06-1", SUBMODULE_PATH: "design-system", UPDATE_BRANCH: "automation/update-design-system"}});
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await fs.readFile(log, "utf8");
  assert.match(await fs.readFile(output, "utf8"), /^mode=pin\nchanged=true$/mu);
  const pushed = execFileSync("git", ["--git-dir", remote, "show", "automation/update-design-system:timds.consumer.json"], {encoding: "utf8"});
  assert.equal(JSON.parse(pushed).designSystem.version, "2026.11.06-1");
  assert.match(execFileSync("git", ["--git-dir", remote, "log", "-1", "--format=%s", "automation/update-design-system"], {encoding: "utf8"}), /update Design System to 2026\.11\.06-1/u);
  return calls;
}

test("a published pin moves with the npm toolkit when the consumer has one", async (t) => {
  const calls = await pinUpdate(t, {installation: {version: 1}});
  assert.match(calls, /^npm ci --ignore-scripts --no-audit --no-fund$/mu);
  assert.match(calls, /^npm run --silent timds -- consumer update 2026\.11\.06-1$/mu);
  assert.doesNotMatch(calls, /^(curl|timds-cli) /mu);
});

test("a published pin moves with the exact verified executable when the consumer is binary", async (t) => {
  const calls = await pinUpdate(t, {installation: {schemaVersion: 2, mode: "binary", name: "@dtconcepts/timds", version: "0.2.3", executable: "timds-cli"}});
  assert.match(calls, /^curl .* https:\/\/downloads\.timds\.com\/timds-cli\/v0\.2\.3\/timds-cli-v0\.2\.3-linux-x64 /mu);
  assert.match(calls, /^curl .* https:\/\/downloads\.timds\.com\/timds-cli\/v0\.2\.3\/SHA256SUMS /mu);
  assert.match(calls, /^timds-cli consumer update 2026\.11\.06-1$/mu);
  assert.doesNotMatch(calls, /^npm /mu);
});

test("the pin update's executable download is the consumer workflows' own install", () => {
  const download = (text) => {
    const lines = text.split("\n").map((line) => line.trim());
    const from = lines.findIndex((line) => line.startsWith('asset="timds-cli-v'));
    const to = lines.findIndex((line, index) => index > from && line.startsWith("install -m 755 "));
    assert.ok(from >= 0 && to > from);
    return lines.slice(from, to + 1).join("\n");
  };
  assert.equal(download(workflow), download(binaryInstall));
  assert.match(workflow, /\[\[ "\$version" =~ \^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$ \]\]/u);
});

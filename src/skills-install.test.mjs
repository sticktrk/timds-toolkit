import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runCli, runWithOutputSink } from "./core.mjs";
import {
  INSTALLABLE_SKILL_NAMES,
  SKILL_DIRECTORIES,
  hostedSkillName,
  hostedSkillPlaceholders,
  installSkills,
  renderHostedSkillFiles,
} from "./skills-install.mjs";

const toolkitVersion = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8")).version;
const hostedTemplateRoot = fileURLToPath(new URL("../skills/timds-hosted-design-system/", import.meta.url));
const quiet = () => {};
const sha256 = (content) => createHash("sha256").update(content).digest("hex");

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "timds-skills-"));
  t.after(() => fs.rm(directory, { force: true, recursive: true }));
  return fs.realpath(directory);
}

test("the hosted skill template is a CLI workflow with only the placeholders the host fills", async () => {
  for (const file of ["SKILL.md", "agents/openai.yaml"]) {
    const text = await fs.readFile(path.join(hostedTemplateRoot, file), "utf8");
    assert.doesNotMatch(text, /\bMCP\b|_session\b|__MCP_URL__/i, `${file} mentions MCP`);
    for (const placeholder of text.match(/__[A-Z_]+__/g) || []) assert.ok(hostedSkillPlaceholders.includes(placeholder), `${file} uses unknown ${placeholder}`);
  }
  const skill = await fs.readFile(path.join(hostedTemplateRoot, "SKILL.md"), "utf8");
  assert.match(skill, /^name: __SKILL_NAME__$/m);
  assert.match(skill, /npx --yes @dtconcepts\/timds@latest/);
  assert.doesNotMatch(skill, /@dtconcepts\/timds@\d/, "never a pinned version");
  for (const command of [
    "timds auth login --portal-url __HOST_ORIGIN__ --oauth",
    "timds whoami",
    "timds start __SYSTEM_ID__ --root ./<folder> --portal-url __HOST_ORIGIN__",
    'timds join "<invite link>"',
    "timds draft create <name> --system-id __SYSTEM_ID__",
    "timds active-work",
    "timds claim --on",
    "npm ci",
    "timds dev",
    "timds check",
    "timds pull",
    "timds update --resolve",
    'timds submit --note "',
  ]) assert.ok(skill.includes(command), `skill names ${command}`);
  assert.match(skill, /## Never, unless the designer explicitly asks[\s\S]*timds publish[\s\S]*timds rollback/);
});

test("skills install writes the filled designer skills into every agent folder and records their digests", async (t) => {
  const root = await temporaryDirectory(t);
  const lines = [];
  await runWithOutputSink((line) => lines.push(line), () => runCli(["skills", "install", "--root", root, "--portal-url", "https://host.example.com/studio/", "--system-id", "timds-example/core"]));

  const hosted = hostedSkillName("timds-example/core");
  assert.equal(hosted, "timds-core", "the same folder name the host gives the skill");
  for (const directory of SKILL_DIRECTORIES) {
    for (const name of [...INSTALLABLE_SKILL_NAMES, hosted]) {
      await fs.access(path.join(root, directory, name, "SKILL.md"));
      await fs.access(path.join(root, directory, name, "agents", "openai.yaml"));
    }
    await assert.rejects(fs.access(path.join(root, directory, "timds-consume-design-system")), "consumer skills belong to consumer init");
    await assert.rejects(fs.access(path.join(root, directory, "timds-hosted-design-system")), "the template folder is never installed as is");
  }
  const skill = await fs.readFile(path.join(root, ".claude", "skills", hosted, "SKILL.md"), "utf8");
  assert.doesNotMatch(skill, /__[A-Z_]+__/);
  assert.match(skill, /^name: timds-core$/m);
  assert.match(skill, /timds auth login --portal-url https:\/\/host\.example\.com --oauth/);
  assert.match(skill, /timds start timds-example\/core --root/);
  assert.match(skill, /Studio, where the designer reviews: https:\/\/host\.example\.com\/studio\//);
  assert.match(await fs.readFile(path.join(root, ".cursor", "skills", hosted, "agents", "openai.yaml"), "utf8"), /\$timds-core/);

  const record = JSON.parse(await fs.readFile(path.join(root, ".timds", "skills.json"), "utf8"));
  assert.equal(record.version, toolkitVersion);
  assert.deepEqual(record.systems.map(({ portalUrl, systemId, skill: name }) => ({ portalUrl, systemId, name })), [{ portalUrl: "https://host.example.com", systemId: "timds-example/core", name: "timds-core" }]);
  assert.equal(Object.keys(record.managedFiles).length, SKILL_DIRECTORIES.length * (INSTALLABLE_SKILL_NAMES.length + 1) * 2);
  assert.match(lines.join("\n"), /Hosted skill timds-core: timds-example\/core at https:\/\/host\.example\.com/);
});

test("without a host and system only the system-independent skills are installed, and the output says so", async (t) => {
  const root = await temporaryDirectory(t);
  const lines = [];
  const result = await installSkills({ root, output: (line) => lines.push(line) });
  assert.deepEqual(result.systems, []);
  for (const name of INSTALLABLE_SKILL_NAMES) await fs.access(path.join(root, ".agents", "skills", name, "SKILL.md"));
  assert.deepEqual((await fs.readdir(path.join(root, ".agents", "skills"))).sort(), [...INSTALLABLE_SKILL_NAMES].sort());
  assert.match(lines.join("\n"), /No hosted skill[\s\S]*--portal-url URL and --system-id ID/);
  await assert.rejects(installSkills({ root, portalUrl: "https://host.example.com", output: quiet }), /--portal-url and --system-id go together/);
  await assert.rejects(installSkills({ root, portalUrl: "ftp://host.example.com", systemId: "a/b", output: quiet }), /HTTP or HTTPS/);
});

test("a rerun refreshes unmodified files, keeps edits unless forced, rerenders recorded systems, and removes retired files", async (t) => {
  const root = await temporaryDirectory(t);
  await installSkills({ root, portalUrl: "https://host.example.com", systemId: "timds-example/core", output: quiet });
  const recordPath = path.join(root, ".timds", "skills.json");
  const record = JSON.parse(await fs.readFile(recordPath, "utf8"));

  // An older release wrote this file and recorded it; this release no longer ships it.
  const retired = ".agents/skills/design-start/old-notes.md";
  await fs.writeFile(path.join(root, retired), "old\n");
  // An older release's copy of a still-shipped file: refreshed, because nobody edited it.
  const stale = ".claude/skills/design-ship/SKILL.md";
  await fs.writeFile(path.join(root, stale), "older stock\n");
  record.managedFiles[retired] = sha256("old\n");
  record.managedFiles[stale] = sha256("older stock\n");
  await fs.writeFile(recordPath, JSON.stringify(record));
  // A person's edit to the hosted skill.
  const edited = ".agents/skills/timds-core/SKILL.md";
  const editedText = `${await fs.readFile(path.join(root, edited), "utf8")}\nOur own rule.\n`;
  await fs.writeFile(path.join(root, edited), editedText);

  const lines = [];
  const rerun = await installSkills({ root, output: (line) => lines.push(line) });
  const status = (relative) => rerun.files.find((entry) => entry.path === relative)?.status;
  assert.deepEqual(rerun.systems.map((system) => system.systemId), ["timds-example/core"], "the recorded system is rerendered without flags");
  assert.equal(status(stale), "refreshed");
  assert.notEqual(await fs.readFile(path.join(root, stale), "utf8"), "older stock\n");
  assert.equal(status(retired), "removed");
  await assert.rejects(fs.access(path.join(root, retired)));
  assert.equal(status(edited), "kept");
  assert.equal(await fs.readFile(path.join(root, edited), "utf8"), editedText);
  assert.match(lines.join("\n"), /kept {6}\.agents\/skills\/timds-core\/SKILL\.md \(edited here; rerun with --force/);

  const forced = await installSkills({ root, force: true, output: quiet });
  assert.equal(forced.files.find((entry) => entry.path === edited).status, "replaced");
  const [rendered] = (await renderHostedSkillFiles({ portalUrl: "https://host.example.com", systemId: "timds-example/core" })).filter((file) => file.relative === "SKILL.md");
  assert.equal(await fs.readFile(path.join(root, edited), "utf8"), rendered.content);
});

test("a linked skill folder is written once, and --global installs under the home folder with the record beside the credentials", async (t) => {
  const root = await temporaryDirectory(t);
  await fs.mkdir(path.join(root, ".agents", "skills"), { recursive: true });
  await fs.mkdir(path.join(root, ".claude"), { recursive: true });
  await fs.symlink(path.join("..", ".agents", "skills"), path.join(root, ".claude", "skills"), "dir");
  const linked = await installSkills({ root, output: quiet });
  assert.equal(linked.destinations.find((entry) => entry.relative === ".claude/skills").linkedTo, ".agents/skills");
  assert.ok(!Object.keys(linked.installation.managedFiles).some((file) => file.startsWith(".claude/")));
  await fs.access(path.join(root, ".claude", "skills", "design-start", "SKILL.md"));

  const home = await temporaryDirectory(t);
  const result = await installSkills({ global: true, homeDirectory: home, env: {}, portalUrl: "https://host.example.com", systemId: "timds-example/core", output: quiet });
  assert.equal(result.base, home);
  assert.equal(result.recordPath, path.join(home, ".config", "timds", "skills.json"));
  await fs.access(path.join(home, ".cursor", "skills", "timds-core", "SKILL.md"));
  await assert.rejects(fs.access(path.join(home, ".timds")));
});

test("skills install refuses folders whose skills another TimDS record owns", async (t) => {
  for (const [file, pattern] of [
    [".timds/session.json", /hosted TimDS session workspace/],
    ["timds.json", /Design System repository[\s\S]*timds upgrade/],
    ["timds.consumer.json", /consumer repository[\s\S]*consumer init/],
  ]) {
    const root = await temporaryDirectory(t);
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), "{}\n");
    await assert.rejects(installSkills({ root, output: quiet }), pattern);
    await assert.rejects(fs.access(path.join(root, ".agents")));
  }
  await assert.rejects(runCli(["skills", "list"]), /Usage: timds skills install/);
});

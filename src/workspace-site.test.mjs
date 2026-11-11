// Two builds in one repository: a Design System workspace with an EmDash
// site in site/ (issue #160, item 4). The system's build, check, extract,
// upgrade and doctor must give the same results with the site folder as
// without it, never write into it, and the git-scoped commands, the MCP
// guard, hosted sessions and offshoots must each treat it as decided in
// workspace-site.mjs's callers. One workspace is built with the real `init`,
// measured, then given a scaffolded site with stand-ins for everything an
// install and a build leave behind, and measured again.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { collectBundleFiles } from "./bundle.mjs";
import { scaffoldWorkspaceEmdashSite } from "./consumer-scaffold-workspace.mjs";
import { initializeRepository, loadWorkspace, runCli, runWithOutputSink, submitWorkspace } from "./core.mjs";
import { sessionChanges } from "./hosted.mjs";
import { isProtectedPath } from "./mcp.mjs";
import { loadOffshootSource, transformOffshoot } from "./offshoots.mjs";
import { CONSUMER_SKILL_NAMES } from "./consumer.mjs";
import { designSystemSkillNames } from "./skill-names.mjs";
import { WORKSPACE_SITE_DIRECTORY, WORKSPACE_SITE_SKILL_NAMES, findWorkspaceSite, isWorkspaceSitePath, workspaceSitePath, workspaceSiteSkillFolders } from "./workspace-site.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const toolkitVersion = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")).version;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const quiet = () => {};

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function write(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

/** Every entry under `directory` with the sha256 of its bytes; links by target. */
async function treeHash(directory) {
  const result = {};
  const visit = async (relative) => {
    for (const entry of (await fs.readdir(path.join(directory, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) result[child] = `-> ${await fs.readlink(path.join(directory, child))}`;
      else if (entry.isDirectory()) { result[`${child}/`] = "dir"; await visit(child); }
      else result[child] = sha256(await fs.readFile(path.join(directory, child)));
    }
  };
  await visit("");
  return result;
}

async function cli(args) {
  const lines = [];
  await runWithOutputSink((line) => lines.push(line), () => runCli(args));
  return lines;
}

const json = async (args) => JSON.parse((await cli(args)).join("\n"));

/**
 * What the system's commands give for the workspace at `root`: their output,
 * the built artifact and derived layer (dist/), the upgrade and doctor
 * documents, and the managed records an upgrade writes.
 */
async function systemResults(root) {
  const check = await cli(["check", "--root", root, "--require-clean-dist"]);
  const builtDist = await treeHash(path.join(root, "dist"));
  const extract = await cli(["extract", "--root", root, "--skip-build"]);
  const extractedDist = await treeHash(path.join(root, "dist"));
  const derived = {};
  for (const name of ["index.json", "tokens.json", "brand.json", "formats.json", "designs.json", "changelog.json", "llms.txt"]) {
    const file = path.join(root, "dist", name);
    if (existsSync(file)) derived[name] = await fs.readFile(file, "utf8");
  }
  const doctor = await json(["doctor", "--root", root, "--json"]);
  const upgrade = await json(["upgrade", "--root", root, "--json"]);
  const records = {};
  for (const name of [".timds/installation.json", ".timds/starter.json", ".timds/contract-layout.json"]) {
    records[name] = existsSync(path.join(root, name)) ? await fs.readFile(path.join(root, name), "utf8") : null;
  }
  const managed = {};
  // The system's managed skills only: the scaffold installs the two consumer
  // skills beside them, which no Design System upgrade manages.
  for (const skill of designSystemSkillNames) {
    for (const [name, hash] of Object.entries(await treeHash(path.join(root, ".agents", "skills", skill)))) managed[`${skill}/${name}`] = hash;
  }
  return { check, builtDist, extract, extractedDist, derived, doctor, upgrade, records, managed, status: git(root, "status", "--porcelain", "--untracked-files=all") };
}

let directory;
let root;
let withoutSite;
let withSite;
let siteBefore;
let siteAfter;

before(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "timds-workspace-site-")));
  root = path.join(directory, "ws");
  await fs.mkdir(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "timds-test@example.com");
  git(root, "config", "user.name", "TimDS Test");
  await initializeRepository(root, { standalone: true, name: "Acme", systemId: "acme/core" });
  git(root, "add", "--all");
  git(root, "commit", "-qm", "Initialize the Design System");
  withoutSite = await systemResults(root);

  await scaffoldWorkspaceEmdashSite(root, { skipInstall: true, output: quiet });
  const site = path.join(root, WORKSPACE_SITE_DIRECTORY);
  // Stand-ins for what `npm ci`, `astro build`, `astro dev` and Wrangler leave
  // behind: a dependency tree with a link, a built site whose HTML would fail
  // the system's artifact rules, and local state and secrets.
  const deep = path.join(site, "dist", "client", ...Array.from({ length: 24 }, (_, index) => `d${index}`));
  await write(path.join(deep, "index.html"), '<!doctype html><a href="/missing/page/">broken</a><link rel="stylesheet" href="../nowhere.css">\n');
  await write(path.join(site, "dist", "client", "index.html"), '<!doctype html><html><body><a href="/no-such-route/">x</a><img src="/absent.png"></body></html>\n');
  await write(path.join(site, "dist", "server", "entry.mjs"), "export default {};\n");
  await write(path.join(site, "node_modules", "some-package", "package.json"), '{"name":"some-package","version":"1.0.0"}\n');
  await write(path.join(site, "node_modules", "some-package", "styles", "theme.css"), ":root { --color-ink: hotpink; }\n.prose { color: hotpink; }\n");
  await write(path.join(site, "node_modules", "some-package", "README.md"), "# some-package\n");
  await fs.mkdir(path.join(site, "node_modules", ".bin"), { recursive: true });
  await fs.symlink("../some-package/README.md", path.join(site, "node_modules", ".bin", "some-package"));
  await fs.symlink("../../src", path.join(site, "node_modules", "some-package", "loop"));
  await write(path.join(site, ".astro", "types.d.ts"), "export {};\n");
  await write(path.join(site, ".wrangler", "state", "v3", "d1", "db.sqlite"), "SQLite format 3\0");
  await write(path.join(site, ".emdash", "migrations.json"), "{}\n");
  await write(path.join(site, ".dev.vars"), "EMDASH_SECRET=local-only\n");
  git(root, "add", "--all");
  git(root, "commit", "-qm", "Add the workspace site");
  assert.equal(git(root, "status", "--porcelain", "--untracked-files=all"), "", "the site's own .gitignore keeps its generated folders out of Git");
  siteBefore = await treeHash(site);
  withSite = await systemResults(root);
  siteAfter = await treeHash(site);
});

after(() => directory && fs.rm(directory, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 }));

test("the workspace really holds a site and its generated folders", () => {
  assert.ok(findWorkspaceSite(root));
  assert.equal(workspaceSitePath(root, root), "site");
  assert.ok(siteBefore["node_modules/.bin/some-package"].startsWith("-> "));
  assert.ok(Object.keys(siteBefore).some((name) => name.startsWith("dist/client/d0/")));
  assert.ok(siteBefore[".dev.vars"] && siteBefore["package-lock.json"] && siteBefore["timds.consumer.json"]);
});

test("check (with --require-clean-dist) builds the same artifact and prints the same report with the site present", () => {
  assert.deepEqual(withSite.check, withoutSite.check);
  assert.deepEqual(withSite.builtDist, withoutSite.builtDist);
  assert.ok(Object.keys(withoutSite.builtDist).length > 20, "the artifact is the real starter build");
  assert.ok(!Object.keys(withSite.builtDist).some((name) => name.startsWith("site/")), "nothing of the site enters the system's artifact");
});

test("extract derives the same layer with the site present", () => {
  assert.deepEqual(withSite.extract, withoutSite.extract);
  assert.deepEqual(withSite.extractedDist, withoutSite.extractedDist);
  assert.deepEqual(withSite.derived, withoutSite.derived);
  assert.ok(withSite.derived["tokens.json"] && withSite.derived["llms.txt"]);
});

test("upgrade at the workspace root is the Design System's own upgrade, with the same result and records", () => {
  assert.equal(withSite.upgrade.ok, true);
  assert.equal(withSite.upgrade.command, "upgrade");
  assert.equal(withSite.upgrade.designSystemRoot, root);
  assert.equal(withSite.upgrade.toolkit.selected, toolkitVersion);
  assert.deepEqual(withSite.upgrade, withoutSite.upgrade);
  assert.deepEqual(withSite.records, withoutSite.records);
  assert.deepEqual(withSite.managed, withoutSite.managed);
  assert.equal(withSite.status, "", "a same-version upgrade leaves the tree as committed");
  assert.equal(withoutSite.status, "");
});

test("doctor reports the same facts with the site present", () => {
  assert.deepEqual(withSite.doctor, withoutSite.doctor);
  assert.equal(withSite.doctor.consumer, null, "the root is a Design System, not a consumer");
});

test("nothing the system does writes into site/", () => {
  assert.deepEqual(siteAfter, siteBefore);
});

test("--require-clean-dist compares the system's dist/ only, never site/dist/", async () => {
  // Track a built site file, then change it: only the system's artifact is compared.
  const built = path.join(root, "site", "dist", "server", "entry.mjs");
  git(root, "add", "--force", "site/dist/server/entry.mjs");
  git(root, "commit", "-qm", "Track a built site file");
  try {
    await fs.writeFile(built, "export default { changed: true };\n");
    await cli(["check", "--root", root, "--skip-build", "--require-clean-dist"]);
  } finally {
    git(root, "rm", "-q", "--cached", "site/dist/server/entry.mjs");
    git(root, "commit", "-qm", "Untrack the built site file");
    await fs.writeFile(built, "export default {};\n");
  }
});

test("the bundle walk never enters the workspace site, and a plain site/ folder is walked as before", async () => {
  const config = { include: ["**/*.css"], exclude: [] };
  const { files, skipped } = await collectBundleFiles(root, config, { outputDirectory: "bundle" });
  assert.ok(files.some((file) => file.path === "src/styles/system.css"));
  assert.deepEqual(files.filter((file) => isWorkspaceSitePath(file.path, "site")), []);
  assert.deepEqual(skipped.filter((name) => name.startsWith("site/")), []);

  // Without a workspace-form manifest, site/ is an ordinary folder of the system.
  const plain = path.join(directory, "plain");
  await write(path.join(plain, "src", "styles", "system.css"), ":root {}\n");
  await write(path.join(plain, "site", "theme.css"), ".x {}\n");
  const plainFiles = (await collectBundleFiles(plain, config)).files.map((file) => file.path);
  assert.deepEqual(plainFiles, ["site/theme.css", "src/styles/system.css"]);
});

test("timds upgrade inside site/ is refused, and the root upgrade keeps unknown skill folders", async () => {
  await assert.rejects(cli(["upgrade", "--root", path.join(root, "site")]), /workspace/i);
  const consumerSkill = path.join(root, ".agents", "skills", "timds-consume-design-system", "SKILL.md");
  await write(consumerSkill, "# Consume the Design System\n");
  git(root, "add", "--all");
  git(root, "commit", "-qm", "Add the consumer skill at the workspace root");
  const report = await json(["upgrade", "--root", root, "--json"]);
  assert.equal(report.ok, true);
  assert.ok(!JSON.stringify(report.managedFiles).includes("timds-consume-design-system"), "the system's upgrade neither writes nor reports a skill it does not manage");
  assert.equal(await fs.readFile(consumerSkill, "utf8"), "# Consume the Design System\n");
  assert.equal(git(root, "status", "--porcelain", "--untracked-files=all"), "");
});

test("the MCP editing guard opens the site's source and protects its package, records, output, state and secrets", async () => {
  const workspace = await loadWorkspace(root);
  for (const file of ["site/src/pages/index.astro", "site/src/layouts/Base.astro", "site/astro.config.mjs", "site/wrangler.jsonc", "site/.env.example", "site/seed/seed.json"]) {
    assert.equal(isProtectedPath(workspace, file), false, `${file} is editable`);
  }
  for (const file of ["site/package.json", "site/package-lock.json", "site/timds.consumer.json", "site/.timds/emdash.json", "site/node_modules/some-package/README.md", "site/dist/client/index.html", "site/.astro/types.d.ts", "site/.wrangler/state/v3/d1/db.sqlite", "site/.emdash/migrations.json", "site/.dev.vars", "site/.env", "site/.env.production", "site/.gitignore"]) {
    assert.equal(isProtectedPath(workspace, file), true, `${file} is protected`);
  }
  // The system's own protection is unchanged.
  assert.equal(isProtectedPath(workspace, "package.json"), true);
  assert.equal(isProtectedPath(workspace, "src/styles/system.css"), false);

  // A site/ folder without a workspace manifest is ordinary authored source, as before.
  const plain = { ...workspace, designSystemRoot: path.join(directory, "plain"), repoRoot: path.join(directory, "plain") };
  assert.equal(isProtectedPath(plain, "site/package.json"), false);
  assert.equal(isProtectedPath(plain, "site/dist/index.html"), false);
});

test("submit needs no system changelog note for a change confined to site/, and still does for any system change", async () => {
  const page = path.join(root, "site", "src", "pages", "about-us.astro");
  await write(page, "---\n---\n<h1>About</h1>\n");
  try {
    const result = await submitWorkspace(root, "Add the about page to the site", { dryRun: true, noBuild: true });
    assert.equal(result.dryRun, true);
    assert.deepEqual(result.commands[1], ["git", "add", "--all"], "a standalone submit carries the site with the system");

    // The same change plus any system file needs the note.
    const css = path.join(root, "src", "styles", "system.css");
    const original = await fs.readFile(css, "utf8");
    await fs.appendFile(css, "\n.about { margin: 0; }\n");
    try {
      await assert.rejects(submitWorkspace(root, "Add the about page", { dryRun: true, noBuild: true }), /no note under ## Unreleased/);
    } finally {
      await fs.writeFile(css, original);
    }
  } finally {
    await fs.rm(page, { force: true });
  }

  // A file moved out of the system into the site is a system change too.
  git(root, "switch", "-q", "-c", "move-into-site");
  try {
    git(root, "mv", "src/styles/canvas.css", "site/src/canvas.css");
    git(root, "commit", "-qm", "Move a stylesheet into the site");
    await assert.rejects(submitWorkspace(root, "Move a stylesheet", { dryRun: true, noBuild: true }), /no note under ## Unreleased/);
  } finally {
    git(root, "switch", "-q", "main");
    git(root, "branch", "-q", "-D", "move-into-site");
  }
});

test("a hosted session would carry the site's source and never its dependencies, output, state or secrets", async () => {
  const { files } = await sessionChanges(root, { files: [], session: { baseRevision: "base" } });
  const names = [...files.keys()];
  assert.ok(names.includes("site/package.json") && names.includes("site/src/layouts/Base.astro"));
  for (const prefix of ["site/node_modules/", "site/dist/", "site/.astro/", "site/.wrangler/"]) {
    assert.deepEqual(names.filter((name) => name.startsWith(prefix)), [], prefix);
  }
  assert.ok(!names.includes("site/.dev.vars"));
  assert.ok(names.filter((name) => name.startsWith("site/")).length < 200, "the site's source is a few dozen files");
});

test("a full offshoot of a system with a site starts without it", async () => {
  const source = await loadOffshootSource(root, { sourceId: randomUUID() });
  assert.ok(source.files.some((file) => file.path === "site/timds.consumer.json"), "the parent's tree holds the site");
  const { files } = await transformOffshoot(source, { mode: "full", systemId: "acme/child" });
  assert.deepEqual(files.filter((file) => file.path.startsWith("site/")), []);
  assert.ok(files.some((file) => file.path === "src/styles/system.css"));
});

test("the skills the system's commands name for a workspace site are the consumer skills", () => {
  assert.deepEqual([...WORKSPACE_SITE_SKILL_NAMES], [...CONSUMER_SKILL_NAMES]);
});

test("the scaffold's record makes the root consumer skills the site's, and nothing else does", async () => {
  assert.deepEqual(workspaceSiteSkillFolders(root, root), WORKSPACE_SITE_SKILL_NAMES.map((name) => `.agents/skills/${name}`));
  // No site, no skills: the same folders at a plain root are not the system's.
  assert.deepEqual(workspaceSiteSkillFolders(path.join(directory, "plain"), path.join(directory, "plain")), []);
});

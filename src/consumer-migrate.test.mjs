import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CONSUMER_MANIFEST_FILE, checkConsumer, loadConsumer, runConsumerCli } from "./consumer.mjs";
import { migrateConsumerToPublished, removeGitmodulesSection } from "./consumer-migrate.mjs";

const BASE = "https://cdn.test/acme/core/artifact";
const sha256 = (content) => createHash("sha256").update(content).digest("hex");

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "timds-consumer-migrate-"));
  t.after(() => fs.rm(directory, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 }));
  return fs.realpath(directory);
}

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "protocol.file.allow=always", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function initRepo(cwd) {
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "config", "user.email", "timds-test@example.com");
  git(cwd, "config", "user.name", "TimDS Test");
  git(cwd, "config", "commit.gpgsign", "false");
}

async function write(root, relative, content) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
}

/** A published 1.3.0 bundle holding the stylesheet the product's symlink reaches, but not its script. */
function publishedSystem() {
  const files = [["src/styles/ds/brand.css", ".brand{}"]];
  const bundle = { schemaVersion: 1, system: { id: "acme/core", name: "Acme", version: "1.3.0" }, url: `${BASE}/v/1.3.0/bundle.json`, directory: `${BASE}/v/1.3.0/bundle`, fileCount: 1, bytes: 8, files: files.map(([relative, body]) => ({ path: relative, url: `${BASE}/v/1.3.0/bundle/${relative}`, bytes: body.length, sha256: sha256(body) })) };
  const served = new Map([["v/1.3.0/bundle.json", JSON.stringify(bundle)], ...files.map(([relative, body]) => [`v/1.3.0/bundle/${relative}`, body])]);
  return async (url) => {
    const relative = String(url).startsWith(`${BASE}/`) ? String(url).slice(BASE.length + 1) : null;
    const body = relative === null ? undefined : served.get(relative);
    return body === undefined ? new Response("missing", { status: 404 }) : new Response(body, { status: 200 });
  };
}

/** A product with the Design System as a real submodule at version 1.3.0, a tracked symlink into it, and a deploy script that updates it. */
async function submoduleProduct(t, { version = "1.3.0" } = {}) {
  const root = await temporaryDirectory(t);
  const dsRepo = path.join(root, "ds-origin");
  const product = path.join(root, "product");
  await fs.mkdir(dsRepo);
  await fs.mkdir(product);
  initRepo(dsRepo);
  await write(dsRepo, "timds.json", { schemaVersion: 2, systemId: "acme/core", name: "Acme", version });
  await write(dsRepo, "src/styles/ds/brand.css", ".brand{}");
  await write(dsRepo, "public/ds.js", "// js");
  git(dsRepo, "add", ".");
  git(dsRepo, "commit", "-q", "-m", "Design system");

  initRepo(product);
  await write(product, CONSUMER_MANIFEST_FILE, { schemaVersion: 1, designSystem: { path: "design-system", systemId: "acme/core" }, apps: { web: { cwd: "web", preview: { build: ["npm", "run", "build"], output: "dist" }, designSurface: ["src/**"] } } });
  await write(product, "package.json", { name: "product", private: true, scripts: { timds: "timds" }, devDependencies: { "@dtconcepts/timds": "0.1.x" } });
  await write(product, "web/package.json", { name: "web" });
  await write(product, "scripts/deploy.sh", "#!/bin/sh\ngit submodule update --init design-system\n");
  await write(product, ".gitignore", "node_modules/\n");
  git(product, "submodule", "add", "-q", dsRepo, "design-system");
  await fs.mkdir(path.join(product, "web/src/styles"), { recursive: true });
  await fs.symlink("../../../design-system/src/styles/ds", path.join(product, "web/src/styles/ds"));
  await fs.symlink("../design-system/public/ds.js", path.join(product, "web/ds.js"));
  git(product, "add", ".");
  git(product, "commit", "-q", "-m", "Product");
  return { product, dsRepo };
}

test("removes a .gitmodules section by path and reports when nothing remains", () => {
  const two = '[submodule "design-system"]\n\tpath = design-system\n\turl = ../ds.git\n\tbranch = main\n[submodule "other"]\n\tpath = vendor/other\n\turl = ../other.git\n';
  assert.equal(removeGitmodulesSection(two, "design-system"), '[submodule "other"]\n\tpath = vendor/other\n\turl = ../other.git\n');
  assert.equal(removeGitmodulesSection(two, "vendor/other"), '[submodule "design-system"]\n\tpath = design-system\n\turl = ../ds.git\n\tbranch = main\n');
  assert.equal(removeGitmodulesSection('[submodule "design-system"]\n\tpath = design-system/\n\turl = x\n', "design-system"), null);
  assert.equal(removeGitmodulesSection("", "design-system"), null);
});

test("migrates a submodule product to a published pin at the checkout's version, in one reviewable change", async (t) => {
  const { product } = await submoduleProduct(t);
  const fetchImpl = publishedSystem();
  const lines = [];
  const result = await migrateConsumerToPublished(product, { url: BASE, fetchImpl, output: (line) => lines.push(line) });
  assert.deepEqual([result.version, result.checkoutVersion, result.url, result.synced.status, result.synced.version], ["1.3.0", "1.3.0", BASE, "synced", "1.3.0"]);
  assert.deepEqual(result.removed, ["submodule deinit", "gitlink design-system", ".git/modules/design-system", ".gitmodules", "design-system/ checkout"]);

  // The submodule is gone from the index, the module store, and .gitmodules.
  assert.equal(git(product, "ls-files", "-s", "--", "design-system"), "");
  assert.ok(!existsSync(path.join(product, ".gitmodules")));
  assert.ok(!existsSync(path.join(product, ".git", "modules", "design-system")));
  assert.equal(git(product, "ls-files", "--", ".gitmodules"), "", ".gitmodules is removed from the index");

  // The pin, the postinstall, the ignore line, and the published-mode skill follow.
  const manifest = JSON.parse(await fs.readFile(path.join(product, CONSUMER_MANIFEST_FILE), "utf8"));
  assert.deepEqual(manifest.designSystem, { path: "design-system", systemId: "acme/core", version: "1.3.0", url: BASE });
  const packageJson = JSON.parse(await fs.readFile(path.join(product, "package.json"), "utf8"));
  assert.equal(packageJson.scripts.postinstall, "timds consumer sync");
  assert.match(await fs.readFile(path.join(product, ".gitignore"), "utf8"), /^design-system\/$/m);
  const skill = await fs.readFile(path.join(product, ".agents/skills/timds-consume-design-system/SKILL.md"), "utf8");
  assert.match(skill, /fetches the pinned\n   Design System bundle \(version 1\.3\.0\)/);

  // The bundle is in place under the old paths, so the product's stylesheet symlink still resolves; the script's does not.
  assert.equal(await fs.readFile(path.join(product, "web/src/styles/ds/brand.css"), "utf8"), ".brand{}");
  assert.deepEqual(result.dangling, [{ path: "web/ds.js", target: "design-system/public/ds.js" }]);
  assert.match(lines.join("\n"), /Warning: web\/ds\.js links to design-system\/public\/ds\.js, which the published bundle does not include; add it to bundle\.include/);

  // Product-owned files that still mention the submodule are listed, never edited.
  assert.deepEqual(result.mentions.map((mention) => mention.path), ["scripts/deploy.sh"]);
  assert.match(lines.join("\n"), /scripts\/deploy\.sh\n\s+2: git submodule update --init design-system/);
  assert.equal(await fs.readFile(path.join(product, "scripts/deploy.sh"), "utf8"), "#!/bin/sh\ngit submodule update --init design-system\n");
  assert.match(lines.join("\n"), /^Migrated acme\/core from the design-system submodule to a published pin at version 1\.3\.0\.$/m);

  // What is left is a published consumer that passes check and whose diff is the migration.
  const consumer = await loadConsumer(product);
  assert.deepEqual([consumer.designSystem.mode, consumer.designSystem.commit, consumer.designSystem.present], ["published", null, true]);
  const checked = await checkConsumer(product);
  assert.equal(checked.status, "passed", checked.errors.join("\n"));
  const status = git(product, "status", "--porcelain", "--untracked-files=all").split("\n").map((line) => line.trim()).sort();
  assert.ok(status.includes("D  .gitmodules"), status.join("\n"));
  assert.ok(status.includes("D  design-system"), status.join("\n"));
  assert.ok(status.some((line) => line.endsWith(CONSUMER_MANIFEST_FILE)));
  assert.ok(!status.some((line) => /^\?\? design-system\//.test(line)), "the fetched bundle is ignored");

  // Migrating twice is a no-op with a pointer to sync.
  await assert.rejects(migrateConsumerToPublished(product, { url: BASE, fetchImpl, output: () => {} }), /already pins a published version \(1\.3\.0\); nothing to migrate/);
});

test("refuses a dirty tree, an unpublished version, and a product without the submodule, before changing anything", async (t) => {
  const { product } = await submoduleProduct(t, { version: "1.4.0" });
  const fetchImpl = publishedSystem();
  await fs.writeFile(path.join(product, "web/package.json"), "{}");
  await assert.rejects(migrateConsumerToPublished(product, { url: BASE, fetchImpl, output: () => {} }), /working tree has uncommitted changes:\n\s+ M web\/package\.json/);
  git(product, "checkout", "--", "web/package.json");

  // 1.4.0 is what the checkout declares, but only 1.3.0 is published.
  await assert.rejects(migrateConsumerToPublished(product, { url: BASE, fetchImpl, output: () => {} }), /version 1\.4\.0 is not usable as a published pin: Design System version 1\.4\.0's bundle is not published[\s\S]*pass --version/);
  assert.notEqual(git(product, "ls-files", "-s", "--", "design-system"), "", "nothing was removed");
  assert.ok(existsSync(path.join(product, ".gitmodules")));

  // --version overrides the checkout's declaration; --skip-sync migrates offline.
  const lines = [];
  const result = await migrateConsumerToPublished(product, { version: "1.3.0", url: BASE, fetchImpl, output: (line) => lines.push(line) });
  assert.deepEqual([result.version, result.checkoutVersion], ["1.3.0", "1.4.0"]);
  assert.match(lines.join("\n"), /at version 1\.3\.0 \(the checkout declared 1\.4\.0\)/);

  const bare = await temporaryDirectory(t);
  initRepo(bare);
  await write(bare, CONSUMER_MANIFEST_FILE, { schemaVersion: 1, designSystem: { path: "design-system", systemId: "acme/core" }, apps: { web: { cwd: "web", preview: { build: ["npm", "run", "build"], output: "dist" }, designSurface: ["src/**"] } } });
  git(bare, "add", ".");
  git(bare, "commit", "-q", "-m", "bare");
  await assert.rejects(migrateConsumerToPublished(bare, { fetchImpl, output: () => {} }), /design-system is not a git submodule here; pin a published version directly with timds consumer init --system acme\/core/);
});

test("migrates offline with --skip-sync, keeping other submodules, and routes through the CLI", async (t) => {
  const { product, dsRepo } = await submoduleProduct(t);
  git(product, "submodule", "add", "-q", dsRepo, "vendor/other");
  git(product, "commit", "-q", "-am", "second submodule");
  const result = await migrateConsumerToPublished(product, { skipSync: true, fetchImpl: async () => { throw new Error("no network"); }, output: () => {} });
  assert.equal(result.synced, null);
  assert.deepEqual(result.dangling, []);
  assert.equal(await fs.readFile(path.join(product, ".gitmodules"), "utf8"), `[submodule "vendor/other"]\n\tpath = vendor/other\n\turl = ${dsRepo}\n`);
  assert.ok(result.removed.includes(".gitmodules entry for design-system"));
  const checked = await checkConsumer(product);
  assert.match(checked.errors.join("\n"), /has no synced Design System bundle/, "offline, the sync is still to come");

  await assert.rejects(runConsumerCli(["migrate", "--bogus"]), /Unknown option --bogus/);
  const lines = [];
  await runConsumerCli(["migrate", "--help"], { output: (line) => lines.push(line) });
  assert.match(lines.join("\n"), /timds consumer migrate \[--version VERSION\]/);
});

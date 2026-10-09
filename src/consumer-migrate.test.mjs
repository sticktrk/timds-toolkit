import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CONSUMER_MANIFEST_FILE, checkConsumer, loadConsumer, runConsumerCli } from "./consumer.mjs";
import { initializeConsumer, renderConsumerSkill } from "./consumer-init.mjs";
import { migrateConsumerToPublished, removeGitmodulesSection } from "./consumer-migrate.mjs";

const BASE = "https://cdn.test/acme/core/artifact";
const toolkitPackage = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
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
async function submoduleProduct(t, { version = "1.3.0", designSystemPath = "design-system", moduleName = null } = {}) {
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
  await write(product, CONSUMER_MANIFEST_FILE, { schemaVersion: 1, designSystem: { path: designSystemPath, systemId: "acme/core" }, apps: { web: { cwd: "web", preview: { build: ["npm", "run", "build"], output: "dist" }, designSurface: ["src/**"] } } });
  await write(product, "package.json", { name: "product", private: true, scripts: { timds: "timds" }, devDependencies: { "@dtconcepts/timds": "0.1.x" } });
  await write(product, "package-lock.json", { lockfileVersion: 3, packages: {
    "": { name: "product", devDependencies: { "@dtconcepts/timds": "0.1.x" } },
    "node_modules/@dtconcepts/timds": { version: toolkitPackage.version },
  } });
  await write(product, "web/package.json", { name: "web" });
  await write(product, "scripts/deploy.sh", "#!/bin/sh\ngit submodule update --init design-system\n");
  await write(product, ".gitignore", "node_modules/\n");
  git(product, "submodule", "add", "-q", ...(moduleName ? ["--name", moduleName] : []), dsRepo, designSystemPath);
  await fs.mkdir(path.join(product, "web/src/styles"), { recursive: true });
  await fs.symlink(path.relative(path.join(product, "web/src/styles"), path.join(product, designSystemPath, "src/styles/ds")), path.join(product, "web/src/styles/ds"));
  await fs.symlink(path.relative(path.join(product, "web"), path.join(product, designSystemPath, "public/ds.js")), path.join(product, "web/ds.js"));
  git(product, "add", ".");
  git(product, "commit", "-q", "-m", "Product");
  return { product, dsRepo };
}

/** Bytes, links, directories, Git registration, and staged entries to preserve on refusal/failure. */
async function productState(product) {
  const tree = {};
  const visit = async (relative) => {
    for (const name of (await fs.readdir(path.join(product, relative))).sort()) {
      if (name === ".git") continue;
      const child = path.join(relative, name);
      const absolute = path.join(product, child);
      const info = await fs.lstat(absolute);
      if (info.isSymbolicLink()) tree[child] = { link: await fs.readlink(absolute) };
      else if (info.isDirectory()) {
        tree[child] = { directory: true };
        await visit(child);
      } else tree[child] = { bytes: (await fs.readFile(absolute)).toString("base64"), mode: info.mode };
    }
  };
  await visit("");
  return {
    tree,
    status: git(product, "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"),
    index: git(product, "ls-files", "--stage"),
    config: await fs.readFile(path.resolve(product, git(product, "rev-parse", "--git-path", "config")), "utf8"),
    submodules: git(product, "submodule", "status"),
  };
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

test("refuses modified, staged, or untracked submodule work even with --force and ignore settings", async (t) => {
  for (const kind of ["modified", "staged", "untracked"]) await t.test(kind, async (t) => {
    const { product } = await submoduleProduct(t);
    const dsRoot = path.join(product, "design-system");
    const relative = kind === "untracked" ? "draft.txt" : "src/styles/ds/brand.css";
    await write(dsRoot, relative, "local design work");
    if (kind === "staged") git(dsRoot, "add", relative);
    git(product, "config", "submodule.design-system.ignore", "all");
    const before = await productState(product);
    await assert.rejects(migrateConsumerToPublished(product, { force: true, skipSync: true }), /design-system submodule has uncommitted changes/);
    assert.deepEqual(await productState(product), before);
    assert.equal(await fs.readFile(path.join(dsRoot, relative), "utf8"), "local design work");
    assert.equal(git(dsRoot, "rev-parse", "HEAD"), (await loadConsumer(product)).designSystem.commit);
  });
});

test("refuses untracked product files and a checkout ahead of the gitlink", async (t) => {
  const { product } = await submoduleProduct(t);
  await write(product, "draft.txt", "product draft");
  const before = await productState(product);
  await assert.rejects(migrateConsumerToPublished(product, { skipSync: true }), /working tree has uncommitted changes:[\s\S]*draft\.txt/);
  assert.deepEqual(await productState(product), before);
  await fs.rm(path.join(product, "draft.txt"));
  const dsRoot = path.join(product, "design-system");
  git(dsRoot, "config", "user.email", "timds-test@example.com");
  git(dsRoot, "config", "user.name", "TimDS Test");
  git(dsRoot, "config", "commit.gpgsign", "false");
  await write(dsRoot, "src/styles/ds/brand.css", "new release");
  git(dsRoot, "commit", "-q", "-am", "local release");
  const ahead = await productState(product);
  await assert.rejects(migrateConsumerToPublished(product, { skipSync: true }), /working tree has uncommitted changes:[\s\S]*design-system/);
  assert.deepEqual(await productState(product), ahead);
});

test("--force replaces customized managed files while preserving the manifest and foreign entries", async (t) => {
  const designSystemPath = "vendor/design-library";
  const { product } = await submoduleProduct(t, { designSystemPath, moduleName: "brand-library" });
  const manifestPath = path.join(product, CONSUMER_MANIFEST_FILE);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.$schema = "https://example.test/consumer.schema.json";
  manifest.apps = { storefront: { ...manifest.apps.web, preview: { build: ["npm", "run", "custom-build"], output: "site", viewports: ["tablet"], schemes: ["dark"] }, designSurface: ["src/styles/**"], protected: ["src/server/**"] } };
  await write(product, CONSUMER_MANIFEST_FILE, manifest);
  await initializeConsumer(product, { skipInstall: true, portalUrl: "https://portal.example.test" });
  const skillPath = path.join(product, ".agents/skills/timds-consume-design-system/SKILL.md");
  await fs.appendFile(skillPath, "\nCustomized guidance\n");
  const mcp = JSON.parse(await fs.readFile(path.join(product, ".mcp.json"), "utf8"));
  mcp.mcpServers.other = { command: "node", args: ["tools.mjs"] };
  await write(product, ".mcp.json", mcp);
  const launch = { configurations: [{ name: "other app", runtimeExecutable: "node", runtimeArgs: ["dev.mjs"] }] };
  await write(product, ".claude/launch.json", launch);
  const installation = JSON.parse(await fs.readFile(path.join(product, ".timds/installation.json"), "utf8"));
  installation.productSettings = { keep: true };
  await write(product, ".timds/installation.json", installation);
  git(product, "add", ".");
  git(product, "commit", "-q", "-m", "custom consumer settings");

  const result = await migrateConsumerToPublished(product, { force: true, url: BASE, fetchImpl: publishedSystem() });
  const expected = { ...manifest, designSystem: { ...manifest.designSystem, version: "1.3.0", url: BASE } };
  assert.deepEqual(JSON.parse(await fs.readFile(manifestPath, "utf8")), expected);
  assert.equal(await fs.readFile(skillPath, "utf8"), await renderConsumerSkill(expected));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(product, ".mcp.json"), "utf8")), mcp);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(product, ".claude/launch.json"), "utf8")), launch);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(product, ".timds/installation.json"), "utf8")).productSettings, { keep: true });
  assert.equal(existsSync(path.join(product, ".git/modules/brand-library")), false);
  assert.equal(result.synced.location, path.join(product, designSystemPath));
  const checked = await checkConsumer(product);
  assert.equal(checked.status, "passed", checked.errors.join("\n"));
});

test("preflights managed-file and package conflicts without changing the product", async (t) => {
  for (const kind of ["skill", "package"]) await t.test(kind, async (t) => {
    const { product } = await submoduleProduct(t);
    await initializeConsumer(product, { skipInstall: true });
    if (kind === "skill") await fs.appendFile(path.join(product, ".agents/skills/timds-consume-design-system/SKILL.md"), "\nCustom guidance\n");
    else {
      const pkg = JSON.parse(await fs.readFile(path.join(product, "package.json"), "utf8"));
      pkg.scripts.timds = "custom timds";
      await write(product, "package.json", pkg);
    }
    git(product, "add", ".");
    git(product, "commit", "-q", "-m", "customized consumer setup");
    const before = await productState(product);
    await assert.rejects(migrateConsumerToPublished(product, { url: BASE, fetchImpl: publishedSystem() }), kind === "skill" ? /Refusing to replace customized TimDS consumer files:[\s\S]*timds consumer migrate with --force/ : /scripts\.timds is already/);
    assert.deepEqual(await productState(product), before);
    assert.equal(existsSync(path.join(product, "design-system/.git")), true);
  });
});

test("validates replacement pin options before removal, including offline migration", async (t) => {
  const { product } = await submoduleProduct(t);
  const before = await productState(product);
  for (const options of [{ version: "invalid version" }, { url: "file:///invalid" }]) {
    await assert.rejects(migrateConsumerToPublished(product, { ...options, skipSync: true }), /timds\.consumer\.json is invalid/);
    assert.deepEqual(await productState(product), before);
  }
});

test("verifies bundle payloads before removing the submodule", async (t) => {
  for (const kind of ["missing", "digest"]) await t.test(kind, async (t) => {
    const { product } = await submoduleProduct(t);
    const before = await productState(product);
    const published = publishedSystem();
    const fetchImpl = (url) => String(url).includes("/bundle/") ? new Response("bad payload", { status: kind === "missing" ? 404 : 200 }) : published(url);
    await assert.rejects(migrateConsumerToPublished(product, { url: BASE, fetchImpl }), kind === "missing" ? /not usable as a published pin:[\s\S]*responded 404/ : /does not match the digest/);
    assert.deepEqual(await productState(product), before);
  });
});

test("refuses submodule work that appears during bundle preflight", async (t) => {
  const { product } = await submoduleProduct(t);
  const stylesheet = path.join(product, "design-system/src/styles/ds/brand.css");
  const before = await productState(product);
  const published = publishedSystem();
  const fetchImpl = async (url) => {
    if (String(url).includes("/bundle/")) await fs.writeFile(stylesheet, "work during download");
    return published(url);
  };
  await assert.rejects(migrateConsumerToPublished(product, { url: BASE, fetchImpl }), /submodule has uncommitted changes/);
  assert.equal(await fs.readFile(stylesheet, "utf8"), "work during download");
  await fs.writeFile(stylesheet, ".brand{}");
  assert.deepEqual(await productState(product), before);
});

test("rolls back a failed managed write and can retry, with initialized or absent checkouts", async (t) => {
  for (const initialized of [true, false]) await t.test(initialized ? "initialized" : "absent", async (t) => {
    const { product, dsRepo } = await submoduleProduct(t);
    git(product, "submodule", "add", "-q", dsRepo, "vendor/other");
    git(product, "commit", "-q", "-am", "second submodule");
    if (!initialized) {
      git(product, "submodule", "deinit", "-f", "--", "design-system");
      await fs.rm(path.join(product, "design-system"), { recursive: true });
    }
    const before = await productState(product);
    const originalWrite = fs.writeFile;
    let failed = false;
    t.mock.method(fs, "writeFile", async (target, ...args) => {
      if (!failed && target === path.join(product, ".timds/installation.json")) {
        failed = true;
        throw new Error("simulated installation write failure");
      }
      return originalWrite(target, ...args);
    });
    await assert.rejects(migrateConsumerToPublished(product, { version: "1.3.0", url: BASE, fetchImpl: publishedSystem() }), /original checkout, Git state, and files were restored: simulated installation write failure/);
    assert.equal(failed, true);
    assert.deepEqual(await productState(product), before);
    assert.equal(existsSync(path.join(product, ".agents")), false);
    assert.equal(existsSync(path.join(product, ".timds")), false);
    assert.ok(!(await fs.readdir(path.join(product, ".git"))).some((name) => name.startsWith("timds-consumer-migrate-")));
    t.mock.restoreAll();
    const result = await migrateConsumerToPublished(product, { version: "1.3.0", url: BASE, fetchImpl: publishedSystem() });
    assert.equal(result.synced.status, "synced");
    const checked = await checkConsumer(product);
    assert.equal(checked.status, "passed", checked.errors.join("\n"));
    assert.equal(git(path.join(product, "vendor/other"), "rev-parse", "HEAD"), git(dsRepo, "rev-parse", "HEAD"));
  });
});

test("rolls back a bundle installation failure after managed files have been written", async (t) => {
  const { product } = await submoduleProduct(t);
  await initializeConsumer(product, { skipInstall: true });
  git(product, "add", ".");
  git(product, "commit", "-q", "-m", "consumer installation");
  const before = await productState(product);
  const copy = fs.cp;
  t.mock.method(fs, "cp", async (source, target, options) => {
    await copy(source, target, options);
    if (target === path.join(product, "design-system")) throw new Error("simulated bundle installation failure");
  });
  await assert.rejects(migrateConsumerToPublished(product, { url: BASE, fetchImpl: publishedSystem() }), /files were restored: simulated bundle installation failure/);
  assert.deepEqual(await productState(product), before);
  assert.equal(existsSync(path.join(product, "design-system/.timds-bundle.json")), false);
  assert.equal(git(path.join(product, "design-system"), "rev-parse", "HEAD"), (await loadConsumer(product)).designSystem.commit);
});

test("preflights an older toolkit lock before removing the submodule and rolls the lock back with later writes", async (t) => {
  const { product } = await submoduleProduct(t);
  const lockPath = path.join(product, "package-lock.json");
  const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
  lock.packages["node_modules/@dtconcepts/timds"].version = "0.1.451";
  await write(product, "package-lock.json", lock);
  git(product, "add", ".");
  git(product, "commit", "-qm", "Older toolkit lock");
  const before = await productState(product);
  await assert.rejects(migrateConsumerToPublished(product, { skipSync: true, runNpm: async () => {
    assert.ok(existsSync(path.join(product, "design-system/.git")), "the submodule remains during lock preflight");
    await fs.writeFile(lockPath, "partial lock");
    throw new Error("registry unavailable");
  } }), /Could not refresh the locked toolkit[\s\S]*registry unavailable/);
  assert.deepEqual(await productState(product), before);

  const runNpm = async (_command, args, { cwd }) => {
    assert.deepEqual(args, ["install", "--package-lock-only", "--ignore-scripts"]);
    const pkg = JSON.parse(await fs.readFile(path.join(cwd, "package.json"), "utf8"));
    assert.equal(pkg.devDependencies[toolkitPackage.name], toolkitPackage.version);
    const selected = structuredClone(lock);
    selected.packages[""].devDependencies[toolkitPackage.name] = toolkitPackage.version;
    selected.packages["node_modules/@dtconcepts/timds"].version = toolkitPackage.version;
    await write(product, "package-lock.json", selected);
  };
  const originalCopy = fs.cp;
  t.mock.method(fs, "cp", async (source, target, options) => {
    await originalCopy(source, target, options);
    if (target === path.join(product, "design-system")) throw new Error("bundle write failed");
  });
  await assert.rejects(migrateConsumerToPublished(product, { url: BASE, fetchImpl: publishedSystem(), runNpm }), /files were restored: bundle write failed/);
  assert.deepEqual(await productState(product), before, "later failures restore the old lock with the checkout and managed files");
});

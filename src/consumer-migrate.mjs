// `timds consumer migrate`: move a product from the Design System submodule
// to a published pin, in one reviewable change.
//
// The first consumers carried their Design System as the `design-system`
// git submodule. The published pin (consumer-sync.mjs) replaces that with a
// version in `timds.consumer.json` and a gitignored directory `npm install`
// fills, under the same paths the submodule had, so a product's existing
// symlinks into it keep resolving. Migrate does the mechanical part:
//
//   1. reads the version the product is built against from the checked-out
//      submodule's own timds.json (or takes --version), so the pin starts
//      exactly where the gitlink was;
//   2. validates the installation plan and downloads the full bundle, then
//      removes the submodule: deinit, the gitlink, `.git/modules/<name>`, the
//      `.gitmodules` section, the checkout on disk;
//   3. rewrites the manifest with the pin, then applies init's plan so
//      package.json gets the postinstall sync, .gitignore the directory, and
//      the managed skill its published-mode text;
//   4. installs the verified bundle and confirms every tracked symlink into the directory
//      still resolves, naming the ones the bundle does not cover.
//
// What it does not do is edit product-owned files. A deploy script that runs
// `git submodule update`, a hook that guards the gitlink, a README that
// explains the checkout: those are listed at the end for a developer. The
// working tree must be clean so the whole migration is one diff to review.

import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { spawn } from "node:child_process";

import { CONSUMER_MANIFEST_FILE, loadConsumer, publishedBaseUrl, validateConsumerManifest } from "./consumer.mjs";
import { applyConsumerInstallation, planConsumerInstallation, prepareConsumerInstallation } from "./consumer-init.mjs";
import { syncConsumerBundle } from "./consumer-sync.mjs";

const MIGRATE_HELP = `Usage:
  timds consumer migrate [--version VERSION] [--url URL] [--root PATH] [--force] [--skip-sync]

Replaces the Design System git submodule with a published pin: removes the
submodule, its .gitmodules entry, and the checkout; pins designSystem.version
in ${CONSUMER_MANIFEST_FILE} (default: the version the checked-out submodule
declares); adds the postinstall sync and the .gitignore line; re-renders the
managed files for the published mode (--force replaces customized ones,
preserving the manifest's app settings); resolves a missing or older toolkit
lock to the running release, keeping the bounded dependency range; and
syncs the bundle. Product files that still mention the submodule are listed
for a developer. The product and submodule working trees must be clean.
The bundle and installation are validated before removal; a failed write
restores the checkout, Git state, and files.`;

// Product-owned places a submodule typically leaks into; migrate reports, never edits.
const MENTION_ROOTS = ["scripts", ".githooks", ".github", "deploy", "docs", "AGENTS.md", "CLAUDE.md", "README.md", "DESIGN_SYSTEM.md", "package.json"];
const MENTION_SKIP = new Set(["node_modules", ".git", ".timds"]);
const MENTION_LIMIT = 40;

function run(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: error.message }));
    child.on("close", (code) => resolve({ code: Number(code ?? -1), stdout, stderr }));
  });
}
const git = (args, cwd) => run("git", args, cwd);

async function requireGit(args, cwd, what) {
  const result = await git(args, cwd);
  if (result.code !== 0) throw new Error(`${what} failed: ${(result.stderr || result.stdout).trim().split("\n").at(-1) || `git ${args.join(" ")}`}`);
  return result.stdout;
}

async function requireCleanTree(repoRoot, designSystem) {
  // Inspect the submodule itself too: its status may be hidden by a user's
  // submodule ignore settings, and forced deinit would erase untracked work.
  if (existsSync(path.join(designSystem.root, ".git"))) {
    const status = await requireGit(["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"], designSystem.root, "git status in the Design System");
    if (status.trim()) throw new Error(`The ${designSystem.path} submodule has uncommitted changes:\n${status.trim()}\nPreserve this work in a separate Design System checkout before migrating; this checkout will be removed.`);
  }
  const status = await requireGit(["status", "--porcelain", "-z", "--untracked-files=all", "--ignore-submodules=none"], repoRoot, "git status");
  // A gitlink whose checkout is absent can be migrated with --version; there
  // is no local checkout to lose. A staged removal still counts as a change.
  const changes = status.split("\0").filter((entry) => entry && !(entry === ` D ${designSystem.path}` && !existsSync(designSystem.root)));
  if (changes.length) {
    throw new Error(`The working tree has uncommitted changes:\n${changes.slice(0, 10).map((line) => `  ${line}`).join("\n")}\nCommit or stash them so the migration is one change to review.`);
  }
}

/** The module store uses the registered name, which need not be its path. */
async function moduleStore(repoRoot, designSystemPath) {
  const entries = await git(["config", "--file", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"], repoRoot);
  for (const line of entries.stdout.split("\n")) {
    const match = /^submodule\.(.+)\.path\s+(.+)$/.exec(line);
    if (match && match[2].replace(/\/+$/, "") === designSystemPath) {
      const location = await requireGit(["rev-parse", "--git-path", `modules/${match[1]}`], repoRoot, "locating the submodule store");
      return path.resolve(repoRoot, location.trim());
    }
  }
  return null;
}

/** Snapshot only migration writes and Git metadata; move the checkout later. */
async function migrationBackup(repoRoot, designSystem, writes) {
  const gitDirectory = (await requireGit(["rev-parse", "--absolute-git-dir"], repoRoot, "locating the Git directory")).trim();
  const directory = await fs.mkdtemp(path.join(gitDirectory, "timds-consumer-migrate-"));
  const files = [];
  const missingDirectories = new Set();
  try {
    const paths = [path.join(repoRoot, ".gitmodules"), ...writes.map((file) => path.join(repoRoot, file.path))];
    for (const name of ["index", "config"]) {
      paths.push(path.resolve(repoRoot, (await requireGit(["rev-parse", "--git-path", name], repoRoot, `locating Git ${name}`)).trim()));
    }
    for (const absolute of new Set(paths)) {
      let info = null;
      try { info = await fs.lstat(absolute); } catch (error) { if (error.code !== "ENOENT") throw error; }
      const copy = path.join(directory, `file-${files.length}`);
      if (info) await fs.copyFile(absolute, copy);
      files.push({ absolute, copy: info ? copy : null, mode: info?.mode, link: info?.isSymbolicLink() ? await fs.readlink(absolute) : null });
      for (let parent = path.dirname(absolute); parent.startsWith(`${repoRoot}${path.sep}`) && !existsSync(parent); parent = path.dirname(parent)) {
        missingDirectories.add(parent);
      }
    }
    const modules = await moduleStore(repoRoot, designSystem.path);
    await fs.writeFile(path.join(directory, "files.json"), `${JSON.stringify({ files, checkout: designSystem.root, modules }, null, 2)}\n`);
    return { directory, files, missingDirectories, modules, checkoutExisted: existsSync(designSystem.root), checkoutMoved: false, modulesMoved: false };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function restoreMigration(backup, designSystem) {
  if (!backup.checkoutExisted || backup.checkoutMoved) await fs.rm(designSystem.root, { recursive: true, force: true });
  if (backup.checkoutMoved) {
    await fs.rename(path.join(backup.directory, "checkout"), designSystem.root);
  }
  if (backup.modulesMoved) await fs.rename(path.join(backup.directory, "modules"), backup.modules);
  for (const file of backup.files) {
    if (!file.copy) {
      await fs.rm(file.absolute, { force: true });
      continue;
    }
    await fs.mkdir(path.dirname(file.absolute), { recursive: true });
    if (file.link !== null) {
      await fs.rm(file.absolute, { force: true });
      await fs.symlink(file.link, file.absolute);
    }
    await fs.copyFile(file.copy, file.absolute);
    if (file.link === null) await fs.chmod(file.absolute, file.mode);
  }
  for (const directory of [...backup.missingDirectories].sort((a, b) => b.length - a.length)) {
    try { await fs.rmdir(directory); } catch (error) { if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error; }
  }
}

/** `.gitmodules` without the section whose path is `designSystemPath`; null when nothing else remains. */
export function removeGitmodulesSection(text, designSystemPath) {
  const lines = String(text ?? "").split(/\r?\n/);
  const sections = [];
  let current = null;
  for (const line of lines) {
    const header = /^\s*\[submodule\s+"(.*)"\]\s*$/.exec(line);
    if (header) {
      current = { name: header[1], lines: [line], path: null };
      sections.push(current);
      continue;
    }
    if (!current) {
      sections.push({ name: null, lines: [line], path: null });
      current = null;
      continue;
    }
    const pathLine = /^\s*path\s*=\s*(.+?)\s*$/.exec(line);
    if (pathLine) current.path = pathLine[1].replace(/\/+$/, "");
    current.lines.push(line);
  }
  const kept = sections.filter((section) => section.path !== designSystemPath);
  if (!kept.some((section) => section.name !== null)) return null;
  return `${kept.flatMap((section) => section.lines).join("\n").replace(/\n+$/, "")}\n`;
}

/** Every tracked symbolic link in the repository with its target, from the index. */
export async function trackedSymlinks(repoRoot) {
  const listing = await git(["ls-files", "-s", "-z"], repoRoot);
  if (listing.code !== 0) return [];
  const links = [];
  for (const entry of listing.stdout.split("\0")) {
    const match = /^120000 [0-9a-f]+ \d\t(.+)$/.exec(entry);
    if (!match) continue;
    try {
      links.push({ path: match[1], target: await fs.readlink(path.join(repoRoot, match[1])) });
    } catch {
      // A link the working tree lacks is not ours to judge.
    }
  }
  return links;
}

/** Product files that still mention the submodule by path or by `submodule`, for the developer's list. */
async function submoduleMentions(repoRoot, designSystemPath) {
  const found = [];
  const pattern = new RegExp(`submodule|\\b${designSystemPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`, "i");
  const visit = async (absolute, relative) => {
    if (found.length >= MENTION_LIMIT) return;
    let info;
    try {
      info = await fs.lstat(absolute);
    } catch {
      return;
    }
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      for (const entry of (await fs.readdir(absolute)).sort()) {
        if (MENTION_SKIP.has(entry)) continue;
        await visit(path.join(absolute, entry), relative ? `${relative}/${entry}` : entry);
      }
      return;
    }
    if (!info.isFile() || info.size > 2_000_000) return;
    // The managed TimDS files are rewritten by migrate itself.
    if (relative.startsWith(".agents/skills/timds-") || /^\.github\/workflows\/timds-/.test(relative)) return;
    let text;
    try {
      text = await fs.readFile(absolute, "utf8");
    } catch {
      return;
    }
    if (text.includes("\0")) return;
    const hits = [];
    text.split(/\r?\n/).forEach((line, index) => {
      if (hits.length < 3 && pattern.test(line)) hits.push(`${index + 1}: ${line.trim().slice(0, 120)}`);
    });
    if (hits.length) found.push({ path: relative, hits });
  };
  for (const root of MENTION_ROOTS) await visit(path.join(repoRoot, root), root);
  return found;
}

/**
 * Migrate the product at `rootInput` from the submodule pin to a published
 * one. Returns what was done; refuses before changing anything when the
 * manifest already pins a version, the tree is dirty, or no version can be
 * determined.
 */
export async function migrateConsumerToPublished(rootInput = process.cwd(), { version = null, url = null, force = false, skipSync = false, fetchImpl = fetch, runNpm, output = () => {} } = {}) {
  const consumer = await loadConsumer(rootInput);
  const { designSystem, manifestPath, repoRoot } = consumer;
  if (designSystem.mode === "published") {
    throw new Error(`${CONSUMER_MANIFEST_FILE} already pins a published version (${designSystem.version}); nothing to migrate. Run timds consumer sync.`);
  }
  if (!designSystem.commit) {
    throw new Error(`${designSystem.path} is not a git submodule here; pin a published version directly with timds consumer init --system ${designSystem.systemId}.`);
  }
  await requireCleanTree(repoRoot, designSystem);

  // The pin starts where the gitlink was: the version the checkout declares.
  let pinned = version ? String(version).trim() : null;
  let checkoutVersion = null;
  if (designSystem.present) {
    try {
      checkoutVersion = String(JSON.parse(await fs.readFile(path.join(designSystem.root, "timds.json"), "utf8")).version || "").trim() || null;
    } catch {
      checkoutVersion = null;
    }
  }
  if (!pinned) pinned = checkoutVersion;
  if (!pinned) {
    throw new Error(`Could not read the Design System version from ${designSystem.path}/timds.json${designSystem.present ? "" : " (the submodule is not checked out)"}. Pass --version with the published version this product is built against.`);
  }
  const base = url ? String(url).replace(/\/+$/, "") : publishedBaseUrl({ systemId: designSystem.systemId });
  const raw = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  raw.designSystem = { ...raw.designSystem, version: pinned, ...(url ? { url: base } : {}) };
  validateConsumerManifest(raw);
  const plan = await planConsumerInstallation(repoRoot, raw, { force, command: "timds consumer migrate" });

  // Fetch and verify the complete bundle outside the product before removal.
  // sync also checks any design pairings, so preflight covers the same inputs
  // the final consumer needs, including payload and digest failures.
  const staging = skipSync ? null : await fs.mkdtemp(path.join(os.tmpdir(), "timds-consumer-migrate-"));
  const syncOutput = [];
  const removed = [];
  let written = [];
  let synced = null;
  try {
    if (staging) {
      try {
        await fs.writeFile(path.join(staging, CONSUMER_MANIFEST_FILE), `${JSON.stringify(raw, null, 2)}\n`);
        await fs.writeFile(path.join(staging, ".gitignore"), `${designSystem.path}/\n`);
        synced = await syncConsumerBundle(staging, { fetchImpl, output: (line) => syncOutput.push(line) });
      } catch (error) {
        throw new Error(`Design System ${designSystem.systemId} version ${pinned} is not usable as a published pin: ${error.message}\nPublish that version (timds extract --publish in the Design System), pass --version, or pass --skip-sync to migrate without fetching.`, { cause: error });
      }
    }
    await requireCleanTree(repoRoot, designSystem);
    await prepareConsumerInstallation(repoRoot, plan, { runNpm, output });
    // Downloads and lock resolution may take time; refuse work that appeared while they ran.
    await requireCleanTree(repoRoot, designSystem);
    const backup = await migrationBackup(repoRoot, designSystem, [{ path: CONSUMER_MANIFEST_FILE }, ...plan.writes]);
    try {
      const initialized = designSystem.present || existsSync(path.join(designSystem.root, ".git"));
      // Keep the checkout and module store intact until all writes succeed.
      // Deinit runs against an empty path, so it cannot erase the backup.
      if (backup.checkoutExisted) {
        await fs.rename(designSystem.root, path.join(backup.directory, "checkout"));
        backup.checkoutMoved = true;
      }
      if (initialized) {
        await requireGit(["submodule", "deinit", "-f", "--", designSystem.path], repoRoot, "deinitializing the Design System submodule");
        removed.push("submodule deinit");
      }
      await requireGit(["rm", "-q", "-f", "--cached", "--", designSystem.path], repoRoot, `removing the ${designSystem.path} gitlink`);
      removed.push(`gitlink ${designSystem.path}`);
      if (backup.modules && existsSync(backup.modules)) {
        await fs.rename(backup.modules, path.join(backup.directory, "modules"));
        backup.modulesMoved = true;
        removed.push(path.relative(repoRoot, backup.modules).split(path.sep).join("/"));
      }
      const gitmodulesPath = path.join(repoRoot, ".gitmodules");
      if (existsSync(gitmodulesPath)) {
        const remaining = removeGitmodulesSection(await fs.readFile(gitmodulesPath, "utf8"), designSystem.path);
        if (remaining === null) {
          await requireGit(["rm", "-q", "-f", "--", ".gitmodules"], repoRoot, "removing .gitmodules");
          removed.push(".gitmodules");
        } else {
          await fs.writeFile(gitmodulesPath, remaining, "utf8");
          await requireGit(["add", "--", ".gitmodules"], repoRoot, "staging .gitmodules");
          removed.push(`.gitmodules entry for ${designSystem.path}`);
        }
      }
      await fs.rm(designSystem.root, { force: true, recursive: true });
      removed.push(`${designSystem.path}/ checkout`);
      await fs.writeFile(manifestPath, `${JSON.stringify(raw, null, 2)}\n`);
      written = await applyConsumerInstallation(repoRoot, plan);
      if (staging) {
        await fs.cp(path.join(staging, designSystem.path), designSystem.root, { recursive: true, verbatimSymlinks: true });
        synced.location = designSystem.root;
      }
    } catch (error) {
      try {
        await restoreMigration(backup, designSystem);
      } catch (restoreError) {
        throw new Error(`Migration failed (${error.message}); restoration also failed (${restoreError.message}). The original files are kept at ${backup.directory}.`, { cause: error });
      }
      await fs.rm(backup.directory, { recursive: true, force: true });
      throw new Error(`Migration failed; the original checkout, Git state, and files were restored: ${error.message}`, { cause: error });
    }
    try {
      await fs.rm(backup.directory, { recursive: true, force: true });
    } catch (error) {
      output(`Migration completed, but the temporary backup at ${backup.directory} could not be removed: ${error.message}`);
    }
  } finally {
    if (staging) await fs.rm(staging, { recursive: true, force: true });
  }
  for (const line of syncOutput) output(line);

  // Symlinks into the directory are how the product reaches the system; name the ones the bundle leaves dangling.
  const dangling = [];
  if (synced && synced.status !== "linked") {
    for (const link of await trackedSymlinks(repoRoot)) {
      const resolved = path.resolve(path.dirname(path.join(repoRoot, link.path)), link.target);
      if (!resolved.startsWith(`${designSystem.root}${path.sep}`)) continue;
      if (!existsSync(resolved)) dangling.push({ path: link.path, target: path.relative(repoRoot, resolved).split(path.sep).join("/") });
    }
  }
  const mentions = await submoduleMentions(repoRoot, designSystem.path);

  output(`Migrated ${designSystem.systemId} from the ${designSystem.path} submodule to a published pin at version ${pinned}${checkoutVersion && checkoutVersion !== pinned ? ` (the checkout declared ${checkoutVersion})` : ""}.`);
  for (const item of removed) output(`  removed   ${item}`);
  output(`  pinned    designSystem.version ${pinned} in ${CONSUMER_MANIFEST_FILE}`);
  for (const file of written) output(`  written   ${file}`);
  for (const name of plan.mcpPlan.kept) output(`  kept      ${name} in .mcp.json (customized)`);
  for (const entry of dangling) output(`Warning: ${entry.path} links to ${entry.target}, which the published bundle does not include; add it to bundle.include in the Design System or change the link.`);
  if (mentions.length) {
    output("");
    output("Product files that still mention the submodule (not edited; update or remove by hand):");
    for (const mention of mentions) {
      output(`- ${mention.path}`);
      for (const hit of mention.hits) output(`    ${hit}`);
    }
  }
  output("");
  output(`Review the diff (git status), then commit. ${designSystem.path}/ is ignored by git and fetched by npm install; moving the pin later is timds consumer update.`);

  return { repoRoot, systemId: designSystem.systemId, version: pinned, checkoutVersion, url: base, removed, written, synced, dangling, mentions };
}

function parseMigrateArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("-")) throw new Error(`Unexpected argument ${value}\n${MIGRATE_HELP}`);
    const [rawName, inlineValue] = value.replace(/^--?/, "").split("=", 2);
    const name = rawName.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    if (["force", "help", "skipSync"].includes(name)) {
      options[name] = true;
      continue;
    }
    if (!["root", "version", "url"].includes(name)) throw new Error(`Unknown option --${rawName}\n${MIGRATE_HELP}`);
    const next = inlineValue ?? argv[index + 1];
    if (next === undefined || next === "" || String(next).startsWith("-")) throw new Error(`--${rawName} requires a value`);
    options[name] = next;
    if (inlineValue === undefined) index += 1;
  }
  return options;
}

/** `timds consumer migrate [--version VERSION] [--url URL] [--root PATH] [--force] [--skip-sync]` */
export async function runConsumerMigrate(args = [], { output = (message = "") => process.stdout.write(`${message}\n`) } = {}) {
  const options = parseMigrateArguments(args);
  if (options.help) {
    output(MIGRATE_HELP);
    return null;
  }
  return migrateConsumerToPublished(options.root || process.cwd(), {
    version: options.version ?? null,
    url: options.url ?? null,
    force: Boolean(options.force),
    skipSync: Boolean(options.skipSync),
    output,
  });
}

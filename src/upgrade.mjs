// Dependency selection is explicit. Normal synchronization stays in core.mjs
// (and consumer-init.mjs for product repositories); this command prepares
// dependency and managed-file changes for review in either kind of repository.
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { declaredReleaseLine, isRuntimeDependency as isRuntime } from "./runtime.mjs";
import { releaseLineOf } from "../video/runtime-compat.mjs";

const execute = promisify(execFile);
const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const writeJson = async (file, value) => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
const packageName = "@dtconcepts/timds";
const installedName = (location) => location.split("node_modules/").at(-1);
const exactRelease = (version) => /^\d+\.\d+\.\d+$/u.test(version ?? "");

export function validateLockedRuntime(lock, toolkit) {
  if (![2, 3].includes(lock.lockfileVersion) || !lock.packages) throw new Error("Commit an npm v2/v3 package-lock.json before checking the TimDS dependency graph");
  const required = Object.fromEntries(Object.entries(toolkit.dependencies).filter(([name]) => isRuntime(name)));
  const versions = new Map();
  const locations = new Map();
  for (const [location, item] of Object.entries(lock.packages)) {
    if (!location.includes("node_modules/")) continue;
    const name = installedName(location);
    if (!isRuntime(name) && name !== packageName) continue;
    if (locations.has(name)) throw new Error(`TimDS dependency graph: ${name} has multiple installations at ${locations.get(name)} and ${location}; select compatible dependencies and run npm dedupe before reviewing the lockfile`);
    locations.set(name, location);
    if (!versions.has(name)) versions.set(name, new Set());
    versions.get(name).add(item.version);
    const expected = name === packageName ? toolkit.version : required[name] ?? required.remotion;
    if (item.version !== expected) throw new Error(`TimDS dependency graph: ${location} resolves ${item.version}, expected ${expected}. Adopt TimDS runtime dependency ownership with upgrade --version VERSION --own-runtime, then regenerate and review the lockfile.`);
  }
  for (const name of [packageName, ...Object.keys(required)]) if (!versions.has(name)) throw new Error(`TimDS dependency graph: lockfile is missing ${name}; run the explicit dependency upgrade and commit its lockfile`);
  return {toolkit: toolkit.version, dependencies: required};
}

export async function checkRuntimeDependencies({repoRoot, designSystemRoot}) {
  const pkg = await readJson(path.join(repoRoot, "package.json"));
  const lock = await readJson(path.join(repoRoot, "package-lock.json"));
  for (const key of ["dependencies", "devDependencies", "optionalDependencies"]) {
    if (JSON.stringify(Object.entries(pkg[key] ?? {}).sort()) !== JSON.stringify(Object.entries(lock.packages?.[""]?.[key] ?? {}).sort())) throw new Error(`package.json ${key} differs from the committed lockfile; regenerate it in an upgrade PR`);
  }
  const require = createRequire(path.join(repoRoot, "package.json"));
  const entry = require.resolve(packageName);
  const toolkit = await readJson(path.resolve(path.dirname(entry), "..", "package.json"));
  const result = validateLockedRuntime(lock, toolkit);
  // npm ls verifies installed packages against their parents' requirements as
  // well as the lockfile's single-version policy.
  const installed = await execute("npm", ["ls", "--all", "--json"], {cwd: repoRoot, maxBuffer: 20_000_000}).catch((error) => {
    throw new Error(`Installed dependency graph is invalid; run npm ci from the reviewed lockfile. ${error.stderr || error.message}`);
  });
  const visit = (dependencies) => {
    for (const [name, item] of Object.entries(dependencies ?? {})) {
      if (Object.keys(item).length === 0) continue; // Uninstalled optional platform binaries.
      if (isRuntime(name) || name === packageName) {
        const expected = name === packageName ? toolkit.version : result.dependencies[name] ?? result.dependencies.remotion;
        if (item.version !== expected) throw new Error(`Installed ${name}@${item.version} differs from the locked runtime ${expected}; run npm ci`);
      }
      visit(item.dependencies);
    }
  };
  visit(JSON.parse(installed.stdout).dependencies);
  const metadata = await readJson(path.join(designSystemRoot, ".timds", "installation.json"));
  if (metadata.version !== toolkit.version) throw new Error(`Managed TimDS metadata is ${metadata.version}, installed runtime is ${toolkit.version}; run npm run timds -- upgrade and commit the synchronized managed files`);
  return result;
}

// Shared by design-system and consumer repositories: validate the bounded
// line and the requested version, require a clean tree and a committed
// matching lockfile, and resolve the exact release from the registry.
async function selectRelease(root, version, invoke) {
  const packagePath = path.join(root, "package.json"), lockPath = path.join(root, "package-lock.json");
  const pkg = await readJson(packagePath);
  // The bounded line comes from the repository's own requirement, so moving to
  // a new minor line is an explicit package.json edit, never a toolkit literal.
  const line = declaredReleaseLine(pkg.devDependencies?.[packageName] ?? pkg.dependencies?.[packageName]);
  if (pkg.scripts?.timds !== "timds" || !line) throw new Error("Keep scripts.timds at timds and select a bounded MAJOR.MINOR.x dependency line before upgrading");
  if (version !== line && !(exactRelease(version) && releaseLineOf(version) === line)) throw new Error(`upgrade --version requires an exact stable ${line} release or ${line} to resolve the newest compatible release once`);
  const status = await invoke("git", ["status", "--porcelain", "--untracked-files=all"]);
  if (status.stdout.trim()) throw new Error("Dependency upgrades require a clean working tree; commit or restore existing changes before selecting a release");
  const previousLock = await readJson(lockPath); // A committed baseline is required for rollback and review.
  const dependencyKey = pkg.devDependencies?.[packageName] ? "devDependencies" : "dependencies";
  if (![2, 3].includes(previousLock.lockfileVersion) || previousLock.packages?.[""]?.[dependencyKey]?.[packageName] !== pkg[dependencyKey][packageName]) throw new Error("Commit a matching npm v2/v3 package-lock.json before selecting a dependency upgrade");
  const metadataResult = await invoke("npm", ["view", `${packageName}@${version}`, "version", "dependencies", "--json"]);
  const resolved = JSON.parse(metadataResult.stdout);
  const selected = Array.isArray(resolved) ? [...resolved].sort((a, b) => Number(b.version?.split(".")[2]) - Number(a.version?.split(".")[2]))[0] : resolved;
  if (!exactRelease(selected?.version) || releaseLineOf(selected.version) !== line || (version !== line && selected.version !== version)) throw new Error("Registry returned an unexpected TimDS release");
  return {dependencyKey, lockPath, packagePath, pkg, previousLock, selected};
}

// Resolve the selected release exactly, then restore the bounded manifest
// requirement without re-resolving the tested package graph.
async function lockExactRelease({dedupe = true, dependencyKey, invoke, lockPath, packagePath, pkg, previousLock, selected}) {
  const bounded = pkg[dependencyKey][packageName];
  pkg[dependencyKey][packageName] = selected.version;
  await writeJson(packagePath, pkg);
  let lock;
  try {
    await invoke("npm", ["install", "--ignore-scripts"]);
    if (dedupe) await invoke("npm", ["dedupe", "--ignore-scripts"]);
    lock = await readJson(lockPath);
  } finally {
    pkg[dependencyKey][packageName] = bounded;
    await writeJson(packagePath, pkg);
    lock ??= await readJson(lockPath).catch(() => previousLock);
    lock.packages[""][dependencyKey][packageName] = bounded;
    await writeJson(lockPath, lock);
  }
  return lock;
}

export async function upgradeToRelease(workspace, {version, ownRuntime = false, force = false, run = execute} = {}) {
  const root = workspace.repoRoot;
  const invoke = (command, args) => run(command, args, {cwd: root, maxBuffer: 20_000_000});
  const release = await selectRelease(root, version, invoke);
  const {pkg, selected} = release;
  const installationPath = path.join(workspace.designSystemRoot, ".timds", "installation.json");
  const installation = await readJson(installationPath);
  const ownership = ownRuntime || installation.runtimeDependencyOwnership === "timds-v1";
  const desired = Object.fromEntries(Object.entries(selected.dependencies ?? {}).filter(([name]) => isRuntime(name)));
  if (!desired.react || !desired.remotion) throw new Error("Selected TimDS release does not declare its runtime dependencies");
  for (const key of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, current] of Object.entries(pkg[key] ?? {})) {
      if (!isRuntime(name)) continue;
      const expected = desired[name] ?? desired.remotion;
      if (current !== expected && !ownership) throw new Error(`Direct dependency ${name}@${current} needs ${expected}; opt in once with --own-runtime to let TimDS align existing React/Remotion declarations`);
      if (ownership) pkg[key][name] = expected;
    }
  }
  const lock = await lockExactRelease({...release, invoke});
  validateLockedRuntime(lock, selected);
  await invoke("npm", ["ci"]);
  // The selected package performs synchronization and checks, so new CLI,
  // templates, and skill behavior always come from one release.
  await invoke("npm", ["run", "timds", "--", "upgrade", ...(force ? ["--force"] : [])]);
  if (ownership) {
    const synchronized = await readJson(installationPath);
    synchronized.runtimeDependencyOwnership = "timds-v1";
    await writeJson(installationPath, synchronized);
  }
  await invoke("npm", ["run", "timds", "--", "dependencies", "check"]);
  await invoke("npm", ["run", "timds", "--", "check"]);
  if (pkg.scripts?.["check:timds-upgrade"]) await invoke("npm", ["run", "check:timds-upgrade"]);
  return {version: selected.version, runtimeDependencyOwnership: ownership ? "timds-v1" : null};
}

/**
 * `timds upgrade --version VERSION` in a consumer (product) repository: the
 * same exact selection under the bounded requirement as a Design System, then
 * `npm ci` and the newly installed CLI's `upgrade`, which refreshes the
 * consumer-managed files from that release's templates. A product owns its
 * own React and other dependencies, so there is no runtime alignment, no
 * dedupe of its graph, and no single-version runtime check; only the toolkit
 * entry in the lockfile must resolve the selected release.
 */
export async function upgradeConsumerToRelease(repoRoot, {version, force = false, run = execute} = {}) {
  const invoke = (command, args) => run(command, args, {cwd: repoRoot, maxBuffer: 20_000_000});
  const release = await selectRelease(repoRoot, version, invoke);
  const lock = await lockExactRelease({...release, dedupe: false, invoke});
  const locked = lock.packages?.[`node_modules/${packageName}`]?.version;
  if (locked !== release.selected.version) throw new Error(`package-lock.json resolves ${packageName} to ${locked ?? "nothing"}, expected ${release.selected.version}; review the lockfile before retrying`);
  await invoke("npm", ["ci"]);
  // The selected package refreshes the managed files, so the CLI, workflows,
  // and skill always come from one release.
  await invoke("npm", ["run", "timds", "--", "upgrade", ...(force ? ["--force"] : [])]);
  return {version: release.selected.version};
}

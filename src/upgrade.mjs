// Dependency selection is explicit. Normal synchronization stays in core.mjs;
// this command prepares dependency and managed-file changes for review.
import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const writeJson = async (file, value) => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
const packageName = "@dtconcepts/timds";
const isRuntime = (name) => ["react", "react-dom", "remotion"].includes(name) || name.startsWith("@remotion/");
const installedName = (location) => location.split("node_modules/").at(-1);

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

export async function checkRuntimeDependencies(repoRoot) {
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
  const designSystemRoot = existsSync(path.join(repoRoot, "timds.json")) ? repoRoot : path.join(repoRoot, "design-system");
  const metadata = await readJson(path.join(designSystemRoot, ".timds", "installation.json"));
  if (metadata.version !== toolkit.version) throw new Error(`Managed TimDS metadata is ${metadata.version}, installed runtime is ${toolkit.version}; run npm run timds -- upgrade and commit the synchronized managed files`);
  return result;
}

export async function upgradeToRelease(workspace, {version, ownRuntime = false, force = false, run = execute} = {}) {
  if (!/^(?:0\.1\.\d+|0\.1\.x)$/u.test(version ?? "")) throw new Error("upgrade --version requires an exact stable 0.1.x release or 0.1.x to resolve the newest compatible release once");
  const root = workspace.repoRoot;
  const invoke = (command, args) => run(command, args, {cwd: root, maxBuffer: 20_000_000});
  const status = await invoke("git", ["status", "--porcelain", "--untracked-files=all"]);
  if (status.stdout.trim()) throw new Error("Dependency upgrades require a clean working tree; commit or restore existing changes before selecting a release");
  const packagePath = path.join(root, "package.json"), lockPath = path.join(root, "package-lock.json");
  const pkg = await readJson(packagePath);
  if (pkg.scripts?.timds !== "timds" || !/^(?:0\.1\.x|\^0\.1\.\d+)$/u.test(pkg.devDependencies?.[packageName] ?? pkg.dependencies?.[packageName] ?? "")) throw new Error("Keep scripts.timds at timds and select the bounded 0.1.x dependency line before upgrading");
  const previousLock = await readJson(lockPath); // A committed baseline is required for rollback and review.
  const dependencyKey = pkg.devDependencies?.[packageName] ? "devDependencies" : "dependencies";
  if (![2, 3].includes(previousLock.lockfileVersion) || previousLock.packages?.[""]?.[dependencyKey]?.[packageName] !== pkg[dependencyKey][packageName]) throw new Error("Commit a matching npm v2/v3 package-lock.json before selecting a dependency upgrade");
  const metadataResult = await invoke("npm", ["view", `${packageName}@${version}`, "version", "dependencies", "--json"]);
  const resolved = JSON.parse(metadataResult.stdout);
  const selected = Array.isArray(resolved) ? [...resolved].sort((a, b) => Number(b.version?.split(".")[2]) - Number(a.version?.split(".")[2]))[0] : resolved;
  if (!/^0\.1\.\d+$/u.test(selected?.version ?? "") || (version !== "0.1.x" && selected.version !== version)) throw new Error("Registry returned an unexpected TimDS release");
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
  const bounded = pkg[dependencyKey][packageName];
  // Resolve the selected release exactly, then restore the bounded manifest
  // requirement without re-resolving the tested package graph.
  pkg[dependencyKey][packageName] = selected.version;
  await writeJson(packagePath, pkg);
  let lock;
  try {
    await invoke("npm", ["install", "--ignore-scripts"]);
    await invoke("npm", ["dedupe", "--ignore-scripts"]);
    lock = await readJson(lockPath);
  } finally {
    pkg[dependencyKey][packageName] = bounded;
    await writeJson(packagePath, pkg);
    lock ??= await readJson(lockPath).catch(() => previousLock);
    lock.packages[""][dependencyKey][packageName] = bounded;
    await writeJson(lockPath, lock);
  }
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

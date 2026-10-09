// Published consumers need a lock that can execute the postinstall we write.
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { runtimeIdentity } from "./runtime.mjs";

export const runConsumerNpm = promisify(execFile);
// The first published release with designSystem.version/url and consumer sync.
export const PUBLISHED_CONSUMER_MINIMUM_VERSION = "0.1.452";

const toJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
const readText = (file) => fs.readFile(file, "utf8").catch((error) => {
  if (error.code !== "ENOENT") throw error;
  return null;
});

export function toolkitVersionOlderThan(version, minimum) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) return true;
  const actual = version.split(".").map(Number);
  const required = minimum.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] !== required[index]) return actual[index] < required[index];
  }
  return false;
}

export function lockedConsumerToolkitVersion(lock) {
  return lock?.packages?.[`node_modules/${runtimeIdentity.name}`]?.version
    ?? lock?.dependencies?.[runtimeIdentity.name]?.version
    ?? null;
}

export async function planConsumerToolkitLock(repoRoot) {
  // npm gives a shrinkwrap precedence over package-lock.json.
  const shrinkwrap = await readText(path.join(repoRoot, "npm-shrinkwrap.json"));
  const relative = shrinkwrap === null ? "package-lock.json" : "npm-shrinkwrap.json";
  let lock = null;
  try {
    const content = shrinkwrap ?? await readText(path.join(repoRoot, relative));
    if (content !== null) lock = JSON.parse(content);
  } catch (error) {
    throw new Error(`Could not read ${relative}: ${error.message}`, { cause: error });
  }
  const version = lockedConsumerToolkitVersion(lock);
  return { path: relative, version, refresh: toolkitVersionOlderThan(version, runtimeIdentity.version) };
}

export function consumerToolkitLockRemedy() {
  return `npx --yes --package=${runtimeIdentity.name}@${runtimeIdentity.version} timds consumer init`;
}

/** Resolve exactly once without running the newly added postinstall or changing node_modules. */
export async function resolveConsumerToolkitLock(repoRoot, packageContent, { lockFile = "package-lock.json", runNpm = runConsumerNpm, output = () => {} } = {}) {
  const packagePath = path.join(repoRoot, "package.json");
  const lockPath = path.join(repoRoot, lockFile);
  const packageText = await readText(packagePath);
  const previousLock = await readText(lockPath);
  const pkg = JSON.parse(packageContent);
  const bounded = pkg.devDependencies[runtimeIdentity.name];
  pkg.devDependencies[runtimeIdentity.name] = runtimeIdentity.version;
  output(`Resolving ${runtimeIdentity.name}@${runtimeIdentity.version} into ${lockFile} (keeping ${bounded})...`);
  try {
    await fs.writeFile(packagePath, toJson(pkg));
    await runNpm("npm", ["install", "--package-lock-only", "--ignore-scripts"], { cwd: repoRoot, maxBuffer: 20_000_000 });
    const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
    if (lockedConsumerToolkitVersion(lock) !== runtimeIdentity.version || !lock.packages?.[""]) {
      throw new Error(`${lockFile} did not resolve ${runtimeIdentity.name}@${runtimeIdentity.version}`);
    }
    lock.packages[""].devDependencies[runtimeIdentity.name] = bounded;
    return { path: lockFile, content: toJson(lock) };
  } catch (error) {
    throw new Error(`Could not refresh the locked toolkit to ${runtimeIdentity.name}@${runtimeIdentity.version}: ${(error.stderr || error.message).trim()}\nRetry with: ${consumerToolkitLockRemedy()}`, { cause: error });
  } finally {
    // Resolution is preflight: the caller includes the new lock in its normal
    // writes and rollback boundary, after all downloads have succeeded.
    if (packageText === null) await fs.rm(packagePath, { force: true });
    else await fs.writeFile(packagePath, packageText);
    if (previousLock === null) await fs.rm(lockPath, { force: true });
    else await fs.writeFile(lockPath, previousLock);
  }
}

// Executable compatibility and dependency identity for producer and renderer hosts.
// Versions describe installed bytes; repository installation metadata is never
// used to guess which runtime is executing a contract. The bounded release line
// (MAJOR.MINOR.x) and the runtime dependency list are defined once here so
// core, the upgrade command, and the components agree without a literal.
import { readFileSync } from "node:fs";
import {assertRuntimeCompatibility as assertCompatibility, releaseLineOf, runtimeIdentityFor} from "../video/runtime-compat.mjs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
export const runtimeIdentity = runtimeIdentityFor(pkg);
export const isRuntimeDependency = (name) => ["react", "react-dom", "remotion"].includes(name) || name.startsWith("@remotion/");
export const runtimeDependencies = Object.freeze(Object.fromEntries(Object.entries(pkg.dependencies).filter(([name]) => isRuntimeDependency(name))));

/** The bounded MAJOR.MINOR.x line of an installed toolkit identity. */
export const toolkitReleaseRange = (identity = runtimeIdentity) => releaseLineOf(identity.version);

/**
 * The line a package.json requirement selects: the range itself (`0.1.x`) or
 * an npm caret on a release in it (`^0.1.12`). Null for anything else.
 */
export function declaredReleaseLine(requirement) {
  const match = String(requirement ?? "").match(/^(\^?)(\d+)\.(\d+)\.(\d+|x)$/u);
  if (!match) return null;
  const [, caret, major, minor, patch] = match;
  if (patch === "x" ? caret : !caret) return null;
  return `${major}.${minor}.x`;
}

/** Whether a package.json requirement selects the installed identity's line without exceeding it. */
export function acceptsToolkitReleaseRange(selectedVersion, identity = runtimeIdentity) {
  const releaseRange = toolkitReleaseRange(identity);
  if (selectedVersion === releaseRange) return true;
  if (declaredReleaseLine(selectedVersion) !== releaseRange) return false;
  const [major, , patch] = identity.version.split(".").map(Number);
  return major === 0 && Number(String(selectedVersion).split(".")[2]) <= patch;
}

export function sharedRuntimeRequirements() {
  return {releaseLine: runtimeIdentity.releaseLine, minimumVersion: runtimeIdentity.version,
    videoSchema: 2, componentApi: 1, features: [...runtimeIdentity.features]};
}

export function assertVideoContractRuntime(contract) {
  assertRuntimeCompatibility(contract.runtime);
  const schemaVersion = Number(contract.schemaVersion);
  if (schemaVersion === 2 && !contract.runtime) throw new Error("Video contract schemaVersion 2 requires explicit runtime requirements");
  if (schemaVersion === 1 && contract.runtime) throw new Error("Video runtime requirements need contract schemaVersion 2 so older hosts reject them; review the explicit contract migration");
  if (contract.runtime && contract.runtime.videoSchema !== schemaVersion) throw new Error("Video contract schemaVersion must match runtime.videoSchema");
}

export function assertRuntimeCompatibility(requirements, selected = runtimeIdentity) {
  return assertCompatibility(requirements, selected);
}

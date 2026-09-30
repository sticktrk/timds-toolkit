// Executable compatibility and dependency identity for producer and renderer hosts.
// Versions describe installed bytes; repository installation metadata is never
// used to guess which runtime is executing a contract.
import { readFileSync } from "node:fs";
import {VIDEO_RUNTIME_CAPABILITIES, assertRuntimeCompatibility as assertCompatibility} from "../video/runtime-compat.mjs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
export const runtimeIdentity = Object.freeze({
  name: pkg.name,
  version: pkg.version,
  ...VIDEO_RUNTIME_CAPABILITIES,
});
export const runtimeDependencies = Object.freeze(Object.fromEntries(Object.entries(pkg.dependencies)
  .filter(([name]) => ["react", "react-dom", "remotion"].includes(name) || name.startsWith("@remotion/"))));

export function sharedRuntimeRequirements() {
  return {releaseLine: runtimeIdentity.releaseLine, minimumVersion: runtimeIdentity.version,
    videoSchema: 2, componentApi: 1, features: [...runtimeIdentity.features]};
}

export function assertVideoContractRuntime(contract) {
  assertRuntimeCompatibility(contract.runtime);
  if (contract.schemaVersion === 2 && !contract.runtime) throw new Error("Video contract schemaVersion 2 requires explicit runtime requirements");
  if (contract.schemaVersion === 1 && contract.runtime) throw new Error("Video runtime requirements need contract schemaVersion 2 so older hosts reject them; review the explicit contract migration");
  if (contract.runtime && contract.runtime.videoSchema !== contract.schemaVersion) throw new Error("Video contract schemaVersion must match runtime.videoSchema");
}

export function assertRuntimeCompatibility(requirements, selected = runtimeIdentity) {
  return assertCompatibility(requirements, selected);
}

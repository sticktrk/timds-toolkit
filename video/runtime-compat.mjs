// Browser-safe compatibility checks used by composition registration and server hosts.
export const VIDEO_RUNTIME_CAPABILITIES = Object.freeze({
  releaseLine: "0.1.x", videoSchema: 2, componentApi: 1,
  features: Object.freeze(["board-catalog-v1", "contextual-board-limits-v1", "shared-board-layouts-v1"]),
});

const versionParts = (version) => {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/u.test(version)) throw new Error(`TimDS runtime version must be an exact stable release: ${JSON.stringify(version)}`);
  return version.split(".").map(Number);
};
const atLeast = (actual, minimum) => {
  const a = versionParts(actual), b = versionParts(minimum);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};

export function assertRuntimeCompatibility(requirements, selected) {
  if (requirements === undefined) return selected; // Existing contracts opt in through migration.
  const fail = (reason) => { throw new Error(`TimDS runtime compatibility: ${reason}; installed ${selected.name}@${selected.version}. Select a compatible locked TimDS release on both producer and renderer hosts, or review the contract migration.`); };
  if (!requirements || typeof requirements !== "object" || Array.isArray(requirements)) fail("video contract runtime must be an object");
  const keys = ["releaseLine", "minimumVersion", "videoSchema", "componentApi", "features", "testedVersions"];
  for (const key of Object.keys(requirements)) if (!keys.includes(key)) fail(`unknown runtime requirement ${key}`);
  if (requirements.releaseLine !== selected.releaseLine) fail(`requires release line ${requirements.releaseLine}`);
  const parts = versionParts(requirements.minimumVersion);
  if (`${parts[0]}.${parts[1]}.x` !== requirements.releaseLine) fail("minimumVersion must belong to releaseLine");
  if (!atLeast(selected.version, requirements.minimumVersion)) fail(`requires at least ${requirements.minimumVersion}`);
  for (const key of ["videoSchema", "componentApi"]) if (requirements[key] !== selected[key]) fail(`requires ${key} ${requirements[key]}, supported ${selected[key]}`);
  if (!Array.isArray(requirements.features) || requirements.features.some((feature) => typeof feature !== "string" || !selected.features.includes(feature))) fail(`unsupported required features ${JSON.stringify(requirements.features)}`);
  if (requirements.testedVersions !== undefined) {
    if (!Array.isArray(requirements.testedVersions) || !requirements.testedVersions.length) fail("testedVersions must list reviewed exact releases for custom components");
    requirements.testedVersions.forEach(versionParts);
    if (!requirements.testedVersions.includes(selected.version)) fail(`custom components have been tested only on ${requirements.testedVersions.join(", ")}`);
  }
  return selected;
}

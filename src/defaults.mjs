import { promises as fs } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

const publishingTemplate = new URL("../templates/video/publishing-defaults.json", import.meta.url);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);

export async function videoPublishingDefaults() {
  return JSON.parse(await fs.readFile(publishingTemplate, "utf8"));
}

// Overrides are sticky: equality with a later default never transfers ownership.
export function mergeDefaults(current, previous, next, overrides = []) {
  const protectedPaths = new Set(overrides);
  const changed = [];
  function merge(value, before, after, prefix) {
    const result = structuredClone(value);
    const keys = new Set([...Object.keys(before), ...Object.keys(after), ...(prefix === "publishing" ? [] : Object.keys(value))]);
    for (const key of keys) {
      const label = `${prefix}.${key}`;
      if (protectedPaths.has(label)) continue;
      if (isObject(after[key]) && (isObject(value[key]) || (!own(value, key) && !own(before, key))) && (!own(before, key) || isObject(before[key]))) {
        const nested = merge(value[key] || {}, before[key] || {}, after[key], label);
        result[key] = nested;
        if (!own(value, key) && !Object.keys(nested).length) changed.push(label);
      } else if ([...protectedPaths].some((entry) => entry.startsWith(`${label}.`))) {
        // Removing/replacing a defaults group cannot remove a nested override.
        continue;
      } else if (own(value, key) === own(before, key) && isDeepStrictEqual(value[key], before[key])) {
        if (own(value, key) !== own(after, key) || !isDeepStrictEqual(value[key], after[key])) {
          if (own(after, key)) result[key] = structuredClone(after[key]); else delete result[key];
          changed.push(label);
        }
      } else {
        protectedPaths.add(label);
      }
    }
    return result;
  }
  const value = merge(current, previous, next, "publishing");
  const preserved = [...protectedPaths].sort();
  return { value, changed, preserved, overrides: preserved };
}

function inheritedOverrides(publishing, previous, next) {
  const overrides = [];
  const fields = ["shortBridge", "shortDisclaimer", "shortArticleLink"];
  for (const field of fields) {
    if (own(next.targetDefaults || {}, field) && !own(previous.targetDefaults || {}, field) && !own(publishing.targetDefaults || {}, field) && own(publishing, field)) {
      overrides.push(`publishing.targetDefaults.${field}`);
    }
    for (const [target, policy] of Object.entries(next.targets || {})) {
      if (own(policy, field) && !own(previous.targets?.[target] || {}, field) && !own(publishing.targets?.[target] || {}, field) && (own(publishing.targetDefaults || {}, field) || own(publishing, field))) {
        overrides.push(`publishing.targets.${target}.${field}`);
      }
    }
  }
  return overrides;
}

/** Only the publishing defaults participate. Brand, productions and components never do. */
export async function syncDefaults(workspace, { apply = false, scaffold = false } = {}) {
  if (!workspace.manifest.video) return { changed: [], preserved: [], applied: false, enabled: false };
  const contractPath = path.join(workspace.designSystemRoot, workspace.manifest.video.contract);
  const baselinePath = path.join(workspace.designSystemRoot, ".timds", "defaults.json");
  const contract = JSON.parse(await fs.readFile(contractPath, "utf8"));
  if (!isObject(contract.publishing ?? {})) throw new Error("publishing must be an object before syncing defaults");
  let baseline = null;
  try {
    baseline = JSON.parse(await fs.readFile(baselinePath, "utf8"));
    if (![1, 2].includes(baseline.schemaVersion) || !isObject(baseline.videoPublishing)) throw new Error("Invalid TimDS defaults baseline");
    if (baseline.schemaVersion === 2 && (!Array.isArray(baseline.overrides) || baseline.overrides.some((entry) => typeof entry !== "string" || !/^publishing\.(targets|targetDefaults)(\.[A-Za-z_][A-Za-z_0-9]*)*$/u.test(entry)))) throw new Error("Invalid TimDS defaults overrides");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const next = await videoPublishingDefaults();
  const publishing = contract.publishing || {};
  const previous = baseline?.videoPublishing || {};
  const inherited = scaffold ? [] : inheritedOverrides(publishing, previous, next);
  const merged = mergeDefaults(publishing, previous, next, [...(baseline?.schemaVersion === 2 ? baseline.overrides : []), ...inherited]);
  const nextBaseline = { schemaVersion: 2, videoPublishing: next, overrides: merged.overrides };
  const baselineChanged = !isDeepStrictEqual(baseline, nextBaseline);
  const changed = [...merged.changed, ...(baselineChanged ? [".timds/defaults.json"] : [])];
  if (apply) {
    if (merged.changed.length) {
      contract.publishing = merged.value;
      await fs.writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
    }
    if (baselineChanged) {
      await fs.mkdir(path.dirname(baselinePath), { recursive: true });
      await fs.writeFile(baselinePath, `${JSON.stringify(nextBaseline, null, 2)}\n`);
    }
  }
  return { changed, preserved: merged.preserved, applied: apply, enabled: true };
}

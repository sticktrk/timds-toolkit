import { promises as fs } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

const publishingTemplate = new URL("../templates/video/publishing-defaults.json", import.meta.url);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);

export async function videoPublishingDefaults() {
  return JSON.parse(await fs.readFile(publishingTemplate, "utf8"));
}

// A three-way update: advance an unchanged default, retain a local edit, and
// introduce a new key. A locally deleted key stays deleted on later updates.
export function mergeDefaults(current, previous, next, prefix = "publishing") {
  const value = structuredClone(current);
  const changed = [];
  const preserved = [];
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    const label = `${prefix}.${key}`;
    if (isObject(next[key]) && isObject(value[key]) && (!own(previous, key) || isObject(previous[key]))) {
      const merged = mergeDefaults(value[key], previous[key] || {}, next[key], label);
      value[key] = merged.value;
      changed.push(...merged.changed);
      preserved.push(...merged.preserved);
    } else if ((own(value, key) === own(previous, key) && isDeepStrictEqual(value[key], previous[key]))) {
      if (own(value, key) !== own(next, key) || !isDeepStrictEqual(value[key], next[key])) {
        if (own(next, key)) value[key] = structuredClone(next[key]); else delete value[key];
        changed.push(label);
      }
    } else if (!isDeepStrictEqual(value[key], next[key])) {
      preserved.push(label);
    }
  }
  return { value, changed, preserved };
}

/** Only the publishing defaults participate. Brand, productions and components never do. */
export async function syncDefaults(workspace, { apply = false } = {}) {
  if (!workspace.manifest.video) return { changed: [], preserved: [], applied: false, enabled: false };
  const contractPath = path.join(workspace.designSystemRoot, workspace.manifest.video.contract);
  const baselinePath = path.join(workspace.designSystemRoot, ".timds", "defaults.json");
  const contract = JSON.parse(await fs.readFile(contractPath, "utf8"));
  if (!isObject(contract.publishing ?? {})) throw new Error("publishing must be an object before syncing defaults");
  let baseline = null;
  try {
    baseline = JSON.parse(await fs.readFile(baselinePath, "utf8"));
    if (baseline.schemaVersion !== 1 || !isObject(baseline.videoPublishing)) throw new Error("Invalid TimDS defaults baseline");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const next = await videoPublishingDefaults();
  const merged = mergeDefaults(contract.publishing || {}, baseline?.videoPublishing || {}, next);
  const baselineChanged = !isDeepStrictEqual(baseline?.videoPublishing, next);
  const changed = [...merged.changed, ...(baselineChanged ? [".timds/defaults.json"] : [])];
  if (apply) {
    if (merged.changed.length) {
      contract.publishing = merged.value;
      await fs.writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
    }
    if (baselineChanged) {
      await fs.mkdir(path.dirname(baselinePath), { recursive: true });
      await fs.writeFile(baselinePath, `${JSON.stringify({ schemaVersion: 1, videoPublishing: next }, null, 2)}\n`);
    }
  }
  return { changed, preserved: merged.preserved, applied: apply, enabled: true };
}

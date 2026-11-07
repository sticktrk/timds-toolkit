// Shared package resource selection for init, upgrade, and release metadata.
import { promises as fs } from "node:fs";
import path from "node:path";
import { packageRoot } from "./executable.mjs";
import { starterKind } from "./starter.mjs";

// Both the automation migration and installation record use these tables.
export const standaloneReleaseAutomationFiles = Object.freeze([
  [".github/workflows/timds-design-system.yml", "timds-standalone.yml"],
  [".github/workflows/update-consumer-submodule.yml", "update-consumer-submodule.yml"],
  ["scripts/release.mjs", "starter/scripts/release.mjs"],
  ["scripts/release.sh", "starter/scripts/release.sh"],
  ["scripts/check-versions.mjs", "starter/scripts/check-versions.mjs"],
  ["scripts/prepare-merge-release.mjs", "starter/scripts/prepare-merge-release.mjs"],
  ["scripts/prepare-merge-release.test.mjs", "starter/scripts/prepare-merge-release.test.mjs"],
]);
export const dependencyAutomationFiles = Object.freeze([
  [".github/workflows/timds-upgrade.yml", "timds-upgrade.yml"],
]);

/** Sorted regular package files; links and special files are not resources. */
export async function packageResourcePaths(directory) {
  const result = [];
  async function walk(relative) {
    const absolute = path.join(packageRoot, relative);
    const stat = await fs.lstat(absolute);
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(absolute)).sort()) await walk(`${relative}/${name}`);
    } else if (stat.isFile()) result.push(relative);
    else throw new Error(`Unsupported toolkit resource ${relative}: expected a regular file or directory`);
  }
  await walk(directory);
  return result;
}

/** The selected overlay wins; other starters never inherit ordinary pages/designs. */
export async function starterTemplateFiles(kind) {
  kind = starterKind(kind);
  const files = new Map();
  if (kind !== "starter") {
    for (const resource of await packageResourcePaths(`templates/${kind}`)) files.set(resource.slice(`templates/${kind}/`.length), resource);
  }
  for (const resource of await packageResourcePaths("templates/starter")) {
    const relative = resource.slice("templates/starter/".length);
    if (kind !== "starter" && ["src/pages/", "src/designs/"].some(prefix => relative.startsWith(prefix))) continue;
    if (!files.has(relative)) files.set(relative, resource);
  }
  return [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}

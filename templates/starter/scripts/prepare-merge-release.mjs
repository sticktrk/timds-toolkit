#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const filePath = (file) => join(root, file);
const readText = (file) => readFileSync(filePath(file), "utf8");
const versionPattern = /^\d+\.\d+\.\d+$/;

export const parseVersion = (version) => {
  if (!versionPattern.test(version ?? "")) throw new Error(`Invalid Design System version ${JSON.stringify(version)}`);
  return version.split(".").map(Number);
};

export const compareVersions = (left, right) => {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
};

export const nextPatch = (version) => {
  const [major, minor, patch] = parseVersion(version);
  return `${major}.${minor}.${patch + 1}`;
};

const fallbackEntry = (message) => {
  const lines = String(message ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const useful = lines.find((line) => !/^Merge pull request #\d+\b/i.test(line)) ?? lines[0];
  return useful ? `- ${useful.replace(/^[-*]\s+/, "")}` : "- Publish merged Design System changes.";
};

const replaceDeclaredVersion = (text, previousVersion, version, file) => {
  const escaped = previousVersion.replace(/\./g, "\\.");
  const next = text.replace(new RegExp(`("version"\\s*:\\s*")${escaped}(")`), `$1${version}$2`);
  if (next === text) throw new Error(`Could not replace version ${previousVersion} in ${file}`);
  return next;
};

export function prepareMergeRelease(input) {
  const currentVersion = JSON.parse(input.timdsJson).version;
  const comparison = compareVersions(currentVersion, input.previousVersion);
  if (comparison < 0) throw new Error(`Design System version regressed from ${input.previousVersion} to ${currentVersion}`);
  if (comparison > 0) {
    if (!input.changelog.includes(`\n## ${currentVersion}\n`)) {
      throw new Error(`CHANGELOG.md has no section for explicitly advanced version ${currentVersion}`);
    }
    return { changed: false, version: currentVersion };
  }

  const version = nextPatch(currentVersion);
  const match = input.changelog.match(/\n## Unreleased\n([\s\S]*?)(?=\n## )/);
  if (!match) throw new Error("CHANGELOG.md has no ## Unreleased section to roll");
  const entries = match[1].trim() || fallbackEntry(input.fallbackNote);
  const changelog = input.changelog.replace(match[0], `\n## Unreleased\n\n## ${version}\n\n${entries}\n`);

  const packageJson = JSON.parse(input.packageJson);
  const lock = JSON.parse(input.packageLock);
  if (packageJson.version !== currentVersion
    || lock.version !== currentVersion
    || lock.packages?.[""]?.version !== currentVersion) {
    throw new Error("package.json and package-lock.json root versions must match timds.json before the merge release");
  }
  lock.version = version;
  lock.packages[""].version = version;

  return {
    changed: true,
    version,
    files: {
      "timds.json": replaceDeclaredVersion(input.timdsJson, currentVersion, version, "timds.json"),
      "package.json": replaceDeclaredVersion(input.packageJson, currentVersion, version, "package.json"),
      "package-lock.json": `${JSON.stringify(lock, null, 2)}\n`,
      "CHANGELOG.md": changelog,
    },
  };
}

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const previousVersion = argument("--previous");
    if (!previousVersion) throw new Error("Usage: prepare-merge-release.mjs --previous MAJOR.MINOR.PATCH [--fallback-note TEXT] [--github-output FILE]");
    const result = prepareMergeRelease({
      previousVersion,
      fallbackNote: argument("--fallback-note"),
      timdsJson: readText("timds.json"),
      packageJson: readText("package.json"),
      packageLock: readText("package-lock.json"),
      changelog: readText("CHANGELOG.md"),
    });
    for (const [file, contents] of Object.entries(result.files ?? {})) writeFileSync(filePath(file), contents);
    const output = argument("--github-output");
    if (output) writeFileSync(output, `changed=${result.changed}\nversion=${result.version}\n`, { flag: "a" });
    console.log(result.changed ? `Prepared automatic Design System ${result.version}` : `Using explicitly prepared Design System ${result.version}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

#!/usr/bin/env node
// Design System versions are dated: YYYY.MM.DD-N, the UTC day a release was
// prepared and its number that day (2026.10.12-1, then 2026.10.12-2). A merge
// to main takes the next one automatically; release.mjs prepares one by hand.
// Systems released before the scheme carry MAJOR.MINOR.PATCH versions, which
// order below every dated version, so the first merge after adopting this
// script moves the system onto today's date.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const filePath = (file) => join(root, file);
const readText = (file) => readFileSync(filePath(file), "utf8");
const datedPattern = /^(\d{4})\.(\d{2})\.(\d{2})-([1-9]\d*)$/;
const legacyPattern = /^\d+\.\d+\.\d+$/;

export const isVersion = (version) => parseVersion(version, { throws: false }) !== null;

/** `{ kind: "dated", date, build }` or `{ kind: "legacy", parts }`; throws (or returns null) for anything else. */
export const parseVersion = (version, { throws = true } = {}) => {
  const text = String(version ?? "").trim();
  const dated = datedPattern.exec(text);
  if (dated) {
    const date = `${dated[1]}-${dated[2]}-${dated[3]}`;
    const parsed = new Date(`${date}T00:00:00Z`);
    if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date) return { kind: "dated", date, build: Number(dated[4]) };
  } else if (legacyPattern.test(text)) {
    return { kind: "legacy", parts: text.split(".").map(Number) };
  }
  if (throws) throw new Error(`Invalid Design System version ${JSON.stringify(version)}; expected YYYY.MM.DD-N such as ${todayVersion()}`);
  return null;
};

export const compareVersions = (left, right) => {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a.kind !== b.kind) return a.kind === "dated" ? 1 : -1;
  if (a.kind === "dated") return a.date === b.date ? a.build - b.build : a.date < b.date ? -1 : 1;
  for (let index = 0; index < 3; index += 1) {
    if (a.parts[index] !== b.parts[index]) return a.parts[index] - b.parts[index];
  }
  return 0;
};

/** Today's date (UTC) as a version prefix, 2026.10.12. */
export const todayVersion = (now = new Date()) => now.toISOString().slice(0, 10).replaceAll("-", ".");

/** The first release of the day is YYYY.MM.DD-1; another the same UTC day counts up. */
export const nextVersion = (current, now = new Date()) => {
  const parsed = parseVersion(current);
  const today = todayVersion(now);
  if (parsed.kind === "dated" && parsed.date.replaceAll("-", ".") === today) return `${today}-${parsed.build + 1}`;
  return `${today}-1`;
};

const fallbackEntry = (message) => {
  const lines = String(message ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const useful = lines.find((line) => !/^Merge pull request #\d+\b/i.test(line)) ?? lines[0];
  if (!useful) return "- Publish merged Design System changes.";
  const text = useful.replace(/^[-*]\s+/, "");
  // A toolkit upgrade merged without a note is maintenance, and reads as such on the changelog page.
  return `- ${/^Upgrade TimDS\b/i.test(text) ? `Maintenance: ${text}` : text}`;
};

const replaceDeclaredVersion = (text, previousVersion, version, file) => {
  const escaped = previousVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

  const version = nextVersion(currentVersion, input.now ?? new Date());
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
    if (!previousVersion) throw new Error("Usage: prepare-merge-release.mjs --previous VERSION [--fallback-note TEXT] [--github-output FILE]");
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

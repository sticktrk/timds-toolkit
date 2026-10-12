#!/usr/bin/env node
// Prepare a release by hand: the next dated version (YYYY.MM.DD-N, today's
// date and the release number that day) or an explicit later one, the
// Unreleased notes rolled under it, on a release branch and draft pull
// request. Merging an ordinary change does this automatically; use this only
// to release at a chosen moment or under a chosen version.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions, nextVersion, parseVersion, todayVersion } from "./prepare-merge-release.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: root }).toString().trim();
const filePath = (file) => join(root, file);
const readText = (file) => readFileSync(filePath(file), "utf8");
const args = process.argv.slice(2);
const push = args.includes("--push");
const requested = args.find((argument) => !argument.startsWith("--"));

const current = JSON.parse(readText("timds.json")).version;
// A hand release takes a dated version only: the legacy scheme ends with the
// version the system has, and a release carries the day it is prepared, never
// a later one, so the automatic releases that follow it keep counting up.
const explicit = requested === undefined ? null : parseVersion(requested, { throws: false });
if (requested !== undefined && explicit?.kind !== "dated") {
  console.error(`Usage: npm run release -- [YYYY.MM.DD-N] [--push]\nThe next version is ${nextVersion(current)}.`);
  process.exit(1);
}
const version = requested ?? nextVersion(current);
if (compareVersions(version, current) <= 0) {
  console.error(`timds.json is already ${current}; ${version} does not follow it. The next version is ${nextVersion(current)}.`);
  process.exit(1);
}
if (explicit && explicit.date.replaceAll("-", ".") > todayVersion()) {
  console.error(`${version} is dated after today (${todayVersion()}); a release carries the day it is prepared. The next version is ${nextVersion(current)}.`);
  process.exit(1);
}
if (git("status", "--porcelain")) {
  console.error("Working tree is dirty; commit or stash before releasing.");
  process.exit(1);
}
const changelog = readText("CHANGELOG.md");
const match = changelog.match(/\n## Unreleased\n([\s\S]*?)(?=\n## )/);
if (!match || !match[1].trim()) {
  console.error("CHANGELOG.md must have release notes under ## Unreleased.");
  process.exit(1);
}
const entries = match[1].trim();
const replaceVersion = (file, pattern) => {
  const before = readText(file);
  const after = before.replace(pattern, (matched) => matched.replace(current, version));
  if (before === after) throw new Error(`Could not replace ${current} in ${file}`);
  writeFileSync(filePath(file), after);
};
const escaped = current.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
replaceVersion("timds.json", new RegExp(`"version":\\s*"${escaped}"`));
replaceVersion("package.json", new RegExp(`"version":\\s*"${escaped}"`));
const lock = readText("package-lock.json").split("\n");
let patched = 0;
for (let index = 0; index < lock.length && patched < 2; index += 1) {
  if (index < 20 && lock[index].includes(`"version": "${current}"`)) {
    lock[index] = lock[index].replace(current, version);
    patched += 1;
  }
}
if (patched !== 2) throw new Error(`Expected two root package-lock versions, patched ${patched}`);
writeFileSync(filePath("package-lock.json"), lock.join("\n"));
writeFileSync(filePath("CHANGELOG.md"), changelog.replace(match[0], `\n## Unreleased\n\n## ${version}\n\n${entries}\n`));
execFileSync("node", [filePath("scripts/check-versions.mjs")], { cwd: root, stdio: "inherit" });

const branch = `design-system/release-${version}`;
git("switch", "--create", branch);
git("add", "CHANGELOG.md", "package.json", "package-lock.json", "timds.json");
git("commit", "--message", `Release ${version}`);
console.log(`Prepared ${version} on ${branch}`);
if (push) {
  git("push", "--set-upstream", "origin", branch);
  execFileSync("gh", ["pr", "create", "--draft", "--base", "main", "--head", branch,
    "--title", `Release ${version}`,
    "--body", `Bumps the Design System to ${version}. Merging publishes this exact commit and offers the linked consumer update.\n\n${entries}`],
  { cwd: root, stdio: "inherit" });
}

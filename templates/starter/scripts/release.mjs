#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: root }).toString().trim();
const filePath = (file) => join(root, file);
const readText = (file) => readFileSync(filePath(file), "utf8");
const args = process.argv.slice(2);
const push = args.includes("--push");
const version = args.find((argument) => !argument.startsWith("--"));

if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("Usage: npm run release -- <MAJOR.MINOR.PATCH> [--push]");
  process.exit(1);
}
const current = JSON.parse(readText("timds.json")).version;
if (version === current) {
  console.error(`timds.json is already ${version}; pick a new version.`);
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
replaceVersion("timds.json", new RegExp(`"version":\\s*"${current}"`));
replaceVersion("package.json", new RegExp(`"version":\\s*"${current}"`));
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
    "--body", `Bumps the Design System to ${version}. Merging publishes the artifact and tags v${version}.\n\n${entries}`],
  { cwd: root, stdio: "inherit" });
}

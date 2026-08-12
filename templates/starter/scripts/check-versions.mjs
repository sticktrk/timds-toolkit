#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (file) => JSON.parse(readFileSync(join(root, file), "utf8"));
const timds = readJson("timds.json");
const pkg = readJson("package.json");
const lock = readJson("package-lock.json");
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
const expected = timds.version;
const problems = [];

if (!/^\d+\.\d+\.\d+$/.test(expected ?? "")) problems.push(`timds.json version is invalid: ${JSON.stringify(expected)}`);
if (pkg.version !== expected) problems.push(`package.json is ${pkg.version}, expected ${expected}`);
if (lock.version !== expected) problems.push(`package-lock.json root is ${lock.version}, expected ${expected}`);
if (lock.packages?.[""]?.version !== expected) problems.push(`package-lock.json packages[""] is ${lock.packages?.[""]?.version}, expected ${expected}`);
if (!changelog.includes(`\n## ${expected}\n`)) problems.push(`CHANGELOG.md has no "## ${expected}" section`);

if (problems.length) {
  console.error(`Version mismatch (timds.json is the source of truth, ${expected}):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`Versions agree at ${expected}`);

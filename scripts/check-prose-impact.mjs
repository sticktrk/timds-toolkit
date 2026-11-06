// Prose impact: for a range of commits, name the instruction surfaces that
// describe each changed module (the `proseOwnership` map in
// src/prose-contract.mjs) and fail when a module changed and none of its
// surfaces did. The contract test catches claims the source no longer backs;
// this catches the other direction, a behaviour that changed with the words
// about it left as they were. A commit in the range may carry a
// `Prose-impact:` trailer (`Prose-impact: none, internal refactor`) to say
// why no surface needs to move; the trailer is printed so the reviewer sees
// the claim. CI runs this on every pull request against its base branch.
//
//   node scripts/check-prose-impact.mjs --base origin/master   # the default base
//   node scripts/check-prose-impact.mjs --base origin/master --advisory   # report, never fail
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { proseOwnership, proseSurfaces } from "../src/prose-contract.mjs";

const args = process.argv.slice(2);
const baseIndex = args.indexOf("--base");
const base = baseIndex >= 0 ? args[baseIndex + 1] : "origin/master";
const advisory = args.includes("--advisory");
const git = (...gitArgs) => execFileSync("git", gitArgs, { encoding: "utf8" }).trim();

let changed;
try {
  changed = git("diff", "--name-only", `${base}...HEAD`).split("\n").filter(Boolean);
} catch {
  throw new Error(`Cannot diff against ${base}; fetch it first (git fetch origin ${base.replace(/^origin\//, "")})`);
}
const surfaceFiles = new Set(proseSurfaces.map((surface) => surface.file));
const changedSurfaces = changed.filter((file) => surfaceFiles.has(file));
const trailers = git("log", "--format=%B", `${base}..HEAD`).split("\n").map((line) => /^Prose-impact:\s*(.+)$/i.exec(line)?.[1]).filter(Boolean);

const rows = [];
for (const [module, surfaces] of Object.entries(proseOwnership)) {
  const touched = changed.filter((file) => (module.endsWith("/") ? file.startsWith(module) : file === module));
  if (!touched.length) continue;
  const carried = surfaces.filter((surface) => changedSurfaces.includes(surface));
  rows.push({ module, touched, surfaces, carried });
}
const unmet = rows.filter((row) => !row.carried.length);

const lines = [];
if (!rows.length) lines.push(`No module in proseOwnership changed between ${base} and HEAD.`);
for (const row of rows) {
  lines.push(`${row.carried.length ? "ok " : "!! "}${row.module}: described in ${row.surfaces.join(", ")}${row.carried.length ? ` (changed: ${row.carried.join(", ")})` : " (none changed)"}`);
}
if (trailers.length) lines.push(`Prose-impact trailer: ${trailers.join(" | ")}`);
const report = lines.join("\n");
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Prose impact\n\n\`\`\`\n${report}\n\`\`\`\n`);

if (unmet.length && !trailers.length && !advisory) {
  console.error(`\n${unmet.length} changed module(s) have no changed instruction surface. Update one of the surfaces listed, or add a commit trailer "Prose-impact: <why none is needed>".`);
  process.exit(1);
}

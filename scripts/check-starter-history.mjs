// Every stock version of a starter-managed file that a release shipped must
// stay recognizable as the toolkit's: starter sync refreshes a file only while
// its bytes match a known stock hash (`knownStarterHashes` in src/starter.mjs),
// and a system whose record moved past its files, such as one whose page
// writes were reverted while the record kept the newer hash, is otherwise
// treated as customized for good. This walks the release tags and fails when
// a shipped version is neither the current template nor in
// `legacyStarterFileHashes`. It needs the tags, so CI checks out full history.
//
//   node scripts/check-starter-history.mjs           # report and fail on a gap
//   node scripts/check-starter-history.mjs --print   # also print the missing entries
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { legacyStarterFileHashes, starterFragments, starterPlumbingFiles } from "../src/starter.mjs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const repoPath = (templateName) => (templateName.startsWith("../") ? templateName.slice(3) : `templates/${templateName}`);
const tags = git("tag", "--list", "v0.1.*", "--sort=version:refname").trim().split("\n").filter(Boolean);
if (!tags.length) throw new Error("No release tags in this checkout; fetch them (actions/checkout with fetch-depth: 0) before checking starter history");

const missing = new Map();
for (const [relative, templateName] of [...starterPlumbingFiles, ...starterFragments("starter"), ...starterFragments("brand-kit")]) {
  const current = sha256(git("show", `HEAD:${repoPath(templateName)}`));
  const known = new Set(legacyStarterFileHashes.get(relative) ?? []);
  for (const tag of tags) {
    let text;
    try { text = git("show", `${tag}:${repoPath(templateName)}`); } catch { continue; }
    const hash = sha256(text);
    if (hash === current || known.has(hash)) continue;
    const entry = missing.get(relative) ?? new Map();
    if (!entry.has(hash)) entry.set(hash, tag);
    missing.set(relative, entry);
  }
}

if (!missing.size) {
  process.stdout.write(`Every stock version shipped in ${tags.length} releases is recognized\n`);
} else {
  for (const [relative, entry] of missing) process.stderr.write(`${relative}: ${[...entry.values()].join(", ")} shipped a version legacyStarterFileHashes does not list\n`);
  if (process.argv.includes("--print")) {
    for (const [relative, entry] of missing) process.stdout.write(`${relative}\n${[...entry].map(([hash, tag]) => `    "${hash}", // ${tag}`).join("\n")}\n`);
  }
  process.exitCode = 1;
}

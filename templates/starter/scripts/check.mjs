import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredSourceFiles = ["index.html", "styles.css"];

for (const file of requiredSourceFiles) {
  await access(path.join(root, "src", file));
}

const tokens = JSON.parse(await readFile(path.join(root, "tokens.json"), "utf8"));
const groups = Object.entries(tokens);
if (!groups.length) throw new Error("tokens.json must define at least one token group");

for (const [group, entries] of groups) {
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    throw new Error(`Token group ${group} must be an object`);
  }
  for (const [name, token] of Object.entries(entries)) {
    if (!token || typeof token.value !== "string" || !token.value.trim()) {
      throw new Error(`Token ${group}.${name} must have a non-empty string value`);
    }
  }
}

const html = await readFile(path.join(root, "src", "index.html"), "utf8");
for (const asset of ["styles.css", "tokens.css"]) {
  if (!html.includes(asset)) throw new Error(`src/index.html must reference ${asset}`);
}

console.log(`Validated ${groups.length} token groups and ${requiredSourceFiles.length} authored viewer files`);

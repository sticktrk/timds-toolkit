import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
const expectedTag = `v${packageJson.version}`;
const actualTag = String(process.env.GITHUB_REF_NAME || "").trim();

if (packageJson.name !== "@dtconcepts/timds") {
  throw new Error(`Unexpected npm package name ${String(packageJson.name || "")}`);
}
if (packageJson.private) throw new Error("The TimDS npm package cannot be private");
if (actualTag !== expectedTag) {
  throw new Error(`GitHub Release tag ${actualTag || "<missing>"} must match package version ${expectedTag}`);
}

process.stdout.write(`Release ${actualTag} matches ${packageJson.name}@${packageJson.version}\n`);

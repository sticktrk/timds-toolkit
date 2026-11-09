import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { renderBinaryInstructions } from "./binary-installation.mjs";
import { renderConsumerSkillFile } from "./consumer-init.mjs";

// The binary rendering of a skill is a set of sentence rewrites over its npm
// wording (binary-installation.mjs). Rewording a skill can silently stop one
// of them matching, and the binary installation tests that would notice run
// in CI only when binary files change; this check runs for every change.

const skillsRoot = fileURLToPath(new URL("../skills/", import.meta.url));
const skillNames = (await fs.readdir(skillsRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
const consumerSkills = ["timds-consume-design-system", "timds-update-design-system"];
const manifests = {
  published: { schemaVersion: 1, designSystem: { path: "design-system", systemId: "example/core", version: "2026.10.27-1", url: "https://public.example.com" }, apps: { web: { cwd: ".", preview: { build: ["npm", "run", "build"], output: "dist" }, designSurface: ["src/**"] } } },
  submodule: { schemaVersion: 1, designSystem: { path: "design-system", systemId: "example/core" }, apps: { web: { cwd: ".", preview: { build: ["npm", "run", "build"], output: "dist" }, designSurface: ["src/**"] } } },
};

test("every shipped skill renders for binary mode without an npm invocation", async () => {
  assert.ok(skillNames.length >= 9, `skills: ${skillNames.join(", ")}`);
  for (const name of skillNames) {
    const source = await fs.readFile(path.join(skillsRoot, name, "SKILL.md"), "utf8");
    const rendered = consumerSkills.includes(name) ? null : renderBinaryInstructions(source);
    const renders = rendered === null
      ? await Promise.all(Object.values(manifests).map((manifest) => renderConsumerSkillFile(name, manifest, { defaultBranch: "main", mode: "binary", ...(name === "timds-update-design-system" && manifest.designSystem.version ? { targetLabel: "2026.10.27-2" } : {}) })))
      : [rendered];
    for (const text of renders) {
      assert.doesNotMatch(text, /npm run timds --/, `${name}: an npm invocation survived the binary rendering`);
      assert.doesNotMatch(text, /npx --yes @dtconcepts\/timds/, `${name}: an npx invocation survived the binary rendering`);
    }
  }
});

test("each sentence rewrite in renderBinaryInstructions still matches the skill it was written for", async () => {
  const read = (name) => fs.readFile(path.join(skillsRoot, name, "SKILL.md"), "utf8");
  const edit = renderBinaryInstructions(await read("timds-edit-design-system"));
  assert.match(edit, /5\. Verify `timds-cli --version` matches `\.timds\/installation\.json`; the stock system needs no npm install\./, "the edit skill's install step");
  const cloud = renderBinaryInstructions(await fs.readFile(path.join(skillsRoot, "timds-edit-design-system", "references", "timds-cloud.md"), "utf8"));
  assert.match(cloud, /Hosted workspaces use the same selected executable\./, "the edit skill's hosted paragraph");
  assert.doesNotMatch(cloud, /@dtconcepts\/timds@latest/);
  assert.doesNotMatch(edit, /@dtconcepts\/timds@latest/);
  const start = renderBinaryInstructions(await read("design-start"));
  assert.match(start, /3\. Verify `timds-cli --version` matches `\.timds\/installation\.json`\. No package-manager installation is needed for stock commands\./, "design-start's install step");
  const hosted = renderBinaryInstructions(await read("timds-hosted-design-system"));
  assert.match(hosted, /Use `timds-cli <command>` from the verified executable release\./, "the hosted skill's install paragraph");
  assert.match(hosted, /1\. Compare `timds-cli --version` with `\.timds\/installation\.json`/, "the hosted skill's npm ci step");
  assert.match(hosted, /Change the selected toolkit release\. Binary version changes require/, "the hosted skill's never-pin bullet");
  assert.doesNotMatch(hosted, /npx --yes|npm ci|npm install|never pin a/);
});

// The EmDash template version is published in the package's registry document
// (package.json `emdashTemplate`, beside `hostContract`), so a host can tell
// which template set a toolkit release installs without unpacking it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (relative) => JSON.parse(readFileSync(path.join(packageRoot, relative), "utf8"));

test("package.json publishes the EmDash template version with what each version changed", () => {
  const { emdashTemplate, emdashWorkspaceContract, emdashSectionsContract } = readJson("package.json");
  assert.equal(emdashWorkspaceContract, 3);
  assert.equal(emdashSectionsContract, 2);
  const templates = readJson("templates/emdash/site.json");
  assert.deepEqual(Object.keys(emdashTemplate), ["version", "history"]);
  assert.equal(emdashTemplate.version, templates.version, "package.json emdashTemplate.version must equal templates/emdash/site.json version");
  // One entry for every version from 1 to the current one, in order, each with a short list.
  assert.deepEqual(emdashTemplate.history.map((entry) => entry.version), Array.from({ length: templates.version }, (_unused, index) => index + 1));
  for (const entry of emdashTemplate.history) {
    assert.deepEqual(Object.keys(entry), ["version", "changes"]);
    assert.ok(entry.changes.length >= 1 && entry.changes.length <= 8, `version ${entry.version} lists 1 to 8 changes`);
    for (const change of entry.changes) assert.ok(typeof change === "string" && change.trim().length > 10 && change.length <= 300, `version ${entry.version}: ${change}`);
  }
});

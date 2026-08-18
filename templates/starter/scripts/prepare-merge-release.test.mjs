import assert from "node:assert/strict";
import test from "node:test";
import { prepareMergeRelease } from "./prepare-merge-release.mjs";

const fixture = (overrides = {}) => ({
  previousVersion: "1.3.103",
  fallbackNote: "Merge pull request #24 from example/branch\n\nAdd production runtime",
  timdsJson: '{"version":"1.3.103"}',
  packageJson: '{"name":"root","version":"1.3.103"}',
  packageLock: JSON.stringify({ version: "1.3.103", packages: { "": { version: "1.3.103" } } }),
  changelog: "# Changelog\n\n## Unreleased\n\n- Added the runtime.\n\n## 1.3.103\n\n- Previous.\n",
  ...overrides,
});

test("increments the patch and rolls Unreleased on an ordinary merge", () => {
  const result = prepareMergeRelease(fixture());
  assert.equal(result.changed, true);
  assert.equal(result.version, "1.3.104");
  assert.match(result.files["CHANGELOG.md"], /## Unreleased\n\n## 1\.3\.104\n\n- Added the runtime\./);
  assert.equal(JSON.parse(result.files["package-lock.json"]).packages[""].version, "1.3.104");
});

test("uses the merge title when a pull request omitted an Unreleased entry", () => {
  const result = prepareMergeRelease(fixture({
    changelog: "# Changelog\n\n## Unreleased\n\n## 1.3.103\n\n- Previous.\n",
  }));
  assert.match(result.files["CHANGELOG.md"], /## 1\.3\.104\n\n- Add production runtime/);
});

test("uses an explicitly advanced version without incrementing it again", () => {
  const result = prepareMergeRelease(fixture({
    timdsJson: '{"version":"1.4.0"}',
    changelog: "# Changelog\n\n## Unreleased\n\n## 1.4.0\n\n- Major update.\n",
  }));
  assert.deepEqual(result, { changed: false, version: "1.4.0" });
});

test("rejects a version regression", () => {
  assert.throws(() => prepareMergeRelease(fixture({ previousVersion: "1.3.104" })), /regressed/);
});

test("requires synchronized package metadata before incrementing", () => {
  assert.throws(() => prepareMergeRelease(fixture({ packageJson: '{"version":"1.3.102"}' })), /must match/);
});

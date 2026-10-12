import assert from "node:assert/strict";
import test from "node:test";
import { compareVersions, isVersion, nextVersion, prepareMergeRelease } from "./prepare-merge-release.mjs";

const NOW = new Date("2026-10-12T15:00:00Z");

const fixture = (overrides = {}) => ({
  previousVersion: "2026.10.12-1",
  fallbackNote: "Merge pull request #24 from example/branch\n\nAdd production runtime",
  now: NOW,
  timdsJson: '{"version":"2026.10.12-1"}',
  packageJson: '{"name":"root","version":"2026.10.12-1"}',
  packageLock: JSON.stringify({ version: "2026.10.12-1", packages: { "": { version: "2026.10.12-1" } } }),
  changelog: "# Changelog\n\n## Unreleased\n\n- Added the runtime.\n\n## 2026.10.12-1\n\n- Previous.\n",
  ...overrides,
});

test("a second merge the same day counts the release up and rolls Unreleased", () => {
  const result = prepareMergeRelease(fixture());
  assert.equal(result.changed, true);
  assert.equal(result.version, "2026.10.12-2");
  assert.match(result.files["CHANGELOG.md"], /## Unreleased\n\n## 2026\.10\.12-2\n\n- Added the runtime\./);
  assert.equal(JSON.parse(result.files["package-lock.json"]).packages[""].version, "2026.10.12-2");
  assert.equal(JSON.parse(result.files["timds.json"]).version, "2026.10.12-2");
});

test("the first merge of a new day starts at -1", () => {
  const result = prepareMergeRelease(fixture({ now: new Date("2026-10-13T00:30:00Z") }));
  assert.equal(result.version, "2026.10.13-1");
});

test("a system still on MAJOR.MINOR.PATCH moves onto today's date at its next merge", () => {
  const result = prepareMergeRelease(fixture({
    previousVersion: "1.3.103",
    timdsJson: '{"version":"1.3.103"}',
    packageJson: '{"name":"root","version":"1.3.103"}',
    packageLock: JSON.stringify({ version: "1.3.103", packages: { "": { version: "1.3.103" } } }),
    changelog: "# Changelog\n\n## Unreleased\n\n- Added the runtime.\n\n## 1.3.103\n\n- Previous.\n",
  }));
  assert.equal(result.version, "2026.10.12-1");
  assert.match(result.files["CHANGELOG.md"], /## 2026\.10\.12-1\n\n- Added the runtime\.\n\n## 1\.3\.103\n/);
});

test("uses the merge title when a pull request omitted an Unreleased entry, marking a toolkit upgrade as maintenance", () => {
  const result = prepareMergeRelease(fixture({ changelog: "# Changelog\n\n## Unreleased\n\n## 2026.10.12-1\n\n- Previous.\n" }));
  assert.match(result.files["CHANGELOG.md"], /## 2026\.10\.12-2\n\n- Add production runtime/);
  const upgrade = prepareMergeRelease(fixture({
    changelog: "# Changelog\n\n## Unreleased\n\n## 2026.10.12-1\n\n- Previous.\n",
    fallbackNote: "Upgrade TimDS to 0.1.461",
  }));
  assert.match(upgrade.files["CHANGELOG.md"], /## 2026\.10\.12-2\n\n- Maintenance: Upgrade TimDS to 0\.1\.461/);
});

test("uses an explicitly advanced version without incrementing it again", () => {
  const result = prepareMergeRelease(fixture({
    timdsJson: '{"version":"2026.10.12-5"}',
    changelog: "# Changelog\n\n## Unreleased\n\n## 2026.10.12-5\n\n- Major update.\n",
  }));
  assert.deepEqual(result, { changed: false, version: "2026.10.12-5" });
});

test("rejects a version regression and an unknown version form", () => {
  assert.throws(() => prepareMergeRelease(fixture({ previousVersion: "2026.10.12-2" })), /regressed/);
  assert.throws(() => prepareMergeRelease(fixture({ timdsJson: '{"version":"2026.13.01-1"}' })), /Invalid Design System version/);
});

test("requires synchronized package metadata before incrementing", () => {
  assert.throws(() => prepareMergeRelease(fixture({ packageJson: '{"version":"1.3.102"}' })), /must match/);
});

test("orders dated versions by day then release, every legacy version below them", () => {
  assert.ok(compareVersions("2026.10.12-2", "2026.10.12-1") > 0);
  assert.ok(compareVersions("2026.10.12-9", "2026.10.13-1") < 0);
  assert.ok(compareVersions("2026.01.01-1", "99.99.99") > 0);
  assert.equal(compareVersions("1.3.103", "1.3.103"), 0);
  assert.equal(nextVersion("2026.10.12-3", NOW), "2026.10.12-4");
  assert.equal(nextVersion("2026.10.11-3", NOW), "2026.10.12-1");
  assert.equal(nextVersion("0.1.43", NOW), "2026.10.12-1");
  assert.deepEqual(["2026.10.12-1", "1.2.3"].map(isVersion), [true, true]);
  assert.deepEqual(["2026.10.12-0", "2026.10.12.1", "2026.13.01-1", "v1"].map(isVersion), [false, false, false, false]);
});

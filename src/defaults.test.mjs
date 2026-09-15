import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { mergeDefaults, syncDefaults, videoPublishingDefaults } from "./defaults.mjs";
import { videoFixture } from "./video.fixture.mjs";
import { runCli } from "./core.mjs";

test("new defaults advance unchanged values and preserve edits and deletions", () => {
  const previous = { targets: { youtube_short: { brief: "old", maxCharacters: 500, shortBridge: "old CTA" } }, retired: true };
  const current = { targets: { youtube_short: { brief: "old", maxCharacters: 650 } }, retired: true, custom: "owned" };
  const next = { targets: { youtube_short: { brief: "new", maxCharacters: 600, shortBridge: "new CTA" }, instagram_reel: { brief: "new platform" } } };
  const { value, preserved } = mergeDefaults(current, previous, next);
  assert.deepEqual(value, { targets: { youtube_short: { brief: "new", maxCharacters: 650 }, instagram_reel: { brief: "new platform" } }, custom: "owned" });
  assert.deepEqual(preserved, ["publishing.targets.youtube_short.maxCharacters", "publishing.targets.youtube_short.shortBridge"]);
  assert.equal(current.retired, true);
});

test("defaults adoption previews without writing, preserves client source, and is idempotent", async (t) => {
  const workspace = await videoFixture(t);
  const contractPath = path.join(workspace.designSystemRoot, workspace.manifest.video.contract);
  const contract = JSON.parse(await fs.readFile(contractPath, "utf8"));
  contract.publishing = { disclaimer: "Client disclaimer", targets: { youtube_short: { shortBridge: "Client CTA" } } };
  await fs.writeFile(contractPath, JSON.stringify(contract));
  const before = await fs.readFile(contractPath, "utf8");
  const productionPath = path.join(workspace.designSystemRoot, "video/productions/sample-topic/publishing.json");
  const productionBefore = await fs.readFile(productionPath, "utf8");
  assert.ok((await syncDefaults(workspace)).changed.length);
  assert.equal(await fs.readFile(contractPath, "utf8"), before);
  await assert.rejects(fs.access(path.join(workspace.designSystemRoot, ".timds/defaults.json")));
  await syncDefaults(workspace, { apply: true });
  const adopted = JSON.parse(await fs.readFile(contractPath, "utf8"));
  assert.equal(adopted.publishing.disclaimer, "Client disclaimer");
  assert.equal(adopted.publishing.targets.youtube_short.shortBridge, "Client CTA");
  assert.equal(adopted.publishing.targets.youtube_short.brief, (await videoPublishingDefaults()).targets.youtube_short.brief);
  assert.deepEqual(adopted.brand, contract.brand);
  assert.equal(await fs.readFile(productionPath, "utf8"), productionBefore);
  const adoptedBytes = await fs.readFile(contractPath, "utf8");
  assert.deepEqual((await syncDefaults(workspace, { apply: true })).changed, []);
  assert.equal(await fs.readFile(contractPath, "utf8"), adoptedBytes);
});

test("a later toolkit default refresh replaces old defaults while keeping client overrides", async (t) => {
  const workspace = await videoFixture(t);
  await syncDefaults(workspace, { apply: true });
  const contractPath = path.join(workspace.designSystemRoot, workspace.manifest.video.contract);
  const baselinePath = path.join(workspace.designSystemRoot, ".timds/defaults.json");
  const contract = JSON.parse(await fs.readFile(contractPath, "utf8"));
  const baseline = JSON.parse(await fs.readFile(baselinePath, "utf8"));
  baseline.videoPublishing.targets.youtube_short.brief = "Previous toolkit wording";
  contract.publishing.targets.youtube_short.brief = "Previous toolkit wording";
  contract.publishing.targets.facebook_reel.brief = "Client-owned writing brief";
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await fs.writeFile(baselinePath, JSON.stringify(baseline));
  await syncDefaults(workspace, { apply: true });
  const updated = JSON.parse(await fs.readFile(contractPath, "utf8"));
  assert.equal(updated.publishing.targets.youtube_short.brief, (await videoPublishingDefaults()).targets.youtube_short.brief);
  assert.equal(updated.publishing.targets.facebook_reel.brief, "Client-owned writing brief");
});

test("defaults skip non-video systems and reject damaged baseline data", async (t) => {
  assert.equal((await syncDefaults({ manifest: {} })).enabled, false);
  const workspace = await videoFixture(t);
  await syncDefaults(workspace, { apply: true });
  await fs.writeFile(path.join(workspace.designSystemRoot, ".timds/defaults.json"), '{"schemaVersion":9}');
  await assert.rejects(syncDefaults(workspace, { apply: true }), /Invalid TimDS defaults baseline/);
});

test("CLI defaults application requires a feature branch", async (t) => {
  const workspace = await videoFixture(t);
  await fs.writeFile(path.join(workspace.designSystemRoot, "tokens.json"), "{}");
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace.repoRoot, stdio: "ignore" });
  await assert.rejects(runCli(["defaults", "--root", workspace.repoRoot, "--apply"], { output() {} }), /feature branch/);
  const preview = await runCli(["defaults", "--root", workspace.repoRoot, "--apply", "--dry-run"]);
  assert.equal(preview.applied, false);
  await assert.rejects(fs.access(path.join(workspace.designSystemRoot, ".timds/defaults.json")));
});

test("CLI video init creates the publishing defaults baseline", async (t) => {
  const workspace = await videoFixture(t);
  const manifest = JSON.parse(await fs.readFile(workspace.manifestPath, "utf8"));
  delete manifest.video;
  await fs.writeFile(workspace.manifestPath, JSON.stringify(manifest));
  await fs.writeFile(path.join(workspace.designSystemRoot, "tokens.json"), "{}");
  execFileSync("git", ["init", "-b", "design-system/example"], { cwd: workspace.repoRoot, stdio: "ignore" });
  const result = await runCli(["video", "init", "--root", workspace.repoRoot]);
  assert.ok(result.contract);
  await fs.access(path.join(workspace.designSystemRoot, ".timds/defaults.json"));
});

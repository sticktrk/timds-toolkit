import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { initializeRepository, loadWorkspace, runCli, runWithOutputSink, upgradeRepository } from "./core.mjs";
import { publicationFixture } from "./publication.fixture.mjs";
import { publicationDigest, publicationSnapshot } from "./publication-snapshot.mjs";
import { PUBLICATION_STAMP, createPublicationStamp, publishArtifactRef, publishRelease, writePublicationStamp } from "./publish.mjs";

async function fixture(t, embedded = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "timds-publish-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = embedded ? path.join(root, "design-system") : root;
  const input = publicationFixture();
  input.media.assets[0].contentType = "application/octet-stream";
  input.media.assets[0].tags = [" logo "];
  const write = async (file, content) => { const absolute = path.join(sourceRoot, file); await fs.mkdir(path.dirname(absolute), { recursive: true }); await fs.writeFile(absolute, content); };
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe", encoding: "utf8" });
  git("init", "-q", "-b", "main"); git("config", "user.name", "TimDS Test"); git("config", "user.email", "test@example.com");
  await write(".gitignore", "dist/\n.timds/cache/\n");
  await write("timds.json", JSON.stringify(input.manifest)); await write("tokens.json", JSON.stringify(input.tokens)); await write("media.json", JSON.stringify(input.media));
  for (const file of input.sourceFiles) await write(file.path, file.content || "x".repeat(file.bytes));
  git("add", "--all"); git("commit", "-q", "-m", "Contract"); git("remote", "add", "origin", "git@github.com:example/design-system.git");
  for (const file of input.artifactFiles) await write(`dist/${file.path}`, file.content);
  return { root, sourceRoot, git, write, workspace: await loadWorkspace(root) };
}

const resultFor = (stamp, overrides = {}) => ({ status: "published", unchanged: false, automaticUpdates: true, systemId: stamp.systemId, version: stamp.version, publicRoot: "https://example-ds.timds.com/", versionedUrls: { root: "https://example-ds.timds.com/v/1.2.3/", llmsTxt: "https://example-ds.timds.com/v/1.2.3/llms.txt", bundleJson: "https://example-ds.timds.com/v/1.2.3/bundle.json", artifact: "https://example-ds.timds.com/v/1.2.3/.timds-artifact.json" }, ...overrides });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

test("publication schema matches independent canonical digest vectors", () => {
  assert.equal(publicationDigest(publicationFixture(1)), "92c0dd70ca9c431fdba0b93681dff2ea8234f9a0f73a809576c12b3e83113d36");
  assert.equal(publicationDigest(publicationFixture(2)), "c882edfa69832377a19ce13541cde1594318846d205760a73fb2e59ce647d4a8");
  const input = publicationFixture();
  const original = publicationDigest(input);
  input.manifest.workspace = { build: ["other tool"] };
  assert.equal(publicationDigest(input), original, "private build configuration is outside the snapshot");
  input.artifactFiles.reverse(); input.sourceFiles.reverse();
  assert.notEqual(publicationDigest(input), original, "schema-1 asset order is retained");
  assert.equal(publicationSnapshot(input).media.assets[0].rights.status, "");
});

for (const embedded of [false, true]) test(`stamps local ${embedded ? "embedded" : "standalone"} bytes with the checkout commit`, async (t) => {
  const f = await fixture(t, embedded);
  const stamp = await createPublicationStamp(f.workspace);
  assert.equal(stamp.contentDigest, publicationDigest(publicationFixture()));
  assert.equal(stamp.sourceCommit, f.git("rev-parse", "HEAD").trim());
  await f.write("dist/viewer/styles.css", "changed bytes");
  assert.notEqual((await createPublicationStamp(f.workspace)).contentDigest, stamp.contentDigest);
  await f.write("docs/new.md", "# Uncommitted\n");
  await assert.rejects(createPublicationStamp(f.workspace), /Commit the source contract/);
});

test("artifact push stamps the ref and saves the local stamp only after push succeeds", async (t) => {
  const f = await fixture(t); let stagedStamp;
  await assert.rejects(publishArtifactRef(f.workspace, { repository: "example/design-system", run(command, args, cwd) {
    if (args[0] === "push") throw new Error("push denied");
  } }), /push denied/);
  await assert.rejects(fs.access(path.join(f.sourceRoot, PUBLICATION_STAMP)), /ENOENT/);
  const calls = [];
  const stamp = await publishArtifactRef(f.workspace, { repository: "example/design-system", run(command, args, cwd) {
    calls.push(args);
    if (args[0] === "push") stagedStamp = JSON.parse(execFileSync(process.execPath, ["-e", "process.stdout.write(require('fs').readFileSync('.timds-artifact.json'))"], { cwd, encoding: "utf8" }));
  } });
  assert.deepEqual(stagedStamp, stamp);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.sourceRoot, PUBLICATION_STAMP), "utf8")), stamp);
  assert.deepEqual(calls.at(-1), ["push", "--force", "origin", "HEAD:refs/heads/timds-published"]);
});

test("ON and unchanged success verify the public stamp without sending the operator token", async (t) => {
  const f = await fixture(t); const stamp = await writePublicationStamp(f.workspace);
  for (const unchanged of [false, true]) {
    const requests = [];
    const result = await publishRelease(f.workspace, { token: "timds_test", portalUrl: "https://portal.example.com", fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return json(requests.length === 1 ? resultFor(stamp, { unchanged }) : stamp);
    } });
    assert.equal(result.unchanged, unchanged);
    assert.equal(requests[0].url, "https://portal.example.com/api/timds/publish");
    assert.deepEqual(JSON.parse(requests[0].options.body), { systemId: stamp.systemId, version: stamp.version, sourceCommit: stamp.sourceCommit, contentDigest: stamp.contentDigest });
    assert.equal(requests[1].url, "https://example-ds.timds.com/.timds-artifact.json");
    assert.equal(requests[1].options.headers.Authorization, undefined);
  }
});

test("OFF reports the exact waiting candidate and never reads the unchanged public root", async (t) => {
  const f = await fixture(t); const stamp = await writePublicationStamp(f.workspace); let requests = 0;
  const expected = resultFor(stamp, { status: "awaiting-operator", automaticUpdates: false, operatorUrl: "https://timds.com/c/client", candidate: { versionId: "version", version: stamp.version, sourceCommit: stamp.sourceCommit, contentDigest: stamp.contentDigest } });
  assert.deepEqual(await publishRelease(f.workspace, { token: "timds_test", fetchImpl: async () => { requests++; return json(expected); } }), expected);
  assert.equal(requests, 1);
});

test("rejects missing, old and changed local stamps before any request", async (t) => {
  const f = await fixture(t); const options = { token: "timds_test", fetchImpl: () => { throw new Error("must not request"); } };
  await assert.rejects(publishRelease(f.workspace, options), /No local/);
  const stamp = await writePublicationStamp(f.workspace);
  for (const field of ["version", "sourceCommit", "contentDigest", "systemId"]) {
    await writePublicationStamp(f.workspace, { ...stamp, [field]: "old" });
    await assert.rejects(publishRelease(f.workspace, options), /differs from the local/);
  }
  await writePublicationStamp(f.workspace, stamp);
  await f.write("dist/bundle.json", "different");
  await assert.rejects(publishRelease(f.workspace, options), /differs from the local/);
});

test("publication rejection and stale public bytes fail the command", async (t) => {
  const f = await fixture(t); const stamp = await writePublicationStamp(f.workspace);
  await assert.rejects(publishRelease(f.workspace, { token: "timds_test", fetchImpl: async () => json({ error: "candidate does not match" }, 409) }), /409: candidate does not match/);
  for (const status of [401, 403, 500]) await assert.rejects(publishRelease(f.workspace, { token: "timds_test", fetchImpl: async () => json({ error: "rejected" }, status) }), new RegExp(String(status)));
  await assert.rejects(publishRelease(f.workspace, { token: "timds_test", fetchImpl: async (url) => json(url.endsWith("/publish") ? resultFor(stamp) : { ...stamp, contentDigest: "f".repeat(64) }) }), /public root does not serve/);
});

test("rejects artifact symlinks and reserved root metadata", async (t) => {
  const f = await fixture(t);
  await fs.symlink("index.html", path.join(f.sourceRoot, "dist/viewer/link.html"));
  await assert.rejects(createPublicationStamp(f.workspace), /symbolic links/);
  await fs.unlink(path.join(f.sourceRoot, "dist/viewer/link.html"));
  await f.write("dist/.timds-artifact.json", "{}");
  await assert.rejects(createPublicationStamp(f.workspace), /reserved/);
});

test("CLI skip flags call the endpoint and print actionable OFF and verified ON results", async (t) => {
  const f = await fixture(t); const stamp = await writePublicationStamp(f.workspace);
  for (const status of ["published", "awaiting-operator"]) {
    const result = resultFor(stamp, status === "published" ? {} : { status, automaticUpdates: false, operatorUrl: "https://timds.com/c/client", candidate: { versionId: "version", version: stamp.version, sourceCommit: stamp.sourceCommit, contentDigest: stamp.contentDigest } });
    t.mock.method(globalThis, "fetch", async (url) => json(url.endsWith("/publish") ? result : stamp));
    const lines = [];
    await runWithOutputSink((line) => lines.push(line), () => runCli(["publish", "--root", f.root, "--skip-build", "--skip-push", "--token", "timds_test"]));
    assert.match(lines.join("\n"), status === "published" ? /Verified public stamp/ : /awaiting operator publication.*\nOpen https:\/\/timds.com\/c\/client/);
    t.mock.restoreAll();
  }
});

test("managed workflow finishes extraction and ref push before promotion", async () => {
  const source = await fs.readFile(new URL("../templates/timds-standalone.yml", import.meta.url), "utf8");
  const workflow = YAML.parse(source);
  const steps = workflow.jobs.publish.steps;
  const upload = steps.findIndex((step) => step.run?.includes("extract --skip-build --publish"));
  const push = steps.findIndex((step) => step.run?.includes("timds-publish-artifact"));
  const publish = steps.findIndex((step) => step.run?.includes("publish --skip-build --skip-push"));
  assert.ok(upload < push && push < publish);
  assert.equal(publish, steps.length - 1);
  assert.match(steps[upload].run, /exit 1/);
  assert.equal(steps[publish].env.TIMDS_ACCESS_TOKEN, "${{ secrets.TIMDS_ACCESS_TOKEN }}");
});

test("adopted stock automation advances to publication and remains repeatable", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "timds-workflow-upgrade-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q", "-b", "main"); git("config", "user.name", "TimDS Test"); git("config", "user.email", "test@example.com");
  await initializeRepository(root, { standalone: true });
  const previous = await fs.readFile(new URL("fixtures/timds-standalone-before-publish.yml", import.meta.url), "utf8");
  const workflow = ".github/workflows/timds-design-system.yml";
  await fs.writeFile(path.join(root, workflow), previous);
  const recordPath = path.join(root, ".timds/installation.json");
  const record = JSON.parse(await fs.readFile(recordPath, "utf8"));
  record.managedFiles[workflow] = createHash("sha256").update(previous).digest("hex");
  await fs.writeFile(recordPath, JSON.stringify(record));
  git("add", "--all"); git("commit", "-q", "-m", "Previous stock automation");
  const upgraded = await upgradeRepository(root);
  assert.ok(upgraded.releaseAutomationChanges.includes(workflow));
  assert.match(await fs.readFile(path.join(root, workflow), "utf8"), /publish --skip-build --skip-push/);
  git("add", "--all"); git("commit", "-q", "-m", "Publication automation");
  assert.deepEqual((await upgradeRepository(root)).releaseAutomationChanges, []);
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkWorkspace,
  runCli,
  runWithOutputSink,
  createPlumbingPrompt,
  createPreviewServer,
  initializeDesigns,
  initializeRepository,
  loadWorkspace,
  submitWorkspace,
  syncStarterWorkspace,
  upgradeRepository,
  validateArtifact,
  validateManifest,
} from "./core.mjs";
import { describeStarterSync, forceReplaceable, starterManagedFragments, starterPlumbingFiles } from "./starter.mjs";
import { prepareMergeRelease } from "../templates/starter/scripts/prepare-merge-release.mjs";
import {
  addMediaFile,
  backfillMediaMetadata,
  localMediaResponse,
  publishStagedMedia,
  readMediaCatalog,
  resolveMediaSource,
  validateMediaCatalog,
} from "./media.mjs";

const VIDEO_METADATA = { codec: "h264", durationSeconds: 5.042, frameRate: 24, height: 1080, width: 1920 };

// Read from the manifest rather than hardcoding: these assertions describe the
// version the toolkit installs, which changes on every release.
const toolkitVersion = JSON.parse(
  await fs.readFile(new URL("../package.json", import.meta.url), "utf8"),
).version;

const templatesRoot = fileURLToPath(new URL("../templates/", import.meta.url));
const starterFixtureRoot = fileURLToPath(new URL("./fixtures/starter-before-formats/", import.meta.url));

function gitInit(repoRoot) {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.email", "timds-test@example.com"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "TimDS Test"], { cwd: repoRoot });
}

function commitAll(repoRoot, message) {
  execFileSync("git", ["add", "--all"], { cwd: repoRoot });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: repoRoot, stdio: "ignore" });
}

/** Rewind a fresh standalone scaffold to the shape `init` produced before the asset views and format catalog existed. */
async function rewindStarter(repoRoot) {
  await fs.cp(starterFixtureRoot, repoRoot, { force: true, recursive: true });
  for (const relative of ["src/formats.json", "src/styles/canvas.css", "src/pages/digital", "src/pages/print", "src/pages/social", "src/pages/use", ".timds/starter.json"]) {
    await fs.rm(path.join(repoRoot, relative), { force: true, recursive: true });
  }
}

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "timds-cli-"));
  t.after(() => fs.rm(directory, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 }));
  return fs.realpath(directory);
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createDesignSystemRepo(t, { broken = false } = {}) {
  const repoRoot = await temporaryDirectory(t);
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "timds-test@example.com"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "TimDS Test"], { cwd: repoRoot });
  await fs.writeFile(path.join(repoRoot, "README.md"), "# Test\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot });
  execFileSync("git", ["commit", "-m", "Initial"], { cwd: repoRoot, stdio: "ignore" });
  await writeJson(path.join(repoRoot, "design-system", "timds.json"), {
    artifact: { entry: "index.html" },
    name: "Test Design System",
    schemaVersion: 2,
    systemId: "test/core",
    version: "1.0.0",
    workspace: {},
  });
  await writeJson(path.join(repoRoot, "design-system", "tokens.json"), {});
  await fs.mkdir(path.join(repoRoot, "design-system", "dist", "assets"), { recursive: true });
  await fs.writeFile(
    path.join(repoRoot, "design-system", "dist", "index.html"),
    `<link rel="stylesheet" href="/assets/site.css"><main>${broken ? '<img src="/missing.png">' : "Ready"}</main>`,
    "utf8",
  );
  await fs.writeFile(path.join(repoRoot, "design-system", "dist", "assets", "site.css"), ":root{--brand:#123}body{color:var(--brand)}\n", "utf8");
  return repoRoot;
}

test("validates schema 2 manifests with argv workspace commands", () => {
  const manifest = validateManifest({
    artifact: { entry: "index.html" },
    name: "Pierce Law Group",
    schemaVersion: 2,
    systemId: "pierce-law/core",
    version: "2.1.0",
    workspace: { build: ["npm", "run", "build"] },
  });
  assert.deepEqual(manifest.workspace.build, ["npm", "run", "build"]);
  assert.equal(manifest.artifact.entry, "index.html");
});

test("validates brand roles in the manifest and defaults them to empty", () => {
  const base = { artifact: { entry: "index.html" }, name: "Roles", schemaVersion: 2, systemId: "roles/core", version: "1.0.0", workspace: {} };
  assert.deepEqual(validateManifest(base).brand, { guidance: {}, roles: {} });
  assert.deepEqual(validateManifest({ ...base, brand: { roles: { "color.accent": "--gold-300" } } }).brand.roles, { "color.accent": "--gold-300" });
  assert.throws(() => validateManifest({ ...base, brand: { roles: { accent: "--gold-300" } } }), /brand\.roles accent must be color\.<name> or font\.<name>/);
  assert.throws(() => validateManifest({ ...base, brand: "roles" }), /timds\.json brand must be/);
  assert.deepEqual(validateManifest({ ...base, brand: { guidance: { voice: "brand/voice" } } }).brand.guidance, { voice: ["brand/voice"] });
  assert.throws(() => validateManifest({ ...base, brand: { guidance: { voice: ["brand/voice#a b"] } } }), /must be page or page#block/);
});

test("validates explicit native HMR without adding a workspace command", () => {
  const base = { name: "Live preview", systemId: "example/core", version: "1.0.0", workspace: { dev: ["npm", "run", "dev"] } };
  assert.equal(validateManifest(base).live, null);
  assert.equal(validateManifest({ ...base, live: null }).live, null);
  const live = { strategy: "hmr", restartOn: ["astro.config.mjs", "scripts/contract-tokens.mjs", "astro.config.mjs"] };
  const normalized = validateManifest({ ...base, live });
  assert.deepEqual(normalized.live, { strategy: "hmr", restartOn: ["astro.config.mjs", "scripts/contract-tokens.mjs"] });
  assert.deepEqual(normalized.workspace.dev, ["npm", "run", "dev"]);
  assert.equal(normalized.workspace.live, undefined);
  assert.equal(live.restartOn.length, 3, "normalization never mutates authored configuration");
  assert.deepEqual(validateManifest({ ...base, live: { strategy: "hmr", restartOn: [] } }).live.restartOn, []);
  for (const value of [true, [], "hmr", {}, { strategy: "restart", restartOn: [] }, { strategy: "hmr" }, { strategy: "hmr", restartOn: "config.mjs" }, { strategy: "hmr", restartOn: Array(101).fill("config.mjs") }]) {
    assert.throws(() => validateManifest({ ...base, live: value }), /timds\.json live/);
  }
  for (const relative of ["", null, 2, "/tmp/config", "../config", "src/../config", "./config", "src//config", "src/", "C:/config", "src\\config", "src/*.json", "config?.mjs", "[config].mjs", "{a,b}.mjs", "bad\0path", "bad\npath", "bad\u007fpath", "a".repeat(501)]) {
    assert.throws(() => validateManifest({ ...base, live: { strategy: "hmr", restartOn: [relative] } }), /exact relative paths/, String(relative));
  }
});

test("workspace checks retain live configuration and leave the source manifest byte exact", async (t) => {
  const root = await createDesignSystemRepo(t);
  const manifestPath = path.join(root, "design-system", "timds.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.live = { strategy: "hmr", restartOn: ["scripts/contract-tokens.mjs"] };
  await writeJson(manifestPath, manifest);
  const before = await fs.readFile(manifestPath, "utf8");
  assert.deepEqual((await loadWorkspace(root)).manifest.live, manifest.live);
  await checkWorkspace(root, { skipBuild: true });
  assert.equal(await fs.readFile(manifestPath, "utf8"), before);
});

test("release preparation preserves the raw live declaration while advancing only the manifest version", () => {
  const timdsJson = '{\n  "version": "1.0.0",\n  "live": { "strategy": "hmr", "restartOn": ["scripts/compiler.mjs"] }\n}\n';
  const result = prepareMergeRelease({
    timdsJson,
    previousVersion: "1.0.0",
    packageJson: '{"version":"1.0.0"}',
    packageLock: '{"version":"1.0.0","packages":{"":{"version":"1.0.0"}}}',
    changelog: "# Changelog\n\n## Unreleased\n\n- Enable native preview updates.\n\n## 1.0.0\n\n- Initial.\n",
    now: new Date("2026-10-13T00:00:00Z"),
  });
  assert.equal(result.files["timds.json"], timdsJson.replace('"1.0.0"', '"2026.10.13-1"'));
});

test("rejects shell-string workspace commands", () => {
  assert.throws(
    () => validateManifest({
      artifact: { entry: "index.html" },
      name: "Unsafe",
      schemaVersion: 2,
      systemId: "unsafe/core",
      version: "1.0.0",
      workspace: { build: "npm run build" },
    }),
    /non-empty string array/,
  );
});

test("rejects unsafe artifact publication refs", () => {
  assert.throws(
    () => validateManifest({
      artifact: { entry: "index.html", publishRef: "release/../main" },
      name: "Unsafe",
      schemaVersion: 2,
      systemId: "unsafe/core",
      version: "1.0.0",
      workspace: {},
    }),
    /safe Git ref/,
  );
});

test("validates a linked consumer repository contract", () => {
  const manifest = validateManifest({
    artifact: { entry: "index.html", publishRef: "timds-published" },
    consumer: {
      branch: "master",
      path: "design-system",
      repository: "Pierce-Law-Group/wallace-pierce-law",
    },
    name: "WPL Design System",
    schemaVersion: 2,
    systemId: "wpl-design-system/core",
    version: "0.1.0",
    workspace: {},
  });
  assert.deepEqual(manifest.consumer, {
    branch: "master",
    path: "design-system",
    repository: "Pierce-Law-Group/wallace-pierce-law",
  });
  assert.throws(
    () => validateManifest({
      artifact: { entry: "index.html" },
      consumer: { repository: "not-a-repository" },
      name: "Unsafe",
      schemaVersion: 2,
      systemId: "unsafe/core",
      version: "1.0.0",
      workspace: {},
    }),
    /OWNER\/REPOSITORY/,
  );
});

test("validates stable media catalog records and rejects signed URLs", () => {
  const asset = {
    bytes: 24,
    contentType: "image/png",
    filename: "portrait.png",
    id: "asset_12345678",
    key: "attorney-portrait",
    kind: "image",
    publicUrl: "https://assets.timds.com/clients/example/portrait.png",
    sha256: "a".repeat(64),
    tags: ["portrait"],
    title: "Attorney portrait",
  };
  assert.equal(validateMediaCatalog({ assets: [asset], schemaVersion: 2 }).assets[0].key, asset.key);
  const video = validateMediaCatalog({
    assets: [{ ...asset, contentType: "video/mp4", filename: "clip.mp4", kind: "video", ...VIDEO_METADATA }],
    schemaVersion: 2,
  }).assets[0];
  assert.deepEqual(
    { codec: video.codec, durationSeconds: video.durationSeconds, frameRate: video.frameRate, height: video.height, width: video.width },
    VIDEO_METADATA,
  );
  assert.throws(
    () => validateMediaCatalog({ assets: [{ ...asset, durationSeconds: 0 }], schemaVersion: 2 }),
    /durationSeconds is invalid/,
  );
  assert.throws(
    () => validateMediaCatalog({
      assets: [{ ...asset, publicUrl: `${asset.publicUrl}?X-Amz-Signature=temporary` }],
      schemaVersion: 2,
    }),
    /expiring storage signature/,
  );
});

test("init --json emits one parseable result and sends build progress to stderr", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "timds-init-json-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  const cli = fileURLToPath(new URL("../bin/timds.mjs", import.meta.url));
  // The result includes the validated artifact's file buffers; the richer
  // derived layer exceeds execFileSync's default 1 MiB output limit.
  const stdout = execFileSync(process.execPath, [cli, "init", "--standalone", "--root", root, "--name", 'JSON "system"', "--system-id", "test/json-output", "--description", "Worker contract", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 });
  const result = JSON.parse(stdout);
  assert.equal(result.manifest.systemId, "test/json-output");
  assert.equal(result.manifest.name, 'JSON "system"');
  assert.ok(result.initializedArtifact);
});

test("stages media outside Git then publishes only its stable public record", async (t) => {
  const repoRoot = await createDesignSystemRepo(t);
  await initializeRepository(repoRoot);
  const filePath = path.join(repoRoot, "full-resolution.png");
  await fs.writeFile(filePath, Buffer.from("full-resolution-image"));
  const workspace = await checkWorkspace(repoRoot, { skipBuild: true });
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ method: options.method || "GET", url: String(url) });
    if (String(url).endsWith("/api/operator/design-system-assets/uploads")) {
      return Response.json({
        asset: { id: "asset_12345678", kind: "image", publicUrl: "https://assets.timds.test/test/full-resolution.png" },
        upload: {
          completeUrl: "https://timds.test/api/operator/design-system-assets/uploads/upload-1/complete",
          headers: { "x-amz-meta-sha256": "accepted" },
          method: "single",
          url: "https://r2.test/object",
        },
      });
    }
    if (String(url) === "https://r2.test/object") return new Response(null, { status: 200 });
    if (String(url).endsWith("/complete")) {
      return Response.json({ asset: { id: "asset_12345678", kind: "image", publicUrl: "https://assets.timds.test/test/full-resolution.png" } });
    }
    return Response.json({ error: "unexpected" }, { status: 500 });
  };
  const staged = await addMediaFile(workspace, filePath, {
    key: "full-resolution",
    title: "Full-resolution image",
  });
  assert.equal(staged.asset.key, "full-resolution");
  assert.equal(calls.length, 0);
  await fs.access(path.join(repoRoot, "design-system", "media-local", "full-resolution.png"));
  const localSource = await resolveMediaSource(path.join(repoRoot, "design-system"), "full-resolution", { development: true });
  assert.equal(localSource.src, "/__timds/media/full-resolution");
  const rangeResponse = await localMediaResponse(
    new Request("http://localhost/__timds/media/full-resolution", { headers: { Range: "bytes=0-3" } }),
    path.join(repoRoot, "design-system"),
  );
  assert.equal(rangeResponse.status, 206);
  assert.equal(await rangeResponse.text(), "full");
  const result = await publishStagedMedia(workspace, {
    fetchImpl: fakeFetch,
    portalUrl: "https://timds.test",
    token: "test-token",
  });
  assert.equal(result.published[0].asset.id, "asset_12345678");
  assert.deepEqual(calls.map((call) => call.method), ["POST", "PUT", "POST"]);
  const { catalog } = await readMediaCatalog(path.join(repoRoot, "design-system"), { required: true });
  assert.equal(catalog.assets[0].filename, "full-resolution.png");
  assert.equal(catalog.assets[0].key, "full-resolution");
  assert.equal(catalog.assets[0].publicUrl, "https://assets.timds.test/test/full-resolution.png");
  assert.match(catalog.assets[0].sha256, /^[a-f0-9]{64}$/);
  assert.match(await fs.readFile(path.join(repoRoot, "design-system", ".gitignore"), "utf8"), /media-local\/\*/);
  const publicSource = await resolveMediaSource(path.join(repoRoot, "design-system"), "full-resolution");
  assert.equal(publicSource.src, "https://assets.timds.test/test/full-resolution.png");
});

test("uses bounded multipart handshakes for large-media upload plans", async (t) => {
  const repoRoot = await createDesignSystemRepo(t);
  await initializeRepository(repoRoot);
  const filePath = path.join(repoRoot, "b-roll.mp4");
  await fs.writeFile(filePath, Buffer.from("video-master"));
  const workspace = await checkWorkspace(repoRoot, { skipBuild: true });
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    const call = { body: options.body, method: options.method || "GET", url: String(url) };
    calls.push(call);
    if (call.url.endsWith("/api/operator/design-system-assets/uploads")) {
      return Response.json({
        asset: { id: "asset_87654321", kind: "video", publicUrl: "https://assets.timds.test/test/b-roll.mp4" },
        upload: {
          completeUrl: "/api/operator/design-system-assets/uploads/upload-2/complete",
          method: "multipart",
          partsUrl: "/api/operator/design-system-assets/uploads/upload-2/parts",
          partSize: 5 * 1024 ** 2,
        },
      });
    }
    if (call.url.endsWith("/parts")) return Response.json({ url: "https://r2.test/part-1" });
    if (call.url === "https://r2.test/part-1") {
      return new Response(null, { headers: { ETag: '"part-1"' }, status: 200 });
    }
    if (call.url.endsWith("/complete")) {
      const submitted = JSON.parse(options.body);
      assert.deepEqual(submitted.parts, [{ etag: '"part-1"', partNumber: 1 }]);
      return Response.json({ asset: { id: "asset_87654321", kind: "video", publicUrl: "https://assets.timds.test/test/b-roll.mp4" } });
    }
    return Response.json({ error: "unexpected" }, { status: 500 });
  };
  await addMediaFile(workspace, filePath, {
    key: "b-roll",
    probeMedia: async () => VIDEO_METADATA,
  });
  const result = await publishStagedMedia(workspace, {
    fetchImpl: fakeFetch,
    portalUrl: "https://timds.test",
    token: "test-token",
  });
  assert.equal(result.published[0].asset.id, "asset_87654321");
  assert.deepEqual(calls.map((call) => call.method), ["POST", "POST", "PUT", "POST"]);
  const uploadRequest = JSON.parse(calls[0].body);
  assert.equal(uploadRequest.durationSeconds, VIDEO_METADATA.durationSeconds);
  assert.equal(uploadRequest.width, VIDEO_METADATA.width);
  assert.equal(uploadRequest.height, VIDEO_METADATA.height);
  assert.equal(calls[1].url, "https://timds.test/api/operator/design-system-assets/uploads/upload-2/parts");
});

test("cancels the server upload lease when object transfer fails", async (t) => {
  const repoRoot = await createDesignSystemRepo(t);
  await initializeRepository(repoRoot);
  const filePath = path.join(repoRoot, "failed-video.mp4");
  await fs.writeFile(filePath, Buffer.from("video-master"));
  const workspace = await checkWorkspace(repoRoot, { skipBuild: true });
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    const call = { method: options.method || "GET", url: String(url) };
    calls.push(call);
    if (call.url.endsWith("/api/operator/design-system-assets/uploads") && call.method === "POST") {
      return Response.json({
        asset: { id: "asset_failed123", kind: "video", publicUrl: "https://assets.timds.test/test/failed-video.mp4" },
        upload: {
          cancelUrl: "/api/operator/design-system-assets/uploads/upload-failed",
          completeUrl: "/api/operator/design-system-assets/uploads/upload-failed/complete",
          id: "upload-failed",
          headers: { "x-amz-meta-sha256": "accepted" },
          method: "single",
          url: "https://r2.test/failed-object",
        },
      });
    }
    if (call.url === "https://r2.test/failed-object") {
      return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
    }
    if (call.url.endsWith("/upload-failed") && call.method === "DELETE") {
      return Response.json({ ok: true });
    }
    return Response.json({ error: "unexpected" }, { status: 500 });
  };
  await addMediaFile(workspace, filePath, { key: "failed-video", probeMedia: async () => VIDEO_METADATA });
  await assert.rejects(
    publishStagedMedia(workspace, {
      fetchImpl: fakeFetch,
      portalUrl: "https://timds.test",
      token: "test-token",
    }),
    /Object upload returned 403: <Error><Code>AccessDenied<\/Code><\/Error>/,
  );
  assert.deepEqual(calls.map((call) => call.method), ["POST", "PUT", "DELETE"]);
});

test("backfills timed metadata from stable public media without uploading it", async (t) => {
  const repoRoot = await createDesignSystemRepo(t);
  await initializeRepository(repoRoot);
  const designSystemRoot = path.join(repoRoot, "design-system");
  await writeJson(path.join(designSystemRoot, "media.json"), {
    schemaVersion: 2,
    assets: [{
      bytes: 42,
      contentType: "video/mp4",
      filename: "legacy.mp4",
      id: "asset_legacy123",
      key: "legacy-video",
      kind: "video",
      publicUrl: "https://assets.timds.test/legacy.mp4",
      sha256: "b".repeat(64),
      tags: ["b-roll"],
      title: "Legacy video",
    }],
  });
  const workspace = await loadWorkspace(repoRoot);
  const result = await backfillMediaMetadata(workspace, {
    probeMedia: async (source) => {
      assert.equal(source, "https://assets.timds.test/legacy.mp4");
      return VIDEO_METADATA;
    },
  });
  assert.equal(result.updated.length, 1);
  const { catalog } = await readMediaCatalog(designSystemRoot, { required: true });
  assert.equal(catalog.assets[0].durationSeconds, 5.042);
  assert.equal(catalog.assets[0].width, 1920);
  assert.equal(catalog.assets[0].height, 1080);
});

test("validates exact artifact files and local references", async (t) => {
  const repoRoot = await createDesignSystemRepo(t);
  const result = await checkWorkspace(repoRoot, { skipBuild: true });
  assert.equal(result.artifact.entryPath, "index.html");
  // The machine-readable companions are written into, and validated as part of,
  // the published artifact.
  const paths = result.artifact.files.map((file) => file.path);
  assert.ok(paths.includes("index.html"));
  assert.ok(paths.includes("index.json"));
  assert.ok(paths.includes("tokens.json"));
  assert.ok(paths.includes("brand.json"));
  assert.ok(paths.includes("llms.txt"));
  assert.equal(result.artifact.fileCount, paths.length);
  assert.ok(result.machine.enabled);
  // The token layer is read from the stylesheet the page links, not from tokens.json at the root.
  assert.equal(result.machine.counts.tokens, 1);
  assert.equal(result.machine.counts.stylesheets, 1);
  assert.equal(result.machine.tokens.tokens[0].name, "--brand");
  assert.equal(result.machine.tokens.tokens[0].resolved, "#123");
  // --brand fills color.accent by convention; the other roles are reported, not fatal.
  assert.equal(result.machine.counts.roles, 1);
  assert.equal(result.machine.tokens.roles["color.accent"].token, "--brand");
  // Seven unfilled roles, then the empty voice group and the missing logo annotation.
  assert.equal(result.machine.warnings.length, 9);
  assert.match(result.machine.warnings[7], /guidance group voice is empty/);
  assert.match(result.machine.warnings[8], /no asset is annotated data-timds-role="logo"/);
});

test("check fails when a manifest guidance group references a block the artifact lacks", async (t) => {
  const repoRoot = await createDesignSystemRepo(t);
  const manifestPath = path.join(repoRoot, "design-system", "timds.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.brand = { guidance: { voice: ["index#tone"] } };
  await writeJson(manifestPath, manifest);
  // The fixture page has no <h1>, so extract records no page at all: the reference dangles at the page level.
  await assert.rejects(checkWorkspace(repoRoot, { skipBuild: true }), /guidance group voice references index#tone, but the artifact has no page index/);
});

test("check fails when a manifest brand role names a token the stylesheets do not declare", async (t) => {
  const repoRoot = await createDesignSystemRepo(t);
  const manifestPath = path.join(repoRoot, "design-system", "timds.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.brand = { roles: { "color.text": "--ink" } };
  await writeJson(manifestPath, manifest);
  await assert.rejects(checkWorkspace(repoRoot, { skipBuild: true }), /brand role color\.text is mapped to --ink, which no loaded stylesheet declares/);
  manifest.brand = { roles: { "color.text": "--brand" } };
  await writeJson(manifestPath, manifest);
  const result = await checkWorkspace(repoRoot, { skipBuild: true });
  assert.equal(result.machine.tokens.roles["color.text"].source, "manifest");
  assert.equal(result.machine.tokens.roles["color.accent"].source, "convention");
});

test("builds before running the workspace check on a clean artifact", async (t) => {
  const repoRoot = await createDesignSystemRepo(t);
  const designSystemRoot = path.join(repoRoot, "design-system");
  const manifestPath = path.join(designSystemRoot, "timds.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.workspace = {
    build: ["node", "-e", "require('node:fs').appendFileSync('command-order.txt', 'build\\n')"],
    check: ["node", "-e", "const fs=require('node:fs'); if(fs.readFileSync('command-order.txt','utf8')!=='build\\n') process.exit(1); fs.appendFileSync('command-order.txt','check\\n')"],
  };
  await writeJson(manifestPath, manifest);

  await checkWorkspace(repoRoot);

  assert.equal(await fs.readFile(path.join(designSystemRoot, "command-order.txt"), "utf8"), "build\ncheck\n");
});

test("accepts trailing-slash links to static route indexes", async (t) => {
  const repoRoot = await createDesignSystemRepo(t);
  const designSystemRoot = path.join(repoRoot, "design-system");
  await fs.mkdir(path.join(designSystemRoot, "dist", "design-system"), { recursive: true });
  await fs.writeFile(
    path.join(designSystemRoot, "dist", "design-system", "index.html"),
    '<a href="/design-system/">Design System</a>',
    "utf8",
  );
  const manifest = validateManifest(JSON.parse(await fs.readFile(path.join(designSystemRoot, "timds.json"), "utf8")));
  const result = await validateArtifact(designSystemRoot, manifest);
  assert.equal(result.fileCount, 3);
});

test("reports broken artifact references", async (t) => {
  const repoRoot = await createDesignSystemRepo(t, { broken: true });
  const manifest = validateManifest(JSON.parse(await fs.readFile(path.join(repoRoot, "design-system", "timds.json"), "utf8")));
  await assert.rejects(
    validateArtifact(path.join(repoRoot, "design-system"), manifest),
    /index\.html -> \/missing\.png/,
  );
});

test("initializes guarded tooling without overwriting the design-system manifest", async (t) => {
  const repoRoot = await createDesignSystemRepo(t);
  const manifestPath = path.join(repoRoot, "design-system", "timds.json");
  const before = await fs.readFile(manifestPath, "utf8");
  const result = await initializeRepository(repoRoot);
  assert.equal(await fs.readFile(manifestPath, "utf8"), before);
  assert.equal(result.repoRoot, repoRoot);
  // Embedded skills sit at the repository root, one level above the Design System's entry file.
  const claudeEntry = await fs.readFile(path.join(repoRoot, "design-system", "CLAUDE.md"), "utf8");
  assert.match(claudeEntry, /^@AGENTS\.md$/m);
  assert.match(claudeEntry, /`\.\.\/\.agents\/skills\/`/);
  const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.devDependencies["@dtconcepts/timds"], "0.1.x");
  assert.equal(packageJson.scripts.timds, "timds");
  await assert.rejects(fs.access(path.join(repoRoot, "design-system", ".timds", "cli")), /ENOENT/);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(repoRoot, "design-system", ".timds", "installation.json"), "utf8")),
    { name: "@dtconcepts/timds", schemaVersion: 1, version: toolkitVersion },
  );
  await fs.access(path.join(repoRoot, "design-system", "media.json"));
  assert.match(await fs.readFile(path.join(repoRoot, "design-system", ".gitignore"), "utf8"), /\.timds\/cache/);
  assert.match(await fs.readFile(path.join(repoRoot, "design-system", ".gitignore"), "utf8"), /media-local\/\*/);
  await fs.access(path.join(repoRoot, "design-system", "media-local", "README.md"));
  await fs.access(path.join(repoRoot, ".agents", "skills", "timds-edit-design-system", "SKILL.md"));
  await fs.access(path.join(repoRoot, ".agents", "skills", "timds-create-video", "SKILL.md"));
  // The designer skills ship with every system, and Claude Code sees them through one relative link.
  for (const name of ["design-start", "design-media", "design-ship", "design-handoff"]) {
    await fs.access(path.join(repoRoot, ".agents", "skills", name, "SKILL.md"));
    await fs.access(path.join(repoRoot, ".agents", "skills", name, "agents", "openai.yaml"));
  }
  assert.equal(await fs.readlink(path.join(repoRoot, ".claude", "skills")), path.join("..", ".agents", "skills"));
  await fs.access(path.join(repoRoot, ".claude", "skills", "design-ship", "SKILL.md"));
  await fs.access(path.join(repoRoot, ".github", "workflows", "timds-design-system.yml"));
});

test("upgrades clean managed records and removes the legacy vendored CLI", async (t) => {
  const repoRoot = await createDesignSystemRepo(t);
  await initializeRepository(repoRoot);
  await writeJson(path.join(repoRoot, "design-system", ".timds", "installation.json"), {
    name: "@dtconcepts/timds",
    schemaVersion: 1,
    version: "0.1.0",
  });
  const packagePath = path.join(repoRoot, "package.json");
  const packageJson = JSON.parse(await fs.readFile(packagePath, "utf8"));
  packageJson.devDependencies["@dtconcepts/timds"] = "^0.1.1";
  await writeJson(packagePath, packageJson);
  const stalePath = path.join(repoRoot, "design-system", ".timds", "cli", "src", "removed-in-new-release.mjs");
  await fs.mkdir(path.dirname(stalePath), { recursive: true });
  await fs.writeFile(stalePath, "export default true;\n", "utf8");
  execFileSync("git", ["add", "design-system/.timds", ".agents/skills", ".claude/skills", "package.json"], { cwd: repoRoot });
  execFileSync("git", ["commit", "-m", "Install TimDS toolkit"], { cwd: repoRoot, stdio: "ignore" });

  const skillPath = path.join(repoRoot, ".agents", "skills", "timds-edit-design-system", "SKILL.md");
  const originalSkill = await fs.readFile(skillPath, "utf8");
  await fs.writeFile(skillPath, `${originalSkill}\nLocal modification\n`, "utf8");
  await assert.rejects(upgradeRepository(repoRoot), /locally modified TimDS tooling/);
  await fs.writeFile(skillPath, originalSkill, "utf8");

  const result = await upgradeRepository(repoRoot);
  assert.equal(result.previousVersion, "0.1.0");
  assert.equal(result.package.version, toolkitVersion);
  await assert.rejects(fs.access(stalePath), /ENOENT/);
  assert.equal(await fs.readFile(skillPath, "utf8"), originalSkill);
});

test("refuses an upgrade outside the running toolkit release line", async (t) => {
  const repoRoot = await createDesignSystemRepo(t);
  await initializeRepository(repoRoot);
  const packagePath = path.join(repoRoot, "package.json");
  const packageJson = JSON.parse(await fs.readFile(packagePath, "utf8"));
  packageJson.devDependencies["@dtconcepts/timds"] = "0.2.x";
  await writeJson(packagePath, packageJson);
  await assert.rejects(upgradeRepository(repoRoot), /must select the 0\.1\.x @dtconcepts\/timds release line/);
});

test("plans a scoped branch and draft pull request without writing during submit dry-run", async (t) => {
  const repoRoot = await createDesignSystemRepo(t);
  await initializeRepository(repoRoot);
  execFileSync("git", ["add", "--all"], { cwd: repoRoot });
  execFileSync("git", ["commit", "-m", "Initialize TimDS"], { cwd: repoRoot, stdio: "ignore" });
  await writeJson(path.join(repoRoot, "design-system", "tokens.json"), { color: { gold: "#a8863f" } });
  // A change ships with its release note; without one, submit stops before anything is planned.
  await assert.rejects(submitWorkspace(repoRoot, "Darken marketing gold", { dryRun: true, noBuild: true }), /CHANGELOG\.md has no note under ## Unreleased/);
  const changelogPath = path.join(repoRoot, "design-system", "CHANGELOG.md");
  await fs.writeFile(changelogPath, (await fs.readFile(changelogPath, "utf8")).replace("## Unreleased\n", "## Unreleased\n\n- Brand · Color: darken the marketing gold.\n"));
  const result = await submitWorkspace(repoRoot, "Darken marketing gold", { dryRun: true, noBuild: true });
  assert.equal(result.branch, "design-system/darken-marketing-gold");
  assert.deepEqual(result.commands[0], ["git", "switch", "-c", "design-system/darken-marketing-gold"]);
  assert.equal(result.commands.at(-1)[0], "gh");
  assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: repoRoot, encoding: "utf8" }).trim(), "main");
});

test("refuses submit when unrelated repository files are dirty", async (t) => {
  const repoRoot = await createDesignSystemRepo(t);
  await initializeRepository(repoRoot);
  await fs.writeFile(path.join(repoRoot, "README.md"), "Unrelated\n", "utf8");
  await assert.rejects(
    submitWorkspace(repoRoot, "Update tokens", { dryRun: true, noBuild: true }),
    /README\.md/,
  );
});

test("refuses submit from a branch containing unrelated committed changes", async (t) => {
  const repoRoot = await createDesignSystemRepo(t);
  await initializeRepository(repoRoot);
  execFileSync("git", ["add", "design-system", ".agents", ".github", ".gitignore", "package.json"], { cwd: repoRoot });
  execFileSync("git", ["commit", "-m", "Initialize TimDS"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["switch", "-c", "feature/unrelated"], { cwd: repoRoot, stdio: "ignore" });
  await fs.writeFile(path.join(repoRoot, "README.md"), "Unrelated committed work\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot });
  execFileSync("git", ["commit", "-m", "Unrelated work"], { cwd: repoRoot, stdio: "ignore" });
  await writeJson(path.join(repoRoot, "design-system", "tokens.json"), { color: { gold: "#a8863f" } });
  await assert.rejects(
    submitWorkspace(repoRoot, "Update tokens", { dryRun: true, noBuild: true }),
    /committed changes outside the TimDS scope[\s\S]*README\.md/,
  );
});

test("preview server resolves entry, assets, and static routes", async (t) => {
  const repoRoot = await createDesignSystemRepo(t);
  await fs.mkdir(path.join(repoRoot, "design-system", "dist", "brand"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "design-system", "dist", "brand", "index.html"), "Brand", "utf8");
  const server = createPreviewServer({
    artifactRoot: path.join(repoRoot, "design-system", "dist"),
    entryPath: "index.html",
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const get = (pathname) => new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${address.port}${pathname}`, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ body, status: response.statusCode }));
    }).on("error", reject);
  });
  assert.equal((await get("/")).status, 200);
  assert.equal((await get("/assets/site.css")).status, 200);
  assert.deepEqual(await get("/brand"), { body: "Brand", status: 200 });
  assert.equal((await get("/missing")).status, 404);
});

test("loads and validates a standalone repository contract", async (t) => {
  const repoRoot = await temporaryDirectory(t);
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "ignore" });
  await writeJson(path.join(repoRoot, "timds.json"), {
    artifact: { entry: "index.html", publishRef: "timds-published" },
    name: "Standalone Design System",
    schemaVersion: 2,
    systemId: "standalone/core",
    version: "1.0.0",
    workspace: {},
  });
  await writeJson(path.join(repoRoot, "tokens.json"), {});
  await writeJson(path.join(repoRoot, "media.json"), { assets: [], schemaVersion: 1 });
  await fs.mkdir(path.join(repoRoot, "dist"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "dist", "index.html"), "<!doctype html><h1>Standalone</h1>", "utf8");

  const workspace = await loadWorkspace(repoRoot);
  assert.equal(workspace.layout, "standalone");
  assert.equal(workspace.designSystemRoot, repoRoot);
  const checked = await checkWorkspace(repoRoot, { skipBuild: true });
  assert.deepEqual(
    checked.artifact.files.map((file) => file.path).sort(),
    ["brand.json", "index.html", "index.json", "index.md", "llms-full.txt", "llms.txt", "tokens.json"],
  );
  assert.equal(checked.machine.counts.blocks, 1);
  assert.equal(checked.machine.counts.tokens, 0);
});

test("init creates a standalone root that does not exist yet", async (t) => {
  const parent = await temporaryDirectory(t);
  const repoRoot = path.join(parent, "fresh-design-system");

  const result = await initializeRepository(repoRoot, { standalone: true });

  assert.equal(result.repoRoot, repoRoot);
  assert.equal(result.designSystemRoot, repoRoot);
  const manifest = JSON.parse(await fs.readFile(path.join(repoRoot, "timds.json"), "utf8"));
  assert.equal(manifest.systemId, "fresh-design-system/core");
  await fs.access(path.join(repoRoot, "dist", "index.html"));
});

test("initializes the reusable standalone repository shape", async (t) => {
  const repoRoot = await temporaryDirectory(t);
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "timds-test@example.com"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "TimDS Test"], { cwd: repoRoot });

  const result = await initializeRepository(repoRoot, { standalone: true });
  assert.equal(result.designSystemRoot, repoRoot);
  assert.equal(result.initializedArtifact.entryPath, "index.html");
  const manifest = JSON.parse(await fs.readFile(path.join(repoRoot, "timds.json"), "utf8"));
  assert.equal(manifest.artifact.publishRef, "timds-published");
  assert.deepEqual(manifest.workspace.build, ["node", "scripts/build.mjs"]);
  assert.match(await fs.readFile(path.join(repoRoot, "README.md"), "utf8"), /npm run timds -- doctor/);
  // The agent entry points name real commands and paths, with no template placeholder left behind.
  const agentContract = await fs.readFile(path.join(repoRoot, "AGENTS.md"), "utf8");
  assert.match(agentContract, /This repository is the editable source/);
  assert.match(agentContract, /\.agents\/skills\/timds-edit-design-system\/SKILL\.md/);
  assert.match(agentContract, /npm run timds -- brand/);
  const claudeEntry = await fs.readFile(path.join(repoRoot, "CLAUDE.md"), "utf8");
  assert.match(claudeEntry, /^@AGENTS\.md$/m);
  assert.match(claudeEntry, /`\.agents\/skills\/`/);
  for (const document of [agentContract, claudeEntry, await fs.readFile(path.join(repoRoot, "README.md"), "utf8")]) {
    assert.doesNotMatch(document, /__(?:TIMDS_CLI|CONTRACT_DESCRIPTION|DIST_PATH|SKILLS_PATH)__/);
  }
  const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
  // A fresh system is the first release of the day it was scaffolded, in timds.json, package.json, and the changelog alike.
  assert.match(packageJson.version, /^\d{4}\.\d{2}\.\d{2}-1$/);
  assert.equal(packageJson.version, manifest.version);
  assert.match(await fs.readFile(path.join(repoRoot, "CHANGELOG.md"), "utf8"), new RegExp(`\\n## Unreleased\\n\\n## ${manifest.version.replaceAll(".", "\\.")}\\n\\n- Maintenance: Initialize`));
  assert.equal(packageJson.devDependencies["@dtconcepts/timds"], "0.1.x");
  assert.equal(packageJson.scripts["check:versions"], "node scripts/check-versions.mjs");
  assert.equal(packageJson.scripts.release, "node scripts/release.mjs");
  assert.equal(packageJson.scripts["test:release"], "node --test scripts/prepare-merge-release.test.mjs");
  assert.equal(packageJson.scripts.timds, "timds");
  await fs.access(path.join(repoRoot, "src", "site.json"));
  await fs.access(path.join(repoRoot, "src", "layout.html"));
  await fs.access(path.join(repoRoot, "src", "pages", "index.html"));
  await fs.access(path.join(repoRoot, "scripts", "build.mjs"));
  await fs.access(path.join(repoRoot, "scripts", "viewer.mjs"));
  await fs.access(path.join(repoRoot, "scripts", "check-versions.mjs"));
  await fs.access(path.join(repoRoot, "scripts", "prepare-merge-release.mjs"));
  await fs.access(path.join(repoRoot, "scripts", "prepare-merge-release.test.mjs"));
  await fs.access(path.join(repoRoot, "scripts", "release.mjs"));
  await fs.access(path.join(repoRoot, "scripts", "release.sh"));
  await fs.access(path.join(repoRoot, ".github", "workflows", "update-consumer-submodule.yml"));
  await fs.access(path.join(repoRoot, "dist", "index.html"));
  assert.equal(
    JSON.parse(await fs.readFile(path.join(repoRoot, ".timds", "installation.json"), "utf8")).releaseAutomation,
    "merge-patch-v1",
  );
  const releaseWorkflow = await fs.readFile(path.join(repoRoot, ".github", "workflows", "timds-design-system.yml"), "utf8");
  assert.match(releaseWorkflow, /prepare-release:/);
  assert.match(releaseWorkflow, /npm run test:release/);
  assert.match(releaseWorkflow, /sha: \$\{\{ steps\.commit\.outputs\.sha \}\}/);
  assert.doesNotMatch(releaseWorkflow, /^  tag:/m);
  assert.match(await fs.readFile(path.join(repoRoot, ".gitignore"), "utf8"), /node_modules\//);
  assert.match(await fs.readFile(path.join(repoRoot, ".gitignore"), "utf8"), /dist\//);
  assert.match(
    await fs.readFile(path.join(repoRoot, ".agents", "skills", "timds-edit-design-system", "SKILL.md"), "utf8"),
    /standalone Design System/,
  );
  for (const name of ["design-start", "design-media", "design-ship", "design-handoff"]) {
    assert.match(await fs.readFile(path.join(repoRoot, ".agents", "skills", name, "SKILL.md"), "utf8"), new RegExp(`^name: ${name}$`, "m"));
  }
  assert.equal(await fs.readlink(path.join(repoRoot, ".claude", "skills")), path.join("..", ".agents", "skills"));
  assert.match(agentContract, /design-ship/);

  await fs.mkdir(path.join(repoRoot, "node_modules", "example"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "node_modules", "example", "ignored.js"), "ignored\n", "utf8");
  execFileSync("git", ["add", "--all"], { cwd: repoRoot });
  execFileSync("git", ["commit", "-m", "Initialize TimDS"], { cwd: repoRoot, stdio: "ignore" });
  assert.equal(execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repoRoot, encoding: "utf8" }), "");
});

test("initializes opt-in consumer submodule automation", async (t) => {
  const repoRoot = await temporaryDirectory(t);
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "ignore" });
  await writeJson(path.join(repoRoot, "package.json"), {
    name: "existing-design-system-package",
    private: true,
    version: "0.0.0",
  });

  const initialized = await initializeRepository(repoRoot, {
    consumerBranch: "master",
    consumerPath: "design-system",
    consumerRepository: "Pierce-Law-Group/wallace-pierce-law",
    standalone: true,
  });
  assert.equal(initialized.consumer.repository, "Pierce-Law-Group/wallace-pierce-law");

  const manifest = JSON.parse(await fs.readFile(path.join(repoRoot, "timds.json"), "utf8"));
  assert.deepEqual(manifest.consumer, {
    branch: "master",
    path: "design-system",
    repository: "Pierce-Law-Group/wallace-pierce-law",
  });
  const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.version, manifest.version);
  const workflow = await fs.readFile(path.join(repoRoot, ".github", "workflows", "timds-design-system.yml"), "utf8");
  assert.match(workflow, /pin-consumer:/);
  assert.match(workflow, /update-consumer-submodule\.yml/);
  assert.match(workflow, /sha: \$\{\{ needs\.prepare-release\.outputs\.sha \}\}/);
  assert.doesNotMatch(workflow, /tag: \$\{\{/);
  const updater = await fs.readFile(path.join(repoRoot, ".github", "workflows", "update-consumer-submodule.yml"), "utf8");
  assert.match(updater, /TIMDS_CONSUMER_TOKEN/);
  assert.match(updater, /consumer update "\$DESIGN_SYSTEM_VERSION"/, "a published pin moves with the consumer's own toolkit");
  assert.match(updater, /git update-index --cacheinfo/, "a submodule consumer still gets its gitlink advanced");
  assert.match(updater, /INPUT_SHA/);
  assert.match(updater, /declared_version/);
  assert.doesNotMatch(updater, /Resolve release tag/);
});

test("migrates standalone release automation only with explicit replacement of customized files", async (t) => {
  const repoRoot = await temporaryDirectory(t);
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "timds-test@example.com"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "TimDS Test"], { cwd: repoRoot });
  await initializeRepository(repoRoot, { standalone: true });
  execFileSync("git", ["add", "--all"], { cwd: repoRoot });
  execFileSync("git", ["commit", "-m", "Initialize TimDS"], { cwd: repoRoot, stdio: "ignore" });

  const workflowPath = path.join(repoRoot, ".github", "workflows", "timds-design-system.yml");
  await fs.writeFile(workflowPath, "name: Customized release\n", "utf8");
  await assert.rejects(
    upgradeRepository(repoRoot, { autoRelease: true }),
    /Refusing to replace customized release automation/,
  );
  assert.equal(await fs.readFile(workflowPath, "utf8"), "name: Customized release\n");

  const result = await upgradeRepository(repoRoot, { autoRelease: true, force: true });
  assert.ok(result.releaseAutomationChanges.includes(".github/workflows/timds-design-system.yml"));
  assert.match(await fs.readFile(workflowPath, "utf8"), /prepare-release:/);
  const installation = JSON.parse(await fs.readFile(path.join(repoRoot, ".timds", "installation.json"), "utf8"));
  assert.equal(installation.releaseAutomation, "merge-patch-v1");
  assert.deepEqual(Object.keys(installation.managedFiles), [
    ".github/workflows/timds-design-system.yml",
    ".github/workflows/update-consumer-submodule.yml",
    "scripts/release.mjs",
    "scripts/release.sh",
    "scripts/check-versions.mjs",
    "scripts/prepare-merge-release.mjs",
    "scripts/prepare-merge-release.test.mjs",
  ], "every file the migration writes is recorded, so the next upgrade recognizes it as stock");
  execFileSync("node", ["--test", "scripts/prepare-merge-release.test.mjs"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["add", "--all"], { cwd: repoRoot });
  execFileSync("git", ["commit", "--allow-empty", "-m", "Adopt release automation"], { cwd: repoRoot, stdio: "ignore" });
  // Adopted automation now follows every plain upgrade; unmodified stock files never trip the guard.
  assert.deepEqual((await upgradeRepository(repoRoot)).releaseAutomationChanges, []);
  await fs.writeFile(workflowPath, "name: Customized again\n", "utf8");
  await assert.rejects(upgradeRepository(repoRoot), /Refusing to replace customized release automation/);
  assert.equal(await fs.readFile(workflowPath, "utf8"), "name: Customized again\n");
});

test("initializes an embedded contract with a committed starter artifact", async (t) => {
  const repoRoot = await temporaryDirectory(t);
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "timds-test@example.com"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "TimDS Test"], { cwd: repoRoot });
  await fs.writeFile(path.join(repoRoot, "README.md"), "# Existing app\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot });
  execFileSync("git", ["commit", "-m", "Initial"], { cwd: repoRoot, stdio: "ignore" });

  const result = await initializeRepository(repoRoot);
  const designSystemRoot = path.join(repoRoot, "design-system");
  assert.equal(result.initializedArtifact.entryPath, "index.html");
  await fs.access(path.join(designSystemRoot, "dist", "index.html"));
  assert.match(await fs.readFile(path.join(repoRoot, ".gitignore"), "utf8"), /node_modules\//);
  assert.doesNotMatch(await fs.readFile(path.join(designSystemRoot, ".gitignore"), "utf8"), /^dist\/$/m);
  assert.throws(
    () => execFileSync("git", ["check-ignore", "design-system/dist/index.html"], { cwd: repoRoot, stdio: "ignore" }),
  );

  execFileSync("git", ["add", "--all"], { cwd: repoRoot });
  execFileSync("git", ["commit", "-m", "Add TimDS contract"], { cwd: repoRoot, stdio: "ignore" });
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }), "");
  assert.match(
    execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: repoRoot, encoding: "utf8" }),
    /design-system\/dist\/index\.html/,
  );
});


test("the starter viewer renders its site model, and its build guards pages, placeholders, and color literals", async (t) => {
  const repoRoot = await temporaryDirectory(t);
  await initializeRepository(repoRoot, { standalone: true, name: "Client & Co" });
  const run = (script) => execFileSync("node", [`scripts/${script}.mjs`], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const fails = (script, pattern) => assert.throws(() => run(script), (error) => pattern.test(String(error.stderr)));
  const read = (relative) => fs.readFile(path.join(repoRoot, relative), "utf8");
  const site = JSON.parse(await read("src/site.json"));
  const declared = site.views.flatMap((view) => view.pages.map((page) => ({ ...page, id: page.slug ? `${view.id}/${page.slug}` : view.id })));

  // Every authored page is built into the shared shell; a planned page is declared but never built.
  for (const page of declared) {
    const built = path.join(repoRoot, "dist", page.id, "index.html");
    if (page.planned) await assert.rejects(fs.access(built), page.id);
    else assert.match(await fs.readFile(built, "utf8"), /<main id="content"/, page.id);
  }
  const overview = await read("dist/index.html");
  assert.match(overview, /<h1 class="page-title">Client &amp; Co<\/h1>/);
  // The version chip opens the changelog TimDS renders outside the views; the starter build writes it so dev shows it.
  assert.match(overview, /<a class="appbar__version" href="\/changelog\/" title="Changelog">v\d{4}\.\d{2}\.\d{2}-1<\/a>/);
  const changelogPage = await read("dist/changelog/index.html");
  assert.match(changelogPage, /<title>Changelog · Client &amp; Co<\/title>/);
  assert.match(changelogPage, /<link rel="stylesheet" href="\/tokens\.css">/);
  assert.match(changelogPage, /<span class="td-changelog-area is-maintenance">Maintenance<\/span> Initialize the TimDS contract and starter viewer\./);
  assert.match(changelogPage, /<span class="td-changelog-current">Current<\/span>/);
  assert.match(overview, /<span class="tag">Planned<\/span>/);
  assert.doesNotMatch(overview, /\{\{/);
  // The sample website design is listed by the viewer and built by TimDS as whole pages, states beside them.
  assert.match(overview, /<a class="appbar__view" href="\/designs\/"><b>Designs<\/b>/);
  assert.match(overview, /<a href="\/designs\/website\/">Marketing site<\/a><\/td><td>Designs<\/td>[\s\S]*?<td>2 pages<\/td>/);
  assert.match(await read("dist/designs/index.html"), /<a href="\/designs\/website\/contact\/sent\.html">sent<\/a>/);
  const contact = await read("dist/designs/website/contact/index.html");
  assert.match(contact, /<a class="site-header__brand" href="\/designs\/website\/">Client &amp; Co<\/a>/, "site routes point at the design's place in the artifact");
  assert.doesNotMatch(contact, /viewer\.css/, "a design loads the system, not the documentation chrome");
  const color = await read("dist/brand/color/index.html");
  assert.match(color, /<a href="\/brand\/color\/" aria-current="page">Color<\/a>/);
  assert.match(color, /<td><code>color\.accent<\/code><\/td><td><code>--color-accent<\/code><\/td>/, "token tables come from tokens.json");
  assert.match(color, /class="pagenav"[\s\S]*← Typography[\s\S]*Spacing &amp; shape →/, "previous and next follow the site model");
  // Format tables and previews come from src/formats.json; a format's planned page is named, never linked.
  const digital = await read("dist/digital/index.html");
  assert.match(digital, /<td><strong>Medium rectangle<\/strong><\/td><td><span style="white-space:nowrap">300 × 250 px<\/span><\/td><td>12 px<\/td><td>PNG or JPG<\/td><td>150 KB<\/td><td>Google Display Ads <span class="tag">Planned<\/span><\/td>/);
  assert.match(digital, /<div class="canvas-frame canvas-frame--actual" style="--cw:728;--ch:90;--safe:8;--bleed:0;--ui-t:0;--ui-b:0;--ui-l:0;--ui-r:0;--clear-l:0;--clear-r:0">/);
  assert.match(await read("dist/print/index.html"), /<td><strong>Letterhead · US Letter<\/strong><\/td><td><span style="white-space:nowrap">8\.5″ × 11″<\/span><\/td><td>0\.125″<\/td><td>0\.5″<\/td>/);
  assert.match(await read("dist/social/index.html"), /style="--cw:1080;--ch:1920;--safe:64;--bleed:0;--ui-t:250;--ui-b:340;/, "platform bands reach the preview");

  // The derived layer carries only authored guidance, so the brand kit still reports what the client has not supplied.
  const { designs, machine } = await checkWorkspace(repoRoot);
  assert.deepEqual(machine.pages.map((page) => page.id), ["brand/color", "brand/typography", "digital", "index", "print", "social", "use", "web/components", "web/spacing"], "design and changelog pages are not guidance");
  assert.deepEqual(machine.index.changelog, { url: "/changelog.json", page: "/changelog/", releases: 1, latest: machine.index.system.version });
  assert.equal(JSON.parse(await read("dist/changelog.json")).releases[0].entries[0].area, "Maintenance");
  assert.equal(machine.counts.untyped, 0);
  assert.deepEqual(machine.warnings.map((warning) => warning.split(":")[0]), ["guidance group voice is empty", 'no asset is annotated data-timds-role="logo"; the brand kit has no logo']);
  assert.equal(machine.formats.count, 48);
  assert.ok(machine.formats.groups.flatMap((group) => group.formats).every((format) => format.planned === true && !format.pageUrl));
  assert.deepEqual(designs, { enabled: true, designCount: 1, pageCount: 2, stateCount: 3 });
  assert.deepEqual(machine.index.designs, { url: "/designs.json", count: 1, pages: 2, states: 3 });
  const designsDocument = JSON.parse(await read("dist/designs.json"));
  assert.deepEqual(designsDocument.designs[0].pages.map((page) => [page.route, page.title, page.states.map((state) => state.name)]), [["/", "Home", ["default"]], ["/contact", "Contact", ["default", "sent"]]]);

  // JavaScript survives the complete build/check/extraction path without running on the build host.
  await fs.writeFile(path.join(repoRoot, "src/designs/website/pages/about.html"), '<section class="hero"><h1>About</h1><button onclick="this.textContent=\'Done\'">Try</button><script src="/assets/interactions.js"></script></section>\n');
  await fs.mkdir(path.join(repoRoot, "src/assets"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "src/assets/interactions.js"), 'document.body.dataset.ready = "true";');
  assert.equal((await checkWorkspace(repoRoot)).designs.pageCount, 3);
  assert.match(await read("dist/designs/website/about/index.html"), /<script src="\/assets\/interactions\.js"><\/script>/);
  assert.equal(await read("dist/assets/interactions.js"), 'document.body.dataset.ready = "true";');

  // A design may use only what the system defines; check names the file and what it reached for.
  await fs.writeFile(path.join(repoRoot, "src/designs/website/pages/about.html"), '<section class="hero fancy"><h1>About</h1><p style="color:red">x</p><script>1</script></section>\n');
  await assert.rejects(checkWorkspace(repoRoot), (error) => /src\/designs\/website\/pages\/about\.html: uses classes the linked stylesheets do not declare \(fancy\)/.test(error.message)
    && /about\.html: 1 element has a style attribute/.test(error.message));
  await fs.rm(path.join(repoRoot, "src/designs/website/pages/about.html"));
  // A state without its default page, and a view that would collide with the designs output, both stop the build.
  await fs.writeFile(path.join(repoRoot, "src/designs/website/pages/orders.empty.html"), "<h1>No orders</h1>\n");
  await assert.rejects(checkWorkspace(repoRoot), /route \/orders of design website has states .* but no default page; author pages\/orders\.html first/);
  await fs.rm(path.join(repoRoot, "src/designs/website/pages/orders.empty.html"));
  site.views.push({ id: "designs", label: "Designs", pages: [{ slug: "", title: "Designs", planned: true }] });
  await writeJson(path.join(repoRoot, "src/site.json"), site);
  fails("build", /may not declare a view named designs while src\/designs\/ exists/);
  site.views.pop();
  await writeJson(path.join(repoRoot, "src/site.json"), site);

  // Authoring a planned page without clearing its flag, and the reverse, both stop the build.
  await fs.writeFile(path.join(repoRoot, "src/pages/brand/voice.html"), '<span class="eyebrow">Brand</span>\n<h1 class="page-title">Voice</h1>\n<section class="block" id="rules"><h2 class="h2">Rules</h2><p>Lead with the answer.</p></section>\n');
  fails("build", /remove "planned": true from brand\/voice/);
  const voice = site.views[0].pages.find((page) => page.slug === "voice");
  delete voice.planned;
  await writeJson(path.join(repoRoot, "src/site.json"), site);
  assert.match(run("build"), /10 pages/);
  assert.match(await read("dist/brand/voice/index.html"), /Lead with the answer/);
  await fs.rm(path.join(repoRoot, "src/pages/brand/voice.html"));
  fails("build", /src\/pages\/brand\/voice\.html is missing/);
  voice.planned = true;
  await writeJson(path.join(repoRoot, "src/site.json"), site);

  await fs.writeFile(path.join(repoRoot, "src/pages/orphan.html"), "<h1>Orphan</h1>\n");
  fails("check", /src\/pages\/orphan\.html is not declared in src\/site\.json/);
  await fs.rm(path.join(repoRoot, "src/pages/orphan.html"));

  const colorSource = await read("src/pages/brand/color.html");
  await fs.writeFile(path.join(repoRoot, "src/pages/brand/color.html"), colorSource.replace("{{tokens:color}}", "{{tokens:colour}}"));
  fails("check", /tokens\.json has no colour group/);
  await fs.writeFile(path.join(repoRoot, "src/pages/brand/color.html"), colorSource.replace("{{tokens:color}}", "{{palette}}"));
  fails("check", /unknown placeholder \{\{palette\}\}/);
  await fs.writeFile(path.join(repoRoot, "src/pages/brand/color.html"), colorSource);

  // A format names a declared page, ids are unique across groups, and a page previews only a declared format.
  const formats = JSON.parse(await read("src/formats.json"));
  formats.print.formats.letterhead.page = "print/stationery";
  await writeJson(path.join(repoRoot, "src/formats.json"), formats);
  fails("check", /format print\.letterhead names the page "print\/stationery", which src\/site\.json does not declare/);
  formats.print.formats.letterhead.page = "print/letterheads";
  formats.social.formats.letterhead = { ...formats.print.formats.letterhead };
  await writeJson(path.join(repoRoot, "src/formats.json"), formats);
  fails("check", /declares the format letterhead twice/);
  delete formats.social.formats.letterhead;
  await writeJson(path.join(repoRoot, "src/formats.json"), formats);
  const digitalSource = await read("src/pages/digital/index.html");
  await fs.writeFile(path.join(repoRoot, "src/pages/digital/index.html"), digitalSource.replace("{{canvas:gdn-728x90}}", "{{canvas:gdn-728x91}}"));
  fails("check", /uses \{\{canvas:gdn-728x91\}\}, but src\/formats\.json declares no format gdn-728x91/);
  await fs.writeFile(path.join(repoRoot, "src/pages/digital/index.html"), digitalSource.replace("{{formats:digital}}", "{{formats:screen}}"));
  fails("check", /src\/formats\.json has no screen group/);
  await fs.writeFile(path.join(repoRoot, "src/pages/digital/index.html"), digitalSource);

  await fs.appendFile(path.join(repoRoot, "src/styles/system.css"), "\n#facade { color: var(--color-ink); }\n.button--danger { background: #b00020; }\n");
  fails("check", /Color literals belong in tokens\.json.*\(src\/styles\/system\.css:\d+\)/);
});


test("designs init adopts website designs in a system scaffolded without them", async (t) => {
  const repoRoot = await temporaryDirectory(t);
  await initializeRepository(repoRoot, { standalone: true });
  const read = (relative) => fs.readFile(path.join(repoRoot, relative), "utf8");
  // Simulate the earlier scaffold: no designs, and a system stylesheet without the layout block.
  await fs.rm(path.join(repoRoot, "src/designs"), { recursive: true });
  const stylesheet = await read("src/styles/system.css");
  const stripped = stylesheet.replace(/\/\* ---- site layout ---- \*\/[\s\S]*?\/\* ---- end site layout ---- \*\/\n/, "");
  assert.notEqual(stripped, stylesheet);
  await fs.writeFile(path.join(repoRoot, "src/styles/system.css"), stripped);
  await fs.appendFile(path.join(repoRoot, "scripts/build.mjs"), "// client change\n");

  const result = await initializeDesigns(repoRoot);
  await fs.access(path.join(repoRoot, "src/designs/website/pages/contact.sent.html"));
  assert.deepEqual(result.scripts, [{ path: "scripts/build.mjs", status: "customized" }, { path: "scripts/viewer.mjs", status: "current" }]);
  assert.equal(result.stylesheet, "appended", "the stock token names let the layout block be restored");
  assert.deepEqual(result.missingClasses, []);
  assert.match(await read("src/styles/system.css"), /\/\* ---- site layout ---- \*\/[\s\S]*\.site-footer/);
  assert.match(await read("scripts/build.mjs"), /client change/, "a customized script is never replaced");
  const checked = await checkWorkspace(repoRoot);
  assert.equal(checked.designs.pageCount, 2);
  await assert.rejects(initializeDesigns(repoRoot), /src\/designs\/ already exists/);

  // A system that renamed its tokens is told which classes the sample needs rather than given a block that would not resolve.
  await fs.rm(path.join(repoRoot, "src/designs"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "src/styles/system.css"), stripped);
  const tokens = JSON.parse(await read("tokens.json"));
  tokens.spacing = tokens.space;
  delete tokens.space;
  await fs.rename(path.join(repoRoot, "tokens/space.json"), path.join(repoRoot, "tokens/spacing.json"));
  const renamed = await initializeDesigns(repoRoot);
  assert.equal(renamed.stylesheet, "untouched");
  assert.deepEqual(renamed.missingClasses, ["form", "hero", "notice", "section", "site-footer", "site-header", "site-header__brand", "site-nav", "wrap"]);
  assert.equal(await read("src/styles/system.css"), stripped);

  // --force rewrites the sample and the customized script, and the starter record learns the hash it wrote.
  const staleRecord = JSON.parse(await read(".timds/starter.json"));
  staleRecord.files["scripts/build.mjs"] = "stale";
  await writeJson(path.join(repoRoot, ".timds/starter.json"), staleRecord);
  const forced = await initializeDesigns(repoRoot, { force: true });
  assert.deepEqual(forced.scripts.map((script) => script.status), ["updated", "current"]);
  assert.doesNotMatch(await read("scripts/build.mjs"), /client change/);
  const stockBuild = await fs.readFile(path.join(templatesRoot, "starter/scripts/build.mjs"), "utf8");
  assert.equal(JSON.parse(await read(".timds/starter.json")).files["scripts/build.mjs"], createHash("sha256").update(stockBuild).digest("hex"));
});

test("standalone init accepts explicit immutable identity and JSON-safe text", async (t) => {
  const parent = await temporaryDirectory(t);
  const root = path.join(parent, "ephemeral-workspace");
  const options = { standalone: true, name: 'Client "Brand"', systemId: "client/immutable-123", description: "First line\nSecond line" };
  const result = await initializeRepository(root, options);
  assert.equal(result.manifest.name, options.name);
  assert.equal(result.manifest.systemId, options.systemId);
  assert.equal(result.manifest.description, options.description);
  assert.equal(result.layout, "standalone");
  assert.match(result.package.version, /^0\.1\./);
  await initializeRepository(root, options);
  await assert.rejects(initializeRepository(root, { ...options, systemId: "other/id" }), /conflicts/);
  await assert.rejects(initializeRepository(path.join(parent, "bad"), { systemId: "../bad" }), /hierarchical/);
});


test("standalone publication treats a GitHub bootstrap commit as an initial contract", async (t) => {
  const root = await temporaryDirectory(t);
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await fs.writeFile(path.join(root, "README.md"), "Bootstrap\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "-m", "Bootstrap"], { cwd: root, stdio: "ignore" });
  const bootstrap = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
  await initializeRepository(root, { standalone: true });
  const workflow = await fs.readFile(path.join(root, ".github/workflows/timds-design-system.yml"), "utf8");
  const condition = workflow.split("\n").find((line) => line.includes('if [[ "$EVENT_NAME"'));
  const script = `${condition}\n echo bump;\nelse\n echo initial;\nfi`;
  const evaluate = (before) => execFileSync("bash", ["-c", script], { cwd: root, env: { ...process.env, EVENT_NAME: "push", BEFORE_SHA: before } }).toString().trim();
  assert.equal(evaluate(bootstrap), "initial");
  execFileSync("git", ["add", "timds.json"], { cwd: root });
  execFileSync("git", ["commit", "-m", "Initial contract"], { cwd: root, stdio: "ignore" });
  assert.equal(evaluate(execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim()), "bump");
});


test("starter sync adopts a scaffold from before the asset views, and upgrade keeps it current afterwards", async (t) => {
  const repoRoot = await temporaryDirectory(t);
  gitInit(repoRoot);
  await initializeRepository(repoRoot, { standalone: true, name: "Client & Co" });
  await rewindStarter(repoRoot);
  commitAll(repoRoot, "Scaffold before asset views");
  const read = (relative) => fs.readFile(path.join(repoRoot, relative), "utf8");
  // The rewound scaffold is a working system of the earlier shape.
  const before = await checkWorkspace(repoRoot);
  assert.deepEqual(before.machine.pages.map((page) => page.id), ["brand/color", "brand/typography", "index", "web/components", "web/spacing"]);

  // The sync rewrites the catalogs and layout whole, so it refuses to run over uncommitted changes to the files it writes.
  await fs.appendFile(path.join(repoRoot, "src/layout.html"), "\n");
  await assert.rejects(syncStarterWorkspace(repoRoot), /Starter sync refuses to run over uncommitted changes to the files it writes:\n\s*M src\/layout\.html\nCommit or stash them first/);
  execFileSync("git", ["checkout", "--", "src/layout.html"], { cwd: repoRoot, stdio: "ignore" });

  const result = await syncStarterWorkspace(repoRoot);
  assert.equal(result.adopted, true);
  assert.deepEqual(result.files.map((file) => [file.path, file.status]), [
    ["scripts/build.mjs", "updated"],
    ["scripts/check.mjs", "updated"],
    ["scripts/dev.mjs", "current"],
    ["scripts/viewer.mjs", "updated"],
    ["src/styles/canvas.css", "created"],
    ["src/styles/viewer.css", "current"],
    ["src/site.json", "updated"],
    ["src/formats.json", "created"],
    ["src/pages/digital/index.html", "created"],
    ["src/pages/print/index.html", "created"],
    ["src/pages/social/index.html", "created"],
    ["src/pages/use/index.html", "created"],
    ["src/layout.html", "updated"],
  ]);
  assert.deepEqual(result.site, { addedPages: ["web/email", "web/email-templates"], addedViews: ["digital", "social", "print", "use"], advanced: ["web.label", "web.blurb"], kept: [] });
  assert.deepEqual([result.formats.addedGroups, result.formats.addedFormats.length, result.formats.kept, result.formats.skipped], [["print", "digital", "social"], 48, [], []]);
  // Nothing here was customized, so the merged catalogs and refreshed files equal the stock scaffold's byte for byte.
  for (const relative of ["src/site.json", "src/formats.json", "src/layout.html", "scripts/viewer.mjs", "scripts/check.mjs", "src/styles/canvas.css", "src/pages/print/index.html", "src/pages/use/index.html"]) {
    assert.equal(await read(relative), await fs.readFile(path.join(templatesRoot, "starter", relative), "utf8"), relative);
  }
  assert.doesNotMatch(await read("src/pages/index.html"), /Digital DS/, "the client's own overview fragment is never rewritten");
  assert.deepEqual(result.check.machine.warnings.map((warning) => warning.split(":")[0]), ["guidance group voice is empty", 'no asset is annotated data-timds-role="logo"; the brand kit has no logo']);
  const record = JSON.parse(await read(".timds/starter.json"));
  assert.equal(record.version, toolkitVersion);
  assert.deepEqual(Object.keys(record.files).sort(), [...starterPlumbingFiles, ...starterManagedFragments].map(([relative]) => relative).sort());
  assert.deepEqual(record.baseline.site, JSON.parse(await fs.readFile(path.join(templatesRoot, "starter/src/site.json"), "utf8")));

  // A second sync has nothing to do and runs no check.
  commitAll(repoRoot, "Adopt the starter sync");
  const again = await syncStarterWorkspace(repoRoot);
  assert.deepEqual([again.adopted, again.written, again.check], [false, [], null]);
  assert.ok(again.files.every((file) => file.status === "current"), JSON.stringify(again.files));

  // From now on every upgrade syncs the starter, under the same clean-tree rule; a system without the record is only told how to opt in.
  await fs.appendFile(path.join(repoRoot, "src/site.json"), "\n");
  await assert.rejects(upgradeRepository(repoRoot), /Starter sync refuses to run over uncommitted changes to the files it writes:\n\s*M src\/site\.json/);
  execFileSync("git", ["checkout", "--", "src/site.json"], { cwd: repoRoot, stdio: "ignore" });
  const upgraded = await upgradeRepository(repoRoot);
  assert.deepEqual([upgraded.starterAvailable, upgraded.starter.written], [false, []]);

  // upgrade --force stays with the managed boundary: a customized starter file is reported and kept, never replaced by upgrade.
  await fs.appendFile(path.join(repoRoot, "scripts/dev.mjs"), "\n// client change\n");
  commitAll(repoRoot, "Customize dev.mjs");
  const forcedUpgrade = await upgradeRepository(repoRoot, { force: true });
  assert.deepEqual(forcedUpgrade.starter.files.find((file) => file.path === "scripts/dev.mjs"), { path: "scripts/dev.mjs", status: "customized" });
  assert.deepEqual(forceReplaceable(forcedUpgrade.starter), ["scripts/dev.mjs"]);
  assert.match(await read("scripts/dev.mjs"), /client change/);

  // A sync that fails its check runs before the managed files are touched, so the upgrade aborts with the repository as it was and a plain rerun is not refused.
  const stockViewer = await read("scripts/viewer.mjs");
  await fs.writeFile(path.join(repoRoot, "scripts/viewer.mjs"), `${stockViewer}\nthrow new Error("client change broke the viewer");\n`);
  await fs.rm(path.join(repoRoot, "src/styles/canvas.css"));
  await fs.rm(path.join(repoRoot, ".agents/skills/timds-edit-design-system"), { recursive: true });
  commitAll(repoRoot, "Break the viewer and drop the managed skill");
  for (const attempt of [1, 2]) {
    await assert.rejects(upgradeRepository(repoRoot), /Starter sync was rolled back because the workspace check failed afterwards/, `attempt ${attempt}`);
    await assert.rejects(fs.access(path.join(repoRoot, ".agents/skills/timds-edit-design-system")), /ENOENT/, "the managed skill was not reinstalled by the aborted upgrade");
    await assert.rejects(fs.access(path.join(repoRoot, "src/styles/canvas.css")), /ENOENT/);
    assert.equal(execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repoRoot, encoding: "utf8" }).trim(), "", "nothing is left behind");
  }
  execFileSync("git", ["checkout", "HEAD~1", "--", "scripts/viewer.mjs", "src/styles/canvas.css", ".agents/skills/timds-edit-design-system"], { cwd: repoRoot, stdio: "ignore" });
  commitAll(repoRoot, "Restore the viewer");
  await fs.rm(path.join(repoRoot, ".timds/starter.json"));
  commitAll(repoRoot, "Drop the record");
  const unadopted = await upgradeRepository(repoRoot);
  assert.deepEqual([unadopted.starter, unadopted.starterAvailable], [null, true]);
});

test("starter sync adds a view a newer scaffold declares to a system adopted under an earlier release", async (t) => {
  // A fresh scaffold is adopted at the current release. Rewind its record and
  // site model to the release before the Use view existed: the baseline site
  // lacks the view, the record never saw the fragment, and the system has
  // neither. This is the shape every adopted system has when a release adds a
  // managed view, so the sync's recorded mode must add it end to end.
  const repoRoot = await temporaryDirectory(t);
  gitInit(repoRoot);
  await initializeRepository(repoRoot, { standalone: true, name: "Client & Co" });
  const read = (relative) => fs.readFile(path.join(repoRoot, relative), "utf8");
  const dropUse = (site) => ({ ...site, views: site.views.filter((view) => view.id !== "use") });
  const record = JSON.parse(await read(".timds/starter.json"));
  assert.ok(record.files["src/pages/use/index.html"], "a fresh scaffold records the Use fragment");
  delete record.files["src/pages/use/index.html"];
  record.baseline.site = dropUse(record.baseline.site);
  record.version = "0.1.0";
  await writeJson(path.join(repoRoot, ".timds/starter.json"), record);
  await writeJson(path.join(repoRoot, "src/site.json"), dropUse(JSON.parse(await read("src/site.json"))));
  await fs.rm(path.join(repoRoot, "src/pages/use"), { recursive: true });
  commitAll(repoRoot, "Adopted before the Use view");

  const result = await syncStarterWorkspace(repoRoot);
  assert.equal(result.adopted, false, "the record was present, so this is a re-sync, not an adoption");
  assert.deepEqual(result.site, { addedPages: [], addedViews: ["use"], advanced: [], kept: [] }, "a new view is reported as the view; its pages come with it");
  assert.deepEqual(result.files.filter((file) => file.status !== "current").map((file) => [file.path, file.status]), [
    ["src/site.json", "updated"],
    ["src/pages/use/index.html", "created"],
  ]);
  const stock = await fs.readFile(path.join(templatesRoot, "starter/src/pages/use/index.html"), "utf8");
  assert.equal(await read("src/pages/use/index.html"), stock, "the fragment is written byte for byte");
  assert.equal(await read("src/site.json"), await fs.readFile(path.join(templatesRoot, "starter/src/site.json"), "utf8"), "the view is appended as the scaffold declares it");
  assert.ok(result.check.machine.pages.map((page) => page.id).includes("use"), "the check that follows builds the page");
  const after = JSON.parse(await read(".timds/starter.json"));
  assert.equal(after.version, toolkitVersion);
  assert.ok(after.files["src/pages/use/index.html"], "the record now carries the fragment so later syncs can refresh it while unmodified");
  assert.ok(after.baseline.site.views.some((view) => view.id === "use"));

  // A second sync has nothing to do; a fragment the system then edits is its own page and stays.
  commitAll(repoRoot, "Sync the Use view");
  const again = await syncStarterWorkspace(repoRoot);
  assert.deepEqual([again.written, again.check], [[], null]);
  await fs.appendFile(path.join(repoRoot, "src/pages/use/index.html"), "\n<p class=\"note\">Our own addition.</p>\n");
  commitAll(repoRoot, "Extend the Use page");
  const customized = await syncStarterWorkspace(repoRoot);
  assert.deepEqual(customized.files.find((file) => file.path === "src/pages/use/index.html").status, "customized");
  assert.match(await read("src/pages/use/index.html"), /Our own addition/);
});

test("starter sync reports customized files, rolls back when they break the check, and replaces them only with --force", async (t) => {
  const repoRoot = await temporaryDirectory(t);
  await initializeRepository(repoRoot, { standalone: true });
  const read = (relative) => fs.readFile(path.join(repoRoot, relative), "utf8");
  // A fresh scaffold is recorded as adopted, so its first sync is a no-op.
  const fresh = await syncStarterWorkspace(repoRoot);
  assert.deepEqual([fresh.adopted, fresh.written, fresh.recordWritten, fresh.plumbing], [false, [], false, "toolkit"]);
  // A fresh scaffold's plumbing is the toolkit's outright: a local change is brought back to stock, reported, and nothing halts or needs --force.
  assert.equal(JSON.parse(await read(".timds/starter.json")).plumbing, "toolkit");
  await fs.appendFile(path.join(repoRoot, "scripts/dev.mjs"), "\n// client change\n");
  const owned = await syncStarterWorkspace(repoRoot);
  assert.deepEqual(owned.files.find((file) => file.path === "scripts/dev.mjs"), { note: "the toolkit's in this system; a local change was replaced", path: "scripts/dev.mjs", status: "updated" });
  assert.deepEqual([owned.written, forceReplaceable(owned)], [["scripts/dev.mjs"], []]);
  assert.equal(await read("scripts/dev.mjs"), await fs.readFile(path.join(templatesRoot, "starter/scripts/dev.mjs"), "utf8"));
  assert.equal(JSON.parse(await read(".timds/starter.json")).plumbing, "toolkit", "the mode survives a sync");
  await writeJson(path.join(repoRoot, ".timds/starter.json"), { ...JSON.parse(await read(".timds/starter.json")), plumbing: "mine" });
  await assert.rejects(syncStarterWorkspace(repoRoot), /plumbing "mine"; it must be "toolkit" or "recorded"/);
  // A scaffold already at stock but without the record is adopted by writing the record alone, and says so; an adopted system's plumbing is recorded, not owned.
  await fs.rm(path.join(repoRoot, ".timds/starter.json"));
  const recordOnly = await syncStarterWorkspace(repoRoot);
  assert.deepEqual([recordOnly.adopted, recordOnly.written, recordOnly.recordWritten, recordOnly.check, recordOnly.plumbing], [true, [], true, null, "recorded"]);
  assert.equal(JSON.parse(await read(".timds/starter.json")).plumbing, undefined);

  await rewindStarter(repoRoot);
  await fs.appendFile(path.join(repoRoot, "scripts/dev.mjs"), "\n// client change\n");
  const devOnly = await syncStarterWorkspace(repoRoot);
  assert.deepEqual(devOnly.files.find((file) => file.path === "scripts/dev.mjs"), { path: "scripts/dev.mjs", status: "customized" });
  assert.match(await read("scripts/dev.mjs"), /client change/, "a customized script the check does not need is reported and kept");
  assert.equal(await read("scripts/viewer.mjs"), await fs.readFile(path.join(templatesRoot, "starter/scripts/viewer.mjs"), "utf8"));
  assert.equal(devOnly.check.machine.warnings.length, 2);
  const record = JSON.parse(await read(".timds/starter.json"));
  assert.equal(record.files["scripts/dev.mjs"], undefined, "a customized file is not recorded as toolkit-written");

  // A customized viewer cannot render the new overviews, so the sync is rolled back and says why.
  await rewindStarter(repoRoot);
  const customizedViewer = `${await read("scripts/viewer.mjs")}\n// client change\n`;
  await fs.writeFile(path.join(repoRoot, "scripts/viewer.mjs"), customizedViewer);
  await assert.rejects(syncStarterWorkspace(repoRoot), (error) => /Starter sync was rolled back because the workspace check failed afterwards: node scripts\/build\.mjs failed/.test(error.message)
    && /Customized files were kept \(scripts\/dev\.mjs, scripts\/viewer\.mjs\); .* run timds starter sync --force scripts\/dev\.mjs scripts\/viewer\.mjs to replace them/.test(error.message));
  assert.equal(await read("scripts/viewer.mjs"), customizedViewer);
  await assert.rejects(fs.access(path.join(repoRoot, "src/formats.json")), /ENOENT/);
  await assert.rejects(fs.access(path.join(repoRoot, ".timds/starter.json")), /ENOENT/);
  assert.equal(await read("src/site.json"), await fs.readFile(path.join(starterFixtureRoot, "src/site.json"), "utf8"));

  // --force names each customized plumbing file it replaces and nothing else; an overview fragment this system wrote itself is its own page and survives.
  const ownOverview = '<span class="eyebrow">Print</span>\n<h1 class="page-title">Our print</h1>\n<section class="block" id="rules"><h2 class="h2">Rules</h2><p>Paper first.</p></section>\n';
  await fs.mkdir(path.join(repoRoot, "src/pages/print"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "src/pages/print/index.html"), ownOverview);
  await assert.rejects(syncStarterWorkspace(repoRoot, { force: ["src/pages/print/index.html"] }), /--force replaces only the starter's stock scripts and stylesheets, named one by one: scripts\/build\.mjs, .*\. Not src\/pages\/print\/index\.html;/);
  await assert.rejects(syncStarterWorkspace(repoRoot, { force: ["scripts/viewer.mjs", "scripts/nope.mjs"] }), /Not scripts\/nope\.mjs;/);
  // In a terminal the sync asks about each customized file instead; the answers decide, and a diff can be shown first.
  const asked = [];
  const diffed = [];
  const prompt = createPlumbingPrompt({
    ask: async (question) => { asked.push(question); return asked.length === 1 ? "d" : asked.length === 2 ? "nonsense" : "k"; },
    showDiff: async (file) => { diffed.push([file.path, file.templatePath.endsWith("templates/starter/scripts/dev.mjs")]); },
  });
  const decisions = [];
  const answered = await syncStarterWorkspace(repoRoot, { decideCustomized: async (file) => {
    decisions.push(file.path);
    return file.path === "scripts/dev.mjs" ? prompt(file) : "replace";
  } });
  assert.deepEqual(decisions, ["scripts/dev.mjs", "scripts/viewer.mjs"]);
  assert.deepEqual([asked.length, diffed], [3, [["scripts/dev.mjs", true]]], "the diff was shown once and an unknown answer was asked again");
  assert.deepEqual(answered.files.find((file) => file.path === "scripts/dev.mjs"), { note: "kept at the prompt", path: "scripts/dev.mjs", status: "customized" });
  assert.deepEqual(answered.files.find((file) => file.path === "scripts/viewer.mjs"), { note: "replaced at the prompt", path: "scripts/viewer.mjs", status: "updated" });
  assert.doesNotMatch(await read("scripts/viewer.mjs"), /client change/);
  assert.equal(answered.check.machine.warnings.length, 2);
  await fs.writeFile(path.join(repoRoot, "scripts/viewer.mjs"), customizedViewer);
  const forced = await syncStarterWorkspace(repoRoot, { force: ["scripts/viewer.mjs"] });
  assert.deepEqual(forced.files.find((file) => file.path === "scripts/viewer.mjs"), { note: "replaced with --force", path: "scripts/viewer.mjs", status: "updated" });
  assert.deepEqual(forced.files.find((file) => file.path === "scripts/dev.mjs"), { path: "scripts/dev.mjs", status: "customized" }, "a customized file not named stays customized");
  assert.deepEqual(forceReplaceable(forced), ["scripts/dev.mjs"]);
  assert.match(await read("scripts/dev.mjs"), /client change/);
  assert.doesNotMatch(await read("scripts/viewer.mjs"), /client change/);
  assert.deepEqual(forced.files.find((file) => file.path === "src/pages/print/index.html"), { note: "this system's own page; never replaced, --force included", path: "src/pages/print/index.html", status: "customized" });
  assert.equal(await read("src/pages/print/index.html"), ownOverview);
  assert.ok(!forceReplaceable(forced).includes("src/pages/print/index.html"), "a kept fragment is not something --force would replace");
  const printView = JSON.parse(await read("src/site.json")).views.find((view) => view.id === "print");
  assert.equal(printView.pages[0].planned, undefined, "the overview is authored because its fragment exists");
  assert.match(await read("dist/print/index.html"), /Paper first/);
  assert.equal(forced.check.machine.warnings.length, 2);
});

test("starter sync merges around a view the client already declared", async (t) => {
  const repoRoot = await temporaryDirectory(t);
  await initializeRepository(repoRoot, { standalone: true });
  await rewindStarter(repoRoot);
  const read = (relative) => fs.readFile(path.join(repoRoot, relative), "utf8");
  const site = JSON.parse(await read("src/site.json"));
  const ownPrint = { id: "print", label: "Printed matter", blurb: "Paper", pages: [
    { slug: "letterheads", title: "Letterhead", summary: "Ours." },
    { slug: "swag", title: "Swag", planned: true },
  ] };
  site.views.push(ownPrint);
  await writeJson(path.join(repoRoot, "src/site.json"), site);
  await fs.mkdir(path.join(repoRoot, "src/pages/print"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "src/pages/print/letterheads.html"), '<span class="eyebrow">Print</span>\n<h1 class="page-title">Letterhead</h1>\n<section class="block" id="rules"><h2 class="h2">Rules</h2><p>Lead with the answer.</p></section>\n');
  await checkWorkspace(repoRoot);

  const result = await syncStarterWorkspace(repoRoot);
  const merged = JSON.parse(await read("src/site.json"));
  assert.deepEqual(merged.views.map((view) => view.id), ["brand", "web", "print", "digital", "social", "use"], "the client's view keeps its place; new views follow");
  const print = merged.views[2];
  assert.deepEqual([print.label, print.blurb], ["Printed matter", "Paper"]);
  assert.deepEqual(print.pages.map((page) => [page.slug, page.planned === true]), [
    ["", false],
    ["letterheads", false],
    ["business-cards", true], ["brochures", true], ["booklets", true], ["worksheets", true], ["calendars", true], ["notepads", true], ["conference-banners", true], ["posters", true],
    ["swag", true],
  ], "stock pages are added as planned after their predecessors; the client's own page stays");
  assert.deepEqual(print.pages[1], { slug: "letterheads", title: "Letterhead", summary: "Ours." }, "a page the client declared keeps every field");
  assert.deepEqual(result.site.addedViews, ["digital", "social", "use"]);
  assert.deepEqual(result.site.addedPages.filter((id) => id.startsWith("print")), ["print", "print/business-cards", "print/brochures", "print/booklets", "print/worksheets", "print/calendars", "print/notepads", "print/conference-banners", "print/posters"]);
  assert.deepEqual(result.site.kept.map((kept) => [kept.path, kept.current]), [["print.label", "Printed matter"], ["print.blurb", "Paper"], ["print/letterheads.title", "Letterhead"], ["print/letterheads.group", undefined], ["print/letterheads.summary", "Ours."]]);
  assert.ok(describeStarterSync(result).includes('Kept print/letterheads.group undeclared; the scaffold now says "Stationery".'), describeStarterSync(result).join("\n"));
  // The next sync knows the view and has nothing new to say about it.
  const quiet = await syncStarterWorkspace(repoRoot);
  assert.deepEqual([quiet.written, quiet.site.kept, quiet.formats.kept], [[], [], []]);
  assert.equal(result.files.find((file) => file.path === "src/pages/print/index.html").status, "created", "the overview fragment is written because the sync added its page");
  assert.deepEqual(result.formats.skipped, []);
  assert.equal(result.check.machine.warnings.length, 2);
  assert.match(await read("dist/print/index.html"), /Letterhead · US Letter/);
  assert.match(await read("dist/print/letterheads/index.html"), /Lead with the answer/);

  // A planned overview the client declared has nothing to lose: it receives the stock fragment and becomes authored under the client's title.
  await rewindStarter(repoRoot);
  const declaredOverview = JSON.parse(await fs.readFile(path.join(starterFixtureRoot, "src/site.json"), "utf8"));
  declaredOverview.views.push({ id: "social", label: "Social", pages: [{ slug: "", title: "Social", planned: true }] });
  await writeJson(path.join(repoRoot, "src/site.json"), declaredOverview);
  const plannedOverview = await syncStarterWorkspace(repoRoot);
  assert.deepEqual(plannedOverview.files.find((file) => file.path === "src/pages/social/index.html"), { path: "src/pages/social/index.html", status: "created" });
  const social = JSON.parse(await read("src/site.json")).views.find((view) => view.id === "social");
  assert.deepEqual([social.label, social.pages[0]], ["Social", { slug: "", title: "Social" }]);
  assert.ok(plannedOverview.site.advanced.includes("social.planned"));
  assert.deepEqual(plannedOverview.site.kept.map((kept) => kept.path), ["social.label", "social.blurb", "social.title", "social.group", "social.summary"]);
  assert.match(await read("dist/social/index.html"), /<h1 class="page-title">/);
  assert.equal(plannedOverview.check.machine.warnings.length, 2);
});

test("a later scaffold advances starter fields the client never changed and keeps the ones they did", async (t) => {
  const repoRoot = await temporaryDirectory(t);
  await initializeRepository(repoRoot, { standalone: true });
  const read = (relative) => fs.readFile(path.join(repoRoot, relative), "utf8");
  // Stand in for a system synced against an earlier scaffold: move the record's baseline and the client's files back together.
  const record = JSON.parse(await read(".timds/starter.json"));
  const site = JSON.parse(await read("src/site.json"));
  const formats = JSON.parse(await read("src/formats.json"));
  const web = (model) => model.views.find((view) => view.id === "web");
  web(record.baseline.site).label = "Web";
  web(site).label = "Web";
  web(record.baseline.site).blurb = "Interface system";
  web(site).blurb = "Our interfaces";
  web(record.baseline.site).pages = web(record.baseline.site).pages.filter((page) => page.slug !== "email-templates");
  web(site).pages = web(site).pages.filter((page) => page.slug !== "email-templates");
  record.baseline.formats.print.formats.letterhead.stock = "Older stock note.";
  formats.print.formats.letterhead.stock = "Older stock note.";
  record.baseline.formats.print.formats.letterhead.safe = 0.75;
  formats.print.formats.letterhead.safe = 1;
  const olderCheck = "// an older stock check script\n";
  await fs.writeFile(path.join(repoRoot, "scripts/check.mjs"), olderCheck);
  record.files["scripts/check.mjs"] = createHash("sha256").update(olderCheck).digest("hex");
  await writeJson(path.join(repoRoot, ".timds/starter.json"), record);
  await writeJson(path.join(repoRoot, "src/site.json"), site);
  await writeJson(path.join(repoRoot, "src/formats.json"), formats);

  const result = await syncStarterWorkspace(repoRoot);
  assert.deepEqual(result.site, { addedPages: ["web/email-templates"], addedViews: [], advanced: ["web.label"], kept: [{ current: "Our interfaces", path: "web.blurb", stock: "Web & email system" }] });
  assert.deepEqual([result.formats.advanced, result.formats.kept], [["print.letterhead.stock"], [{ current: 1, path: "print.letterhead.safe", stock: 0.5 }]]);
  assert.equal(result.files.find((file) => file.path === "scripts/check.mjs").status, "updated", "a file at the hash the toolkit last wrote is stock, whatever release wrote it");
  assert.equal(await read("scripts/check.mjs"), await fs.readFile(path.join(templatesRoot, "starter/scripts/check.mjs"), "utf8"));
  const synced = JSON.parse(await read("src/site.json"));
  assert.deepEqual([web(synced).label, web(synced).blurb, web(synced).pages.map((page) => page.slug)], ["Web DS", "Our interfaces", ["spacing", "photography", "components", "layout", "email", "email-templates"]]);
  assert.equal(result.check.machine.warnings.length, 2);

  // In the recorded mode a customized file keeps the hash the toolkit last wrote for it, so reverting to that version is recognized as stock again instead of needing --force.
  const olderHash = createHash("sha256").update(olderCheck).digest("hex");
  const synchronizedRecord = JSON.parse(await read(".timds/starter.json"));
  synchronizedRecord.plumbing = "recorded";
  synchronizedRecord.files["scripts/check.mjs"] = olderHash;
  await writeJson(path.join(repoRoot, ".timds/starter.json"), synchronizedRecord);
  await fs.writeFile(path.join(repoRoot, "scripts/check.mjs"), `${olderCheck}// client change\n`);
  const customized = await syncStarterWorkspace(repoRoot);
  assert.equal(customized.files.find((file) => file.path === "scripts/check.mjs").status, "customized");
  assert.equal(JSON.parse(await read(".timds/starter.json")).files["scripts/check.mjs"], olderHash);
  await fs.writeFile(path.join(repoRoot, "scripts/check.mjs"), olderCheck);
  const reverted = await syncStarterWorkspace(repoRoot);
  assert.equal(reverted.files.find((file) => file.path === "scripts/check.mjs").status, "updated");
  assert.equal(await read("scripts/check.mjs"), await fs.readFile(path.join(templatesRoot, "starter/scripts/check.mjs"), "utf8"));
});


test("login reuses saved credentials without opening an authorization flow", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "timds-cli-login-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const credentialsPath = path.join(root, "credentials.json");
  const { saveAccessToken } = await import("./auth.mjs");
  await saveAccessToken("https://saved.test", "timds_saved", { credentialsPath });
  await saveAccessToken("https://other.test", "timds_other", { credentialsPath });
  const lines = [];
  const result = await runWithOutputSink(line => lines.push(line), () => runCli(["auth", "login", "--root", root, "--credentials-path", credentialsPath, "--portal-url", "https://saved.test", "--oauth"]));
  assert.equal(result.reused, true);
  assert.equal(result.portal, "https://saved.test");
  const { savedPortalUrl } = await import("./auth.mjs");
  assert.equal(await savedPortalUrl({ credentialsPath }), "https://saved.test");
  assert.match(lines.join("\n"), /Already signed in/);
  assert.doesNotMatch(lines.join("\n"), /timds_saved/);
});

test("dev --port passes PORT to the workspace command and rejects invalid ports", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "timds-cli-dev-port-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await initializeRepository(root, { standalone: true, provider: "hosted", portalUrl: "https://host.test" });
  const manifestPath = path.join(root, "timds.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.workspace.dev = [process.execPath, "-e", "require('fs').writeFileSync('received-port.txt', process.env.PORT)"];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await runCli(["dev", "--root", root, "--port", "4327"]);
  assert.equal(await fs.readFile(path.join(root, "received-port.txt"), "utf8"), "4327");
  await assert.rejects(runCli(["dev", "--root", root, "--port", "70000"]), /Dev port must/);
});


test("preview and starter dev explain an occupied port without a stack trace", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "timds-cli-busy-port-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await initializeRepository(root, { standalone: true, provider: "hosted", portalUrl: "https://host.test" });
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  await assert.rejects(runCli(["preview", "--root", root, "--no-build", "--port", String(port)]), /already in use.*timds preview --port/);
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await assert.rejects(promisify(execFile)(process.execPath, ["scripts/dev.mjs"], { cwd: root, env: { ...process.env, PORT: String(port) } }), error => {
    assert.match(error.stderr, /already in use.*timds dev --port/);
    assert.doesNotMatch(error.stderr, /Unhandled|at Server/);
    return true;
  });
});

test("whoami prints the principal and join prints the workspace and next steps", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "timds-cli-join-"));
  const originalFetch = globalThis.fetch;
  t.after(async () => { globalThis.fetch = originalFetch; await fs.rm(root, { recursive: true, force: true }); });
  const principal = { id: "11111111-1111-4111-8111-111111111111", type: "user", name: "Example Person", admin: false };
  const session = { id: "session-1", systemId: "example/core", baseRevision: "base", status: "open" };
  const systems = [{ id: "11111111-1111-4111-8111-111111111111", systemId: "example/core", name: "Example Core" }];
  globalThis.fetch = async url => new Response(JSON.stringify(String(url).endsWith("/me") ? { apiVersion: 1, principal } : String(url).endsWith("/design-systems") ? { apiVersion: 1, systems } : { apiVersion: 1, session, files: [{ path: "note.txt", encoding: "base64", content: Buffer.from("shared").toString("base64"), mode: "100644" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  const host = ["--portal-url", "https://host.example", "--token", "timds_test"];
  const lines = [];
  await runWithOutputSink(line => lines.push(line), () => runCli(["whoami", "--root", root, ...host]));
  assert.deepEqual(lines, [`https://host.example: signed in as Example Person (user) ${principal.id}`]);
  lines.length = 0;
  await runWithOutputSink(line => lines.push(line), () => runCli(["systems", "--root", root, ...host]));
  assert.deepEqual(lines, ["example/core  Example Core"]);
  lines.length = 0;
  const member = path.join(root, "member");
  await runWithOutputSink(line => lines.push(line), () => runCli(["join", "session-1", "--root", member, ...host]));
  assert.equal(await fs.readFile(path.join(member, "note.txt"), "utf8"), "shared");
  assert.match(lines.join("\n"), new RegExp(`Workspace: ${member.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(lines.join("\n"), /npm ci[\s\S]*timds dev[\s\S]*timds update --note/);
  lines.length = 0;
  await runWithOutputSink(line => lines.push(line), () => runCli(["join", "session-1", "--root", member, "--principal-id", principal.id, ...host]));
  assert.match(lines.join("\n"), new RegExp(`Invited ${principal.id}\\. They attach with: timds join session-1 --root`));
  assert.doesNotMatch(lines.join("\n"), /Workspace:/);
});

test("the edit skill steers hosted sessions to the CLI, never MCP", async () => {
  const skill = await fs.readFile(fileURLToPath(new URL("../skills/timds-edit-design-system/SKILL.md", import.meta.url)), "utf8");
  const hosted = skill.slice(skill.indexOf("## Hosted sessions"));
  assert.doesNotMatch(hosted, /\bMCP\b|timds_[a-z]/);
  assert.match(hosted, /npx --yes @dtconcepts\/timds@latest <command>/);
  assert.match(hosted, /`npm run timds -- <command>`/);
  for (const command of ["timds start", "timds join", "timds pull", "timds update", "timds submit", "timds claim", "timds active-work", "timds whoami", "timds systems", "timds principals", "timds draft create", "timds draft list", "timds draft close", "timds sessions close"]) {
    assert.ok(hosted.includes(command), command);
  }
  assert.match(hosted, /Join before you start/);
  assert.match(hosted, /--note INTENT/);
  assert.match(hosted, /--resolve 'PATH#KEY=mine\|theirs'/);
  assert.match(hosted, /Never put access tokens in source or session metadata/);
});

test("joining from a Studio link attaches in a new session folder without another sign-in", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "timds-cli-join-link-"));
  const originalFetch = globalThis.fetch, originalDirectory = process.cwd();
  t.after(async () => { globalThis.fetch = originalFetch; process.chdir(originalDirectory); await fs.rm(root, { recursive: true, force: true }); });
  // The current folder already has files, as a terminal usually does.
  await fs.writeFile(path.join(root, "mine.txt"), "keep");
  const credentialsPath = path.join(root, "credentials.json");
  const { saveAccessToken } = await import("./auth.mjs");
  await saveAccessToken("https://host.example", "timds_saved", { credentialsPath });
  const sessionId = "22222222-2222-4222-8222-222222222222", requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), authorization: options.headers.Authorization });
    return new Response(JSON.stringify({ apiVersion: 1, session: { id: sessionId, systemId: "example/core", baseRevision: "base", status: "open" }, files: [{ path: "note.txt", encoding: "base64", content: Buffer.from("shared").toString("base64"), mode: "100644" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  process.chdir(root);
  const workspace = path.join(process.cwd(), "session-22222222");
  const lines = [];
  await runWithOutputSink(line => lines.push(line), () => runCli(["join", `https://host.example/studio/#source=11111111-1111-4111-8111-111111111111&view=studio&session=${sessionId}&join=1`, "--credentials-path", credentialsPath]));
  assert.deepEqual(requests, [{ url: `https://host.example/api/timds/sessions/${sessionId}/join`, authorization: "Bearer timds_saved" }]);
  assert.equal(await fs.readFile(path.join(workspace, "note.txt"), "utf8"), "shared");
  assert.equal(await fs.readFile(path.join(root, "mine.txt"), "utf8"), "keep");
  assert.equal(lines[0], "TimDS join: fetching workspace from https://host.example...");
  assert.ok(lines.includes(`Workspace: ${workspace}`));
  assert.doesNotMatch(lines.join("\n"), /authoriz|Already signed in/i);
});

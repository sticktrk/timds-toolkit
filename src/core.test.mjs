import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkWorkspace,
  createPreviewServer,
  initializeRepository,
  loadWorkspace,
  submitWorkspace,
  upgradeRepository,
  validateArtifact,
  validateManifest,
} from "./core.mjs";
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

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "timds-cli-"));
  t.after(() => fs.rm(directory, { force: true, recursive: true }));
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
  await fs.writeFile(path.join(repoRoot, "design-system", "dist", "assets", "site.css"), "body{color:#123}\n", "utf8");
  return repoRoot;
}

test("validates schema 2 manifests with argv workspace commands", () => {
  const manifest = validateManifest({
    artifact: { entry: "index.html" },
    name: "Acme Design System",
    schemaVersion: 2,
    systemId: "acme/core",
    version: "2.1.0",
    workspace: { build: ["npm", "run", "build"] },
  });
  assert.deepEqual(manifest.workspace.build, ["npm", "run", "build"]);
  assert.equal(manifest.artifact.entry, "index.html");
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
      repository: "Acme-Co/acme-site",
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
    repository: "Acme-Co/acme-site",
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
  assert.ok(paths.includes("llms.txt"));
  assert.equal(result.artifact.fileCount, paths.length);
  assert.ok(result.machine.enabled);
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
  execFileSync("git", ["add", "design-system/.timds", ".agents/skills/timds-edit-design-system", "package.json"], { cwd: repoRoot });
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
    ["index.html", "index.json", "index.md", "llms.txt"],
  );
  assert.equal(checked.machine.counts.blocks, 1);
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
  const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.version, "0.1.0");
  assert.equal(packageJson.devDependencies["@dtconcepts/timds"], "0.1.x");
  assert.equal(packageJson.scripts["check:versions"], "node scripts/check-versions.mjs");
  assert.equal(packageJson.scripts.release, "node scripts/release.mjs");
  assert.equal(packageJson.scripts.timds, "timds");
  await fs.access(path.join(repoRoot, "src", "index.html"));
  await fs.access(path.join(repoRoot, "scripts", "build.mjs"));
  await fs.access(path.join(repoRoot, "scripts", "check-versions.mjs"));
  await fs.access(path.join(repoRoot, "scripts", "release.mjs"));
  await fs.access(path.join(repoRoot, "scripts", "release.sh"));
  await fs.access(path.join(repoRoot, ".github", "workflows", "update-consumer-submodule.yml"));
  await fs.access(path.join(repoRoot, "dist", "index.html"));
  assert.match(await fs.readFile(path.join(repoRoot, ".gitignore"), "utf8"), /node_modules\//);
  assert.match(await fs.readFile(path.join(repoRoot, ".gitignore"), "utf8"), /dist\//);
  assert.match(
    await fs.readFile(path.join(repoRoot, ".agents", "skills", "timds-edit-design-system", "SKILL.md"), "utf8"),
    /standalone Design System/,
  );

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
    consumerRepository: "Acme-Co/acme-site",
    standalone: true,
  });
  assert.equal(initialized.consumer.repository, "Acme-Co/acme-site");

  const manifest = JSON.parse(await fs.readFile(path.join(repoRoot, "timds.json"), "utf8"));
  assert.deepEqual(manifest.consumer, {
    branch: "master",
    path: "design-system",
    repository: "Acme-Co/acme-site",
  });
  const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.version, manifest.version);
  const workflow = await fs.readFile(path.join(repoRoot, ".github", "workflows", "timds-design-system.yml"), "utf8");
  assert.match(workflow, /pin-consumer:/);
  assert.match(workflow, /update-consumer-submodule\.yml/);
  const updater = await fs.readFile(path.join(repoRoot, ".github", "workflows", "update-consumer-submodule.yml"), "utf8");
  assert.match(updater, /TIMDS_CONSUMER_TOKEN/);
  assert.match(updater, /git update-index --cacheinfo/);
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

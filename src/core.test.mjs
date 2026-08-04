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
  readMediaCatalog,
  validateMediaCatalog,
} from "./media.mjs";

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "timds-cli-"));
  t.after(() => fs.rm(directory, { force: true, recursive: true }));
  return directory;
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

test("validates stable media catalog records and rejects signed URLs", () => {
  const asset = {
    bytes: 24,
    contentType: "image/png",
    filename: "portrait.png",
    id: "asset_12345678",
    kind: "image",
    publicUrl: "https://assets.timds.com/clients/example/portrait.png",
    rights: { status: "client-owned" },
    sha256: "a".repeat(64),
    tags: ["portrait"],
    title: "Attorney portrait",
    visibility: "public",
  };
  assert.equal(validateMediaCatalog({ assets: [asset], schemaVersion: 1 }).assets[0].id, asset.id);
  assert.throws(
    () => validateMediaCatalog({
      assets: [{ ...asset, publicUrl: `${asset.publicUrl}?X-Amz-Signature=temporary` }],
      schemaVersion: 1,
    }),
    /expiring storage signature/,
  );
});

test("uploads media outside Git and writes only its stable catalog record", async (t) => {
  const repoRoot = await createDesignSystemRepo(t);
  const filePath = path.join(repoRoot, "full-resolution.png");
  await fs.writeFile(filePath, Buffer.from("full-resolution-image"));
  const workspace = await checkWorkspace(repoRoot, { skipBuild: true });
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ method: options.method || "GET", url: String(url) });
    if (String(url).endsWith("/api/operator/design-system-assets/uploads")) {
      return Response.json({
        asset: { id: "asset_12345678", kind: "image", publicUrl: "" },
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
      return Response.json({ asset: { id: "asset_12345678", kind: "image", publicUrl: "" } });
    }
    return Response.json({ error: "unexpected" }, { status: 500 });
  };
  const result = await addMediaFile(workspace, filePath, {
    fetchImpl: fakeFetch,
    portalUrl: "https://timds.test",
    rights: "client-owned",
    token: "test-token",
    visibility: "private",
  });
  assert.equal(result.asset.id, "asset_12345678");
  assert.deepEqual(calls.map((call) => call.method), ["POST", "PUT", "POST"]);
  const { catalog } = await readMediaCatalog(path.join(repoRoot, "design-system"), { required: true });
  assert.equal(catalog.assets[0].filename, "full-resolution.png");
  assert.equal(catalog.assets[0].publicUrl, "");
  assert.match(catalog.assets[0].sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(fs.access(path.join(repoRoot, "design-system", "assets", "full-resolution.png")));
});

test("uses bounded multipart handshakes for large-media upload plans", async (t) => {
  const repoRoot = await createDesignSystemRepo(t);
  const filePath = path.join(repoRoot, "b-roll.mp4");
  await fs.writeFile(filePath, Buffer.from("video-master"));
  const workspace = await checkWorkspace(repoRoot, { skipBuild: true });
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    const call = { body: options.body, method: options.method || "GET", url: String(url) };
    calls.push(call);
    if (call.url.endsWith("/api/operator/design-system-assets/uploads")) {
      return Response.json({
        asset: { id: "asset_87654321", kind: "video", publicUrl: "" },
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
      return Response.json({ asset: { id: "asset_87654321", kind: "video", publicUrl: "" } });
    }
    return Response.json({ error: "unexpected" }, { status: 500 });
  };
  const result = await addMediaFile(workspace, filePath, {
    fetchImpl: fakeFetch,
    portalUrl: "https://timds.test",
    rights: "licensed",
    token: "test-token",
    visibility: "private",
  });
  assert.equal(result.asset.id, "asset_87654321");
  assert.deepEqual(calls.map((call) => call.method), ["POST", "POST", "PUT", "POST"]);
  assert.equal(calls[1].url, "https://timds.test/api/operator/design-system-assets/uploads/upload-2/parts");
});

test("validates exact artifact files and local references", async (t) => {
  const repoRoot = await createDesignSystemRepo(t);
  const result = await checkWorkspace(repoRoot, { skipBuild: true });
  assert.equal(result.artifact.fileCount, 2);
  assert.equal(result.artifact.entryPath, "index.html");
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
  await fs.access(path.join(repoRoot, "design-system", ".timds", "cli", "bin", "timds.mjs"));
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(repoRoot, "design-system", ".timds", "installation.json"), "utf8")),
    { name: "@dtconcepts/timds", schemaVersion: 1, version: "0.1.0" },
  );
  await fs.access(path.join(repoRoot, "design-system", "media.json"));
  assert.match(await fs.readFile(path.join(repoRoot, "design-system", ".gitignore"), "utf8"), /\.timds\/cache/);
  await fs.access(path.join(repoRoot, ".agents", "skills", "timds-edit-design-system", "SKILL.md"));
  await fs.access(path.join(repoRoot, ".github", "workflows", "timds-design-system.yml"));
  execFileSync(
    "node",
    [path.join(repoRoot, "design-system", ".timds", "cli", "bin", "timds.mjs"), "doctor", "--root", repoRoot],
    { cwd: repoRoot, stdio: "ignore" },
  );
});

test("upgrades only clean package-managed CLI and skill trees", async (t) => {
  const repoRoot = await createDesignSystemRepo(t);
  await initializeRepository(repoRoot);
  execFileSync("git", ["add", "design-system/.timds", ".agents/skills/timds-edit-design-system"], { cwd: repoRoot });
  execFileSync("git", ["commit", "-m", "Install TimDS toolkit"], { cwd: repoRoot, stdio: "ignore" });

  const skillPath = path.join(repoRoot, ".agents", "skills", "timds-edit-design-system", "SKILL.md");
  const originalSkill = await fs.readFile(skillPath, "utf8");
  await fs.writeFile(skillPath, `${originalSkill}\nLocal modification\n`, "utf8");
  await assert.rejects(upgradeRepository(repoRoot), /locally modified TimDS tooling/);
  await fs.writeFile(skillPath, originalSkill, "utf8");

  const stalePath = path.join(repoRoot, "design-system", ".timds", "cli", "src", "removed-in-new-release.mjs");
  await fs.writeFile(stalePath, "export default true;\n", "utf8");
  execFileSync("git", ["add", "design-system/.timds/cli/src/removed-in-new-release.mjs"], { cwd: repoRoot });
  execFileSync("git", ["commit", "-m", "Track stale managed file"], { cwd: repoRoot, stdio: "ignore" });

  const result = await upgradeRepository(repoRoot);
  assert.equal(result.previousVersion, "0.1.0");
  assert.equal(result.package.version, "0.1.0");
  await assert.rejects(fs.access(stalePath), /ENOENT/);
  assert.equal(await fs.readFile(skillPath, "utf8"), originalSkill);
});

test("plans a scoped branch and draft pull request without writing during submit dry-run", async (t) => {
  const repoRoot = await createDesignSystemRepo(t);
  await initializeRepository(repoRoot);
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
  execFileSync("git", ["add", "design-system", ".agents", ".github"], { cwd: repoRoot });
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
  assert.equal(checked.artifact.fileCount, 1);
});

test("initializes the reusable standalone repository shape", async (t) => {
  const repoRoot = await temporaryDirectory(t);
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "ignore" });

  const result = await initializeRepository(repoRoot, { standalone: true });
  assert.equal(result.designSystemRoot, repoRoot);
  const manifest = JSON.parse(await fs.readFile(path.join(repoRoot, "timds.json"), "utf8"));
  assert.equal(manifest.artifact.publishRef, "timds-published");
  assert.match(await fs.readFile(path.join(repoRoot, "README.md"), "utf8"), /node \.timds\/cli\/bin\/timds\.mjs/);
  assert.match(
    await fs.readFile(path.join(repoRoot, ".agents", "skills", "timds-edit-design-system", "SKILL.md"), "utf8"),
    /Standalone/,
  );
});

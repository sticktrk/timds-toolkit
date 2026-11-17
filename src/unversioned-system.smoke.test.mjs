// Smoke test: a Design System whose timds.json declares no version builds,
// checks, bundles and publishes without embedding a version, a host can file
// that publication under a label it assigns, and a consumer syncs it by that
// label or by `current`. Versioned systems are covered by the existing suites.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { publishExtractedIndex } from "./artifact.mjs";
import { loadWorkspace } from "./core.mjs";
import { CONSUMER_MANIFEST_FILE, checkConsumer } from "./consumer.mjs";
import { readBundleRecord, syncConsumerBundle, updateConsumerPin } from "./consumer-sync.mjs";
import { PROVENANCE_FILE, fetchDerivedLayer } from "./derived.mjs";
import { createPublicationStampFromFiles } from "./publication-snapshot.mjs";
import { prepareMergeRelease } from "../templates/starter/scripts/prepare-merge-release.mjs";

const cli = fileURLToPath(new URL("../bin/timds.mjs", import.meta.url));
const toolkitPackage = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
const PUBLIC_BASE = "https://cdn.example.com/timds-example/unversioned/artifact";
const HOST_LABEL = "2026.11.17-7";

async function temporaryDirectory(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 }));
  return fs.realpath(directory);
}

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const timds = (...args) => execFileSync(process.execPath, [cli, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 });

async function walk(root, relative = "") {
  const found = [];
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await walk(root, child));
    else if (entry.isFile()) found.push(child);
  }
  return found;
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

test("an unversioned Design System builds, checks, publishes without a version, and a consumer syncs it by host label or current", async (t) => {
  // A fresh standalone system, then the version taken out of timds.json and
  // the changelog left with Unreleased notes only.
  const root = await temporaryDirectory(t, "timds-unversioned-");
  git(root, "init", "-q", "-b", "main");
  timds("init", "--standalone", "--root", root, "--name", "Unversioned", "--system-id", "timds-example/unversioned");
  const manifestPath = path.join(root, "timds.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const removedVersion = manifest.version;
  assert.ok(removedVersion, "init still scaffolds a versioned system");
  delete manifest.version;
  await writeJson(manifestPath, manifest);
  await fs.writeFile(path.join(root, "CHANGELOG.md"), "# Changelog\n\n## Unreleased\n\n- Foundations: start the unversioned system.\n");

  const checked = timds("check", "--root", root);
  assert.match(checked, /TimDS check passed/);
  assert.match(checked, /Consumer bundle: 2 files/);

  // Every derived document names the system without a version, the bundle
  // sits only at its current path, and no built file carries the label.
  const dist = path.join(root, "dist");
  for (const name of ["index", "tokens", "brand", "formats", "designs", "changelog", "bundle"]) {
    const document = JSON.parse(await fs.readFile(path.join(dist, `${name}.json`), "utf8"));
    assert.deepEqual(document.system, { id: "timds-example/unversioned", name: manifest.name }, `${name}.json carries no version`);
  }
  const bundle = JSON.parse(await fs.readFile(path.join(dist, "bundle.json"), "utf8"));
  assert.deepEqual([bundle.versioned, bundle.directory, bundle.files.map((file) => file.path)], [null, "/bundle", ["dist/styles/system.css", "dist/tokens.css"]]);
  const builtFiles = await walk(dist);
  assert.ok(!builtFiles.some((file) => file.startsWith("v/")), "no v/<version>/ copy is built");
  for (const file of builtFiles) {
    if (!/\.(html|json|md|txt|css)$/.test(file)) continue;
    assert.ok(!(await fs.readFile(path.join(dist, file), "utf8")).includes(removedVersion), `${file} does not embed the removed version`);
  }

  // Publishing uploads no versioned copy and a stamp without a version.
  const workspace = await loadWorkspace(root);
  assert.equal(workspace.manifest.version, undefined);
  const sessions = [];
  const cdn = new Map();
  const portalFetch = async (url, init = {}) => {
    if (String(url).endsWith("/api/operator/design-system-artifacts/uploads")) {
      const body = JSON.parse(init.body);
      sessions.push(body);
      return Response.json({ publicBase: PUBLIC_BASE, uploads: body.files.map((file) => ({ method: "single", path: file.path, url: `https://upload.example.com/${file.path}` })) });
    }
    if (String(url).startsWith("https://upload.example.com/") && init.method === "PUT") {
      cdn.set(String(url).slice("https://upload.example.com/".length), Buffer.from(init.body));
      return new Response(null, { status: 200 });
    }
    throw new Error(`Unexpected fetch ${init.method || "GET"} ${url}`);
  };
  const published = await publishExtractedIndex(workspace, { fetchImpl: portalFetch, portalUrl: "https://portal.example.com", sourceCommit: "c".repeat(40), token: "timds_test_token" });
  assert.equal(published.bundleVersionedUrl, null);
  assert.ok(sessions.every((session) => !("version" in session)), "upload sessions send no version");
  assert.ok(![...cdn.keys()].some((key) => key.startsWith("v/")), "nothing is uploaded under v/");
  const stamp = JSON.parse(cdn.get(PROVENANCE_FILE).toString("utf8"));
  assert.deepEqual(Object.keys(stamp), ["schemaVersion", "sourceCommit", "systemId", "lineage", "entry", "files"]);
  const publishedBundle = JSON.parse(cdn.get("bundle.json").toString("utf8"));
  assert.deepEqual([publishedBundle.system.version, publishedBundle.versioned, publishedBundle.base], [undefined, null, PUBLIC_BASE]);

  // The host files the publication under a label it assigns: here it serves
  // the built bundle beside itself at v/<label>/, as a portal may.
  cdn.set(`v/${HOST_LABEL}/bundle.json`, await fs.readFile(path.join(dist, "bundle.json")));
  for (const file of bundle.files) cdn.set(`v/${HOST_LABEL}/bundle/${file.path}`, await fs.readFile(path.join(dist, "bundle", file.path)));
  const requests = [];
  const cdnFetch = async (url) => {
    requests.push(String(url));
    const key = String(url).startsWith(`${PUBLIC_BASE}/`) ? decodeURIComponent(String(url).slice(PUBLIC_BASE.length + 1)) : null;
    const body = key === null ? undefined : cdn.get(key);
    return body === undefined ? new Response("missing", { status: 404 }) : new Response(body, { status: 200 });
  };

  // The published reader serves it with no version and the stamp's identity.
  const layer = await fetchDerivedLayer(PUBLIC_BASE, { fetchImpl: cdnFetch });
  assert.deepEqual([layer.system.id, layer.system.version ?? null, layer.provenance.sourceCommit, layer.bundle.versioned], ["timds-example/unversioned", null, "c".repeat(40), null]);

  // A product pinned to the host's label syncs and checks offline.
  const product = await temporaryDirectory(t, "timds-unversioned-product-");
  git(product, "init", "-q", "-b", "main");
  git(product, "config", "user.email", "timds-test@example.com");
  git(product, "config", "user.name", "TimDS Test");
  await writeJson(path.join(product, CONSUMER_MANIFEST_FILE), { schemaVersion: 1, designSystem: { path: "design-system", systemId: "timds-example/unversioned", version: HOST_LABEL, url: PUBLIC_BASE }, apps: { web: { cwd: "web", preview: { build: ["npm", "run", "build"], output: "dist" }, designSurface: ["src/**"] } } });
  await writeJson(path.join(product, "package.json"), { name: "product", private: true, scripts: { postinstall: "timds consumer sync", timds: "timds" }, devDependencies: { "@dtconcepts/timds": "0.1.x" } });
  await writeJson(path.join(product, "package-lock.json"), { lockfileVersion: 3, packages: { "": { name: "product", devDependencies: { "@dtconcepts/timds": "0.1.x" } }, "node_modules/@dtconcepts/timds": { version: toolkitPackage.version } } });
  await writeJson(path.join(product, "web/package.json"), { name: "web" });
  await fs.writeFile(path.join(product, ".gitignore"), "node_modules/\ndesign-system/\n");
  git(product, "add", ".");
  git(product, "commit", "-q", "-m", "Product");

  const pinned = await syncConsumerBundle(product, { fetchImpl: cdnFetch });
  assert.deepEqual([pinned.status, pinned.version, pinned.downloaded], ["synced", HOST_LABEL, 2]);
  for (const file of bundle.files) {
    assert.deepEqual(await fs.readFile(path.join(product, "design-system", file.path)), await fs.readFile(path.join(dist, "bundle", file.path)));
  }
  assert.equal((await readBundleRecord(path.join(product, "design-system"))).version, HOST_LABEL);
  const pinnedCheck = await checkConsumer(product);
  assert.equal(pinnedCheck.status, "passed", pinnedCheck.errors.join("\n"));

  // A tampered copy at the label is refused by its digest.
  const original = cdn.get(`v/${HOST_LABEL}/bundle/dist/tokens.css`);
  cdn.set(`v/${HOST_LABEL}/bundle/dist/tokens.css`, Buffer.from(":root{}"));
  await fs.rm(path.join(product, "design-system"), { recursive: true });
  await assert.rejects(syncConsumerBundle(product, { fetchImpl: cdnFetch }), /does not match the digest/);
  cdn.set(`v/${HOST_LABEL}/bundle/dist/tokens.css`, original);

  // Moving the pin needs a label: the current publication carries none.
  await assert.rejects(updateConsumerPin(product, { fetchImpl: cdnFetch }), /carries no version label to pin/);

  // A current pin reads the stamp, then the current bundle, and records the stamp's commit.
  const current = JSON.parse(await fs.readFile(path.join(product, CONSUMER_MANIFEST_FILE), "utf8"));
  current.designSystem.version = "current";
  await writeJson(path.join(product, CONSUMER_MANIFEST_FILE), current);
  requests.length = 0;
  const followed = await syncConsumerBundle(product, { fetchImpl: cdnFetch });
  assert.deepEqual([followed.status, followed.pin, followed.version], ["synced", "current", null]);
  assert.deepEqual(requests.slice(0, 2), [`${PUBLIC_BASE}/${PROVENANCE_FILE}`, `${PUBLIC_BASE}/bundle.json`]);
  const record = await readBundleRecord(path.join(product, "design-system"));
  assert.deepEqual([record.version, record.sourceCommit, record.versioned], [null, "c".repeat(40), null]);
  const currentCheck = await checkConsumer(product);
  assert.equal(currentCheck.status, "passed", currentCheck.errors.join("\n"));

  // A merge release bumps nothing and leaves the notes under Unreleased.
  const changelog = await fs.readFile(path.join(root, "CHANGELOG.md"), "utf8");
  assert.deepEqual(prepareMergeRelease({ previousVersion: removedVersion, timdsJson: await fs.readFile(manifestPath, "utf8"), packageJson: "{}", packageLock: "{}", changelog }), { changed: false, version: null });

  // Publication provenance from committed bytes carries no version either,
  // and refuses a label the manifest does not declare.
  const sourceFiles = [{ path: "timds.json", content: await fs.readFile(manifestPath, "utf8") }, { path: "tokens.json", content: await fs.readFile(path.join(root, "tokens.json"), "utf8") }];
  const artifactFiles = [{ path: "index.html", content: await fs.readFile(path.join(dist, "index.html")) }];
  const provenance = createPublicationStampFromFiles({ sourceCommit: "c".repeat(40), sourceFiles, artifactFiles });
  assert.deepEqual(Object.keys(provenance), ["schemaVersion", "systemId", "sourceCommit", "lineage", "contentDigest"]);
  assert.throws(() => createPublicationStampFromFiles({ sourceCommit: "c".repeat(40), sourceFiles, artifactFiles, version: HOST_LABEL }), /differs from the committed manifest/);

  // Declaring a version again without rebuilding is a mismatch publish refuses.
  await writeJson(manifestPath, { ...manifest, version: removedVersion });
  await assert.rejects(publishExtractedIndex(await loadWorkspace(root), { fetchImpl: portalFetch, portalUrl: "https://portal.example.com", sourceCommit: "c".repeat(40), token: "timds_test_token" }), /stamped without a version but timds\.json declares/);
});

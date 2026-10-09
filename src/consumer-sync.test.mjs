import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CONSUMER_BUNDLE_RECORD_FILE, CONSUMER_MANIFEST_FILE, checkConsumer, loadConsumer, runConsumerCli } from "./consumer.mjs";
import { readBundleRecord, resolvePublishedBundle, syncConsumerBundle, updateConsumerPin } from "./consumer-sync.mjs";
import { derivedLayerPaths } from "./derived.mjs";

const BASE = "https://cdn.test/acme/core/artifact";
const sha256 = (content) => createHash("sha256").update(content).digest("hex");

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "timds-consumer-sync-"));
  t.after(() => fs.rm(directory, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 }));
  return fs.realpath(directory);
}

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "protocol.file.allow=always", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function write(root, relative, content) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
}

/** A published Design System: version 1.2.0 pinned under v/, and 1.3.0 as the current release at the base. */
function publishedSystem() {
  const file = (version, relative, body) => [`v/${version}/bundle/${relative}`, body];
  const pinnedFiles = [["src/styles/ds/brand.css", ".brand{color:navy}"], ["public/ds.js", "// ds 1.2"]];
  const currentFiles = [["src/styles/ds/brand.css", ".brand{color:gold}"]];
  const bundle = (version, files, directory) => ({
    schemaVersion: 1,
    system: { id: "acme/core", name: "Acme", version },
    url: `${directory.replace(/\/bundle$/, "")}/bundle.json`,
    directory,
    base: BASE,
    versioned: `${BASE}/v/${version}/bundle`,
    fileCount: files.length,
    bytes: files.reduce((sum, [, body]) => sum + body.length, 0),
    files: files.map(([relative, body]) => ({ path: relative, url: `${directory}/${relative}`, bytes: body.length, sha256: sha256(body) })),
    designs: [{ id: "website", routes: version === "1.2.0" ? ["/", "/about"] : ["/", "/contact"] }],
  });
  const served = new Map([
    [`v/1.2.0/bundle.json`, JSON.stringify(bundle("1.2.0", pinnedFiles, `${BASE}/v/1.2.0/bundle`))],
    ...pinnedFiles.map(([relative, body]) => file("1.2.0", relative, body)),
    [".timds-artifact.json", JSON.stringify({ schemaVersion: 1, sourceCommit: "a".repeat(40), version: "1.3.0", systemId: "acme/core", entry: "design-system/index.html", files: derivedLayerPaths("design-system/index.html") })],
    ["design-system/index.json", JSON.stringify({ schemaVersion: 1, system: { id: "acme/core", name: "Acme", version: "1.3.0" }, pageCount: 0, pages: [] })],
    ["design-system/bundle.json", JSON.stringify(bundle("1.3.0", currentFiles, `${BASE}/design-system/bundle`))],
    ...currentFiles.map(([relative, body]) => [`design-system/bundle/${relative}`, body]),
    // A publish writes the immutable copy beside the current one.
    [`v/1.3.0/bundle.json`, JSON.stringify(bundle("1.3.0", currentFiles, `${BASE}/v/1.3.0/bundle`))],
    ...currentFiles.map(([relative, body]) => file("1.3.0", relative, body)),
    ["design-system/designs.json", JSON.stringify({ schemaVersion: 1, designs: [{ id: "website", pages: [{ route: "/" }, { route: "/contact" }] }] })],
  ]);
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(String(url));
    const relative = String(url).startsWith(`${BASE}/`) ? String(url).slice(BASE.length + 1) : null;
    const body = relative === null ? undefined : served.get(relative);
    return body === undefined ? new Response("missing", { status: 404 }) : new Response(body, { status: 200 });
  };
  return { fetchImpl, requests, served, pinnedFiles };
}

async function productRepo(t, designSystem = { path: "design-system", systemId: "acme/core", version: "1.2.0", url: BASE }, apps = { web: { cwd: "web", preview: { build: ["npm", "run", "build"], output: "dist" }, designSurface: ["src/**"] } }) {
  const product = await temporaryDirectory(t);
  git(product, "init", "-q", "-b", "main");
  git(product, "config", "user.email", "timds-test@example.com");
  git(product, "config", "user.name", "TimDS Test");
  await write(product, CONSUMER_MANIFEST_FILE, { schemaVersion: 1, designSystem, apps });
  await write(product, "web/package.json", { name: "web" });
  await write(product, ".gitignore", "node_modules/\ndesign-system/\n");
  git(product, "add", ".");
  git(product, "commit", "-q", "-m", "Product");
  return product;
}

test("resolvePublishedBundle reads a pinned version directly and the current release through the stamp", async () => {
  const { fetchImpl, requests } = publishedSystem();
  const pinned = await resolvePublishedBundle({ url: BASE, version: "1.2.0", fetchImpl });
  assert.deepEqual([pinned.version, pinned.systemId, pinned.files.map((file) => file.path), pinned.designs], ["1.2.0", "acme/core", ["src/styles/ds/brand.css", "public/ds.js"], null]);
  assert.deepEqual(requests, [`${BASE}/v/1.2.0/bundle.json`], "a pinned version never reads the stamp");
  const current = await resolvePublishedBundle({ url: `${BASE}/`, version: "current", fetchImpl, withDesigns: true });
  assert.deepEqual([current.version, current.files.map((file) => file.path)], ["1.3.0", ["src/styles/ds/brand.css"]]);
  assert.deepEqual(current.designs, [{ id: "website", routes: ["/", "/contact"] }]);
  await assert.rejects(resolvePublishedBundle({ url: BASE, version: "9.9.9", fetchImpl }), /version 9\.9\.9's bundle is not published at .*v\/9\.9\.9\/bundle\.json/);
});

test("current pins resolve immutable bytes and reject a missing or mismatched versioned bundle", async () => {
  const { fetchImpl, served, requests } = publishedSystem();
  // A CDN can still serve the previous release's mutable manifest while the
  // stamp has advanced; it must not be relabeled as the new release.
  served.set("design-system/bundle.json", served.get("v/1.2.0/bundle.json"));
  const current = await resolvePublishedBundle({ url: BASE, version: "current", fetchImpl });
  assert.equal(current.version, "1.3.0");
  assert.ok(current.files.every((file) => file.url.startsWith(`${BASE}/v/1.3.0/`)));
  assert.deepEqual(requests, [`${BASE}/.timds-artifact.json`, `${BASE}/v/1.3.0/bundle.json`]);
  served.delete("v/1.3.0/bundle.json");
  await assert.rejects(resolvePublishedBundle({ url: BASE, version: "current", fetchImpl }), /version 1\.3\.0's bundle is not published/);
  served.set("v/1.3.0/bundle.json", served.get("v/1.2.0/bundle.json"));
  await assert.rejects(resolvePublishedBundle({ url: BASE, version: "1.3.0", fetchImpl }), /bundle is stamped 1\.2\.0/);
});

test("sync fetches the pinned bundle under its source paths, verifies digests, records what it fetched, and is idempotent", async (t) => {
  const product = await productRepo(t);
  const { fetchImpl, requests, pinnedFiles } = publishedSystem();
  const lines = [];
  const first = await syncConsumerBundle(product, { fetchImpl, output: (line) => lines.push(line) });
  assert.deepEqual([first.status, first.version, first.downloaded, first.unchanged, first.removed, first.files], ["synced", "1.2.0", 2, 0, 0, 2]);
  for (const [relative, body] of pinnedFiles) assert.equal(await fs.readFile(path.join(product, "design-system", relative), "utf8"), body);
  const record = await readBundleRecord(path.join(product, "design-system"));
  assert.deepEqual([record.schemaVersion, record.systemId, record.pin, record.version, record.versioned], [1, "acme/core", "1.2.0", "1.2.0", `${BASE}/v/1.2.0/bundle`]);
  assert.deepEqual(record.files.map((file) => file.path), ["src/styles/ds/brand.css", "public/ds.js"]);
  assert.match(lines.join("\n"), /Synced Design System acme\/core 1\.2\.0 into design-system\/: 2 downloaded, 0 unchanged, 0 removed/);
  assert.ok(!lines.join("\n").includes("Warning"), ".gitignore covers the directory");

  // A second sync reads the manifest, finds every digest in place, and downloads nothing.
  requests.length = 0;
  const second = await syncConsumerBundle(product, { fetchImpl, output: (line) => lines.push(line) });
  assert.deepEqual([second.status, second.downloaded, second.unchanged], ["unchanged", 0, 2]);
  assert.deepEqual(requests, [`${BASE}/v/1.2.0/bundle.json`]);
  assert.match(lines.at(-1), /is up to date at design-system\/ \(2 files\)/);

  // A tampered file is fetched again; the sync never trusts what is on disk by name alone.
  await fs.writeFile(path.join(product, "design-system/public/ds.js"), "edited");
  const repaired = await syncConsumerBundle(product, { fetchImpl, output: () => {} });
  assert.deepEqual([repaired.status, repaired.downloaded, repaired.unchanged], ["synced", 1, 1]);
  assert.equal(await fs.readFile(path.join(product, "design-system/public/ds.js"), "utf8"), "// ds 1.2");

  // The consumer loads as a published pin that is present, and check passes offline.
  const consumer = await loadConsumer(product);
  assert.deepEqual([consumer.designSystem.mode, consumer.designSystem.version, consumer.designSystem.url, consumer.designSystem.present, consumer.designSystem.commit], ["published", "1.2.0", BASE, true, null]);
  const checked = await checkConsumer(product);
  assert.equal(checked.status, "passed", checked.errors.join("\n"));
});

test("sync removes files the new version no longer lists, follows a current pin, and warns when git would track the directory", async (t) => {
  const product = await productRepo(t, { path: "design-system", systemId: "acme/core", version: "current", url: BASE });
  await fs.writeFile(path.join(product, ".gitignore"), "node_modules/\n");
  const { fetchImpl } = publishedSystem();
  // Pretend an earlier sync fetched 1.2.0's two files.
  await write(product, "design-system/public/ds.js", "// ds 1.2");
  await write(product, `design-system/${CONSUMER_BUNDLE_RECORD_FILE}`, { schemaVersion: 1, version: "1.2.0", files: [{ path: "public/ds.js" }, { path: "src/styles/ds/brand.css" }] });
  const lines = [];
  const result = await syncConsumerBundle(product, { fetchImpl, output: (line) => lines.push(line) });
  assert.deepEqual([result.status, result.pin, result.version, result.downloaded, result.removed], ["synced", "current", "1.3.0", 1, 1]);
  await assert.rejects(fs.access(path.join(product, "design-system/public/ds.js")), "the stale file is gone");
  assert.equal(await fs.readFile(path.join(product, "design-system/src/styles/ds/brand.css"), "utf8"), ".brand{color:gold}");
  assert.equal((await readBundleRecord(path.join(product, "design-system"))).version, "1.3.0");
  assert.match(lines.join("\n"), /Warning: \.gitignore does not list design-system\//);
  const checked = await checkConsumer(product);
  assert.equal(checked.status, "passed", checked.errors.join("\n"));
});

test("sync leaves a symbolic link alone and refuses a directory that is still a submodule", async (t) => {
  const product = await productRepo(t);
  const { fetchImpl } = publishedSystem();
  const checkout = await temporaryDirectory(t);
  await write(checkout, "src/styles/ds/brand.css", ".live{}");
  await write(checkout, "timds.json", { systemId: "acme/core", version: "1.4.0" });
  await fs.symlink(checkout, path.join(product, "design-system"));
  const lines = [];
  const linked = await syncConsumerBundle(product, { fetchImpl, output: (line) => lines.push(line) });
  assert.deepEqual([linked.status, linked.target], ["linked", checkout]);
  assert.match(lines[0], /design-system is a symbolic link to .*; leaving it alone/);
  assert.equal(await fs.readFile(path.join(product, "design-system/src/styles/ds/brand.css"), "utf8"), ".live{}");
  const checked = await checkConsumer(product);
  assert.equal(checked.status, "passed", checked.errors.join("\n"));
  assert.match(checked.warnings.join("\n"), /local Design System checkout/);
  await fs.rm(path.join(checkout, "timds.json"));
  assert.match((await checkConsumer(product)).errors.join("\n"), /target has no timds.json/);

  await fs.unlink(path.join(product, "design-system"));
  await fs.mkdir(path.join(product, "design-system/.git"), { recursive: true });
  await assert.rejects(syncConsumerBundle(product, { fetchImpl, output: () => {} }), /design-system is still a git submodule[\s\S]*git rm -r --cached design-system/);
});

test("a fixed pin checks its own design routes without reading current metadata or the provenance dotfile", async (t) => {
  const product = await productRepo(t, undefined, {
    web: { cwd: "web", preview: { build: ["npm", "run", "build"], output: "dist", routes: ["/"], designs: { "/": "website:/about" } }, designSurface: ["src/**"] },
  });
  const { fetchImpl, requests, served } = publishedSystem();
  served.delete(".timds-artifact.json");
  await syncConsumerBundle(product, { fetchImpl });
  assert.ok(requests.every((url) => url.startsWith(`${BASE}/v/1.2.0/`)), requests.join("\n"));
  assert.equal((await checkConsumer(product)).status, "passed");
  const record = await readBundleRecord(path.join(product, "design-system"));
  assert.deepEqual(record.designs, [{ id: "website", routes: ["/", "/about"] }]);

  const manifest = JSON.parse(await fs.readFile(path.join(product, CONSUMER_MANIFEST_FILE), "utf8"));
  manifest.apps.web.preview.designs["/"] = "website:/contact";
  await write(product, CONSUMER_MANIFEST_FILE, manifest);
  assert.match((await checkConsumer(product)).errors.join("\n"), /has no route \/contact/);

  // An older bundle without a summary remains installable; the current
  // release's routes must never fill the gap, nor may a previous sync do so.
  const oldBundle = JSON.parse(served.get("v/1.2.0/bundle.json"));
  delete oldBundle.designs;
  served.set("v/1.2.0/bundle.json", JSON.stringify(oldBundle));
  await syncConsumerBundle(product, { fetchImpl });
  assert.equal((await readBundleRecord(path.join(product, "design-system"))).designs, null);
  assert.match((await checkConsumer(product)).warnings.join("\n"), /no recorded website designs/);
});

test("a published pin symlink checks design pairings from its checkout", async (t) => {
  const product = await productRepo(t, undefined, {
    web: { cwd: "web", preview: { build: ["npm", "run", "build"], output: "dist", routes: ["/"], designs: { "/": "website:/live" } }, designSurface: ["src/**"] },
  });
  const checkout = await temporaryDirectory(t);
  await write(checkout, "timds.json", { systemId: "acme/core" });
  await write(checkout, "src/designs/website/design.json", { title: "Website" });
  await write(checkout, "src/designs/website/pages/live.html", "<h1>Live</h1>");
  await fs.symlink(checkout, path.join(product, "design-system"));
  assert.equal((await checkConsumer(product)).status, "passed");
  await fs.rm(path.join(checkout, "src/designs/website/pages/live.html"));
  await write(checkout, "src/designs/website/pages/index.html", "<h1>Home</h1>");
  assert.match((await checkConsumer(product)).errors.join("\n"), /has no route \/live/);
});

test("sync refuses a bundle whose bytes do not match its digest, a foreign system, or a submodule pin", async (t) => {
  const product = await productRepo(t);
  const { fetchImpl, served } = publishedSystem();
  served.set("v/1.2.0/bundle/public/ds.js", "tampered");
  await assert.rejects(syncConsumerBundle(product, { fetchImpl, output: () => {} }), /public\/ds\.js downloaded from .* does not match the digest/);
  await assert.rejects(fs.access(path.join(product, "design-system", CONSUMER_BUNDLE_RECORD_FILE)), "nothing is recorded for a failed sync");

  const other = await productRepo(t, { path: "design-system", systemId: "other/core", version: "1.2.0", url: BASE });
  await assert.rejects(syncConsumerBundle(other, { fetchImpl: publishedSystem().fetchImpl, output: () => {} }), /names other\/core but the bundle at .* belongs to acme\/core/);

  const submodule = await productRepo(t, { path: "design-system", systemId: "acme/core" });
  await assert.rejects(syncConsumerBundle(submodule, { fetchImpl, output: () => {} }), /pins the Design System as a git submodule .* sync applies to a published pin/);
});

test("update moves the pin to the current release or a named version, rewrites the manifest, and syncs", async (t) => {
  const product = await productRepo(t);
  const { fetchImpl } = publishedSystem();
  await syncConsumerBundle(product, { fetchImpl, output: () => {} });
  const lines = [];
  const moved = await updateConsumerPin(product, { fetchImpl, output: (line) => lines.push(line) });
  assert.deepEqual([moved.previous, moved.version, moved.changed, moved.synced.status, moved.synced.version], ["1.2.0", "1.3.0", true, "synced", "1.3.0"]);
  const manifest = JSON.parse(await fs.readFile(path.join(product, CONSUMER_MANIFEST_FILE), "utf8"));
  assert.deepEqual(manifest.designSystem, { path: "design-system", systemId: "acme/core", version: "1.3.0", url: BASE });
  assert.match(lines[0], /Pinned Design System acme\/core: 1\.2\.0 -> 1\.3\.0 in timds\.consumer\.json/);
  await assert.rejects(fs.access(path.join(product, "design-system/public/ds.js")), "1.3.0 no longer ships the script");

  const same = await updateConsumerPin(product, { fetchImpl, output: (line) => lines.push(line) });
  assert.equal(same.changed, false);
  assert.match(lines.at(-2), /already pinned at 1\.3\.0/);
  const back = await updateConsumerPin(product, { version: "1.2.0", fetchImpl, output: () => {} });
  assert.deepEqual([back.changed, back.version, back.synced.downloaded], [true, "1.2.0", 2]);

  // The moved pin is a pin change for check --base, never a design change (HEAD still pins 1.2.0).
  await fs.writeFile(path.join(product, CONSUMER_MANIFEST_FILE), JSON.stringify({ ...manifest, designSystem: { ...manifest.designSystem, version: "1.3.0" } }, null, 2));
  const checked = await checkConsumer(product, { base: "HEAD" });
  assert.equal(checked.status, "failed");
  assert.match(checked.errors.join("\n"), /The Design System pin \(designSystem in timds\.consumer\.json\) changed/);
  assert.deepEqual(checked.changes, [{ path: CONSUMER_MANIFEST_FILE, status: "pin", app: null }]);
});

test("check in published mode reports a missing sync, a drifted version, a leftover submodule, and pairs designs from the record", async (t) => {
  const product = await productRepo(t, { path: "design-system", systemId: "acme/core", version: "1.2.0", url: BASE }, {
    web: { cwd: "web", preview: { serve: ["npm", "run", "dev"], port: 4321, routes: ["/", "/about"], designs: { "/": "website:/", "/about": "website:/about" } }, designSurface: ["src/**"] },
  });
  const missing = await checkConsumer(product);
  assert.equal(missing.status, "failed");
  assert.match(missing.errors.join("\n"), /design-system has no synced Design System bundle\. Run: npm run timds -- consumer sync/);

  await write(product, "design-system/src/styles/ds/brand.css", "x");
  await write(product, `design-system/${CONSUMER_BUNDLE_RECORD_FILE}`, { schemaVersion: 1, systemId: "acme/core", version: "1.1.0", files: [{ path: "src/styles/ds/brand.css" }], designs: [{ id: "website", routes: ["/"] }] });
  const drifted = await checkConsumer(product);
  assert.match(drifted.errors.join("\n"), /holds Design System version 1\.1\.0 but timds\.consumer\.json pins 1\.2\.0/);
  assert.match(drifted.errors.join("\n"), /design website has no route \/about \(routes: \/\)/, "pairings come from the recorded designs");

  await write(product, `design-system/${CONSUMER_BUNDLE_RECORD_FILE}`, { schemaVersion: 1, systemId: "acme/core", version: "1.2.0", files: [{ path: "src/styles/ds/brand.css" }, { path: "public/ds.js" }], designs: [{ id: "website", routes: ["/", "/about"] }] });
  const incomplete = await checkConsumer(product);
  assert.match(incomplete.errors.join("\n"), /design-system\/public\/ds\.js is missing from the synced bundle/);

  await write(product, "design-system/public/ds.js", "x");
  const passed = await checkConsumer(product);
  assert.equal(passed.status, "passed", passed.errors.join("\n"));

  const { product: withSubmodule, lines } = await (async () => {
    const dsRepo = await temporaryDirectory(t);
    git(dsRepo, "init", "-q", "-b", "main");
    git(dsRepo, "config", "user.email", "timds-test@example.com");
    git(dsRepo, "config", "user.name", "TimDS Test");
    await write(dsRepo, "timds.json", { schemaVersion: 2, systemId: "acme/core", name: "Acme" });
    git(dsRepo, "add", ".");
    git(dsRepo, "commit", "-q", "-m", "ds");
    const repo = await productRepo(t);
    await fs.rm(path.join(repo, "design-system"), { force: true, recursive: true });
    await fs.writeFile(path.join(repo, ".gitignore"), "node_modules/\n");
    git(repo, "submodule", "add", "-q", dsRepo, "design-system");
    git(repo, "commit", "-q", "-am", "submodule");
    const output = [];
    return { product: repo, lines: output };
  })();
  const leftover = await checkConsumer(withSubmodule);
  assert.match(leftover.errors.join("\n"), /design-system is still a git submodule but timds\.consumer\.json pins a published version/);
  assert.equal(lines.length, 0);
});

test("the consumer CLI routes sync and update, and refuses unknown options", async () => {
  await assert.rejects(runConsumerCli(["sync", "--bogus"]), /Unknown option --bogus/);
  await assert.rejects(runConsumerCli(["update", "1.0.0", "2.0.0"]), /Unexpected argument 2\.0\.0/);
  const lines = [];
  await runConsumerCli(["sync", "--help"], { output: (line) => lines.push(line) });
  assert.match(lines.join("\n"), /timds consumer update \[VERSION\]/);
});

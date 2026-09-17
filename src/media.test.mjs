import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { publishStagedMedia, readLocalMediaManifest, readMediaCatalog, stageMediaFile } from "./media.mjs";

const sha256 = (content) => createHash("sha256").update(content).digest("hex");

function record(key, content, overrides = {}) {
  return {
    bytes: Buffer.byteLength(content),
    contentType: "image/png",
    filename: `${key}.png`,
    id: `asset_${key.replaceAll("-", "_")}`,
    key,
    kind: "image",
    publicUrl: `https://assets.example.test/${key}.png`,
    sha256: sha256(content),
    tags: [],
    title: key,
    ...overrides,
  };
}

async function fixture(t, assets = []) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "timds-media-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".timds"));
  await fs.mkdir(path.join(root, "media-local"));
  const workspace = { repoRoot: root, designSystemRoot: root, manifest: { systemId: "test/media" } };
  const catalogPath = path.join(root, "media.json");
  const localPath = path.join(root, ".timds", "local-media.json");
  const writeCatalog = (next) => fs.writeFile(catalogPath, `${JSON.stringify({ schemaVersion: 2, assets: next }, null, 2)}\n`);
  await writeCatalog(assets);
  return {
    workspace, root, catalogPath, localPath, writeCatalog,
    async stage(key, content, filename = `${key}.png`) {
      const source = path.join(root, "media-local", filename);
      await fs.writeFile(source, content);
      return stageMediaFile(workspace, source, { key });
    },
    async makeLegacy() {
      const { manifest } = await readLocalMediaManifest(root);
      for (const asset of manifest.assets) delete asset.baseSha256;
      await fs.writeFile(localPath, JSON.stringify(manifest));
    },
    async localAssets() { return (await readLocalMediaManifest(root)).manifest.assets; },
    async assets() { return (await readMediaCatalog(root)).catalog.assets; },
  };
}

function publisher(onUpload = () => {}) {
  const requests = [];
  return {
    requests,
    options: {
      portalUrl: "https://portal.example.test",
      token: "test-token",
      async fetchImpl(url, options) {
        const body = JSON.parse(options.body);
        requests.push({ url: String(url), body });
        const asset = await onUpload(body) || {
          id: `asset_${body.sha256.slice(0, 16)}`,
          publicUrl: `https://assets.example.test/${body.sha256}/${body.filename}`,
        };
        return Response.json({ asset, reused: true });
      },
    },
  };
}

test("legacy PNG staging cannot overwrite 27 optimized portraits or delete their original keys", async (t) => {
  const pairs = Array.from({ length: 27 }, (_, index) => {
    const key = `portrait-${index}`;
    return [
      record(key, `webp-${index}`, { contentType: "image/webp", filename: `${key}.webp`, publicUrl: `https://assets.example.test/${key}.webp` }),
      record(`${key}-original`, `png-${index}`),
    ];
  });
  const f = await fixture(t, pairs.flat());
  // Even an unrelated new asset sorted before the conflict must not be uploaded.
  await f.stage("a-new-image", "new-image");
  for (let index = 0; index < pairs.length; index++) await f.stage(pairs[index][0].key, `png-${index}`);
  await f.makeLegacy();
  const before = await fs.readFile(f.catalogPath, "utf8");
  const localBefore = await fs.readFile(f.localPath, "utf8");
  const p = publisher();
  await assert.rejects(publishStagedMedia(f.workspace, p.options), /portrait-0 conflicts.*older staging entry/);
  assert.equal(p.requests.length, 0);
  assert.equal(await fs.readFile(f.catalogPath, "utf8"), before);
  assert.equal(await fs.readFile(f.localPath, "utf8"), localBefore);
});

test("catalog changes after staging block publication even when the image format is unchanged", async (t) => {
  const f = await fixture(t, [record("portrait", "version-one")]);
  await f.stage("portrait", "staged-replacement");
  await f.writeCatalog([record("portrait", "version-two")]);
  const before = await fs.readFile(f.catalogPath, "utf8");
  const p = publisher();
  await assert.rejects(publishStagedMedia(f.workspace, p.options), /catalog changed since staging/);
  assert.equal(p.requests.length, 0);
  assert.equal(await fs.readFile(f.catalogPath, "utf8"), before);
});

test("restaging a reviewed replacement publishes it once and keeps the baseline local", async (t) => {
  const f = await fixture(t, [record("portrait", "version-one")]);
  await f.stage("portrait", "replacement");
  await f.writeCatalog([record("portrait", "version-two")]);
  await f.stage("portrait", "replacement");
  assert.equal((await f.localAssets())[0].baseSha256, sha256("version-two"));
  const p = publisher();
  const first = await publishStagedMedia(f.workspace, p.options);
  assert.equal(first.published.length, 1);
  assert.equal(first.unchanged.length, 0);
  assert.equal((await f.assets())[0].sha256, sha256("replacement"));
  assert.equal((await f.localAssets())[0].baseSha256, sha256("replacement"));
  assert.equal(Object.hasOwn(p.requests[0].body, "baseSha256"), false);
  assert.equal(Object.hasOwn((await f.assets())[0], "baseSha256"), false);
  const second = await publishStagedMedia(f.workspace, p.options);
  assert.equal(second.published.length, 0);
  assert.equal(second.unchanged.length, 1);
  assert.equal(p.requests.length, 1);
});

test("reverting media.json after a successful replacement cannot republish the reverted content", async (t) => {
  const original = record("portrait", "original-version");
  const f = await fixture(t, [original]);
  await f.stage("portrait", "replacement");
  const p = publisher();
  await publishStagedMedia(f.workspace, p.options);
  await f.writeCatalog([original]);
  await assert.rejects(publishStagedMedia(f.workspace, p.options), /catalog changed since staging/);
  assert.equal(p.requests.length, 1);
  assert.deepEqual(await f.assets(), [original]);
});

test("a staged new key cannot overwrite a key added by another checkout", async (t) => {
  const f = await fixture(t);
  await f.stage("portrait", "local-new-file");
  assert.equal((await f.localAssets())[0].baseSha256, null);
  const remote = record("portrait", "remote-new-file");
  await f.writeCatalog([remote]);
  const p = publisher();
  await assert.rejects(publishStagedMedia(f.workspace, p.options), /catalog changed since staging/);
  assert.equal(p.requests.length, 0);
  assert.deepEqual(await f.assets(), [remote]);
});

test("removing a successfully published new key does not let old staging resurrect it", async (t) => {
  const f = await fixture(t);
  await f.stage("portrait", "new-file");
  const p = publisher();
  await publishStagedMedia(f.workspace, p.options);
  await f.writeCatalog([]);
  await assert.rejects(publishStagedMedia(f.workspace, p.options), /catalog changed since staging/);
  assert.equal(p.requests.length, 1);
  assert.deepEqual(await f.assets(), []);
});

test("reusing another key's asset ID preserves both catalog records", async (t) => {
  const optimized = record("portrait", "optimized", { contentType: "image/webp", filename: "portrait.webp" });
  const original = record("portrait-original", "original");
  const f = await fixture(t, [optimized, original]);
  // Intentional restaging passes the stale-entry check; ID reuse must still fail.
  await f.stage("portrait", "original");
  const before = await fs.readFile(f.catalogPath, "utf8");
  const localBefore = await fs.readFile(f.localPath, "utf8");
  const p = publisher(() => original);
  await assert.rejects(publishStagedMedia(f.workspace, p.options), /already belongs to key portrait-original/);
  assert.equal(p.requests.length, 1);
  assert.equal(await fs.readFile(f.catalogPath, "utf8"), before);
  assert.equal(await fs.readFile(f.localPath, "utf8"), localBefore);
});

test("a new key cannot silently rename an existing key when the portal reuses its asset ID", async (t) => {
  const original = record("portrait-original", "original");
  const f = await fixture(t, [original]);
  await f.stage("portrait", "original");
  const p = publisher(() => original);
  await assert.rejects(publishStagedMedia(f.workspace, p.options), /already belongs to key portrait-original/);
  assert.deepEqual(await f.assets(), [original]);
});

test("unchanged legacy staging adopts a baseline without uploading or rewriting media.json", async (t) => {
  const existing = record("portrait", "same-image");
  const f = await fixture(t, [existing]);
  await f.stage("portrait", "same-image");
  await f.makeLegacy();
  const before = await fs.readFile(f.catalogPath, "utf8");
  const p = publisher();
  const result = await publishStagedMedia(f.workspace, p.options);
  assert.equal(result.unchanged.length, 1);
  assert.equal(p.requests.length, 0);
  assert.equal(await fs.readFile(f.catalogPath, "utf8"), before);
  assert.equal((await f.localAssets())[0].baseSha256, existing.sha256);
  await f.writeCatalog([record("portrait", "changed-image")]);
  await assert.rejects(publishStagedMedia(f.workspace, p.options), /catalog changed since staging/);
});

test("legacy staging for an unpublished key still publishes and records its new baseline", async (t) => {
  const f = await fixture(t);
  await f.stage("portrait", "new-file");
  await f.makeLegacy();
  const p = publisher();
  const result = await publishStagedMedia(f.workspace, p.options);
  assert.equal(result.published.length, 1);
  assert.equal((await f.localAssets())[0].baseSha256, sha256("new-file"));
});

test("failed publication leaves the baseline and catalog intact so the operation can be retried", async (t) => {
  const original = record("portrait", "original");
  const f = await fixture(t, [original]);
  await f.stage("portrait", "replacement");
  const failing = publisher(() => { throw new Error("transfer failed"); });
  await assert.rejects(publishStagedMedia(f.workspace, failing.options), /transfer failed/);
  assert.equal((await f.localAssets())[0].baseSha256, original.sha256);
  assert.deepEqual(await f.assets(), [original]);
  const p = publisher();
  assert.equal((await publishStagedMedia(f.workspace, p.options)).published.length, 1);
});

test("catalog changes during an upload are checked before replacing its record", async (t) => {
  const f = await fixture(t, [record("portrait", "original")]);
  await f.stage("portrait", "replacement");
  const remote = record("portrait", "remote-change");
  const p = publisher(async () => { await f.writeCatalog([remote]); });
  await assert.rejects(publishStagedMedia(f.workspace, p.options), /catalog changed since staging/);
  assert.deepEqual(await f.assets(), [remote]);
});

test("publication preserves unrelated catalog and staging changes made during upload", async (t) => {
  const original = record("portrait", "original");
  const unrelated = record("unrelated", "other-file");
  const f = await fixture(t, [original]);
  await f.stage("portrait", "replacement");
  const p = publisher(async () => {
    await f.writeCatalog([original, unrelated]);
    await f.stage("later-image", "staged-during-upload");
  });
  await publishStagedMedia(f.workspace, p.options);
  assert.deepEqual((await f.assets()).find((asset) => asset.key === unrelated.key), unrelated);
  assert.deepEqual((await f.localAssets()).map((asset) => asset.key), ["later-image", "portrait"]);
});

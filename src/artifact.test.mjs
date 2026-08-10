import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  artifactContentType,
  collectIndexAssetFiles,
  publishExtractedIndex,
  rewriteIndexForPublish,
} from "./artifact.mjs";

const INDEX = {
  schemaVersion: 1,
  system: { id: "client/system", name: "Client System", version: "1.2.3" },
  pageCount: 1,
  pages: [
    {
      id: "social/video-assets",
      url: "/design-system/social/video-assets",
      view: "social",
      eyebrow: "",
      title: "Video assets",
      lede: "",
      blocks: [
        {
          id: "social/video-assets#photos",
          title: "Photos",
          assets: [
            { id: "a1", name: "Elder hands", media: { url: "/design-system/photos/elder-hands.webp" } },
            { id: "a2", name: "Elder hands again", media: { url: "/design-system/photos/elder-hands.webp?v=2" } },
            {
              id: "a3",
              name: "widow-window",
              media: { key: "b-roll-widow-window", url: "https://cdn.example.com/media/abc/widow-window.mp4" },
            },
          ],
        },
      ],
    },
  ],
};

async function makeArtifact(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "timds-artifact-test-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, ...relative.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return root;
}

test("artifactContentType maps known extensions and defaults the rest", () => {
  assert.equal(artifactContentType("design-system/photos/elder-hands.webp"), "image/webp");
  assert.equal(artifactContentType("design-system/index.json"), "application/json");
  assert.equal(artifactContentType("mystery.bin"), "application/octet-stream");
});

test("collectIndexAssetFiles resolves site-absolute references and dedupes queries", async () => {
  const root = await makeArtifact({ "design-system/photos/elder-hands.webp": "webp-bytes" });
  try {
    const files = await collectIndexAssetFiles(INDEX, root);
    assert.deepEqual([...files.keys()], ["design-system/photos/elder-hands.webp"]);
    const file = files.get("design-system/photos/elder-hands.webp");
    assert.equal(file.bytes, 10);
    assert.equal(file.contentType, "image/webp");
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("collectIndexAssetFiles fails loudly on a dangling reference", async () => {
  const root = await makeArtifact({});
  try {
    await assert.rejects(
      () => collectIndexAssetFiles(INDEX, root),
      /references \/design-system\/photos\/elder-hands\.webp but the artifact has no/
    );
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("rewriteIndexForPublish rewrites local references, stamps integrity, and leaves media records alone", async () => {
  const root = await makeArtifact({ "design-system/photos/elder-hands.webp": "webp-bytes" });
  try {
    const files = await collectIndexAssetFiles(INDEX, root);
    const rewritten = rewriteIndexForPublish(INDEX, files, "https://cdn.example.com/clients/c/design-systems/s/artifact/");
    const [local, localWithQuery, mediaRecord] = rewritten.pages[0].blocks[0].assets.map((asset) => asset.media);
    assert.equal(local.url, "https://cdn.example.com/clients/c/design-systems/s/artifact/design-system/photos/elder-hands.webp");
    assert.equal(local.bytes, 10);
    assert.match(local.sha256, /^[a-f0-9]{64}$/);
    assert.equal(localWithQuery.url, local.url);
    assert.equal(mediaRecord.url, "https://cdn.example.com/media/abc/widow-window.mp4");
    assert.equal(mediaRecord.bytes, undefined);
    // The extracted index on disk keeps its site-absolute form.
    assert.equal(INDEX.pages[0].blocks[0].assets[0].media.url, "/design-system/photos/elder-hands.webp");
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("publishExtractedIndex uploads assets first, then the rewritten index and provenance stamp", async () => {
  const designSystemRoot = await fs.mkdtemp(path.join(os.tmpdir(), "timds-publish-test-"));
  try {
    const artifact = {
      "dist/design-system/index.json": `${JSON.stringify(INDEX, null, 2)}\n`,
      "dist/design-system/photos/elder-hands.webp": "webp-bytes",
    };
    for (const [relative, content] of Object.entries(artifact)) {
      const target = path.join(designSystemRoot, ...relative.split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }
    const workspace = {
      designSystemRoot,
      manifest: {
        artifact: { entry: "design-system/index.html" },
        media: { portalUrl: "https://portal.example.com" },
        systemId: "client/system",
        version: "1.2.3",
      },
    };

    const sessions = [];
    const puts = new Map();
    const fetchImpl = async (url, init = {}) => {
      if (String(url).endsWith("/api/operator/design-system-artifacts/uploads")) {
        const body = JSON.parse(init.body);
        sessions.push(body);
        return new Response(
          JSON.stringify({
            publicBase: "https://cdn.example.com/clients/c/design-systems/s/artifact",
            // The photo is reported current; only index + stamp need uploading.
            uploads: body.files
              .filter((file) => file.path !== "design-system/photos/elder-hands.webp")
              .map((file) => ({ method: "single", path: file.path, url: `https://upload.example.com/${file.path}` })),
          }),
          { headers: { "Content-Type": "application/json" }, status: 200 }
        );
      }
      if (String(url).startsWith("https://upload.example.com/") && init.method === "PUT") {
        puts.set(String(url).slice("https://upload.example.com/".length), Buffer.from(init.body).toString("utf8"));
        return new Response(null, { status: 200 });
      }
      throw new Error(`Unexpected fetch ${init.method || "GET"} ${url}`);
    };

    const published = await publishExtractedIndex(workspace, {
      fetchImpl,
      sourceCommit: "a".repeat(40),
      token: "timds_test_token",
    });

    assert.equal(published.indexUrl, "https://cdn.example.com/clients/c/design-systems/s/artifact/design-system/index.json");
    assert.equal(published.uploaded, 2);
    assert.equal(published.skipped, 1);
    assert.equal(published.total, 3);

    assert.equal(sessions.length, 2);
    assert.deepEqual(sessions[0].files.map((file) => file.path), ["design-system/photos/elder-hands.webp"]);
    assert.equal(sessions[0].systemId, "client/system");
    assert.equal(sessions[0].version, "1.2.3");
    assert.deepEqual(sessions[1].files.map((file) => file.path).sort(), [".timds-artifact.json", "design-system/index.json"]);

    const uploadedIndex = JSON.parse(puts.get("design-system/index.json"));
    assert.equal(
      uploadedIndex.pages[0].blocks[0].assets[0].media.url,
      "https://cdn.example.com/clients/c/design-systems/s/artifact/design-system/photos/elder-hands.webp"
    );
    assert.match(uploadedIndex.pages[0].blocks[0].assets[0].media.sha256, /^[a-f0-9]{64}$/);
    const stamp = JSON.parse(puts.get(".timds-artifact.json"));
    assert.deepEqual(stamp, { schemaVersion: 1, sourceCommit: "a".repeat(40), version: "1.2.3" });
  } finally {
    await fs.rm(designSystemRoot, { force: true, recursive: true });
  }
});

test("publishExtractedIndex refuses a stale index", async () => {
  const designSystemRoot = await fs.mkdtemp(path.join(os.tmpdir(), "timds-stale-test-"));
  try {
    const target = path.join(designSystemRoot, "dist", "design-system", "index.json");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify({ ...INDEX, system: { ...INDEX.system, version: "1.2.2" } }));
    const workspace = {
      designSystemRoot,
      manifest: { artifact: { entry: "design-system/index.html" }, systemId: "client/system", version: "1.2.3" },
    };
    await assert.rejects(
      () => publishExtractedIndex(workspace, { token: "timds_test_token" }),
      /stamped 1\.2\.2 but timds\.json declares 1\.2\.3/
    );
  } finally {
    await fs.rm(designSystemRoot, { force: true, recursive: true });
  }
});

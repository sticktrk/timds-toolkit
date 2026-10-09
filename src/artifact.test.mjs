import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  artifactContentType,
  collectBrandKitFiles,
  collectIndexAssetFiles,
  collectMachineDocFiles,
  detectSourceCommit,
  publishExtractedIndex,
  rewriteIndexForPublish,
  rewriteBrandKitForPublish,
  rewriteLlmsForPublish,
} from "./artifact.mjs";

test("detectSourceCommit stamps the published checkout rather than the triggering workflow commit", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "timds-source-commit-test-"));
  const previous = process.env.GITHUB_SHA;
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.name", "TimDS Test"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await fs.writeFile(path.join(root, "source.txt"), "release checkout\n");
    execFileSync("git", ["add", "source.txt"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "Release checkout"], { cwd: root });
    const checkoutCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    process.env.GITHUB_SHA = "f".repeat(40);

    assert.equal(detectSourceCommit(root), checkoutCommit);
  } finally {
    if (previous === undefined) delete process.env.GITHUB_SHA;
    else process.env.GITHUB_SHA = previous;
    await fs.rm(root, { force: true, recursive: true });
  }
});

const INDEX = {
  schemaVersion: 1,
  system: { id: "client/system", name: "Client System", version: "1.2.3" },
  pageCount: 1,
  pages: [
    {
      id: "social/video-assets",
      url: "/design-system/social/video-assets",
      markdownUrl: "/design-system/social/video-assets/index.md",
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
    assert.equal(rewritten.pages[0].markdownUrl, "https://cdn.example.com/clients/c/design-systems/s/artifact/design-system/social/video-assets/index.md");
    assert.equal(mediaRecord.url, "https://cdn.example.com/media/abc/widow-window.mp4");
    assert.equal(mediaRecord.bytes, undefined);
    // The extracted index on disk keeps its site-absolute form.
    assert.equal(INDEX.pages[0].blocks[0].assets[0].media.url, "/design-system/photos/elder-hands.webp");
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("rewriteLlmsForPublish makes link targets and the index pointer absolute", () => {
  const source = [
    "# Client System",
    "",
    "Machine-readable index: /design-system/index.json — every page below also exists as `index.md`.",
    "",
    "## social",
    "",
    "- [Video assets](/design-system/social/video-assets/index.md): The photo registry.",
  ].join("\n");
  const rewritten = rewriteLlmsForPublish(source, "https://cdn.example.com/artifact/");
  assert.match(rewritten, /Machine-readable index: https:\/\/cdn\.example\.com\/artifact\/design-system\/index\.json/);
  assert.match(
    rewriteLlmsForPublish("Design tokens: /design-system/tokens.json — resolved.\n", "https://cdn.example.com/artifact/"),
    /^Design tokens: https:\/\/cdn\.example\.com\/artifact\/design-system\/tokens\.json — resolved\.$/m,
  );
  assert.match(rewritten, /\]\(https:\/\/cdn\.example\.com\/artifact\/design-system\/social\/video-assets\/index\.md\)/);
  assert.doesNotMatch(rewritten, /\]\(\//);
});

test("collectMachineDocFiles finds page mirrors under the entry directory", async () => {
  const root = await makeArtifact({
    "design-system/index.md": "# Root",
    "design-system/social/video-assets/index.md": "# Video assets",
    "design-system/photos/elder-hands.webp": "not-markdown",
  });
  try {
    assert.deepEqual(await collectMachineDocFiles(root, "design-system"), [
      "design-system/index.md",
      "design-system/social/video-assets/index.md",
    ]);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("protocol-relative font URLs remain external during collection and publishing", async () => {
  const root = await makeArtifact({ "fonts.example.com/inter.woff2": "unrelated-local-file" });
  try {
    const url = "//fonts.example.com/inter.woff2";
    const kit = { roles: { "font.body": { files: [{ url, weight: "400", style: "normal" }] } } };
    const files = await collectBrandKitFiles(kit, root);
    assert.equal(files.size, 0);
    assert.equal(rewriteBrandKitForPublish(kit, files, "https://cdn.example.com/artifact").roles["font.body"].files[0].url, url);
    const text = "  - stylesheet: //fonts.googleapis.com/css2?family=Inter\n  - 400 normal woff2: //fonts.example.com/inter.woff2\n- [External](//fonts.example.com/inter.css)\n- 400 normal woff2: /fonts/inter.woff2\n";
    const published = rewriteLlmsForPublish(text, "https://cdn.example.com/artifact");
    assert.ok(published.includes("stylesheet: //fonts.googleapis.com/css2?family=Inter"));
    assert.ok(published.includes("woff2: //fonts.example.com/inter.woff2"));
    assert.ok(published.includes("[External](//fonts.example.com/inter.css)"));
    assert.ok(published.includes("woff2: https://cdn.example.com/artifact/fonts/inter.woff2"));
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("publishExtractedIndex uploads assets and mirrors first, then index, llms.txt, and stamp", async () => {
  const designSystemRoot = await fs.mkdtemp(path.join(os.tmpdir(), "timds-publish-test-"));
  try {
    const artifact = {
      "dist/design-system/index.json": `${JSON.stringify({ ...INDEX, formats: { url: "/design-system/formats.json", groups: 1, count: 1 } }, null, 2)}\n`,
      "dist/design-system/photos/elder-hands.webp": "webp-bytes",
      "dist/design-system/social/video-assets/index.md": "# Video assets\n",
      "dist/design-system/tokens.json": '{"schemaVersion":1,"tokens":[{"name":"--navy","resolved":"#0a1729"}]}\n',
      // The kit names a font file the index does not: it publishes beside the logos so a consumer can download the face.
      "dist/design-system/brand.json": JSON.stringify({ schemaVersion: 1, roles: { "font.body": { token: "--font-body", value: "Newsreader, serif", kind: "font-family", source: "convention", family: "Newsreader", files: [{ url: "/design-system/fonts/newsreader.woff2", format: "woff2", weight: "400", style: "normal" }] } }, logos: [{ name: "Mark", role: "logo", media: { url: "/design-system/photos/elder-hands.webp" } }], imagery: [] }),
      "dist/design-system/fonts/newsreader.woff2": "woff2-bytes",
      "dist/design-system/formats.json": JSON.stringify({ schemaVersion: 1, url: "/design-system/formats.json", count: 1, groups: [{ id: "print", unit: "in", formats: [{ id: "card", name: "Card", width: 3.5, height: 2, unit: "in", safe: 0.125, page: "social/video-assets", pageUrl: "/design-system/social/video-assets/index.md" }] }] }),
      "dist/design-system/llms.txt": "Machine-readable index: /design-system/index.json\nFull text: /design-system/llms-full.txt\nDesign tokens: /design-system/tokens.json\nBrand kit: /design-system/brand.json\nAsset formats: /design-system/formats.json\nWebsite designs: /design-system/designs.json — whole pages.\n\n## Fonts\n\n- Body (`font.body`): **Newsreader** — CSS `Newsreader, serif`\n  - 400 normal woff2: /design-system/fonts/newsreader.woff2\n\n## Logos\n\n- Mark (svg): /design-system/photos/elder-hands.webp\n\n- [Video assets](/design-system/social/video-assets/index.md)\n",
      "dist/design-system/llms-full.txt": "# Client System\n\n---\n\n# Video assets\n\n<!-- source: /design-system/social/video-assets · id: social/video-assets -->\n\nSee [photos](/design-system/photos/elder-hands.webp).\n",
      // The consumer bundle: check copied the files under their source paths and recorded their digests.
      "dist/design-system/bundle.json": JSON.stringify({ schemaVersion: 1, system: { id: "client/system", name: "Client System", version: "1.2.3" }, url: "/design-system/bundle.json", directory: "/design-system/bundle", base: null, versioned: null, fileCount: 2, bytes: 14, files: [
        { path: "src/styles/ds/brand.css", url: "/design-system/bundle/src/styles/ds/brand.css", bytes: 8, sha256: createHash("sha256").update(".brand{}").digest("hex") },
        { path: "public/ds.js", url: "/design-system/bundle/public/ds.js", bytes: 6, sha256: createHash("sha256").update("// ds;").digest("hex") },
      ] }),
      "dist/design-system/bundle/src/styles/ds/brand.css": ".brand{}",
      "dist/design-system/bundle/public/ds.js": "// ds;",
      // The website designs carry their HTML and name the stylesheet they load, which publishes beside them.
      "dist/design-system/designs.json": JSON.stringify({ schemaVersion: 1, base: null, designs: [{ id: "site", pages: [{ route: "/", states: [{ name: "default", html: "<link rel=\"stylesheet\" href=\"/design-system/styles/site.css\">", references: ["/design-system/styles/site.css"] }] }] }] }),
      "dist/design-system/styles/site.css": ".wrap{}",
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
      if (String(url) === "https://cdn.example.com/clients/c/design-systems/s/artifact/v/1.2.3/bundle.json") {
        const published = puts.get("v/1.2.3/bundle.json");
        return new Response(published ?? "missing", { status: published ? 200 : 404 });
      }
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
    assert.equal(published.llmsUrl, "https://cdn.example.com/clients/c/design-systems/s/artifact/design-system/llms.txt");
    assert.equal(published.tokensUrl, "https://cdn.example.com/clients/c/design-systems/s/artifact/design-system/tokens.json");
    assert.equal(published.brandUrl, "https://cdn.example.com/clients/c/design-systems/s/artifact/design-system/brand.json");
    assert.equal(published.designsUrl, "https://cdn.example.com/clients/c/design-systems/s/artifact/design-system/designs.json");
    assert.equal(published.formatsUrl, "https://cdn.example.com/clients/c/design-systems/s/artifact/design-system/formats.json");
    assert.equal(published.llmsFullUrl, "https://cdn.example.com/clients/c/design-systems/s/artifact/design-system/llms-full.txt");
    assert.equal(published.bundleUrl, "https://cdn.example.com/clients/c/design-systems/s/artifact/design-system/bundle.json");
    assert.equal(published.bundleVersionedUrl, "https://cdn.example.com/clients/c/design-systems/s/artifact/v/1.2.3/bundle");
    assert.equal(published.bundleFiles, 2);
    assert.equal(published.docCount, 1);
    assert.equal(published.uploaded, 17);
    assert.equal(published.skipped, 1);
    assert.equal(published.total, 18);

    assert.equal(sessions.length, 2);
    // Index assets, then the kit's font files, then design references, then the
    // bundle under its current and immutable versioned prefixes, then the page mirrors.
    assert.deepEqual(sessions[0].files.map((file) => file.path), [
      "design-system/photos/elder-hands.webp",
      "design-system/fonts/newsreader.woff2",
      "design-system/styles/site.css",
      "design-system/bundle/src/styles/ds/brand.css",
      "v/1.2.3/bundle/src/styles/ds/brand.css",
      "design-system/bundle/public/ds.js",
      "v/1.2.3/bundle/public/ds.js",
      "design-system/social/video-assets/index.md",
    ]);
    const bundleUploads = sessions[0].files.filter((file) => file.path.endsWith("brand.css"));
    assert.equal(bundleUploads[0].sha256, bundleUploads[1].sha256, "both copies are the same bytes");
    assert.equal(bundleUploads[0].contentType, "text/css");
    assert.equal(sessions[0].systemId, "client/system");
    assert.equal(sessions[0].version, "1.2.3");
    assert.deepEqual(sessions[1].files.map((file) => file.path).sort(), [
      ".timds-artifact.json",
      "design-system/brand.json",
      "design-system/bundle.json",
      "design-system/designs.json",
      "design-system/formats.json",
      "design-system/index.json",
      "design-system/llms-full.txt",
      "design-system/llms.txt",
      "design-system/tokens.json",
      "v/1.2.3/bundle.json",
    ]);
    // The current bundle manifest names the versioned copy; the versioned manifest points its files at itself.
    const currentBundle = JSON.parse(puts.get("design-system/bundle.json"));
    assert.equal(currentBundle.base, "https://cdn.example.com/clients/c/design-systems/s/artifact");
    assert.equal(currentBundle.directory, "https://cdn.example.com/clients/c/design-systems/s/artifact/design-system/bundle");
    assert.equal(currentBundle.versioned, "https://cdn.example.com/clients/c/design-systems/s/artifact/v/1.2.3/bundle");
    assert.equal(currentBundle.files[0].url, "https://cdn.example.com/clients/c/design-systems/s/artifact/design-system/bundle/src/styles/ds/brand.css");
    const versionedBundle = JSON.parse(puts.get("v/1.2.3/bundle.json"));
    assert.equal(versionedBundle.url, "https://cdn.example.com/clients/c/design-systems/s/artifact/v/1.2.3/bundle.json");
    assert.equal(versionedBundle.directory, versionedBundle.versioned);
    assert.equal(versionedBundle.files[1].url, "https://cdn.example.com/clients/c/design-systems/s/artifact/v/1.2.3/bundle/public/ds.js");
    assert.deepEqual(versionedBundle.files.map((file) => file.path), currentBundle.files.map((file) => file.path));
    assert.deepEqual(versionedBundle.designs, [{ id: "site", routes: ["/"] }], "a named pin carries its own pairing catalog");
    assert.deepEqual(currentBundle.designs, versionedBundle.designs);
    // Font files resolve on the CDN with their integrity, like logos.
    const kitFont = JSON.parse(puts.get("design-system/brand.json")).roles["font.body"].files[0];
    assert.equal(kitFont.url, "https://cdn.example.com/clients/c/design-systems/s/artifact/design-system/fonts/newsreader.woff2");
    assert.match(kitFont.sha256, /^[a-f0-9]{64}$/);
    assert.equal(kitFont.weight, "400");
    // The format catalog's page links and its own URL resolve on the CDN.
    const formats = JSON.parse(puts.get("design-system/formats.json"));
    assert.equal(formats.url, "https://cdn.example.com/clients/c/design-systems/s/artifact/design-system/formats.json");
    assert.equal(formats.groups[0].formats[0].pageUrl, "https://cdn.example.com/clients/c/design-systems/s/artifact/design-system/social/video-assets/index.md");
    // llms-full.txt rewrites its links and source comments the way llms.txt does.
    const llmsFull = puts.get("design-system/llms-full.txt");
    assert.ok(llmsFull.includes("<!-- source: https://cdn.example.com/clients/c/design-systems/s/artifact/design-system/social/video-assets · id: social/video-assets -->"));
    assert.ok(llmsFull.includes("[photos](https://cdn.example.com/clients/c/design-systems/s/artifact/design-system/photos/elder-hands.webp)"));
    // Designs publish as written, plus the base their site-absolute references resolve against.
    const designs = JSON.parse(puts.get("design-system/designs.json"));
    assert.equal(designs.base, "https://cdn.example.com/clients/c/design-systems/s/artifact");
    assert.equal(designs.designs[0].pages[0].states[0].references[0], "/design-system/styles/site.css");
    // Kit media resolve on the CDN exactly like index assets, with the uploaded file's integrity.
    const kit = JSON.parse(puts.get("design-system/brand.json"));
    assert.equal(kit.logos[0].media.url, "https://cdn.example.com/clients/c/design-systems/s/artifact/design-system/photos/elder-hands.webp");
    assert.match(kit.logos[0].media.sha256, /^[a-f0-9]{64}$/);
    // Tokens carry resolved CSS values and no local references, so they publish verbatim.
    assert.equal(puts.get("design-system/tokens.json"), artifact["dist/design-system/tokens.json"]);

    // Page mirrors upload verbatim; llms.txt links resolve on the CDN.
    assert.equal(puts.get("design-system/social/video-assets/index.md"), "# Video assets\n");
    const llms = puts.get("design-system/llms.txt");
    assert.match(llms, /Machine-readable index: https:\/\/cdn\.example\.com\/clients\/c\/design-systems\/s\/artifact\/design-system\/index\.json/);
    assert.match(llms, /Design tokens: https:\/\/cdn\.example\.com\/clients\/c\/design-systems\/s\/artifact\/design-system\/tokens\.json/);
    assert.match(llms, /Brand kit: https:\/\/cdn\.example\.com\/clients\/c\/design-systems\/s\/artifact\/design-system\/brand\.json/);
    assert.match(llms, /Website designs: https:\/\/cdn\.example\.com\/clients\/c\/design-systems\/s\/artifact\/design-system\/designs\.json/);
    assert.match(llms, /^Full text: https:\/\/cdn\.example\.com\/clients\/c\/design-systems\/s\/artifact\/design-system\/llms-full\.txt$/m);
    assert.match(llms, /^Asset formats: https:\/\/cdn\.example\.com\/clients\/c\/design-systems\/s\/artifact\/design-system\/formats\.json$/m);
    // The essentials' font and logo file lines resolve too.
    assert.match(llms, /^  - 400 normal woff2: https:\/\/cdn\.example\.com\/clients\/c\/design-systems\/s\/artifact\/design-system\/fonts\/newsreader\.woff2$/m);
    assert.match(llms, /^- Mark \(svg\): https:\/\/cdn\.example\.com\/clients\/c\/design-systems\/s\/artifact\/design-system\/photos\/elder-hands\.webp$/m);
    assert.doesNotMatch(llms, /\]\(\//);
    assert.doesNotMatch(llms, /: \/design-system/);

    const uploadedIndex = JSON.parse(puts.get("design-system/index.json"));
    assert.equal(
      uploadedIndex.pages[0].blocks[0].assets[0].media.url,
      "https://cdn.example.com/clients/c/design-systems/s/artifact/design-system/photos/elder-hands.webp"
    );
    assert.match(uploadedIndex.pages[0].blocks[0].assets[0].media.sha256, /^[a-f0-9]{64}$/);
    // The stamp is all a remote consumer needs: version, commit, and where each derived file sits.
    const stamp = JSON.parse(puts.get(".timds-artifact.json"));
    assert.deepEqual(stamp, {
      schemaVersion: 1,
      sourceCommit: "a".repeat(40),
      version: "1.2.3",
      systemId: "client/system",
      entry: "design-system/index.html",
      files: { index: "design-system/index.json", tokens: "design-system/tokens.json", brand: "design-system/brand.json", llms: "design-system/llms.txt", llmsFull: "design-system/llms-full.txt", formats: "design-system/formats.json", designs: "design-system/designs.json", bundle: "design-system/bundle.json" },
    });
    // A former catalog may remain on disk, but a release that does not
    // advertise it must not publish it again, even if that file is invalid.
    await fs.writeFile(path.join(designSystemRoot, "dist/design-system/index.json"), JSON.stringify(INDEX));
    await fs.writeFile(path.join(designSystemRoot, "dist/design-system/formats.json"), "{obsolete");
    const withoutFormats = await publishExtractedIndex(workspace, { token: "timds_test_token", fetchImpl, sourceCommit: "a".repeat(40) });
    assert.equal(withoutFormats.formatsUrl, null);
    assert.ok(!sessions.at(-1).files.some((file) => file.path.endsWith("formats.json")));

    // The bundle stamp must match the release, independently of the index.
    const sourceBundle = JSON.parse(artifact["dist/design-system/bundle.json"]);
    await fs.writeFile(path.join(designSystemRoot, "dist/design-system/bundle.json"), JSON.stringify({ ...sourceBundle, system: { ...sourceBundle.system, version: "1.0.0" } }));
    await assert.rejects(publishExtractedIndex(workspace, { token: "timds_test_token", fetchImpl }), /Artifact bundle is stamped.*1\.0\.0.*rebuild before publishing/);

    // Changing source bytes under an existing version must fail before any
    // current or versioned file is uploaded, even when the local digests agree.
    const changedBody = ".brand{color:red}";
    const changedBundle = structuredClone(sourceBundle);
    changedBundle.files[0].sha256 = createHash("sha256").update(changedBody).digest("hex");
    changedBundle.files[0].bytes = Buffer.byteLength(changedBody);
    await fs.writeFile(path.join(designSystemRoot, "dist/design-system/bundle.json"), JSON.stringify(changedBundle));
    await fs.writeFile(path.join(designSystemRoot, "dist/design-system/bundle/src/styles/ds/brand.css"), changedBody);
    const before = [...puts.entries()];
    await assert.rejects(publishExtractedIndex(workspace, { token: "timds_test_token", fetchImpl }), /version 1\.2\.3 already has a different published bundle.*immutable/);
    assert.deepEqual([...puts.entries()], before, "an immutable conflict never uploads changed bytes");

    // Older manifests can gain the new pairing summary without changing any
    // existing file digest. Unchanged releases remain repeatable.
    await fs.writeFile(path.join(designSystemRoot, "dist/design-system/bundle.json"), JSON.stringify(sourceBundle));
    await fs.writeFile(path.join(designSystemRoot, "dist/design-system/bundle/src/styles/ds/brand.css"), ".brand{}");
    const legacy = JSON.parse(puts.get("v/1.2.3/bundle.json"));
    delete legacy.designs;
    puts.set("v/1.2.3/bundle.json", JSON.stringify(legacy));
    await publishExtractedIndex(workspace, { token: "timds_test_token", fetchImpl });
    assert.deepEqual(JSON.parse(puts.get("v/1.2.3/bundle.json")).designs, [{ id: "site", routes: ["/"] }]);
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

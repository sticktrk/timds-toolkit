import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildBundle,
  bundleDocument,
  bundleManifestPublishPaths,
  bundleOutputDirectory,
  bundlePublishPaths,
  collectBundleFiles,
  describeBundle,
  globToRegExp,
  matchesPattern,
  normalizeBundleConfig,
  rewriteBundleForPublish,
} from "./bundle.mjs";

const MANIFEST = { systemId: "client/system", name: "Client", version: "2.0.0", artifact: { entry: "design-system/index.html" } };

async function fixture(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "timds-bundle-"));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, ...relative.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return root;
}

test("validates the manifest's bundle globs", () => {
  assert.equal(normalizeBundleConfig(undefined), null);
  assert.equal(normalizeBundleConfig(false), null);
  assert.deepEqual(normalizeBundleConfig({ include: [" src/styles/ds/** ", "./public/ds.js", "public/design-system/"] }), {
    include: ["src/styles/ds/**", "public/ds.js", "public/design-system"],
    exclude: [],
  });
  assert.deepEqual(normalizeBundleConfig({ include: ["a"], exclude: ["a/b/**"] }).exclude, ["a/b/**"]);
  assert.throws(() => normalizeBundleConfig([]), /must be an object with an include list/);
  assert.throws(() => normalizeBundleConfig({}), /bundle\.include must name at least one file or glob/);
  assert.throws(() => normalizeBundleConfig({ include: "src" }), /bundle\.include must be an array/);
  assert.throws(() => normalizeBundleConfig({ include: ["/etc/passwd"] }), /must be relative to the Design System root/);
  assert.throws(() => normalizeBundleConfig({ include: ["../other/**"] }), /no \. or \.\. segments/);
  assert.throws(() => normalizeBundleConfig({ include: ["src//x"] }), /no \. or \.\. segments/);
  assert.throws(() => normalizeBundleConfig({ include: [""] }), /must be a relative path or glob/);
});

test("matches globs with **, *, and ?, and plain paths as files or directories", () => {
  assert.ok(globToRegExp("src/styles/ds/**").test("src/styles/ds/brand.css"));
  assert.ok(globToRegExp("src/styles/ds/**").test("src/styles/ds/deep/er/print.css"));
  assert.ok(!globToRegExp("src/styles/ds/**").test("src/styles/dsx/brand.css"));
  assert.ok(globToRegExp("src/**/*.css").test("src/a.css"));
  assert.ok(globToRegExp("src/**/*.css").test("src/x/y/a.css"));
  assert.ok(!globToRegExp("src/*.css").test("src/x/a.css"));
  assert.ok(globToRegExp("public/logo-?.svg").test("public/logo-a.svg"));
  assert.ok(!globToRegExp("public/logo-?.svg").test("public/logo-ab.svg"));
  assert.ok(globToRegExp("public/*.(svg)").test("public/x.(svg)"), "regex characters in a segment are literal");
  assert.ok(matchesPattern("public/design-system/fonts/a.woff2", "public/design-system"));
  assert.ok(matchesPattern("public/ds.js", "public/ds.js"));
  assert.ok(!matchesPattern("public/ds.js.map", "public/ds.js"));
  assert.ok(!matchesPattern("public/design-systems/x", "public/design-system"));
});

test("collects matched files from the root, enters dist only when asked, skips links, and refuses a dead pattern", async (t) => {
  const root = await fixture(t, {
    "src/styles/ds/brand.css": ".a{}",
    "src/styles/ds/print.css": "@page{}",
    "src/styles/viewer.css": ".v{}",
    "public/ds.js": "// js",
    "public/design-system/logo.svg": "<svg/>",
    "public/design-system/photos/.gitkeep": "",
    "public/design-system/brand/huge.psd": "psd",
    "dist/tokens.css": ":root{}",
    "dist/design-system/bundle/src/styles/ds/brand.css": "stale copy",
    "dist/design-system/bundle.json": "{}",
    "node_modules/pkg/index.css": ".n{}",
    "media-local/photo.jpg": "jpg",
    ".git/config": "",
  });
  await fs.symlink(path.join(root, "src/styles/ds/brand.css"), path.join(root, "src/styles/ds/link.css"));

  const config = normalizeBundleConfig({ include: ["src/styles/ds/**", "public/**"], exclude: ["public/design-system/brand/**"] });
  const { files, skipped, empty } = await collectBundleFiles(root, config, { outputDirectory: "design-system/bundle" });
  assert.deepEqual(files.map((file) => file.path), ["public/design-system/logo.svg", "public/ds.js", "src/styles/ds/brand.css", "src/styles/ds/print.css"]);
  assert.deepEqual(skipped, ["src/styles/ds/link.css"]);
  assert.deepEqual(empty, ["public/design-system/photos/.gitkeep"], "a placeholder file matches the glob but is never bundled");
  assert.match(files[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(files[1].bytes, 5);

  // A pattern under dist/ enters the build output, but never the bundle's own output.
  const withDist = await collectBundleFiles(root, normalizeBundleConfig({ include: ["dist/**/*.css"] }), { outputDirectory: "design-system/bundle" });
  assert.deepEqual(withDist.files.map((file) => file.path), ["dist/tokens.css"]);
  // Globs that would reach node_modules, local media, or an unrequested dist never do.
  const everything = await collectBundleFiles(root, normalizeBundleConfig({ include: ["**/*.css"] }), { outputDirectory: "design-system/bundle" });
  assert.deepEqual(everything.files.map((file) => file.path), ["src/styles/ds/brand.css", "src/styles/ds/print.css", "src/styles/viewer.css"]);
  await assert.rejects(collectBundleFiles(root, normalizeBundleConfig({ include: ["**/*.jpg"] })), /matches no file for "\*\*\/\*\.jpg"/, "local media is never bundled");
  await assert.rejects(collectBundleFiles(root, normalizeBundleConfig({ include: ["src/styles/ds/**", "src/nope/**"] })), /matches no file for "src\/nope\/\*\*"/);
});

test("builds the bundle into the artifact under source paths with a manifest, and removes a stale one", async (t) => {
  const root = await fixture(t, {
    "src/styles/ds/brand.css": ".a{}",
    "public/ds.js": "// js",
    "dist/design-system/index.html": "<h1>x</h1>",
    "dist/design-system/bundle/old/file.css": "stale",
    "dist/design-system/bundle.json": "{\"stale\":true}",
  });
  const manifest = { ...MANIFEST, bundle: normalizeBundleConfig({ include: ["src/styles/ds/**", "public/ds.js"] }) };
  const built = await buildBundle(root, { manifest });
  assert.equal(built.enabled, true);
  assert.equal(built.outputDirectory, "design-system/bundle");
  assert.equal(await fs.readFile(path.join(root, "dist/design-system/bundle/src/styles/ds/brand.css"), "utf8"), ".a{}");
  await assert.rejects(fs.access(path.join(root, "dist/design-system/bundle/old/file.css")), "the previous output is gone");
  const document = JSON.parse(await fs.readFile(path.join(root, "dist/design-system/bundle.json"), "utf8"));
  assert.deepEqual(document, built.document);
  assert.deepEqual([document.schemaVersion, document.system, document.url, document.directory, document.base, document.versioned, document.fileCount, document.bytes], [1, { id: "client/system", name: "Client", version: "2.0.0" }, "/design-system/bundle.json", "/design-system/bundle", null, null, 2, 9]);
  assert.deepEqual(document.files.map((file) => [file.path, file.url]), [
    ["public/ds.js", "/design-system/bundle/public/ds.js"],
    ["src/styles/ds/brand.css", "/design-system/bundle/src/styles/ds/brand.css"],
  ]);
  // Building again from a manifest without a bundle leaves no trace of it.
  const none = await buildBundle(root, { manifest: { ...MANIFEST, bundle: null } });
  assert.deepEqual([none.enabled, none.document], [false, null]);
  await assert.rejects(fs.access(path.join(root, "dist/design-system/bundle.json")));
  await assert.rejects(fs.access(path.join(root, "dist/design-system/bundle")));
  // A root-level entry keeps the bundle beside index.html.
  assert.equal(bundleOutputDirectory("index.html"), "bundle");
  assert.equal(bundleOutputDirectory(), "bundle");
});

test("publishing rewrites the manifest to the CDN and names the immutable versioned copy", () => {
  const document = bundleDocument([{ path: "src/a.css", bytes: 1, sha256: "x" }], MANIFEST, { basePrefix: "/design-system" });
  const current = rewriteBundleForPublish(document, { publicBase: "https://cdn.example.com/s/artifact/", entryDirectory: "design-system", version: "2.0.0" });
  assert.deepEqual([current.url, current.directory, current.base, current.versioned, current.files[0].url], [
    "https://cdn.example.com/s/artifact/design-system/bundle.json",
    "https://cdn.example.com/s/artifact/design-system/bundle",
    "https://cdn.example.com/s/artifact",
    "https://cdn.example.com/s/artifact/v/2.0.0/bundle",
    "https://cdn.example.com/s/artifact/design-system/bundle/src/a.css",
  ]);
  const versioned = rewriteBundleForPublish(document, { publicBase: "https://cdn.example.com/s/artifact", entryDirectory: ".", version: "2.0.0", versioned: true });
  assert.deepEqual([versioned.url, versioned.directory, versioned.files[0].url], [
    "https://cdn.example.com/s/artifact/v/2.0.0/bundle.json",
    "https://cdn.example.com/s/artifact/v/2.0.0/bundle",
    "https://cdn.example.com/s/artifact/v/2.0.0/bundle/src/a.css",
  ]);
  assert.equal(document.base, null, "the local document is not mutated");
  assert.deepEqual(bundlePublishPaths("src/a.css", { entryDirectory: "design-system", version: "2.0.0" }), { current: "design-system/bundle/src/a.css", versioned: "v/2.0.0/bundle/src/a.css" });
  assert.deepEqual(bundlePublishPaths("src/a.css", { entryDirectory: ".", version: "2.0.0" }), { current: "bundle/src/a.css", versioned: "v/2.0.0/bundle/src/a.css" });
  assert.deepEqual(bundleManifestPublishPaths({ entryDirectory: "design-system", version: "2.0.0" }), { current: "design-system/bundle.json", versioned: "v/2.0.0/bundle.json" });
  assert.equal(describeBundle(document), "Consumer bundle: 1 file, 0.0 KB");
  assert.equal(describeBundle({ fileCount: 12, bytes: 9_400_000 }), "Consumer bundle: 12 files, 9.4 MB");
  assert.equal(describeBundle(null), "Consumer bundle: not configured (add bundle.include to timds.json)");
});

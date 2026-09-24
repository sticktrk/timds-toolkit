import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { derivedFilePath, derivedLayerPaths, describeBrandKit, fetchDerivedLayer, readDerivedLayer, summarizeBrandKit } from "./derived.mjs";

const KIT = {
  schemaVersion: 1,
  system: { id: "client/system", name: "Client", version: "2.0.0" },
  roles: { "color.accent": { token: "--accent", value: "#111", kind: "color", source: "convention" } },
  missingRoles: ["font.ui"],
  logos: [{ id: "a", name: "White logo", role: "logo", primary: true, media: { url: "/logo.svg" } }],
  imagery: [],
  guidance: { voice: { source: "convention", blocks: [] } },
};

test("derived file paths follow the artifact entry directory", () => {
  assert.deepEqual(derivedLayerPaths("design-system/index.html"), {
    index: "design-system/index.json", tokens: "design-system/tokens.json", brand: "design-system/brand.json", llms: "design-system/llms.txt",
  });
  assert.deepEqual(derivedLayerPaths(), { index: "index.json", tokens: "tokens.json", brand: "brand.json", llms: "llms.txt" });
  assert.equal(derivedFilePath("/ds", { artifact: { entry: "design-system/index.html" } }, "brand"), "/ds/dist/design-system/brand.json");
  assert.throws(() => derivedFilePath("/ds", {}, "nope"), /unknown derived file/);
});

test("reads the local derived layer, tolerating files check has not written and flagging a stale version", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "timds-derived-"));
  try {
    const manifest = { systemId: "client/system", name: "Client", version: "2.0.0", artifact: { entry: "design-system/index.html" } };
    const empty = await readDerivedLayer(root, manifest);
    assert.equal(empty.derived, false);
    assert.equal(empty.stale, false);
    assert.deepEqual([empty.index, empty.tokens, empty.brand, empty.llms], [null, null, null, null]);
    assert.deepEqual(empty.source, { kind: "local", root, artifactRoot: path.join(root, "dist") });

    await fs.mkdir(path.join(root, "dist", "design-system"), { recursive: true });
    await fs.writeFile(path.join(root, "dist", "design-system", "brand.json"), JSON.stringify(KIT));
    await fs.writeFile(path.join(root, "dist", "design-system", "llms.txt"), "# Client\n");
    const partial = await readDerivedLayer(root, manifest);
    assert.equal(partial.derived, true);
    assert.equal(partial.stale, false);
    assert.equal(partial.brand.logos[0].name, "White logo");
    assert.equal(partial.llms, "# Client\n");
    assert.equal(partial.tokens, null);

    const stale = await readDerivedLayer(root, { ...manifest, version: "2.1.0" });
    assert.equal(stale.stale, true);

    await fs.writeFile(path.join(root, "dist", "design-system", "tokens.json"), "{not json");
    await assert.rejects(readDerivedLayer(root, manifest), /tokens\.json is not valid/);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("fetches the published derived layer from the provenance stamp alone", async () => {
  const served = {
    ".timds-artifact.json": JSON.stringify({ schemaVersion: 1, sourceCommit: "a".repeat(40), version: "2.0.0", systemId: "client/system", entry: "design-system/index.html", files: derivedLayerPaths("design-system/index.html") }),
    "design-system/index.json": JSON.stringify({ schemaVersion: 1, system: KIT.system, pageCount: 0, pages: [] }),
    "design-system/brand.json": JSON.stringify(KIT),
    "design-system/llms.txt": "# Client\n",
  };
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    const relative = url.replace("https://cdn.example.com/artifact/", "");
    const body = served[relative];
    return body === undefined
      ? new Response("missing", { status: 404 })
      : new Response(body, { status: 200, headers: { "Content-Type": relative.endsWith(".txt") ? "text/plain" : "application/json" } });
  };
  const layer = await fetchDerivedLayer("https://cdn.example.com/artifact/", { fetchImpl });
  assert.deepEqual(layer.source, { kind: "published", base: "https://cdn.example.com/artifact" });
  assert.deepEqual(layer.system, KIT.system);
  assert.equal(layer.provenance.sourceCommit, "a".repeat(40));
  assert.equal(layer.brand.roles["color.accent"].value, "#111");
  assert.equal(layer.tokens, null); // not published: null, exactly as locally
  assert.equal(layer.llms, "# Client\n");
  assert.equal(requested[0], "https://cdn.example.com/artifact/.timds-artifact.json");

  // An older stamp without file pointers still resolves from its entry.
  const legacy = { ...served, ".timds-artifact.json": JSON.stringify({ schemaVersion: 1, sourceCommit: "b".repeat(40), version: "2.0.0", entry: "design-system/index.html" }) };
  const legacyLayer = await fetchDerivedLayer("https://cdn.example.com/artifact", { fetchImpl: async (url) => new Response(legacy[url.replace("https://cdn.example.com/artifact/", "")] ?? "x", { status: legacy[url.replace("https://cdn.example.com/artifact/", "")] ? 200 : 404 }) });
  assert.equal(legacyLayer.brand.system.version, "2.0.0");

  await assert.rejects(fetchDerivedLayer("https://cdn.example.com/nothing", { fetchImpl: async () => new Response("", { status: 404 }) }), /\.timds-artifact\.json responded 404/);
  await assert.rejects(fetchDerivedLayer("ftp://cdn"), /must be an HTTP or HTTPS URL/);
});

test("summarizes a kit for doctor in one line", () => {
  const summary = summarizeBrandKit(KIT);
  assert.deepEqual(summary, { version: "2.0.0", roles: { filled: 1, missing: ["font.ui"], total: 2 }, logos: 1, primaryLogo: "White logo", imagery: 0, guidance: ["voice"] });
  assert.equal(describeBrandKit(summary), "Brand kit: 1/2 roles (missing font.ui), 1 logo (primary: White logo), 0 imagery, guidance voice (derived for 2.0.0)");
  assert.equal(describeBrandKit(summarizeBrandKit(null)), "Brand kit: not derived; run timds check");
});

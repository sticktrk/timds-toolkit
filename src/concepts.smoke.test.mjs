import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { publishExtractedIndex } from "./artifact.mjs";
import { checkWorkspace, initializeRepository } from "./core.mjs";

const sampleConcept = fileURLToPath(new URL("../templates/starter/src/concepts/sample", import.meta.url));

// A custom (non-starter) workspace that already passes check, given the stock sample concept.
async function adoptSample(t, { entry = "index.html", machine, sample = true, before = async () => {} } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "timds-concept-adoption-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  const system = path.join(root, "design-system");
  const entryDirectory = path.posix.dirname(entry);
  const prefix = entryDirectory === "." ? "" : "/" + entryDirectory;
  await fs.mkdir(path.join(system, "dist", ...entry.split("/"), ".."), { recursive: true });
  await fs.mkdir(path.join(system, "dist", ...prefix.split("/").filter(Boolean), "assets"), { recursive: true });
  await fs.writeFile(path.join(system, "timds.json"), JSON.stringify({
    artifact: { entry }, name: "Adopting System", schemaVersion: 2, systemId: "test/adopting", version: "1.0.0", workspace: {},
    ...(machine === undefined ? {} : { machine }),
  }));
  await fs.writeFile(path.join(system, "tokens.json"), "{}");
  await fs.writeFile(path.join(system, "dist", ...entry.split("/")), `<link rel="stylesheet" href="${prefix}/assets/site.css"><main>Ready</main>`);
  await fs.writeFile(path.join(system, "dist", ...prefix.split("/").filter(Boolean), "assets", "site.css"), "body{color:#123}\n");
  await before(system);
  await checkWorkspace(root, { skipBuild: true });
  if (sample) await fs.cp(sampleConcept, path.join(system, "src/concepts/sample"), { recursive: true });
  return { root, system, prefix };
}

const localReferences = html => [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map(match => match[1]).filter(value => !/^(?:[a-z]+:|#)/i.test(value));

test("checking a concept publishes its pieces without changing the system's brand", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "timds-concept-check-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  await initializeRepository(root, { standalone: true });
  const read = relative => fs.readFile(path.join(root, relative), "utf8");
  const manifestPath = path.join(root, "src/concepts/sample/concept.json");
  const sample = JSON.parse(await fs.readFile(manifestPath));
  const domainFiles = () => Promise.all(["brand.json", "tokens.json"].map(file => read("dist/" + file)));
  await checkWorkspace(root);
  const before = await domainFiles();
  const published = JSON.parse(await read("dist/concepts.json"));
  const [concept] = published.concepts;
  assert.equal(concept.id, "sample");
  assert.equal(published.approved, null);
  const piece = concept.pieces[0];
  const bytes = await fs.readFile(path.join(root, "dist", piece.url));
  assert.equal(bytes.length, piece.bytes);
  assert.match(piece.sha256, /^[a-f0-9]{64}$/);
  assert.match(await read("dist/concepts/sample/index.html"), /<iframe[^>]*sandbox/);
  assert.match(await read("dist/concepts/sample/index.md"), /Field notes/);
  assert.match(await read("dist/llms.txt"), /Brand concepts: \/concepts\.json/);

  // A repeated check handles an edited proposal and the removal of its entire section.
  await fs.writeFile(manifestPath, JSON.stringify({ ...sample, status: "approved", decided: "2026-11-25" }));
  await checkWorkspace(root);
  assert.equal(JSON.parse(await read("dist/index.json")).concepts.approved, "sample");
  await fs.rm(path.join(root, "src/concepts"), { recursive: true });
  await checkWorkspace(root);
  assert.deepEqual(await domainFiles(), before);
  await assert.rejects(read("dist/concepts/sample/index.html"), { code: "ENOENT" });
});

test("the check command identifies the concept containing an invalid piece", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "timds-invalid-concept-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  await initializeRepository(root, { standalone: true });
  const manifest = path.join(root, "src/concepts/sample/concept.json");
  const sample = JSON.parse(await fs.readFile(manifest));
  await fs.writeFile(manifest, JSON.stringify({ ...sample, pieces: [{ kind: "website", file: "missing.html" }] }));
  const cli = fileURLToPath(new URL("../bin/timds.mjs", import.meta.url));
  assert.throws(() => execFileSync(process.execPath, [cli, "check", "--root", root], { stdio: "pipe" }),
    err => /src\/concepts\/sample.*missing\.html/.test(String(err.stderr)));
});

test("a system with machine output disabled adopts concepts without links to files it does not emit", async t => {
  const { root, system } = await adoptSample(t, { machine: false });
  await checkWorkspace(root, { skipBuild: true });
  for (const page of ["concepts/index.html", "concepts/sample/index.html"]) {
    assert.doesNotMatch(await fs.readFile(path.join(system, "dist", page), "utf8"), /llms(?:-full)?\.txt/, page);
  }
});

test("concept pages link back to a configured entry that is not an index", async t => {
  const { root, system } = await adoptSample(t, { entry: "guide/brand.html" });
  await checkWorkspace(root, { skipBuild: true });
  for (const page of ["guide/concepts/index.html", "guide/concepts/sample/index.html"]) {
    const html = await fs.readFile(path.join(system, "dist", page), "utf8");
    const header = html.match(/<header class="td-directory-bar">(.*?)<\/header>/s)[1];
    const targets = [...header.matchAll(/href="([^"]+)"/g)].map(match => new URL(match[1], `https://example.test/${page}`).pathname);
    assert.deepEqual(targets, ["/guide/brand.html", "/guide/brand.html"], page);
  }
});

test("published concept pages and mirrors navigate within a path-prefixed artifact", async t => {
  const { root, system } = await adoptSample(t, { entry: "design-system/index.html" });
  await checkWorkspace(root, { skipBuild: true });
  const publicBase = "https://cdn.example.com/clients/c/design-systems/s/artifact";
  const uploaded = new Map();
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith("/api/operator/design-system-artifacts/uploads")) {
      const { files } = JSON.parse(init.body);
      return Response.json({ publicBase, uploads: files.map(file => ({ method: "single", path: file.path, url: `https://upload.example.com/${file.path}` })) });
    }
    if (String(url).startsWith("https://upload.example.com/")) {
      uploaded.set(String(url).slice("https://upload.example.com/".length), Buffer.from(init.body).toString("utf8"));
      return new Response(null, { status: 200 });
    }
    return new Response("missing", { status: 404 });
  };
  const workspace = { designSystemRoot: system, manifest: { artifact: { entry: "design-system/index.html" }, media: { portalUrl: "https://portal.example.com" }, systemId: "test/adopting", version: "1.0.0" }, parentRecord: null };
  await publishExtractedIndex(workspace, { fetchImpl, sourceCommit: "a".repeat(40), token: "timds_test_token" });
  const follow = (page, references) => references.map(reference => {
    const resolved = new URL(reference, `${publicBase}/${page}`).href;
    assert.ok(resolved.startsWith(publicBase + "/"), `${page} -> ${reference} leaves the artifact (${resolved})`);
    return resolved.slice(publicBase.length + 1);
  });
  // Every page, piece and stylesheet a published concept page loads or links within its section was published.
  for (const page of ["design-system/concepts/index.html", "design-system/concepts/sample/index.html"]) {
    assert.ok(uploaded.has(page), page);
    for (const key of follow(page, localReferences(uploaded.get(page)))) {
      if (key === "design-system/index.html") continue; // the viewer entry, served with the artifact rather than by this publication
      const file = key.endsWith("/") ? key + "index.html" : key;
      assert.ok(uploaded.has(decodeURIComponent(file)), `${page} links ${key}, which was not published`);
    }
  }
  const mirror = "design-system/concepts/sample/index.md";
  const links = [...uploaded.get(mirror).matchAll(/\]\(([^)]+)\)/g)].map(match => match[1]);
  assert.ok(links.length);
  for (const key of follow(mirror, links)) assert.ok(uploaded.has(decodeURIComponent(key)), `${mirror} links ${key}, which was not published`);
});

test("a system without concepts keeps its own concepts route in the artifact and the machine layer", async t => {
  const own = "<main><h1>Our concepts</h1><section><h2>Sketches</h2><p>How we sketch.</p></section></main>";
  const { root, system } = await adoptSample(t, { sample: false, before: async system => {
    await fs.mkdir(path.join(system, "dist/concepts"), { recursive: true });
    await fs.writeFile(path.join(system, "dist/concepts/index.html"), own);
  } });
  await checkWorkspace(root, { skipBuild: true });
  assert.equal(await fs.readFile(path.join(system, "dist/concepts/index.html"), "utf8"), own);
  assert.ok(JSON.parse(await fs.readFile(path.join(system, "dist/index.json"), "utf8")).pages.some(page => page.id === "concepts"));
  assert.match(await fs.readFile(path.join(system, "dist/llms.txt"), "utf8"), /Our concepts/);
  await assert.rejects(fs.access(path.join(system, "dist/concepts.json")), { code: "ENOENT" });
});

test("a starter view labelled Concepts is flagged only while the viewer shows a Concepts tab", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "timds-concept-label-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  await initializeRepository(root, { standalone: true });
  const sitePath = path.join(root, "src/site.json");
  const site = JSON.parse(await fs.readFile(sitePath, "utf8"));
  site.views[1].label = "Concepts";
  await fs.writeFile(sitePath, JSON.stringify(site, null, 2));
  const twoTabs = result => result.machine.warnings.filter(warning => /two "Concepts" tabs/.test(warning));
  assert.equal(twoTabs(await checkWorkspace(root)).length, 1);
  await fs.rm(path.join(root, "src/concepts"), { recursive: true });
  assert.deepEqual(twoTabs(await checkWorkspace(root)), []);
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkWorkspace, initializeRepository } from "./core.mjs";

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

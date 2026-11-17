import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/timds.mjs", import.meta.url));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("a workspace site's consumer check accepts an unversioned sibling at an exact host label and verifies its pin and bytes", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "timds-emdash-unversioned-sibling-"));
  t.after(() => fs.rm(directory, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 }));
  const root = await fs.realpath(directory);
  const environment = { ...process.env };
  delete environment.TIMDS_SITE_INPUTS;
  const timds = (...args) => execFileSync(process.execPath, [cli, ...args], { cwd: root, env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const write = async (relative, value) => {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  timds("init", "--standalone", "--root", root, "--name", "Sibling smoke", "--system-id", "timds-example/main");
  timds("consumer", "scaffold", "emdash", "--workspace", "--root", root, "--skip-install");

  const systemId = "timds-example/sibling";
  const version = "release-2026.11.17_1";
  const division = { id: "studio", prefix: "/studio/", system: "sibling", design: "website", pages: "src/divisions/studio/pages", layout: "src/layouts/Studio.astro", collections: [] };
  const declaration = { schemaVersion: 1, systems: { main: { workspace: true }, sibling: { systemId, version } }, divisions: [division] };
  await write("site/divisions.json", declaration);
  await write(`site/${division.pages}/index.html`, '<h1 class="sibling-heading">Studio</h1>');
  await write(`site/${division.layout}`, '<html><head><slot name="head" /></head><body><slot /></body></html>');

  const files = {
    "bundle.json": JSON.stringify({ schemaVersion: 1, system: { id: systemId, name: "Sibling" } }),
    "designs.json": JSON.stringify({ schemaVersion: 1, system: { id: systemId, name: "Sibling" }, designs: [{ id: "website", url: "/designs/website/", pages: [{ route: "/", states: [{ name: "default", html: '<link rel="stylesheet" href="/styles/brand.css"><h1 class="sibling-heading">Reference</h1>' }] }] }] }),
    "files/styles/brand.css": ".sibling-heading { color: inherit; }",
  };
  const stage = async ({ receiptVersion = version } = {}) => {
    for (const [file, bytes] of Object.entries(files)) await write(`site/.timds-site-inputs/sibling/${file}`, bytes);
    await write("site/.timds-site-inputs/receipt.json", { schemaVersion: 1, dependencies: [{
      alias: "sibling", sourceId: "11111111-1111-4111-8111-111111111111", systemId,
      version: receiptVersion, commit: "b".repeat(40), contentDigest: "a".repeat(64), manifestDigest: "c".repeat(64),
      files: Object.entries(files).map(([file, bytes]) => ({ path: file, size: Buffer.byteLength(bytes), sha256: sha256(bytes) })),
    }] });
  };
  const check = () => {
    const result = spawnSync(process.execPath, [cli, "consumer", "check", "--root", path.join(root, "site"), "--no-fix", "--json"], { cwd: root, env: environment, encoding: "utf8" });
    assert.ok(result.stdout, result.stderr);
    return JSON.parse(result.stdout);
  };
  await stage();
  const accepted = check();
  assert.equal(accepted.status, "passed", accepted.errors.join("\n"));

  // A label belongs to the receipt; a document declaring a different one
  // is refused even when its bytes and receipt digests agree.
  for (const file of ["bundle.json", "designs.json"]) {
    const document = JSON.parse(files[file]);
    files[file] = JSON.stringify({ ...document, system: { ...document.system, version: "another-release" } });
    await stage();
    assert.match(check().errors.join("\n"), /pins and digests/);
    files[file] = JSON.stringify(document);
  }

  await stage({ receiptVersion: "another-release" });
  assert.match(check().errors.join("\n"), /pins and digests/);
  await stage();
  await write("site/.timds-site-inputs/sibling/files/styles/brand.css", ".sibling-heading { color: red; }");
  assert.match(check().errors.join("\n"), /pins and digests/);

  for (const floating of ["current", "latest"]) {
    await write("site/divisions.json", { ...declaration, systems: { ...declaration.systems, sibling: { systemId, version: floating } } });
    assert.match(check().errors.join("\n"), /exact release labels/);
  }

  // SemVer build labels accepted by earlier templates remain usable.
  const semver = "1.2.3+build";
  await write("site/divisions.json", { ...declaration, systems: { ...declaration.systems, sibling: { systemId, version: semver } } });
  await stage({ receiptVersion: semver });
  const compatible = check();
  assert.equal(compatible.status, "passed", compatible.errors.join("\n"));
});

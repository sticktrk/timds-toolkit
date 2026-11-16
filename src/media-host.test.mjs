// Smoke coverage: `timds assets publish` and `extract --publish` in a hosted
// session go to the session's host, never the retired portal origin older
// scaffolds recorded in timds.json media.portalUrl.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { initializeRepository } from "./core.mjs";

const cli = fileURLToPath(new URL("../bin/timds.mjs", import.meta.url));
const run = (root, args, env) => promisify(execFile)(process.execPath, [cli, ...args, "--root", root], {
  cwd: root,
  env: { PATH: process.env.PATH, HOME: root, TIMDS_ACCESS_TOKEN: "timds_test_fixture", ...env },
});

test("a hosted session publishes media to its own host and refuses extract --publish", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "timds-media-host-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const requests = [];
  const host = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization, body: parsed });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ asset: { id: "asset_hosted", publicUrl: `https://media.example.test/${parsed.sha256}/${parsed.filename}` }, reused: true }));
  });
  await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { host.closeAllConnections(); host.close(resolve); }));
  const hostUrl = `http://127.0.0.1:${host.address().port}`;

  await initializeRepository(root, { standalone: true });
  const manifestPath = path.join(root, "timds.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert.equal(manifest.media, undefined, "fresh scaffolds no longer record a media host");
  // An older scaffold's record, kept in the system's source.
  manifest.media = { portalUrl: "https://timds.com" };
  manifest.provider = { kind: "hosted", url: hostUrl };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(path.join(root, ".timds", "session.json"), JSON.stringify({
    apiVersion: 1,
    provider: { kind: "hosted", url: hostUrl },
    session: { id: "session-media", systemId: manifest.systemId, baseRevision: "revision-1", status: "open" },
  }));
  await fs.writeFile(path.join(root, "hero.png"), Buffer.from("not really a png"));

  await run(root, ["assets", "add", "hero.png", "--key", "hero"]);
  const published = await run(root, ["assets", "publish"]);
  assert.match(published.stdout, /Media publication complete: 1 changed/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].path, "/api/operator/design-system-assets/uploads");
  assert.equal(requests[0].authorization, "Bearer timds_test_fixture");
  assert.equal(requests[0].body.systemId, manifest.systemId);
  const media = JSON.parse(await fs.readFile(path.join(root, "media.json"), "utf8"));
  assert.equal(media.assets.find((asset) => asset.key === "hero")?.id, "asset_hosted");

  await assert.rejects(run(root, ["extract", "--publish"]), (error) => /hosted session.*timds publish/.test(error.stderr));
  assert.equal(requests.length, 1, "extract --publish sends nothing from a hosted session");
});

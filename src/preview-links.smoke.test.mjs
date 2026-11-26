// Smoke: the commands an agent runs in a hosted session name the page it
// changed, on the local preview while one is running and on the hosted copy
// otherwise, and the submission Preview opens on that page too.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const cli = fileURLToPath(new URL("../bin/timds.mjs", import.meta.url));
const exec = promisify(execFile);
const liveUrl = "https://live.example.test/";
const frozenUrl = "https://review.example.test/";
const page = "src/designs/website/pages/about.html";
const route = "designs/website/about/";

async function snapshotFiles(root) {
  const files = [];
  async function walk(directory, prefix = "") {
    for (const name of await readdir(directory)) {
      if (["dist", "node_modules", "media-local", "video-local"].includes(name)) continue;
      const absolute = path.join(directory, name), relative = prefix ? `${prefix}/${name}` : name;
      if (relative === ".timds/session.json") continue;
      const info = await lstat(absolute);
      if (info.isDirectory()) await walk(absolute, relative);
      else files.push({ path: relative, encoding: "base64", content: (info.isSymbolicLink() ? Buffer.from(await readlink(absolute)) : await readFile(absolute)).toString("base64"), mode: info.isSymbolicLink() ? "120000" : info.mode & 0o111 ? "100755" : "100644" });
    }
  }
  await walk(root);
  return files;
}

test("hosted session commands link the changed design, on the local preview first", async (t) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "timds-preview-links-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const root = path.join(scratch, "session");
  // The local preview records live under the temporary directory: keep this run's apart.
  const temporary = path.join(scratch, "tmp");
  await mkdir(temporary);

  let snapshot;
  const host = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const sent = body ? JSON.parse(body) : null;
    if (/\/(?:update|submit)$/.test(request.url)) {
      const files = new Map(snapshot.files.map((file) => [file.path, file]));
      for (const name of sent.deletedPaths || []) files.delete(name);
      for (const file of sent.changedFiles || []) files.set(file.path, file);
      snapshot = { ...snapshot, session: { ...snapshot.session, baseRevision: `${snapshot.session.baseRevision}+` }, files: [...files.values()] };
    }
    const payload = request.url.endsWith("/status") ? { session: snapshot.session }
      : request.url.endsWith("/submit") ? { ...snapshot, submission: { id: "submission-1", previewUrl: frozenUrl } }
        : snapshot;
    response.writeHead(200, { "Content-Type": "application/json", "X-TimDS-API-Version": "1" }).end(JSON.stringify({ apiVersion: 1, ...payload }));
  });
  host.listen(0, "127.0.0.1");
  await once(host, "listening");
  t.after(() => { host.closeAllConnections(); host.close(); });
  const portal = `http://127.0.0.1:${host.address().port}`;

  const env = { ...process.env, TIMDS_ACCESS_TOKEN: "timds_smoke", TIMDS_PORTAL_URL: "", TMPDIR: temporary, PORT: "0" };
  const run = async (...args) => (await exec(process.execPath, [cli, ...args], { cwd: root, env, timeout: 60_000 })).stdout;

  await exec(process.execPath, [cli, "init", "--standalone", "--provider", "hosted", "--portal-url", portal, "--root", root, "--name", "Preview links", "--system-id", "example/preview-links"], { env, timeout: 60_000 });
  const provider = { kind: "hosted", url: portal, apiVersion: 1 };
  snapshot = { session: { id: "session-1", systemId: "example/preview-links", status: "open", baseRevision: "base", liveUrl }, files: await snapshotFiles(root) };
  await writeFile(path.join(root, ".timds", "session.json"), JSON.stringify({ apiVersion: 1, provider, session: snapshot.session, files: snapshot.files }));

  // Nothing changed yet: the hosted copy is named as what it is, at its front page.
  const untouched = await run("status");
  assert.match(untouched, /Local preview: not running\. Start it with timds dev/);
  assert.match(untouched, new RegExp(`Hosted copy \\(shows only what the last timds update sent\\): ${liveUrl}\\n`));

  await appendFile(path.join(root, page), "\n<!-- a designer's change -->\n");
  const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
  await writeFile(path.join(root, "CHANGELOG.md"), changelog.replace(/^## Unreleased\s*$/m, "## Unreleased\n\n- Web DS · About: smoke change."));

  // An unsent edit already has its address on the hosted copy.
  assert.match(await run("status"), new RegExp(`Hosted copy \\(shows only what the last timds update sent\\): ${liveUrl}${route}\\n`));

  // With the dev server up, every command names the local address first.
  // Its own process group, so stopping it stops the server the command started.
  const dev = spawn(process.execPath, [cli, "dev"], { cwd: root, env, stdio: ["ignore", "pipe", "inherit"], detached: true });
  const stop = () => { try { process.kill(-dev.pid); } catch { /* already gone */ } };
  t.after(stop);
  let printed = "";
  const local = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dev printed no preview address:\n${printed}`)), 60_000);
    dev.stdout.on("data", (chunk) => {
      printed += chunk;
      const match = new RegExp(`Preview: (http://127\\.0\\.0\\.1:\\d+/${route})`).exec(printed);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    dev.once("exit", (code) => { clearTimeout(timer); reject(new Error(`dev exited with ${code}:\n${printed}`)); });
  });
  assert.equal((await fetch(local)).status, 200);

  const updated = await run("update", "--note", "Smoke change");
  assert.ok(updated.indexOf(`Preview: ${local}`) !== -1 && updated.indexOf(`Preview: ${local}`) < updated.indexOf("Hosted copy, for someone on another machine"), updated);
  assert.match(updated, new RegExp(`Hosted copy, for someone on another machine \\(shows only what the last timds update sent\\): ${liveUrl}${route}`));

  // The update moved the session's base past the edit; the page stays the work here.
  const status = JSON.parse(await run("status", "--json"));
  assert.equal(status.preview.preferred, "local");
  assert.deepEqual(status.preview.local.urls, [local]);
  assert.deepEqual(status.preview.hosted.urls, [liveUrl + route]);

  assert.match(await run("check"), new RegExp(`Preview: ${local}\\n`));
  assert.match(await run("submit", "--note", "Smoke change"), new RegExp(`Submitted submission-1\\. Preview: ${frozenUrl}${route}\\n`));

  // Once the local server is gone, the hosted copy is the address again.
  stop();
  await once(dev, "exit");
  const stopped = await run("status");
  assert.doesNotMatch(stopped, /Preview: http:\/\/127\.0\.0\.1/);
  assert.match(stopped, new RegExp(`Hosted copy \\(shows only what the last timds update sent\\): ${liveUrl}${route}\\n`));
});

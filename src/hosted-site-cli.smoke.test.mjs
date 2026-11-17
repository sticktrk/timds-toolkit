import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const cli = fileURLToPath(new URL("../bin/timds.mjs", import.meta.url));
const exec = promisify(execFile);
const sourceId = randomUUID();
const sessionId = randomUUID();
const submissionId = randomUUID();
const publicationId = randomUUID();
const operationId = randomUUID();
const systemId = "example/core";
const oldCommit = "a".repeat(40);
const newCommit = "b".repeat(40);
const siteRoute = `/api/timds/sources/${sourceId}/site`;
const sourceRoute = `/api/timds/design-systems/${sourceId}`;
const publishRoute = `/api/timds/submissions/${submissionId}/publish`;
const sessionRoute = `/api/timds/sessions/${sessionId}`;
const publicRoot = "https://example.test/design-system/";
const liveUrl = "https://live.example.test/";
const site = {
  id: randomUUID(), sourceId, operationId, url: "https://site.example.test/",
  sourceCommit: oldCommit, deployedCommit: oldCommit, status: "ready", stage: "ready",
  deployments: [{ sourceCommit: oldCommit, status: "ready", stage: "ready" }],
};
const failedDeployment = {
  sourceCommit: newCommit, status: "failed", stage: "build",
  error: "Site build failed.", buildOutput: "Astro: Cannot resolve src/components/Hero.astro",
};
const failedSite = { ...site, sourceCommit: newCommit, status: "failed", stage: "build", error: failedDeployment.error, deployments: [failedDeployment, ...site.deployments] };

async function fixture(t, route, { workspace = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "timds-hosted-site-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const entry = {
      url: request.url, method: request.method, authorization: request.headers.authorization,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined,
    };
    requests.push(entry);
    const result = route(entry);
    if (result?.hang) return;
    if (!result) return response.writeHead(404).end(JSON.stringify({ error: "Route not found" }));
    const { status = 200, payload, headerOnly } = result;
    response.writeHead(status, { "Content-Type": "application/json", "X-TimDS-API-Version": "1" });
    response.end(JSON.stringify(headerOnly ? payload : { apiVersion: 1, ...payload }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const portal = `http://127.0.0.1:${server.address().port}`;
  const session = { id: sessionId, sourceId, systemId, status: "open", liveUrl };
  const provider = { kind: "hosted", url: portal };
  const state = path.join(root, ".timds", "session.json");
  if (workspace) {
    await mkdir(path.dirname(state));
    await writeFile(state, JSON.stringify({ apiVersion: 1, session, provider, files: [] }));
    await writeFile(path.join(root, "timds.json"), JSON.stringify({ systemId, provider }));
    await mkdir(path.join(root, "site"));
    await writeFile(path.join(root, "site", "timds.consumer.json"), JSON.stringify({ designSystem: { workspace: true, systemId } }));
  }
  const env = { ...process.env, TIMDS_ACCESS_TOKEN: "timds_smoke", TIMDS_PORTAL_URL: "" };
  const run = async (...args) => {
    const options = { cwd: root, env, timeout: 12_000 };
    try { return { ...await exec(process.execPath, [cli, ...args], options), code: 0 }; }
    catch (error) {
      if (typeof error.code !== "number") throw error;
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  };
  return { portal, root, state, session, run, requests };
}

test("hosted site CLI discovers the live preview and reads session diagnostics", async t => {
  const f = await fixture(t, ({ url }) => {
    if (url === sessionRoute + "/status") return { payload: { session: f.session } };
    if (url !== sessionRoute + "/diagnostics") return;
    return { headerOnly: true, payload: {
      state: "running", dev: { state: "ready", site: "failed", output: "Cannot find site module" },
      dependencyCache: { state: "hit" }, siteDependencyCache: { state: "miss" },
      wakeStartedAt: "2026-11-17T00:00:00Z", wakePhases: { siteDependencies: 357 },
    } };
  });
  const status = await f.run("status", "--root", path.join(f.root, "site"), "--json");
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).sitePreviewUrl, liveUrl + "site/");
  const diagnostics = await f.run("diagnostics");
  assert.equal(diagnostics.code, 0, diagnostics.stderr);
  for (const content of [/Site preview: failed/, /Cannot find site module/, /Dependency cache: hit/, /Site dependency cache: miss/, /siteDependencies: 357 ms/]) {
    assert.match(diagnostics.stdout, content);
  }
  const json = await f.run("diagnostics", "--json");
  assert.equal(json.code, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).dev.site, "failed");
  await rm(path.join(f.root, "site"), { recursive: true });
  const noSite = await f.run("status", "--json");
  assert.equal(noSite.code, 0, noSite.stderr);
  assert.equal(JSON.parse(noSite.stdout).sitePreviewUrl, undefined);
});

test("site show reports failed build output and retry reuses the host operation", async t => {
  let authorized = false;
  const f = await fixture(t, request => {
    if (request.url === siteRoute) return { payload: { site: failedSite } };
    if (request.url === sourceRoute.replace(sourceId, encodeURIComponent(systemId))) return { payload: { source: { id: sourceId } } };
    if (request.url === siteRoute + "/retry") return authorized
      ? { status: 202, payload: { site: { ...failedSite, status: "deploying", error: null } } }
      : { status: 403, payload: { error: "An active host administrator is required." } };
  });
  await rm(f.state); // A hosted source checkout can resolve its manifest without a session.
  const summary = await f.run("site", "show");
  assert.equal(summary.code, 0, summary.stderr);
  assert.match(summary.stdout, new RegExp(`Requested commit: ${newCommit}`));
  assert.match(summary.stdout, new RegExp(`Deployed commit: ${oldCommit}`));
  assert.match(summary.stdout, /Recent deployments:/);
  assert.match(summary.stdout, /Cannot resolve src\/components\/Hero\.astro/);
  const wait = await f.run("site", "show", "--source-id", sourceId, "--wait", "--json");
  assert.equal(wait.code, 1);
  const result = JSON.parse(wait.stdout);
  assert.equal(result.siteDeployment.status, "failed");
  assert.equal(result.site.deployments[0].buildOutput, failedDeployment.buildOutput);
  const refused = await f.run("site", "retry", "--source-id", sourceId);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /active host administrator/);
  authorized = true;
  const retry = await f.run("site", "retry", "--source-id", sourceId, "--json");
  assert.equal(retry.code, 0, retry.stderr);
  assert.equal(JSON.parse(retry.stdout).site.status, "deploying");
  assert.deepEqual(f.requests.at(-1), {
    url: siteRoute + "/retry", method: "POST", authorization: "Bearer timds_smoke",
    body: { apiVersion: 1, operationId },
  });
});

test("site show waits for a pinned commit and times out while an older commit is ready", async t => {
  let reads = 0;
  let deploy = false;
  const f = await fixture(t, ({ url }) => {
    if (url !== siteRoute) return;
    reads++;
    return { payload: { site: deploy && reads >= 2 ? { ...site, sourceCommit: newCommit, deployedCommit: newCommit } : site } };
  }, { workspace: false });
  const args = ["site", "show", "--source-id", sourceId, "--portal-url", f.portal, "--wait", "--commit", newCommit, "--json"];
  const timeout = await f.run(...args, "--timeout-seconds", "1");
  assert.equal(timeout.code, 1);
  assert.equal(JSON.parse(timeout.stdout).siteDeployment.status, "timeout");
  deploy = true;
  reads = 0;
  const success = await f.run(...args, "--timeout-seconds", "9");
  assert.equal(success.code, 0, success.stderr);
  assert.deepEqual(JSON.parse(success.stdout).siteDeployment, { sourceCommit: newCommit, status: "ready" });
  assert.equal(reads, 2);
});

test("publish follows its release ID and preserves a successful publication on site failure", async t => {
  let currentSite = site;
  let stall = false;
  const f = await fixture(t, ({ url, body }) => {
    if (url === publishRoute && (body.preflight || body.dryRun)) return { payload: {
      preflight: { submissionId, sessionId, systemId, version: "2026.11.17-1" },
    } };
    if (url === publishRoute) return { status: 202, payload: {
      publication: { id: publicationId, sourceId, status: "published", result: {
        publicRoot, version: "2026.11.17-1", publication: { version_id: publicationId },
      } },
    } };
    if (url === siteRoute) return stall ? { hang: true } : { payload: { site: currentSite } };
    if (url === sourceRoute) return { payload: {
      currentVersion: { id: randomUUID(), sourceCommit: oldCommit },
      versions: [{ id: publicationId, sourceCommit: newCommit }],
    } };
  });
  const dryRun = await f.run("publish", "--submission", submissionId, "--dry-run", "--json");
  assert.equal(dryRun.code, 0, dryRun.stderr);
  assert.equal(f.requests.length, 1);
  const pending = await f.run("publish", "--submission", submissionId, "--yes");
  assert.equal(pending.code, 0, pending.stderr);
  assert.match(pending.stdout, /Published: https:\/\/example\.test/);
  assert.match(pending.stdout, new RegExp(`Site deployment ${newCommit}: pending`));
  assert.match(pending.stdout, new RegExp(`Follow: timds site show .*--wait --commit ${newCommit}`));
  currentSite = failedSite;
  const failed = await f.run("publish", "--submission", submissionId, "--yes", "--wait-site", "--json");
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /Design System publication succeeded/);
  const report = JSON.parse(failed.stdout);
  assert.equal(report.status, "published");
  assert.equal(report.result.publicRoot, publicRoot);
  assert.equal(report.siteDeployment.status, "failed");
  assert.equal(report.site.deployments[0].buildOutput, failedDeployment.buildOutput);
  assert.equal(JSON.parse(await readFile(f.state, "utf8")).session.status, "closed");
  currentSite = null;
  const noSite = await f.run("publish", "--submission", submissionId, "--yes", "--wait-site", "--json");
  assert.equal(noSite.code, 0, noSite.stderr);
  assert.equal(JSON.parse(noSite.stdout).site, null);
  assert.equal(f.requests.at(-1).url, siteRoute);
  stall = true;
  const timeout = await f.run("publish", "--submission", submissionId, "--yes", "--wait-site", "--timeout-seconds", "1", "--json");
  assert.equal(timeout.code, 1);
  assert.equal(JSON.parse(timeout.stdout).siteDeployment.status, "timeout");
});

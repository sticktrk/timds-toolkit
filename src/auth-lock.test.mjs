import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import lockfile from "proper-lockfile";
import { readCredentials, saveAccessToken } from "./auth.mjs";

const authUrl = new URL("./auth.mjs", import.meta.url).toString();
async function file(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "timds-auth-lock-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return path.join(root, "credentials.json");
}
async function child(credentialsPath, host, operation, ...args) {
  const script = `import assert from 'node:assert/strict';
    import {resolveAccessToken,saveAccessToken,removeAccessToken} from ${JSON.stringify(authUrl)};
    const [credentialsPath,host,operation,...args]=process.argv.slice(1);
    const options={credentialsPath};
    if(operation==='refresh')assert.equal(await resolveAccessToken(host,options),'new-access');
    if(operation==='save')await saveAccessToken(host,args[0],options);
    if(operation==='remove')await removeAccessToken(host,options);
    if(operation==='busy')await assert.rejects(saveAccessToken(host,'timds_unused',{...options,lockTimeoutMs:150}),/busy in another process/);`;
  const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, credentialsPath, host, operation, ...args], { env: { ...process.env, TIMDS_ACCESS_TOKEN: "" }, timeout: 10_000 });
  assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
}

test("separate CLI processes reload the locked credential and exchange one rotating refresh token", async t => {
  const credentialsPath = await file(t); let refreshes = 0, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const form = new URLSearchParams(body);
    assert.equal(form.get("refresh_token"), "old-refresh"); refreshes += 1; entered();
    await new Promise(resolve => setTimeout(resolve, 250));
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(refreshes === 1 ? { access_token: "new-access", token_type: "Bearer", refresh_token: "new-refresh", expires_in: 3600 } : { error: "rotating token used twice" }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const host = `http://127.0.0.1:${server.address().port}`;
  await fs.writeFile(credentialsPath, JSON.stringify({ schemaVersion: 1, portals: { [host]: { accessToken: "old-access", oauth: { issuer: host, tokenEndpoint: `${host}/token`, clientId: "client", resource: `${host}/api/timds`, refreshToken: "old-refresh", expiresAt: new Date(0).toISOString() } } } }), { mode: 0o600 });
  const first = child(credentialsPath, host, "refresh");
  await started;
  await Promise.all([first, ...Array.from({ length: 4 }, () => child(credentialsPath, host, "refresh"))]);
  assert.equal(refreshes, 1);
  assert.equal((await readCredentials({ credentialsPath })).portals[host].oauth.refreshToken, "new-refresh");
  assert.equal((await fs.stat(credentialsPath)).mode & 0o777, 0o600);
});

test("concurrent process login and logout merge every host record without lost updates", async t => {
  const credentialsPath = await file(t), removedHost = "https://removed.test";
  await saveAccessToken(removedHost, "timds_old", { credentialsPath });
  const hosts = Array.from({ length: 12 }, (_, index) => `https://host${index}.test`);
  await Promise.all([child(credentialsPath, removedHost, "remove"), ...hosts.map((host, index) => child(credentialsPath, host, "save", `timds_fixture_${index}`))]);
  const saved = (await readCredentials({ credentialsPath })).portals;
  assert.deepEqual(Object.keys(saved).sort(), hosts.sort());
  assert.equal((await fs.stat(credentialsPath)).mode & 0o777, 0o600);
  await assert.rejects(fs.stat(`${credentialsPath}.lock`), { code: "ENOENT" });
});

test("an abandoned stale lock recovers, while a live owner gets a bounded credential-free busy error", async t => {
  const credentialsPath = await file(t), host = "https://host.test";
  await fs.mkdir(`${credentialsPath}.lock`);
  await fs.utimes(`${credentialsPath}.lock`, new Date(0), new Date(0));
  await child(credentialsPath, host, "save", "timds_recovered");
  const release = await lockfile.lock(credentialsPath, { realpath: false, stale: 10_000, update: 2_000 });
  try { await child(credentialsPath, host, "busy"); }
  finally { await release(); }
  assert.equal((await readCredentials({ credentialsPath })).portals[host].accessToken, "timds_recovered");
});

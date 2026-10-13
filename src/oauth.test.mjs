import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loginWithHost, readCredentials, resolveAccessToken, saveAccessToken } from "./auth.mjs";
import { discoverOAuthServer, openAuthorizationBrowser } from "./oauth.mjs";

const host = "https://host.test";
const discovery = {
  issuer: host, authorization_endpoint: `${host}/authorize`, token_endpoint: `${host}/token`, registration_endpoint: `${host}/register`,
  response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
  scopes_supported: ["timds:read", "timds:write", "offline_access"],
};
async function file(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "timds-oauth-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return path.join(root, "credentials.json");
}
function fixture(overrides = {}) {
  const calls = [];
  return { calls, fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    assert.equal(options.redirect, "error");
    assert.equal(new URL(url).origin, host);
    if (String(url).endsWith("oauth-authorization-server")) return Response.json({ ...discovery, ...overrides.metadata });
    if (String(url).endsWith("/register")) return Response.json({ client_id: "public-cli", token_endpoint_auth_method: "none", ...overrides.registration });
    return Response.json({ access_token: "opaque-access-secret", token_type: "Bearer", expires_in: 3600, refresh_token: "opaque-refresh-secret", ...overrides.tokens });
  } };
}
function callback(authorization, values = {}) {
  const url = new URL(authorization.redirectUri), login = new URL(authorization.verificationUrl);
  url.searchParams.set("state", login.searchParams.get("state"));
  url.searchParams.set("code", "single-use-code");
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
  return url;
}
const approve = async authorization => { assert.equal((await fetch(callback(authorization))).status, 200); };

test("OAuth registers a public loopback client and exchanges a single state-bound PKCE code", async t => {
  const credentialsPath = await file(t), f = fixture();
  let login;
  const result = await loginWithHost(host, {
    credentialsPath, ...f,
    async onAuthorization(authorization) {
      login = new URL(authorization.verificationUrl);
      const redirect = new URL(authorization.redirectUri);
      assert.equal(redirect.hostname, "127.0.0.1"); assert.notEqual(redirect.port, ""); assert.equal(redirect.pathname, "/callback");
      assert.equal(login.searchParams.get("code_challenge_method"), "S256");
      assert.equal(login.searchParams.get("resource"), `${host}/api/timds`);
      assert.equal(login.searchParams.get("scope"), "timds:read timds:write offline_access");
      assert.equal((await fetch(callback(authorization, { state: "incorrect" }))).status, 400);
      const wrongPath = callback(authorization); wrongPath.pathname = "/other";
      assert.equal((await fetch(wrongPath)).status, 404);
      assert.equal((await fetch(callback(authorization), { method: "POST" })).status, 404);
      const duplicate = callback(authorization); duplicate.searchParams.append("code", "other");
      assert.equal((await fetch(duplicate)).status, 400);
      const wrongHost = await new Promise((resolve, reject) => {
        const req = http.get(callback(authorization), { headers: { Host: "other.test" } }, res => { res.resume(); resolve(res.statusCode); }); req.on("error", reject);
      });
      assert.equal(wrongHost, 404);
      await approve(authorization);
      assert.equal((await fetch(callback(authorization))).status, 404, "callback is consumed once");
    },
  });
  const registration = JSON.parse(f.calls[1].options.body), fields = new URLSearchParams(f.calls[2].options.body);
  assert.equal(registration.token_endpoint_auth_method, "none"); assert.equal(registration.application_type, "native");
  assert.deepEqual(registration.redirect_uris, [login.searchParams.get("redirect_uri")]);
  assert.equal(fields.get("code"), "single-use-code"); assert.equal(fields.get("client_id"), "public-cli");
  assert.match(fields.get("code_verifier"), /^[a-zA-Z0-9_-]{43}$/);
  assert.equal(createHash("sha256").update(fields.get("code_verifier")).digest("base64url"), login.searchParams.get("code_challenge"));
  assert.equal(fields.get("resource"), `${host}/api/timds`);
  assert.equal(await resolveAccessToken(host, { credentialsPath }), "opaque-access-secret");
  assert.equal((await fs.stat(credentialsPath)).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal((await readCredentials({ credentialsPath })).portals[host].oauth.refreshToken, "opaque-refresh-secret");
});

for (const status of [404, 405, 501]) test(`missing OAuth discovery (${status}) keeps portal device login`, async t => {
  const credentialsPath = await file(t), calls = [];
  await loginWithHost(host, { credentialsPath, pollImmediately: true, fetchImpl: async url => {
    calls.push(String(url));
    if (String(url).endsWith("oauth-authorization-server")) return new Response(null, { status });
    if (String(url).endsWith("/authorize")) return Response.json({ deviceCode: "device", userCode: "ABCD", verificationUrl: `${host}/login` });
    return Response.json({ accessToken: "timds_device" });
  } });
  assert.equal(calls.length, 3); assert.equal(await resolveAccessToken(host, { credentialsPath }), "timds_device");
});

test("discovery never downgrades an unavailable, malformed, or foreign OAuth host to device login", async () => {
  for (const metadata of [{ issuer: "https://other.test" }, { token_endpoint: "https://other.test/token" }, { registration_endpoint: `${host}/register?redirect=elsewhere` }, { code_challenge_methods_supported: ["plain"] }, { token_endpoint_auth_methods_supported: ["client_secret_post"] }]) {
    const f = fixture({ metadata }); await assert.rejects(loginWithHost(host, f), /OAuth/); assert.equal(f.calls.length, 1);
  }
  for (const status of [401, 403, 429, 500, 503]) await assert.rejects(loginWithHost(host, { fetchImpl: async () => new Response(null, { status }) }), /discovery returned/);
  await assert.rejects(discoverOAuthServer(host, { fetchImpl: async () => { throw new Error("sensitive provider error"); } }), error => !error.message.includes("sensitive") && /request failed/.test(error.message));
  await assert.rejects(discoverOAuthServer("http://unsafe.test"), /requires HTTPS/);
  await assert.rejects(loginWithHost(host, { flow: "oauth", fetchImpl: async () => new Response(null, { status: 404 }) }), /does not advertise/);
});

test("explicit device flow bypasses OAuth discovery", async t => {
  const credentialsPath = await file(t);
  await loginWithHost(host, { flow: "device", credentialsPath, pollImmediately: true, fetchImpl: async url => {
    assert.equal(String(url).includes(".well-known"), false);
    return Response.json(String(url).endsWith("/authorize") ? { deviceCode: "d", userCode: "u", verificationUrl: `${host}/login` } : { accessToken: "timds_device" });
  } });
});

test("cancel, timeout, provider denial and issuer mismatch close the loopback listener without credentials", async t => {
  for (const reason of ["cancel", "timeout", "denied", "issuer"]) {
    const credentialsPath = await file(t), f = fixture(), controller = new AbortController(); let redirect;
    await assert.rejects(loginWithHost(host, { ...f, credentialsPath, signal: controller.signal, timeoutMs: reason === "timeout" ? 30 : 3000,
      async onAuthorization(auth) {
        redirect = auth.redirectUri;
        if (reason === "cancel") controller.abort();
        if (reason === "denied") await fetch(callback(auth, { error: "access_denied", error_description: "sensitive text" }));
        if (reason === "issuer") await fetch(callback(auth, { iss: "https://other.test" }));
      },
    }), error => /cancelled or expired|not granted|issuer does not match/.test(error.message) && !error.message.includes("sensitive"));
    assert.equal(f.calls.filter(call => call.url.endsWith("/token")).length, 0);
    assert.deepEqual((await readCredentials({ credentialsPath })).portals, {});
    await assert.rejects(fetch(redirect));
  }
});

test("registered public client avoids DCR, but registration cannot return a client secret", async t => {
  const credentialsPath = await file(t), f = fixture({ metadata: { registration_endpoint: undefined } });
  await loginWithHost(host, { ...f, credentialsPath, clientId: "pre-registered", onAuthorization: approve });
  assert.equal(f.calls.length, 2); assert.equal(new URLSearchParams(f.calls[1].options.body).get("client_id"), "pre-registered");
  await assert.rejects(loginWithHost(host, { ...fixture({ registration: { client_secret: "must-not-be-used" } }), credentialsPath }), /public client registration failed/);
});

test("expiring OAuth credentials refresh once per host, rotate safely, and keep unrelated tokens", async t => {
  const credentialsPath = await file(t), now = () => 1_000_000;
  await saveAccessToken("https://portal.test", "timds_other", { credentialsPath });
  await loginWithHost(host, { ...fixture({ tokens: { expires_in: 1 } }), credentialsPath, now, onAuthorization: approve });
  let refreshes = 0;
  const fetchImpl = async (url, options) => {
    refreshes += 1; assert.equal(url, `${host}/token`); assert.equal(options.redirect, "error");
    const fields = new URLSearchParams(options.body);
    assert.equal(fields.get("grant_type"), "refresh_token"); assert.equal(fields.get("refresh_token"), "opaque-refresh-secret"); assert.equal(fields.get("resource"), `${host}/api/timds`);
    await new Promise(resolve => setTimeout(resolve, 10));
    return Response.json({ access_token: "rotated-access", token_type: "Bearer", refresh_token: "rotated-refresh", expires_in: 3600 });
  };
  assert.deepEqual(await Promise.all([resolveAccessToken(host, { credentialsPath, now, fetchImpl }), resolveAccessToken(host, { credentialsPath, now, fetchImpl })]), ["rotated-access", "rotated-access"]);
  assert.equal(refreshes, 1);
  const saved = (await readCredentials({ credentialsPath })).portals;
  assert.equal(saved[host].oauth.refreshToken, "rotated-refresh"); assert.equal(saved["https://portal.test"].accessToken, "timds_other");
  assert.equal(await resolveAccessToken("https://elsewhere.test", { credentialsPath, now, fetchImpl }), "");
  assert.equal(await resolveAccessToken(host, { credentialsPath, token: "explicit", fetchImpl }), "explicit");
});

test("failed refresh preserves saved credentials and never sends a refresh token to a foreign endpoint", async t => {
  const credentialsPath = await file(t), now = () => 1_000_000;
  await loginWithHost(host, { ...fixture({ tokens: { expires_in: 1 } }), credentialsPath, now, onAuthorization: approve });
  const before = await fs.readFile(credentialsPath, "utf8");
  await assert.rejects(resolveAccessToken(host, { credentialsPath, now, fetchImpl: async () => Response.json({ error_description: "opaque-refresh-secret" }, { status: 400 }) }), error => /run timds auth login/.test(error.message) && !error.message.includes("secret"));
  assert.equal(await fs.readFile(credentialsPath, "utf8"), before);
  const poisoned = JSON.parse(before); poisoned.portals[host].oauth.tokenEndpoint = "https://other.test/token";
  await fs.writeFile(credentialsPath, JSON.stringify(poisoned));
  await assert.rejects(resolveAccessToken(host, { credentialsPath, now, fetchImpl: () => assert.fail("Must not send token") }), /selected host origin/);
});

test("browser launch passes the URL as a single argument with no shell", async () => {
  const url = `${host}/authorize?state=abc&resource=api`;
  assert.equal(await openAuthorizationBrowser(url, { platform: "darwin", spawnImpl(command, args, options) {
    assert.equal(command, "open"); assert.deepEqual(args, [url]); assert.equal(options.shell, false);
    const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit("spawn")); return child;
  } }), true);
});

test("CLI auth uses explicit host, then nearest hosted workspace, then configured portal", async t => {
  const credentialsPath = await file(t), root = path.join(path.dirname(credentialsPath), "workspace"), nested = path.join(root, "nested");
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(root, "timds.json"), JSON.stringify({ provider: { kind: "hosted", url: host } }));
  const cli = fileURLToPath(new URL("../bin/timds.mjs", import.meta.url));
  const env = { ...process.env, TIMDS_ACCESS_TOKEN: "", TIMDS_PORTAL_URL: "https://configured.test" };
  const run = (...args) => promisify(execFile)(process.execPath, [cli, ...args, "--root", nested, "--credentials-path", credentialsPath], { env });
  const implicit = await run("auth", "login", "--token", "timds_workspace");
  assert.match(implicit.stdout, /saved for https:\/\/host.test/); assert.equal(implicit.stdout.includes("timds_workspace"), false);
  await run("login", "--token", "timds_explicit", "--portal-url", "https://explicit.test");
  const status = await run("auth", "status"); assert.match(status.stdout, /https:\/\/host.test: signed in/);
  await fs.writeFile(path.join(root, "timds.json"), JSON.stringify({ provider: { kind: "local" } }));
  await run("auth", "login", "--token", "timds_configured");
  const saved = (await readCredentials({ credentialsPath })).portals;
  assert.deepEqual(Object.keys(saved).sort(), ["https://configured.test", "https://explicit.test", host].sort());
  await run("auth", "logout", "--portal-url", host);
  assert.equal((await readCredentials({ credentialsPath })).portals[host], undefined);
});

test("real HTTP OAuth discovery, registration and callback never follow a token-endpoint redirect", async t => {
  const credentialsPath = await file(t); let origin, redirectedRequests = 0, exchange = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    res.setHeader("Content-Type", "application/json");
    if (url.pathname.endsWith("oauth-authorization-server")) {
      res.end(JSON.stringify({ ...discovery, issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register` }));
    } else if (url.pathname === "/register") {
      let input = ""; for await (const chunk of req) input += chunk;
      assert.equal(JSON.parse(input).token_endpoint_auth_method, "none");
      res.end(JSON.stringify({ client_id: "loopback-cli" }));
    } else if (url.pathname === "/authorize") {
      const target = new URL(url.searchParams.get("redirect_uri"));
      target.searchParams.set("state", url.searchParams.get("state")); target.searchParams.set("code", "local-code");
      res.writeHead(302, { Location: target.toString() }).end();
    } else if (url.pathname === "/token") {
      exchange += 1;
      let input = ""; for await (const chunk of req) input += chunk;
      assert.equal(new URLSearchParams(input).get("code"), "local-code");
      res.writeHead(307, { Location: `${origin}/untrusted` }).end();
    } else { redirectedRequests += 1; res.end("{}"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); server.closeAllConnections(); });
  await assert.rejects(loginWithHost(origin, { credentialsPath, onAuthorization: async auth => {
    assert.equal((await fetch(auth.verificationUrl)).status, 200);
  } }), /OAuth request failed/);
  assert.equal(exchange, 1); assert.equal(redirectedRequests, 0);
  assert.deepEqual((await readCredentials({ credentialsPath })).portals, {});
});

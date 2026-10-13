import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";

const defaultScopes = ["timds:read", "timds:write", "offline_access"];
const failure = (message) => new Error(`TimDS OAuth ${message}`);

function hostOrigin(value) {
  const url = new URL(value);
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) {
    throw failure("requires HTTPS, or HTTP on a loopback host");
  }
  return url.origin;
}

function boundEndpoint(value, origin) {
  let url;
  try { url = new URL(value); } catch { throw failure("metadata contains an invalid endpoint"); }
  if (url.origin !== origin || url.username || url.password || url.hash || url.search) throw failure("endpoints must belong to the selected host origin");
  return url.toString();
}

async function request(url, options, { fetchImpl = fetch, signal } = {}) {
  let response;
  try {
    response = await fetchImpl(url, { ...options, redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
  } catch {
    if (signal?.aborted) throw failure("authorization cancelled or expired");
    throw failure("request failed; check the host connection and try again");
  }
  return { response, payload: await response.json().catch(() => null) };
}

export async function discoverOAuthServer(host, options = {}) {
  const origin = hostOrigin(host);
  const { response, payload } = await request(`${origin}/.well-known/oauth-authorization-server`, { headers: { Accept: "application/json" } }, options);
  if ([404, 405, 501].includes(response.status)) return null;
  if (!response.ok) throw failure(`discovery returned HTTP ${response.status}`);
  if (!payload || ![origin, `${origin}/`].includes(payload.issuer)) throw failure("issuer does not match the selected host");
  if (!Array.isArray(payload.response_types_supported) || !payload.response_types_supported.includes("code") || !Array.isArray(payload.code_challenge_methods_supported) || !payload.code_challenge_methods_supported.includes("S256")) throw failure("host must support authorization code with PKCE S256");
  if (payload.token_endpoint_auth_methods_supported && (!Array.isArray(payload.token_endpoint_auth_methods_supported) || !payload.token_endpoint_auth_methods_supported.includes("none"))) throw failure("host must support public clients");
  return {
    issuer: payload.issuer,
    authorizationEndpoint: boundEndpoint(payload.authorization_endpoint, origin),
    tokenEndpoint: boundEndpoint(payload.token_endpoint, origin),
    registrationEndpoint: payload.registration_endpoint ? boundEndpoint(payload.registration_endpoint, origin) : null,
    scopesSupported: Array.isArray(payload.scopes_supported) ? payload.scopes_supported : [],
  };
}

function secretString(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 16_384 && !/[^\x21-\x7e]/.test(value);
}

function tokenResult(payload, previous, now = Date.now()) {
  if (!payload || !secretString(payload.access_token) || String(payload.token_type).toLowerCase() !== "bearer") throw failure("host returned an invalid bearer token");
  if (payload.refresh_token !== undefined && !secretString(payload.refresh_token)) throw failure("host returned an invalid refresh token");
  const lifetime = payload.expires_in;
  if (lifetime !== undefined && (!Number.isFinite(lifetime) || lifetime <= 0 || lifetime > 365 * 86400)) throw failure("host returned an invalid token lifetime");
  return {
    accessToken: payload.access_token,
    oauth: {
      ...previous,
      refreshToken: payload.refresh_token ?? previous.refreshToken ?? null,
      expiresAt: lifetime === undefined ? null : new Date(now + lifetime * 1000).toISOString(),
    },
  };
}

async function tokenRequest(metadata, fields, options) {
  const { response, payload } = await request(metadata.tokenEndpoint, {
    method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString(),
  }, options);
  if (!response.ok) throw failure(`token exchange returned HTTP ${response.status}; run timds auth login again`);
  return tokenResult(payload, metadata, options.now?.() ?? Date.now());
}

async function loopbackCallback(state, signal) {
  let resolveCode, rejectCode, redirectUri, consumed = false;
  const code = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  // Registration/discovery may fail before the caller starts awaiting the code.
  code.catch(() => {});
  const server = http.createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Connection", "close");
    const expected = new URL(redirectUri);
    let url;
    try { url = new URL(req.url, redirectUri); } catch { res.writeHead(400).end("Invalid callback."); return; }
    if (req.method !== "GET" || req.headers.host !== expected.host || url.origin !== expected.origin || url.pathname !== expected.pathname || consumed) {
      res.writeHead(404).end("Not found."); return;
    }
    const received = Buffer.from(url.searchParams.get("state") || "");
    const correct = Buffer.from(state);
    if (url.searchParams.getAll("state").length !== 1 || received.length !== correct.length || !timingSafeEqual(received, correct)) {
      res.writeHead(400).end("Invalid authorization state."); return;
    }
    if (url.searchParams.has("iss") && (url.searchParams.getAll("iss").length !== 1 || !url.searchParams.get("iss"))) {
      res.writeHead(400).end("Invalid issuer."); return;
    }
    if (url.searchParams.has("error")) {
      consumed = true;
      const declined = () => rejectCode(failure("authorization was not granted"));
      res.once("finish", declined);
      res.once("close", declined);
      res.writeHead(400).end("Authorization was not granted. Return to the terminal.");
      return;
    }
    if (url.searchParams.getAll("code").length !== 1 || !secretString(url.searchParams.get("code"))) {
      res.writeHead(400).end("Invalid authorization code."); return;
    }
    consumed = true;
    // Complete only after handing the landing response to the socket, or after
    // the browser disconnects. A valid callback still succeeds if its tab closes.
    const receivedCode = () => resolveCode({ code: url.searchParams.get("code"), issuer: url.searchParams.get("iss") });
    res.once("finish", receivedCode);
    res.once("close", receivedCode);
    res.end("Authorization received. You can close this tab and return to the terminal.");
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
  const cancel = () => rejectCode(failure("authorization cancelled or expired"));
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  return { redirectUri, code, close() {
    signal.removeEventListener("abort", cancel);
    return new Promise((resolve) => {
      // Let active responses drain; force-close only a connection that stalls.
      const deadline = setTimeout(() => server.closeAllConnections(), 5000);
      deadline.unref();
      server.close(() => { clearTimeout(deadline); resolve(); });
    });
  } };
}

/** Launch a URL as one argument, without a shell; headless callers can print it. */
export function openAuthorizationBrowser(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  const command = platform === "darwin" ? ["open", url] : platform === "win32" ? ["rundll32.exe", "url.dll,FileProtocolHandler", url] : ["xdg-open", url];
  return new Promise((resolve) => {
    const child = spawnImpl(command[0], command.slice(1), { shell: false, stdio: "ignore", detached: true });
    child.once("error", () => resolve(false));
    child.once("spawn", () => { child.unref(); resolve(true); });
  });
}

export async function authorizeOAuth(host, metadata, options = {}) {
  const origin = hostOrigin(host);
  if (![origin, `${origin}/`].includes(metadata.issuer)) throw failure("issuer does not match the selected host");
  boundEndpoint(metadata.authorizationEndpoint, origin); boundEndpoint(metadata.tokenEndpoint, origin);
  if (metadata.registrationEndpoint) boundEndpoint(metadata.registrationEndpoint, origin);
  const timeoutMs = options.timeoutMs ?? 600_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3600_000) throw failure("timeout must be between 1 ms and one hour");
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const context = { ...options, signal };
  const state = randomBytes(32).toString("base64url"), verifier = randomBytes(32).toString("base64url");
  const listener = await loopbackCallback(state, signal);
  try {
    let clientId = options.clientId;
    if (!clientId) {
      if (!metadata.registrationEndpoint) throw failure("host requires a registered public --client-id");
      const { response, payload } = await request(metadata.registrationEndpoint, {
        method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "TimDS CLI", application_type: "native", redirect_uris: [listener.redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
      }, context);
      if (!response.ok || !secretString(payload?.client_id) || payload.client_secret || payload.token_endpoint_auth_method && payload.token_endpoint_auth_method !== "none") throw failure("public client registration failed");
      clientId = payload.client_id;
    }
    if (!secretString(clientId)) throw failure("invalid public client ID");
    const scopes = options.scopes || defaultScopes.filter(scope => metadata.scopesSupported.includes(scope));
    if (!Array.isArray(scopes) || scopes.some(scope => typeof scope !== "string" || !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope))) throw failure("invalid scope");
    const resource = `${origin}/api/timds`;
    const url = new URL(metadata.authorizationEndpoint);
    for (const [key, value] of Object.entries({ response_type: "code", client_id: clientId, redirect_uri: listener.redirectUri, state, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource, scope: scopes.join(" ") })) url.searchParams.set(key, value);
    const notification = { flow: "oauth", verificationUrl: url.toString(), redirectUri: listener.redirectUri };
    await options.onAuthorization?.(notification);
    if (options.openBrowser) await (typeof options.openBrowser === "function" ? options.openBrowser : openAuthorizationBrowser)(notification.verificationUrl);
    const received = await listener.code;
    if (received.issuer && received.issuer !== metadata.issuer) throw failure("callback issuer does not match the selected host");
    return await tokenRequest({ issuer: metadata.issuer, tokenEndpoint: metadata.tokenEndpoint, clientId, resource, scopes }, { grant_type: "authorization_code", client_id: clientId, redirect_uri: listener.redirectUri, code: received.code, code_verifier: verifier, resource }, context);
  } finally { await listener.close(); }
}

export async function refreshOAuth(host, credential, options = {}) {
  const origin = hostOrigin(host), metadata = credential.oauth;
  if (!metadata || ![origin, `${origin}/`].includes(metadata.issuer) || metadata.resource !== `${origin}/api/timds`) throw failure("saved credential does not match the selected host");
  boundEndpoint(metadata.tokenEndpoint, origin);
  if (!secretString(metadata.clientId) || !secretString(metadata.refreshToken)) throw failure("authorization expired; run timds auth login again");
  return tokenRequest(metadata, { grant_type: "refresh_token", client_id: metadata.clientId, refresh_token: metadata.refreshToken, resource: metadata.resource }, options);
}

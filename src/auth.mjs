import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { authorizeOAuth, discoverOAuthServer, refreshOAuth } from "./oauth.mjs";

const DEFAULT_PORTAL_URL = "https://timds.com";
const DEFAULT_POLL_INTERVAL_SECONDS = 5;

function cleanPortalUrl(value) {
  const url = new URL(String(value || DEFAULT_PORTAL_URL));
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("TimDS portal URL must use HTTP or HTTPS without embedded credentials");
  }
  return url.origin;
}

function endpoint(portalUrl, pathname) {
  return new URL(pathname, `${cleanPortalUrl(portalUrl)}/`).toString();
}

export function credentialsPath(options = {}) {
  if (options.credentialsPath) return path.resolve(options.credentialsPath);
  const configRoot = String(process.env.XDG_CONFIG_HOME || "").trim()
    ? path.resolve(process.env.XDG_CONFIG_HOME)
    : path.join(os.homedir(), ".config");
  return path.join(configRoot, "timds", "credentials.json");
}

export async function readCredentials(options = {}) {
  const filePath = credentialsPath(options);
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    const portals = parsed?.portals && typeof parsed.portals === "object" && !Array.isArray(parsed.portals)
      ? parsed.portals
      : {};
    return { filePath, portals, schemaVersion: 1 };
  } catch (caught) {
    if (caught?.code === "ENOENT") return { filePath, portals: {}, schemaVersion: 1 };
    if (caught instanceof SyntaxError) throw new Error("TimDS credentials file is invalid JSON");
    throw caught;
  }
}

async function saveCredential(portal, credential, options) {
  const credentials = await readCredentials(options);
  const next = {
    portals: {
      ...credentials.portals,
      [portal]: {
        ...credential,
        savedAt: new Date().toISOString(),
      },
    },
    schemaVersion: 1,
  };
  await writeCredentials(credentials.filePath, next);
  return { filePath: credentials.filePath, portal };
}

async function writeCredentials(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { mode: 0o700, recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(temporary, filePath);
  } finally { await fs.rm(temporary, { force: true }); }
}

export async function saveAccessToken(portalUrl, accessToken, options = {}) {
  const portal = cleanPortalUrl(portalUrl);
  const token = String(accessToken || "").trim();
  if (!token.startsWith("timds_") || /\s/.test(token)) throw new Error("TimDS access token is invalid");
  return saveCredential(portal, { accessToken: token }, options);
}

export async function removeAccessToken(portalUrl, options = {}) {
  const portal = cleanPortalUrl(portalUrl);
  const credentials = await readCredentials(options);
  if (!credentials.portals[portal]) return { filePath: credentials.filePath, portal, removed: false };
  const portals = { ...credentials.portals };
  delete portals[portal];
  await writeCredentials(credentials.filePath, { portals, schemaVersion: 1 });
  return { filePath: credentials.filePath, portal, removed: true };
}

const refreshes = new Map();
export async function resolveAccessToken(portalUrl, options = {}) {
  const explicit = String(options.token || process.env.TIMDS_ACCESS_TOKEN || "").trim();
  if (explicit) return explicit;
  const portal = cleanPortalUrl(portalUrl);
  const credentials = await readCredentials(options);
  const credential = credentials.portals[portal];
  if (credential?.oauth?.expiresAt && Date.parse(credential.oauth.expiresAt) <= (options.now?.() ?? Date.now()) + 30_000) {
    const key = `${credentials.filePath}:${portal}`;
    if (!refreshes.has(key)) {
      const pending = (async () => {
        const next = await refreshOAuth(portal, credential, options);
        await saveCredential(portal, next, options);
        return next.accessToken;
      })().finally(() => refreshes.delete(key));
      refreshes.set(key, pending);
    }
    return refreshes.get(key);
  }
  return String(credential?.accessToken || "").trim();
}

async function jsonRequest(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, {
    ...options,
    redirect: "error",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  return { payload, response };
}

export async function beginDeviceAuthorization(portalUrl, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const { payload, response } = await jsonRequest(
    fetchImpl,
    endpoint(portalUrl, "/api/timds-cli/device/authorize"),
    { body: JSON.stringify({ clientName: options.clientName || "TimDS CLI" }), method: "POST", signal: options.signal },
  );
  if (!response.ok) throw new Error(String(payload.error || `TimDS device authorization returned ${response.status}`));
  if (!payload.deviceCode || !payload.userCode || !payload.verificationUrl) {
    throw new Error("TimDS returned an invalid device authorization response");
  }
  return payload;
}

export async function pollDeviceAuthorization(portalUrl, authorization, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const expiresAt = Date.now() + Number(authorization.expiresIn || 600) * 1_000;
  let intervalSeconds = Math.max(
    1,
    Number(authorization.pollInterval || DEFAULT_POLL_INTERVAL_SECONDS),
  );
  while (Date.now() < expiresAt) {
    if (options.signal?.aborted) throw new Error("TimDS authorization cancelled or expired");
    if (!options.pollImmediately) await sleep(intervalSeconds * 1_000);
    options.pollImmediately = false;
    const { payload, response } = await jsonRequest(
      fetchImpl,
      endpoint(portalUrl, "/api/timds-cli/device/token"),
      { body: JSON.stringify({ deviceCode: authorization.deviceCode }), method: "POST", signal: options.signal },
    );
    if (response.ok && payload.accessToken) return payload;
    const code = String(payload.code || "");
    if (response.status === 428 && code === "authorization_pending") continue;
    if (response.status === 429 && code === "slow_down") {
      intervalSeconds += 2;
      continue;
    }
    throw new Error(String(payload.error || `TimDS device authorization returned ${response.status}`));
  }
  throw new Error("TimDS device authorization expired before it was approved");
}

export async function loginWithDevice(portalUrl, options = {}) {
  const portal = cleanPortalUrl(portalUrl);
  const authorization = await beginDeviceAuthorization(portal, options);
  options.onAuthorization?.(authorization);
  const granted = await pollDeviceAuthorization(portal, authorization, options);
  const saved = await saveAccessToken(portal, granted.accessToken, options);
  return { ...saved, expiresAt: granted.expiresAt || null, userCode: authorization.userCode };
}

/** OAuth hosts advertise discovery; existing portals retain device authorization. */
export async function loginWithHost(portalUrl, options = {}) {
  const portal = cleanPortalUrl(portalUrl), flow = options.flow || "auto";
  if (!["auto", "oauth", "device"].includes(flow)) throw new Error("Unknown TimDS authorization flow");
  if (flow === "device") return loginWithDevice(portal, options);
  const metadata = await discoverOAuthServer(portal, options);
  if (!metadata) {
    if (flow === "oauth") throw new Error("The selected TimDS host does not advertise OAuth authorization");
    return loginWithDevice(portal, options);
  }
  const credential = await authorizeOAuth(portal, metadata, options);
  const saved = await saveCredential(portal, credential, options);
  return { ...saved, flow: "oauth", expiresAt: credential.oauth.expiresAt };
}

export { cleanPortalUrl };

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

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
    if (caught instanceof SyntaxError) throw new Error(`TimDS credentials file is invalid JSON: ${caught.message}`);
    throw caught;
  }
}

export async function saveAccessToken(portalUrl, accessToken, options = {}) {
  const portal = cleanPortalUrl(portalUrl);
  const token = String(accessToken || "").trim();
  if (!token.startsWith("timds_")) throw new Error("TimDS access token is invalid");
  const credentials = await readCredentials(options);
  const next = {
    portals: {
      ...credentials.portals,
      [portal]: {
        accessToken: token,
        savedAt: new Date().toISOString(),
      },
    },
    schemaVersion: 1,
  };
  await fs.mkdir(path.dirname(credentials.filePath), { mode: 0o700, recursive: true });
  await fs.writeFile(credentials.filePath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(credentials.filePath, 0o600);
  return { filePath: credentials.filePath, portal };
}

export async function removeAccessToken(portalUrl, options = {}) {
  const portal = cleanPortalUrl(portalUrl);
  const credentials = await readCredentials(options);
  if (!credentials.portals[portal]) return { filePath: credentials.filePath, portal, removed: false };
  const portals = { ...credentials.portals };
  delete portals[portal];
  await fs.mkdir(path.dirname(credentials.filePath), { mode: 0o700, recursive: true });
  await fs.writeFile(
    credentials.filePath,
    `${JSON.stringify({ portals, schemaVersion: 1 }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await fs.chmod(credentials.filePath, 0o600);
  return { filePath: credentials.filePath, portal, removed: true };
}

export async function resolveAccessToken(portalUrl, options = {}) {
  const explicit = String(options.token || process.env.TIMDS_ACCESS_TOKEN || "").trim();
  if (explicit) return explicit;
  const portal = cleanPortalUrl(portalUrl);
  const credentials = await readCredentials(options);
  return String(credentials.portals[portal]?.accessToken || "").trim();
}

async function jsonRequest(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, {
    ...options,
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
    { body: JSON.stringify({ clientName: options.clientName || "TimDS CLI" }), method: "POST" },
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
    if (!options.pollImmediately) await sleep(intervalSeconds * 1_000);
    options.pollImmediately = false;
    const { payload, response } = await jsonRequest(
      fetchImpl,
      endpoint(portalUrl, "/api/timds-cli/device/token"),
      { body: JSON.stringify({ deviceCode: authorization.deviceCode }), method: "POST" },
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

export { cleanPortalUrl };

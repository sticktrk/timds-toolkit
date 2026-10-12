// The public host contract. Storage, publication and credentials belong to the host.
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import ignore from "ignore";
import { cleanPortalUrl, resolveAccessToken } from "./auth.mjs";

export const HOST_API_VERSION = 1;
export const SESSION_FILE = ".timds/session.json";
const PENDING_START_FILE = ".timds/start.json";
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 4000;
const NO_HOST = "No TimDS host configured; use local mode for editing or git mode for pull requests, or configure provider.kind=hosted and provider.url.";
const RESERVED = new Set([".git", ".github", "node_modules", "dist", ".env", ".env.server"]);

export function hostedPath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || /[\x00-\x1f\x7f]/.test(value) || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) throw new Error("Invalid session file path");
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || RESERVED.has(part.toLowerCase()) || (part.toLowerCase().startsWith(".env.") && part.toLowerCase() !== ".env.example")) || /^\.timds\/(?:session|auth|start)(?:[./]|$)/i.test(value) || /\.(?:pem|key|p12|pfx)$/i.test(value)) throw new Error(`Unsafe session file path: ${value}`);
  return value;
}

export function normalizeProvider(value) {
  if (value === undefined || value === null) return null;
  const provider = typeof value === "string" ? { kind: value } : value;
  if (!provider || !["local", "git", "hosted"].includes(provider.kind)) throw new Error("timds.json provider.kind must be local, git, or hosted");
  if (provider.kind === "hosted" && !provider.url) throw new Error(NO_HOST);
  return provider.kind === "hosted" ? { kind: "hosted", url: cleanPortalUrl(provider.url), apiVersion: HOST_API_VERSION } : { kind: provider.kind };
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function findHostedRoot(start = process.cwd()) {
  let current = path.resolve(start);
  while (true) {
    if (await readJson(path.join(current, SESSION_FILE))) return current;
    if (await readJson(path.join(current, "timds.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
}

export async function workspaceProvider(root) {
  const selected = await findHostedRoot(root);
  const manifest = await readJson(path.join(selected, "timds.json"));
  const state = await readJson(path.join(selected, SESSION_FILE));
  return normalizeProvider(manifest?.provider || state?.provider);
}

export function createHostProvider({ url, token, fetchImpl = fetch }) {
  const origin = cleanPortalUrl(url);
  if (!token) throw new Error("A TimDS token is required; run timds auth login or set TIMDS_ACCESS_TOKEN.");
  async function request(method, suffix, body) {
    const response = await fetchImpl(`${origin}/api/timds/sessions${suffix}`, {
      method, redirect: "error",
      headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-TimDS-API-Version": String(HOST_API_VERSION) },
      ...(body ? { body: JSON.stringify({ ...body, apiVersion: HOST_API_VERSION }) } : {}),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`TimDS host returned ${response.status}: ${String(payload.error || "request failed")}`);
    if (payload.apiVersion !== HOST_API_VERSION) throw new Error("Unsupported TimDS host API version; update the CLI and host together.");
    return payload;
  }
  const sessionPath = (id) => `/${encodeURIComponent(id)}`;
  return {
    start: (input) => request("POST", "", input),
    pull: (id) => request("GET", sessionPath(id)),
    submit: (id, input) => request("POST", `${sessionPath(id)}/submit`, input),
    update: (id, input) => request("POST", `${sessionPath(id)}/update`, input),
    status: (id) => request("GET", `${sessionPath(id)}/status`),
    history: (id) => request("GET", `${sessionPath(id)}/history`),
    close: (id) => request("POST", `${sessionPath(id)}/close`, {}),
  };
}

function decodeFiles(files) {
  if (!Array.isArray(files) || files.length > MAX_FILES) throw new Error("TimDS host returned an invalid file snapshot");
  const decoded = new Map();
  const portablePaths = new Set();
  let total = 0;
  for (const file of files) {
    const name = hostedPath(file.path);
    const portablePath = name.normalize("NFC").toLowerCase();
    if (portablePaths.has(portablePath)) throw new Error(`Session paths collide on this filesystem: ${name}`);
    portablePaths.add(portablePath);
    if (decoded.has(name) || file.encoding !== "base64" || typeof file.content !== "string" || file.content.length > Math.ceil(MAX_FILE_BYTES / 3) * 4) throw new Error(`Invalid session file: ${name}`);
    const bytes = Buffer.from(file.content, "base64");
    if (bytes.toString("base64") !== file.content) throw new Error(`Invalid session file encoding: ${name}`);
    bytes.mode = file.mode || "100644";
    if (!["100644", "100755", "120000"].includes(bytes.mode)) throw new Error(`Invalid session file mode: ${name}`);
    if (bytes.mode === "120000") safeLinkTarget(name, bytes.toString("utf8"));
    total += bytes.length;
    if (bytes.length > MAX_FILE_BYTES || total > MAX_SNAPSHOT_BYTES) throw new Error("Session snapshot exceeds the supported file size");
    decoded.set(name, bytes);
  }
  for (const name of decoded.keys()) {
    const parts = name.split("/");
    while (parts.length > 1) { parts.pop(); if (portablePaths.has(parts.join("/").normalize("NFC").toLowerCase())) throw new Error(`Conflicting session file path: ${name}`); }
  }
  validateLinks(decoded);
  return decoded;
}

function safeLinkTarget(name, target) {
  if (!target || target.includes("\0") || target.includes("\\") || path.posix.isAbsolute(target) || /^[A-Za-z]:/.test(target)) throw new Error(`Unsafe session symlink: ${name}`);
  const segments = target.split("/");
  if (segments.includes(".") || segments.includes("") || segments.findIndex((part) => part !== "..") < segments.lastIndexOf("..")) throw new Error(`Unsafe session symlink: ${name}`);
  if (name.toLowerCase() === ".timds") throw new Error("Session metadata directory cannot be a symlink");
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), target));
  hostedPath(resolved);
  return resolved;
}

function validateLinks(files) {
  for (const [name, bytes] of files) {
    if (bytes.mode !== "120000") continue;
    let target = safeLinkTarget(name, bytes.toString("utf8"));
    const visited = new Set([name]);
    while (true) {
      const parts = target.split("/");
      let linked = false;
      for (let index = 1; index <= parts.length; index++) {
        const candidate = parts.slice(0, index).join("/");
        const entry = files.get(candidate);
        if (entry?.mode !== "120000") continue;
        if (visited.has(candidate)) throw new Error(`Cyclic session symlink: ${name}`);
        visited.add(candidate);
        target = path.posix.join(safeLinkTarget(candidate, entry.toString("utf8")), ...parts.slice(index));
        hostedPath(target);
        linked = true;
        break;
      }
      if (!linked) break;
    }
  }
}

function encodeFiles(files) { return [...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) => ({ path: name, encoding: "base64", content: bytes.toString("base64"), mode: bytes.mode || "100644" })); }
function same(a, b) { return a === undefined ? b === undefined : b !== undefined && a.equals(b) && (a.mode || "100644") === (b.mode || "100644"); }

async function safeDestination(root, name, allowFinalLink = false, removing = new Set()) {
  hostedPath(name);
  let current = root;
  for (const segment of ["", ...name.split("/")]) {
    current = segment ? path.join(current, segment) : current;
    if (removing.has(path.relative(root, current).split(path.sep).join("/"))) break;
    try { const info = await fs.lstat(current); if (info.isSymbolicLink() && !(allowFinalLink && current === path.join(root, name))) throw new Error(`Session paths cannot traverse symbolic links: ${name}`); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return path.join(root, name);
}

async function ignoredMatcher(root) {
  const rules = [];
  async function walk(directory, prefix = "") {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    const file = entries.find((entry) => entry.name === ".gitignore" && entry.isFile());
    if (file) rules.push({ prefix, matcher: ignore().add(await fs.readFile(path.join(directory, file.name), "utf8")) });
    for (const entry of entries) if (entry.isDirectory() && ![".git", "node_modules", "dist", ".timds", "media-local", "video-local"].includes(entry.name)) await walk(path.join(directory, entry.name), `${prefix}${entry.name}/`);
  }
  await walk(root);
  return (name) => {
    let ignored = false;
    for (const rule of rules) {
      if (!name.startsWith(rule.prefix) || name === rule.prefix) continue;
      const result = rule.matcher.test(name.slice(rule.prefix.length));
      if (result.ignored) ignored = true;
      if (result.unignored) ignored = false;
    }
    return ignored;
  };
}

export async function sessionIgnoredMatcher(root) {
  const state = await readJson(path.join(root, SESSION_FILE));
  const manifest = await readJson(path.join(root, "timds.json"));
  if (!state && normalizeProvider(manifest?.provider)?.kind !== "hosted") return () => false;
  const tracked = new Set((state?.files || []).map((file) => file.path));
  const ignored = await ignoredMatcher(root);
  return (name) => !tracked.has(name) && ignored(name);
}

async function localFiles(root, base) {
  const files = new Map();
  const ignored = await ignoredMatcher(root);
  async function walk(directory, prefix = "") {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (name === SESSION_FILE || RESERVED.has(entry.name.toLowerCase()) || /\.(?:pem|key|p12|pfx)$/i.test(entry.name) || entry.name.toLowerCase().startsWith(".env.") && entry.name.toLowerCase() !== ".env.example") continue;
      if (entry.isSymbolicLink()) {
        if (ignored(name) && !base.has(name)) continue;
        await safeDestination(root, name, true);
        const bytes = Buffer.from(await fs.readlink(path.join(directory, entry.name)));
        safeLinkTarget(name, bytes.toString("utf8"));
        bytes.mode = "120000";
        files.set(name, bytes);
        continue;
      }
      if (entry.isDirectory()) {
        if (ignored(`${name}/`) && ![...base.keys()].some((key) => key.startsWith(`${name}/`))) continue;
        await walk(path.join(directory, entry.name), `${name}/`);
      } else if (entry.isFile()) {
        if (ignored(name) && !base.has(name)) continue; // Same tracked-file exception as consumer gitIgnoredPaths.
        const destination = await safeDestination(root, name);
        const info = await fs.stat(destination);
        if (info.size > MAX_FILE_BYTES) throw new Error(`Session file exceeds 10 MiB: ${name}`);
        const bytes = await fs.readFile(destination);
        bytes.mode = info.mode & 0o111 ? "100755" : "100644";
        files.set(name, bytes);
      }
    }
  }
  await walk(root);
  validateLinks(files);
  if (files.size > MAX_FILES || [...files.values()].reduce((total, bytes) => total + bytes.length, 0) > MAX_SNAPSHOT_BYTES) throw new Error("Session snapshot exceeds 4000 files or 10 MiB");
  return files;
}

export async function sessionChanges(root, state, note) {
  const base = decodeFiles(state.files);
  const files = await localFiles(root, base);
  const changed = new Map([...files].filter(([name, bytes]) => !same(base.get(name), bytes)));
  return { files, changes: { baseRevision: state.session.baseRevision, changedFiles: encodeFiles(changed), deletedPaths: [...base.keys()].filter((name) => !files.has(name)).sort(), ...(note ? { note } : {}) } };
}

async function writeState(root, state) {
  // Metadata never carries a token. Refuse a linked metadata directory before writing.
  await safeDestination(root, ".timds/session-check");
  await fs.mkdir(path.join(root, ".timds"), { recursive: true });
  const destination = path.join(root, SESSION_FILE);
  try { if ((await fs.lstat(destination)).isSymbolicLink()) throw new Error("Session metadata cannot be a symbolic link"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  await fs.writeFile(destination, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function validateSession(session) {
  if (!session || typeof session.id !== "string" || !session.id || typeof session.baseRevision !== "string" || !session.baseRevision) throw new Error("TimDS host returned an invalid session");
  return session;
}

async function applySnapshot(root, snapshot, previous, provider, replace = false) {
  const session = validateSession(snapshot.session);
  const remote = decodeFiles(snapshot.files);
  const base = previous ? decodeFiles(previous.files) : new Map();
  const local = previous ? await localFiles(root, base) : new Map();
  const conflicts = new Set(snapshot.conflicts || []);
  const writes = [];
  for (const name of new Set([...base.keys(), ...remote.keys(), ...local.keys()])) {
    const before = base.get(name), ours = local.get(name), theirs = remote.get(name);
    if (!replace && !same(ours, before) && !same(theirs, before) && !same(ours, theirs)) { conflicts.add(name); continue; }
    if ((replace || same(ours, before)) && !same(ours, theirs)) writes.push([name, theirs]);
  }
  if (conflicts.size) return { ...snapshot, conflicts: [...conflicts].sort(), applied: false };
  // Validate the complete transition before changing any file. Never remove an
  // untracked file to make room for a directory/file shape change.
  const removing = new Set(writes.filter(([, bytes]) => bytes === undefined).map(([name]) => name));
  const emptyDirectories = [];
  async function removableDirectory(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await removableDirectory(absolute);
      else if (!removing.has(path.relative(root, absolute).split(path.sep).join("/"))) throw new Error(`Snapshot would overwrite a local path: ${path.relative(root, absolute)}`);
    }
    emptyDirectories.push(directory);
  }
  for (const [name, bytes] of writes) {
    await safeDestination(root, name, base.get(name)?.mode === "120000" || local.get(name)?.mode === "120000", removing);
    if (bytes !== undefined) {
      const info = await fs.lstat(path.join(root, name)).catch((error) => { if (["ENOENT", "ENOTDIR"].includes(error.code)) return null; throw error; });
      if (info?.isDirectory()) await removableDirectory(path.join(root, name));
    }
  }
  await safeDestination(root, ".timds/session-check");
  for (const name of removing) await fs.rm(path.join(root, name), { force: true });
  for (const directory of emptyDirectories) await fs.rmdir(directory);
  for (const [name, bytes] of writes.filter(([, bytes]) => bytes !== undefined)) {
    const destination = path.join(root, name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    if (local.get(name)?.mode === "120000") await fs.rm(destination, { force: true });
    if (bytes.mode === "120000") { await fs.rm(destination, { force: true }); await fs.symlink(bytes.toString("utf8"), destination); }
    else { await fs.writeFile(destination, bytes); await fs.chmod(destination, bytes.mode === "100755" ? 0o755 : 0o644); }
  }
  await writeState(root, { apiVersion: HOST_API_VERSION, provider, session, files: snapshot.files });
  return { ...snapshot, conflicts: [], applied: true };
}

/** The same implementation is called by the CLI and the editing MCP server. */
export async function runHostedCommand(command, { root = process.cwd(), systemId, note, portalUrl, token, fetchImpl, credentialsPath, dryRun = false, resolve = [], idempotencyKey } = {}) {
  const selected = command === "start" ? path.resolve(root) : await findHostedRoot(root);
  const state = await readJson(path.join(selected, SESSION_FILE));
  const configured = await workspaceProvider(selected);
  const pending = command === "start" ? await readJson(path.join(selected, PENDING_START_FILE)) : null;
  const url = portalUrl || process.env.TIMDS_PORTAL_URL || configured?.url || pending?.provider?.url;
  if (!url || configured && configured.kind !== "hosted") throw new Error(NO_HOST);
  const provider = normalizeProvider({ kind: "hosted", url });
  if (state && state.provider.url !== provider.url) throw new Error("Session belongs to a different TimDS host");
  const host = createHostProvider({ url: provider.url, token: await resolveAccessToken(provider.url, { token, credentialsPath }), fetchImpl });
  if (command === "start") {
    if (!systemId) throw new Error("start requires a design-system identifier");
    const entries = await fs.readdir(selected).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
    const pendingOnly = pending && entries.length === 1 && entries[0] === ".timds" && (await fs.readdir(path.join(selected, ".timds"))).join() === "start.json";
    if (entries.length && !pendingOnly) throw new Error("Start requires an empty destination; choose --root PATH (use --idempotency-key to recover an interrupted start there)");
    if (pending && (pending.systemId !== systemId || pending.provider?.url !== provider.url || idempotencyKey && idempotencyKey !== pending.idempotencyKey)) throw new Error("An interrupted start here belongs to another system, host, or idempotency key");
    const key = pending?.idempotencyKey || idempotencyKey || randomUUID();
    if (typeof key !== "string" || !key.trim() || key.length > 200) throw new Error("idempotency-key must contain 1–200 characters");
    await safeDestination(selected, ".timds/start-check");
    if (pending && (await fs.lstat(path.join(selected, PENDING_START_FILE))).isSymbolicLink()) throw new Error("Pending session metadata cannot be a symbolic link");
    await fs.mkdir(path.join(selected, ".timds"), { recursive: true });
    await fs.writeFile(path.join(selected, PENDING_START_FILE), `${JSON.stringify({ apiVersion: HOST_API_VERSION, systemId, provider, idempotencyKey: key }, null, 2)}\n`, { mode: 0o600 });
    const snapshot = await host.start({ systemId, idempotencyKey: key });
    decodeFiles(snapshot.files); validateSession(snapshot.session);
    const result = await applySnapshot(selected, snapshot, null, provider);
    await fs.rm(path.join(selected, PENDING_START_FILE));
    return result;
  }
  if (!state || state.apiVersion !== HOST_API_VERSION) throw new Error("No compatible TimDS session here; run timds start first.");
  if (command === "status" || command === "history") return host[command](state.session.id);
  if (command === "close") {
    const result = await host.close(state.session.id);
    await writeState(selected, { ...state, session: { ...state.session, status: "closed" } });
    return result;
  }
  if (state.session.status === "closed") throw new Error("This TimDS session is closed; start a new session.");
  if (command === "pull") return applySnapshot(selected, await host.pull(state.session.id), state, provider);
  const { files, changes } = await sessionChanges(selected, state, note);
  if (command === "submit") {
    if (dryRun) return { apiVersion: HOST_API_VERSION, dryRun: true, ...changes };
    const result = await host.submit(state.session.id, changes);
    validateSession(result.session);
    if (result.files) decodeFiles(result.files);
    await writeState(selected, { apiVersion: HOST_API_VERSION, provider, session: result.session, files: result.files || encodeFiles(files) });
    return result;
  }
  if (command === "update") {
    const resolvedPaths = typeof resolve === "string" ? [resolve] : resolve;
    if (resolvedPaths.length) {
      if (!state.pendingConflicts?.mainRevision) throw new Error("Run timds update to identify conflicts before resolving paths.");
      for (const name of resolvedPaths) if (!state.pendingConflicts.paths.includes(name)) throw new Error(`No pending conflict for ${name}`);
      changes.resolvedPaths = resolvedPaths;
      changes.mainRevision = state.pendingConflicts.mainRevision;
    }
    const result = await host.update(state.session.id, changes);
    if (result.conflicts?.length) {
      for (const name of result.conflicts) hostedPath(name);
      await writeState(selected, { ...state, pendingConflicts: { paths: result.conflicts, mainRevision: result.mainRevision } });
      return { ...result, applied: false };
    }
    return applySnapshot(selected, result, state, provider, true);
  }
  throw new Error(`Unknown hosted command: ${command}`);
}

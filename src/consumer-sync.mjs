// `timds consumer sync` and `timds consumer update`: a product that consumes
// a published Design System keeps only a version pin.
//
// In published mode `timds.consumer.json` names the system, the version the
// product is built against, and the public prefix it is published at. No
// Design System bytes are tracked in the product: `sync` fetches the bundle
// the pinned version published (`v/<version>/bundle.json` and the files it
// lists) into the gitignored `designSystem.path`, under the same paths the
// files have in the Design System tree, verifying every digest. It runs from
// `postinstall`, so a clone and an `npm ci` is all a website or an agent
// needs. A file already present with the right digest is kept, a file the
// previous sync fetched and the new bundle no longer lists is removed, and
// `.timds-bundle.json` in that directory records what is there so `check`
// can confirm the pin offline.
//
// A developer working on the Design System and the product together symlinks
// that directory to a Design System checkout; `sync` leaves a symbolic link
// alone and says where it points. A directory that is still a git submodule
// is refused: the submodule has to go first.
//
// `update` moves the pin: to a named version, or to the current published
// version read from the provenance stamp, then syncs. A pin of `current`
// follows every release at the next install instead; `sync` records which
// version that resolved to.

import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

import { BUNDLE_MANIFEST_FILE, BUNDLE_VERSION_PREFIX } from "./bundle.mjs";
import { CONSUMER_BUNDLE_RECORD_FILE, CONSUMER_MANIFEST_FILE, loadConsumer, publishedBaseUrl } from "./consumer.mjs";
import { fetchDerivedLayer } from "./derived.mjs";

export const BUNDLE_RECORD_SCHEMA_VERSION = 1;

const SYNC_HELP = `Usage:
  timds consumer sync [--root PATH]
  timds consumer update [VERSION] [--root PATH]

sync fetches the Design System bundle the product pins (designSystem.version in
${CONSUMER_MANIFEST_FILE}) into designSystem.path, verifying every file's digest;
it runs from npm's postinstall. update moves the pin to VERSION, or to the
current published version, then syncs.`;

const sha256Of = (data) => createHash("sha256").update(data).digest("hex");
const defaultOutput = (message = "") => process.stdout.write(`${message}\n`);

function safeBundlePath(value) {
  const relative = String(value ?? "");
  if (!relative || relative.startsWith("/") || relative.includes("\\") || relative.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`the published bundle lists an unsafe file path ${JSON.stringify(relative)}`);
  }
  return relative;
}

async function fetchJson(fetchImpl, url, what) {
  const response = await fetchImpl(url);
  if (response.status === 404) throw new Error(`${what} is not published at ${url}`);
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  try {
    return JSON.parse(await response.text());
  } catch (caught) {
    throw new Error(`${url} is not valid JSON: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
}

/** The routes each published website design has, for checking preview pairings offline. */
function designsSummary(designs) {
  if (!designs?.designs) return null;
  return designs.designs.map((design) => ({ id: design.id, routes: (design.pages ?? []).map((page) => page.route) }));
}

/**
 * The bundle a pin resolves to. A named version reads the immutable copy
 * directly; `current` reads the provenance stamp at the base, which names the
 * published version and where its bundle sits. Returns the manifest with
 * absolute file URLs, the version it is for, and the designs summary when
 * the caller asked for it.
 */
export async function resolvePublishedBundle({ url, version, fetchImpl = fetch, withDesigns = false }) {
  const base = String(url).replace(/\/+$/, "");
  let document;
  let resolvedVersion = version;
  let layer = null;
  if (version === "current" || withDesigns) {
    layer = await fetchDerivedLayer(base, { fetchImpl });
  }
  if (version === "current") {
    resolvedVersion = layer.system?.version ?? layer.provenance?.version ?? null;
    if (!resolvedVersion) throw new Error(`${base} publishes no version in its provenance stamp`);
    document = layer.bundle;
    if (!document) throw new Error(`${base} (version ${resolvedVersion}) publishes no consumer bundle; the Design System needs bundle.include in its timds.json`);
  } else {
    document = await fetchJson(fetchImpl, `${base}/${BUNDLE_VERSION_PREFIX}/${encodeURIComponent(version)}/${BUNDLE_MANIFEST_FILE}`, `Design System version ${version}'s bundle`);
  }
  const files = (document.files ?? []).map((file) => {
    const relative = safeBundlePath(file.path);
    const fileUrl = typeof file.url === "string" && /^https?:\/\//.test(file.url) ? file.url : `${String(document.directory ?? "").replace(/\/+$/, "")}/${relative}`;
    if (!/^https?:\/\//.test(fileUrl)) throw new Error(`the published bundle names ${relative} without an absolute URL; republish the Design System`);
    if (!/^[a-f0-9]{64}$/.test(String(file.sha256 ?? ""))) throw new Error(`the published bundle lists ${relative} without a sha256 digest`);
    return { path: relative, url: fileUrl, bytes: Number(file.bytes ?? 0), sha256: file.sha256 };
  });
  return {
    version: resolvedVersion,
    systemId: document.system?.id ?? layer?.system?.id ?? null,
    url: document.url ?? null,
    directory: document.directory ?? null,
    versioned: document.versioned ?? null,
    files,
    designs: withDesigns ? designsSummary(layer?.designs) : null,
  };
}

/** The record the last sync left in the bundle directory, or null. */
export async function readBundleRecord(directory) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(directory, CONSUMER_BUNDLE_RECORD_FILE), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function fileDigest(filePath) {
  try {
    return sha256Of(await fs.readFile(filePath));
  } catch {
    return null;
  }
}

async function download(fetchImpl, file, target) {
  const response = await fetchImpl(file.url);
  if (!response.ok) throw new Error(`${file.url} responded ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  const digest = sha256Of(body);
  if (digest !== file.sha256) throw new Error(`${file.path} downloaded from ${file.url} does not match the digest the bundle records (${digest.slice(0, 12)} vs ${file.sha256.slice(0, 12)}); the publish may be mid-flight, retry`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.timds-${process.pid}.tmp`;
  await fs.writeFile(temporary, body);
  await fs.rename(temporary, target);
}

/** Whether the product's .gitignore keeps the bundle directory out of git. */
async function gitignoreCovers(repoRoot, designSystemPath) {
  try {
    const lines = (await fs.readFile(path.join(repoRoot, ".gitignore"), "utf8")).split(/\r?\n/).map((line) => line.trim());
    return lines.some((line) => [designSystemPath, `${designSystemPath}/`, `/${designSystemPath}`, `/${designSystemPath}/`].includes(line));
  } catch {
    return false;
  }
}

/**
 * Fetch the pinned bundle into `designSystem.path`. Returns what happened:
 * `linked` (a symbolic link was left alone), `unchanged`, or `synced` with
 * the counts, and the version the pin resolved to.
 */
export async function syncConsumerBundle(rootInput = process.cwd(), { fetchImpl = fetch, output = () => {} } = {}) {
  const consumer = await loadConsumer(rootInput);
  const { designSystem, manifest, repoRoot } = consumer;
  if (designSystem.mode !== "published") {
    throw new Error(`${CONSUMER_MANIFEST_FILE} pins the Design System as a git submodule at ${designSystem.path}; sync applies to a published pin (designSystem.version). See timds consumer init --system.`);
  }
  const location = designSystem.root;
  let info = null;
  try {
    info = await fs.lstat(location);
  } catch {
    // Nothing fetched yet.
  }
  if (info?.isSymbolicLink()) {
    const target = await fs.readlink(location);
    output(`${designSystem.path} is a symbolic link to ${target}; leaving it alone (a Design System checkout serves the same paths live).`);
    return { status: "linked", target, version: null, location };
  }
  if (designSystem.commit || (info?.isDirectory() && existsSync(path.join(location, ".git")))) {
    throw new Error(`${designSystem.path} is still a git submodule. Remove it before syncing the published bundle:\n  git rm -r --cached ${designSystem.path} && rm -rf ${designSystem.path} .git/modules/${designSystem.path}\nand drop its entry from .gitmodules.`);
  }
  if (info && !info.isDirectory()) throw new Error(`${designSystem.path} exists and is not a directory`);

  const needsDesigns = Object.values(manifest.apps).some((app) => app.preview.designs && Object.keys(app.preview.designs).length);
  const resolved = await resolvePublishedBundle({ url: publishedBaseUrl(manifest.designSystem), version: designSystem.version, fetchImpl, withDesigns: needsDesigns });
  if (resolved.systemId && resolved.systemId !== designSystem.systemId) {
    throw new Error(`${CONSUMER_MANIFEST_FILE} names ${designSystem.systemId} but the bundle at ${publishedBaseUrl(manifest.designSystem)} belongs to ${resolved.systemId}`);
  }

  const previous = await readBundleRecord(location);
  const wanted = new Map(resolved.files.map((file) => [file.path, file]));
  let downloaded = 0;
  let unchanged = 0;
  for (const file of resolved.files) {
    const target = path.join(location, ...file.path.split("/"));
    if ((await fileDigest(target)) === file.sha256) {
      unchanged += 1;
      continue;
    }
    await download(fetchImpl, file, target);
    downloaded += 1;
  }
  let removed = 0;
  for (const stale of previous?.files ?? []) {
    let relative;
    try {
      relative = safeBundlePath(stale.path);
    } catch {
      continue;
    }
    if (wanted.has(relative)) continue;
    await fs.rm(path.join(location, ...relative.split("/")), { force: true });
    removed += 1;
  }

  const record = {
    schemaVersion: BUNDLE_RECORD_SCHEMA_VERSION,
    systemId: designSystem.systemId,
    pin: designSystem.version,
    version: resolved.version,
    url: resolved.url,
    directory: resolved.directory,
    versioned: resolved.versioned,
    syncedAt: new Date().toISOString(),
    files: resolved.files.map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })),
    designs: resolved.designs ?? previous?.designs ?? null,
  };
  const same = previous && previous.version === record.version && downloaded === 0 && removed === 0
    && JSON.stringify(previous.files) === JSON.stringify(record.files) && JSON.stringify(previous.designs ?? null) === JSON.stringify(record.designs ?? null);
  await fs.mkdir(location, { recursive: true });
  if (!same) await fs.writeFile(path.join(location, CONSUMER_BUNDLE_RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`);

  if (!(await gitignoreCovers(repoRoot, designSystem.path))) {
    output(`Warning: .gitignore does not list ${designSystem.path}/; the fetched bundle must never be committed.`);
  }
  const status = same ? "unchanged" : "synced";
  output(status === "unchanged"
    ? `Design System ${designSystem.systemId} ${record.version} is up to date at ${designSystem.path}/ (${record.files.length} files).`
    : `Synced Design System ${designSystem.systemId} ${record.version} into ${designSystem.path}/: ${downloaded} downloaded, ${unchanged} unchanged, ${removed} removed.`);
  return { status, version: record.version, pin: designSystem.version, location, downloaded, unchanged, removed, files: record.files.length };
}

/**
 * Move the pin to `version`, or to the current published version, then sync.
 * A pin of `current` with no version named stays `current`; the sync then
 * reports what it resolved to.
 */
export async function updateConsumerPin(rootInput = process.cwd(), { version = null, fetchImpl = fetch, output = () => {} } = {}) {
  const consumer = await loadConsumer(rootInput);
  const { designSystem, manifest, manifestPath } = consumer;
  if (designSystem.mode !== "published") {
    throw new Error(`${CONSUMER_MANIFEST_FILE} pins the Design System as a git submodule at ${designSystem.path}; update applies to a published pin (designSystem.version).`);
  }
  let target = version ? String(version).trim() : null;
  if (!target && designSystem.version !== "current") {
    const resolved = await resolvePublishedBundle({ url: publishedBaseUrl(manifest.designSystem), version: "current", fetchImpl });
    target = resolved.version;
  }
  const previous = designSystem.version;
  if (target && target !== previous) {
    const raw = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    raw.designSystem = { ...raw.designSystem, version: target };
    await fs.writeFile(manifestPath, `${JSON.stringify(raw, null, 2)}\n`);
    output(`Pinned Design System ${designSystem.systemId}: ${previous} -> ${target} in ${CONSUMER_MANIFEST_FILE}.`);
  } else {
    output(target ? `Design System ${designSystem.systemId} is already pinned at ${previous}.` : `Design System ${designSystem.systemId} follows the current release (pin: current).`);
  }
  const synced = await syncConsumerBundle(rootInput, { fetchImpl, output });
  return { previous, version: target ?? previous, changed: Boolean(target && target !== previous), synced };
}

function parseArguments(argv, { positional = 0 } = {}) {
  const options = { positional: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("-")) {
      if (options.positional.length >= positional) throw new Error(`Unexpected argument ${value}\n${SYNC_HELP}`);
      options.positional.push(value);
      continue;
    }
    const [rawName, inlineValue] = value.replace(/^--?/, "").split("=", 2);
    if (rawName === "help" || rawName === "h") {
      options.help = true;
      continue;
    }
    if (rawName !== "root") throw new Error(`Unknown option --${rawName}\n${SYNC_HELP}`);
    const next = inlineValue ?? argv[index + 1];
    if (next === undefined || next === "" || String(next).startsWith("-")) throw new Error(`--${rawName} requires a value`);
    options.root = next;
    if (inlineValue === undefined) index += 1;
  }
  return options;
}

/** `timds consumer sync [--root PATH]` */
export async function runConsumerSync(args = [], { output = defaultOutput } = {}) {
  const options = parseArguments(args);
  if (options.help) {
    output(SYNC_HELP);
    return null;
  }
  return syncConsumerBundle(options.root || process.cwd(), { output });
}

/** `timds consumer update [VERSION] [--root PATH]` */
export async function runConsumerUpdate(args = [], { output = defaultOutput } = {}) {
  const options = parseArguments(args, { positional: 1 });
  if (options.help) {
    output(SYNC_HELP);
    return null;
  }
  return updateConsumerPin(options.root || process.cwd(), { version: options.positional[0] ?? null, output });
}

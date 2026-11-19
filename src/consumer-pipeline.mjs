// Installed with the consumer workflows. This module only uses Node built-ins.
// The credentialed jobs load this file from the trusted workflow revision.
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const DESIGNER_REQUEST_MARKER = "<!-- timds-designer-request -->";
export const CONSUMER_PREVIEWS_PATH = "/api/timds/consumer-previews";
export const PREVIEW_METADATA_HEADER = "x-timds-build-metadata";

// The same limits `validateArtifact` applies to a Design System build, so the
// portal's draft-build intake accepts what this writes.
export const PREVIEW_LIMITS = Object.freeze({
  maxDepth: 20,
  maxFileBytes: 12_000_000,
  maxFiles: 2_000,
  maxScannedEntries: 5_000,
  maxTotalBytes: 80_000_000,
});

/**
 * Walk `root` with the artifact limits (depth, entry count, per-file and total
 * bytes, file count) and refuse symbolic links. Returns relative file paths.
 */
export async function scanPreviewTree(root, label = root, limits = PREVIEW_LIMITS) {
  const rootInfo = await fs.lstat(root).catch((error) => {
    if (error?.code === "ENOENT") throw new Error(`${label} does not exist`);
    throw error;
  });
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error(`${label} must be a real directory`);
  const files = [];
  let scanned = 0;
  let totalBytes = 0;
  const walk = async (directory, depth) => {
    if (depth > limits.maxDepth) throw new Error(`${label} exceeds the directory depth limit of ${limits.maxDepth}`);
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      scanned += 1;
      if (scanned > limits.maxScannedEntries) throw new Error(`${label} contains more than ${limits.maxScannedEntries} entries`);
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
      const info = await fs.lstat(absolutePath);
      if (info.isSymbolicLink()) throw new Error(`${label} cannot contain symbolic links (${relativePath})`);
      if (info.isDirectory()) {
        await walk(absolutePath, depth + 1);
        continue;
      }
      if (!info.isFile()) throw new Error(`${label} contains a non-regular file (${relativePath})`);
      if (info.size > limits.maxFileBytes) throw new Error(`${label}/${relativePath} exceeds the ${limits.maxFileBytes}-byte file limit`);
      totalBytes += info.size;
      if (totalBytes > limits.maxTotalBytes) throw new Error(`${label} exceeds the ${limits.maxTotalBytes}-byte total limit`);
      if (files.length >= limits.maxFiles) throw new Error(`${label} contains more than ${limits.maxFiles} files`);
      files.push({ bytes: info.size, path: relativePath });
    }
  };
  await walk(root, 0);
  return { files, totalBytes };
}

/**
 * The metadata header: `preview.json` without the per-route detail, the
 * changed-file list, or the dropped-file list (which travel in the archive
 * and could exceed HTTP header limits), plus counts, base64-encoded JSON like
 * the draft-build upload header.
 */
export function previewMetadataHeader(preview) {
  const { routes = [], compare = null, dropped: _dropped, ...rest } = preview;
  const metadata = {
    ...rest,
    compare: compare ? { base: compare.base, baseCommit: compare.baseCommit, status: compare.status } : null,
    changedRouteCount: preview.changedRouteCount ?? 0,
    routeCount: routes.length,
    captureCount: routes.reduce((sum, route) => sum + (route.captures?.length || 0), 0),
    designRouteCount: routes.filter((route) => route.design?.captures?.length).length,
  };
  return Buffer.from(JSON.stringify(metadata), "utf8").toString("base64");
}

// The host exchanges a service token for a short-lived Access JWT. Keep the
// response and the token pair in this trusted process, including on failures.
async function serviceAssertion(origin, serviceHeaders, fetchImpl) {
  const invalid = "The host returned an invalid service identity response";
  let response;
  try {
    response = await fetchImpl(new URL("/service-auth", origin).href, {
      method: "GET", headers: { Accept: "application/json", ...serviceHeaders },
      redirect: "error", signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("The host service identity exchange failed");
  }
  if (response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") || "")) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`The host service identity exchange failed (${response.status})`);
  }
  const chunks = [];
  let bytes = 0;
  let result;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 32_768) throw new Error(invalid);
      chunks.push(chunk);
    }
    result = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
  } catch {
    throw new Error(invalid);
  }
  const assertion = result?.assertion;
  if (typeof result?.principalId !== "string" || !result.principalId.trim() ||
      typeof assertion !== "string" || assertion.length > 16_384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(assertion)) {
    throw new Error(invalid);
  }
  return assertion;
}

export async function pipelineHeaders(portalUrl, env, token, fetchImpl = fetch) {
  const id = env.CF_ACCESS_CLIENT_ID, secret = env.CF_ACCESS_CLIENT_SECRET;
  const follower = env.TIMDS_CONSUMER_ID ? { "X-TimDS-Consumer-ID": env.TIMDS_CONSUMER_ID } : {};
  const version = { "X-TimDS-API-Version": "1", ...follower };
  if (id || secret) {
    const origin = URL.canParse(portalUrl) && new URL(portalUrl).origin;
    if (!id || !secret || !origin || !origin.startsWith("https://") || origin !== env.TIMDS_PORTAL_URL || (portalUrl !== origin && portalUrl !== origin + "/")) {
      throw new Error("Set both Access service-token variables and TIMDS_PORTAL_URL to the exact HTTPS host origin");
    }
    const serviceHeaders = { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret };
    if (env.TIMDS_ACCESS_MODE === "protected-api") return { ...version, ...serviceHeaders };
    if (env.TIMDS_ACCESS_MODE && env.TIMDS_ACCESS_MODE !== "exchange") throw new Error("TIMDS_ACCESS_MODE must be exchange or protected-api");
    return { ...version, "Cf-Access-Jwt-Assertion": await serviceAssertion(origin, serviceHeaders, fetchImpl) };
  }
  if (!token) throw new Error("Set the Access service-token pair for this follower, or use its provider’s TIMDS_ACCESS_TOKEN");
  return { ...version, Authorization: `Bearer ${token}` };
}

/** Tar and gzip `outputDir` and post it to the portal; returns `{ previewUrl }`. */
export async function uploadPreview(outputDir, { portalUrl, headers, expected, fetchImpl = fetch }) {
  const root = path.resolve(outputDir);
  let preview;
  await scanPreviewTree(root, "The preview");
  try {
    preview = JSON.parse(await fs.readFile(path.join(root, "preview.json"), "utf8"));
  } catch {
    throw new Error(`${root}/preview.json is missing or invalid; run \`timds consumer preview\` first`);
  }
  if (expected && Object.entries(expected).some(([key, value]) => preview[key] !== value)) {
    throw new Error("The preview identity does not match the pull request being published");
  }
  const workDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "timds-consumer-preview-"));
  try {
    const archivePath = path.join(workDirectory, "preview.tar.gz");
    await execute("tar", ["-czf", archivePath, "-C", root, "."], { env: { PATH: process.env.PATH, COPYFILE_DISABLE: "1" } });
    const body = await fs.readFile(archivePath);
    const url = new URL(CONSUMER_PREVIEWS_PATH, portalUrl).href;
    const response = await fetchImpl(url, {
      body,
      headers: {
        Accept: "application/json",
        ...headers,
        "Content-Type": "application/gzip",
        [PREVIEW_METADATA_HEADER]: previewMetadataHeader(preview),
      },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok && !headers.Authorization) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Publishing the preview failed (${response.status})`);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`Publishing the preview failed (${response.status}): ${String(payload.error || payload.message || response.statusText || "no detail")}`);
    }
    const previewUrl = String(payload.previewUrl || "").trim();
    if (!previewUrl) throw new Error("The portal accepted the preview but returned no previewUrl");
    return { previewUrl };
  } finally {
    await fs.rm(workDirectory, { force: true, recursive: true });
  }
}

export async function readNotesPages(url, page) {
  const notes = [];
  const cursors = new Set();
  while (true) {
    const payload = await page(url);
    if (!Array.isArray(payload?.notes)) throw new Error("The portal returned no notes list");
    for (const note of payload.notes) notes.push(note);
    const cursor = payload.nextCursor;
    if (cursor == null) return { notes };
    if (typeof cursor !== "string" || !cursor || cursors.has(cursor)) throw new Error("The portal returned an invalid notes cursor");
    cursors.add(cursor);
    url.searchParams.set("after", cursor);
  }
}

/**
 * The notes array carried by a portal PR comment: the comment holds the
 * marker `<!-- timds-designer-request -->` and a fenced ```json block whose
 * content is either an array of notes or `{ "notes": [...] }`. Returns null
 * when the comment is not a designer request; throws when it is one whose
 * json block is missing or unreadable.
 */
export function parseNotesComment(body) {
  const text = String(body ?? "").replace(/\r\n/g, "\n");
  const markerAt = text.indexOf(DESIGNER_REQUEST_MARKER);
  if (markerAt === -1) return null;
  const match = text.slice(markerAt).match(/```json[^\n]*\n([\s\S]*?)\n```/);
  if (!match) throw new Error("The designer request comment has no ```json block with its notes");
  let value;
  try {
    value = JSON.parse(match[1]);
  } catch (error) {
    throw new Error(`The designer request comment's json block is not valid JSON: ${error.message}`);
  }
  const notes = Array.isArray(value) ? value : value?.notes;
  if (!Array.isArray(notes)) throw new Error("The designer request comment's json block must be an array of notes or { \"notes\": [...] }");
  return notes;
}

// CI inputs come from the trusted event and gate. Artifacts and note IDs are data.
export async function runConsumerPipeline(action, env) {
  const portal = env.TIMDS_PORTAL_URL || "https://timds.com";
  const headers = await pipelineHeaders(portal, env, env.TIMDS_ACCESS_TOKEN);
  if (new URL(portal).protocol !== "https:") throw new Error("The pipeline endpoint must use HTTPS");
  const request = async (url, init = {}) => {
    const response = await fetch(url, { ...init, headers: { ...headers, "Content-Type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Designer notes request failed (${response.status})`);
    return response.json();
  };
  if (action === "upload") {
    const expected = { repository: env.GITHUB_REPOSITORY, app: env.APP, pullRequest: Number(env.PULL_REQUEST), commit: env.SHA, branch: env.BRANCH };
    const { previewUrl } = await uploadPreview(path.join(env.RUNNER_TEMP, "review"), { portalUrl: portal, headers, expected });
    if (new URL(previewUrl).protocol !== "https:" || /[\r\n]/.test(previewUrl)) throw new Error("Invalid preview URL");
    await fs.appendFile(env.GITHUB_OUTPUT, `preview-url=${previewUrl}\n`);
    return;
  }
  const notesUrl = new URL("/api/timds/consumer-previews/notes", portal);
  if (action === "read") {
    const manifest = JSON.parse(await fs.readFile(path.join(env.RUNNER_TEMP, "consumer.json"), "utf8"));
    const event = JSON.parse(await fs.readFile(env.GITHUB_EVENT_PATH, "utf8"));
    const comment = event.comment?.body || "";
    const selection = comment.includes(DESIGNER_REQUEST_MARKER) && comment.includes("```json") ? parseNotesComment(comment) : null;
    const selectedIds = selection && new Set(selection.map(note => note.id));
    const apps = env.APP ? [env.APP] : Object.keys(manifest.apps);
    const notes = [];
    // A manual host continuation can pick up notes already sent to this PR by a publisher.
    for (const app of apps) {
      const query = { repository: env.GITHUB_REPOSITORY, app, pullRequest: env.PULL_REQUEST, status: "open" };
      for (let attempt = 0; ; attempt++) {
        notesUrl.search = new URLSearchParams(query);
        const page = await readNotesPages(notesUrl, request);
        const candidates = page.notes.filter(note => !selectedIds || selectedIds.has(note.id));
        // The comment event can arrive before the host records successful delivery.
        if (env.CF_ACCESS_CLIENT_ID && selectedIds && attempt < 3 && candidates.some(note => note.status === "open")) {
          await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
          continue;
        }
        for (const note of candidates) {
          if (!env.CF_ACCESS_CLIENT_ID || note.status === "sent") notes.push({ ...note, app });
        }
        break;
      }
    }
    if (env.CF_ACCESS_CLIENT_ID && !selectedIds && !notes.length) {
      console.log("No outstanding notes have been applied to this pull request. A publisher can send notes from Studio.");
    }
    await fs.writeFile(path.join(env.RUNNER_TEMP, "designer-notes.json"), JSON.stringify({ notes }));
    return;
  }
  if (action !== "resolve") throw new Error("Unknown pipeline action");
  const ids = JSON.parse(env.NOTE_IDS);
  const allowed = new Set(JSON.parse(await fs.readFile(path.join(env.RUNNER_TEMP, "notes", "designer-notes.json"), "utf8")).notes.map(note => note.id));
  if (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id) || !allowed.has(id))) throw new Error("Unknown addressed note ID");
  for (const id of new Set(ids)) {
    await request(new URL(`${notesUrl.pathname}/${id}`, notesUrl), { method: "PATCH", body: JSON.stringify({ status: "addressed", commit: env.SHA }) });
  }
}

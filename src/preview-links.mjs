// Where a designer looks at the work in a workspace.
//
// A preview address that opens the system's front page sends the designer
// looking for the page that changed. This module names the pages a workspace
// changed (a website design's page and state, a concept, a viewer page) as
// routes in the built artifact, and resolves them against whichever preview
// exists: the local server (`timds dev` or `timds preview`), which shows the
// files on disk as last built, or the hosted copy of a session, which shows
// only what the last `timds update` or `submit` sent.
//
// Local is preferred whenever it is running and answers. A local server
// records its address in a per-user file outside the workspace, so nothing
// here enters a change set or a commit; a record is trusted only while its
// process is alive and its address answers with the record's token.
//
// What changed: in a hosted session, every path this workspace has sent plus
// its unsent edits (hosted.mjs keeps that list in the session's local
// metadata); in a Git checkout, the working tree plus the branch's commits
// since the default branch. With no list there is no deep link, and the
// callers name the front page.
//
// Routes are relative to the artifact entry's directory, which is how a host
// builds its live and submission addresses, so one route resolves against
// every preview.

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_STATE, DESIGNS_OUTPUT_DIRECTORY, DESIGNS_SOURCE_DIRECTORY, parsePageFile } from "./designs.mjs";
import { SESSION_FILE, sessionWorkPaths } from "./hosted.mjs";

/** The most changed pages one report links; the rest are counted. */
export const MAX_PREVIEW_LINKS = 5;
const PROBE_TIMEOUT_MS = 1000;
const LOCAL_ADDRESS = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;
const PREVIEW_HEADER = "X-TimDS-Preview";

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; }
}

function entryDirectory(manifest) {
  const directory = path.posix.dirname(String(manifest?.artifact?.entry || "index.html"));
  return directory === "." ? "" : directory;
}

/* ── what changed ───────────────────────────────────────────────────────── */

function gitPaths(root, args) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 5000, windowsHide: true },
      (error, stdout) => resolve(error ? [] : String(stdout).split("\0").filter(Boolean)));
  });
}

async function gitChangedPaths(root) {
  const [edited, untracked, head] = await Promise.all([
    gitPaths(root, ["diff", "--name-only", "-z", "--relative", "HEAD"]),
    gitPaths(root, ["ls-files", "-z", "--others", "--exclude-standard"]),
    gitPaths(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]),
  ]);
  let committed = [];
  for (const base of [head[0]?.trim(), "origin/main", "origin/master"].filter(Boolean)) {
    committed = await gitPaths(root, ["diff", "--name-only", "-z", "--relative", `${base}...HEAD`]);
    if (committed.length) break;
  }
  return [...new Set([...edited, ...untracked, ...committed])];
}

/**
 * The paths this workspace changed, relative to the design system root: a
 * hosted session's sent and unsent work, else a Git checkout's working tree
 * and branch. A workspace that is neither, or that cannot be read, has none.
 */
export async function changedWorkspacePaths(designSystemRoot) {
  const root = path.resolve(designSystemRoot);
  try {
    if (existsSync(path.join(root, SESSION_FILE))) return await sessionWorkPaths(root);
    return await gitChangedPaths(root);
  } catch {
    return [];
  }
}

/* ── changed paths to routes ────────────────────────────────────────────── */

/**
 * The built pages the changed paths show, most specific first: design pages
 * (a state when the file is one), a design's own page for its other files,
 * concepts, then viewer pages. A design page maps by the designs contract
 * alone; a concept or viewer page is kept only when the built artifact has
 * it, so a custom build is never guessed at. Returns `{ routes, more }`,
 * `more` counting the pages past MAX_PREVIEW_LINKS.
 */
export async function previewRoutes(designSystemRoot, changedPaths, { manifest = null } = {}) {
  const root = path.resolve(designSystemRoot);
  const resolved = manifest ?? await readJson(path.join(root, "timds.json"));
  const dist = path.join(root, "dist", ...entryDirectory(resolved).split("/").filter(Boolean));
  const source = (relative) => existsSync(path.join(root, ...relative.split("/")));
  const built = (route) => existsSync(path.join(dist, ...route.split("/").filter(Boolean), ...(route.endsWith("/") ? ["index.html"] : [])));
  const designPages = [], designRoots = new Map(), concepts = [], pages = [];
  let site;

  for (const changed of [...new Set(changedPaths)].sort()) {
    const design = new RegExp(`^${DESIGNS_SOURCE_DIRECTORY}/([^/]+)/(.+)$`).exec(changed);
    if (design) {
      const [, id, rest] = design;
      if (!source(`${DESIGNS_SOURCE_DIRECTORY}/${id}/design.json`)) continue;
      const home = `/${DESIGNS_OUTPUT_DIRECTORY}/${id}/`;
      designRoots.set(id, { route: home, source: changed });
      if (!rest.startsWith("pages/") || !rest.endsWith(".html") || !source(changed)) continue;
      try {
        const { route, state } = parsePageFile(rest.slice("pages/".length), changed);
        const directory = `/${DESIGNS_OUTPUT_DIRECTORY}/${id}${route === "/" ? "" : route}`;
        designPages.push({ design: id, route: state === DEFAULT_STATE ? `${directory}/` : `${directory}/${state}.html`, source: changed });
      } catch { /* a misnamed page is check's to report; the design's own page still shows it */ }
      continue;
    }
    const concept = /^src\/concepts\/([^/]+)\//.exec(changed);
    if (concept) {
      const route = `/concepts/${concept[1]}/`;
      if (built(route) && !concepts.some((entry) => entry.route === route)) concepts.push({ route, source: changed });
      continue;
    }
    const page = /^src\/pages\/(.+)\.html$/.exec(changed);
    if (page && source(changed)) {
      site ??= await readJson(path.join(root, "src", "site.json")) ?? {};
      // The viewer's addresses: the overview at /, a view's own page at
      // /<view>/, and the two swapped for the view `home` names.
      const [, name] = page;
      const view = name.endsWith("/index") ? name.slice(0, -"/index".length) : null;
      const route = name === "index" ? (site.home ? "/overview/" : "/") : view !== null ? (site.home === view ? "/" : `/${view}/`) : `/${name}/`;
      if (built(route)) pages.push({ route, source: changed });
    }
  }

  const listed = new Set(designPages.map((entry) => entry.design));
  const all = [
    ...designPages.map(({ route, source: from }) => ({ route, source: from })),
    ...[...designRoots].filter(([id]) => !listed.has(id)).map(([, entry]) => entry),
    ...concepts,
    ...pages,
  ];
  return { routes: all.slice(0, MAX_PREVIEW_LINKS), more: Math.max(0, all.length - MAX_PREVIEW_LINKS) };
}

/**
 * A route under a preview address. The address is where the artifact entry
 * is served (an origin, a directory, or the entry file itself); one that
 * carries a query or a fragment is not a directory of files, so it gets no
 * deep link and null is returned.
 */
export function previewAddress(base, route = "/") {
  let url;
  try { url = new URL(base); } catch { return null; }
  if (!/^https?:$/.test(url.protocol) || url.search || url.hash) return null;
  const directory = /\.html?$/i.test(url.pathname) ? url.pathname.replace(/[^/]*$/, "") : url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  url.pathname = `${directory}${route.replace(/^\/+/, "")}`;
  return url.href;
}

/* ── the local server ───────────────────────────────────────────────────── */

function recordDirectory() {
  let user = "user";
  try { user = String(os.userInfo().uid); } catch { /* no account entry: one shared name */ }
  return path.join(os.tmpdir(), `timds-previews-${user}`);
}

function recordFile(root) {
  let real = path.resolve(root);
  try { real = realpathSync(real); } catch { /* a missing folder keeps its given path */ }
  return { real, file: path.join(recordDirectory(), `${createHash("sha256").update(real).digest("hex").slice(0, 32)}.json`) };
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

/**
 * Record that `server`, listening on 127.0.0.1 in this process, serves the
 * workspace's built artifact. Every answer from then on carries the record's
 * token in an X-TimDS-Preview header, which is how a later command tells this
 * server from another one that took its port. The record is removed when the
 * server closes, and records of processes that have ended are pruned here,
 * so a killed server leaves nothing behind for long. Never throws: a preview
 * that cannot be recorded is still a preview.
 */
export async function recordLocalPreview(designSystemRoot, server) {
  const { real, file } = recordFile(designSystemRoot);
  try {
    const token = randomUUID();
    server.prependListener("request", (_request, response) => { response.setHeader(PREVIEW_HEADER, token); });
    server.once("close", () => { void readJson(file).then((record) => record?.token === token && fs.rm(file, { force: true })).catch(() => {}); });
    const directory = path.dirname(file);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    for (const name of await fs.readdir(directory)) {
      const other = path.join(directory, name);
      if (other !== file && !alive((await readJson(other))?.pid)) await fs.rm(other, { force: true });
    }
    await fs.writeFile(file, `${JSON.stringify({ root: real, pid: process.pid, url: `http://127.0.0.1:${server.address().port}`, token })}\n`, { mode: 0o600 });
  } catch { /* unrecorded */ }
}

/**
 * The local preview of this workspace when one is running and working: its
 * record names this folder, its process is alive, and its address answers
 * with the record's token. Returns `{ url }` (the origin) or null. A record
 * whose process has ended is removed.
 */
export async function findLocalPreview(designSystemRoot, { fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const { real, file } = recordFile(designSystemRoot);
  const record = await readJson(file);
  if (!record) return null;
  if (record.root !== real || !LOCAL_ADDRESS.test(String(record.url)) || !alive(record.pid)) {
    await fs.rm(file, { force: true }).catch(() => {});
    return null;
  }
  try {
    const response = await fetchImpl(`${record.url}/`, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    await response.body?.cancel().catch(() => {});
    return response.status < 500 && response.headers.get(PREVIEW_HEADER) === record.token ? { url: record.url } : null;
  } catch {
    return null;
  }
}

/* ── the report ─────────────────────────────────────────────────────────── */

/**
 * Where this workspace's work is looked at. `routes` are the changed pages;
 * `local` is the running local preview with an address per route (the front
 * page when nothing specific changed), or null; `hosted` is the same for the
 * session's hosted copy when the workspace is a session with a live address
 * (`liveUrl` overrides the one the session last recorded). `preferred` is
 * "local" whenever that preview works, else "hosted", else null.
 */
export async function workspacePreview(designSystemRoot, { manifest = null, liveUrl, fetchImpl } = {}) {
  const root = path.resolve(designSystemRoot);
  const resolved = manifest ?? await readJson(path.join(root, "timds.json"));
  const { routes, more } = await previewRoutes(root, await changedWorkspacePaths(root), { manifest: resolved });
  const targets = routes.length ? routes.map((entry) => entry.route) : ["/"];
  const running = await findLocalPreview(root, fetchImpl ? { fetchImpl } : {});
  // The local servers serve dist/ itself, so the entry's directory is part of the address there.
  const localBase = running && `${running.url}/${entryDirectory(resolved)}`;
  const live = liveUrl ?? (await readJson(path.join(root, SESSION_FILE)))?.session?.liveUrl;
  const hostedUrls = live ? targets.map((route) => previewAddress(live, route)).filter(Boolean) : [];
  const local = running ? { url: running.url, urls: targets.map((route) => previewAddress(localBase, route)) } : null;
  const hosted = live ? { url: live, urls: hostedUrls.length ? hostedUrls : [live] } : null;
  return { routes, more, local, hosted, preferred: local ? "local" : hosted ? "hosted" : null };
}

/**
 * The report as lines for a person or an agent reading command output.
 * `cli` is the command name to suggest; `started` is false right after a
 * start or join, where the next-step lines already say to run dev.
 */
export function previewLines(preview, { cli = "timds", started = true } = {}) {
  const lines = [];
  const extra = preview.more ? ` (and ${preview.more} more changed page${preview.more === 1 ? "" : "s"})` : "";
  if (preview.local) {
    preview.local.urls.forEach((url, index) => lines.push(`Preview: ${url}${index === preview.local.urls.length - 1 ? extra : ""}`));
    if (preview.hosted) lines.push(`Hosted copy, for someone on another machine (shows only what the last ${cli} update sent): ${preview.hosted.urls[0]}`);
    return lines;
  }
  if (preview.hosted) {
    if (started) lines.push(`Local preview: not running. Start it with ${cli} dev and give the designer that address; it shows edits as soon as ${cli} check builds them.`);
    preview.hosted.urls.forEach((url, index) => lines.push(`Hosted copy (shows only what the last ${cli} update sent): ${url}${index === preview.hosted.urls.length - 1 ? extra : ""}`));
    return lines;
  }
  if (preview.routes.length) lines.push(`Preview: start ${cli} dev, then open ${preview.routes.map((entry) => entry.route).join(", ")}${extra}`);
  return lines;
}

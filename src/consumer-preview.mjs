// Reviewable previews of a consumer product, for designer pull requests.
//
// `timds consumer preview --app NAME` turns one app declared in
// `timds.consumer.json` into a self-contained review folder at
// `.timds/preview/<app>/`: `preview.json` (who, what, which commit), a gallery
// `index.html` with relative links only, and either the static build under
// `site/` (static mode: `build` + `output`) or, for every route × viewport ×
// color scheme, a full-page PNG under `captures/` and the rendered DOM under
// `pages/` (crawl mode: `serve` + `port` + `routes`, or `build` + `output` +
// `routes`, which serves the build with the toolkit's static server).
// Crawl captures also write an element map per capture under `maps/` (each
// visible element's rectangle, selector, text, and source stamp, relative to
// the repository). `preview.discover` adds routes found by following
// same-origin links and the sitemap. `--base REF` builds the merge base of
// REF and HEAD first, in a temporary git worktree, and compares: changed
// routes get `base/captures/` copies and `diffs/` overlays, and each route
// lists the changed files its element maps point at (`affectedBy`).
// `--publish` tars that folder and posts it to the portal, which returns the
// private preview URL the PR workflow comments.
//
// Boundary: TimDS never builds the product. It runs the product's declared
// `install`, `build`, and `serve` commands in the app's cwd (for the base,
// as the base's own manifest declares them) and captures what a reviewer
// would see; nothing here knows a framework. The manifest is read by
// `consumer.mjs`, the browser is driven by `consumer-browser.mjs`, pixels are
// compared by `consumer-png.mjs`, and the portal owns storage, access, and
// the interactive review page; the gallery here is the script-free fallback.

import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { fileURLToPath } from "node:url";

import { resolveAccessToken } from "./auth.mjs";
import { MAX_MAP_ELEMENTS, launchBrowser as launchChrome } from "./consumer-browser.mjs";
import { diffPngs, pngSize } from "./consumer-png.mjs";
import {
  CONSUMER_MANIFEST_FILE,
  consumerPreviewMode,
  loadConsumer,
  matchesGlob,
  resolveConsumerApp,
  validateConsumerManifest,
} from "./consumer.mjs";
import { createPreviewServer, execute } from "./core.mjs";
import { portalEndpoint } from "./media.mjs";

export const PREVIEW_SCHEMA_VERSION = 1;
export const PREVIEW_VIEWPORTS = Object.freeze({
  desktop: Object.freeze({ width: 1440, height: 900 }),
  tablet: Object.freeze({ width: 1024, height: 768 }),
  phone: Object.freeze({ width: 390, height: 844 }),
});
export const CONSUMER_PREVIEWS_PATH = "/api/timds/consumer-previews";
export const PREVIEW_METADATA_HEADER = "x-timds-build-metadata";
const DEFAULT_PORTAL_URL = "https://timds.com";
const DEFAULT_READY_TIMEOUT_MS = 120_000;

// The same limits `validateArtifact` applies to a Design System build, so the
// portal's draft-build intake accepts what this writes.
export const PREVIEW_LIMITS = Object.freeze({
  maxDepth: 20,
  maxFileBytes: 12_000_000,
  maxFiles: 2_000,
  maxScannedEntries: 5_000,
  maxTotalBytes: 80_000_000,
});

const PREVIEW_HELP = `Usage:
  timds consumer preview --app NAME [--root PATH] [--output DIR] [--no-install] [--base REF]
                         [--ready-timeout SECONDS] [--publish] [--pull-request N] [--portal-url URL]`;

const noop = () => {};

// The product's install, build, and serve commands run code from the branch
// under review and its dependencies; they never receive the portal token.
function productEnvironment(env) {
  const { TIMDS_ACCESS_TOKEN: _token, ...rest } = env;
  return rest;
}

// ---------------------------------------------------------------------------
// Naming and provenance

/** "root" for "/", otherwise the path with every run of non-alphanumerics collapsed to "-". */
export function routeSlug(route) {
  const slug = String(route || "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "root";
}

/** OWNER/REPO from a git remote URL (https, ssh, or scp-like), or null. */
export function normalizeRepository(remoteUrl) {
  const value = String(remoteUrl || "").trim();
  if (!value) return null;
  let pathname;
  const scp = value.match(/^[^@/\s]+@[^:/\s]+:(.+)$/);
  if (scp) pathname = scp[1];
  else {
    try {
      pathname = new URL(value).pathname;
    } catch {
      pathname = value;
    }
  }
  const segments = pathname.replace(/\.git\/?$/, "").split("/").filter(Boolean);
  if (segments.length < 2) return null;
  return `${segments.at(-2)}/${segments.at(-1)}`;
}

/** The pull request number from `--pull-request`, else from `GITHUB_REF` (`refs/pull/N/...`), else null. */
export function resolvePullRequest(flag, env = process.env) {
  if (flag !== undefined && flag !== null && flag !== "") {
    const number = Number(flag);
    if (!Number.isInteger(number) || number < 1) throw new Error("--pull-request must be a positive integer");
    return number;
  }
  const match = String(env.GITHUB_REF || "").match(/^refs\/pull\/(\d+)\//);
  return match ? Number(match[1]) : null;
}

async function gitValue(args, cwd) {
  const result = await execute(["git", ...args], { allowFailure: true, capture: true, cwd }).catch(() => null);
  return result && result.code === 0 ? result.stdout.trim() || null : null;
}

async function repositoryProvenance(repoRoot, env) {
  const repository = normalizeRepository(await gitValue(["remote", "get-url", "origin"], repoRoot))
    || normalizeRepository(env.GITHUB_REPOSITORY ? `https://github.com/${env.GITHUB_REPOSITORY}` : "");
  const headRef = String(env.GITHUB_HEAD_REF || "").trim();
  const branch = headRef
    || await gitValue(["symbolic-ref", "--quiet", "--short", "HEAD"], repoRoot)
    || (/^\d+\/merge$/.test(String(env.GITHUB_REF_NAME || "")) ? null : String(env.GITHUB_REF_NAME || "").trim() || null);
  const commit = await gitValue(["rev-parse", "HEAD"], repoRoot);
  return { branch, commit, repository };
}

function timestamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------------------
// Files

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
      if (!info.isFile()) continue;
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

async function copyPreviewTree(source, destination, label) {
  const { files } = await scanPreviewTree(source, label);
  for (const file of files) {
    const target = path.join(destination, ...file.path.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(source, ...file.path.split("/")), target);
  }
  return files.length;
}

/** Empty the output directory, refusing to clear one that is not a previous preview. */
async function prepareOutputDirectory(outputDir) {
  let entries = [];
  try {
    entries = await fs.readdir(outputDir);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (entries.length && !entries.includes("preview.json")) {
    throw new Error(`${outputDir} is not empty and is not a previous preview; choose another --output`);
  }
  await fs.rm(outputDir, { force: true, recursive: true });
  await fs.mkdir(outputDir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Servers

function portInUse(port) {
  const probe = (host) => new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1_000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
  return Promise.all([probe("127.0.0.1"), probe("::1")]).then((results) => results.some(Boolean));
}

function killProcessTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const signal = (name) => {
    try {
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else process.kill(-child.pid, name);
    } catch {
      try {
        child.kill(name);
      } catch {
        // Already gone.
      }
    }
  };
  signal("SIGTERM");
  const forced = setTimeout(() => signal("SIGKILL"), 5_000);
  return Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]).finally(() => clearTimeout(forced));
}

/**
 * Start the app's `serve` command in its cwd, its output captured, and wait
 * until `http://127.0.0.1:<port><ready>` (or `[::1]`) answers 200.
 */
export async function startAppServer(command, { cwd, env = process.env, port, ready = "/", timeoutMs = DEFAULT_READY_TIMEOUT_MS } = {}) {
  if (await portInUse(port)) {
    throw new Error(`Port ${port} is already in use; stop whatever is listening there so the preview captures this branch`);
  }
  const child = spawn(command[0], command.slice(1), {
    cwd,
    detached: process.platform !== "win32",
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  const append = (chunk) => {
    log = (log + chunk).slice(-20_000);
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  let exit = null;
  let spawnError = null;
  child.on("exit", (code, signal) => {
    exit = { code, signal };
  });
  child.on("error", (error) => {
    spawnError = error;
  });
  const stop = () => killProcessTree(child);
  const tail = () => (log.trim() ? `\n--- serve output (tail) ---\n${log.trim().split("\n").slice(-40).join("\n")}` : "");
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;
  while (Date.now() < deadline) {
    if (spawnError) {
      await stop();
      throw new Error(`Could not start ${command.join(" ")}: ${spawnError.message}`);
    }
    if (exit) throw new Error(`${command.join(" ")} exited (${exit.signal || `code ${exit.code}`}) before ${ready} answered on port ${port}${tail()}`);
    for (const host of ["127.0.0.1", "[::1]"]) {
      const origin = `http://${host}:${port}`;
      try {
        const response = await fetch(`${origin}${ready}`, { signal: AbortSignal.timeout(5_000) });
        await response.arrayBuffer().catch(() => {});
        lastStatus = response.status;
        if (response.status === 200) return { child, log: () => log, origin, stop };
      } catch {
        // Not listening on this host yet.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await stop();
  throw new Error(`${ready} on port ${port} did not answer 200 within ${Math.round(timeoutMs / 1000)}s${lastStatus ? ` (last status ${lastStatus})` : ""}${tail()}`);
}

async function startStaticServer(root) {
  const server = createPreviewServer({ artifactRoot: root, entryPath: "index.html" });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// Interrupts

// One SIGINT/SIGTERM handler for the whole run: every server, browser, and
// temporary worktree registers its cleanup here, and an interrupt runs them
// all before exiting, so nothing is left listening or checked out.
function interruptGuard() {
  const cleanups = new Set();
  let interrupted = false;
  const handler = () => {
    if (interrupted) return;
    interrupted = true;
    Promise.allSettled([...cleanups].reverse().map((cleanup) => cleanup())).finally(() => process.exit(130));
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return {
    add(cleanup) {
      cleanups.add(cleanup);
      return () => cleanups.delete(cleanup);
    },
    dispose() {
      process.off("SIGINT", handler);
      process.off("SIGTERM", handler);
    },
  };
}

async function waitForPortFree(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portInUse(port))) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Route discovery

const PAGE_EXTENSIONS = new Set(["", ".asp", ".aspx", ".htm", ".html", ".jsp", ".php", ".shtml", ".xhtml"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_SITEMAPS = 10;

/** The dedupe key of a route path: "/about/" and "/about" are one page. */
export function routeKey(routePath) {
  const value = String(routePath || "/");
  return value.length > 1 ? value.replace(/\/+$/, "") || "/" : value;
}

function excludedRoute(routePath, exclude) {
  const key = routeKey(routePath);
  return exclude.some((glob) => matchesGlob(key, glob) || matchesGlob(routePath, glob));
}

/**
 * The route path `href` points at when it is a same-origin page worth
 * capturing (query and hash stripped; loopback aliases on the same port count
 * as the same origin), or null when it is off-origin, has a non-page file
 * extension, or matches an `exclude` glob.
 */
export function discoverablePath(href, origin, exclude = []) {
  let home;
  let url;
  try {
    home = new URL(origin);
    url = new URL(href, home);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const sameHost = url.hostname === home.hostname || (LOOPBACK_HOSTS.has(url.hostname) && LOOPBACK_HOSTS.has(home.hostname));
  if (!sameHost || url.port !== home.port || url.protocol !== home.protocol) return null;
  const pathname = url.pathname || "/";
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  const dot = last.lastIndexOf(".");
  if (!PAGE_EXTENSIONS.has(dot > 0 ? last.slice(dot).toLowerCase() : "")) return null;
  if (excludedRoute(pathname, exclude)) return null;
  return pathname;
}

/** The `<loc>` values of a sitemap or sitemap index, and whether it is an index. */
export function parseSitemap(xml) {
  const text = String(xml || "");
  const decode = (value) => value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
  return {
    index: /<sitemapindex[\s>]/i.test(text),
    locs: [...text.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]*?)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((match) => decode(match[1])).filter(Boolean),
  };
}

// Sitemap entries carry the production host; only their paths are used, on
// the app's own origin. Nested sitemaps are followed up to MAX_SITEMAPS.
async function sitemapRoutes(origin, exclude) {
  const routes = [];
  const queue = ["/sitemap.xml"];
  const seen = new Set();
  while (queue.length && seen.size < MAX_SITEMAPS) {
    const target = queue.shift();
    if (seen.has(target)) continue;
    seen.add(target);
    let text;
    try {
      const response = await fetch(`${origin}${target}`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) {
        await response.arrayBuffer().catch(() => {});
        continue;
      }
      text = await response.text();
    } catch {
      continue;
    }
    const { index, locs } = parseSitemap(text);
    for (const loc of locs) {
      let url;
      try {
        url = new URL(loc, origin);
      } catch {
        continue;
      }
      if (index) queue.push(`${url.pathname}${url.search}`);
      else {
        const routePath = discoverablePath(`${origin}${url.pathname}`, origin, exclude);
        if (routePath) routes.push(routePath);
      }
    }
  }
  return routes;
}

/**
 * Visit the declared routes, then, with `discover`, breadth-first from
 * `discover.from` (the sitemap's pages join after the first level), then the
 * `extra` paths, admitting at most `discover.limit` routes beyond the
 * declared ones. `visit(path, { declared })` captures one route and resolves
 * to the hrefs it links to. Returns the discovered paths in visiting order.
 */
async function walkRoutes({ declared, discover, extra = [], origin, visit }) {
  const known = new Set();
  const hrefs = new Map();
  const discovered = [];
  for (const routePath of declared) {
    if (known.has(routeKey(routePath))) continue;
    known.add(routeKey(routePath));
    hrefs.set(routeKey(routePath), (await visit(routePath, { declared: true })) || []);
  }
  if (!discover) return { discovered };
  const full = () => discovered.length >= discover.limit;
  const admit = async (routePath) => {
    const key = routeKey(routePath);
    if (known.has(key) || full()) return false;
    known.add(key);
    discovered.push(routePath);
    hrefs.set(key, (await visit(routePath, { declared: false })) || []);
    return true;
  };
  const queue = [];
  for (const start of discover.from) {
    await admit(start);
    queue.push(start);
  }
  let firstLevel = queue.length;
  let sitemapRead = false;
  while (queue.length && !full()) {
    const current = queue.shift();
    for (const href of hrefs.get(routeKey(current)) || []) {
      if (full()) break;
      const candidate = discoverablePath(href, origin, discover.exclude);
      if (candidate && await admit(candidate)) queue.push(candidate);
    }
    firstLevel -= 1;
    if (firstLevel <= 0 && !sitemapRead) {
      sitemapRead = true;
      for (const candidate of await sitemapRoutes(origin, discover.exclude)) {
        if (full()) break;
        if (await admit(candidate)) queue.push(candidate);
      }
    }
  }
  for (const routePath of extra) {
    if (full()) break;
    await admit(routePath);
  }
  return { discovered };
}

// ---------------------------------------------------------------------------
// Element maps and source stamps

/**
 * A source stamp's file as a repository-relative path: the absolute
 * repository root (or a temporary worktree root) is stripped; a path that
 * exists under the app's cwd is prefixed with it; anything else is returned
 * as given.
 */
export function normalizeSourceFile(file, { repoRoot, roots = [], appCwd = ".", exists = existsSync } = {}) {
  let value = String(file ?? "").trim();
  if (!value) return null;
  if (value.startsWith("file://")) {
    try {
      value = fileURLToPath(value);
    } catch {
      // Keep the URL text.
    }
  }
  value = value.replace(/\\/g, "/");
  const prefixes = [repoRoot, ...roots].filter(Boolean).map((root) => String(root).replace(/\\/g, "/").replace(/\/+$/, ""));
  for (const prefix of prefixes) {
    if (value.startsWith(`${prefix}/`)) return value.slice(prefix.length + 1);
  }
  const inner = value.replace(/^\.?\/+/, "");
  if (repoRoot && inner && appCwd && appCwd !== "." && exists(path.join(repoRoot, appCwd, inner))) {
    return path.posix.join(appCwd, inner);
  }
  if (value.startsWith("/")) {
    // A root-relative stamp ("/src/App.tsx", as Vite plugins emit) that is a file in the repository.
    if (repoRoot && inner && exists(path.join(repoRoot, inner))) return inner;
    return value;
  }
  return inner || value;
}

async function sourceNormalizer(repoRoot, appCwd, extraRoots = []) {
  const roots = [];
  for (const root of [repoRoot, ...extraRoots]) {
    roots.push(root);
    const real = await fs.realpath(root).catch(() => null);
    if (real && real !== root) roots.push(real);
  }
  const cache = new Map();
  const existsCached = (target) => {
    if (!cache.has(target)) cache.set(target, existsSync(target));
    return cache.get(target);
  };
  return (file) => normalizeSourceFile(file, { appCwd, exists: existsCached, repoRoot, roots: roots.slice(1) });
}

function elementMapRecord(map, normalizeSource) {
  const elements = (Array.isArray(map?.elements) ? map.elements : []).slice(0, MAX_MAP_ELEMENTS).map((element) => {
    const file = element?.source?.file ? normalizeSource(element.source.file) : null;
    return {
      id: String(element.id),
      rect: element.rect,
      selector: String(element.selector),
      tag: String(element.tag),
      text: String(element.text ?? ""),
      source: file ? { file, line: element.source.line ?? null, column: element.source.column ?? null } : null,
    };
  });
  return { schemaVersion: 1, width: map.width, height: map.height, elements };
}

// ---------------------------------------------------------------------------
// Crawl

function previewCells(preview) {
  const cells = [];
  for (const scheme of preview.schemes) {
    for (const viewport of preview.viewports) {
      const size = PREVIEW_VIEWPORTS[viewport];
      if (!size) throw new Error(`Unknown viewport ${viewport}; use ${Object.keys(PREVIEW_VIEWPORTS).join(", ")}`);
      cells.push({ height: size.height, name: `${viewport}-${scheme}`, scheme, viewport, width: size.width });
    }
  }
  return cells;
}

const missingStatus = (status) => status === 404 || status === 410;
const roundRatio = (ratio) => Number(ratio.toFixed(6));

async function writeOutputFile(outputDir, file, content, encoding) {
  const target = path.join(outputDir, ...file.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, encoding);
}

/**
 * Capture every route on the base into `tempDir` (the full viewport × scheme
 * matrix, since which routes changed is only known once the head is
 * captured). Returns `{ discovered, routes }`, `routes` keyed by `routeKey`.
 */
async function captureBaseRoutes(browser, origin, preview, cells, tempDir, { captureTimeoutMs, output }) {
  const routes = new Map();
  const visit = async (routePath) => {
    const entry = { cells: new Map(), path: routePath, status: null };
    const directory = path.join(tempDir, String(routes.size + 1));
    routes.set(routeKey(routePath), entry);
    let links = [];
    for (const [index, cell] of cells.entries()) {
      let shot;
      try {
        shot = await browser.capture({ height: cell.height, links: index === 0, scheme: cell.scheme, timeoutMs: captureTimeoutMs, url: `${origin}${routePath}`, width: cell.width });
      } catch {
        continue;
      }
      if (index === 0) links = shot.links || [];
      if (entry.status === null && shot.status !== null && shot.status !== undefined) entry.status = shot.status;
      const file = path.join(directory, `${cell.name}.png`);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(file, shot.png);
      entry.cells.set(cell.name, file);
    }
    output(`Captured ${routePath} on the base (${entry.cells.size} of ${cells.length})`);
    return links;
  };
  const { discovered } = await walkRoutes({ declared: preview.routes || [], discover: preview.discover, origin, visit });
  if (![...routes.values()].some((entry) => entry.cells.size)) throw new Error("no route could be captured on the base");
  return { discovered, routes };
}

/**
 * Capture the head. Without a base, every route gets the full matrix. With
 * one, each route's first viewport and scheme is captured and compared
 * first (the detect pass); declared routes, and routes that changed, were
 * added or removed, or cannot be compared, then get the full matrix with
 * base copies and diff overlays (the detail pass). Unchanged discovered
 * routes are listed without captures.
 */
async function captureHeadRoutes(browser, origin, preview, cells, outputDir, { base, captureTimeoutMs, normalizeSource, output }) {
  const routes = [];
  const sources = new Map();
  const slugCounts = new Map();
  let anyCaptured = false;
  const nextSlug = (routePath) => {
    const slug = routeSlug(routePath);
    const count = (slugCounts.get(slug) || 0) + 1;
    slugCounts.set(slug, count);
    return count === 1 ? slug : `${slug}-${count}`;
  };
  const visit = async (routePath, { declared }) => {
    const slug = nextSlug(routePath);
    const route = { path: routePath, slug, declared, discovered: !declared, html: null, pages: [], status: null, change: "unknown", affectedBy: [], captures: [] };
    const routeSources = new Set();
    routes.push(route);
    sources.set(route, routeSources);
    const baseEntry = base ? base.routes.get(routeKey(routePath)) || null : null;
    const failures = [];
    let links = [];
    let detail = !base || declared;
    for (const [index, cell] of cells.entries()) {
      let shot = null;
      try {
        shot = await browser.capture({
          elementMap: true,
          height: cell.height,
          links: index === 0,
          scheme: cell.scheme,
          timeoutMs: captureTimeoutMs,
          url: `${origin}${routePath}`,
          width: cell.width,
        });
      } catch (error) {
        failures.push(`${cell.viewport}/${cell.scheme}: ${error.message}`);
      }
      if (shot) {
        anyCaptured = true;
        if (index === 0) links = shot.links || [];
        if (route.status === null && shot.status !== null && shot.status !== undefined) route.status = shot.status;
      }
      const map = shot?.map ? elementMapRecord(shot.map, normalizeSource) : null;
      for (const element of map?.elements || []) if (element.source?.file) routeSources.add(element.source.file);
      if (index === 0 && base) {
        route.change = await detectChange(baseEntry, route.status, cell, shot);
        detail = detail || route.change !== "unchanged";
      }
      if (!detail) break;
      if (!shot) continue;
      if (shot.png.length > PREVIEW_LIMITS.maxFileBytes) {
        failures.push(`${cell.viewport}/${cell.scheme}: the capture is ${shot.png.length} bytes, over the ${PREVIEW_LIMITS.maxFileBytes}-byte file limit`);
        continue;
      }
      const capture = { viewport: cell.viewport, scheme: cell.scheme, width: cell.width, height: cell.height, file: `captures/${slug}/${cell.name}.png`, base: null, diff: null, map: null };
      await writeOutputFile(outputDir, capture.file, shot.png);
      if (map) {
        capture.map = `maps/${slug}/${cell.name}.json`;
        await writeOutputFile(outputDir, capture.map, `${JSON.stringify(map)}\n`, "utf8");
      }
      const baseFile = baseEntry?.cells.get(cell.name);
      if (baseFile) {
        const basePng = await fs.readFile(baseFile);
        if (basePng.length <= PREVIEW_LIMITS.maxFileBytes) {
          const size = pngSize(basePng);
          capture.base = { file: `base/captures/${slug}/${cell.name}.png`, width: size?.width ?? cell.width, height: size?.height ?? cell.height };
          await writeOutputFile(outputDir, capture.base.file, basePng);
        }
        try {
          const diff = diffPngs(basePng, shot.png);
          capture.diff = { file: null, changedPixels: diff.changedPixels, changedRatio: roundRatio(diff.changedRatio) };
          if (diff.overlay.length <= PREVIEW_LIMITS.maxFileBytes) {
            capture.diff.file = `diffs/${slug}/${cell.name}.png`;
            await writeOutputFile(outputDir, capture.diff.file, diff.overlay);
          }
          if (diff.changed && route.change === "unchanged") route.change = "changed";
        } catch (error) {
          failures.push(`${cell.viewport}/${cell.scheme}: could not compare with the base (${error.message})`);
        }
      }
      route.captures.push(capture);
      if (!route.pages.some((page) => page.scheme === cell.scheme)) {
        const page = `pages/${slug}/${cell.scheme}.html`;
        await writeOutputFile(outputDir, page, shot.html, "utf8");
        route.pages.push({ scheme: cell.scheme, file: page });
      }
    }
    route.html = route.pages[0]?.file ?? null;
    if (failures.length) {
      route.error = failures.join("; ");
      output(`Warning: ${routePath}: ${route.error}`);
    } else if (route.status && route.status >= 400) {
      output(`Warning: ${routePath} answered ${route.status}`);
    }
    const note = base ? `, ${route.change}` : "";
    output(`Captured ${routePath} (${route.captures.length} of ${cells.length}${note})`);
    return links;
  };
  const extra = base ? base.discovered : [];
  await walkRoutes({ declared: preview.routes || [], discover: preview.discover, extra, origin, visit });
  if (routes.length && !anyCaptured) {
    throw new Error(`No route could be captured:\n${routes.map((route) => `- ${route.path}: ${route.error}`).join("\n")}`);
  }
  return { routes, sources };
}

// The detect pass for one route: added or removed when exactly one side is a
// 404, else the first viewport and scheme compared pixel by pixel.
async function detectChange(baseEntry, headStatus, cell, shot) {
  if (!baseEntry || (!baseEntry.cells.size && baseEntry.status === null)) return "unknown";
  if (missingStatus(baseEntry.status) && headStatus !== null && !missingStatus(headStatus)) return "added";
  if (!missingStatus(baseEntry.status) && baseEntry.status !== null && missingStatus(headStatus)) return "removed";
  const baseFile = baseEntry.cells.get(cell.name);
  if (!baseFile || !shot) return "unknown";
  try {
    return diffPngs(await fs.readFile(baseFile), shot.png, { overlay: false }).changed ? "changed" : "unchanged";
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Compare

const shortCommit = (sha) => (sha ? String(sha).slice(0, 7) : "unknown");
const firstLine = (text) => {
  const line = String(text || "").trim().split("\n").find((entry) => entry.trim()) || "";
  return line.length > 300 ? `${line.slice(0, 297)}...` : line;
};

async function gitRun(args, cwd) {
  return execute(["git", ...args], { allowFailure: true, capture: true, cwd }).catch((error) => ({ code: -1, stderr: error.message, stdout: "" }));
}

async function resolveMergeBase(repoRoot, ref) {
  const result = await gitRun(["merge-base", ref, "HEAD"], repoRoot);
  const sha = result.code === 0 ? result.stdout.trim() : "";
  if (!sha) {
    throw new Error(`Could not find where ${ref} and HEAD diverge${result.stderr.trim() ? ` (${firstLine(result.stderr)})` : ""}. Fetch the base branch first (e.g. git fetch origin main) or pass a different --base.`);
  }
  return sha;
}

/** Files changed between the merge base and HEAD plus working-tree changes, repository-relative, sorted. */
async function changedFilesSince(repoRoot, mergeBase, ignoredPrefix) {
  const files = new Set();
  const committed = await gitRun(["diff", "--name-only", "--no-renames", "-z", `${mergeBase}...HEAD`], repoRoot);
  if (committed.code === 0) for (const file of committed.stdout.split("\0").filter(Boolean)) files.add(file);
  const status = await gitRun(["status", "--porcelain", "-z", "--no-renames", "--untracked-files=all"], repoRoot);
  if (status.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean)) files.add(entry.slice(3));
  return [...files].filter((file) => !ignoredPrefix || !(file === ignoredPrefix || file.startsWith(`${ignoredPrefix}/`))).sort();
}

/**
 * Build and capture the base in a temporary worktree at `mergeBase`, using
 * the app as the base's own manifest declares it. Resolves to
 * `{ discovered, routes }`, or `{ reason }` when the base cannot be shown;
 * the worktree is always removed and the port verified free.
 */
async function captureBaseSide({ app, captureTimeoutMs, cells, commandEnv, compareRef, consumer, guard, launchBrowser, mergeBase, output, preview, readyTimeoutMs, scratch }) {
  const repoRoot = consumer.repoRoot;
  const where = `${compareRef} (${shortCommit(mergeBase)})`;
  const shown = await gitRun(["show", `${mergeBase}:${CONSUMER_MANIFEST_FILE}`], repoRoot);
  if (shown.code !== 0) return { reason: `${CONSUMER_MANIFEST_FILE} does not exist at ${where}, so there is no earlier version of this app to compare with.` };
  let manifest;
  try {
    manifest = validateConsumerManifest(JSON.parse(shown.stdout));
  } catch (error) {
    return { reason: `${CONSUMER_MANIFEST_FILE} at ${where} could not be read: ${firstLine(error.message)}` };
  }
  if (!Object.hasOwn(manifest.apps, app.name)) return { reason: `App "${app.name}" does not exist at ${where}, so there is no earlier version of it to compare with.` };
  const baseApp = manifest.apps[app.name];
  const checkout = path.join(scratch, "base-checkout");
  let added = false;
  // Set when the base Design System is a linked worktree of the checked-out
  // submodule rather than a fresh clone; it has to go first, because git
  // refuses to remove a worktree that still contains a populated submodule.
  let linkedDesignSystem = null;
  const removeWorktree = async () => {
    if (!added) return;
    added = false;
    if (linkedDesignSystem) {
      await gitRun(["worktree", "remove", "--force", linkedDesignSystem.target], linkedDesignSystem.repository);
      await fs.rm(linkedDesignSystem.target, { force: true, recursive: true }).catch(() => {});
      await gitRun(["worktree", "prune"], linkedDesignSystem.repository);
      linkedDesignSystem = null;
    }
    await gitRun(["worktree", "remove", "--force", checkout], repoRoot);
    // Remove the folder before pruning: when git refused the removal above
    // (a populated submodule), prune only forgets a worktree whose folder is gone.
    await fs.rm(checkout, { force: true, recursive: true }).catch(() => {});
    await gitRun(["worktree", "prune"], repoRoot);
  };
  const releaseWorktree = guard.add(removeWorktree);
  try {
    output(`Checking out ${where} in a temporary worktree`);
    const worktree = await gitRun(["worktree", "add", "--detach", checkout, mergeBase], repoRoot);
    if (worktree.code !== 0) return { reason: `git could not check out ${where}: ${firstLine(worktree.stderr)}` };
    added = true;
    const designSystemPath = manifest.designSystem.path;
    // A designer change rarely moves the pin, so the commit the base needs is
    // usually already in the checked-out submodule. Linking a worktree of it
    // needs no network and no credentials, which matters in CI where the
    // submodule's credentials are scoped to the one checkout command.
    const pinned = await gitRun(["ls-tree", mergeBase, "--", designSystemPath], repoRoot);
    const basePin = /^160000 commit ([0-9a-f]{40,64})\t/m.exec(pinned.stdout)?.[1];
    const headDesignSystem = consumer.designSystem?.root;
    if (basePin && headDesignSystem && existsSync(path.join(headDesignSystem, ".git"))) {
      const available = await gitRun(["cat-file", "-e", `${basePin}^{commit}`], headDesignSystem);
      if (available.code === 0) {
        const target = path.join(checkout, designSystemPath);
        await fs.rm(target, { force: true, recursive: true });
        const linked = await gitRun(["worktree", "add", "--detach", target, basePin], headDesignSystem);
        if (linked.code === 0) linkedDesignSystem = { repository: headDesignSystem, target };
      }
    }
    if (!linkedDesignSystem) {
      const submodule = await gitRun(["submodule", "update", "--init", "--", designSystemPath], checkout);
      if (submodule.code !== 0) output(`Warning: could not check out ${designSystemPath} at ${where} (${firstLine(submodule.stderr)}); building the base without it`);
    }
    const baseCwd = path.resolve(checkout, baseApp.cwd);
    if (!existsSync(baseCwd)) return { reason: `App "${app.name}" folder ${baseApp.cwd} does not exist at ${where}.` };
    if (baseApp.install) {
      output(`Running the base install: ${baseApp.install.join(" ")}`);
      try {
        await execute(baseApp.install, { cwd: baseCwd, env: commandEnv });
      } catch (error) {
        return { reason: `The app could not be installed at ${where}: ${firstLine(error.message)}` };
      }
    }
    let server;
    const basePreview = baseApp.preview;
    try {
      if (basePreview.build) {
        output(`Running the base build: ${basePreview.build.join(" ")}`);
        await execute(basePreview.build, { cwd: baseCwd, env: commandEnv });
        const buildOutput = path.resolve(baseCwd, basePreview.output);
        if (!existsSync(buildOutput)) throw new Error(`${basePreview.output} does not exist after the build`);
        server = await startStaticServer(buildOutput);
      } else {
        output(`Starting the base: ${basePreview.serve.join(" ")} on port ${basePreview.port}`);
        server = await startAppServer(basePreview.serve, {
          cwd: baseCwd,
          env: commandEnv,
          port: basePreview.port,
          ready: basePreview.ready || "/",
          timeoutMs: readyTimeoutMs,
        });
      }
    } catch (error) {
      return { reason: `The app did not build or start at ${where}: ${firstLine(error.message)}` };
    }
    const releaseServer = guard.add(() => server.stop());
    let browser;
    try {
      browser = await launchBrowser();
      const releaseBrowser = guard.add(() => browser.close());
      try {
        return await captureBaseRoutes(browser, server.origin, preview, cells, path.join(scratch, "base-captures"), { captureTimeoutMs, output });
      } finally {
        await browser.close();
        releaseBrowser();
      }
    } catch (error) {
      return { reason: `The app at ${where} could not be captured: ${firstLine(error.message)}` };
    } finally {
      await server.stop();
      releaseServer();
      if (!basePreview.build && !(await waitForPortFree(basePreview.port))) {
        output(`Warning: port ${basePreview.port} is still in use after the base stopped`);
      }
    }
  } finally {
    await removeWorktree();
    releaseWorktree();
  }
}

// ---------------------------------------------------------------------------
// Limits

/**
 * Keep the preview inside the portal's archive limits by dropping the least
 * useful files first: before/changes images of unchanged declared routes,
 * then extra viewports of discovered routes, then discovered routes'
 * captures, then later viewports' before images of declared routes. Mutates
 * the route records and returns `[{ route, what, files }]`.
 */
async function enforcePreviewLimits(outputDir, routes, limits = PREVIEW_LIMITS) {
  // Room for preview.json and index.html, written afterwards.
  const reserveFiles = 2;
  const reserveBytes = Math.min(2_000_000, Math.floor(limits.maxTotalBytes * 0.05));
  const relaxed = { ...limits, maxFiles: Infinity, maxScannedEntries: Infinity, maxTotalBytes: Infinity };
  const { files } = await scanPreviewTree(outputDir, "The preview", relaxed);
  const sizes = new Map(files.map((file) => [file.path, file.bytes]));
  let totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const over = () => sizes.size + reserveFiles > limits.maxFiles || totalBytes + reserveBytes > limits.maxTotalBytes;
  if (!over()) return [];
  const dropped = [];
  const remove = async (route, what, list) => {
    const removed = [];
    for (const file of list.filter(Boolean)) {
      if (!sizes.has(file)) continue;
      await fs.rm(path.join(outputDir, ...file.split("/")), { force: true });
      // Remove folders the drop emptied (rmdir refuses non-empty ones).
      for (let folder = path.posix.dirname(file); folder !== "."; folder = path.posix.dirname(folder)) {
        if (!(await fs.rmdir(path.join(outputDir, ...folder.split("/"))).then(() => true, () => false))) break;
      }
      totalBytes -= sizes.get(file);
      sizes.delete(file);
      removed.push(file);
    }
    if (removed.length) dropped.push({ route: route.path, what, files: removed });
  };
  const keepPages = (route) => {
    const schemes = new Set(route.captures.map((capture) => capture.scheme));
    const gone = route.pages.filter((page) => !schemes.has(page.scheme)).map((page) => page.file);
    route.pages = route.pages.filter((page) => schemes.has(page.scheme));
    route.html = route.pages[0]?.file ?? null;
    return gone;
  };
  const backwards = (filter) => routes.filter(filter).reverse();
  const steps = [
    ...backwards((route) => route.declared && route.change === "unchanged").map((route) => async () => {
      const list = route.captures.flatMap((capture) => [capture.base?.file, capture.diff?.file]);
      for (const capture of route.captures) {
        capture.base = null;
        capture.diff = null;
      }
      await remove(route, "before and changes images of an unchanged page", list);
    }),
    ...backwards((route) => !route.declared && route.captures.length > 1).map((route) => async () => {
      const extra = route.captures.splice(1);
      const list = extra.flatMap((capture) => [capture.file, capture.base?.file, capture.diff?.file, capture.map]);
      await remove(route, "captures beyond the first viewport and scheme", [...list, ...keepPages(route)]);
    }),
    ...backwards((route) => !route.declared && route.captures.length).map((route) => async () => {
      const list = route.captures.flatMap((capture) => [capture.file, capture.base?.file, capture.diff?.file, capture.map]);
      route.captures = [];
      await remove(route, "all captures of a discovered page", [...list, ...keepPages(route)]);
    }),
    ...backwards((route) => route.declared && route.captures.length > 1).map((route) => async () => {
      const list = route.captures.slice(1).map((capture) => capture.base?.file);
      for (const capture of route.captures.slice(1)) capture.base = null;
      await remove(route, "before images beyond the first viewport and scheme", list);
    }),
  ];
  for (const step of steps) {
    if (!over()) break;
    await step();
  }
  return dropped;
}

// ---------------------------------------------------------------------------
// Gallery

const escapeHtml = (value) => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

// Every href/src is a relative path segment list; encode each segment so odd
// slugs never escape the folder and no link is ever site-absolute.
const relativeHref = (file) => String(file).split("/").map(encodeURIComponent).join("/");

const titleCase = (value) => String(value).charAt(0).toUpperCase() + String(value).slice(1);

const CHANGE_LABELS = Object.freeze({ added: "New page", changed: "Changed", removed: "Removed" });
const isChangedRoute = (route) => Object.hasOwn(CHANGE_LABELS, route.change);

function plainList(items) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function affectedSentence(route) {
  const files = route.affectedBy || [];
  if (!files.length) return "";
  const shown = files.slice(0, 6).map((file) => `<span title="${escapeHtml(file)}">${escapeHtml(path.posix.basename(file))}</span>`);
  const more = files.length > 6 ? [`${files.length - 6} more file${files.length - 6 === 1 ? "" : "s"}`] : [];
  return `<p class="affected">Likely from the edits to ${plainList([...shown, ...more])}.</p>`;
}

function renderCapture(route, capture, alt, page, counter) {
  const caption = `${escapeHtml(titleCase(capture.scheme))}${page ? ` · <a href="${relativeHref(page.file)}">Rendered HTML</a>` : ""}`;
  const after = `<a class="shot" href="${relativeHref(capture.file)}"><img src="${relativeHref(capture.file)}" alt="${escapeHtml(alt)}" loading="lazy" width="${capture.width}"></a>`;
  if (!capture.base && !capture.diff?.file) {
    return `<figure class="scheme-${escapeHtml(capture.scheme)}">
          ${after}
          <figcaption>${caption}</figcaption>
        </figure>`;
  }
  const id = `c${counter.next()}`;
  const views = [
    ["after", "After", after],
    ...(capture.base ? [["before", "Before", `<a class="shot" href="${relativeHref(capture.base.file)}"><img src="${relativeHref(capture.base.file)}" alt="${escapeHtml(`${alt}, before`)}" loading="lazy" width="${capture.width}"></a>`]] : []),
    ...(capture.diff?.file ? [["changes", "Changes", `<a class="shot" href="${relativeHref(capture.diff.file)}"><img src="${relativeHref(capture.diff.file)}" alt="${escapeHtml(`${alt}, changes highlighted`)}" loading="lazy" width="${capture.width}"></a>`]] : []),
  ];
  const ordered = ["before", "after", "changes"].map((key) => views.find((view) => view[0] === key)).filter(Boolean);
  const share = capture.diff ? ` · ${capture.diff.changedRatio > 0 ? `${(capture.diff.changedRatio * 100).toFixed(capture.diff.changedRatio < 0.001 ? 3 : 1)}% of pixels differ` : "no visible difference"}` : "";
  return `<figure class="compare scheme-${escapeHtml(capture.scheme)}">
          ${ordered.map(([key]) => `<input type="radio" class="pick pick-${key}" name="${id}" id="${id}-${key}"${key === "after" ? " checked" : ""}>`).join("")}
          <div class="tabs" role="group" aria-label="Before and after">${ordered.map(([key, label]) => `<label class="tab tab-${key}" for="${id}-${key}">${label}</label>`).join("")}</div>
          ${ordered.map(([key, , html]) => `<div class="view view-${key}">${html}</div>`).join("\n          ")}
          <figcaption>${caption}${escapeHtml(share)}</figcaption>
        </figure>`;
}

function renderRoute(route, counter) {
  const viewports = [...new Set(route.captures.map((capture) => capture.viewport))];
  const groups = viewports.map((viewport) => {
    const captures = route.captures.filter((capture) => capture.viewport === viewport);
    const { width, height } = captures[0];
    const figures = captures.map((capture) => {
      const page = route.pages?.find((entry) => entry.scheme === capture.scheme);
      const alt = `${route.path} at ${viewport} width in ${capture.scheme} mode`;
      return renderCapture(route, capture, alt, page, counter);
    }).join("\n");
    return `<div class="viewport viewport-${escapeHtml(viewport)}">
        <h3>${escapeHtml(titleCase(viewport))} <span>${width}×${height}</span></h3>
        <div class="shots">${figures}</div>
      </div>`;
  }).join("\n");
  const status = route.status ? `<span class="status${route.status >= 400 ? " bad" : ""}">${route.status}</span>` : "";
  const badge = isChangedRoute(route) ? `<span class="badge badge-${escapeHtml(route.change)}">${CHANGE_LABELS[route.change]}</span>` : "";
  const found = route.discovered ? `<span class="status">found by crawling</span>` : "";
  const error = route.error ? `<p class="error">${escapeHtml(route.error)}</p>` : "";
  const empty = route.change === "unchanged" ? "<p>No visible change.</p>" : route.error ? "" : "<p>No captures.</p>";
  return `<section id="route-${escapeHtml(route.slug)}">
      <h2><code>${escapeHtml(route.path)}</code> ${badge} ${status} ${found}</h2>
      ${affectedSentence(route)}
      ${error}
      ${groups || empty}
    </section>`;
}

/**
 * The self-contained gallery page: relative links only, no scripts. With a
 * comparison, changed routes come first, each capture has a CSS-only
 * Before / After / Changes switch, and unchanged routes sit in a collapsed
 * `<details>`.
 */
export function renderPreviewGallery(preview) {
  const facts = [
    ["App", preview.app],
    ["Repository", preview.repository || "unknown"],
    ["Branch", preview.branch || "detached"],
    ["Pull request", preview.pullRequest ? `#${preview.pullRequest}` : "none"],
    ["Commit", shortCommit(preview.commit)],
    ["Design System", `${preview.designSystem?.systemId || "unknown"} @ ${shortCommit(preview.designSystem?.commit)}`],
    ["Mode", preview.mode],
    ...(preview.compare ? [["Compared with", `${preview.compare.base} @ ${shortCommit(preview.compare.baseCommit)}`]] : []),
    ["Generated", preview.generatedAt],
  ];
  const counter = { value: 0, next() { this.value += 1; return this.value; } };
  const compare = preview.compare;
  const ready = compare?.status === "ready";
  const changed = ready ? preview.routes.filter(isChangedRoute) : [];
  const unchanged = ready ? preview.routes.filter((route) => !isChangedRoute(route)) : [];
  const ordered = ready ? [...changed, ...unchanged] : preview.routes;
  const routeNav = ordered.length
    ? `<nav aria-label="Routes"><ul>${ordered.map((route) => `<li><a href="#route-${escapeHtml(route.slug)}">${escapeHtml(route.path)}</a>${ready && isChangedRoute(route) ? " ●" : ""}</li>`).join("")}</ul></nav>`
    : "";
  const siteLink = preview.site
    ? `<p class="site"><a href="${relativeHref(preview.site)}">Open the static build</a></p>`
    : "";
  let summary = "";
  if (ready) {
    const total = preview.routes.length;
    summary = `<p class="summary">${changed.length} of ${total} page${total === 1 ? "" : "s"} changed compared with ${escapeHtml(compare.base)}.</p>`;
  } else if (compare) {
    summary = `<p class="summary unavailable">Comparison with ${escapeHtml(compare.base)} was not available: ${escapeHtml(compare.reason || "unknown reason")} The pages below show this branch only.</p>`;
  }
  const dropped = preview.dropped?.length
    ? `<p class="note">To stay within the upload limits, some images were left out: ${escapeHtml(plainList(preview.dropped.map((entry) => `${entry.what} on ${entry.route}`)))}.</p>`
    : "";
  let sections;
  if (ready) {
    const changedHtml = changed.map((route) => renderRoute(route, counter)).join("\n");
    const unchangedHtml = unchanged.length
      ? `<details class="unchanged"><summary>${unchanged.length} page${unchanged.length === 1 ? "" : "s"} without visible changes</summary>
${unchanged.map((route) => renderRoute(route, counter)).join("\n")}
</details>`
      : "";
    sections = `${changedHtml}\n${unchangedHtml}`;
  } else {
    sections = preview.routes.map((route) => renderRoute(route, counter)).join("\n");
  }
  const empty = !preview.routes.length && !preview.site ? "<p>This preview has no routes or build.</p>" : "";
  const heading = `${preview.app}${preview.pullRequest ? ` · PR #${preview.pullRequest}` : preview.branch ? ` · ${preview.branch}` : ""}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>${escapeHtml(`Preview: ${heading}`)}</title>
<style>
:root { color-scheme: light dark; --bg: #f6f6f4; --fg: #1b1b1a; --muted: #5d5d58; --card: #ffffff; --line: #dcdcd6; --accent: #1f5fbf; --bad: #b3261e; --changed: #a3127a; }
@media (prefers-color-scheme: dark) { :root { --bg: #151514; --fg: #ececea; --muted: #a3a39d; --card: #1f1f1d; --line: #34342f; --accent: #8ab4f8; --bad: #f28b82; --changed: #f38bd6; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1600px; margin: 0 auto; padding: 24px 16px 64px; }
a { color: var(--accent); }
h1 { font-size: 1.5rem; margin: 0 0 12px; }
h2 { font-size: 1.15rem; margin: 0 0 12px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
h3 { font-size: .95rem; margin: 16px 0 8px; } h3 span { color: var(--muted); font-weight: normal; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 16px; margin: 0 0 16px; color: var(--muted); }
dt { font-weight: 600; } dd { margin: 0; overflow-wrap: anywhere; }
nav ul { list-style: none; padding: 0; margin: 0 0 24px; display: flex; flex-wrap: wrap; gap: 6px 14px; }
section { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px; margin: 0 0 20px; }
.summary { font-size: 1.05rem; font-weight: 600; margin: 0 0 16px; } .summary.unavailable { font-weight: normal; color: var(--muted); }
.note, .affected { color: var(--muted); margin: 0 0 12px; } .affected span { font-family: ui-monospace, monospace; font-size: .9em; color: var(--fg); }
.shots { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: 12px; align-items: start; }
.viewport-phone .shots { grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 260px)); }
figure { margin: 0; }
.shot { display: block; max-height: 720px; overflow: hidden; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); }
.shot img { display: block; width: 100%; height: auto; }
figcaption { font-size: .85rem; color: var(--muted); margin-top: 4px; }
.status, .badge { font-size: .8rem; border: 1px solid var(--line); border-radius: 999px; padding: 0 8px; color: var(--muted); }
.badge { border-color: var(--changed); color: var(--changed); font-weight: 600; }
.status.bad, .error { color: var(--bad); }
.pick { position: absolute; opacity: 0; pointer-events: none; }
.tabs { display: flex; gap: 4px; margin: 0 0 6px; }
.tab { font-size: .8rem; padding: 2px 10px; border: 1px solid var(--line); border-radius: 999px; cursor: pointer; color: var(--muted); }
.view { display: none; }
.pick-before:checked ~ .view-before, .pick-after:checked ~ .view-after, .pick-changes:checked ~ .view-changes { display: block; }
.pick-before:checked ~ .tabs .tab-before, .pick-after:checked ~ .tabs .tab-after, .pick-changes:checked ~ .tabs .tab-changes { color: var(--fg); border-color: var(--accent); font-weight: 600; }
.pick:focus-visible ~ .tabs { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 999px; }
details.unchanged > summary { cursor: pointer; font-weight: 600; margin: 0 0 16px; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(heading)}</h1>
${summary}
<dl>${facts.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>
${dropped}
${siteLink}
${routeNav}
${sections}
${empty}
</main>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Build

/**
 * Produce the preview for one resolved app (see `resolveConsumerApp`) in
 * `options.outputDir`, and return the `preview.json` object it wrote. With
 * `options.base` (a git ref), crawl previews are compared with the merge
 * base of that ref and HEAD, built first in a temporary worktree.
 */
export async function buildConsumerPreview(consumer, app, options = {}) {
  const output = options.output || noop;
  const env = options.env || process.env;
  const commandEnv = productEnvironment(env);
  const preview = app.preview;
  const mode = consumerPreviewMode(preview);
  const outputDir = path.resolve(options.outputDir || path.join(consumer.repoRoot, ".timds", "preview", app.name));
  const launchBrowser = options.launchBrowser || (() => launchChrome({ allowDownload: options.allowBrowserDownload ?? true }));
  const captureTimeoutMs = options.captureTimeoutMs ?? 60_000;
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const compareRef = options.base ? String(options.base) : null;
  if (!existsSync(app.cwd)) throw new Error(`App "${app.name}" cwd ${app.cwd} does not exist`);
  const mergeBase = compareRef ? await resolveMergeBase(consumer.repoRoot, compareRef) : null;
  await prepareOutputDirectory(outputDir);

  const guard = interruptGuard();
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "timds-preview-work-"));
  const releaseScratch = guard.add(() => fs.rm(scratch, { force: true, recursive: true }));
  try {
    const cells = mode === "crawl" ? previewCells(preview) : [];
    let compare = null;
    let base = null;
    if (compareRef) {
      const outputRelative = path.relative(consumer.repoRoot, outputDir).split(path.sep).join("/");
      compare = {
        base: compareRef,
        baseCommit: mergeBase,
        status: "unavailable",
        reason: null,
        changedFiles: await changedFilesSince(consumer.repoRoot, mergeBase, outputRelative.startsWith("..") ? null : outputRelative),
      };
      if (mode !== "crawl") {
        compare.reason = "Only previews that crawl routes are compared; this app's preview is its static build.";
      } else {
        const result = await captureBaseSide({
          app, captureTimeoutMs, cells, commandEnv, compareRef, consumer, guard, launchBrowser, mergeBase, output, preview, readyTimeoutMs, scratch,
        });
        if (result.reason) compare.reason = result.reason;
        else {
          base = result;
          compare.status = "ready";
        }
      }
      if (compare.reason) output(`Comparison unavailable: ${compare.reason}`);
    }

    if (app.install && options.install !== false) {
      output(`Running install: ${app.install.join(" ")}`);
      await execute(app.install, { cwd: app.cwd, env: commandEnv });
    }

    let routes = [];
    let sources = new Map();
    let site = null;
    const normalizeSource = await sourceNormalizer(consumer.repoRoot, app.cwdRelative || ".", [path.join(scratch, "base-checkout")]);
    const crawl = async (origin) => {
      const browser = await launchBrowser();
      const releaseBrowser = guard.add(() => browser.close());
      try {
        ({ routes, sources } = await captureHeadRoutes(browser, origin, preview, cells, outputDir, { base, captureTimeoutMs, normalizeSource, output }));
      } finally {
        await browser.close();
        releaseBrowser();
      }
    };
    if (preview.build) {
      output(`Running build: ${preview.build.join(" ")}`);
      await execute(preview.build, { cwd: app.cwd, env: commandEnv });
      const buildOutput = path.resolve(app.cwd, preview.output);
      const siteDir = path.join(outputDir, "site");
      const count = await copyPreviewTree(buildOutput, siteDir, preview.output);
      output(`Copied ${count} file${count === 1 ? "" : "s"} from ${preview.output} to site/`);
      if (existsSync(path.join(siteDir, "index.html"))) site = "site/index.html";
      else if (!preview.routes?.length) {
        throw new Error(`${preview.output}/index.html does not exist after the build; a static preview needs an index.html at the root of preview.output, or preview.routes to crawl`);
      }
      if (preview.routes?.length) {
        const server = await startStaticServer(siteDir);
        const releaseServer = guard.add(() => server.stop());
        try {
          await crawl(server.origin);
        } finally {
          await server.stop();
          releaseServer();
        }
      }
    } else {
      output(`Starting ${preview.serve.join(" ")} on port ${preview.port}`);
      const server = await startAppServer(preview.serve, {
        cwd: app.cwd,
        env: commandEnv,
        port: preview.port,
        ready: preview.ready || "/",
        timeoutMs: readyTimeoutMs,
      });
      const releaseServer = guard.add(() => server.stop());
      try {
        await crawl(server.origin);
      } finally {
        await server.stop();
        releaseServer();
      }
    }

    const changedFiles = new Set(compare?.changedFiles || []);
    for (const route of routes) {
      route.affectedBy = compare ? [...(sources.get(route) || [])].filter((file) => changedFiles.has(file)).sort() : [];
    }
    const limits = options.limits || PREVIEW_LIMITS;
    const dropped = await enforcePreviewLimits(outputDir, routes, limits);
    if (dropped.length) {
      const count = dropped.reduce((sum, entry) => sum + entry.files.length, 0);
      output(`Warning: the preview was over the portal's upload limits; left out ${count} file${count === 1 ? "" : "s"}: ${dropped.map((entry) => `${entry.what} on ${entry.route}`).join("; ")}`);
    }

    const provenance = await repositoryProvenance(consumer.repoRoot, env);
    const record = {
      schemaVersion: PREVIEW_SCHEMA_VERSION,
      app: app.name,
      repository: provenance.repository,
      branch: provenance.branch,
      commit: provenance.commit,
      pullRequest: resolvePullRequest(options.pullRequest, env),
      designSystem: { systemId: consumer.designSystem.systemId, commit: consumer.designSystem.commit ?? null },
      mode,
      ...(site ? { site } : {}),
      compare,
      changedRouteCount: compare?.status === "ready" ? routes.filter(isChangedRoute).length : 0,
      routes,
      dropped,
      generatedAt: timestamp(options.now || new Date()),
    };
    await fs.writeFile(path.join(outputDir, "preview.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(outputDir, "index.html"), renderPreviewGallery(record), "utf8");
    await scanPreviewTree(outputDir, "The preview", limits);
    return record;
  } finally {
    await fs.rm(scratch, { force: true, recursive: true }).catch(() => {});
    releaseScratch();
    guard.dispose();
  }
}

// ---------------------------------------------------------------------------
// Publish

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
  };
  return Buffer.from(JSON.stringify(metadata), "utf8").toString("base64");
}

/** Tar and gzip `outputDir` and post it to the portal; returns `{ previewUrl }`. */
export async function publishConsumerPreview(outputDir, options = {}) {
  const root = path.resolve(outputDir);
  let preview;
  try {
    preview = JSON.parse(await fs.readFile(path.join(root, "preview.json"), "utf8"));
  } catch {
    throw new Error(`${root}/preview.json is missing or invalid; run \`timds consumer preview\` first`);
  }
  await scanPreviewTree(root, "The preview");
  const portalUrl = options.portalUrl || process.env.TIMDS_PORTAL_URL || DEFAULT_PORTAL_URL;
  const token = await resolveAccessToken(portalUrl, options);
  if (!token) throw new Error("Set TIMDS_ACCESS_TOKEN or sign in with `timds auth login` before publishing a preview");
  const fetchImpl = options.fetchImpl || fetch;
  const workDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "timds-consumer-preview-"));
  try {
    const archivePath = path.join(workDirectory, "preview.tar.gz");
    await execute(["tar", "-czf", archivePath, "-C", root, "."], {
      capture: true,
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    const body = await fs.readFile(archivePath);
    const url = portalEndpoint(portalUrl, CONSUMER_PREVIEWS_PATH);
    const response = await fetchImpl(url, {
      body,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/gzip",
        [PREVIEW_METADATA_HEADER]: previewMetadataHeader(preview),
      },
      method: "POST",
    });
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

// ---------------------------------------------------------------------------
// CLI

const BOOLEAN_FLAGS = new Set(["help", "noInstall", "publish"]);

function parsePreviewArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("-")) throw new Error(`Unexpected argument ${value}\n${PREVIEW_HELP}`);
    const [rawName, inlineValue] = value.replace(/^--?/, "").split("=", 2);
    const name = rawName.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    if (BOOLEAN_FLAGS.has(name)) {
      options[name] = true;
      continue;
    }
    if (!["app", "base", "output", "portalUrl", "pullRequest", "readyTimeout", "root"].includes(name)) {
      throw new Error(`Unknown option --${rawName}\n${PREVIEW_HELP}`);
    }
    const next = inlineValue ?? argv[index + 1];
    if (next === undefined || next === "" || String(next).startsWith("--")) throw new Error(`--${rawName} requires a value`);
    options[name] = next;
    if (inlineValue === undefined) index += 1;
  }
  return options;
}

/** `timds consumer preview ...` */
export async function runConsumerPreview(args = [], { output = (line) => process.stdout.write(`${line}\n`), ...overrides } = {}) {
  const options = parsePreviewArguments(args);
  if (options.help) {
    output(PREVIEW_HELP);
    return null;
  }
  let readyTimeoutMs;
  if (options.readyTimeout !== undefined) {
    const seconds = Number(options.readyTimeout);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("--ready-timeout must be a positive number of seconds");
    readyTimeoutMs = seconds * 1000;
  }
  const pullRequest = resolvePullRequest(options.pullRequest);
  const consumer = await loadConsumer(options.root || process.cwd());
  const app = resolveConsumerApp(consumer, options.app);
  const outputDir = options.output
    ? path.resolve(options.output)
    : path.join(consumer.repoRoot, ".timds", "preview", app.name);
  const preview = await buildConsumerPreview(consumer, app, {
    ...overrides,
    base: options.base,
    install: !options.noInstall,
    output,
    outputDir,
    pullRequest,
    readyTimeoutMs,
  });
  const captures = preview.routes.reduce((sum, route) => sum + route.captures.length, 0);
  output(`Preview written to ${outputDir} (${preview.mode}, ${preview.routes.length} route${preview.routes.length === 1 ? "" : "s"}, ${captures} capture${captures === 1 ? "" : "s"})`);
  if (preview.compare?.status === "ready") output(`${preview.changedRouteCount} of ${preview.routes.length} page${preview.routes.length === 1 ? "" : "s"} changed compared with ${preview.compare.base}`);
  if (!options.publish) return { outputDir, preview };
  const published = await publishConsumerPreview(outputDir, { ...overrides, portalUrl: options.portalUrl });
  output(`Preview URL: ${published.previewUrl}`);
  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(process.env.GITHUB_OUTPUT, `preview-url=${published.previewUrl}\n`, "utf8").catch(() => {});
  }
  return { outputDir, preview, previewUrl: published.previewUrl };
}

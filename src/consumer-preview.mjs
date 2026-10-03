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
// `--publish` tars that folder and posts it to the portal, which returns the
// private preview URL the PR workflow comments.
//
// Boundary: TimDS never builds the product. It runs the product's declared
// `install`, `build`, and `serve` commands in the app's cwd and captures what
// a reviewer would see; nothing here knows a framework. The manifest is read
// by `consumer.mjs`, the browser is driven by `consumer-browser.mjs`, and the
// portal owns storage, access, and the viewer.

import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { resolveAccessToken } from "./auth.mjs";
import { launchBrowser as launchChrome } from "./consumer-browser.mjs";
import { consumerPreviewMode, loadConsumer, resolveConsumerApp } from "./consumer.mjs";
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
  timds consumer preview --app NAME [--root PATH] [--output DIR] [--no-install]
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

function uniqueSlugs(routes) {
  const seen = new Map();
  return routes.map((route) => {
    const base = routeSlug(route);
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}-${count}`;
  });
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
// Crawl

async function crawlRoutes(origin, preview, outputDir, { captureTimeoutMs, launchBrowser, output }) {
  const browser = await launchBrowser();
  const routes = [];
  try {
    const slugs = uniqueSlugs(preview.routes);
    for (const [index, routePath] of preview.routes.entries()) {
      const slug = slugs[index];
      const route = { path: routePath, slug, html: null, pages: [], status: null, captures: [] };
      const failures = [];
      for (const scheme of preview.schemes) {
        for (const viewport of preview.viewports) {
          const size = PREVIEW_VIEWPORTS[viewport];
          if (!size) throw new Error(`Unknown viewport ${viewport}; use ${Object.keys(PREVIEW_VIEWPORTS).join(", ")}`);
          let shot;
          try {
            shot = await browser.capture({ height: size.height, scheme, timeoutMs: captureTimeoutMs, url: `${origin}${routePath}`, width: size.width });
          } catch (error) {
            failures.push(`${viewport}/${scheme}: ${error.message}`);
            continue;
          }
          if (shot.png.length > PREVIEW_LIMITS.maxFileBytes) {
            failures.push(`${viewport}/${scheme}: the capture is ${shot.png.length} bytes, over the ${PREVIEW_LIMITS.maxFileBytes}-byte file limit`);
            continue;
          }
          const file = `captures/${slug}/${viewport}-${scheme}.png`;
          await fs.mkdir(path.join(outputDir, "captures", slug), { recursive: true });
          await fs.writeFile(path.join(outputDir, ...file.split("/")), shot.png);
          route.captures.push({ viewport, scheme, width: size.width, height: size.height, file });
          if (route.status === null && shot.status !== null && shot.status !== undefined) route.status = shot.status;
          if (!route.pages.some((page) => page.scheme === scheme)) {
            const page = `pages/${slug}/${scheme}.html`;
            await fs.mkdir(path.join(outputDir, "pages", slug), { recursive: true });
            await fs.writeFile(path.join(outputDir, ...page.split("/")), shot.html, "utf8");
            route.pages.push({ scheme, file: page });
          }
        }
      }
      route.html = route.pages[0]?.file ?? null;
      if (failures.length) {
        route.error = failures.join("; ");
        output(`Warning: ${routePath}: ${route.error}`);
      } else if (route.status && route.status >= 400) {
        output(`Warning: ${routePath} answered ${route.status}`);
      }
      output(`Captured ${routePath} (${route.captures.length} of ${preview.schemes.length * preview.viewports.length})`);
      routes.push(route);
    }
  } finally {
    await browser.close();
  }
  if (routes.length && routes.every((route) => !route.captures.length)) {
    throw new Error(`No route could be captured:\n${routes.map((route) => `- ${route.path}: ${route.error}`).join("\n")}`);
  }
  return routes;
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

/** The self-contained gallery page: every route grouped by viewport and scheme, relative links only. */
export function renderPreviewGallery(preview) {
  const short = (sha) => (sha ? String(sha).slice(0, 7) : "unknown");
  const facts = [
    ["App", preview.app],
    ["Repository", preview.repository || "unknown"],
    ["Branch", preview.branch || "detached"],
    ["Pull request", preview.pullRequest ? `#${preview.pullRequest}` : "none"],
    ["Commit", short(preview.commit)],
    ["Design System", `${preview.designSystem?.systemId || "unknown"} @ ${short(preview.designSystem?.commit)}`],
    ["Mode", preview.mode],
    ["Generated", preview.generatedAt],
  ];
  const routeNav = preview.routes.length
    ? `<nav aria-label="Routes"><ul>${preview.routes.map((route) => `<li><a href="#route-${escapeHtml(route.slug)}">${escapeHtml(route.path)}</a></li>`).join("")}</ul></nav>`
    : "";
  const siteLink = preview.site
    ? `<p class="site"><a href="${relativeHref(preview.site)}">Open the static build</a></p>`
    : "";
  const sections = preview.routes.map((route) => {
    const viewports = [...new Set(route.captures.map((capture) => capture.viewport))];
    const groups = viewports.map((viewport) => {
      const captures = route.captures.filter((capture) => capture.viewport === viewport);
      const { width, height } = captures[0];
      const figures = captures.map((capture) => {
        const page = route.pages?.find((entry) => entry.scheme === capture.scheme);
        const alt = `${route.path} at ${viewport} width in ${capture.scheme} mode`;
        return `<figure class="scheme-${escapeHtml(capture.scheme)}">
          <a class="shot" href="${relativeHref(capture.file)}"><img src="${relativeHref(capture.file)}" alt="${escapeHtml(alt)}" loading="lazy" width="${capture.width}"></a>
          <figcaption>${escapeHtml(titleCase(capture.scheme))}${page ? ` · <a href="${relativeHref(page.file)}">Rendered HTML</a>` : ""}</figcaption>
        </figure>`;
      }).join("\n");
      return `<div class="viewport viewport-${escapeHtml(viewport)}">
        <h3>${escapeHtml(titleCase(viewport))} <span>${width}×${height}</span></h3>
        <div class="shots">${figures}</div>
      </div>`;
    }).join("\n");
    const status = route.status ? `<span class="status${route.status >= 400 ? " bad" : ""}">${route.status}</span>` : "";
    const error = route.error ? `<p class="error">${escapeHtml(route.error)}</p>` : "";
    return `<section id="route-${escapeHtml(route.slug)}">
      <h2><code>${escapeHtml(route.path)}</code> ${status}</h2>
      ${error}
      ${groups || (route.error ? "" : "<p>No captures.</p>")}
    </section>`;
  }).join("\n");
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
:root { color-scheme: light dark; --bg: #f6f6f4; --fg: #1b1b1a; --muted: #5d5d58; --card: #ffffff; --line: #dcdcd6; --accent: #1f5fbf; --bad: #b3261e; }
@media (prefers-color-scheme: dark) { :root { --bg: #151514; --fg: #ececea; --muted: #a3a39d; --card: #1f1f1d; --line: #34342f; --accent: #8ab4f8; --bad: #f28b82; } }
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
.shots { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: 12px; align-items: start; }
.viewport-phone .shots { grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 260px)); }
figure { margin: 0; }
.shot { display: block; max-height: 720px; overflow: hidden; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); }
.shot img { display: block; width: 100%; height: auto; }
figcaption { font-size: .85rem; color: var(--muted); margin-top: 4px; }
.status { font-size: .8rem; border: 1px solid var(--line); border-radius: 999px; padding: 0 8px; color: var(--muted); }
.status.bad, .error { color: var(--bad); }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(heading)}</h1>
<dl>${facts.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>
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
 * `options.outputDir`, and return the `preview.json` object it wrote.
 */
export async function buildConsumerPreview(consumer, app, options = {}) {
  const output = options.output || noop;
  const env = options.env || process.env;
  const commandEnv = productEnvironment(env);
  const preview = app.preview;
  const mode = consumerPreviewMode(preview);
  const outputDir = path.resolve(options.outputDir || path.join(consumer.repoRoot, ".timds", "preview", app.name));
  const launchBrowser = options.launchBrowser || (() => launchChrome({ allowDownload: options.allowBrowserDownload ?? true }));
  if (!existsSync(app.cwd)) throw new Error(`App "${app.name}" cwd ${app.cwd} does not exist`);
  await prepareOutputDirectory(outputDir);

  if (app.install && options.install !== false) {
    output(`Running install: ${app.install.join(" ")}`);
    await execute(app.install, { cwd: app.cwd, env: commandEnv });
  }

  let routes = [];
  let site = null;
  const crawlOptions = {
    captureTimeoutMs: options.captureTimeoutMs ?? 60_000,
    launchBrowser,
    output,
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
      try {
        routes = await crawlRoutes(server.origin, preview, outputDir, crawlOptions);
      } finally {
        await server.stop();
      }
    }
  } else {
    output(`Starting ${preview.serve.join(" ")} on port ${preview.port}`);
    const server = await startAppServer(preview.serve, {
      cwd: app.cwd,
      env: commandEnv,
      port: preview.port,
      ready: preview.ready || "/",
      timeoutMs: options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    });
    const interrupt = () => {
      server.stop().finally(() => process.exit(130));
    };
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    try {
      routes = await crawlRoutes(server.origin, preview, outputDir, crawlOptions);
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
      await server.stop();
    }
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
    routes,
    generatedAt: timestamp(options.now || new Date()),
  };
  await fs.writeFile(path.join(outputDir, "preview.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(outputDir, "index.html"), renderPreviewGallery(record), "utf8");
  await scanPreviewTree(outputDir, "The preview");
  return record;
}

// ---------------------------------------------------------------------------
// Publish

/**
 * The metadata header: `preview.json` without the per-route detail (which
 * travels in the archive and could exceed HTTP header limits), plus counts,
 * base64-encoded JSON like the draft-build upload header.
 */
export function previewMetadataHeader(preview) {
  const { routes = [], ...rest } = preview;
  const metadata = {
    ...rest,
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
    if (!["app", "output", "portalUrl", "pullRequest", "readyTimeout", "root"].includes(name)) {
      throw new Error(`Unknown option --${rawName}\n${PREVIEW_HELP}`);
    }
    const next = inlineValue ?? argv[index + 1];
    if (next === undefined || String(next).startsWith("--")) throw new Error(`--${rawName} requires a value`);
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
    install: !options.noInstall,
    output,
    outputDir,
    pullRequest,
    readyTimeoutMs,
  });
  const captures = preview.routes.reduce((sum, route) => sum + route.captures.length, 0);
  output(`Preview written to ${outputDir} (${preview.mode}, ${preview.routes.length} route${preview.routes.length === 1 ? "" : "s"}, ${captures} capture${captures === 1 ? "" : "s"})`);
  if (!options.publish) return { outputDir, preview };
  const published = await publishConsumerPreview(outputDir, { ...overrides, portalUrl: options.portalUrl });
  output(`Preview URL: ${published.previewUrl}`);
  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(process.env.GITHUB_OUTPUT, `preview-url=${published.previewUrl}\n`, "utf8").catch(() => {});
  }
  return { outputDir, preview, previewUrl: published.previewUrl };
}

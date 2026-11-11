// The workspace site behind the Design System's dev server: one command and
// one port for the system's pages and the site in `site/`.
//
// A Design System workspace may hold an EmDash (Astro) site in `site/` with
// its own package and `site/timds.consumer.json` (see workspace-site.mjs).
// The stock dev server (viewer.mjs `dev`) builds the system, serves `dist/`,
// and, when the site is installed, calls `startWorkspaceSite` here: the site
// app's `preview.serve` command runs in its folder with TIMDS_SITE_BASE set
// to the mount (`/site`), which the site's astro.config reads as Astro's
// `base`, and TIMDS_SITE_PORT set to the port it must listen on: the
// manifest's `preview.port`, or a free one when that is taken (a serve
// command that names `--port` itself cannot be moved and is refused then).
//
// Astro's `base` covers the pages only. In development the site's server
// also answers at its root: EmDash's routes (`/_emdash/...`: its API, media
// files, the seed route and the admin's calls; EmDash 1.4 fails under a base)
// and Vite's (`/@vite/client`, `/node_modules/...`, component modules under
// `/src/...` or the site folder's absolute path, and the HMR websocket at
// `/`). So the dev server routes, in this order:
//
// 0. When the system's own build output already has a top-level `site`
//    entry (a view named `site` in src/site.json, or a build step that writes
//    `dist/site/`), the mount is the system's (`systemHoldsMount`): the dev
//    server does not start the site, says why once, and every request and
//    websocket is routed as if there were no site (the system's `dist/` or
//    its 404; upgrades closed). Nothing below applies then.
// 1. `/site` and `/site/**`: the site, always (503 while it starts). While
//    a site runs, a GET or HEAD under `/site/_emdash/**` is redirected (307)
//    to the same path at the root, where EmDash answers.
// 2. `SITE_ROOT_ROUTES` (reserved: names starting with `_`, `@` or `.`, or
//    `node_modules`, which no Design System output has, since view, page and
//    design ids are lowercase words joined by hyphens): the site while one runs.
// 3. `/src/**` and the site folder's absolute path: the site while one runs,
//    unless the system's `dist/` has that top-level entry, which then wins.
// 4. Everything else: the system's `dist/`.
//
// Every websocket upgrade goes to a running site (the system serves none).
// Requests are forwarded unchanged (no path or body rewriting), with one
// exception: a request to `/_emdash/**` whose `Accept` names `text/html` (a
// browser opening the EmDash admin or the dev sign-in link) is forwarded
// with the `text/html` ranges taken out of `Accept` (`navigationAccept`).
// EmDash 1.4 answers at the root only, and Astro's dev server answers any
// HTML navigation outside its `base` with its own 404; it decides that on
// `Accept` alone, while EmDash's `/_emdash` handlers never read `Accept`, so
// the response is the HTML the site gives at its own root. Readiness is
// polled on `preview.ready` under the mount, or at the root when it is a root
// route (EmDash's seed route), with its `redirect` moved under the mount.
// The system's pages are served whatever the site does: a site that is
// starting answers 503 under the mount, one that stopped answers 502 with
// the reason.
//
// The child runs in its own process group (the command may be `npx`
// spawning `astro`), which is stopped when the dev server closes, on
// SIGINT/SIGTERM, and on exit.
//
// Boundary: node:http, node:net, node:fs and node:child_process only,
// imported by the viewer only when a workspace site exists. It reads only the
// manifest fields it uses (one app's `cwd` and `preview.serve`, `port` and
// `ready`) and never validates the rest; consumer.mjs owns the manifest schema.

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { WORKSPACE_SITE_BASE_ENV, WORKSPACE_SITE_DIRECTORY, WORKSPACE_SITE_MANIFEST, WORKSPACE_SITE_MOUNT, WORKSPACE_SITE_PORT_ENV } from "./workspace-site.mjs";

/** How long the site's server may take to answer `preview.ready` (first runs optimize dependencies and seed content). */
export const DEFAULT_SITE_READY_TIMEOUT_MS = 120_000;
const STOP_GRACE_MS = 5_000;
const TAIL_LINES = 40;
const manifestLabel = `${WORKSPACE_SITE_DIRECTORY}/${WORKSPACE_SITE_MANIFEST}`;

/** True when a URL path is the mount itself or below it (`/site`, `/site/`, `/site/x`; not `/sitemap`). */
export function isUnderMount(pathname, mount = WORKSPACE_SITE_MOUNT) {
  return typeof pathname === "string" && (pathname === mount || pathname.startsWith(`${mount}/`));
}

/**
 * True when the system's own output already answers under the mount:
 * `systemHas(segment)` holds for the mount's first segment (`site` for
 * `/site`). The system then keeps the mount and no site is served through it.
 */
export function systemHoldsMount(systemHas = () => false, mount = WORKSPACE_SITE_MOUNT) {
  const segment = mount.split("/")[1] || "";
  return Boolean(segment) && Boolean(systemHas(segment));
}

/**
 * The paths outside the mount that a running site's dev server answers and
 * no Design System output can have. `tree` matches the path and everything
 * below it, `exact` the path alone, `start` any path that begins with it.
 * Astro's own list of Vite's internal prefixes (its dev route guard) plus
 * EmDash's routes and Vite's open-in-editor endpoint.
 */
export const SITE_ROOT_ROUTES = Object.freeze([
  Object.freeze({ path: "/_emdash", match: "tree", why: "EmDash: its API, media files, seed route and the admin's calls (EmDash 1.4 answers at the root only)" }),
  Object.freeze({ path: "/@vite", match: "tree", why: "Vite's client and its lazy modules" }),
  Object.freeze({ path: "/@id", match: "tree", why: "Vite's virtual and bare-import modules" }),
  Object.freeze({ path: "/@fs", match: "tree", why: "Vite's modules from outside the site folder" }),
  Object.freeze({ path: "/@react-refresh", match: "exact", why: "React fast refresh for the EmDash admin" }),
  Object.freeze({ path: "/__vite", match: "start", why: "Vite's internal endpoints" }),
  Object.freeze({ path: "/__open-in-editor", match: "exact", why: "Vite's error overlay link to the source" }),
  Object.freeze({ path: "/node_modules", match: "tree", why: "dependency modules, styles and pre-bundled dependencies" }),
  Object.freeze({ path: "/.astro", match: "tree", why: "Astro's generated modules" }),
]);

/**
 * The site's own modules, which a system could in principle also have (a
 * view named `src`): `/src/**` is the site's unless the system's `dist/`
 * holds a top-level `src`.
 */
export const SITE_SOURCE_ROUTE = "/src";

function matchesRoute(pathname, { path: route, match }) {
  if (match === "exact") return pathname === route;
  if (match === "start") return pathname.startsWith(route);
  return pathname === route || pathname.startsWith(`${route}/`);
}

/** True when `pathname` is one of `SITE_ROOT_ROUTES`. */
export function isSiteRootRoute(pathname) {
  return typeof pathname === "string" && SITE_ROOT_ROUTES.some((route) => matchesRoute(pathname, route));
}

/** EmDash's root route (`/_emdash` and below), the one root route whose page navigations the proxy adjusts. */
export const EMDASH_ROOT_ROUTE = "/_emdash";

/** True for `/_emdash` and everything below it. */
export function isEmdashRootPath(pathname) {
  return pathname === EMDASH_ROOT_ROUTE || pathname.startsWith(`${EMDASH_ROOT_ROUTE}/`);
}

/**
 * The `Accept` a page navigation to `/_emdash/**` is forwarded with: the
 * browser's list without its `text/html` ranges (Astro's dev server treats
 * any `Accept` that contains `text/html` outside its `base` as a page and
 * answers 404), `application/xhtml+xml` and the rest kept in order, or the
 * any-type range when nothing is left. Null when `accept` names no `text/html`.
 */
export function navigationAccept(accept) {
  const value = Array.isArray(accept) ? accept.join(",") : accept;
  if (typeof value !== "string" || !value.includes("text/html")) return null;
  const kept = value.split(",").map((range) => range.trim()).filter((range) => range && !range.includes("text/html"));
  return kept.length ? kept.join(",") : "*/*";
}

/** A folder as the URL path Vite requests modules by: `/Users/x/site`, `/C:/x/site`. */
function folderUrlPath(folder) {
  const posix = folder.split(path.sep).join("/");
  return posix.startsWith("/") ? posix : `/${posix}`;
}

/** The URL paths of a site folder as Vite may request them: as given and its real path (Astro asks for component scripts by absolute path). */
export function siteFolderRoutes(folder) {
  const folders = new Set([path.resolve(folder)]);
  try {
    folders.add(realpathSync(folder));
  } catch {
    // Not there yet; the given path is enough.
  }
  return [...folders].map(folderUrlPath);
}

/**
 * Who answers `pathname` at the root while a site runs: "site" or "system".
 * `folders` are `siteFolderRoutes`; `systemHas(segment)` says whether the
 * system's output holds that top-level entry, which wins for `/src/**` and
 * the folder paths only.
 */
export function rootOwner(pathname, { folders = [], systemHas = () => false } = {}) {
  if (isSiteRootRoute(pathname)) return "site";
  const shared = [SITE_SOURCE_ROUTE, ...folders].some((route) => matchesRoute(pathname, { path: route, match: "tree" }));
  if (!shared) return "system";
  const segment = pathname.split("/")[1] || "";
  return segment && systemHas(segment) ? "system" : "site";
}

function requestPathname(request) {
  const url = request.url || "/";
  const end = url.search(/[?#]/);
  const raw = end === -1 ? url : url.slice(0, end);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * The serve options of a workspace site, from its parsed manifest:
 * `{ app, command, port, ready, cwd }`. The app is the only one, or, when
 * the manifest declares several, the one whose `cwd` is ".". Throws a
 * message naming the missing field.
 */
export function siteServeOptions(site) {
  const apps = site?.manifest?.apps;
  if (!apps || typeof apps !== "object" || Array.isArray(apps) || !Object.keys(apps).length) {
    throw new Error(`${manifestLabel} declares no apps; the dev server needs one app with preview.serve and preview.port to start the site`);
  }
  const names = Object.keys(apps);
  const candidates = names.length === 1 ? names : names.filter((name) => apps[name]?.cwd === ".");
  if (candidates.length !== 1) {
    throw new Error(`${manifestLabel} declares ${names.length} apps (${names.join(", ")}) and ${candidates.length ? "more than one" : "none"} with cwd "."; the dev server serves the app at the site's root`);
  }
  const [app] = candidates;
  const preview = apps[app]?.preview;
  const label = `${manifestLabel} apps.${app}.preview`;
  const command = preview?.serve;
  if (!Array.isArray(command) || !command.length || command.some((part) => typeof part !== "string" || !part)) {
    throw new Error(`${label}.serve must be the command that serves the site in development, such as ["npm", "run", "dev", "--", "--host", "127.0.0.1"], with the port read from ${WORKSPACE_SITE_PORT_ENV}`);
  }
  const port = preview.port;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${label}.port must be the port the serve command listens on (1 to 65535)`);
  const ready = preview.ready === undefined ? "/" : preview.ready;
  if (typeof ready !== "string" || !ready.startsWith("/")) throw new Error(`${label}.ready must be a URL path starting with "/"`);
  const cwdRelative = typeof apps[app].cwd === "string" ? apps[app].cwd : ".";
  const cwd = path.resolve(site.root, cwdRelative);
  if (cwd !== site.root && !cwd.startsWith(`${site.root}${path.sep}`)) throw new Error(`${manifestLabel} apps.${app}.cwd must stay inside the site folder`);
  return { app, command: [...command], port, ready, cwd };
}

/** A path under the mount: "/" → "/site/", "/_x/y?z" → "/site/_x/y?z". */
export function mountedPath(pathWithQuery, mount = WORKSPACE_SITE_MOUNT) {
  return `${mount}${pathWithQuery.startsWith("/") ? pathWithQuery : `/${pathWithQuery}`}`;
}

/**
 * Where the dev server polls `preview.ready`: a root route (EmDash's seed
 * route, `/_emdash/api/setup/dev-bypass?redirect=/`) at the root, with a
 * `redirect` path moved under the mount so a browser that follows it lands on
 * the site; any other path under the mount.
 */
export function readyRequestPath(ready, mount = WORKSPACE_SITE_MOUNT) {
  const url = new URL(ready, "http://site.invalid");
  if (!isSiteRootRoute(url.pathname)) return mountedPath(ready, mount);
  const redirect = url.searchParams.get("redirect");
  if (redirect && redirect.startsWith("/") && !redirect.startsWith("//") && !isUnderMount(new URL(redirect, "http://site.invalid").pathname, mount)) {
    url.searchParams.set("redirect", mountedPath(redirect, mount));
  }
  return `${url.pathname}${url.search}`;
}

/** True when a serve command names its own port (`--port N`, `--port=N`), which the dev server then cannot move. */
export function serveNamesPort(command) {
  return command.some((part) => part === "--port" || part.startsWith("--port="));
}

async function portTaken(port) {
  return (await Promise.all([probePort("127.0.0.1", port), probePort("::1", port)])).some(Boolean);
}

async function freeLoopbackPort() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const server = net.createServer();
    const port = await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    });
    await new Promise((resolve) => server.close(resolve));
    if (!(await portTaken(port))) return port;
  }
  throw new Error("Could not find a free port for the site's dev server");
}

function probePort(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1_000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function getStatus(host, port, requestPath, timeoutMs) {
  return new Promise((resolve) => {
    const request = http.get({ host, port, path: requestPath, headers: { host: `${host.includes(":") ? `[${host}]` : host}:${port}` }, timeout: timeoutMs }, (response) => {
      response.resume();
      resolve(response.statusCode ?? null);
    });
    request.once("timeout", () => request.destroy());
    request.once("error", () => resolve(null));
  });
}

const hopByHop = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer", "upgrade"]);

function forwardedHeaders(request) {
  const remote = request.socket?.remoteAddress;
  const prior = request.headers["x-forwarded-for"];
  return {
    "x-forwarded-for": [prior, remote].filter(Boolean).join(", "),
    "x-forwarded-host": request.headers["x-forwarded-host"] || request.headers.host || "",
    "x-forwarded-proto": request.headers["x-forwarded-proto"] || "http",
  };
}

function plainText(response, status, message, extra = {}) {
  if (response.destroyed) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8", ...extra }).end(`${message}\n`);
}

/**
 * Forward one HTTP request to the site's server at `target` ({ host, port }),
 * path, method, headers and body unchanged except hop-by-hop headers and the
 * `x-forwarded-*` set; the `host` header is kept, so the site builds its own
 * URLs (and Astro's origin check) against the address the browser used.
 * Bodies stream both ways. An upstream that does not answer gets a 502.
 */
export function proxySiteRequest(request, response, target, { replaceHeaders = {} } = {}) {
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) if (!hopByHop.has(name)) headers[name] = value;
  Object.assign(headers, replaceHeaders);
  if (!headers.host) headers.host = `127.0.0.1:${target.port}`;
  Object.assign(headers, forwardedHeaders(request));
  const upstream = http.request({ host: target.host, port: target.port, method: request.method, path: request.url, headers }, (answer) => {
    const out = {};
    for (const [name, value] of Object.entries(answer.headers)) if (!hopByHop.has(name) && name !== "transfer-encoding" && value !== undefined) out[name] = value;
    response.writeHead(answer.statusCode || 502, answer.statusMessage, out);
    answer.pipe(response);
    answer.once("error", () => response.destroy());
  });
  upstream.once("error", (error) => {
    plainText(response, 502, `The site's dev server is not answering on port ${target.port} (${error.code || error.message}); the Design System's pages are still served.`);
  });
  response.once("close", () => {
    if (!response.writableFinished) upstream.destroy();
  });
  request.pipe(upstream);
}

function rawResponse(socket, status, reason, message) {
  if (socket.destroyed) return;
  const body = `${message}\n`;
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

/**
 * Forward an upgrade request (Vite's HMR websocket) to `target` as raw bytes:
 * the request line and headers as received, the `x-forwarded-*` set, the
 * buffered `head`, then both sockets piped into each other. Returns the
 * upstream socket.
 */
export function proxySiteUpgrade(request, socket, head, target) {
  const upstream = net.connect({ host: target.host, port: target.port });
  const close = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.once("connect", () => {
    const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
    const raw = request.rawHeaders;
    const replaced = new Set(["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"]);
    for (let index = 0; index < raw.length; index += 2) if (!replaced.has(raw[index].toLowerCase())) lines.push(`${raw[index]}: ${raw[index + 1]}`);
    for (const [name, value] of Object.entries(forwardedHeaders(request))) if (value) lines.push(`${name}: ${value}`);
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.once("error", (error) => {
    if (!upstream.connecting && upstream.bytesWritten) return close();
    rawResponse(socket, 502, "Bad Gateway", `The site's dev server is not answering on port ${target.port} (${error.code || error.message}).`);
  });
  upstream.once("close", () => socket.destroy());
  socket.once("error", close);
  socket.once("close", () => upstream.destroy());
  return upstream;
}

function killGroup(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      if (signal === "SIGKILL" || child.exitCode === null) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => {});
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

function lineWriter(prefix, write) {
  let pending = "";
  return {
    push(chunk) {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) write(`${prefix}${line}`);
    },
    flush() {
      if (pending) write(`${prefix}${pending}`);
      pending = "";
    },
  };
}

/**
 * Start a workspace site (`findWorkspaceSite`'s `{ root, manifest }`) on
 * `preview.port`, or on a free port when that one is taken and the serve
 * command does not name `--port`, and wait until `preview.ready`
 * (`readyRequestPath`) answers with any status below 500. Resolves with a
 * handle:
 *
 * - `port` (the one the site listens on), `host` (the loopback address that
 *   answered), `mount`, `child`, `options`, `folders` (`siteFolderRoutes`),
 *   `emdash` (true when `preview.ready` is an EmDash route)
 * - `state()`: "running" or "stopped", and `reason` once stopped
 * - `handleRequest(request, response)` and `handleUpgrade(request, socket, head)`
 *   for the requests `siteRouter` gives it; a stopped site answers 502 with the reason
 * - `output()`: the tail of the child's output
 * - `stop()`: stops the child's process group; resolves once the child exited
 *
 * Rejects (with the child already stopped and the tail of its output in the
 * message) when the fields are missing, the port is taken and named by the
 * command, the command cannot start, exits early, or does not answer within
 * `readyTimeoutMs`.
 */
export async function startWorkspaceSite(site, { mount = WORKSPACE_SITE_MOUNT, readyTimeoutMs = DEFAULT_SITE_READY_TIMEOUT_MS, env = process.env, log = (line) => console.log(line), onStop = null, signal = null } = {}) {
  const options = siteServeOptions(site);
  const { command, ready } = options;
  const shown = command.join(" ");
  let port = options.port;
  if (await portTaken(port)) {
    if (serveNamesPort(command)) {
      throw new Error(`Port ${port} (preview.port in ${manifestLabel}) is already in use and preview.serve names --port, so the site cannot move; stop what is listening there, or take --port out of preview.serve and read ${WORKSPACE_SITE_PORT_ENV} in astro.config (server.port) instead`);
    }
    port = await freeLoopbackPort();
    log(`Port ${options.port} (preview.port in ${manifestLabel}) is in use, so the site's dev server listens on port ${port}; it is still served through this dev server.`);
  }

  const child = spawn(command[0], command.slice(1), {
    cwd: options.cwd,
    detached: process.platform !== "win32",
    env: { ...env, [WORKSPACE_SITE_BASE_ENV]: mount, [WORKSPACE_SITE_PORT_ENV]: String(port), PORT: String(port) },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tailLines = [];
  const remember = (line) => {
    tailLines.push(line);
    if (tailLines.length > TAIL_LINES) tailLines.shift();
    log(`[site] ${line}`);
  };
  const outWriter = lineWriter("", remember);
  const errWriter = lineWriter("", remember);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => outWriter.push(chunk));
  child.stderr.on("data", (chunk) => errWriter.push(chunk));
  const tail = () => (tailLines.length ? `\n--- site output (last ${tailLines.length} lines) ---\n${tailLines.join("\n")}` : "");

  let exit = null;
  let spawnError = null;
  let stopping = false;
  const sockets = new Set();
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      outWriter.flush();
      errWriter.flush();
      exit = { code, signal };
      // Anything the command left behind in its group (npx's astro) goes too.
      killGroup(child, "SIGTERM");
      resolve(exit);
    });
  });
  child.once("error", (error) => {
    spawnError = error;
  });
  const describeExit = () => (exit ? (exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code}`) : "");

  const onSignal = (signal) => {
    killGroup(child, "SIGTERM");
    removeProcessHooks();
    // Keep the signal's default effect when nothing else listens for it.
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  };
  const onExit = () => killGroup(child, "SIGKILL");
  function removeProcessHooks() {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("exit", onExit);
  }
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("exit", onExit);

  let stopped = null;
  const stop = () => {
    if (stopped) return stopped;
    stopping = true;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    stopped = (async () => {
      if (!exit && !spawnError) {
        killGroup(child, "SIGTERM");
        const forced = setTimeout(() => killGroup(child, "SIGKILL"), STOP_GRACE_MS);
        let giveUp;
        await Promise.race([exited, new Promise((resolve) => { giveUp = setTimeout(resolve, STOP_GRACE_MS * 2); })]);
        clearTimeout(forced);
        clearTimeout(giveUp);
      } else {
        killGroup(child, "SIGTERM");
      }
      removeProcessHooks();
    })();
    return stopped;
  };

  const onAbort = () => stop();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) stop();

  // Wait for readiness on whichever loopback address the server bound.
  const readyPath = readyRequestPath(ready, mount);
  const deadline = Date.now() + readyTimeoutMs;
  let host = null;
  let lastStatus = null;
  while (!host) {
    if (stopping) {
      await stop();
      throw new Error("The site's dev server was stopped before it was ready");
    }
    if (spawnError) {
      await stop();
      throw new Error(`Could not start the site's dev server (${shown}) in ${path.relative(site.root, options.cwd) || "."} of ${WORKSPACE_SITE_DIRECTORY}/: ${spawnError.message}`);
    }
    if (exit) {
      await stop();
      throw new Error(`The site's dev server (${shown}) stopped with ${describeExit()} before ${readyPath} answered on port ${port}${tail()}`);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      await stop();
      throw new Error(`The site's dev server (${shown}) did not answer ${readyPath} on port ${port} within ${Math.round(readyTimeoutMs / 1000)}s${lastStatus ? ` (last status ${lastStatus})` : ""}; check that it reads ${WORKSPACE_SITE_BASE_ENV} as its base path and listens on the port in ${WORKSPACE_SITE_PORT_ENV}${tail()}`);
    }
    for (const candidate of ["127.0.0.1", "::1"]) {
      const status = await getStatus(candidate, port, readyPath, Math.max(1, Math.min(remaining, 60_000)));
      if (status === null) continue;
      lastStatus = status;
      if (status < 500) {
        host = candidate;
        break;
      }
    }
    if (!host) await new Promise((resolve) => setTimeout(resolve, 250));
  }

  exited.then(() => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    removeProcessHooks();
    if (!stopping) {
      log(`The site's dev server stopped with ${describeExit()}; ${mount}/ answers 502 until the dev server is restarted, and the Design System's pages are still served.${tail()}`);
      onStop?.(describeExit());
    }
  });

  const target = { host, port };
  const unavailable = () => (exit ? `The site's dev server stopped with ${describeExit()}; restart the dev server to start it again. The Design System's pages are still served.${tail()}` : stopping ? "The site's dev server is shutting down." : null);
  return {
    port,
    host,
    mount,
    child,
    options,
    folders: siteFolderRoutes(options.cwd),
    // An EmDash site (its ready path is EmDash's seed route): the admin is at /_emdash/admin/.
    emdash: isEmdashRootPath(new URL(ready, "http://site.invalid").pathname),
    state: () => (exit || stopping ? { status: "stopped", reason: exit ? describeExit() : "stopped" } : { status: "running" }),
    output: () => tailLines.join("\n"),
    handleRequest(request, response, forwarding) {
      const reason = unavailable();
      if (reason) return plainText(response, 502, reason);
      proxySiteRequest(request, response, target, forwarding);
    },
    handleUpgrade(request, socket, head) {
      const reason = unavailable();
      if (reason) return rawResponse(socket, 502, "Bad Gateway", reason);
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      proxySiteUpgrade(request, socket, head, target);
    },
    stop,
  };
}

/**
 * Route a dev server's requests, in the order the module comment gives:
 * when the system holds the mount (`systemHoldsMount` with `systemHas`),
 * every request goes to `fallback` and every upgrade is closed, whatever
 * `getSite()` says; otherwise under the mount to `getSite()`'s handle (or a plain-text 503 while it is
 * starting or unavailable); while a site handle exists, the root routes
 * (`rootOwner`, with the handle's `folders` and `systemHas`) to it too;
 * everything else to `fallback`. Every websocket upgrade goes to the site
 * handle when there is one (Vite's HMR socket is at `/`); without one, an
 * upgrade under the mount answers 503 and any other is closed. Returns
 * `{ request, upgrade }` listeners for `createServer` and the server's
 * "upgrade" event.
 */
export function siteRouter({ fallback, getSite, mount = WORKSPACE_SITE_MOUNT, systemHas = () => false }) {
  return {
    request(request, response) {
      if (systemHoldsMount(systemHas, mount)) return fallback(request, response);
      const pathname = requestPathname(request);
      const { site, message } = getSite();
      if (isUnderMount(pathname, mount)) {
        if (!site) return plainText(response, 503, message, { "Retry-After": "2" });
        const rest = pathname.slice(mount.length);
        if (isEmdashRootPath(rest) && (request.method === "GET" || request.method === "HEAD") && (request.url || "").startsWith(`${mount}/`)) {
          const url = request.url || "/";
          const query = url.search(/[?#]/);
          const location = `${url.slice(mount.length, query === -1 ? undefined : query)}${query === -1 ? "" : url.slice(query)}`;
          response.writeHead(307, { "Cache-Control": "no-store", Location: location, "Content-Type": "text/plain; charset=utf-8" });
          return response.end(request.method === "HEAD" ? undefined : `EmDash answers at the root: ${location}\n`);
        }
        return site.handleRequest(request, response);
      }
      if (site && rootOwner(pathname, { folders: site.folders, systemHas }) === "site") {
        const accept = isEmdashRootPath(pathname) ? navigationAccept(request.headers.accept) : null;
        return site.handleRequest(request, response, accept ? { replaceHeaders: { accept } } : undefined);
      }
      return fallback(request, response);
    },
    upgrade(request, socket, head) {
      if (systemHoldsMount(systemHas, mount)) return socket.destroy();
      const { site, message } = getSite();
      if (site) return site.handleUpgrade(request, socket, head);
      if (!isUnderMount(requestPathname(request), mount)) return socket.destroy();
      rawResponse(socket, 503, "Service Unavailable", message);
    },
  };
}

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import http from "node:http";

import { MAX_MAP_ELEMENTS, launchBrowser } from "./consumer-browser.mjs";
import { decodePng, encodePng } from "./consumer-png.mjs";
import {
  PREVIEW_LIMITS,
  buildConsumerPreview,
  discoverablePath,
  normalizeRepository,
  normalizeSourceFile,
  parseSitemap,
  routeKey,
  scanPreviewTree,
  previewMetadataHeader,
  publishConsumerPreview,
  renderPreviewGallery,
  resolvePullRequest,
  routeSlug,
  runConsumerPreview,
  startAppServer,
} from "./consumer-preview.mjs";
import { loadConsumer, resolveConsumerApp } from "./consumer.mjs";
import { syncConsumerBundle } from "./consumer-sync.mjs";
import { initializeRepository } from "./core.mjs";

const DESIGN_SYSTEM_COMMIT = "df31440aa1b2c3d4e5f60718293a4b5c6d7e8f90";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Environment that never leaks the CI runner's GitHub context into assertions.
const cleanEnv = () => {
  const env = { ...process.env };
  for (const key of ["GITHUB_REF", "GITHUB_REF_NAME", "GITHUB_HEAD_REF", "GITHUB_REPOSITORY", "GITHUB_OUTPUT"]) delete env[key];
  return env;
};

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function portAnswers(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

// A small product: a node HTTP server whose pages react to prefers-color-scheme.
const SERVER_SOURCE = `
import http from "node:http";
const port = Number(process.argv[2]);
const page = (title) => \`<!doctype html><html><head><title>\${title}</title><style>
body { margin: 0; background: #ffffff; color: #111111; min-height: 1400px; }
@media (prefers-color-scheme: dark) { body { background: #000000; color: #eeeeee; } }
</style></head><body><h1>\${title}</h1><p id="scheme">pending</p>
<script>document.getElementById("scheme").textContent = matchMedia("(prefers-color-scheme: dark)").matches ? "dark-mode" : "light-mode";</script>
</body></html>\`;
http.createServer((request, response) => {
  const url = new URL(request.url, "http://local");
  if (url.pathname === "/missing") { response.writeHead(404, { "content-type": "text/html" }); response.end(page("Missing")); return; }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(page(url.pathname === "/" ? "Home" : url.pathname));
}).listen(port, "127.0.0.1", () => console.log("listening on " + port));
`;

async function createConsumerRepo(preview, { install = ["node", "-e", "require('fs').writeFileSync('installed.txt', 'yes')"] } = {}) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "timds-consumer-preview-"));
  const appRoot = path.join(repoRoot, "web");
  await fs.mkdir(appRoot, { recursive: true });
  await fs.writeFile(path.join(appRoot, "server.mjs"), SERVER_SOURCE, "utf8");
  const manifest = {
    schemaVersion: 1,
    designSystem: { path: "design-system", systemId: "acme/core" },
    apps: {
      web: {
        cwd: "web",
        ...(install ? { install } : {}),
        preview,
        designSurface: ["src/**"],
      },
    },
  };
  await fs.writeFile(path.join(repoRoot, "timds.consumer.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  git(repoRoot, "init", "-q", "-b", "design/hero-spacing");
  git(repoRoot, "config", "user.email", "test@example.com");
  git(repoRoot, "config", "user.name", "Test");
  git(repoRoot, "config", "commit.gpgsign", "false");
  git(repoRoot, "remote", "add", "origin", "git@github.com:acme/shop.git");
  git(repoRoot, "update-index", "--add", "--cacheinfo", `160000,${DESIGN_SYSTEM_COMMIT},design-system`);
  git(repoRoot, "add", "timds.consumer.json", "web");
  git(repoRoot, "commit", "-q", "-m", "fixture");
  const consumer = await loadConsumer(repoRoot);
  return { app: resolveConsumerApp(consumer, "web"), appRoot, consumer, repoRoot };
}

// Stands in for Chrome: fetches the page so the served app is really exercised.
function fakeBrowser(log = []) {
  return async () => ({
    async capture({ url, width, height, scheme }) {
      log.push({ height, scheme, url, width });
      const response = await fetch(url);
      return { html: `${await response.text()}<!-- ${scheme} -->`, png: PNG_SIGNATURE, status: response.status };
    },
    async close() {},
  });
}

let browserProbe;
function realBrowserAvailable() {
  browserProbe ||= (async () => {
    try {
      const browser = await launchBrowser({ allowDownload: false });
      await browser.close();
      return null;
    } catch (error) {
      return `headless Chrome is not available without a download (${error.message})`;
    }
  })();
  return browserProbe;
}

const readJson = async (filePath) => JSON.parse(await fs.readFile(filePath, "utf8"));

test("routeSlug, normalizeRepository, and resolvePullRequest follow the preview contract", () => {
  assert.equal(routeSlug("/"), "root");
  assert.equal(routeSlug("/estate-planning"), "estate-planning");
  assert.equal(routeSlug("/blog/2026/hello world?x=1"), "blog-2026-hello-world-x-1");
  assert.equal(normalizeRepository("git@github.com:example-org/consumer-site.git"), "example-org/consumer-site");
  assert.equal(normalizeRepository("https://github.com/example-org/consumer-site"), "example-org/consumer-site");
  assert.equal(normalizeRepository("https://x-access-token:abc@github.com/Owner/Repo.git"), "Owner/Repo");
  assert.equal(normalizeRepository("ssh://git@github.com/owner/repo.git"), "owner/repo");
  assert.equal(normalizeRepository(""), null);
  assert.equal(resolvePullRequest("12", {}), 12);
  assert.equal(resolvePullRequest(undefined, { GITHUB_REF: "refs/pull/123/merge" }), 123);
  assert.equal(resolvePullRequest(undefined, { GITHUB_REF: "refs/heads/main" }), null);
  assert.throws(() => resolvePullRequest("abc", {}), /positive integer/);
});

test("static mode installs, builds, copies the output to site/, and writes preview.json and the gallery", async () => {
  const build = ["node", "-e", [
    "const fs = require('fs');",
    "fs.mkdirSync('dist/about', { recursive: true });",
    "fs.writeFileSync('dist/index.html', '<!doctype html><h1>Home</h1><a href=\"about/\">About</a>');",
    "fs.writeFileSync('dist/about/index.html', '<!doctype html><h1>About</h1>');",
  ].join(" ")];
  // The install command records whether it could see the portal token.
  const install = ["node", "-e", "require('fs').writeFileSync('installed.txt', process.env.TIMDS_ACCESS_TOKEN ? 'leaked' : 'yes')"];
  const { app, appRoot, consumer, repoRoot } = await createConsumerRepo({ build, output: "dist" }, { install });
  const lines = [];
  const preview = await buildConsumerPreview(consumer, app, {
    env: { ...cleanEnv(), TIMDS_ACCESS_TOKEN: "timds_test_token" },
    now: new Date("2026-10-03T00:00:00.000Z"),
    output: (line) => lines.push(line),
    pullRequest: 7,
  });
  const outputDir = path.join(repoRoot, ".timds", "preview", "web");
  assert.equal(await fs.readFile(path.join(appRoot, "installed.txt"), "utf8"), "yes");
  assert.match(await fs.readFile(path.join(outputDir, "site", "index.html"), "utf8"), /<h1>Home<\/h1>/);
  assert.match(await fs.readFile(path.join(outputDir, "site", "about", "index.html"), "utf8"), /About/);
  assert.deepEqual(await readJson(path.join(outputDir, "preview.json")), preview);
  assert.deepEqual(preview, {
    schemaVersion: 1,
    app: "web",
    repository: "acme/shop",
    branch: "design/hero-spacing",
    commit: git(repoRoot, "rev-parse", "HEAD"),
    pullRequest: 7,
    designSystem: { systemId: "acme/core", commit: DESIGN_SYSTEM_COMMIT },
    mode: "static",
    site: "site/index.html",
    compare: null,
    changedRouteCount: 0,
    designs: null,
    routes: [],
    dropped: [],
    generatedAt: "2026-10-03T00:00:00Z",
  });
  const gallery = await fs.readFile(path.join(outputDir, "index.html"), "utf8");
  assert.match(gallery, /href="site\/index\.html"/);
  assert.match(gallery, /prefers-color-scheme: dark/);
  assert.match(gallery, /PR #7/);
  assert.ok(lines.some((line) => line.includes("Copied 2 files")));

  // A rerun replaces the previous preview; --no-install skips install.
  await fs.rm(path.join(appRoot, "installed.txt"));
  await runConsumerPreview(["--root", repoRoot, "--app", "web", "--no-install"], { output: () => {} });
  assert.equal(existsSync(path.join(appRoot, "installed.txt")), false);
  assert.ok(existsSync(path.join(outputDir, "site", "about", "index.html")));
});

test("static mode needs an index.html at the root of the build output", async () => {
  const build = ["node", "-e", "const fs = require('fs'); fs.mkdirSync('dist', { recursive: true }); fs.writeFileSync('dist/about.html', 'x');"];
  const { app, consumer } = await createConsumerRepo({ build, output: "dist" }, { install: null });
  await assert.rejects(buildConsumerPreview(consumer, app, { env: cleanEnv() }), /dist\/index\.html does not exist after the build/);
});

test("static mode refuses symbolic links in the build output and an unrelated output directory", async (t) => {
  const build = ["node", "-e", "const fs = require('fs'); fs.mkdirSync('dist', { recursive: true }); fs.writeFileSync('dist/index.html', 'x'); try { fs.symlinkSync('/etc/hosts', 'dist/hosts'); } catch {}"];
  const { app, consumer, repoRoot } = await createConsumerRepo({ build, output: "dist" }, { install: null });
  if (process.platform === "win32") t.skip("symbolic links need privileges on Windows");
  await assert.rejects(buildConsumerPreview(consumer, app, { env: cleanEnv() }), /symbolic links/);
  const foreign = path.join(repoRoot, "elsewhere");
  await fs.mkdir(foreign);
  await fs.writeFile(path.join(foreign, "keep.txt"), "mine");
  await assert.rejects(buildConsumerPreview(consumer, app, { env: cleanEnv(), outputDir: foreign }), /not a previous preview/);
  assert.equal(await fs.readFile(path.join(foreign, "keep.txt"), "utf8"), "mine");
});

test("build + output + routes serves the build with the static server and crawls it", async () => {
  const build = ["node", "-e", "const fs = require('fs'); fs.mkdirSync('dist/contact', { recursive: true }); fs.writeFileSync('dist/index.html', '<h1>Home</h1>'); fs.writeFileSync('dist/contact/index.html', '<h1>Contact</h1>');"];
  const { app, consumer, repoRoot } = await createConsumerRepo({ build, output: "dist", routes: ["/", "/contact"], viewports: ["phone"], schemes: ["dark"] }, { install: null });
  const captures = [];
  const preview = await buildConsumerPreview(consumer, app, { env: cleanEnv(), launchBrowser: fakeBrowser(captures) });
  const outputDir = path.join(repoRoot, ".timds", "preview", "web");
  assert.equal(preview.mode, "crawl");
  assert.equal(preview.site, "site/index.html");
  assert.deepEqual(captures.map((capture) => [new URL(capture.url).pathname, capture.width, capture.height, capture.scheme]), [
    ["/", 390, 844, "dark"],
    ["/contact", 390, 844, "dark"],
  ]);
  assert.match(await fs.readFile(path.join(outputDir, "pages", "contact", "dark.html"), "utf8"), /<h1>Contact<\/h1>/);
  assert.deepEqual(preview.routes[1], {
    path: "/contact",
    slug: "contact",
    declared: true,
    discovered: false,
    html: "pages/contact/dark.html",
    pages: [{ scheme: "dark", file: "pages/contact/dark.html" }],
    status: 200,
    change: "unknown",
    affectedBy: [],
    captures: [{ viewport: "phone", scheme: "dark", width: 390, height: 844, file: "captures/contact/phone-dark.png", base: null, diff: null, map: null }],
    design: null,
  });
});

test("preview.designs shows the pinned system's design beside each paired route, building the pin when it is not built", async () => {
  const port = await freePort();
  const fixture = await createConsumerRepo({
    serve: ["node", "server.mjs", String(port)],
    port,
    routes: ["/", "/contact", "/missing"],
    designs: { "/": "website:/", "/contact/": "website:/contact", "/missing": "website:/nope" },
  }, { install: null });
  const { appRoot, repoRoot } = fixture;
  // Without the pin checked out, the product is still previewed and the gap is recorded.
  let captures = [];
  let preview = await buildConsumerPreview(fixture.consumer, fixture.app, { env: cleanEnv(), launchBrowser: fakeBrowser(captures) });
  assert.deepEqual(preview.designs, { status: "unavailable", reason: "design-system/timds.json is not checked out; run git submodule update --init design-system." });
  assert.ok(preview.routes.every((route) => route.design === null));

  // The pin: a scaffolded standalone system (its own repository, as a submodule is), with its artifact not built.
  const pin = path.join(repoRoot, "design-system");
  await fs.mkdir(pin);
  git(pin, "init", "-q", "-b", "main");
  await initializeRepository(pin, { standalone: true, name: "Acme" });
  await fs.rm(path.join(pin, "dist"), { recursive: true });
  const consumer = await loadConsumer(repoRoot);
  const app = resolveConsumerApp(consumer, "web");
  captures = [];
  const lines = [];
  preview = await buildConsumerPreview(consumer, app, { env: cleanEnv(), launchBrowser: fakeBrowser(captures), output: (line) => lines.push(line) });
  const outputDir = path.join(repoRoot, ".timds", "preview", "web");
  assert.ok(lines.some((line) => line.startsWith("Building the Design System at design-system: node scripts/build.mjs")), lines.join("\n"));
  assert.ok(existsSync(path.join(pin, "dist", "designs", "website", "contact", "index.html")), "the pin's designs are rendered into its artifact");
  assert.deepEqual(preview.designs, { status: "ready", pairedRoutes: 3 });
  assert.equal(preview.routes.length, 3);
  assert.equal(captures.length, 3 * 4 + 2 * 4, "each resolvable pairing is captured at every cell");
  const [home, contact, missing] = preview.routes;
  assert.deepEqual([home.design.id, home.design.route, home.design.title, home.design.url, home.design.error], ["website", "/", "Home", "/designs/website/", null]);
  assert.deepEqual(home.design.captures.map((capture) => capture.file), [
    "designs/root/desktop-light.png", "designs/root/phone-light.png", "designs/root/desktop-dark.png", "designs/root/phone-dark.png",
  ]);
  assert.deepEqual(home.design.pages.map((page) => page.file), ["designs/root/light.html", "designs/root/dark.html"]);
  assert.match(await fs.readFile(path.join(outputDir, "designs/root/light.html"), "utf8"), /class="site-header wrap"/, "the design page itself is captured");
  assert.equal(contact.design.route, "/contact", "a trailing slash in the pairing still matches the route");
  assert.equal(contact.design.captures.length, 4);
  assert.deepEqual([missing.design.id, missing.design.captures.length], ["website", 0]);
  assert.match(missing.design.error, /design website has no route \/nope \(routes: \/, \/404, \/about, \/articles, \/articles\/example-article, \/contact, \/privacy, \/terms, \/topics\/example-topic\)/);
  assert.ok(lines.some((line) => line.includes("Warning: /missing: design website has no route /nope")));
  for (const route of [home, contact]) {
    for (const capture of route.design.captures) assert.ok(existsSync(path.join(outputDir, capture.file)), capture.file);
  }
  const gallery = await fs.readFile(path.join(outputDir, "index.html"), "utf8");
  assert.match(gallery, /<span class="status design-ref">design website\/<\/span>/);
  assert.match(gallery, /<figure class="design scheme-light">[\s\S]*?designs\/root\/desktop-light\.png[\s\S]*?<figcaption>Design <code>website\/<\/code> · Light · <a href="designs\/root\/light\.html">Rendered HTML<\/a>/);
  assert.ok(gallery.indexOf("designs/root/desktop-light.png") < gallery.indexOf("captures/root/desktop-light.png"), "the design sits before the product capture");
  assert.match(gallery, /<dt>Designs<\/dt><dd>3 routes shown beside the design<\/dd>/);
  assert.match(gallery, /The design could not be shown: design website has no route \/nope/);
  for (const match of gallery.matchAll(/(?:href|src)="([^"]+)"/g)) {
    if (!match[1].startsWith("#")) assert.ok(existsSync(path.join(outputDir, decodeURIComponent(match[1]))), match[1]);
  }
  const header = JSON.parse(Buffer.from(previewMetadataHeader(preview), "base64").toString("utf8"));
  assert.equal(header.designRouteCount, 2);
  assert.deepEqual(header.designs, { status: "ready", pairedRoutes: 3 });
  assert.ok(appRoot);
});

test("crawl mode starts serve, waits for ready, captures every route × viewport × scheme, and stops the server", async () => {
  const port = await freePort();
  const { app, consumer, repoRoot } = await createConsumerRepo({
    serve: ["node", "server.mjs", String(port)],
    port,
    ready: "/",
    routes: ["/", "/estate-planning", "/missing"],
  }, { install: null });
  const captures = [];
  const lines = [];
  const preview = await buildConsumerPreview(consumer, app, {
    env: { ...cleanEnv(), GITHUB_REF: "refs/pull/123/merge" },
    launchBrowser: fakeBrowser(captures),
    output: (line) => lines.push(line),
  });
  const outputDir = path.join(repoRoot, ".timds", "preview", "web");
  assert.equal(await portAnswers(port), false, "the serve process is stopped");
  assert.equal(preview.mode, "crawl");
  assert.equal(preview.pullRequest, 123);
  assert.equal(preview.site, undefined);
  assert.equal(captures.length, 3 * 2 * 2);
  assert.deepEqual(preview.routes.map((route) => [route.slug, route.status, route.captures.length]), [
    ["root", 200, 4],
    ["estate-planning", 200, 4],
    ["missing", 404, 4],
  ]);
  assert.deepEqual(preview.routes[0].captures.map((capture) => capture.file), [
    "captures/root/desktop-light.png",
    "captures/root/phone-light.png",
    "captures/root/desktop-dark.png",
    "captures/root/phone-dark.png",
  ]);
  assert.equal(preview.routes[0].html, "pages/root/light.html");
  assert.ok(lines.some((line) => line.includes("/missing answered 404")));
  for (const route of preview.routes) {
    for (const capture of route.captures) assert.ok(existsSync(path.join(outputDir, capture.file)), capture.file);
    for (const page of route.pages) assert.ok(existsSync(path.join(outputDir, page.file)), page.file);
  }
  const gallery = await fs.readFile(path.join(outputDir, "index.html"), "utf8");
  for (const match of gallery.matchAll(/(?:href|src)="([^"]+)"/g)) {
    assert.doesNotMatch(match[1], /^(?:\/|[a-z]+:)/i, `gallery link ${match[1]} must be relative`);
    if (!match[1].startsWith("#")) assert.ok(existsSync(path.join(outputDir, decodeURIComponent(match[1]))), match[1]);
  }
  assert.match(gallery, /<h3>Desktop <span>1440×900<\/span><\/h3>/);
  assert.match(gallery, /<h3>Phone <span>390×844<\/span><\/h3>/);
  assert.match(gallery, /href="#route-estate-planning"/);
});

test("crawl mode drives real headless Chrome for full-page captures and color schemes", async (t) => {
  const unavailable = await realBrowserAvailable();
  if (unavailable) {
    t.skip(unavailable);
    return;
  }
  const port = await freePort();
  const { app, consumer, repoRoot } = await createConsumerRepo({
    serve: ["node", "server.mjs", String(port)],
    port,
    routes: ["/"],
    viewports: ["desktop", "tablet", "phone"],
    schemes: ["light", "dark"],
  }, { install: null });
  const preview = await buildConsumerPreview(consumer, app, { allowBrowserDownload: false, env: cleanEnv() });
  const outputDir = path.join(repoRoot, ".timds", "preview", "web");
  assert.equal(await portAnswers(port), false);
  const expected = { desktop: 1440, phone: 390, tablet: 1024 };
  assert.equal(preview.routes[0].captures.length, 6);
  for (const capture of preview.routes[0].captures) {
    const png = await fs.readFile(path.join(outputDir, capture.file));
    assert.deepEqual(png.subarray(0, 8), PNG_SIGNATURE);
    assert.equal(png.readUInt32BE(16), expected[capture.viewport], `${capture.file} width`);
    assert.ok(png.readUInt32BE(20) >= 1400, `${capture.file} is a full-page capture`);
  }
  assert.match(await fs.readFile(path.join(outputDir, "pages", "root", "light.html"), "utf8"), /light-mode/);
  assert.match(await fs.readFile(path.join(outputDir, "pages", "root", "dark.html"), "utf8"), /dark-mode/);
});

test("a serve command that never becomes ready fails with its output and is stopped", async () => {
  const port = await freePort();
  const appRoot = await fs.mkdtemp(path.join(os.tmpdir(), "timds-consumer-serve-"));
  await fs.writeFile(path.join(appRoot, "slow.mjs"), `
import http from "node:http";
console.log("booting slowly");
http.createServer((q, r) => { r.writeHead(503); r.end("not yet"); }).listen(${port}, "127.0.0.1");
`, "utf8");
  await assert.rejects(
    startAppServer(["node", "slow.mjs"], { cwd: appRoot, port, timeoutMs: 1_500 }),
    (error) => /did not answer 200/.test(error.message) && /last status 503/.test(error.message) && /booting slowly/.test(error.message),
  );
  assert.equal(await portAnswers(port), false);
  await assert.rejects(
    startAppServer(["node", "-e", "console.error('boom'); process.exit(3)"], { cwd: appRoot, port, timeoutMs: 5_000 }),
    /exited \(code 3\).*boom/s,
  );
});

test("the gallery escapes route text and links only relative paths", () => {
  const html = renderPreviewGallery({
    schemaVersion: 1,
    app: "web",
    repository: "acme/shop",
    branch: "x",
    commit: null,
    pullRequest: null,
    designSystem: { systemId: "acme/core", commit: null },
    mode: "crawl",
    routes: [{
      path: "/<script>",
      slug: "script",
      html: null,
      pages: [],
      status: null,
      captures: [],
      error: "desktop/light: <b>broken</b>",
    }],
    generatedAt: "2026-10-03T00:00:00Z",
  });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;b&gt;broken&lt;\/b&gt;/);
  assert.doesNotMatch(html, /(?:href|src)="\//);
});

test("publish tars and gzips the preview and posts it with metadata and bearer auth", async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "timds-consumer-publish-"));
  const preview = {
    schemaVersion: 1,
    app: "web",
    repository: "acme/shop",
    branch: "design/hero",
    commit: "abc123",
    pullRequest: 9,
    designSystem: { systemId: "acme/core", commit: DESIGN_SYSTEM_COMMIT },
    mode: "crawl",
    routes: [{ path: "/", slug: "root", html: "pages/root/light.html", pages: [], status: 200, captures: [{ viewport: "desktop", scheme: "light", width: 1440, height: 900, file: "captures/root/desktop-light.png" }] }],
    generatedAt: "2026-10-03T00:00:00Z",
  };
  await fs.mkdir(path.join(outputDir, "captures", "root"), { recursive: true });
  await fs.writeFile(path.join(outputDir, "captures", "root", "desktop-light.png"), PNG_SIGNATURE);
  await fs.writeFile(path.join(outputDir, "preview.json"), JSON.stringify(preview));
  await fs.writeFile(path.join(outputDir, "index.html"), "<!doctype html>");
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ init, url });
    return new Response(JSON.stringify({ previewUrl: "https://portal.test/p/abc" }), { status: 201, headers: { "content-type": "application/json" } });
  };
  const result = await publishConsumerPreview(outputDir, { fetchImpl, portalUrl: "https://portal.test/ignored/path", token: "cli-token" });
  assert.deepEqual(result, { previewUrl: "https://portal.test/p/abc" });
  assert.equal(calls.length, 1);
  const [{ init, url }] = calls;
  assert.equal(url, "https://portal.test/api/timds/consumer-previews");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer cli-token");
  assert.equal(init.headers["Content-Type"], "application/gzip");
  const metadata = JSON.parse(Buffer.from(init.headers["x-timds-build-metadata"], "base64").toString("utf8"));
  const { routes: _routes, ...summary } = preview;
  assert.deepEqual(metadata, { ...summary, compare: null, changedRouteCount: 0, routeCount: 1, captureCount: 1, designRouteCount: 0 });
  const compared = {
    ...preview,
    compare: { base: "main", baseCommit: "f00d", status: "ready", reason: null, changedFiles: ["web/src/a.css"] },
    changedRouteCount: 1,
    dropped: [{ route: "/", what: "x", files: ["base/captures/root/desktop-light.png"] }],
  };
  const comparedMetadata = JSON.parse(Buffer.from(previewMetadataHeader(compared), "base64").toString("utf8"));
  assert.deepEqual(comparedMetadata.compare, { base: "main", baseCommit: "f00d", status: "ready" });
  assert.equal(comparedMetadata.changedRouteCount, 1);
  assert.equal(comparedMetadata.dropped, undefined);
  assert.equal(init.headers["x-timds-build-metadata"], previewMetadataHeader(preview));
  const body = Buffer.from(init.body);
  assert.deepEqual([...body.subarray(0, 2)], [0x1f, 0x8b], "body is gzip");
  const tar = gunzipSync(body).toString("latin1");
  for (const name of ["./preview.json", "./index.html", "./captures/root/desktop-light.png"]) assert.ok(tar.includes(name), `archive has ${name}`);

  const failing = async () => new Response(JSON.stringify({ error: "Token is not bound to this client" }), { status: 403 });
  await assert.rejects(publishConsumerPreview(outputDir, { fetchImpl: failing, portalUrl: "https://portal.test", token: "t" }), /403.*not bound/);
  const credentialsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "timds-consumer-creds-"));
  const saved = process.env.TIMDS_ACCESS_TOKEN;
  delete process.env.TIMDS_ACCESS_TOKEN;
  try {
    await assert.rejects(
      publishConsumerPreview(outputDir, { credentialsPath: path.join(credentialsDirectory, "none.json"), fetchImpl, portalUrl: "https://portal.test" }),
      /TIMDS_ACCESS_TOKEN/,
    );
  } finally {
    if (saved !== undefined) process.env.TIMDS_ACCESS_TOKEN = saved;
  }
  await assert.rejects(publishConsumerPreview(path.join(outputDir, "nope"), { fetchImpl, token: "t" }), /preview\.json is missing/);
});

// ---------------------------------------------------------------------------
// Discovery, comparison, element maps

// A product whose pages are files under src/pages, stamped like Astro dev
// output. argv[3] "absolute" stamps absolute paths (as Astro does); otherwise
// the app-relative path.
const PAGES_SERVER = `
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
const port = Number(process.argv[2]);
const absolute = process.argv[3] === "absolute";
http.createServer((request, response) => {
  const url = new URL(request.url, "http://local");
  if (url.pathname === "/sitemap.xml") {
    if (!fs.existsSync("sitemap.xml")) { response.writeHead(404); response.end("no"); return; }
    response.writeHead(200, { "content-type": "application/xml" });
    response.end(fs.readFileSync("sitemap.xml"));
    return;
  }
  const name = url.pathname === "/" ? "index" : url.pathname.replace(/^\\/+|\\/+$/g, "");
  const file = path.join("src", "pages", name + ".html");
  if (!/^[a-z0-9/-]+$/.test(name) || !fs.existsSync(file)) {
    response.writeHead(404, { "content-type": "text/html" });
    response.end("<!doctype html><html><body><h1>Not found</h1></body></html>");
    return;
  }
  const html = fs.readFileSync(file, "utf8").replaceAll("__FILE__", absolute ? path.resolve(file) : file.split(path.sep).join("/"));
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
}).listen(port, "127.0.0.1");
`;

const page = (title, body, color = "#222222") => `<!doctype html>
<html><head><title>${title}</title><style>body { margin: 0; font: 20px sans-serif; } h1 { color: ${color}; padding: 40px; }</style></head>
<body>
<h1 data-astro-source-file="__FILE__" data-astro-source-loc="3:1">${title}</h1>
${body}
</body></html>
`;

async function writeFile(root, relative, content) {
  const target = path.join(root, ...relative.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

/**
 * A git repo whose `main` branch holds `basePages` and whose checked-out
 * branch `design/x` holds `headPages` (null deletes a page). `withManifest:
 * false` leaves the manifest out of the base commit.
 */
async function createCompareRepo({ basePages, headPages, preview, withManifest = true, stamp = "relative", extraBase = {} }) {
  const repoRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "timds-consumer-compare-")));
  const manifest = {
    schemaVersion: 1,
    designSystem: { path: "design-system", systemId: "acme/core" },
    apps: { web: { cwd: "web", install: ["node", "-e", "require('fs').writeFileSync('installed.txt', 'yes')"], preview: { ...preview, serve: ["node", "server.mjs", String(preview.port), stamp] }, designSurface: ["src/**"] } },
  };
  git(repoRoot, "init", "-q", "-b", "main");
  git(repoRoot, "config", "user.email", "test@example.com");
  git(repoRoot, "config", "user.name", "Test");
  git(repoRoot, "config", "commit.gpgsign", "false");
  await writeFile(repoRoot, "web/server.mjs", PAGES_SERVER);
  await writeFile(repoRoot, ".gitignore", "web/installed.txt\n");
  for (const [name, html] of Object.entries(basePages)) await writeFile(repoRoot, `web/src/pages/${name}.html`, html);
  for (const [file, content] of Object.entries(extraBase)) await writeFile(repoRoot, file, content);
  if (withManifest) await writeFile(repoRoot, "timds.consumer.json", `${JSON.stringify(manifest, null, 2)}\n`);
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-q", "-m", "base");
  git(repoRoot, "checkout", "-q", "-b", "design/x");
  if (!withManifest) await writeFile(repoRoot, "timds.consumer.json", `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [name, html] of Object.entries(headPages)) {
    const target = path.join(repoRoot, "web", "src", "pages", `${name}.html`);
    if (html === null) await fs.rm(target, { force: true });
    else await writeFile(repoRoot, `web/src/pages/${name}.html`, html);
  }
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-q", "-m", "head", "--allow-empty");
  const consumer = await loadConsumer(repoRoot);
  return { app: resolveConsumerApp(consumer, "web"), consumer, repoRoot };
}

const fnv = (text) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  return hash;
};

// One 4-pixel band per line of HTML, coloured by that line, so one changed
// line changes one band. Real PNG bytes, decodable by the diff.
function bandsPng(lines, width = 20) {
  const height = Math.max(1, lines.length) * 4;
  const data = Buffer.alloc(width * height * 4);
  lines.forEach((line, index) => {
    const hash = fnv(line);
    for (let y = index * 4; y < index * 4 + 4; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const at = (y * width + x) * 4;
        data[at] = hash & 0xff;
        data[at + 1] = (hash >>> 8) & 0xff;
        data[at + 2] = (hash >>> 16) & 0xff;
        data[at + 3] = 255;
      }
    }
  });
  return encodePng({ data, height, width });
}

// Stands in for Chrome with real PNGs, link harvesting, and element maps
// built from the Astro stamps, so discovery and comparison run without a browser.
function renderingBrowser(log = []) {
  return async () => ({
    async capture({ url, width, scheme, links, elementMap }) {
      log.push({ elementMap: Boolean(elementMap), links: Boolean(links), path: new URL(url).pathname, scheme, width });
      const response = await fetch(url);
      const html = await response.text();
      const lines = html.split("\n");
      const result = { html, png: bandsPng(lines.map((line) => `${line}|${scheme}|${width}`)), status: response.status };
      if (links) result.links = [...html.matchAll(/href="([^"]*)"/g)].map((match) => new URL(match[1], url).href);
      if (elementMap) {
        result.map = {
          width: 20,
          height: lines.length * 4,
          elements: [...html.matchAll(/<(\w+)[^>]*data-astro-source-file="([^"]+)" data-astro-source-loc="(\d+):(\d+)"[^>]*>([^<]*)/g)].map((match, index) => ({
            id: `e${index + 1}`,
            rect: [0, index * 4, 20, 4],
            selector: `body > ${match[1]}:nth-of-type(1)`,
            tag: match[1],
            text: match[5].trim(),
            source: { file: match[2], line: Number(match[3]), column: Number(match[4]) },
          })),
        };
      }
      return result;
    },
    async close() {},
  });
}

const worktreeCount = (repoRoot) => git(repoRoot, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).length;

test("routeKey, discoverablePath, and parseSitemap normalise discovered links", () => {
  assert.equal(routeKey("/about/"), "/about");
  assert.equal(routeKey("/"), "/");
  const origin = "http://127.0.0.1:4321";
  assert.equal(discoverablePath("/about?x=1#top", origin), "/about");
  assert.equal(discoverablePath("http://localhost:4321/team/", origin), "/team/");
  assert.equal(discoverablePath("http://localhost:9999/team", origin), null);
  assert.equal(discoverablePath("https://elsewhere.test/page", origin), null);
  assert.equal(discoverablePath("mailto:hi@example.com", origin), null);
  assert.equal(discoverablePath("/files/report.pdf", origin), null);
  assert.equal(discoverablePath("/legacy/page.html", origin), "/legacy/page.html");
  assert.equal(discoverablePath("/admin/users", origin, ["/admin/**"]), null);
  assert.equal(discoverablePath("/admin", origin, ["/admin/**"]), null);
  assert.equal(discoverablePath("/administrator", origin, ["/admin/**"]), "/administrator");
  assert.equal(discoverablePath("/blog/2026/print", origin, ["/blog/*/print"]), null);
  assert.deepEqual(parseSitemap(`<?xml version="1.0"?><urlset><url><loc> https://x.test/a?b=1&amp;c=2 </loc></url><url><loc><![CDATA[https://x.test/b]]></loc></url></urlset>`), {
    index: false,
    locs: ["https://x.test/a?b=1&c=2", "https://x.test/b"],
  });
  assert.equal(parseSitemap("<sitemapindex><sitemap><loc>https://x.test/s1.xml</loc></sitemap></sitemapindex>").index, true);
});

test("discovery follows same-origin links breadth-first, reads the sitemap, skips excluded paths, and stops at the limit", async () => {
  const port = await freePort();
  const index = page("Home", [
    '<a href="/about">About</a>',
    '<a href="/contact?ref=nav#top">Contact</a>',
    '<a href="/about/">About again</a>',
    '<a href="/files/report.pdf">Report</a>',
    '<a href="https://elsewhere.test/page">Elsewhere</a>',
    '<a href="/admin/secret">Admin</a>',
    '<a href="mailto:hi@example.com">Mail</a>',
  ].join("\n"));
  const pages = {
    index,
    about: page("About", '<a href="/team">Team</a>'),
    contact: page("Contact", ""),
    team: page("Team", ""),
    blog: page("Blog", ""),
    "admin/secret": page("Secret", ""),
    "admin/hidden": page("Hidden", ""),
  };
  const sitemap = `<?xml version="1.0"?><urlset><url><loc>https://shop.example.com/blog</loc></url><url><loc>https://shop.example.com/admin/hidden</loc></url><url><loc>https://shop.example.com/about</loc></url></urlset>`;
  const { app, consumer, repoRoot } = await createCompareRepo({
    basePages: pages,
    headPages: {},
    extraBase: { "web/sitemap.xml": sitemap },
    preview: { port, routes: ["/"], viewports: ["phone"], schemes: ["light"], discover: { exclude: ["/admin/**"], limit: 3 } },
  });
  const log = [];
  const preview = await buildConsumerPreview(consumer, app, { env: cleanEnv(), install: false, launchBrowser: renderingBrowser(log) });
  assert.deepEqual(preview.routes.map((route) => [route.path, route.declared, route.discovered, route.change]), [
    ["/", true, false, "unknown"],
    ["/about", false, true, "unknown"],
    ["/contact", false, true, "unknown"],
    ["/blog", false, true, "unknown"],
  ]);
  assert.ok(log.every((entry) => entry.elementMap), "head captures ask for element maps");
  assert.equal(await portAnswers(port), false);

  const wide = { ...consumer, apps: { web: { ...consumer.apps.web, preview: { ...consumer.apps.web.preview, discover: { from: ["/"], exclude: ["/admin/**"], limit: 10 } } } } };
  const widePreview = await buildConsumerPreview(wide, resolveConsumerApp(wide, "web"), { env: cleanEnv(), install: false, launchBrowser: renderingBrowser() });
  assert.deepEqual(widePreview.routes.map((route) => route.path), ["/", "/about", "/contact", "/blog", "/team"]);
  const outputDir = path.join(repoRoot, ".timds", "preview", "web");
  const map = await readJson(path.join(outputDir, "maps", "about", "phone-light.json"));
  assert.deepEqual(map.elements[0].source, { file: "web/src/pages/about.html", line: 3, column: 1 });
  assert.equal(widePreview.routes[1].captures[0].map, "maps/about/phone-light.json");
});

test("--base compares the merge base built in a temporary worktree with HEAD", async () => {
  const port = await freePort();
  const nav = '<a href="/about">About</a>\n<a href="/contact">Contact</a>';
  const { repoRoot } = await createCompareRepo({
    basePages: { index: page("Home", nav), about: page("About", "<p>Old copy</p>"), contact: page("Contact", "") },
    headPages: { about: page("About", "<p>New copy</p>", "#c0007a"), pricing: page("Pricing", "") },
    preview: { port, routes: ["/", "/pricing"], discover: {} },
  });
  const baseSha = git(repoRoot, "rev-parse", "main");
  const lines = [];
  const result = await runConsumerPreview(["--root", repoRoot, "--app", "web", "--base", "main", "--no-install"], {
    launchBrowser: renderingBrowser(),
    output: (line) => lines.push(line),
  });
  const { preview, outputDir } = result;
  assert.equal(await portAnswers(port), false, "the port is free afterwards");
  assert.equal(worktreeCount(repoRoot), 1, "the base worktree is removed");
  assert.equal(git(repoRoot, "worktree", "list").includes("base-checkout"), false);
  assert.deepEqual(preview.compare, { base: "main", baseCommit: baseSha, status: "ready", reason: null, changedFiles: ["web/src/pages/about.html", "web/src/pages/pricing.html"] });
  assert.equal(preview.changedRouteCount, 2);
  const byPath = Object.fromEntries(preview.routes.map((route) => [route.path, route]));
  assert.deepEqual(preview.routes.map((route) => [route.path, route.declared, route.discovered, route.change]), [
    ["/", true, false, "unchanged"],
    ["/pricing", true, false, "added"],
    ["/about", false, true, "changed"],
    ["/contact", false, true, "unchanged"],
  ]);
  assert.deepEqual(byPath["/about"].affectedBy, ["web/src/pages/about.html"]);
  assert.deepEqual(byPath["/pricing"].affectedBy, ["web/src/pages/pricing.html"]);
  assert.deepEqual(byPath["/"].affectedBy, []);
  assert.deepEqual(byPath["/contact"].captures, [], "unchanged discovered routes are listed without captures");
  assert.equal(byPath["/contact"].html, null);
  assert.equal(byPath["/"].captures.length, 4, "declared routes get the full matrix even when unchanged");
  for (const capture of byPath["/"].captures) {
    assert.equal(capture.diff.changedPixels, 0);
    assert.ok(existsSync(path.join(outputDir, capture.base.file)));
  }
  const about = byPath["/about"].captures[0];
  assert.deepEqual(Object.keys(about), ["viewport", "scheme", "width", "height", "file", "base", "diff", "map"]);
  assert.equal(about.base.file, "base/captures/about/desktop-light.png");
  assert.equal(about.diff.file, "diffs/about/desktop-light.png");
  assert.equal(about.map, "maps/about/desktop-light.json");
  assert.ok(about.diff.changedRatio > 0.0005 && about.diff.changedPixels > 0);
  const overlay = decodePng(await fs.readFile(path.join(outputDir, about.diff.file)));
  const head = decodePng(await fs.readFile(path.join(outputDir, about.file)));
  assert.equal(overlay.width, head.width);
  assert.equal(byPath["/about"].captures.length, 4);
  assert.ok(lines.some((line) => line.includes("2 of 4 pages changed compared with main")));
  const written = await readJson(path.join(outputDir, "preview.json"));
  assert.deepEqual(written, preview);

  const gallery = await fs.readFile(path.join(outputDir, "index.html"), "utf8");
  assert.match(gallery, /2 of 4 pages changed compared with main/);
  assert.doesNotMatch(gallery, /<script/i);
  assert.ok(gallery.indexOf('id="route-about"') < gallery.indexOf('id="route-root"'), "changed routes come first");
  assert.match(gallery, /<details class="unchanged"><summary>2 pages without visible changes<\/summary>/);
  assert.match(gallery, /Likely from the edits to <span title="web\/src\/pages\/about.html">about\.html<\/span>/);
  assert.match(gallery, /<input type="radio" class="pick pick-before"/);
  for (const match of gallery.matchAll(/(?:href|src)="([^"]+)"/g)) {
    assert.doesNotMatch(match[1], /^(?:\/|[a-z]+:)/i, `gallery link ${match[1]} must be relative`);
    if (!match[1].startsWith("#")) assert.ok(existsSync(path.join(outputDir, decodeURIComponent(match[1]))), match[1]);
  }

  // Over the archive limits: base and diff images of the unchanged declared route go first.
  const { files } = await scanPreviewTree(outputDir, "preview");
  const consumer = await loadConsumer(repoRoot);
  const limited = await buildConsumerPreview(consumer, resolveConsumerApp(consumer, "web"), {
    base: "main",
    env: cleanEnv(),
    install: false,
    launchBrowser: renderingBrowser(),
    limits: { ...PREVIEW_LIMITS, maxFiles: files.length - 1 },
    output: () => {},
  });
  assert.deepEqual(limited.dropped.map((entry) => [entry.route, entry.files.length]), [["/", 8]]);
  assert.match(limited.dropped[0].what, /unchanged/);
  const root = limited.routes.find((route) => route.path === "/");
  assert.ok(root.captures.every((capture) => capture.base === null && capture.diff === null));
  assert.ok(!existsSync(path.join(outputDir, "base", "captures", "root")));
  assert.ok(limited.routes.find((route) => route.path === "/about").captures.every((capture) => capture.base && capture.diff));
  assert.match(await fs.readFile(path.join(outputDir, "index.html"), "utf8"), /some images were left out/);
});

test("--base uses the base published pin for a nested app and reuses identical pins offline", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "timds-published-compare-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "web"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "commit.gpgsign", "false");
  const url = "https://cdn.test/acme/core/artifact";
  const manifest = {
    schemaVersion: 1,
    designSystem: { path: "design-system", systemId: "acme/core", version: "1.0.0", url },
    apps: { web: {
      cwd: "web", install: ["node", "-e", "require('fs').writeFileSync('installed.txt', 'yes')"],
      preview: { build: ["node", "build.mjs"], output: "dist", routes: ["/"], viewports: ["phone"], schemes: ["light"] },
      designSurface: ["src/**"],
    } },
  };
  await fs.writeFile(path.join(root, "timds.consumer.json"), JSON.stringify(manifest));
  await fs.writeFile(path.join(root, ".gitignore"), "design-system/\nweb/dist/\nweb/installed.txt\n.timds/preview/\n");
  await fs.writeFile(path.join(root, "web/build.mjs"), "import fs from 'node:fs'; fs.mkdirSync('dist', {recursive:true}); fs.writeFileSync('dist/index.html', '<h1>' + fs.readFileSync('../design-system/theme.txt', 'utf8') + '</h1>');");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base pin");
  git(root, "checkout", "-q", "-b", "update-pin");
  manifest.designSystem.version = "2.0.0";
  await fs.writeFile(path.join(root, "timds.consumer.json"), JSON.stringify(manifest));
  git(root, "add", "timds.consumer.json");
  git(root, "commit", "-q", "-m", "move pin");
  const requests = [];
  const fetchImpl = async (address) => {
    requests.push(address);
    const version = String(address).includes("/v/1.0.0/") ? "1.0.0" : "2.0.0";
    const body = version === "1.0.0" ? "OLD" : "NEW";
    const directory = `${url}/v/${version}/bundle`;
    if (address === `${directory}/theme.txt`) return new Response(body);
    if (address === `${url}/v/${version}/bundle.json`) return Response.json({
      system: { id: "acme/core", version }, directory, files: [{ path: "theme.txt", url: `${directory}/theme.txt`, bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") }],
    });
    throw new Error(`Unexpected fetch ${address}`);
  };
  await syncConsumerBundle(root, { fetchImpl });
  requests.length = 0;
  const consumer = await loadConsumer(root);
  const app = resolveConsumerApp(consumer, "web");
  const capturedHtml = [];
  const browser = async () => {
    const renderer = await renderingBrowser()();
    return { ...renderer, async capture(options) {
      const shot = await renderer.capture(options);
      capturedHtml.push(shot.html);
      return shot;
    } };
  };
  const preview = await buildConsumerPreview(consumer, app, { base: "main", env: cleanEnv(), fetchImpl, launchBrowser: browser });
  assert.equal(preview.compare.status, "ready", preview.compare.reason);
  assert.equal(preview.changedRouteCount, 1, "a changed bundle must appear in the before/after comparison");
  const output = path.join(root, ".timds/preview/web");
  assert.match(capturedHtml[0], /<h1>OLD<\/h1>/);
  assert.ok(existsSync(path.join(output, "base/captures/root/phone-light.png")));
  assert.match(await fs.readFile(path.join(output, "pages/root/light.html"), "utf8"), /<h1>NEW<\/h1>/);
  assert.deepEqual(requests, [`${url}/v/1.0.0/bundle.json`, `${url}/v/1.0.0/bundle/theme.txt`]);

  const offline = await buildConsumerPreview(consumer, app, { base: "HEAD", env: cleanEnv(), fetchImpl: async () => { throw new Error("offline"); }, launchBrowser: renderingBrowser() });
  assert.equal(offline.compare.status, "ready", offline.compare.reason);
  assert.equal(offline.changedRouteCount, 0);

  const unavailable = await buildConsumerPreview(consumer, app, { base: "main", env: cleanEnv(), fetchImpl: async () => { throw new Error("offline"); }, launchBrowser: renderingBrowser() });
  assert.equal(unavailable.compare.status, "unavailable", "an unresolved base pin must not be shown using HEAD's bundle");
  assert.match(unavailable.compare.reason, /Design System could not be prepared.*offline/);
});

test("--base records an unavailable comparison and still previews the head when the base cannot be shown", async () => {
  const port = await freePort();
  const { app, consumer, repoRoot } = await createCompareRepo({
    basePages: { index: page("Home", "") },
    headPages: { index: page("Home", "<p>New</p>") },
    preview: { port, routes: ["/"], viewports: ["phone"], schemes: ["light"] },
    withManifest: false,
  });
  const lines = [];
  const preview = await buildConsumerPreview(consumer, app, { base: "main", env: cleanEnv(), install: false, launchBrowser: renderingBrowser(), output: (line) => lines.push(line) });
  assert.equal(preview.compare.status, "unavailable");
  assert.match(preview.compare.reason, /timds\.consumer\.json does not exist at main/);
  assert.equal(preview.compare.baseCommit, git(repoRoot, "rev-parse", "main"));
  assert.equal(preview.changedRouteCount, 0);
  assert.deepEqual(preview.routes.map((route) => [route.path, route.change, route.captures.length, route.captures[0].base]), [["/", "unknown", 1, null]]);
  assert.ok(lines.some((line) => line.startsWith("Comparison unavailable:")));
  const gallery = await fs.readFile(path.join(repoRoot, ".timds", "preview", "web", "index.html"), "utf8");
  assert.match(gallery, /Comparison with main was not available: timds\.consumer\.json does not exist/);

  // The base exists but its serve command fails: unavailable, worktree removed, head still captured.
  const broken = await createCompareRepo({
    basePages: { index: page("Home", "") },
    headPages: { index: page("Home", "<p>New</p>") },
    preview: { port, routes: ["/"], viewports: ["phone"], schemes: ["light"] },
  });
  await fs.writeFile(path.join(broken.repoRoot, "web", "server.mjs"), PAGES_SERVER);
  git(broken.repoRoot, "checkout", "-q", "main");
  await fs.writeFile(path.join(broken.repoRoot, "web", "server.mjs"), "process.exit(4)\n");
  git(broken.repoRoot, "commit", "-q", "-am", "broken base server");
  git(broken.repoRoot, "checkout", "-q", "design/x");
  git(broken.repoRoot, "merge", "-q", "-s", "ours", "main", "-m", "keep head server");
  const brokenPreview = await buildConsumerPreview(broken.consumer, broken.app, { base: "main", env: cleanEnv(), install: false, launchBrowser: renderingBrowser() });
  assert.equal(brokenPreview.compare.status, "unavailable");
  assert.match(brokenPreview.compare.reason, /did not build or start at main/);
  assert.equal(brokenPreview.routes[0].captures.length, 1);
  assert.equal(worktreeCount(broken.repoRoot), 1);
  assert.equal(await portAnswers(port), false);

  await assert.rejects(buildConsumerPreview(consumer, app, { base: "no-such-branch", env: cleanEnv(), install: false, launchBrowser: renderingBrowser() }), /Could not find where no-such-branch and HEAD diverge.*git fetch/);
  await assert.rejects(runConsumerPreview(["--root", repoRoot, "--app", "web", "--base="]), /--base requires a value/);
});

test("normalizeSourceFile makes source stamps repository-relative", () => {
  const exists = (target) => ["/repo/web/src/App.tsx", "/repo/web/src/pages/a.astro", "/repo/lib/x.ts"].includes(target.split(path.sep).join("/"));
  const options = { appCwd: "web", exists, repoRoot: "/repo", roots: ["/private/repo", "/tmp/work/base-checkout"] };
  assert.equal(normalizeSourceFile("/repo/web/src/pages/a.astro", options), "web/src/pages/a.astro");
  assert.equal(normalizeSourceFile("/private/repo/web/src/pages/a.astro", options), "web/src/pages/a.astro");
  assert.equal(normalizeSourceFile("/tmp/work/base-checkout/web/src/x.css", options), "web/src/x.css");
  assert.equal(normalizeSourceFile("file:///repo/web/src/App.tsx", options), "web/src/App.tsx");
  assert.equal(normalizeSourceFile("src/App.tsx", options), "web/src/App.tsx");
  assert.equal(normalizeSourceFile("./src/App.tsx", options), "web/src/App.tsx");
  assert.equal(normalizeSourceFile("/src/App.tsx", options), "web/src/App.tsx");
  assert.equal(normalizeSourceFile("lib/x.ts", options), "lib/x.ts");
  assert.equal(normalizeSourceFile("src/Missing.tsx", options), "src/Missing.tsx");
  assert.equal(normalizeSourceFile("/elsewhere/x.ts", options), "/elsewhere/x.ts");
  assert.equal(normalizeSourceFile("", options), null);
});

test("the gallery puts changed routes first with a CSS-only before/after switch and no scripts", () => {
  const capture = (slug, extra = {}) => ({
    viewport: "desktop", scheme: "light", width: 1440, height: 900, file: `captures/${slug}/desktop-light.png`,
    base: { file: `base/captures/${slug}/desktop-light.png`, width: 1440, height: 1600 },
    diff: { file: `diffs/${slug}/desktop-light.png`, changedPixels: 5000, changedRatio: 0.0021 },
    map: `maps/${slug}/desktop-light.json`,
    ...extra,
  });
  const route = (pathName, slug, change, extra = {}) => ({ path: pathName, slug, declared: true, discovered: false, html: null, pages: [], status: 200, change, affectedBy: [], captures: [capture(slug)], ...extra });
  const html = renderPreviewGallery({
    schemaVersion: 1, app: "web", repository: "acme/shop", branch: "design/x", commit: "abc", pullRequest: 4,
    designSystem: { systemId: "acme/core", commit: null }, mode: "crawl",
    compare: { base: "master", baseCommit: "0123456789", status: "ready", reason: null, changedFiles: [] },
    changedRouteCount: 1,
    routes: [
      route("/", "root", "unchanged", { captures: [capture("root", { diff: { file: "diffs/root/desktop-light.png", changedPixels: 0, changedRatio: 0 } })] }),
      route("/blog", "blog", "unchanged", { declared: false, discovered: true, captures: [] }),
      route("/about", "about", "changed", { affectedBy: ["web/src/components/Hero.astro", "web/src/styles/site.css"] }),
    ],
    dropped: [],
    generatedAt: "2026-10-03T00:00:00Z",
  });
  assert.match(html, /1 of 3 pages changed compared with master\./);
  assert.ok(html.indexOf('id="route-about"') < html.indexOf("<details"), "the changed route precedes the collapsed unchanged ones");
  assert.ok(html.indexOf('id="route-root"') > html.indexOf("<details"));
  assert.match(html, /<span class="badge badge-changed">Changed<\/span>/);
  assert.match(html, /Likely from the edits to <span title="web\/src\/components\/Hero.astro">Hero\.astro<\/span> and <span title="web\/src\/styles\/site.css">site\.css<\/span>\./);
  assert.match(html, /<label class="tab tab-before" for="c\d+-before">Before<\/label><label class="tab tab-after" for="c\d+-after">After<\/label><label class="tab tab-changes" for="c\d+-changes">Changes<\/label>/);
  assert.match(html, /\.pick-changes:checked ~ \.view-changes/);
  assert.match(html, /0\.2% of pixels differ/);
  assert.match(html, /found by crawling/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /(?:href|src)="\//);
  const ids = [...html.matchAll(/ id="(c\d+-[a-z]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, "radio ids are unique");
});

// ---------------------------------------------------------------------------
// Real Chrome

async function serveHtml(html) {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("element maps list visible elements with full-page rects, stable selectors, own text, and source stamps (real Chrome)", async (t) => {
  const unavailable = await realBrowserAvailable();
  if (unavailable) {
    t.skip(unavailable);
    return;
  }
  const filler = Array.from({ length: MAX_MAP_ELEMENTS + 300 }, () => '<i style="display:block;height:2px"></i>').join("");
  const html = `<!doctype html><html><head><style>body{margin:0} .h{visibility:hidden} .n{display:none}</style></head><body>
<header id="top"><h1 data-astro-source-file="/abs/repo/web/src/pages/index.astro" data-astro-source-loc="12:4">  Welcome
   home  </h1></header>
<p data-source-file="src/a.tsx" data-source-line="7">Source stamp</p>
<p data-lov-id="src/components/Hero.tsx:21:9">Lovable</p>
<p data-component-path="src/B.tsx" data-component-line="3">Component</p>
<p data-inspector-relative-path="src/C.tsx" data-inspector-line="4" data-inspector-column="2">Inspector</p>
<div id="dup">a</div><div id="dup">b</div>
<p class="h">hidden</p><p class="n">gone</p><span></span>
<a href="/next?x=1">Next</a>
${filler}
<p id="last">Last words</p>
</body></html>`;
  const server = await serveHtml(html);
  const browser = await launchBrowser({ allowDownload: false });
  try {
    const shot = await browser.capture({ elementMap: true, height: 900, links: true, scheme: "light", url: `${server.origin}/`, width: 1440 });
    assert.deepEqual(shot.links, [`${server.origin}/next?x=1`]);
    const { elements } = shot.map;
    assert.equal(shot.map.width, 1440);
    assert.equal(elements.length, MAX_MAP_ELEMENTS, "capped");
    assert.deepEqual(elements.map((element) => element.id).slice(0, 3), ["e1", "e2", "e3"]);
    assert.equal(elements.at(-1).id, `e${MAX_MAP_ELEMENTS}`);
    const byText = (text) => elements.find((element) => element.text === text);
    const heading = byText("Welcome home");
    assert.deepEqual(heading.source, { file: "/abs/repo/web/src/pages/index.astro", line: 12, column: 4 });
    assert.equal(heading.selector, "#top > h1:nth-of-type(1)");
    assert.equal(heading.tag, "h1");
    assert.equal(heading.rect.length, 4);
    assert.deepEqual(byText("Source stamp").source, { file: "src/a.tsx", line: 7, column: null });
    assert.deepEqual(byText("Lovable").source, { file: "src/components/Hero.tsx", line: 21, column: 9 });
    assert.deepEqual(byText("Component").source, { file: "src/B.tsx", line: 3, column: null });
    assert.deepEqual(byText("Inspector").source, { file: "src/C.tsx", line: 4, column: 2 });
    assert.equal(byText("a").selector, "body > div:nth-of-type(1)", "duplicate ids fall back to nth-of-type");
    assert.equal(byText("hidden"), undefined);
    assert.equal(byText("gone"), undefined);
    const last = byText("Last words");
    assert.ok(last, "text-bearing elements survive the cap");
    assert.equal(last.selector, "#last");
    assert.ok(last.rect[1] > 900, "rects are in full-page coordinates");
    const order = elements.map((element) => Number(element.id.slice(1)));
    assert.deepEqual(order, [...order].sort((left, right) => left - right));
    assert.equal(elements.filter((element) => element.tag === "i").length, MAX_MAP_ELEMENTS - elements.filter((element) => element.tag !== "i").length);
  } finally {
    await browser.close();
    await server.close();
  }
});

test("--base compares real Chrome captures and maps Astro stamps to changed files (real Chrome)", async (t) => {
  const unavailable = await realBrowserAvailable();
  if (unavailable) {
    t.skip(unavailable);
    return;
  }
  const port = await freePort();
  const { app, consumer, repoRoot } = await createCompareRepo({
    basePages: { index: page("Home", '<a href="/about">About</a>'), about: page("About", "<p>Old copy</p>") },
    headPages: { about: page("About", "<p>New copy, longer than before</p>", "#c0007a") },
    preview: { port, routes: ["/"], viewports: ["desktop"], schemes: ["light"], discover: {} },
    stamp: "absolute",
  });
  const preview = await buildConsumerPreview(consumer, app, { allowBrowserDownload: false, base: "main", env: cleanEnv(), install: false, output: () => {} });
  const outputDir = path.join(repoRoot, ".timds", "preview", "web");
  assert.equal(preview.compare.status, "ready");
  assert.equal(await portAnswers(port), false);
  assert.equal(worktreeCount(repoRoot), 1);
  const [root, about] = preview.routes;
  assert.equal(root.change, "unchanged");
  assert.equal(root.captures[0].diff.changedPixels, 0);
  assert.equal(about.change, "changed");
  assert.deepEqual(about.affectedBy, ["web/src/pages/about.html"]);
  const map = await readJson(path.join(outputDir, about.captures[0].map));
  assert.equal(map.schemaVersion, 1);
  assert.equal(map.width, 1440);
  const heading = map.elements.find((element) => element.tag === "h1");
  assert.deepEqual(heading.source, { file: "web/src/pages/about.html", line: 3, column: 1 });
  assert.equal(heading.text, "About");
  const overlay = decodePng(await fs.readFile(path.join(outputDir, about.captures[0].diff.file)));
  assert.equal(overlay.width, 1440);
  assert.ok(about.captures[0].diff.changedRatio > 0.0005);
});

test("--base reuses the checked-out Design System for the base worktree without fetching it", async () => {
  const port = await freePort();
  const { repoRoot } = await createCompareRepo({
    basePages: { index: page("Home", "<p>Old</p>") },
    headPages: { index: page("Home", "<p>New</p>") },
    preview: { port, routes: ["/"] },
  });
  // A real pinned submodule on the base branch, merged into the design branch.
  const systemRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "timds-consumer-system-")));
  git(systemRoot, "init", "-q", "-b", "main");
  git(systemRoot, "config", "user.email", "test@example.com");
  git(systemRoot, "config", "user.name", "Test");
  git(systemRoot, "config", "commit.gpgsign", "false");
  await writeFile(systemRoot, "timds.json", "{}\n");
  git(systemRoot, "add", ".");
  git(systemRoot, "commit", "-q", "-m", "system");
  git(repoRoot, "checkout", "-q", "main");
  git(repoRoot, "-c", "protocol.file.allow=always", "submodule", "add", "-q", systemRoot, "design-system");
  // The recorded URL stops resolving, the way CI has no credentials for it
  // outside the one checkout step: only the local link can provide the base.
  git(repoRoot, "config", "-f", ".gitmodules", "submodule.design-system.url", path.join(systemRoot, "gone"));
  git(repoRoot, "add", ".gitmodules", "design-system");
  git(repoRoot, "commit", "-q", "-m", "pin the design system");
  git(repoRoot, "checkout", "-q", "design/x");
  git(repoRoot, "merge", "-q", "--no-edit", "main");
  const lines = [];
  const { preview } = await runConsumerPreview(["--root", repoRoot, "--app", "web", "--base", "main", "--no-install"], {
    launchBrowser: renderingBrowser(),
    output: (line) => lines.push(line),
  });
  assert.equal(preview.compare.status, "ready");
  assert.equal(preview.routes[0].change, "changed");
  assert.equal(lines.some((line) => /could not check out design-system/.test(line)), false, lines.join("\n"));
  assert.equal(worktreeCount(repoRoot), 1, "the base worktree is removed");
  assert.equal(worktreeCount(path.join(repoRoot, "design-system")), 1, "the linked Design System worktree is removed");
  assert.equal(await portAnswers(port), false);
});

test("--base previews a workspace site with no pin: the base is the same workspace, and system files read from the site", async (t) => {
  const repoRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "timds-workspace-compare-")));
  t.after(() => fs.rm(repoRoot, { recursive: true, force: true }));
  const port = await freePort();
  git(repoRoot, "init", "-q", "-b", "main");
  git(repoRoot, "config", "user.email", "test@example.com");
  git(repoRoot, "config", "user.name", "Test");
  git(repoRoot, "config", "commit.gpgsign", "false");
  await writeFile(repoRoot, "timds.json", `${JSON.stringify({ schemaVersion: 2, systemId: "acme/core", name: "Acme" })}\n`);
  await writeFile(repoRoot, "src/styles/system.css", ":root { --brand: #111111; }\n");
  await writeFile(repoRoot, "site/timds.consumer.json", `${JSON.stringify({
    schemaVersion: 1,
    designSystem: { workspace: true, systemId: "acme/core" },
    apps: { site: { cwd: ".", preview: { serve: ["node", "server.mjs", String(port), "relative"], port, routes: ["/"] }, designSurface: ["src/**"] } },
  }, null, 2)}\n`);
  await writeFile(repoRoot, "site/server.mjs", PAGES_SERVER);
  await writeFile(repoRoot, "site/src/pages/index.html", page("Home", "<p>Old</p>"));
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-q", "-m", "base");
  git(repoRoot, "checkout", "-q", "-b", "design/x");
  await writeFile(repoRoot, "site/src/pages/index.html", page("Home", "<p>New</p>", "#c0007a"));
  await writeFile(repoRoot, "src/styles/system.css", ":root { --brand: #222222; }\n");
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-q", "-m", "head");
  const site = path.join(repoRoot, "site");

  const { preview } = await runConsumerPreview(["--root", site, "--app", "site", "--base", "main", "--no-install"], {
    env: cleanEnv(),
    launchBrowser: renderingBrowser(),
    output: () => {},
  });
  assert.equal(preview.compare.status, "ready", preview.compare.reason);
  assert.deepEqual(preview.compare.changedFiles, ["../src/styles/system.css", "src/pages/index.html"]);
  assert.deepEqual(preview.designSystem, { systemId: "acme/core", commit: git(repoRoot, "rev-parse", "HEAD"), workspace: true });
  const home = preview.routes.find((route) => route.path === "/");
  assert.equal(home.change, "changed");
  assert.deepEqual(home.affectedBy, ["src/pages/index.html"]);
  assert.equal(await portAnswers(port), false, "the port is free afterwards");
  assert.equal(git(repoRoot, "worktree", "list").includes("base-checkout"), false, "the base worktree is removed");
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";

import { launchBrowser } from "./consumer-browser.mjs";
import {
  buildConsumerPreview,
  normalizeRepository,
  previewMetadataHeader,
  publishConsumerPreview,
  renderPreviewGallery,
  resolvePullRequest,
  routeSlug,
  runConsumerPreview,
  startAppServer,
} from "./consumer-preview.mjs";
import { loadConsumer, resolveConsumerApp } from "./consumer.mjs";

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
    routes: [],
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
    html: "pages/contact/dark.html",
    pages: [{ scheme: "dark", file: "pages/contact/dark.html" }],
    status: 200,
    captures: [{ viewport: "phone", scheme: "dark", width: 390, height: 844, file: "captures/contact/phone-dark.png" }],
  });
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
  assert.deepEqual(metadata, { ...summary, routeCount: 1, captureCount: 1 });
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

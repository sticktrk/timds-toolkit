import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CONSUMER_MANIFEST_FILE,
  checkConsumer,
  consumerPreviewMode,
  loadConsumer,
  matchesGlob,
  resolveConsumerApp,
  runConsumerCli,
  validateConsumerManifest,
  parseDesignReference,
  CONSUMER_ALWAYS_ALLOWED,
  CONSUMER_SKILL_NAMES,
} from "./consumer.mjs";
import { runCli } from "./core.mjs";

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "timds-consumer-"));
  t.after(() => fs.rm(directory, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 }));
  return fs.realpath(directory);
}

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "protocol.file.allow=always", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function initRepo(cwd) {
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "config", "user.email", "timds-test@example.com");
  git(cwd, "config", "user.name", "TimDS Test");
  git(cwd, "config", "commit.gpgsign", "false");
}

async function write(root, relative, content) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
}

function staticApp(extra = {}) {
  return {
    cwd: "web",
    preview: { build: ["npm", "run", "build"], output: "dist" },
    designSurface: ["src/styles/**", "src/components/**", "public/**"],
    protected: ["src/components/server/**"],
    ...extra,
  };
}

function baseManifest(apps = { web: staticApp() }) {
  return { schemaVersion: 1, designSystem: { path: "design-system", systemId: "acme/core" }, apps };
}

/** A product repo with `design-system` as a real submodule of a second temp repo. */
async function consumerFixture(t, manifest = baseManifest()) {
  const root = await temporaryDirectory(t);
  const dsRepo = path.join(root, "ds-origin");
  const product = path.join(root, "product");
  await fs.mkdir(dsRepo);
  await fs.mkdir(product);
  initRepo(dsRepo);
  await write(dsRepo, "timds.json", { schemaVersion: 2, systemId: "acme/core", name: "Acme" });
  git(dsRepo, "add", ".");
  git(dsRepo, "commit", "-q", "-m", "Design system");
  const dsCommit = git(dsRepo, "rev-parse", "HEAD");

  initRepo(product);
  await write(product, CONSUMER_MANIFEST_FILE, manifest);
  await write(product, "web/package.json", { name: "web" });
  await write(product, "web/src/styles/site.css", "body{}\n");
  await write(product, "web/src/components/server/db.ts", "export {};\n");
  await write(product, "web/src/lib/api.ts", "export {};\n");
  await write(product, "README.md", "# Product\n");
  git(product, "submodule", "add", "-q", dsRepo, "design-system");
  git(product, "add", ".");
  git(product, "commit", "-q", "-m", "Product");
  return { dsCommit, dsRepo, product };
}

function assertInvalid(manifest, pattern) {
  assert.throws(() => validateConsumerManifest(manifest), (error) => {
    assert.match(error.message, /timds\.consumer\.json is invalid/);
    assert.match(error.message, pattern);
    return true;
  });
}

test("validateConsumerManifest accepts a published pin and rejects a url without a version", () => {
  const published = validateConsumerManifest({ ...baseManifest(), designSystem: { systemId: "acme/core", version: "1.4.0", url: "https://cdn.example.com/acme/core/artifact/" } });
  assert.deepEqual(published.designSystem, { path: "design-system", systemId: "acme/core", version: "1.4.0", url: "https://cdn.example.com/acme/core/artifact" });
  assert.equal(validateConsumerManifest({ ...baseManifest(), designSystem: { systemId: "acme/core", version: "current" } }).designSystem.version, "current");
  assertInvalid({ ...baseManifest(), designSystem: { systemId: "acme/core", url: "https://cdn.example.com/x" } }, /designSystem\.url applies to a published pin; add designSystem\.version/);
  assertInvalid({ ...baseManifest(), designSystem: { systemId: "acme/core", version: "v 1" } }, /designSystem\.version must be a published version label/);
  assertInvalid({ ...baseManifest(), designSystem: { systemId: "acme/core", version: "1.0.0", url: "ftp://cdn" } }, /designSystem\.url must be the HTTP or HTTPS prefix/);
  assertInvalid({ ...baseManifest(), designSystem: { systemId: "acme/core", version: "1.0.0", url: "https://cdn.example.com/x?token=1" } }, /without a query or credentials/);
});

test("validateConsumerManifest applies defaults", () => {
  const manifest = validateConsumerManifest({
    schemaVersion: 1,
    designSystem: { systemId: "acme/core" },
    apps: { web: { cwd: "./web/", preview: { serve: ["npm", "run", "dev"], port: 4321, routes: ["/", "/contact"] }, designSurface: ["src/**"] } },
  });
  assert.equal(manifest.designSystem.path, "design-system");
  const app = manifest.apps.web;
  assert.equal(app.cwd, "web");
  assert.deepEqual(app.protected, []);
  assert.equal(app.preview.ready, "/");
  assert.deepEqual(app.preview.viewports, ["desktop", "phone"]);
  assert.deepEqual(app.preview.schemes, ["light", "dark"]);
  assert.equal(consumerPreviewMode(app.preview), "crawl");
  assert.equal(consumerPreviewMode(validateConsumerManifest(baseManifest()).apps.web.preview), "static");
});

test("validateConsumerManifest accepts static-then-crawl and the issue example", () => {
  const manifest = validateConsumerManifest(baseManifest({
    web: staticApp({ preview: { build: ["npm", "run", "build"], output: "dist", routes: ["/"], viewports: ["tablet"], schemes: ["light"] } }),
    "acme.example": {
      cwd: "acme.example",
      install: ["npm", "ci"],
      preview: { serve: ["npm", "run", "dev"], port: 4321, ready: "/", routes: ["/", "/estate-planning"], viewports: ["desktop", "phone"], schemes: ["light", "dark"] },
      designSurface: ["src/styles/**"],
      protected: ["src/server/**", "scripts/**"],
    },
  }));
  assert.equal(consumerPreviewMode(manifest.apps.web.preview), "crawl");
  assert.deepEqual(manifest.apps["acme.example"].install, ["npm", "ci"]);
});

test("validateConsumerManifest rejects every contract violation with an actionable message", () => {
  const app = (overrides) => baseManifest({ web: { ...staticApp(), ...overrides } });
  const preview = (value) => app({ preview: value });
  assertInvalid(null, /must be a JSON object/);
  assertInvalid({ ...baseManifest(), schemaVersion: 2 }, /schemaVersion must be 1/);
  assertInvalid({ ...baseManifest(), extra: true }, /unknown field "extra"/);
  assertInvalid({ ...baseManifest(), designSystem: { path: "design-system" } }, /designSystem\.systemId/);
  assertInvalid({ ...baseManifest(), designSystem: { systemId: "acme core!" } }, /systemId must use letters/);
  assertInvalid({ ...baseManifest(), designSystem: { systemId: "acme/core", path: "../ds" } }, /designSystem\.path must be a relative path/);
  assertInvalid({ ...baseManifest(), apps: {} }, /at least one app/);
  assertInvalid({ ...baseManifest(), apps: { "bad name": staticApp() } }, /app name "bad name" must start with a letter/);
  assertInvalid(app({ cwd: "/abs" }), /apps\.web\.cwd: cwd must be a relative path/);
  assertInvalid(app({ cwd: "../up" }), /cwd must be a relative path/);
  assertInvalid(app({ install: "npm ci" }), /install must be a command/);
  assertInvalid(app({ designSurface: [] }), /designSurface must list at least one glob/);
  assertInvalid(app({ designSurface: ["../x/**"] }), /designSurface globs are relative/);
  assertInvalid(app({ protected: ["/etc/**"] }), /protected globs are relative/);
  assertInvalid(app({ unknown: 1 }), /unknown field "unknown"/);
  assertInvalid(preview({}), /must declare build \+ output .* or serve \+ port \+ routes/);
  assertInvalid(preview({ build: ["x"], output: "dist", serve: ["y"], port: 1, routes: ["/"] }), /exactly one mode/);
  assertInvalid(preview({ build: ["x"] }), /static preview needs both build .* and output/);
  assertInvalid(preview({ output: "dist" }), /static preview needs both/);
  assertInvalid(preview({ serve: ["npm", "run", "dev"], routes: ["/"] }), /crawl preview needs serve, port, and routes; missing port/);
  assertInvalid(preview({ serve: ["npm", "run", "dev"], port: 3000 }), /missing routes/);
  assertInvalid(preview({ port: 3000, routes: ["/"] }), /missing serve/);
  assertInvalid(preview({ serve: ["npm"], port: 70000, routes: ["/"] }), /port must be between 1 and 65535/);
  assertInvalid(preview({ serve: ["npm"], port: 3000, routes: [] }), /routes must list at least one route/);
  assertInvalid(preview({ serve: ["npm"], port: 3000, routes: ["contact"] }), /absolute URL paths/);
  assertInvalid(preview({ serve: ["npm"], port: 3000, routes: ["/"], ready: "ready" }), /absolute URL paths/);
  assertInvalid(preview({ serve: [], port: 3000, routes: ["/"] }), /preview\.serve must not be empty/);
  assertInvalid(preview({ build: ["x"], output: "dist", viewports: ["watch"] }), /viewports entries must be one of desktop, tablet, phone/);
  assertInvalid(preview({ build: ["x"], output: "dist", viewports: [] }), /viewports must not be empty/);
  assertInvalid(preview({ build: ["x"], output: "dist", schemes: ["sepia"] }), /schemes entries must be one of light, dark/);
  assertInvalid(preview({ build: ["x"], output: "dist", schemes: ["light", "light"] }), /must not repeat/);
  assertInvalid(preview({ build: ["x"], output: "dist", extra: 1 }), /unknown field "extra"/);
});

test("validateConsumerManifest accepts preview.discover in crawl mode with defaults and rejects it elsewhere", () => {
  const crawl = (discover, extra = {}) => baseManifest({ web: staticApp({ preview: { serve: ["npm", "run", "dev"], port: 4321, routes: ["/"], discover, ...extra } }) });
  assert.deepEqual(validateConsumerManifest(crawl({})).apps.web.preview.discover, { from: ["/"], limit: 40, exclude: [] });
  assert.deepEqual(
    validateConsumerManifest(crawl({ from: ["/", "/blog"], limit: 200, exclude: ["/admin/**"] })).apps.web.preview.discover,
    { from: ["/", "/blog"], limit: 200, exclude: ["/admin/**"] },
  );
  const staticCrawl = baseManifest({ web: staticApp({ preview: { build: ["x"], output: "dist", routes: ["/"], discover: { limit: 5 } } }) });
  assert.equal(validateConsumerManifest(staticCrawl).apps.web.preview.discover.limit, 5);
  assert.equal(validateConsumerManifest(crawl(undefined)).apps.web.preview.discover, undefined);
  assertInvalid(baseManifest({ web: staticApp({ preview: { build: ["x"], output: "dist", discover: {} } }) }), /preview\.discover only works in crawl mode/);
  assertInvalid(crawl({ limit: 0 }), /discover\.limit must be between 1 and 200/);
  assertInvalid(crawl({ limit: 201 }), /discover\.limit must be between 1 and 200/);
  assertInvalid(crawl({ limit: 2.5 }), /discover\.limit must be a whole number/);
  assertInvalid(crawl({ from: [] }), /discover\.from must list at least one/);
  assertInvalid(crawl({ from: ["blog"] }), /absolute URL paths/);
  assertInvalid(crawl({ exclude: ["admin/**"] }), /exclude globs are URL path globs/);
  assertInvalid(crawl({ exclude: "/admin/**" }), /exclude must be an array/);
  assertInvalid(crawl({ depth: 2 }), /unknown field "depth"/);
  assertInvalid(crawl("yes"), /preview\.discover must be an object/);
});

test("validateConsumerManifest pairs routes with design pages only in crawl mode and only for listed routes", () => {
  const crawl = (designs) => baseManifest({ web: { ...staticApp(), preview: { serve: ["npm", "run", "dev"], port: 4321, routes: ["/", "/contact"], designs } } });
  const valid = validateConsumerManifest(crawl({ "/": "website:/", "/contact/": "website:/contact" }));
  assert.deepEqual(valid.apps.web.preview.designs, { "/": "website:/", "/contact/": "website:/contact" });
  assert.deepEqual(parseDesignReference("website:/contact/"), { design: "website", route: "/contact" });
  assert.deepEqual(parseDesignReference("website:/"), { design: "website", route: "/" });
  assert.equal(parseDesignReference("website"), null);
  assertInvalid(crawl({ "/": "website" }), /"<design>:<route>", such as "website:\/contact"/);
  assertInvalid(crawl({ "/": "Web Site:/" }), /"<design>:<route>"/);
  assertInvalid(crawl({ "/about": "website:/about" }), /pairs \/about, which preview\.routes does not list/);
  assertInvalid(crawl(["website:/"]), /preview\.designs must be an object keyed by route/);
  assertInvalid(baseManifest({ web: { ...staticApp(), preview: { build: ["npm", "run", "build"], output: "dist", designs: { "/": "website:/" } } } }), /needs preview\.routes \(crawl mode\)/);
});

test("checkConsumer verifies every design pairing against the pin's own catalog", async (t) => {
  const crawl = (designs) => baseManifest({ web: { ...staticApp(), preview: { serve: ["npm", "run", "dev"], port: 4321, routes: ["/", "/contact", "/about"], designs } } });
  const { product } = await consumerFixture(t, crawl({ "/": "website:/", "/contact": "website:/contact", "/about": "shop:/about" }));
  // Without designs in the pin, every pairing is an error that names the gap.
  let result = await checkConsumer(product);
  assert.equal(result.status, "failed");
  assert.match(result.errors.join("\n"), /pairs \/ with website:\/, but design-system has no src\/designs\//);
  await write(product, "design-system/src/designs/website/design.json", { title: "Site" });
  await write(product, "design-system/src/designs/website/pages/index.html", "<h1>Home</h1>");
  result = await checkConsumer(product);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.errors, [
    'App "web": preview.designs pairs /contact with website:/contact, but design website has no route /contact (routes: /)',
    'App "web": preview.designs pairs /about with shop:/about, but design-system has no design shop (designs: website)',
  ]);
  assert.deepEqual(result.apps, [{ name: "web", cwd: "web", cwdExists: true, mode: "crawl", designs: 3 }]);
  await write(product, "design-system/src/designs/website/pages/contact.html", "<h1>Contact</h1>");
  await write(product, "design-system/src/designs/shop/design.json", { title: "Shop" });
  await write(product, "design-system/src/designs/shop/pages/about.html", "<h1>About</h1>");
  await write(product, "design-system/src/designs/shop/pages/index.html", "<h1>Shop</h1>");
  result = await checkConsumer(product);
  assert.equal(result.status, "passed", result.errors.join("\n"));
  // A pin whose catalog is malformed is a warning, not a silent pass.
  await write(product, "design-system/src/designs/shop/design.json", "{ nope");
  result = await checkConsumer(product);
  assert.match(result.warnings.join("\n"), /website designs could not be read: .*design\.json is invalid JSON/);
});

test("matchesGlob supports **, *, ? and literal directories", () => {
  assert.equal(matchesGlob("src/styles/a/b.css", "src/styles/**"), true);
  assert.equal(matchesGlob("src/a.css", "src/**/*.css"), true);
  assert.equal(matchesGlob("src/x/y/a.css", "src/**/*.css"), true);
  assert.equal(matchesGlob("src/x/a.ts", "src/**/*.css"), false);
  assert.equal(matchesGlob("src/a", "src/*"), true);
  assert.equal(matchesGlob("src/a/b", "src/*"), false);
  assert.equal(matchesGlob("a1.css", "a?.css"), true);
  assert.equal(matchesGlob("a12.css", "a?.css"), false);
  assert.equal(matchesGlob("public/img/x.png", "public"), true);
  assert.equal(matchesGlob("publicity.txt", "public"), false);
  assert.equal(matchesGlob("src/a+b.css", "src/a+b.css"), true);
});

test("loadConsumer resolves the manifest and the pinned gitlink commit", async (t) => {
  const { dsCommit, product } = await consumerFixture(t);
  const consumer = await loadConsumer(path.join(product, "web", "src"));
  assert.equal(consumer.repoRoot, product);
  assert.equal(consumer.manifestPath, path.join(product, CONSUMER_MANIFEST_FILE));
  assert.equal(consumer.designSystem.root, path.join(product, "design-system"));
  assert.equal(consumer.designSystem.commit, dsCommit);
  assert.equal(consumer.designSystem.present, true);
  assert.equal(consumer.designSystem.systemId, "acme/core");
  assert.equal(consumer.apps, consumer.manifest.apps);
  assert.deepEqual(consumer.apps.web.preview.viewports, ["desktop", "phone"]);
});

test("loadConsumer reports a missing manifest and a missing design system", async (t) => {
  const root = await temporaryDirectory(t);
  initRepo(root);
  await assert.rejects(loadConsumer(root), /No timds\.consumer\.json found .*`timds consumer init`/);
  await write(root, CONSUMER_MANIFEST_FILE, "{ not json");
  await assert.rejects(loadConsumer(root), /not valid JSON/);
  await write(root, CONSUMER_MANIFEST_FILE, baseManifest());
  const consumer = await loadConsumer(root);
  assert.equal(consumer.designSystem.commit, null);
  assert.equal(consumer.designSystem.present, false);
});

test("resolveConsumerApp returns the only app, a named app, or lists the choices", async (t) => {
  const { product } = await consumerFixture(t);
  const consumer = await loadConsumer(product);
  const only = resolveConsumerApp(consumer);
  assert.equal(only.name, "web");
  assert.equal(only.cwd, path.join(product, "web"));
  assert.equal(only.cwdRelative, "web");
  assert.throws(() => resolveConsumerApp(consumer, "admin"), /Unknown app "admin" .* available apps: web/);
  const many = { ...consumer, apps: { web: consumer.apps.web, admin: { ...consumer.apps.web, cwd: "admin" } } };
  assert.equal(resolveConsumerApp(many, "admin").cwd, path.join(product, "admin"));
  assert.throws(() => resolveConsumerApp(many), /declares 2 apps .* --app \(web, admin\)/);
});

test("checkConsumer passes on an in-scope change", async (t) => {
  const { product } = await consumerFixture(t);
  git(product, "switch", "-q", "-c", "design/spacing");
  await write(product, "web/src/styles/site.css", "body{margin:0}\n");
  git(product, "commit", "-q", "-am", "Spacing");
  await write(product, "web/src/components/Hero.astro", "<section />\n");
  await write(product, ".claude/launch.json", { version: "0.0.1", configurations: [] });
  const result = await checkConsumer(product, { base: "main" });
  assert.equal(result.status, "passed", result.errors.join("\n"));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.apps, [{ name: "web", cwd: "web", cwdExists: true, mode: "static", designs: 0 }]);
  assert.deepEqual(result.changes.map((change) => change.path), [".claude/launch.json", "web/src/components/Hero.astro", "web/src/styles/site.css"]);
  assert.deepEqual(result.previewApps, ["web"]);
  assert.equal((await checkConsumer(product)).previewApps, null);
});

test("required tokens read a submodule working copy and exclude ignored stylesheets", async (t) => {
  const { product } = await consumerFixture(t);
  const ds = path.join(product, "design-system");
  await write(ds, ".gitignore", "ignored.css\n");
  await write(ds, "ignored.css", ":root { --missing-ring: gold; }");
  await write(ds, "src/brand.css", ":root { --gold: gold; --focus-ring: var(--gold); }");
  assert.equal((await checkConsumer(product, { requireTokens: ["--focus-ring"] })).status, "passed");
  assert.match((await checkConsumer(product, { requireTokens: ["--missing-ring"] })).errors.join("\n"), /Missing required/);
});

test("checkConsumer names only the apps a branch can change the look of, and the CLI hands them to the workflow", async (t) => {
  const { product } = await consumerFixture(t, baseManifest({ web: staticApp(), admin: staticApp({ cwd: "admin" }) }));
  await write(product, "admin/src/styles/site.css", "body{}\n");
  git(product, "add", ".");
  git(product, "commit", "-q", "-m", "Admin app");
  git(product, "switch", "-q", "-c", "fix/api");
  // Developer work beside the apps, inside one app but off its surface, and in a protected path.
  await write(product, "services/worker.ts", "export {};\n");
  await write(product, "web/src/lib/api.ts", "export const x = 2;\n");
  await write(product, "web/src/components/server/db.ts", "export const y = 1;\n");
  const developer = await checkConsumer(product, { base: "main" });
  assert.equal(developer.status, "failed");
  assert.deepEqual(developer.previewApps, []);

  const outputFile = path.join(await temporaryDirectory(t), "github-output");
  const lines = [];
  await assert.rejects(runConsumerCli(["check", "--root", product, "--base", "main"], { env: { GITHUB_OUTPUT: outputFile }, output: (line) => lines.push(line) }), /consumer check failed/);
  assert.equal(await fs.readFile(outputFile, "utf8"), "preview-apps=[]\n");
  assert.match(lines.join("\n"), /Preview: no app's design surface, Design System pin, or manifest changed/);

  await write(product, "admin/src/styles/site.css", "body{margin:0}\n");
  assert.deepEqual((await checkConsumer(product, { base: "main" })).previewApps, ["admin"]);
  await runConsumerCli(["check", "--root", product, "--base", "main", "--json"], { env: { GITHUB_OUTPUT: outputFile }, output: () => {} }).catch(() => {});
  assert.equal(await fs.readFile(outputFile, "utf8"), 'preview-apps=[]\npreview-apps=["admin"]\n');
  // Without --base there is no diff to judge, so nothing is written.
  await runConsumerCli(["check", "--root", product], { env: { GITHUB_OUTPUT: outputFile }, output: () => {} });
  assert.equal((await fs.readFile(outputFile, "utf8")).split("\n").length, 3);

  // The manifest declares the routes and commands a preview runs, so changing it previews every app.
  git(product, "checkout", "-q", "--", "admin/src/styles/site.css");
  await write(product, CONSUMER_MANIFEST_FILE, baseManifest({ web: staticApp({ protected: [] }), admin: staticApp({ cwd: "admin" }) }));
  assert.deepEqual((await checkConsumer(product, { base: "main" })).previewApps, ["web", "admin"]);
});

test("checkConsumer allows an adoption-shaped diff at the root but not nested package files", async (t) => {
  const { product } = await consumerFixture(t);
  git(product, "switch", "-q", "-c", "chore/adopt-timds");
  await write(product, "package.json", { private: true, devDependencies: { "@dtconcepts/timds": "~0.1.0" } });
  await write(product, "package-lock.json", { lockfileVersion: 3 });
  await write(product, ".gitignore", ".timds/preview/\n");
  await write(product, ".timds/installation.json", { version: 1 });
  await write(product, ".agents/skills/timds-consume-design-system/SKILL.md", "# Skill\n");
  // An upgrade refreshes the developer's update skill too; it is managed, not product source.
  await write(product, ".agents/skills/timds-update-design-system/SKILL.md", "# Update skill\n");
  await write(product, ".github/workflows/timds-consumer-preview.yml", "name: preview\n");
  await write(product, ".github/workflows/timds-designer-change.yml", "name: designer change\n");
  await write(product, ".mcp.json", { mcpServers: {} });
  git(product, "add", ".");
  git(product, "commit", "-q", "-m", "Adopt TimDS");
  await write(product, "pnpm-lock.yaml", "lockfileVersion: 9\n");
  const adopted = await checkConsumer(product, { base: "main" });
  assert.equal(adopted.status, "passed", adopted.errors.join("\n"));
  assert.ok(adopted.changes.every((change) => change.status === "allowed"));

  await write(product, "web/package.json", { name: "web", version: "2.0.0" });
  await write(product, "web/package-lock.json", { lockfileVersion: 3 });
  const nested = await checkConsumer(product, { base: "main" });
  assert.equal(nested.status, "failed");
  assert.match(nested.errors.join("\n"), /- web\/package-lock\.json[\s\S]*- web\/package\.json|- web\/package\.json/);
  assert.doesNotMatch(nested.errors.join("\n"), /- package\.json|- \.gitignore/);
});

test("checkConsumer fails on out-of-scope and protected changes and lists the paths", async (t) => {
  const { product } = await consumerFixture(t);
  git(product, "switch", "-q", "-c", "design/oops");
  await write(product, "web/src/lib/api.ts", "export const x = 1;\n");
  git(product, "commit", "-q", "-am", "Out of scope");
  await write(product, "web/src/components/server/db.ts", "export const y = 1;\n");
  await write(product, "notes.txt", "hi\n");
  const result = await checkConsumer(product, { base: "main" });
  assert.equal(result.status, "failed");
  const outside = result.errors.find((error) => error.startsWith("Changes outside the design surface"));
  assert.ok(outside, result.errors.join("\n"));
  assert.match(outside, /- notes\.txt/);
  assert.match(outside, /- web\/src\/lib\/api\.ts/);
  const guarded = result.errors.find((error) => error.startsWith("Changes to protected paths"));
  assert.match(guarded, /- web\/src\/components\/server\/db\.ts \(protected in app "web"\)/);

  const lines = [];
  await assert.rejects(runConsumerCli(["check", "--root", product, "--base", "main"], { env: {}, output: (line) => lines.push(line) }), /consumer check failed with 2 errors/);
  assert.match(lines.join("\n"), /Error: Changes outside the design surface[\s\S]*TimDS consumer check failed\./);
});

test("checkConsumer lists a file moved out of a protected area at its old path, and odd file names unquoted", async (t) => {
  const { product } = await consumerFixture(t);
  git(product, "switch", "-q", "-c", "design/move");
  git(product, "mv", "web/src/lib/api.ts", "web/src/styles/api.ts");
  await write(product, "web/src/styles/café.css", "a{}\n");
  git(product, "add", ".");
  git(product, "commit", "-q", "-m", "Move");
  const result = await checkConsumer(product, { base: "main" });
  assert.equal(result.status, "failed");
  assert.match(result.errors.join("\n"), /- web\/src\/lib\/api\.ts/);
  assert.deepEqual(result.changes.find((change) => change.path === "web/src/styles/café.css"), { path: "web/src/styles/café.css", status: "allowed", app: "web" });
});

test("checkConsumer judges the scope against the base manifest, so a branch cannot widen its own surface", async (t) => {
  const { product } = await consumerFixture(t);
  git(product, "switch", "-q", "-c", "design/widen");
  await write(product, CONSUMER_MANIFEST_FILE, baseManifest({ web: staticApp({ designSurface: ["**"], protected: [] }) }));
  await write(product, "web/src/lib/api.ts", "export const widened = 1;\n");
  git(product, "commit", "-q", "-am", "Widen");
  const result = await checkConsumer(product, { base: "main" });
  assert.equal(result.status, "failed");
  assert.match(result.errors.join("\n"), /outside the design surface[\s\S]*- web\/src\/lib\/api\.ts/);
  assert.match(result.warnings.join("\n"), /timds\.consumer\.json changed on this branch/);
  assert.match(result.warnings.join("\n"), /Developer-owned files changed[\s\S]*- timds\.consumer\.json/);
});

test("checkConsumer passes a branch that adds the submodule, then refuses a moved pin", async (t) => {
  const root = await temporaryDirectory(t);
  const dsRepo = path.join(root, "ds-origin");
  const product = path.join(root, "product");
  await fs.mkdir(dsRepo);
  await fs.mkdir(product);
  initRepo(dsRepo);
  await write(dsRepo, "timds.json", { schemaVersion: 2, systemId: "acme/core", name: "Acme" });
  await write(dsRepo, ".gitignore", "dist/\n");
  git(dsRepo, "add", ".");
  git(dsRepo, "commit", "-q", "-m", "Design system");
  initRepo(product);
  await write(product, "web/src/styles/site.css", "body{}\n");
  git(product, "add", ".");
  git(product, "commit", "-q", "-m", "Product");

  git(product, "switch", "-q", "-c", "chore/adopt-timds");
  git(product, "submodule", "add", "-q", dsRepo, "design-system");
  await write(product, CONSUMER_MANIFEST_FILE, baseManifest());
  git(product, "add", ".");
  git(product, "commit", "-q", "-m", "Adopt TimDS");
  const adopted = await checkConsumer(product, { base: "main" });
  assert.equal(adopted.status, "passed", adopted.errors.join("\n"));
  assert.deepEqual(adopted.changes.map((change) => change.path), [".gitmodules", "design-system", CONSUMER_MANIFEST_FILE]);
  assert.deepEqual(adopted.previewApps, ["web"]);

  // Build output and a drifted checkout inside the submodule are not changes to the product.
  await write(product, "design-system/dist/index.json", {});
  await write(product, "design-system/notes.txt", "scratch\n");
  git(product, "switch", "-q", "-c", "design/pin");
  const untouched = await checkConsumer(product, { base: "chore/adopt-timds" });
  assert.equal(untouched.status, "passed", untouched.errors.join("\n"));
  assert.deepEqual(untouched.previewApps, []);
  await fs.rm(path.join(product, "design-system/notes.txt"));

  await write(dsRepo, "timds.json", { schemaVersion: 2, systemId: "acme/core", name: "Acme 2" });
  git(dsRepo, "commit", "-q", "-am", "Bump");
  git(path.join(product, "design-system"), "pull", "-q", "origin", "HEAD");
  const drifted = await checkConsumer(product, { base: "chore/adopt-timds" });
  assert.equal(drifted.status, "passed", drifted.errors.join("\n"));
  assert.match(drifted.warnings.join("\n"), /design-system is checked out at/);
  git(product, "commit", "-q", "-am", "Move the pin");
  const moved = await checkConsumer(product, { base: "chore/adopt-timds" });
  assert.equal(moved.status, "failed");
  assert.match(moved.errors.join("\n"), /The Design System pin at design-system changed/);
  // A new Design System release can change every app's look.
  assert.deepEqual(moved.previewApps, ["web"]);
});

test("timds consumer check refuses an unknown option or an empty --base instead of skipping the scope check", async (t) => {
  const { product } = await consumerFixture(t);
  await assert.rejects(runConsumerCli(["check", "--root", product, "--bse", "main"], { output: () => {} }), /Unknown option --bse/);
  await assert.rejects(runConsumerCli(["check", "--root", product, "--base="], { output: () => {} }), /--base requires a value/);
  await assert.rejects(runConsumerCli(["check", "--root", product, "--base", ""], { output: () => {} }), /--base requires a value/);
});

test("checkConsumer reports a bad base ref, a missing cwd, an unpinned or drifted submodule", async (t) => {
  const { product, dsRepo } = await consumerFixture(t, baseManifest({ web: staticApp(), admin: staticApp({ cwd: "admin" }) }));
  await assert.rejects(checkConsumer(product, { base: "no-such-ref" }), /Could not diff against no-such-ref/);
  const result = await checkConsumer(product);
  assert.equal(result.status, "failed");
  assert.match(result.errors.join("\n"), /App "admin": cwd admin does not exist/);
  const webOnly = await checkConsumer(product, { app: "web" });
  assert.equal(webOnly.status, "passed", webOnly.errors.join("\n"));

  await write(dsRepo, "timds.json", { schemaVersion: 2, systemId: "acme/core", name: "Acme 2" });
  git(dsRepo, "commit", "-q", "-am", "Bump");
  git(path.join(product, "design-system"), "pull", "-q", "origin", "HEAD");
  const drifted = await checkConsumer(product, { app: "web" });
  assert.equal(drifted.status, "passed");
  assert.match(drifted.warnings.join("\n"), /design-system is checked out at [0-9a-f]{12} but the repository pins [0-9a-f]{12}/);

  const bare = await temporaryDirectory(t);
  initRepo(bare);
  await write(bare, CONSUMER_MANIFEST_FILE, baseManifest());
  await write(bare, "web/package.json", {});
  const unpinned = await checkConsumer(bare);
  assert.equal(unpinned.status, "failed");
  assert.match(unpinned.errors.join("\n"), /design-system is not pinned as a git submodule/);
  assert.match(unpinned.errors.join("\n"), /git submodule update --init design-system/);
});

test("timds consumer check runs through runCli", async (t) => {
  const { product } = await consumerFixture(t);
  const lines = [];
  const { runWithOutputSink } = await import("./core.mjs");
  const result = await runWithOutputSink((line) => lines.push(line), () => runCli(["consumer", "check", "--root", product, "--json"]));
  assert.equal(result.status, "passed");
  assert.equal(JSON.parse(lines.join("\n")).status, "passed");
  await assert.rejects(runCli(["consumer", "bogus"]), /Unknown consumer command bogus/);
});

test("checkConsumer fails on a root file git ignores and warns on installed files nobody committed", async (t) => {
  const { product } = await consumerFixture(t);
  await write(product, ".gitignore", "node_modules/\n/package.json\n");
  await write(product, "package.json", { name: "product", private: true });
  await write(product, ".timds/installation.json", { consumer: { managedFiles: { ".github/workflows/timds-consumer-preview.yml": "x", "../escape.yml": "x" }, mcpServers: { "timds-design-system-read": "x" } } });
  await write(product, ".github/workflows/timds-consumer-preview.yml", "name: preview\n");
  await write(product, ".mcp.json", { mcpServers: {} });
  git(product, "add", ".gitignore", ".timds");
  git(product, "commit", "-q", "-m", "Ignore the root package");

  const ignored = await checkConsumer(product);
  assert.equal(ignored.status, "failed");
  assert.deepEqual(ignored.errors, ["package.json is ignored by git (.gitignore:2 /package.json), so it is never committed and a clone will not have it. Edit .gitignore so the path is no longer excluded, then git add package.json."]);
  assert.match(ignored.warnings.join("\n"), /Not tracked by git yet[^]*- \.github\/workflows\/timds-consumer-preview\.yml\n- \.mcp\.json/);
  assert.doesNotMatch(ignored.warnings.join("\n"), /package\.json|escape/);

  // Tracked despite the pattern: git keeps it, so nothing is lost.
  git(product, "add", "-f", "package.json", ".github", ".mcp.json");
  git(product, "commit", "-q", "-m", "Track everything");
  const tracked = await checkConsumer(product);
  assert.equal(tracked.status, "passed", tracked.errors.join("\n"));
  assert.doesNotMatch(tracked.warnings.join("\n"), /Not tracked/);
});

test("every consumer skill consumer init renders is always allowed in a consumer check", () => {
  for (const name of CONSUMER_SKILL_NAMES) assert.ok(CONSUMER_ALWAYS_ALLOWED.includes(`.agents/skills/${name}/**`), name);
  assert.deepEqual(CONSUMER_SKILL_NAMES, ["timds-consume-design-system", "timds-update-design-system"]);
});

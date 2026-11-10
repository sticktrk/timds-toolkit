import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHash } from "node:crypto";

import { checkConsumer, classifyConsumerPath, runConsumerCli, validateConsumerManifest } from "./consumer.mjs";
import { initializeConsumer } from "./consumer-init.mjs";
import {
  EMDASH_GENERATOR,
  EMDASH_RECORD_PATH,
  EMDASH_TEMPLATES_ROOT,
  scaffoldExistingEmdashSite,
  validateEmdashTemplateSet,
  compileTokenCss,
  emdashConsumerManifest,
  inspectDesignSystem,
  nameCloudflareResources,
  patchBaseLayout,
  renderThemeCss,
  runConsumerScaffold,
  scaffoldEmdashSite,
} from "./consumer-scaffold.mjs";
import { initializeRepository, runCli, runWithOutputSink } from "./core.mjs";

const toolkitPackage = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
const releaseLine = toolkitPackage.version.replace(/^(\d+\.\d+)\.\d+.*$/, "$1.x");

// Exercise Git's file transport, not its local hardlink/copy optimization.
// Each clone gets its own object store, independent of source fixture cleanup.
// Ephemeral repositories should not launch background maintenance either.
process.env.GIT_CONFIG_COUNT = "4";
process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow";
process.env.GIT_CONFIG_VALUE_0 = "always";
process.env.GIT_CONFIG_KEY_1 = "url.file:///.insteadOf";
process.env.GIT_CONFIG_VALUE_1 = "/";
process.env.GIT_CONFIG_KEY_2 = "maintenance.auto";
process.env.GIT_CONFIG_VALUE_2 = "false";
process.env.GIT_CONFIG_KEY_3 = "gc.auto";
process.env.GIT_CONFIG_VALUE_3 = "0";

const quiet = () => {};

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "timds-consumer-scaffold-"));
  t.after(() => fs.rm(directory, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 }));
  return fs.realpath(directory);
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function write(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`, "utf8");
}

async function commitRepo(directory) {
  git(directory, "add", "--all");
  git(directory, "-c", "user.email=timds-test@example.com", "-c", "user.name=TimDS Test", "commit", "-m", "Initial");
}

/** A Design System exactly as `timds init --standalone` writes it. */
async function starterDesignSystem(root) {
  const directory = path.join(root, "acme-design-system");
  await fs.mkdir(directory, { recursive: true });
  git(directory, "init", "-b", "main");
  await initializeRepository(directory, { standalone: true, name: "Acme", systemId: "acme/core" });
  await commitRepo(directory);
  return directory;
}

/** A Design System on its own framework: tokens live in authored stylesheets. */
async function frameworkDesignSystem(root, { manifest = {}, files = {} } = {}) {
  const directory = path.join(root, "acme-design-system");
  await fs.mkdir(directory, { recursive: true });
  git(directory, "init", "-b", "main");
  await write(path.join(directory, "timds.json"), {
    schemaVersion: 2,
    systemId: "acme/core",
    name: "Acme Design System",
    version: "1.0.0",
    workspace: { build: ["npm", "run", "build"] },
    ...manifest,
  });
  for (const [file, content] of Object.entries(files)) await write(path.join(directory, file), content);
  await commitRepo(directory);
  return directory;
}

const BASE_LAYOUT = `---
import { EmDashHead } from "emdash/ui";

const { title } = Astro.props;
---

<!doctype html>
<html lang="en">
\t<head>
\t\t<title>{title}</title>
\t\t<EmDashHead />
\t</head>
\t<body>
\t\t<main><slot /></main>
\t</body>
</html>
`;

const WRANGLER_CONFIG = `{
\t"$schema": "node_modules/wrangler/config-schema.json",
\t"name": "my-emdash-site",
\t"main": "./src/worker.ts",
\t"d1_databases": [
\t\t{
\t\t\t"binding": "DB",
\t\t\t"database_name": "my-emdash-site",
\t\t},
\t],
\t"r2_buckets": [
\t\t{
\t\t\t"binding": "MEDIA",
\t\t\t"bucket_name": "my-emdash-media",
\t\t},
\t],
\t// General maintenance cron trigger
\t"triggers": { "crons": ["* * * * *"] },
}
`;

/** Stands in for the EmDash generator: the starter template's shape, no network. */
function fakeGenerator(calls = [], overrides = {}) {
  return async (directory, { name, platform }) => {
    calls.push(`${platform}:${name}`);
    const site = path.join(directory, name);
    const files = {
      ...(platform === "cloudflare" ? { "wrangler.jsonc": WRANGLER_CONFIG, "src/worker.ts": "export default {};\n" } : {}),
      "package.json": {
        name,
        private: true,
        type: "module",
        emdash: { label: "Starter", seed: "seed/seed.json" },
        scripts: { dev: "astro dev", build: "astro build" },
        dependencies: { astro: "^7.3.2", emdash: "^1.0.1" },
      },
      ".gitignore": "node_modules\ndist\ndata.db\n.env\n",
      ".env": "EMDASH_ENCRYPTION_KEY=fixture\n",
      ".mcp.json": { mcpServers: { "emdash-docs": { type: "http", url: "https://docs.emdashcms.com/mcp" } } },
      "AGENTS.md": "This is an EmDash site.\n\n## Visual character\n\nNone imposed.\n",
      "astro.config.mjs": "export default {};\n",
      "seed/seed.json": {},
      "src/layouts/Base.astro": BASE_LAYOUT,
      "src/pages/index.astro": "---\n---\n<h1>Home</h1>\n",
      ...overrides,
    };
    for (const [file, content] of Object.entries(files)) {
      if (content !== null) await write(path.join(site, file), content);
    }
    // The real template links its agent skills into .claude/ by relative path.
    await write(path.join(site, ".agents/skills/emdash-cli/SKILL.md"), "EmDash CLI\n");
    await fs.mkdir(path.join(site, ".claude"), { recursive: true });
    await fs.symlink("../.agents/skills", path.join(site, ".claude/skills"));
    return site;
  };
}

test("scaffolds an EmDash site that reads a starter Design System from the pin", async (t) => {
  const root = await temporaryDirectory(t);
  const designSystem = await starterDesignSystem(root);
  const site = path.join(root, "acme-site");
  const calls = [];
  const lines = [];

  const result = await scaffoldEmdashSite(site, { designSystem, skipInstall: true, createSite: fakeGenerator(calls), output: (line) => lines.push(line) });

  assert.deepEqual(calls, ["cloudflare:acme-site"]);
  assert.equal(result.platform, "cloudflare");
  assert.deepEqual(result.cloudflare, { name: "acme-site", databaseName: "acme-site", bucketName: "acme-site-media" });
  assert.equal(result.systemId, "acme/core");
  assert.equal(result.appName, "acme-site");
  assert.equal(result.tokens, true);
  assert.deepEqual(result.stylesheets, ["src/styles/system.css"]);
  assert.deepEqual(result.missingRoles, []);

  // A new repository with the Design System staged as its submodule, nothing committed.
  assert.match(git(site, "ls-files", "--stage", "--", "design-system"), /^160000 [0-9a-f]{40} 0\tdesign-system$/m);
  assert.throws(() => git(site, "rev-parse", "--verify", "HEAD"));
  assert.equal(JSON.parse(await fs.readFile(path.join(site, "design-system", "timds.json"), "utf8")).systemId, "acme/core");

  // The theme imports the system from the pin and names the tokens that fill the roles.
  const theme = await fs.readFile(path.join(site, "src/styles/theme.css"), "utf8");
  assert.match(theme, /^@import "\.\.\/\.\.\/design-system\/src\/styles\/system\.css";$/m);
  assert.match(theme, /background: var\(--color-canvas\);/);
  assert.match(theme, /color: var\(--color-accent\);/);
  assert.match(theme, /font-family: var\(--font-serif\);/);
  assert.doesNotMatch(theme, /#[0-9a-f]{3,8}\b/i, "the theme never restates a token value");

  const layout = await fs.readFile(path.join(site, "src/layouts/Base.astro"), "utf8");
  assert.ok(layout.startsWith(`---\nimport "../styles/theme.css";\nimport { designSystemTokenCss } from "../utils/design-system";\nimport { EmDashHead } from "emdash/ui";\n`));
  assert.match(layout, /\t\t<EmDashHead \/>\n\t\t<style is:inline set:html=\{designSystemTokenCss\}><\/style>\n\t<\/head>/);
  assert.match(await fs.readFile(path.join(site, "src/utils/design-system.ts"), "utf8"), /import tokens from "\.\.\/\.\.\/design-system\/tokens\.json";/);

  // One root app, previewed from a seeded local database, theme-only surface.
  const manifest = validateConsumerManifest(JSON.parse(await fs.readFile(path.join(site, "timds.consumer.json"), "utf8")));
  assert.deepEqual(manifest.designSystem, { path: "design-system", systemId: "acme/core" });
  const app = manifest.apps["acme-site"];
  assert.equal(app.cwd, ".");
  assert.deepEqual(app.install, ["npm", "ci", "--no-audit", "--no-fund"]);
  assert.deepEqual(app.preview.serve, ["npm", "run", "dev", "--", "--port", "4380", "--host", "127.0.0.1", "--ignore-lock"]);
  assert.equal(app.preview.port, 4380);
  // Waiting on EmDash's development seed route is what loads the preview's content.
  assert.equal(app.preview.ready, "/_emdash/api/setup/dev-bypass?redirect=/");
  assert.deepEqual(app.preview.discover.exclude, ["/_emdash/**"]);
  assert.deepEqual(app.designSurface, ["src/layouts/**", "src/components/**", "src/styles/**", "src/pages/**", "public/**"]);

  const packageJson = JSON.parse(await fs.readFile(path.join(site, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(packageJson.scripts), ["dev", "build", "timds"]);
  assert.equal(packageJson.scripts.timds, "timds");
  assert.equal(packageJson.devDependencies["@dtconcepts/timds"], releaseLine);

  // The generator's files arrive whole; the docs say which change goes where.
  assert.equal(await fs.readFile(path.join(site, ".env"), "utf8"), "EMDASH_ENCRYPTION_KEY=fixture\n");
  assert.equal(await fs.readlink(path.join(site, ".claude/skills")), "../.agents/skills");
  assert.equal(await fs.readFile(path.join(site, ".claude/skills/emdash-cli/SKILL.md"), "utf8"), "EmDash CLI\n");
  const guide = await fs.readFile(path.join(site, "DESIGN_SYSTEM.md"), "utf8");
  assert.match(guide, /`acme\/core` \(Acme\)/);
  assert.match(guide, /`src\/utils\/design-system\.ts` compiles the pinned `design-system\/tokens\.json`/);
  assert.match(guide, /imports `design-system\/src\/styles\/system\.css` from the pin/);
  assert.match(guide, /runs on Cloudflare Workers as `acme-site`, with the D1 database `acme-site` and the R2 bucket `acme-site-media`/);
  assert.match(guide, /Open `\/_emdash\/api\/setup\/dev-bypass\?redirect=\/_emdash\/admin` once/);
  assert.doesNotMatch(guide, /__[A-Z_]+__/);

  // The Worker, database, and bucket carry the site's name, not the template's.
  const wrangler = await fs.readFile(path.join(site, "wrangler.jsonc"), "utf8");
  assert.match(wrangler, /^\t"name": "acme-site",$/m);
  assert.match(wrangler, /^\t\t\t"database_name": "acme-site",$/m);
  assert.match(wrangler, /^\t\t\t"bucket_name": "acme-site-media",$/m);
  assert.match(wrangler, /\/\/ General maintenance cron trigger/);
  assert.doesNotMatch(wrangler, /my-emdash/);
  assert.ok(result.written.includes("wrangler.jsonc"));

  // The deploy is the site's own workflow: by hand first, then on push by opt-in.
  const deploy = await fs.readFile(path.join(site, ".github/workflows/deploy-cloudflare.yml"), "utf8");
  assert.equal(deploy, await fs.readFile(new URL("../templates/emdash/deploy-cloudflare.yml", import.meta.url), "utf8"));
  assert.match(deploy, /^    if: github\.event_name == 'workflow_dispatch' \|\| vars\.CLOUDFLARE_DEPLOY_ON_PUSH == 'true'$/m);
  assert.match(deploy, /npx wrangler deploy --secrets-file "\$secrets_file"/);
  assert.doesNotMatch(deploy, /__[A-Z_]+__/);
  const installation = JSON.parse(await fs.readFile(path.join(site, ".timds/installation.json"), "utf8"));
  assert.ok(installation.consumer.managedFiles[".github/workflows/timds-consumer-preview.yml"]);
  assert.equal(installation.consumer.managedFiles[".github/workflows/deploy-cloudflare.yml"], undefined, "upgrade never manages the deploy workflow");
  assert.match(guide, /`\.github\/workflows\/deploy-cloudflare\.yml` builds and deploys it with Wrangler/);
  assert.match(guide, /Automatic previews are off by default[\s\S]*TIMDS_PREVIEWS_ENABLED=true/);
  assert.ok(result.todos.some((item) => item.startsWith("To deploy, add the CLOUDFLARE_API_TOKEN")));
  assert.ok(result.todos.some((item) => item.includes("whoever opens it first becomes the administrator")));
  const agents = await fs.readFile(path.join(site, "AGENTS.md"), "utf8");
  assert.ok(agents.startsWith("This is an EmDash site.\n\n## Visual character\n\nNone imposed.\n\n## Design System\n"));
  assert.match(agents, /pinned at\n`design-system\/`/);

  // Adopted exactly as `timds consumer init` adopts a product.
  const mcp = JSON.parse(await fs.readFile(path.join(site, ".mcp.json"), "utf8"));
  assert.deepEqual(Object.keys(mcp.mcpServers), ["emdash-docs", "timds-design-system-read"]);
  for (const file of [".agents/skills/timds-consume-design-system/SKILL.md", ".github/workflows/timds-consumer-preview.yml", ".github/workflows/timds-designer-change.yml", ".claude/launch.json", ".timds/installation.json"]) {
    assert.ok(existsSync(path.join(site, file)), file);
    assert.ok(result.written.includes(file), file);
  }
  const launch = JSON.parse(await fs.readFile(path.join(site, ".claude/launch.json"), "utf8"));
  assert.deepEqual(launch.configurations.map((entry) => [entry.name, entry.port]), [["acme-site", 4380]]);
  assert.match(await fs.readFile(path.join(site, ".gitignore"), "utf8"), /^\.timds\/preview\/$/m);
  assert.equal((await checkConsumer(site)).status, "passed");

  assert.ok(result.todos.some((item) => item.startsWith("Run npm install and commit package-lock.json")));
  assert.ok(result.todos.some((item) => item.includes("<site origin>/_emdash/api/mcp")));
  assert.ok(result.todos.some((item) => item.includes("TIMDS_ACCESS_TOKEN repository secret")));
  assert.ok(lines.includes(`Created the EmDash site acme-site at ${site}, consuming acme/core.`));
  assert.ok(!lines.join("\n").includes("EMDASH_ENCRYPTION_KEY=fixture"));
});

test("compiles tokens.json exactly as the starter build writes tokens.css", async (t) => {
  const root = await temporaryDirectory(t);
  const designSystem = await starterDesignSystem(root);
  const tokens = JSON.parse(await fs.readFile(path.join(designSystem, "tokens.json"), "utf8"));
  assert.equal(compileTokenCss(tokens), await fs.readFile(path.join(designSystem, "dist", "tokens.css"), "utf8"));
});

test("adds the EmDash MCP server for --site-url, and refuses a bad one before writing", async (t) => {
  const root = await temporaryDirectory(t);
  const designSystem = await starterDesignSystem(root);
  const site = path.join(root, "site");

  await assert.rejects(scaffoldEmdashSite(site, { designSystem, siteUrl: "ftp://acme.example.com", createSite: fakeGenerator() }), /--site-url must use HTTP or HTTPS/);
  await assert.rejects(scaffoldEmdashSite(site, { designSystem, siteUrl: "not a url", createSite: fakeGenerator() }), /--site-url not a url is not a valid URL/);
  assert.equal(existsSync(site), false);

  const result = await scaffoldEmdashSite(site, { designSystem, siteUrl: "https://acme.example.com/blog", skipInstall: true, createSite: fakeGenerator(), output: quiet });
  const mcp = JSON.parse(await fs.readFile(path.join(site, ".mcp.json"), "utf8"));
  assert.deepEqual(mcp.mcpServers.emdash, { type: "http", url: "https://acme.example.com/_emdash/api/mcp" });
  assert.deepEqual(Object.keys(mcp.mcpServers), ["emdash-docs", "emdash", "timds-design-system-read"]);
  assert.ok(result.todos.some((item) => item.includes('"emdash" MCP server in .mcp.json (https://acme.example.com/_emdash/api/mcp)')));
});

test("imports named stylesheets from a Design System on its own framework", async (t) => {
  const root = await temporaryDirectory(t);
  const designSystem = await frameworkDesignSystem(root, {
    manifest: { brand: { roles: { "color.accent": "--gold-300" } } },
    files: {
      // A root tokens.json is not compiled unless the system runs the starter build.
      "tokens.json": { color: { accent: { value: "#000000" } } },
      "src/styles/ds/brand.css": `@import "./palette.css";\n:root { --color-bg: var(--paper); --ink: #111111; --font-serif: "Canela", serif; }\n`,
      "src/styles/ds/palette.css": ":root { --paper: #faf7f0; --gold-300: #d4b876; }\n",
      "src/styles/ds/marketing.css": ".hero { color: var(--ink); }\n",
    },
  });
  const site = path.join(root, "site");

  const result = await scaffoldEmdashSite(site, {
    designSystem,
    stylesheets: ["src/styles/ds/brand.css", "src/styles/ds/marketing.css"],
    skipInstall: true,
    createSite: fakeGenerator(),
    output: quiet,
  });

  assert.equal(result.tokens, false);
  assert.deepEqual(result.roles, { "color.background": "--color-bg", "color.accent": "--gold-300", "color.text": "--ink", "font.display": "--font-serif" });
  assert.deepEqual(result.missingRoles, ["color.panel", "color.muted", "font.body", "font.ui"]);

  const theme = await fs.readFile(path.join(site, "src/styles/theme.css"), "utf8");
  assert.match(theme, /@import "\.\.\/\.\.\/design-system\/src\/styles\/ds\/brand\.css";\n@import "\.\.\/\.\.\/design-system\/src\/styles\/ds\/marketing\.css";\n/);
  assert.match(theme, /body \{\n  margin: 0;\n  background: var\(--color-bg\);\n  color: var\(--ink\);\n\}/);
  assert.match(theme, /a \{\n  color: var\(--gold-300\);\n\}/);
  // A role nothing fills leaves its declaration out; it is never invented.
  assert.doesNotMatch(theme, /main time/);
  assert.doesNotMatch(theme, /header \{\n  background/);

  const layout = await fs.readFile(path.join(site, "src/layouts/Base.astro"), "utf8");
  assert.ok(layout.startsWith(`---\nimport "../styles/theme.css";\nimport { EmDashHead } from "emdash/ui";\n`));
  assert.doesNotMatch(layout, /designSystemTokenCss/);
  assert.equal(existsSync(path.join(site, "src/utils/design-system.ts")), false);
  assert.doesNotMatch(await fs.readFile(path.join(site, "DESIGN_SYSTEM.md"), "utf8"), /tokens\.json/);
  assert.ok(result.todos.some((item) => item.startsWith("The Design System fills no token for color.panel, color.muted, font.body, font.ui")));
});

test("links public assets from the pin for root-relative stylesheet URLs", async (t) => {
  const root = await temporaryDirectory(t);
  const designSystem = await frameworkDesignSystem(root, {
    files: {
      "src/styles/system.css": `@font-face { font-family: "Example"; src: url("/fonts/brand.woff2"); }\n:root { --font-body: "Example", sans-serif; }\nbody { background-image: url('/images/background.svg'); }\n`,
      "public/fonts/brand.woff2": "first font bytes",
      "public/images/background.svg": "<svg />\n",
      "public/logo.svg": "<svg />\n",
    },
  });
  const site = path.join(root, "site");
  const result = await scaffoldEmdashSite(site, { designSystem, skipInstall: true, createSite: fakeGenerator(), output: quiet });

  for (const entry of ["fonts", "images", "logo.svg"]) {
    const relative = `public/${entry}`;
    assert.equal(await fs.readlink(path.join(site, relative)), `../design-system/public/${entry}`);
    assert.ok(result.written.includes(relative));
    assert.equal(classifyConsumerPath(relative, result.manifest).status, "protected");
    assert.equal(classifyConsumerPath(`${relative}/new-file`, result.manifest).status, "protected");
  }
  assert.equal(classifyConsumerPath("public/site-icon.svg", result.manifest).status, "allowed");
  assert.equal(await fs.readFile(path.join(site, "public/fonts/brand.woff2"), "utf8"), "first font bytes");
  assert.equal(await fs.readFile(path.join(site, "public/images/background.svg"), "utf8"), "<svg />\n");
  git(site, "add", "public");
  assert.equal(git(site, "ls-files", "--stage", "--", "public").split("\n").filter(Boolean).every((line) => line.startsWith("120000 ")), true, "git records links, not copied assets");
  assert.match(await fs.readFile(path.join(site, "DESIGN_SYSTEM.md"), "utf8"), /relative symlinks into `design-system\/public\/`/);

  await write(path.join(designSystem, "public/fonts/brand.woff2"), "updated font bytes");
  await write(path.join(designSystem, "public/fonts/new.woff2"), "new font bytes");
  await commitRepo(designSystem);
  git(path.join(site, "design-system"), "fetch", "origin");
  git(path.join(site, "design-system"), "checkout", git(designSystem, "rev-parse", "HEAD").trim());
  assert.equal(await fs.readFile(path.join(site, "public/fonts/brand.woff2"), "utf8"), "updated font bytes");
  assert.equal(await fs.readFile(path.join(site, "public/fonts/new.woff2"), "utf8"), "new font bytes");
});

test("refuses public asset collisions and rolls back the generated site", async (t) => {
  const root = await temporaryDirectory(t);
  const designSystem = await frameworkDesignSystem(root, {
    files: { "src/styles/system.css": ":root { --ink: #111111; }\n", "public/logo.svg": "system logo\n" },
  });
  const site = path.join(root, "site");
  await assert.rejects(scaffoldEmdashSite(site, {
    designSystem,
    skipInstall: true,
    createSite: fakeGenerator([], { "public/logo.svg": "template logo\n" }),
  }), /design-system\/public\/logo\.svg conflicts with the generated site's public\/logo\.svg/);
  assert.equal(existsSync(site), false);
  assert.equal(await fs.readFile(path.join(designSystem, "public/logo.svg"), "utf8"), "system logo\n");
});

test("validates the portal URL before creating a site or running the generator", async (t) => {
  const root = await temporaryDirectory(t);
  const site = path.join(root, "site");
  const calls = [];
  const options = { designSystem: "git@example.com:example/design-system.git", createSite: fakeGenerator(calls) };
  await assert.rejects(scaffoldEmdashSite(site, { ...options, portalUrl: "not-a-url" }), /--portal-url not-a-url is not a valid URL/);
  await assert.rejects(scaffoldEmdashSite(site, { ...options, portalUrl: "ftp://example.com" }), /--portal-url must use HTTP or HTTPS/);
  assert.equal(existsSync(site), false);
  assert.deepEqual(calls, []);
});

test("rolls back when consumer adoption fails, including an existing empty root", async (t) => {
  const root = await temporaryDirectory(t);
  const designSystem = await starterDesignSystem(root);
  const site = path.join(root, "site");
  const options = { designSystem, skipInstall: true, createSite: fakeGenerator([], { ".mcp.json": { mcpServers: [] } }) };
  await assert.rejects(scaffoldEmdashSite(site, options), /has an mcpServers value that is not an object/);
  assert.equal(existsSync(site), false);

  await fs.mkdir(site);
  await assert.rejects(scaffoldEmdashSite(site, options), /has an mcpServers value that is not an object/);
  assert.deepEqual(await fs.readdir(site), []);

  // The same root is immediately usable once the generator/adoption problem is fixed.
  await scaffoldEmdashSite(site, { designSystem, skipInstall: true, createSite: fakeGenerator() });
  assert.equal((await checkConsumer(site)).status, "passed");
});

test("refuses a root that is not empty or sits inside another repository", async (t) => {
  const root = await temporaryDirectory(t);
  const designSystem = await starterDesignSystem(root);
  const calls = [];
  const createSite = fakeGenerator(calls);

  const occupied = path.join(root, "occupied");
  await write(path.join(occupied, "notes.txt"), "keep me\n");
  await assert.rejects(scaffoldEmdashSite(occupied, { designSystem, createSite }), /is not empty[\s\S]*timds consumer init/);
  assert.equal(await fs.readFile(path.join(occupied, "notes.txt"), "utf8"), "keep me\n");

  await assert.rejects(scaffoldEmdashSite(path.join(designSystem, "site"), { designSystem, createSite }), /is inside the git repository/);
  assert.equal(existsSync(path.join(designSystem, "site")), false);

  await assert.rejects(scaffoldEmdashSite(path.join(root, "site"), { createSite }), /--design-system is required/);
  await assert.rejects(scaffoldEmdashSite("", { designSystem, createSite }), /--root is required/);
  await assert.rejects(scaffoldEmdashSite(path.join(root, "site"), { designSystem, stylesheets: ["../outside.css"], createSite }), /must be a \.css path relative to the Design System root/);
  await assert.rejects(scaffoldEmdashSite(path.join(root, "site"), { designSystem, stylesheets: ["src/styles/system.scss"], createSite }), /must be a \.css path/);
  assert.equal(existsSync(path.join(root, "site")), false);
  assert.deepEqual(calls, []);
});

test("removes what it created when the Design System cannot be consumed", async (t) => {
  const root = await temporaryDirectory(t);
  const calls = [];
  const createSite = fakeGenerator(calls);
  const site = path.join(root, "site");

  const plain = path.join(root, "plain");
  await fs.mkdir(plain, { recursive: true });
  git(plain, "init", "-b", "main");
  await write(path.join(plain, "README.md"), "# Not a Design System\n");
  await commitRepo(plain);
  await assert.rejects(scaffoldEmdashSite(site, { designSystem: plain, createSite }), /not a standalone TimDS Design System/);
  assert.equal(existsSync(site), false);

  await assert.rejects(scaffoldEmdashSite(site, { designSystem: path.join(root, "missing"), createSite }), /git submodule add .* failed/);
  assert.equal(existsSync(site), false);

  const designSystem = await frameworkDesignSystem(root, { files: { "src/styles/ds/brand.css": ":root { --ink: #111111; }\n" } });
  await assert.rejects(scaffoldEmdashSite(site, { designSystem, createSite }), /cannot tell what a product imports[\s\S]*--stylesheet PATH/);
  await assert.rejects(scaffoldEmdashSite(site, { designSystem, stylesheets: ["src/styles/ds/gone.css"], createSite }), /--stylesheet src\/styles\/ds\/gone\.css does not exist in the Design System \(acme\/core\)/);
  assert.equal(existsSync(site), false);
  // The Design System is inspected before the generator runs.
  assert.deepEqual(calls, []);

  // An empty folder that was already there is emptied again, not removed.
  await fs.mkdir(site);
  await assert.rejects(scaffoldEmdashSite(site, { designSystem, createSite }), /cannot tell what a product imports/);
  assert.deepEqual(await fs.readdir(site), []);
});

test("removes what it created when the generator fails or its template has changed", async (t) => {
  const root = await temporaryDirectory(t);
  const designSystem = await starterDesignSystem(root);
  const site = path.join(root, "site");

  await assert.rejects(scaffoldEmdashSite(site, { designSystem, createSite: async () => { throw new Error("registry unreachable"); } }), /registry unreachable/);
  assert.equal(existsSync(site), false);

  await assert.rejects(scaffoldEmdashSite(site, { designSystem, createSite: fakeGenerator([], { "src/layouts/Base.astro": null }) }), /did not produce src\/layouts\/Base\.astro and package\.json/);
  assert.equal(existsSync(site), false);

  await assert.rejects(scaffoldEmdashSite(site, { designSystem, createSite: fakeGenerator([], { "src/layouts/Base.astro": "<html><body><slot /></body></html>\n" }) }), /has no frontmatter or no <\/head>/);
  assert.equal(existsSync(site), false);

  await assert.rejects(scaffoldEmdashSite(site, { designSystem, createSite: fakeGenerator([], { "design-system/README.md": "clash\n" }) }), /produced design-system, which the new repository already has/);
  assert.equal(existsSync(site), false);
});

test("patches a layout in its own indentation and line endings", () => {
  const spaces = "---\nconst a = 1;\n---\n<html>\n  <head>\n    <title>x</title>\n  </head>\n</html>\n";
  assert.equal(
    patchBaseLayout(spaces, { tokens: true }),
    `---\nimport "../styles/theme.css";\nimport { designSystemTokenCss } from "../utils/design-system";\nconst a = 1;\n---\n<html>\n  <head>\n    <title>x</title>\n    <style is:inline set:html={designSystemTokenCss}></style>\n  </head>\n</html>\n`,
  );
  const windows = patchBaseLayout(spaces.replaceAll("\n", "\r\n"), { tokens: false });
  assert.ok(windows.startsWith(`---\r\nimport "../styles/theme.css";\r\nconst a = 1;\r\n`));
  assert.doesNotMatch(windows, /(?<!\r)\n/);
  assert.throws(() => patchBaseLayout("<html><head></head></html>", { tokens: true }), /no frontmatter or no <\/head>/);
});

test("inspects a Design System and renders the theme from its roles alone", async (t) => {
  const root = await temporaryDirectory(t);
  const designSystem = await starterDesignSystem(root);
  const system = await inspectDesignSystem(designSystem);
  assert.equal(system.name, "Acme");
  assert.equal(system.roles["color.panel"], "--color-surface");
  assert.equal(system.roles["font.ui"], "--font-sans");

  assert.doesNotMatch(renderThemeCss({ stylesheets: [], roles: {} }), /var\(--[a-z]/);
  assert.match(renderThemeCss({ stylesheets: [], roles: { "color.text": "--ink" } }), /border-bottom: 1px solid color-mix\(in srgb, var\(--ink\) 14%, transparent\);/);
  assert.equal(emdashConsumerManifest({ appName: "site", systemId: "acme/core" }).apps.site.protected.length, 0);
  // The starter's website design has a home page, so the site's home route is paired with it from the first preview on.
  assert.deepEqual(system.designs, [{ id: "website", routes: ["/", "/404", "/about", "/articles", "/articles/example-article", "/contact", "/privacy", "/terms", "/topics/example-topic"] }]);
  assert.deepEqual(emdashConsumerManifest({ appName: "site", systemId: "acme/core", designs: system.designs }).apps.site.preview.designs, { "/": "website:/" });
  assert.equal(emdashConsumerManifest({ appName: "site", systemId: "acme/core", designs: [{ id: "app", routes: ["/dashboard"] }] }).apps.site.preview.designs, undefined);
});

test("generates the Node.js platform without Cloudflare resources", async (t) => {
  const root = await temporaryDirectory(t);
  const designSystem = await starterDesignSystem(root);
  const site = path.join(root, "node-site");
  const calls = [];

  const result = await scaffoldEmdashSite(site, { designSystem, platform: "node", skipInstall: true, createSite: fakeGenerator(calls), output: quiet });

  assert.deepEqual(calls, ["node:node-site"]);
  assert.equal(result.platform, "node");
  assert.equal(result.cloudflare, undefined);
  assert.equal(existsSync(path.join(site, "wrangler.jsonc")), false);
  assert.equal(existsSync(path.join(site, ".github/workflows/deploy-cloudflare.yml")), false);
  assert.match(await fs.readFile(path.join(site, "DESIGN_SYSTEM.md"), "utf8"), /runs as a Node\.js server with a SQLite database/);
  assert.ok(result.todos.some((item) => item.startsWith("Set EMDASH_ENCRYPTION_KEY wherever the Node.js server is deployed")));
  assert.equal((await checkConsumer(site)).status, "passed");

  await assert.rejects(scaffoldEmdashSite(path.join(root, "other"), { designSystem, platform: "heroku", createSite: fakeGenerator(calls) }), /--platform heroku must be one of cloudflare, node/);
  await assert.rejects(
    scaffoldEmdashSite(path.join(root, "other"), { designSystem, createSite: fakeGenerator([], { "wrangler.jsonc": null }) }),
    /did not produce wrangler\.jsonc for the cloudflare platform/,
  );
  assert.equal(existsSync(path.join(root, "other")), false);
});

test("names the Cloudflare resources after the site and keeps the rest of the config", () => {
  const named = nameCloudflareResources(WRANGLER_CONFIG, "Acme & Sons_Site");
  assert.deepEqual([named.name, named.database_name, named.bucket_name], ["acme-sons-site", "acme-sons-site", "acme-sons-site-media"]);
  assert.equal(named.config, WRANGLER_CONFIG.replaceAll("my-emdash-site", "acme-sons-site").replace("my-emdash-media", "acme-sons-site-media"));
  // A bucket name may be at most 63 characters, suffix included.
  assert.ok(nameCloudflareResources(WRANGLER_CONFIG, "a".repeat(49) + "-" + "b".repeat(30)).bucket_name.length <= 63);
  assert.equal(nameCloudflareResources(WRANGLER_CONFIG, "a".repeat(49) + "-" + "b".repeat(30)).name, "a".repeat(49));
  assert.throws(() => nameCloudflareResources(WRANGLER_CONFIG.replace('"bucket_name"', '"bucket"'), "site"), /has no "bucket_name"/);
});

test("runs through the consumer CLI and explains itself", async (t) => {
  const lines = [];
  assert.equal(await runConsumerScaffold([], { output: (line) => lines.push(line) }), null);
  assert.equal(await runConsumerScaffold(["emdash", "--help"], { output: (line) => lines.push(line) }), null);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /timds consumer scaffold emdash --root PATH --design-system GIT_URL/);
  assert.ok(lines[0].includes(EMDASH_GENERATOR));

  await assert.rejects(runConsumerScaffold(["wordpress", "--root", "x"], { output: quiet }), /Unknown site kind wordpress/);
  await assert.rejects(runConsumerScaffold(["emdash", "--template", "blog"], { output: quiet }), /Unknown option --template/);
  await assert.rejects(runConsumerScaffold(["emdash", "--root", "x", "--design-system", "y", "--platform", "heroku"], { output: quiet }), /--platform heroku must be one of/);
  await assert.rejects(runConsumerScaffold(["emdash", "--root"], { output: quiet }), /--root requires a value/);
  await assert.rejects(runConsumerScaffold(["emdash", "--design-system", "git@example.com:a/b.git"], { output: quiet }), /--root is required/);

  const root = await temporaryDirectory(t);
  await assert.rejects(
    runConsumerCli(["scaffold", "emdash", "--root", path.join(root, "site"), "--design-system", path.join(root, "missing"), "--platform", "node", "--stylesheet=a.css", "--stylesheet", "b.css", "--skip-install"], { output: quiet }),
    /git submodule add .* failed/,
  );
  assert.equal(existsSync(path.join(root, "site")), false);
});

// ---------------------------------------------------------------------------
// --existing: the shared EmDash template set installed into an existing site

// The real template set: the tests read its files and site.json, never a copy of them.
const TEMPLATES = EMDASH_TEMPLATES_ROOT;
const templateSet = async () => JSON.parse(await fs.readFile(path.join(TEMPLATES, "site.json"), "utf8"));

async function walkFiles(directory, prefix = "") {
  const entries = await fs.readdir(path.join(directory, prefix), { withFileTypes: true }).catch((caught) => {
    if (caught?.code === "ENOENT") return [];
    throw caught;
  });
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await walkFiles(directory, relative));
    else files.push(relative);
  }
  return files.sort();
}

/** Every template file for `platform`: `{ path, source }`, the source under the template root. */
async function templateFilesFor(platform) {
  const shared = (await walkFiles(path.join(TEMPLATES, "site"))).map((file) => ({ path: file, source: `site/${file}` }));
  const own = (await walkFiles(path.join(TEMPLATES, `site-${platform}`))).map((file) => ({ path: file, source: `site-${platform}/${file}` }));
  return [...shared, ...own].sort((left, right) => left.path.localeCompare(right.path));
}

/** Every path under `directory` (directories included) with the sha256 of each file's bytes. */
async function treeHash(directory) {
  const result = {};
  const visit = async (relative) => {
    for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.name === ".git") continue;
      if (entry.isDirectory()) {
        result[`${child}/`] = "dir";
        await visit(child);
      } else {
        result[child] = createHash("sha256").update(await fs.readFile(path.join(directory, child))).digest("hex");
      }
    }
  };
  await visit("");
  return result;
}

const EXISTING_PACKAGE = {
  name: "acme-site",
  private: true,
  type: "module",
  scripts: { dev: "astro dev", build: "astro build" },
  dependencies: { astro: "^5.0.0" },
  devDependencies: { prettier: "^3.0.0" },
};

function existingManifest({ cwd = ".", name = "acme-site", preview = {} } = {}) {
  return {
    schemaVersion: 1,
    designSystem: { path: "design-system", systemId: "acme/core", version: "2026.11.01-1" },
    apps: {
      [name]: {
        cwd,
        install: ["npm", "ci"],
        preview: {
          serve: ["npm", "run", "dev", "--", "--port", "4321"],
          port: 4321,
          routes: ["/", "/contact"],
          discover: { from: ["/"], limit: 40 },
          designs: { "/": "website:/" },
          ...preview,
        },
        designSurface: ["src/**"],
      },
    },
  };
}

/** An Astro consumer that already pins a published Design System. */
async function existingSite(root, { cwd = ".", packageJson = EXISTING_PACKAGE, manifest = existingManifest({ cwd }), layout = true, packageIndent = "  " } = {}) {
  const site = path.join(root, "acme-site");
  const app = path.join(site, ...(cwd === "." ? [] : [cwd]));
  await write(path.join(site, "timds.consumer.json"), manifest);
  if (packageJson) await fs.mkdir(app, { recursive: true }).then(() => fs.writeFile(path.join(app, "package.json"), `${JSON.stringify(packageJson, null, packageIndent)}\n`, "utf8"));
  if (layout) await write(path.join(app, "src/layouts/Base.astro"), "---\nconst { title } = Astro.props;\n---\n<html><head><title>{title}</title></head><body><slot /></body></html>\n");
  await write(path.join(app, "src/pages/index.astro"), "---\nimport Base from \"../layouts/Base.astro\";\n---\n<Base title=\"Home\"><h1>Home</h1></Base>\n");
  return site;
}

/** The designs the injected reader reports: every design route site.json pairs except the last, which the system lacks. */
async function systemDesigns() {
  const routes = Object.values((await templateSet()).preview.designs);
  return { reported: [{ id: "website", routes: ["/", "/contact", ...routes.slice(0, -1)] }], missing: routes.slice(-1) };
}

const resolvesTo = (file, specifier) => path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
const importFrom = (file, layout) => {
  const specifier = path.posix.relative(path.posix.dirname(file), layout);
  return specifier.startsWith("../") ? specifier : `./${specifier}`;
};
const fill = (text, { file, layout = "src/layouts/Base.astro", siteUrl = "https://example.com", siteName = "acme-site" }) => text
  .replaceAll("__LAYOUT_IMPORT__", importFrom(file, layout))
  .replaceAll("__SITE_URL__", siteUrl)
  .replaceAll("__SITE_NAME__", siteName);

for (const platform of ["cloudflare", "node"]) {
  test(`--existing installs the template set into an Astro site (${platform})`, async (t) => {
    const root = await temporaryDirectory(t);
    const site = await existingSite(root);
    const set = await templateSet();
    const packageBefore = await fs.readFile(path.join(site, "package.json"), "utf8");
    const { reported } = await systemDesigns();
    const lines = [];

    const result = await scaffoldExistingEmdashSite(site, {
      platform,
      skipInstall: true,
      templatesRoot: TEMPLATES,
      readDesigns: async () => reported,
      output: (line) => lines.push(line),
    });

    // Every template file lands at its path, placeholders filled.
    const files = await templateFilesFor(platform);
    assert.ok(files.length > 0);
    assert.ok(files.some((file) => file.path === "src/live.config.ts"));
    for (const file of files) {
      const installed = await fs.readFile(path.join(site, file.path));
      const source = await fs.readFile(path.join(TEMPLATES, file.source));
      assert.ok(result.written.includes(file.path), file.path);
      if (source.includes(0)) {
        assert.deepEqual(installed, source, file.path);
        continue;
      }
      const text = installed.toString("utf8");
      assert.doesNotMatch(text, /__[A-Z][A-Z0-9_]*__/, file.path);
      const template = source.toString("utf8");
      const expected = fill(template, { file: file.path });
      assert.equal(text, expected, file.path);
      if (template.includes("__LAYOUT_IMPORT__")) {
        assert.equal(resolvesTo(file.path, expected.slice(template.indexOf("__LAYOUT_IMPORT__")).match(/^[^"'`\s]+/)[0]), "src/layouts/Base.astro", file.path);
      }
    }
    // The existing page is untouched.
    assert.match(await fs.readFile(path.join(site, "src/pages/index.astro"), "utf8"), /<h1>Home<\/h1>/);

    // package.json gains exactly the listed dependencies and package keys, nothing else.
    const dependencies = { ...set.dependencies.all, ...set.dependencies[platform] };
    const devDependencies = { ...set.devDependencies.all, ...set.devDependencies[platform] };
    const after = JSON.parse(await fs.readFile(path.join(site, "package.json"), "utf8"));
    for (const [name, version] of Object.entries(dependencies)) {
      if (EXISTING_PACKAGE.dependencies[name] || EXISTING_PACKAGE.devDependencies[name]) continue;
      assert.equal(after.dependencies[name], version, name);
    }
    for (const [name, version] of Object.entries(devDependencies)) {
      if (EXISTING_PACKAGE.dependencies[name] || EXISTING_PACKAGE.devDependencies[name]) continue;
      assert.equal(after.devDependencies[name], version, name);
    }
    assert.deepEqual(result.dependencies.added.map((entry) => entry.name).sort(), [...Object.keys(dependencies), ...Object.keys(devDependencies)].filter((name) => !EXISTING_PACKAGE.dependencies[name] && !EXISTING_PACKAGE.devDependencies[name]).sort());
    assert.equal(after.emdash.seed, set.package.emdash.seed);
    const stripped = structuredClone(after);
    for (const entry of result.dependencies.added) {
      const block = entry.dev ? "devDependencies" : "dependencies";
      delete stripped[block][entry.name];
      if (!EXISTING_PACKAGE[block] && !Object.keys(stripped[block]).length) delete stripped[block];
    }
    for (const key of Object.keys(set.package)) if (!Object.hasOwn(EXISTING_PACKAGE, key)) delete stripped[key];
    assert.equal(`${JSON.stringify(stripped, null, 2)}\n`, packageBefore, "package.json is otherwise byte-identical");

    // The manifest gains the routes, the pairs the system has designs for, the exclusions and the seed route, and still validates.
    const raw = JSON.parse(await fs.readFile(path.join(site, "timds.consumer.json"), "utf8"));
    const manifest = validateConsumerManifest(raw);
    const preview = raw.apps["acme-site"].preview;
    assert.deepEqual(preview.routes, ["/", "/contact", ...set.preview.routes]);
    const pairs = Object.entries(set.preview.designs);
    assert.deepEqual(preview.designs, {
      "/": "website:/",
      ...Object.fromEntries(pairs.slice(0, -1).map(([route, designRoute]) => [route, `website:${designRoute}`])),
    });
    assert.deepEqual(result.preview.unpaired, [pairs.at(-1)[0]]);
    assert.ok(result.todos.includes(`${pairs.at(-1)[0]} has no design yet in the pinned Design System version: move the pin to a release that has it, or author it in the Design System, then pair it in preview.designs`));
    assert.deepEqual(preview.discover.exclude, set.preview.discoverExclude);
    assert.equal(preview.ready, set.preview.ready);
    assert.equal(raw.apps["acme-site"].preview.viewports, undefined, "no defaults are written out");
    assert.deepEqual(result.manifest, manifest);

    // The template version is recorded where upgrade never writes.
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(site, EMDASH_RECORD_PATH), "utf8")), { template: set.version, platform });
    assert.equal(result.template, set.version);

    // What it cannot change safely is printed, with the snippets' text.
    const printed = lines.join("\n");
    for (const entry of set.manual[platform]) {
      assert.ok(printed.includes(`Change ${entry.file} by hand: ${entry.summary}`));
      const snippet = fill(await fs.readFile(path.join(TEMPLATES, entry.snippet), "utf8"), { file: entry.file });
      assert.ok(result.manual.some((manual) => manual.file === entry.file && manual.summary === entry.summary && manual.text === snippet), entry.snippet);
      assert.ok(printed.includes(snippet.replace(/\s+$/, "")), entry.snippet);
    }
    assert.deepEqual(result.gitignore, [...set.gitignore.all, ...set.gitignore[platform]]);
    for (const line of result.gitignore) assert.ok(printed.includes(`  ${line}`));
    assert.ok(result.todos.some((item) => item.startsWith("Run npm install")));
    let usesOrigin = false;
    for (const file of files) usesOrigin ||= (await fs.readFile(path.join(TEMPLATES, file.source), "utf8")).includes("__SITE_URL__");
    assert.equal(result.todos.some((item) => item.includes("use https://example.com as the site's origin")), usesOrigin);
    if (files.some((file) => file.path === "docs/emdash-handover.md")) assert.ok(result.todos.some((item) => item.includes("docs/emdash-handover.md")));
    // No configuration is touched.
    for (const file of [".gitignore", "astro.config.mjs", "wrangler.jsonc", ".env"]) {
      if (!files.some((entry) => entry.path === file)) assert.equal(existsSync(path.join(site, file)), false, file);
    }
  });
}

test("--existing installs relative to the app's cwd and a --layout elsewhere, with --site-url", async (t) => {
  const root = await temporaryDirectory(t);
  const site = await existingSite(root, { cwd: "web", layout: false, packageIndent: "\t" });
  await write(path.join(site, "web/src/components/Shell.astro"), "---\n---\n<slot />\n");
  const packageBefore = await fs.readFile(path.join(site, "web/package.json"), "utf8");

  const result = await scaffoldExistingEmdashSite(site, {
    platform: "node",
    layout: "src/components/Shell.astro",
    siteUrl: "https://www.acme.example/blog?x=1",
    skipInstall: true,
    templatesRoot: TEMPLATES,
    readDesigns: async () => null,
    output: quiet,
  });

  assert.equal(result.appCwd, "web");
  assert.equal(result.layout, "web/src/components/Shell.astro");
  assert.equal(result.siteUrl, "https://www.acme.example");
  for (const file of await templateFilesFor("node")) {
    assert.ok(existsSync(path.join(site, "web", file.path)), file.path);
    const source = await fs.readFile(path.join(TEMPLATES, file.source), "utf8");
    if (!source.includes("__LAYOUT_IMPORT__")) continue;
    const installed = await fs.readFile(path.join(site, "web", file.path), "utf8");
    const specifier = installed.slice(source.indexOf("__LAYOUT_IMPORT__")).match(/^[^"'`\s]+/)[0];
    assert.match(specifier, /^\.\.?\//);
    assert.equal(resolvesTo(file.path, specifier), "src/components/Shell.astro", file.path);
  }
  for (const file of await templateFilesFor("node")) {
    const source = await fs.readFile(path.join(TEMPLATES, file.source), "utf8");
    if (source.includes("__SITE_URL__")) assert.ok((await fs.readFile(path.join(site, "web", file.path), "utf8")).includes("https://www.acme.example"), file.path);
  }
  assert.ok(!result.todos.some((item) => item.includes("https://example.com")));
  // The tab indentation of package.json is kept.
  const packageAfter = await fs.readFile(path.join(site, "web/package.json"), "utf8");
  assert.ok(packageBefore.startsWith("{\n\t\"name\""));
  assert.ok(packageAfter.startsWith("{\n\t\"name\": \"acme-site\",\n\t\"private\": true,"));
  assert.ok(packageAfter.endsWith("}\n"));
  // The record sits at the repository root, beside installation.json.
  assert.ok(existsSync(path.join(site, EMDASH_RECORD_PATH)));
  // Unreadable designs pair nothing and say so.
  assert.deepEqual(result.preview.designsAdded, {});
  assert.ok(result.todos.some((item) => item.startsWith("The Design System's designs could not be read")));
});

test("--existing keeps a dependency the site already declares and reports it", async (t) => {
  const root = await temporaryDirectory(t);
  const set = await templateSet();
  const [name, version] = Object.entries(set.dependencies.all)[0];
  const site = await existingSite(root, { packageJson: { ...EXISTING_PACKAGE, devDependencies: { ...EXISTING_PACKAGE.devDependencies, [name]: "0.0.1-site" } } });
  const result = await scaffoldExistingEmdashSite(site, { skipInstall: true, templatesRoot: TEMPLATES, readDesigns: async () => [], output: quiet });
  const after = JSON.parse(await fs.readFile(path.join(site, "package.json"), "utf8"));
  assert.equal(after.devDependencies[name], "0.0.1-site");
  assert.equal(after.dependencies[name], undefined);
  assert.deepEqual(result.dependencies.kept.find((entry) => entry.name === name), { name, declared: "0.0.1-site", template: version, dev: false });
  assert.ok(!result.dependencies.added.some((entry) => entry.name === name));
  assert.ok(result.todos.includes(`package.json already declares ${name} 0.0.1-site, kept as it is; the templates were written for ${version}, so compare the two`));
  // A system without the article designs leaves every route unpaired.
  assert.deepEqual(result.preview.unpaired, Object.keys(set.preview.designs));
});

test("--existing leaves a preview.ready the site chose and an existing pair alone", async (t) => {
  const root = await temporaryDirectory(t);
  const set = await templateSet();
  const [route] = Object.keys(set.preview.designs);
  const site = await existingSite(root, { manifest: existingManifest({ preview: { ready: "/healthz", routes: ["/", route], designs: { "/": "website:/", [route]: "website:/contact" } } }) });
  const { reported } = await systemDesigns();
  const result = await scaffoldExistingEmdashSite(site, { skipInstall: true, templatesRoot: TEMPLATES, readDesigns: async () => reported, output: quiet });
  const preview = JSON.parse(await fs.readFile(path.join(site, "timds.consumer.json"), "utf8")).apps["acme-site"].preview;
  assert.equal(preview.ready, "/healthz");
  assert.equal(result.preview.ready, "unchanged");
  assert.ok(result.todos.some((item) => item.startsWith("preview.ready stays /healthz; the article routes need the seed loaded")));
  assert.equal(preview.designs[route], "website:/contact");
  assert.equal(preview.routes.filter((entry) => entry === route).length, 1);
});

test("--existing pairs designs from the pinned release's bundle, never the current release, and pairs nothing offline", async (t) => {
  const root = await temporaryDirectory(t);
  const set = await templateSet();
  const designRoutes = Object.values(set.preview.designs);
  const pinned = existingManifest().designSystem.version;
  // The current release has the article designs; what the pin names decides.
  const serve = (pinnedDesigns) => {
    const requests = [];
    const fetchImpl = async (url) => {
      requests.push(url);
      const respond = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body });
      if (url.endsWith(`/v/${encodeURIComponent(pinned)}/bundle.json`)) {
        return respond({ system: { id: "acme/core", version: pinned }, base: null, files: [], ...(pinnedDesigns ? { designs: pinnedDesigns } : {}) });
      }
      if (url.endsWith("/designs.json")) return respond({ designs: [{ id: "website", pages: designRoutes.map((route) => ({ route })) }] });
      if (url.endsWith("/.timds-artifact.json")) return respond({ version: "2099.01.01-1", entry: "index.html" });
      return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
    };
    return { requests, fetchImpl };
  };

  const current = serve([{ id: "website", routes: ["/", ...designRoutes] }]);
  const result = await scaffoldExistingEmdashSite(await existingSite(root), { skipInstall: true, templatesRoot: TEMPLATES, fetchImpl: current.fetchImpl, output: quiet });
  assert.deepEqual(current.requests, [`https://design-systems.timds.com/acme/core/artifact/v/${encodeURIComponent(pinned)}/bundle.json`], "only the pinned version's bundle is read");
  assert.deepEqual(result.preview.designsAdded, Object.fromEntries(Object.entries(set.preview.designs).map(([route, designRoute]) => [route, `website:${designRoute}`])));
  assert.deepEqual(result.preview.unpaired, []);

  // A pin from before the article designs: the current release has them, the pinned bundle does not.
  const older = serve([{ id: "website", routes: ["/", "/contact"] }]);
  const behind = await scaffoldExistingEmdashSite(await existingSite(path.join(root, "older")), { skipInstall: true, templatesRoot: TEMPLATES, fetchImpl: older.fetchImpl, output: quiet });
  assert.deepEqual(behind.preview.designsAdded, {}, "no pair names a design the pin lacks");
  assert.deepEqual(behind.preview.unpaired, Object.keys(set.preview.designs));
  const pairedAfter = Object.keys(behind.manifest.apps["acme-site"].preview.designs ?? {});
  assert.ok(Object.keys(set.preview.designs).every((route) => !pairedAfter.includes(route)), "the manifest gains no article pair");
  assert.ok(behind.todos.some((item) => /has no design yet in the pinned Design System version: move the pin/.test(item)));

  // A bundle from before design summaries pairs nothing and says why.
  const unrecorded = serve(null);
  const silent = await scaffoldExistingEmdashSite(await existingSite(path.join(root, "unrecorded")), { skipInstall: true, templatesRoot: TEMPLATES, fetchImpl: unrecorded.fetchImpl, output: quiet });
  assert.deepEqual(silent.preview.designsAdded, {});
  assert.match(silent.preview.designsError, /records no website designs/);

  const offline = await existingSite(path.join(root, "offline"));
  const unreachable = await scaffoldExistingEmdashSite(offline, { skipInstall: true, templatesRoot: TEMPLATES, fetchImpl: async () => { throw new Error("getaddrinfo ENOTFOUND"); }, output: quiet });
  assert.deepEqual(unreachable.preview.designsAdded, {});
  assert.match(unreachable.preview.designsError, /ENOTFOUND/);
  assert.ok(unreachable.todos.some((item) => item.startsWith("The Design System's designs could not be read (")));
});

test("--existing refuses, with the site untouched, when it cannot install", async (t) => {
  const root = await temporaryDirectory(t);
  const options = { skipInstall: true, templatesRoot: TEMPLATES, readDesigns: async () => [], output: quiet };
  const refuses = async (site, overrides, pattern) => {
    const before = await treeHash(site);
    await assert.rejects(scaffoldExistingEmdashSite(site, { ...options, ...overrides }), pattern);
    assert.deepEqual(await treeHash(site), before);
  };

  await assert.rejects(scaffoldExistingEmdashSite("", options), /--root is required/);
  await assert.rejects(scaffoldExistingEmdashSite(path.join(root, "missing"), options), /is not a directory[\s\S]*without --existing/);
  await write(path.join(root, "a-file"), "x\n");
  await assert.rejects(scaffoldExistingEmdashSite(path.join(root, "a-file"), options), /is not a directory/);

  const bare = path.join(root, "bare");
  await write(path.join(bare, "package.json"), EXISTING_PACKAGE);
  await refuses(bare, {}, /has no timds\.consumer\.json[\s\S]*timds consumer init[\s\S]*without --existing/);

  const invalid = await existingSite(path.join(root, "invalid"), { manifest: { schemaVersion: 2, apps: {} } });
  await refuses(invalid, {}, /timds\.consumer\.json is invalid/);

  const noPackage = await existingSite(path.join(root, "no-package"), { packageJson: null });
  await refuses(noPackage, {}, /package\.json does not exist/);
  const noAstro = await existingSite(path.join(root, "no-astro"), { packageJson: { ...EXISTING_PACKAGE, dependencies: { react: "^19.0.0" } } });
  await refuses(noAstro, {}, /does not depend on astro/);

  const twoApps = existingManifest({ cwd: "web" });
  twoApps.apps.docs = { ...structuredClone(twoApps.apps["acme-site"]), cwd: "docs" };
  const multi = await existingSite(path.join(root, "multi"), { cwd: "web", manifest: twoApps });
  await refuses(multi, {}, /declares 2 apps \(acme-site in web, docs in docs\) and none at the repository root[\s\S]*installs the EmDash files at the site root/);

  const site = await existingSite(path.join(root, "site"));
  await refuses(site, { platform: "heroku" }, /--platform heroku must be one of cloudflare, node/);
  await refuses(site, { siteUrl: "ftp://acme.example" }, /--site-url must use HTTP or HTTPS/);
  await refuses(site, { siteUrl: "not a url" }, /--site-url not a url is not a valid URL/);
  await refuses(site, { layout: "src/layouts/Missing.astro" }, /--layout src\/layouts\/Missing\.astro does not exist/);
  await refuses(site, { layout: "src/layouts/Base.html" }, /must be an \.astro path relative to the site root/);
  await refuses(site, { layout: "../outside.astro" }, /must be an \.astro path relative to the site root/);

  const noLayout = await existingSite(path.join(root, "no-layout"), { layout: false });
  await refuses(noLayout, {}, /has no src\/layouts\/Base\.astro[\s\S]*--layout PATH/);

  const seeded = await existingSite(path.join(root, "seeded"), { packageJson: { ...EXISTING_PACKAGE, emdash: { seed: "content/other.json" } } });
  await refuses(seeded, {}, /package\.json emdash\.seed is "content\/other\.json"/);
});

test("--existing lists every colliding path at once and writes nothing", async (t) => {
  const root = await temporaryDirectory(t);
  const site = await existingSite(root);
  const files = await templateFilesFor("cloudflare");
  const others = files.filter((file) => file.path !== "src/live.config.ts");
  const taken = ["src/live.config.ts", others[0].path, others.at(-1).path];
  for (const file of taken) await write(path.join(site, file), "the site's own\n");
  // A directory where a file goes collides too.
  const directory = others.find((file) => !taken.includes(file.path));
  if (directory) await fs.mkdir(path.join(site, directory.path), { recursive: true });
  const before = await treeHash(site);
  const error = await scaffoldExistingEmdashSite(site, { skipInstall: true, templatesRoot: TEMPLATES, readDesigns: async () => [], output: quiet }).then(() => null, (caught) => caught);
  assert.ok(error);
  for (const file of [...new Set([...taken, ...(directory ? [directory.path] : [])])]) assert.ok(error.message.includes(`\n  ${file}`), file);
  assert.match(error.message, /never overwrites a file or edits an existing page/);
  assert.match(error.message, /_emdash live collection/);
  assert.match(error.message, /Nothing was written/);
  assert.deepEqual(await treeHash(site), before);
});

test("--existing restores the site when a write fails part-way", async (t) => {
  const root = await temporaryDirectory(t);
  const site = await existingSite(root);
  const before = await treeHash(site);
  let calls = 0;
  const failing = async (target, content) => {
    calls += 1;
    if (target.endsWith(path.join(".timds", "emdash.json"))) throw new Error("disk full");
    await fs.writeFile(target, content);
  };
  await assert.rejects(scaffoldExistingEmdashSite(site, { skipInstall: true, templatesRoot: TEMPLATES, readDesigns: async () => [], writeFile: failing, output: quiet }), /disk full/);
  assert.equal(calls, (await templateFilesFor("cloudflare")).length + 3, "the template files, package.json and the manifest were written before the failure");
  assert.deepEqual(await treeHash(site), before);
});

test("--existing refuses a second run and changes nothing", async (t) => {
  const root = await temporaryDirectory(t);
  const site = await existingSite(root);
  const options = { skipInstall: true, templatesRoot: TEMPLATES, readDesigns: async () => [], output: quiet };
  await scaffoldExistingEmdashSite(site, options);
  const before = await treeHash(site);
  await assert.rejects(scaffoldExistingEmdashSite(site, options), /already exist:[\s\S]*src\/live\.config\.ts[\s\S]*\.timds\/emdash\.json/);
  assert.deepEqual(await treeHash(site), before);
});

test("--existing runs npm install in the site unless skipped", async (t) => {
  const root = await temporaryDirectory(t);
  const site = await existingSite(root, { cwd: "web" });
  const installs = [];
  const result = await scaffoldExistingEmdashSite(site, { templatesRoot: TEMPLATES, readDesigns: async () => [], runInstall: async (cwd) => { installs.push(cwd); return { code: 0, stdout: "", stderr: "" }; }, output: quiet });
  assert.deepEqual(installs, [path.join(site, "web")]);
  assert.ok(!result.todos.some((item) => item.startsWith("Run npm install")));

  // A failed install comes after everything the developer has to do by hand
  // is printed: the files are written by then, and a rerun would refuse them.
  const failing = await existingSite(path.join(root, "failing"));
  const printed = [];
  let printedBeforeInstall = null;
  await assert.rejects(
    scaffoldExistingEmdashSite(failing, {
      templatesRoot: TEMPLATES,
      readDesigns: async () => [],
      runInstall: async () => { printedBeforeInstall = printed.join("\n"); return { code: 1, stdout: "", stderr: "connect ENETUNREACH" }; },
      output: (line = "") => printed.push(line),
    }),
    /npm install failed[\s\S]*ENETUNREACH[\s\S]*The EmDash files are already in place and the configuration changes printed above still apply[\s\S]*do not rerun the scaffold[\s\S]*docs\/emdash-handover\.md/,
  );
  assert.ok(existsSync(path.join(failing, EMDASH_RECORD_PATH)));
  const set = await templateSet();
  for (const entry of set.manual.cloudflare) assert.ok(printedBeforeInstall.includes(`Change ${entry.file} by hand: ${entry.summary}`), `${entry.file} is printed before the install`);
  for (const line of [...set.gitignore.all, ...set.gitignore.cloudflare]) assert.ok(printedBeforeInstall.includes(`  ${line}`), `.gitignore ${line} is printed before the install`);
  assert.match(printedBeforeInstall, /Dependencies added:/);
});

test("the recorded template version survives timds upgrade and consumer init", async (t) => {
  const root = await temporaryDirectory(t);
  const site = path.join(root, "acme-site");
  await fs.mkdir(site, { recursive: true });
  git(site, "init", "-b", "main");
  await write(path.join(site, "package.json"), EXISTING_PACKAGE);
  await write(path.join(site, "src/layouts/Base.astro"), "---\n---\n<slot />\n");
  await initializeConsumer(site, { system: "acme/core", version: "2026.11.01-1", skipInstall: true, output: quiet });
  const set = await templateSet();

  await scaffoldExistingEmdashSite(site, { skipInstall: true, templatesRoot: TEMPLATES, readDesigns: async () => [], output: quiet });
  const record = await fs.readFile(path.join(site, EMDASH_RECORD_PATH), "utf8");
  assert.deepEqual(JSON.parse(record), { template: set.version, platform: "cloudflare" });

  const installation = path.join(site, ".timds/installation.json");
  const recorded = JSON.parse(await fs.readFile(installation, "utf8"));
  recorded.consumer.version = "0.1.0";
  await write(installation, recorded);
  const upgraded = await runWithOutputSink(quiet, () => runCli(["upgrade", "--root", site]));
  assert.equal(upgraded.previousVersion, "0.1.0");
  assert.equal(upgraded.version, toolkitPackage.version);
  assert.equal(await fs.readFile(path.join(site, EMDASH_RECORD_PATH), "utf8"), record);

  // Even a --force init, which regenerates the manifest, leaves the record alone.
  await initializeConsumer(site, { force: true, system: "acme/core", version: "2026.11.01-1", skipInstall: true, output: quiet });
  assert.equal(await fs.readFile(path.join(site, EMDASH_RECORD_PATH), "utf8"), record);
  for (const file of await templateFilesFor("cloudflare")) assert.ok(existsSync(path.join(site, file.path)), file.path);
});

test("the template set's site.json has the interface shape", async () => {
  const set = await templateSet();
  assert.equal(validateEmdashTemplateSet(structuredClone(set)).version, set.version);
  assert.ok(existsSync(path.join(TEMPLATES, "site/src/live.config.ts")));
  for (const platform of ["cloudflare", "node"]) {
    for (const entry of set.manual[platform]) assert.ok(existsSync(path.join(TEMPLATES, entry.snippet)), entry.snippet);
  }
  assert.throws(() => validateEmdashTemplateSet({ ...set, extra: true }), /templates\/emdash\/site\.json is malformed: the top level must have exactly[\s\S]*report it to TimDS/);
  assert.throws(() => validateEmdashTemplateSet({ ...set, version: "1" }), /version must be a positive whole number/);
  assert.throws(() => validateEmdashTemplateSet({ ...set, preview: { ...set.preview, designs: { "/elsewhere": "/elsewhere" } } }), /pairs \/elsewhere, which preview\.routes does not list/);
  assert.throws(() => validateEmdashTemplateSet({ ...set, manual: { cloudflare: [{ file: "astro.config.mjs", summary: "x" }], node: [] } }), /manual\.cloudflare\[0\] must have exactly file, summary, snippet/);
});

test("refuses a template set that is malformed or leaves a placeholder unfilled", async (t) => {
  const root = await temporaryDirectory(t);
  const templates = path.join(root, "templates");
  await fs.cp(TEMPLATES, templates, { recursive: true });
  const site = await existingSite(root);
  const before = await treeHash(site);
  const options = { skipInstall: true, templatesRoot: templates, readDesigns: async () => [], output: quiet };

  await write(path.join(templates, "site/src/pages/extra.astro"), "---\nconst x = \"__UNKNOWN_VALUE__\";\n---\n");
  await assert.rejects(scaffoldExistingEmdashSite(site, options), /placeholders the installer does not fill: site\/src\/pages\/extra\.astro \(__UNKNOWN_VALUE__\)[\s\S]*report it to TimDS/);
  await fs.rm(path.join(templates, "site/src/pages/extra.astro"));

  await write(path.join(templates, "site.json"), "{ not json");
  await assert.rejects(scaffoldExistingEmdashSite(site, options), /templates\/emdash\/site\.json is malformed: it is not JSON[\s\S]*report it to TimDS/);
  assert.deepEqual(await treeHash(site), before);
});

test("runConsumerScaffold parses --existing and refuses the other mode's flags", async (t) => {
  const root = await temporaryDirectory(t);
  const site = await existingSite(root);
  const lines = [];
  assert.equal(await runConsumerScaffold(["emdash", "--help"], { output: (line) => lines.push(line) }), null);
  assert.match(lines[0], /timds consumer scaffold emdash --existing --root PATH\n\s+\[--platform cloudflare\|node\] \[--layout PATH\] \[--site-url URL\]\n\s+\[--skip-install\]/);

  const before = await treeHash(site);
  for (const [extra, pattern] of [
    [["--design-system", "git@example.com:a/b.git"], /--design-system belongs to the fresh scaffold, not --existing/],
    [["--stylesheet", "a.css", "--portal-url", "https://timds.example"], /--stylesheet, --portal-url belong to the fresh scaffold, not --existing/],
  ]) {
    await assert.rejects(runConsumerScaffold(["emdash", "--existing", "--root", site, ...extra], { output: quiet }), pattern);
  }
  await assert.rejects(runConsumerScaffold(["emdash", "--root", path.join(root, "new"), "--design-system", "x", "--layout", "src/layouts/Base.astro"], { output: quiet }), /--layout applies only to --existing/);
  await assert.rejects(runConsumerScaffold(["emdash", "--existing", "--root", site, "--layout"], { output: quiet }), /--layout requires a value/);
  await assert.rejects(runConsumerScaffold(["emdash", "--existing", "--root", site, "--platform=heroku"], { output: quiet }), /--platform heroku must be one of/);
  await assert.rejects(runConsumerScaffold(["emdash", "--existing"], { output: quiet }), /--root is required/);
  assert.deepEqual(await treeHash(site), before);
  assert.equal(existsSync(path.join(root, "new")), false);

  const result = await runConsumerScaffold(
    ["emdash", "--existing", `--root=${site}`, "--platform", "node", "--layout=src/layouts/Base.astro", "--site-url", "https://www.acme.example", "--skip-install"],
    { output: quiet, existingOptions: { templatesRoot: TEMPLATES, readDesigns: async () => [] } },
  );
  assert.equal(result.platform, "node");
  assert.equal(result.siteUrl, "https://www.acme.example");
  assert.equal(result.layout, "src/layouts/Base.astro");
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(site, EMDASH_RECORD_PATH), "utf8")).platform, "node");
});

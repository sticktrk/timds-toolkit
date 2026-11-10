// `timds consumer scaffold emdash`: create an EmDash CMS site that consumes a
// TimDS Design System.
//
// EmDash (https://github.com/emdash-cms/emdash) is an Astro-based CMS: page
// content lives in its database, the theme is Astro source in the site
// repository. The scaffold pins the Design System as the `design-system`
// submodule of a new repository, generates the unstyled `starter` template
// with EmDash's own generator (for Cloudflare Workers with D1 and R2, or for
// Node.js with SQLite), and wires the theme to the pin:
//
//   src/styles/theme.css         imports the system's stylesheets from the
//                                submodule and styles the site shell with the
//                                tokens that fill the brand roles
//   src/utils/design-system.ts   (starter-build systems only) compiles the
//                                pinned tokens.json to custom properties by
//                                the rule the system's own build uses
//   public/*                     links the system's public assets from the
//                                pin so root-relative CSS URLs reach them
//   src/layouts/Base.astro       loads both
//   timds.consumer.json          the site as one root app: seeded preview,
//                                theme-only design surface
//   DESIGN_SYSTEM.md             which change goes where (CMS content, theme
//                                pull request, Design System)
//   wrangler.jsonc, .github/workflows/deploy-cloudflare.yml
//                                (Cloudflare only) the Worker, database, and
//                                bucket named after the site, and a Wrangler
//                                deploy that is started by hand the first time
//
// then hands over to `initializeConsumer` for the consumer-managed files.
//
// `--existing` (`scaffoldExistingEmdashSite`) installs the shared EmDash
// template set into an Astro consumer that already has timds.consumer.json:
// the files under templates/emdash/site/ and site-<platform>/ at their paths
// relative to the site root (placeholders filled, never over an existing
// path), the dependencies and package.json keys templates/emdash/site.json
// lists, the article routes and design pairs in the app's preview, and the
// template version in `.timds/emdash.json`. `planEmdashTemplates` and
// `applyWritesWithRollback` are the installer both modes are meant to share.
// The astro.config, wrangler.jsonc and .gitignore changes are printed, never
// made. Every refusal comes before the first write, and a failed write
// restores the site.
//
// Boundary: nothing is copied out of the Design System; the site reads the
// pin at build time, so moving the pin is what changes the brand. Everything
// written here is product source from then on: `upgrade` refreshes only the
// consumer-managed files `initializeConsumer` records, and never reads or
// writes `.timds/emdash.json`. The Design System is inspected before the site
// is generated, and a failure before the managed files are in place removes
// what the scaffold created.

import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { CONSUMER_MANIFEST_FILE, consumerPinMode, publishedBaseUrl, validateConsumerManifest } from "./consumer.mjs";
import { CONSUMER_MCP_PATH, consumerMcpServers, initializeConsumer, rootAppName } from "./consumer-init.mjs";
import { BRAND_ROLES, importReferences, normalizeBrandRoles, parseCssTokens, resolveBrandRoles, resolveTokens } from "./tokens.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The generator the scaffold runs: bounded to one major, like the toolkit's own release line. */
export const EMDASH_GENERATOR = "create-emdash@1";
export const EMDASH_MCP_SERVER_NAME = "emdash";
export const EMDASH_PLATFORMS = Object.freeze(["cloudflare", "node"]);
/** Where the template set lives in the package; the installer takes another root for tests. */
export const EMDASH_TEMPLATES_ROOT = path.join(packageRoot, "templates", "emdash");
/** The site's record of the template set it came from: `{ "template": N, "platform": "..." }`. */
export const EMDASH_RECORD_PATH = ".timds/emdash.json";

const DESIGN_SYSTEM_PATH = "design-system";
const DEFAULT_PORTAL_URL = "https://timds.com";
// Not Astro's default 4321: the starter Design System's own dev server and
// other Astro sites already listen there.
const DEV_PORT = 4380;
// EmDash's development-only setup route: applies the bundled seed (schema and
// demo content) to the local database, then redirects. It answers 403 outside
// `astro dev`, and works the same on SQLite and on the local D1.
const DEV_SEED_ROUTE = "/_emdash/api/setup/dev-bypass";
const WRANGLER_CONFIG = "wrangler.jsonc";
const DEPLOY_WORKFLOW = ".github/workflows/deploy-cloudflare.yml";
const DEPLOY_ON_PUSH_VARIABLE = "CLOUDFLARE_DEPLOY_ON_PUSH";
const BASE_LAYOUT = "src/layouts/Base.astro";
const THEME_STYLESHEET = "src/styles/theme.css";
const TOKEN_MODULE = "src/utils/design-system.ts";
const STARTER_STYLESHEET = "src/styles/system.css";
// The starter build writes tokens.css from tokens.json at build time, so the
// file a product would import does not exist in the pinned source.
const STARTER_BUILD = ["node", "scripts/build.mjs"];
const MAX_IMPORT_DEPTH = 8;

const SCAFFOLD_HELP = `Usage:
  timds consumer scaffold emdash --root PATH --design-system GIT_URL
      [--platform cloudflare|node] [--stylesheet PATH]... [--site-url URL]
      [--portal-url URL] [--skip-install]
  timds consumer scaffold emdash --existing --root PATH
      [--platform cloudflare|node] [--layout PATH] [--site-url URL]
      [--skip-install]

Creates a new EmDash CMS site repository at --root (which must not exist, or
be empty) that consumes a TimDS Design System: the Design System is pinned as
the design-system submodule, the EmDash starter template is generated with
${EMDASH_GENERATOR}, and its theme reads the pin, so every color and font on
the site comes from the system. It then runs the same adoption as timds
consumer init. Nothing is committed.

--platform is where the site is hosted: cloudflare (the default; Workers with
a D1 database and an R2 bucket named after the site, and a deploy workflow
that runs only when started by hand until ${DEPLOY_ON_PUSH_VARIABLE} is set)
or node (a Node.js server with SQLite and local file storage).

--stylesheet names a stylesheet, relative to the Design System root, that the
site imports from the submodule; repeat it for several. It defaults to
${STARTER_STYLESHEET} when the system has one. --site-url is the deployed
site's origin; with it, .mcp.json also gets the EmDash MCP server for content
editing.

--existing installs the EmDash template set (the article routes, the seed,
src/live.config.ts and the site docs) into an Astro site at --root that
already has ${CONSUMER_MANIFEST_FILE}, so it gains an articles section fed
through EmDash's API. It adds the dependencies and package.json keys the
templates need (keeping any the site already declares), the article routes
and their design pairs to the app's preview, and the template version to
${EMDASH_RECORD_PATH}. It never overwrites a path or edits an existing page:
any path that exists is refused before anything is written. The changes to
astro.config, wrangler.jsonc and .gitignore are printed for the developer.
--layout names the site's layout component (an .astro file relative to the
site root; default ${BASE_LAYOUT}); --site-url fills the site's origin.`;

// ---------------------------------------------------------------------------
// Small helpers

function run(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: error.message }));
    child.on("close", (code) => resolve({ code: Number(code ?? -1), stdout, stderr }));
  });
}

const tail = (result) => (result.stderr || result.stdout).trim().split("\n").slice(-20).join("\n");

const toJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

async function template(name) {
  return fs.readFile(path.join(packageRoot, "templates", "emdash", name), "utf8");
}

async function readJson(filePath, label) {
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (caught) {
    if (caught?.code === "ENOENT") return null;
    throw caught;
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not a JSON object");
    return value;
  } catch (caught) {
    throw new Error(`${label} is not a valid JSON object (${caught.message})`);
  }
}

async function writeFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

function slug(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "site";
}

function isSafeRelativePath(value) {
  const normalized = String(value).replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return false;
  return normalized.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

// ---------------------------------------------------------------------------
// The Design System as the site reads it

/** tokens.json as the `:root` block the starter build writes to tokens.css (`--group-name`). */
export function compileTokenCss(tokens) {
  const declarations = [];
  for (const [group, entries] of Object.entries(tokens)) {
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
    for (const [name, token] of Object.entries(entries)) {
      if (typeof token?.value !== "string" || !token.value.trim()) continue;
      declarations.push(`  ${`--${group}-${name}`.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}: ${token.value};`);
    }
  }
  return `:root {\n${declarations.sort().join("\n")}\n}\n`;
}

async function stylesheetCss(designSystemRoot, relative, seen = new Set(), depth = 0) {
  const normalized = path.posix.normalize(relative.replace(/\\/g, "/"));
  if (seen.has(normalized) || depth > MAX_IMPORT_DEPTH || normalized.startsWith("../")) return "";
  seen.add(normalized);
  let css;
  try {
    css = await fs.readFile(path.join(designSystemRoot, normalized), "utf8");
  } catch (caught) {
    if (caught?.code === "ENOENT") return "";
    throw caught;
  }
  let imported = "";
  for (const reference of importReferences(css)) {
    if (reference.startsWith("/")) continue;
    imported += await stylesheetCss(designSystemRoot, path.posix.join(path.posix.dirname(normalized), reference), seen, depth + 1);
  }
  return `${imported}${css}\n`;
}

/**
 * What a site imports from a checked-out Design System: the stylesheets, the
 * tokens.json compile when the system still runs the starter build, and the
 * token that fills each brand role. Refuses a directory that is not a TimDS
 * Design System, a named stylesheet the system does not have, and a system
 * that offers the site nothing to import.
 */
export async function inspectDesignSystem(designSystemRoot, { stylesheets = [] } = {}) {
  const manifest = await readJson(path.join(designSystemRoot, "timds.json"), `${DESIGN_SYSTEM_PATH}/timds.json`);
  const systemId = String(manifest?.systemId || "").trim();
  if (!systemId) {
    throw new Error("The repository has no timds.json with a systemId at its root, so it is not a standalone TimDS Design System. Create one with timds init --standalone, then rerun.");
  }
  for (const stylesheet of stylesheets) {
    if (!existsSync(path.join(designSystemRoot, stylesheet))) throw new Error(`--stylesheet ${stylesheet} does not exist in the Design System (${systemId})`);
  }
  const selected = stylesheets.length
    ? [...new Set(stylesheets.map((stylesheet) => path.posix.normalize(stylesheet.replace(/\\/g, "/"))))]
    : existsSync(path.join(designSystemRoot, STARTER_STYLESHEET)) ? [STARTER_STYLESHEET] : [];

  const tokensJson = JSON.stringify(manifest.workspace?.build) === JSON.stringify(STARTER_BUILD)
    ? await readJson(path.join(designSystemRoot, "tokens.json"), `${DESIGN_SYSTEM_PATH}/tokens.json`)
    : null;
  if (!selected.length && !tokensJson) {
    throw new Error(`The Design System (${systemId}) has no ${STARTER_STYLESHEET} and does not run the starter build, so the scaffold cannot tell what a product imports. Name its stylesheets with --stylesheet PATH (relative to the Design System root), once for each.`);
  }

  let css = tokensJson ? compileTokenCss(tokensJson) : "";
  const seen = new Set();
  for (const stylesheet of selected) css += await stylesheetCss(designSystemRoot, stylesheet, seen);
  let mapping = {};
  try {
    mapping = normalizeBrandRoles(manifest.brand?.roles);
  } catch {
    // The system's own check reports a malformed mapping; conventions still apply here.
  }
  const resolved = resolveBrandRoles(resolveTokens(parseCssTokens(css)), mapping);
  const roles = Object.fromEntries(Object.entries(resolved.roles).map(([role, { token }]) => [role, token]));
  const missing = Object.keys(BRAND_ROLES).filter((role) => !roles[role]);
  const publicAssets = await fs.readdir(path.join(designSystemRoot, "public")).catch((caught) => {
    if (caught?.code === "ENOENT") return [];
    throw caught;
  });
  // The website designs the system holds, so the site's home route can be
  // paired with the design of the home page from the first preview on.
  const { readDesignCatalog } = await import("./designs.mjs");
  const catalog = await readDesignCatalog(designSystemRoot);
  const designs = catalog.designs.map((design) => ({ id: design.id, routes: design.pages.map((page) => page.route) }));
  return { systemId, name: String(manifest.name || systemId), stylesheets: selected, tokens: Boolean(tokensJson), roles, missing, publicAssets: publicAssets.sort(), designs };
}

// ---------------------------------------------------------------------------
// Rendering

function rule(selector, declarations) {
  const lines = declarations.filter(Boolean);
  return lines.length ? `${selector} {\n${lines.map((line) => `  ${line}`).join("\n")}\n}` : "";
}

/**
 * The site's theme entry. It imports the system's stylesheets from the pin
 * and styles only the EmDash starter shell, naming the token that fills each
 * brand role; a role nothing fills leaves its declaration out rather than
 * inventing a value.
 */
export function renderThemeCss({ stylesheets, roles }) {
  const token = (role) => (roles[role] ? `var(${roles[role]})` : null);
  const declare = (property, role) => (token(role) ? `${property}: ${token(role)};` : null);
  const imports = stylesheets
    .map((stylesheet) => `@import "${path.posix.relative(path.posix.dirname(THEME_STYLESHEET), `${DESIGN_SYSTEM_PATH}/${stylesheet}`)}";`)
    .join("\n");
  const border = token("color.text") ? `border-bottom: 1px solid color-mix(in srgb, ${token("color.text")} 14%, transparent);` : null;
  return [
    `/* The site theme. Every color and font here is a Design System token, read\n   from the pinned ${DESIGN_SYSTEM_PATH}/ submodule and never copied: moving the pin is\n   what changes the brand. Name tokens with var(--…); a value the system does\n   not have is a Design System change, not a literal in this file. */`,
    imports,
    rule("body", ["margin: 0;", declare("background", "color.background"), declare("color", "color.text"), declare("font-family", "font.body")]),
    rule("h1, h2, h3", [declare("font-family", "font.display")]),
    rule("a", [declare("color", "color.accent")]),
    rule("header", [declare("background", "color.panel"), border, declare("font-family", "font.ui")]),
    rule("header nav", ["display: flex;", "flex-wrap: wrap;", "align-items: center;", "gap: 0.75rem 1.5rem;", "max-width: 72rem;", "margin: 0 auto;", "padding: 1rem 1.5rem;"]),
    rule("header nav a", ["text-decoration: none;", declare("color", "color.text")]),
    rule("main", ["max-width: 72rem;", "margin: 0 auto;", "padding: 2rem 1.5rem 4rem;"]),
    rule("main time, main small", [declare("color", "color.muted")]),
  ].filter(Boolean).join("\n\n").concat("\n");
}

/**
 * EmDash's Base.astro with the theme imported in its frontmatter and, for a
 * starter-build system, the compiled tokens in `<head>`. Refuses a layout
 * without the two anchors instead of guessing where they went.
 */
export function patchBaseLayout(source, { tokens }) {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const head = lines.findIndex((line) => line.includes("</head>"));
  if (lines[0].trim() !== "---" || head === -1) {
    throw new Error(`${BASE_LAYOUT} from ${EMDASH_GENERATOR} has no frontmatter or no </head>, so the scaffold cannot load the theme. The EmDash starter template has changed; report it to TimDS.`);
  }
  const indent = lines[head].match(/^\s*/)[0];
  const step = indent.includes(" ") ? "  " : "\t";
  if (tokens) lines.splice(head, 0, `${indent}${step}<style is:inline set:html={designSystemTokenCss}></style>`);
  lines.splice(1, 0, `import "../styles/theme.css";`, ...(tokens ? [`import { designSystemTokenCss } from "../utils/design-system";`] : []));
  return lines.join(newline);
}

/**
 * EmDash's wrangler.jsonc with the Worker, its D1 database, and its R2 bucket
 * named after the site instead of the template's shared placeholders, so two
 * sites in one Cloudflare account never deploy over each other. Comments and
 * layout are kept; a config without the three names is refused.
 */
export function nameCloudflareResources(source, siteName) {
  const name = slug(siteName).slice(0, 50).replace(/-+$/, "") || "site";
  const values = { name, database_name: name, bucket_name: `${name}-media` };
  let config = source;
  for (const [key, value] of Object.entries(values)) {
    const pattern = new RegExp(`^(\\s*"${key}"\\s*:\\s*)"[^"\\n]*"`, "m");
    if (!pattern.test(config)) throw new Error(`${WRANGLER_CONFIG} from ${EMDASH_GENERATOR} has no "${key}", so the scaffold cannot name the site's Cloudflare resources. The EmDash starter template has changed; report it to TimDS.`);
    config = config.replace(pattern, (_match, prefix) => `${prefix}"${value}"`);
  }
  return { config, ...values };
}

/** `timds.consumer.json` for the site: one root app, previewed from a seeded local database. */
export function emdashConsumerManifest({ appName, systemId, publicAssets = [], designs = [] }) {
  const home = designs.find((design) => design.routes.includes("/"));
  const manifest = {
    schemaVersion: 1,
    designSystem: { path: DESIGN_SYSTEM_PATH, systemId },
    apps: {
      [appName]: {
        cwd: ".",
        install: ["npm", "ci", "--no-audit", "--no-fund"],
        preview: {
          // --ignore-lock keeps astro dev in the foreground when an agent starts it.
          serve: ["npm", "run", "dev", "--", "--port", String(DEV_PORT), "--host", "127.0.0.1", "--ignore-lock"],
          port: DEV_PORT,
          // The preview needs content: waiting on the seed route loads it.
          ready: `${DEV_SEED_ROUTE}?redirect=/`,
          routes: ["/"],
          discover: { from: ["/"], limit: 40, exclude: ["/_emdash/**"] },
          viewports: ["desktop", "phone"],
          schemes: ["light", "dark"],
          // The home page is reviewed beside its design when the system designed one.
          ...(home ? { designs: { "/": `${home.id}:/` } } : {}),
        },
        designSurface: ["src/layouts/**", "src/components/**", "src/styles/**", "src/pages/**", "public/**"],
        // These links reach Design System source, outside the designer's surface.
        protected: publicAssets.flatMap((entry) => [`public/${entry}`, `public/${entry}/**`]),
      },
    },
  };
  validateConsumerManifest(manifest);
  return manifest;
}

function emdashMcpUrl(siteUrl) {
  let parsed;
  try {
    parsed = new URL(String(siteUrl));
  } catch {
    throw new Error(`--site-url ${siteUrl} is not a valid URL`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("--site-url must use HTTP or HTTPS");
  return new URL("/_emdash/api/mcp", `${parsed.origin}/`).toString();
}

// ---------------------------------------------------------------------------
// Generation

/** Run EmDash's generator in `directory`; returns the generated site folder. */
async function createEmdashSite(directory, { name, platform }) {
  const created = await run("npx", ["--yes", EMDASH_GENERATOR, name, "--template", "starter", "--platform", platform, "--pm", "npm", "--no-install", "--yes"], directory);
  if (created.code !== 0) throw new Error(`${EMDASH_GENERATOR} failed:\n${tail(created)}`);
  return path.join(directory, name);
}

/** Expose static assets at their original URLs without copying source out of the pin. */
async function linkPublicAssets(repoRoot, entries) {
  const written = [];
  for (const entry of entries) {
    const relative = `public/${entry}`;
    const destination = path.join(repoRoot, relative);
    const existing = await fs.lstat(destination).catch((caught) => {
      if (caught?.code === "ENOENT") return null;
      throw caught;
    });
    if (existing) throw new Error(`The Design System asset ${DESIGN_SYSTEM_PATH}/${relative} conflicts with the generated site's ${relative}. Choose a Design System public asset path that does not overlap the EmDash template.`);
    const source = `${DESIGN_SYSTEM_PATH}/${relative}`;
    const stat = await fs.stat(path.join(repoRoot, source));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.symlink(path.posix.relative("public", source), destination, stat.isDirectory() ? "dir" : "file");
    written.push(relative);
  }
  return written;
}

async function refuseUnusableRoot(root) {
  if (existsSync(root)) {
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) throw new Error(`${root} is not a directory`);
    if ((await fs.readdir(root)).length) throw new Error(`${root} is not empty. timds consumer scaffold creates a new site repository; choose a new folder, or adopt TimDS in an existing product with timds consumer init.`);
  }
  let ancestor = root;
  while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const enclosing = await run("git", ["rev-parse", "--show-toplevel"], ancestor);
  if (enclosing.code === 0 && enclosing.stdout.trim()) {
    throw new Error(`${root} is inside the git repository ${enclosing.stdout.trim()}. The site is its own repository; choose a folder outside it.`);
  }
}

/**
 * Create the site. Refuses (before anything is written) a root that exists
 * and is not empty or sits inside another repository; a Design System problem
 * found after the submodule is added removes what was created. Returns what
 * was written and the checklist for the developer.
 */
export async function scaffoldEmdashSite(rootInput, {
  designSystem,
  platform = "cloudflare",
  stylesheets = [],
  siteUrl = "",
  portalUrl = DEFAULT_PORTAL_URL,
  skipInstall = false,
  createSite = createEmdashSite,
  output = () => {},
} = {}) {
  if (!rootInput) throw new Error(`--root is required\n${SCAFFOLD_HELP}`);
  const url = String(designSystem || "").trim();
  if (!url) throw new Error(`--design-system is required: the git URL of the standalone Design System repository\n${SCAFFOLD_HELP}`);
  if (!EMDASH_PLATFORMS.includes(platform)) throw new Error(`--platform ${platform} must be one of ${EMDASH_PLATFORMS.join(", ")}`);
  for (const stylesheet of stylesheets) {
    if (!isSafeRelativePath(stylesheet) || !stylesheet.endsWith(".css")) throw new Error(`--stylesheet ${stylesheet} must be a .css path relative to the Design System root`);
  }
  const mcpUrl = siteUrl ? emdashMcpUrl(siteUrl) : null;
  consumerMcpServers({ portalUrl }); // Validate before creating the repository or running the generator.
  const root = path.resolve(rootInput);
  await refuseUnusableRoot(root);

  const existed = existsSync(root);
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "timds-emdash-"));
  const discard = async () => {
    if (!existed) return fs.rm(root, { force: true, recursive: true });
    for (const entry of await fs.readdir(root)) await fs.rm(path.join(root, entry), { force: true, recursive: true });
  };

  let repoRoot;
  let system;
  let appName;
  let adopted;
  let cloudflare = null;
  const written = [];
  try {
    await fs.mkdir(root, { recursive: true });
    repoRoot = await fs.realpath(root);
    const initialized = await run("git", ["init", "-b", "main"], repoRoot);
    if (initialized.code !== 0) throw new Error(`git init failed in ${repoRoot}:\n${tail(initialized)}`);
    output(`Pinning the Design System at ${DESIGN_SYSTEM_PATH}/...`);
    const added = await run("git", ["submodule", "add", "--", url, DESIGN_SYSTEM_PATH], repoRoot);
    if (added.code !== 0) throw new Error(`git submodule add ${url} failed:\n${tail(added)}`);
    system = await inspectDesignSystem(path.join(repoRoot, DESIGN_SYSTEM_PATH), { stylesheets });

    output(`Generating the EmDash site with ${EMDASH_GENERATOR}...`);
    const siteName = slug(path.basename(repoRoot));
    const generated = await createSite(staging, { name: siteName, platform });
    const layout = await fs.readFile(path.join(generated, BASE_LAYOUT), "utf8").catch(() => null);
    const packageJson = await readJson(path.join(generated, "package.json"), "the generated package.json");
    if (layout === null || !packageJson) throw new Error(`${EMDASH_GENERATOR} did not produce ${BASE_LAYOUT} and package.json. The EmDash starter template has changed; report it to TimDS.`);
    const patchedLayout = patchBaseLayout(layout, { tokens: system.tokens });
    if (platform === "cloudflare") {
      const wrangler = await fs.readFile(path.join(generated, WRANGLER_CONFIG), "utf8").catch(() => null);
      if (wrangler === null) throw new Error(`${EMDASH_GENERATOR} did not produce ${WRANGLER_CONFIG} for the cloudflare platform. The EmDash starter template has changed; report it to TimDS.`);
      cloudflare = nameCloudflareResources(wrangler, siteName);
    }
    for (const entry of await fs.readdir(generated)) {
      // The repository holds only .git, .gitmodules, and the submodule so far.
      if (existsSync(path.join(repoRoot, entry))) throw new Error(`${EMDASH_GENERATOR} produced ${entry}, which the new repository already has`);
      // verbatimSymlinks: the template links .claude/skills to ../.agents/skills,
      // and a resolved copy would commit an absolute path into the staging folder.
      await fs.cp(path.join(generated, entry), path.join(repoRoot, entry), { recursive: true, verbatimSymlinks: true });
    }

    written.push(...await linkPublicAssets(repoRoot, system.publicAssets));

    await writeFile(path.join(repoRoot, BASE_LAYOUT), patchedLayout);
    written.push(BASE_LAYOUT);
    await writeFile(path.join(repoRoot, THEME_STYLESHEET), renderThemeCss(system));
    written.push(THEME_STYLESHEET);
    if (system.tokens) {
      await writeFile(path.join(repoRoot, TOKEN_MODULE), await template("design-system.ts"));
      written.push(TOKEN_MODULE);
    }

    if (cloudflare) {
      await writeFile(path.join(repoRoot, WRANGLER_CONFIG), cloudflare.config);
      written.push(WRANGLER_CONFIG);
      await writeFile(path.join(repoRoot, DEPLOY_WORKFLOW), await template("deploy-cloudflare.yml"));
      written.push(DEPLOY_WORKFLOW);
    }

    appName = rootAppName(packageJson.name, path.basename(repoRoot));
    await writeFile(path.join(repoRoot, CONSUMER_MANIFEST_FILE), toJson(emdashConsumerManifest({ appName, systemId: system.systemId, publicAssets: system.publicAssets, designs: system.designs })));
    written.push(CONSUMER_MANIFEST_FILE);

    const imports = [
      ...(system.tokens ? [`- \`${TOKEN_MODULE}\` compiles the pinned \`${DESIGN_SYSTEM_PATH}/tokens.json\` to CSS custom properties, by the rule the system's own build uses, and \`${BASE_LAYOUT}\` puts them on every page.`] : []),
      ...(system.publicAssets.length ? [`- ${system.publicAssets.map((entry) => `\`public/${entry}\``).join(", ")} are relative symlinks into \`${DESIGN_SYSTEM_PATH}/public/\`, so stylesheet URLs such as \`/fonts/example.woff2\` read assets from the pin. These paths are protected: never edit through the links. A developer must add a link when a later pin introduces a new top-level public asset path.`] : []),
      `- \`${THEME_STYLESHEET}\` ${system.stylesheets.length ? `imports ${system.stylesheets.map((stylesheet) => `\`${DESIGN_SYSTEM_PATH}/${stylesheet}\``).join(", ")} from the pin and` : ""} styles the site shell with the system's tokens.`.replace(/\s+/g, " "),
    ].join("\n");
    await writeFile(path.join(repoRoot, "DESIGN_SYSTEM.md"), (await template("DESIGN_SYSTEM.md"))
      .replaceAll("__SYSTEM_ID__", () => system.systemId)
      .replaceAll("__SYSTEM_NAME__", () => system.name)
      .replaceAll("__DESIGN_SYSTEM_PATH__", () => DESIGN_SYSTEM_PATH)
      .replaceAll("__DEV_SEED_ROUTE__", () => DEV_SEED_ROUTE)
      .replace("__HOSTING__", () => (cloudflare
        ? `The site runs on Cloudflare Workers as \`${cloudflare.name}\`, with the D1 database \`${cloudflare.database_name}\` and the R2 bucket \`${cloudflare.bucket_name}\` (\`${WRANGLER_CONFIG}\`). \`${DEPLOY_WORKFLOW}\` builds and deploys it with Wrangler: it runs when started by hand, and on every push to \`main\` once the repository variable \`${DEPLOY_ON_PUSH_VARIABLE}\` is \`true\`. The first deployment creates the database and the bucket; local development uses a local copy of both, so it needs no Cloudflare account.`
        : "The site runs as a Node.js server with a SQLite database (`data.db`) and uploaded media on local disk (`uploads/`); both stay out of git."))
      .replace("__IMPORTS__", () => imports));
    written.push("DESIGN_SYSTEM.md");
    const agentsPath = path.join(repoRoot, "AGENTS.md");
    const agents = (await fs.readFile(agentsPath, "utf8").catch(() => "")).replace(/\s*$/, "");
    await writeFile(agentsPath, `${agents}${agents ? "\n\n" : ""}${(await template("AGENTS-design-system.md")).replaceAll("__DESIGN_SYSTEM_PATH__", () => DESIGN_SYSTEM_PATH)}`);
    written.push("AGENTS.md");

    if (mcpUrl) {
      const mcpPath = path.join(repoRoot, CONSUMER_MCP_PATH);
      const config = (await readJson(mcpPath, CONSUMER_MCP_PATH)) ?? {};
      config.mcpServers = { ...(config.mcpServers || {}), [EMDASH_MCP_SERVER_NAME]: { type: "http", url: mcpUrl } };
      await writeFile(mcpPath, toJson(config));
    }

    adopted = await initializeConsumer(repoRoot, { skipInstall: true, portalUrl });
    written.push(...adopted.written.filter((file) => !written.includes(file)));
  } catch (caught) {
    await discard();
    throw caught;
  } finally {
    await fs.rm(staging, { force: true, recursive: true });
  }

  if (!skipInstall) {
    output("Running npm install to write the lockfile...");
    const installed = await run("npm", ["install", "--no-audit", "--no-fund"], repoRoot);
    if (installed.code !== 0) throw new Error(`npm install failed in ${repoRoot}:\n${tail(installed)}\nFix the error and run npm install; the site and the TimDS files are already in place.`);
  }

  const todos = [
    ...(skipInstall ? ["Run npm install and commit package-lock.json; the preview installs with npm ci"] : []),
    ...(system.missing.length ? [`The Design System fills no token for ${system.missing.join(", ")}, so ${THEME_STYLESHEET} leaves ${system.missing.length === 1 ? "that declaration" : "those declarations"} out; add the tokens in the Design System (or map the roles in its timds.json brand.roles), then use them in the theme`] : []),
    `Run npm run dev and open ${DEV_SEED_ROUTE}?redirect=/_emdash/admin once: it loads the starter's demo content into the local database and signs you in as a development administrator`,
    `Commit everything (the ${DESIGN_SYSTEM_PATH} pin included), create the site's repository, and push; .env holds the local EMDASH_ENCRYPTION_KEY and stays out of git`,
    ...(cloudflare
      ? [
        `To deploy, add the CLOUDFLARE_API_TOKEN (Workers Scripts, D1, and R2 edit) and CLOUDFLARE_ACCOUNT_ID secrets, then start ${DEPLOY_WORKFLOW} by hand: it deploys the Worker ${cloudflare.name}, and the first deployment creates the D1 database ${cloudflare.database_name} and the R2 bucket ${cloudflare.bucket_name}`,
        `Create the first administrator at /_emdash/admin straight after that first deployment (until setup is completed, whoever opens it first becomes the administrator), then set the repository variable ${DEPLOY_ON_PUSH_VARIABLE} to true to deploy every push to main`,
        "Add an EMDASH_ENCRYPTION_KEY secret (npx emdash secrets generate) for the deploy to upload to the Worker, and before creating the first administrator on a custom domain add its route and EMDASH_SITE_URL to wrangler.jsonc: passkeys only work on the address they were created on",
      ]
      : ["Set EMDASH_ENCRYPTION_KEY wherever the Node.js server is deployed, and keep data.db and uploads/ on persistent storage"]),
    `To have each Design System release open a pin-update pull request here, declare this repository as consumer in the Design System's timds.json; a same-host relative submodule URL in .gitmodules (../<design-system-repo>.git) lets one credential fetch both`,
    mcpUrl
      ? `Content is edited through the "${EMDASH_MCP_SERVER_NAME}" MCP server in ${CONSUMER_MCP_PATH} (${mcpUrl}); it signs in through the site's own OAuth, with the EmDash role of the person connecting`
      : `Once the site is deployed, add its EmDash MCP server (<site origin>/_emdash/api/mcp) to ${CONSUMER_MCP_PATH} so an agent can edit content`,
    ...adopted.todos.filter((item) => !item.startsWith(`After editing ${CONSUMER_MANIFEST_FILE}`) && !item.startsWith(`Commit ${CONSUMER_MANIFEST_FILE}`)),
    "Then run npm run timds -- consumer check",
  ];

  output(`Created the EmDash site ${appName} at ${repoRoot}, consuming ${system.systemId}.`);
  for (const file of written) output(`  ${file}`);
  output("");
  output("For the developer to confirm:");
  for (const item of todos) output(`- ${item}`);

  return {
    repoRoot,
    appName,
    platform,
    ...(cloudflare ? { cloudflare: { name: cloudflare.name, databaseName: cloudflare.database_name, bucketName: cloudflare.bucket_name } } : {}),
    systemId: system.systemId,
    stylesheets: system.stylesheets,
    tokens: system.tokens,
    roles: system.roles,
    missingRoles: system.missing,
    written,
    todos,
    manifest: adopted.manifest,
  };
}

// ---------------------------------------------------------------------------
// The shared EmDash template set (templates/emdash/site*, site.json)

const EMDASH_HANDOVER_DOC = "docs/emdash-handover.md";
const EXAMPLE_SITE_URL = "https://example.com";
const PLACEHOLDER = /__[A-Z][A-Z0-9_]*__/g;
const TEMPLATE_GROUPS = ["all", ...EMDASH_PLATFORMS];

const templateDefect = (detail) => new Error(`templates/emdash/site.json is malformed: ${detail}. The EmDash templates in this TimDS release are broken; report it to TimDS.`);

const isRoute = (value) => typeof value === "string" && value.startsWith("/") && !/\s|\0/.test(value);
const normalizeRoute = (value) => (value.length > 1 ? `/${value.replace(/^\/+|\/+$/g, "")}` : "/");

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, where) {
  if (!isPlainObject(value)) throw templateDefect(`${where} must be an object`);
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (extra.length || missing.length) throw templateDefect(`${where} must have exactly ${keys.join(", ")}${extra.length ? ` (unexpected ${extra.join(", ")})` : ""}${missing.length ? ` (missing ${missing.join(", ")})` : ""}`);
}

/**
 * Validate the parsed `site.json`. It is toolkit data, so a defect is
 * reported as a TimDS bug, never as something the developer fixes.
 */
export function validateEmdashTemplateSet(value) {
  exactKeys(value, ["version", "dependencies", "devDependencies", "package", "preview", "gitignore", "manual"], "the top level");
  if (!Number.isInteger(value.version) || value.version < 1) throw templateDefect("version must be a positive whole number");
  for (const block of ["dependencies", "devDependencies"]) {
    exactKeys(value[block], TEMPLATE_GROUPS, block);
    for (const group of TEMPLATE_GROUPS) {
      if (!isPlainObject(value[block][group])) throw templateDefect(`${block}.${group} must be an object of package versions`);
      for (const [name, version] of Object.entries(value[block][group])) {
        if (!name || typeof version !== "string" || !version.trim()) throw templateDefect(`${block}.${group}.${name} must be a version string`);
      }
    }
  }
  if (!isPlainObject(value.package)) throw templateDefect("package must be an object of package.json keys");
  const { preview } = value;
  exactKeys(preview, ["ready", "routes", "designs", "discoverExclude"], "preview");
  if (!isRoute(preview.ready)) throw templateDefect("preview.ready must be a URL path");
  if (!Array.isArray(preview.routes) || !preview.routes.length || !preview.routes.every(isRoute)) throw templateDefect("preview.routes must be a list of URL paths");
  if (new Set(preview.routes.map(normalizeRoute)).size !== preview.routes.length) throw templateDefect("preview.routes repeats a route");
  if (!isPlainObject(preview.designs)) throw templateDefect("preview.designs must be an object of site route to design route");
  const declared = new Set(preview.routes.map(normalizeRoute));
  for (const [route, designRoute] of Object.entries(preview.designs)) {
    if (!isRoute(route) || !isRoute(designRoute)) throw templateDefect(`preview.designs ${route} must map a URL path to a URL path`);
    if (!declared.has(normalizeRoute(route))) throw templateDefect(`preview.designs pairs ${route}, which preview.routes does not list`);
  }
  if (!Array.isArray(preview.discoverExclude) || !preview.discoverExclude.every(isRoute)) throw templateDefect("preview.discoverExclude must be a list of URL path globs");
  exactKeys(value.gitignore, TEMPLATE_GROUPS, "gitignore");
  for (const group of TEMPLATE_GROUPS) {
    if (!Array.isArray(value.gitignore[group]) || !value.gitignore[group].every((line) => typeof line === "string" && line.trim())) throw templateDefect(`gitignore.${group} must be a list of lines`);
  }
  exactKeys(value.manual, [...EMDASH_PLATFORMS], "manual");
  for (const platform of EMDASH_PLATFORMS) {
    if (!Array.isArray(value.manual[platform])) throw templateDefect(`manual.${platform} must be a list`);
    for (const [index, entry] of value.manual[platform].entries()) {
      exactKeys(entry, ["file", "summary", "snippet"], `manual.${platform}[${index}]`);
      for (const key of ["file", "summary", "snippet"]) {
        if (typeof entry[key] !== "string" || !entry[key].trim()) throw templateDefect(`manual.${platform}[${index}].${key} must be a string`);
      }
      if (!isSafeRelativePath(entry.snippet) || !isSafeRelativePath(entry.file)) throw templateDefect(`manual.${platform}[${index}] must name relative paths`);
    }
  }
  return value;
}

/** Every file under `directory` as sorted POSIX paths relative to it; an absent directory has none. */
async function templateFiles(directory, prefix = "") {
  const entries = await fs.readdir(path.join(directory, prefix), { withFileTypes: true }).catch((caught) => {
    if (caught?.code === "ENOENT") return null;
    throw caught;
  });
  if (entries === null) return prefix ? [] : null;
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await templateFiles(directory, relative));
    else if (entry.isFile()) files.push(relative);
    else throw templateDefect(`${path.basename(directory)}/${relative} is not a regular file`);
  }
  return files.sort();
}

/** The template set: the validated site.json and its directory. */
export async function readEmdashTemplateSet(templatesRoot = EMDASH_TEMPLATES_ROOT) {
  let text;
  try {
    text = await fs.readFile(path.join(templatesRoot, "site.json"), "utf8");
  } catch (caught) {
    if (caught?.code === "ENOENT") throw templateDefect("the file is missing");
    throw caught;
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (caught) {
    throw templateDefect(`it is not JSON (${caught.message})`);
  }
  return { root: templatesRoot, ...validateEmdashTemplateSet(value) };
}

/** `../layouts/Base.astro` from `src/pages/articles/index.astro`: always `./` or `../` first, POSIX separators. */
export function layoutImport(fromFile, layout) {
  const relative = path.posix.relative(path.posix.dirname(fromFile), layout);
  return relative.startsWith("../") ? relative : `./${relative}`;
}

function substitute(text, { file, layout, siteUrl, siteName }) {
  return text
    .replaceAll("__LAYOUT_IMPORT__", () => layoutImport(file, layout))
    .replaceAll("__SITE_URL__", () => siteUrl)
    .replaceAll("__SITE_NAME__", () => siteName);
}

/**
 * Plan the template files for one site: every file of `site/` and of
 * `site-<platform>/` at its path relative to the site root, text files with
 * their placeholders substituted. Nothing is written. Returns the template
 * set, the planned files, the paths that already exist (files, directories,
 * or a file where a directory has to be), the files that received the
 * example origin, and the manual changes with their snippet text. Refuses a
 * template defect (a file in both directories, a placeholder left over).
 */
export async function planEmdashTemplates(siteRoot, { platform, layout, siteUrl = "", siteName, templatesRoot = EMDASH_TEMPLATES_ROOT } = {}) {
  const set = await readEmdashTemplateSet(templatesRoot);
  const shared = await templateFiles(path.join(templatesRoot, "site"));
  if (shared === null) throw templateDefect("templates/emdash/site/ is missing");
  const own = (await templateFiles(path.join(templatesRoot, `site-${platform}`))) ?? [];
  const both = own.filter((file) => shared.includes(file));
  if (both.length) throw templateDefect(`${both.join(", ")} is in both site/ and site-${platform}/`);
  const origin = siteUrl || EXAMPLE_SITE_URL;
  const values = { layout, siteUrl: origin, siteName };
  const files = [];
  const exampleOrigin = [];
  const leftover = [];
  for (const [directory, list] of [["site", shared], [`site-${platform}`, own]]) {
    for (const file of list) {
      const bytes = await fs.readFile(path.join(templatesRoot, directory, ...file.split("/")));
      let content = bytes;
      if (!bytes.includes(0)) {
        const text = bytes.toString("utf8");
        if (!siteUrl && text.includes("__SITE_URL__")) exampleOrigin.push(file);
        content = substitute(text, { ...values, file });
        const left = content.match(PLACEHOLDER);
        if (left) leftover.push(`${directory}/${file} (${[...new Set(left)].join(", ")})`);
      }
      files.push({ path: file, content });
    }
  }
  if (leftover.length) throw new Error(`The EmDash templates in this TimDS release use placeholders the installer does not fill: ${leftover.join("; ")}. Nothing was written; report it to TimDS.`);
  files.sort((left, right) => left.path.localeCompare(right.path));

  const collisions = new Set();
  for (const file of files) {
    const segments = file.path.split("/");
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const relative = segments.slice(0, depth).join("/");
      // A linked directory on the way is followed; the destination itself is never.
      const inspect = depth < segments.length ? fs.stat : fs.lstat;
      const info = await inspect(path.join(siteRoot, ...segments.slice(0, depth))).catch((caught) => {
        if (caught?.code === "ENOENT" || caught?.code === "ENOTDIR") return null;
        throw caught;
      });
      if (!info) break;
      // A directory on the way is expected; anything else in the way collides.
      if (depth < segments.length && info.isDirectory()) continue;
      collisions.add(relative);
      break;
    }
  }

  const manual = [];
  for (const entry of set.manual[platform]) {
    let text;
    try {
      text = await fs.readFile(path.join(templatesRoot, ...entry.snippet.split("/")), "utf8");
    } catch (caught) {
      if (caught?.code === "ENOENT") throw templateDefect(`manual.${platform} names ${entry.snippet}, which is missing`);
      throw caught;
    }
    manual.push({ file: entry.file, summary: entry.summary, snippet: entry.snippet, text: substitute(text, { ...values, file: entry.file }) });
  }
  return {
    set,
    files,
    collisions: [...collisions].sort(),
    exampleOrigin,
    manual,
    gitignore: [...set.gitignore.all, ...set.gitignore[platform]],
    dependencies: { ...set.dependencies.all, ...set.dependencies[platform] },
    devDependencies: { ...set.devDependencies.all, ...set.devDependencies[platform] },
  };
}

// ---------------------------------------------------------------------------
// Writing with rollback

/** The indentation unit, line ending and final newline of a JSON file, so a rewrite keeps them. */
function jsonStyle(text) {
  const indent = text.match(/^[ \t]+(?=")/m)?.[0] ?? "  ";
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  return { indent, newline, final: /\r?\n$/.test(text) };
}

function formatJson(value, { indent, newline, final }) {
  const text = JSON.stringify(value, null, indent).replaceAll("\n", newline);
  return final ? `${text}${newline}` : text;
}

async function defaultWrite(filePath, content) {
  await fs.writeFile(filePath, content);
}

/**
 * Write `writes` (`{ path, content }`, relative to `root`) as one change: a
 * failure part-way removes the files and directories this call created and
 * puts every replaced file back to its earlier bytes, then rethrows.
 */
export async function applyWritesWithRollback(root, writes, { writeFile: write = defaultWrite } = {}) {
  const created = [];
  const createdDirectories = [];
  const replaced = [];
  try {
    for (const file of writes) {
      const target = path.join(root, ...file.path.split("/"));
      const missing = [];
      for (let directory = path.dirname(target); !existsSync(directory); directory = path.dirname(directory)) missing.push(directory);
      for (const directory of missing.reverse()) {
        await fs.mkdir(directory);
        createdDirectories.push(directory);
      }
      const before = await fs.readFile(target).catch((caught) => {
        if (caught?.code === "ENOENT") return null;
        throw caught;
      });
      if (before === null) created.push(target);
      else replaced.push({ target, before });
      await write(target, file.content);
    }
  } catch (caught) {
    for (const { target, before } of replaced.reverse()) await fs.writeFile(target, before).catch(() => {});
    for (const target of created.reverse()) await fs.rm(target, { force: true }).catch(() => {});
    for (const directory of createdDirectories.reverse()) await fs.rmdir(directory).catch(() => {});
    throw caught;
  }
  return writes.map((file) => file.path);
}

// ---------------------------------------------------------------------------
// Existing-site mode

/**
 * The website designs of the pinned system as `[{ id, routes }]`: for a
 * published pin the designs summary of that exact version's bundle (the same
 * record `consumer sync` keeps and `consumer check` reads), for a submodule
 * pin the checkout. The current release never stands in for the pinned one:
 * a pair it added would name a design the pin does not have, and `consumer
 * check` would refuse it. Throws when the designs cannot be read; the caller
 * then pairs nothing.
 */
export async function readPinnedDesigns({ repoRoot, manifest, fetchImpl = fetch }) {
  if (consumerPinMode(manifest.designSystem) === "published") {
    const { resolvePublishedBundle } = await import("./consumer-sync.mjs");
    const { version } = manifest.designSystem;
    const bundle = await resolvePublishedBundle({ url: publishedBaseUrl(manifest.designSystem), version, fetchImpl, withDesigns: true });
    if (!bundle.designs) throw new Error(`the bundle of the pinned version ${bundle.version} records no website designs`);
    return bundle.designs.map((design) => ({ id: design.id, routes: Array.isArray(design.routes) ? design.routes : [] }));
  }
  const checkout = path.join(repoRoot, manifest.designSystem.path);
  if (!existsSync(path.join(checkout, "timds.json"))) throw new Error(`${manifest.designSystem.path} is not checked out`);
  const { readDesignCatalog } = await import("./designs.mjs");
  const catalog = await readDesignCatalog(checkout);
  if (!catalog.exists) throw new Error(`${manifest.designSystem.path} has no src/designs/`);
  return catalog.designs.map((design) => ({ id: design.id, routes: design.pages.map((page) => page.route) }));
}

/** The app the templates install into: the only app, or the one at the repository root. */
function selectEmdashApp(manifest) {
  const names = Object.keys(manifest.apps);
  if (names.length === 1) return names[0];
  const root = names.filter((name) => manifest.apps[name].cwd === ".");
  if (root.length === 1) return root[0];
  throw new Error(`${CONSUMER_MANIFEST_FILE} declares ${names.length} apps (${names.map((name) => `${name} in ${manifest.apps[name].cwd}`).join(", ")}) and none at the repository root (cwd "."). The existing-site mode installs the EmDash files at the site root, the folder of the only app or of the root app, so it cannot tell which app is the site. Run it in a repository whose site is that app.`);
}

/**
 * Merge `template` into `target` (package.json keys): absent keys are added,
 * equal values kept; a different value is a collision, named by its dotted path.
 */
function mergePackageKeys(target, template, prefix, collisions) {
  for (const [key, value] of Object.entries(template)) {
    const where = prefix ? `${prefix}.${key}` : key;
    if (!Object.hasOwn(target, key)) {
      target[key] = structuredClone(value);
    } else if (isPlainObject(value) && isPlainObject(target[key])) {
      mergePackageKeys(target[key], value, where, collisions);
    } else if (JSON.stringify(target[key]) !== JSON.stringify(value)) {
      collisions.push(`package.json ${where} is ${JSON.stringify(target[key])}; the templates need ${JSON.stringify(value)}`);
    }
  }
}

/**
 * The manifest change for the app: routes, design pairs, the discovery
 * exclusions, and the ready route, against the raw manifest so no default
 * is written out. Returns the new raw manifest and what changed.
 */
function planManifestPreview(raw, appName, { preview, designs }) {
  const next = structuredClone(raw);
  const app = next.apps[appName];
  const result = { routesAdded: [], designsAdded: {}, unpaired: [], excludeAdded: [], ready: "unchanged", crawl: Boolean(app.preview?.serve) };
  if (!result.crawl) return { manifest: next, ...result };
  const target = app.preview;
  const listed = new Set((target.routes ?? []).map(normalizeRoute));
  for (const route of preview.routes) {
    if (listed.has(normalizeRoute(route))) continue;
    target.routes = [...(target.routes ?? []), route];
    listed.add(normalizeRoute(route));
    result.routesAdded.push(route);
  }
  const paired = new Set(Object.keys(target.designs ?? {}).map(normalizeRoute));
  // A design the site already pairs with comes first, then the catalog order.
  const preferred = Object.values(target.designs ?? {}).map((reference) => String(reference).split(":")[0]);
  const ordered = designs ? [...designs].sort((left, right) => {
    const rank = (design) => (preferred.includes(design.id) ? preferred.indexOf(design.id) : preferred.length);
    return rank(left) - rank(right);
  }) : [];
  for (const [route, designRoute] of Object.entries(preview.designs)) {
    if (paired.has(normalizeRoute(route))) continue;
    if (!designs) continue;
    const design = ordered.find((candidate) => candidate.routes.map(normalizeRoute).includes(normalizeRoute(designRoute)));
    if (!design) {
      result.unpaired.push(route);
      continue;
    }
    target.designs = { ...(target.designs ?? {}), [route]: `${design.id}:${normalizeRoute(designRoute)}` };
    result.designsAdded[route] = target.designs[route];
  }
  if (target.discover) {
    const present = new Set(target.discover.exclude ?? []);
    for (const glob of preview.discoverExclude) {
      if (present.has(glob)) continue;
      target.discover.exclude = [...(target.discover.exclude ?? []), glob];
      present.add(glob);
      result.excludeAdded.push(glob);
    }
  }
  if (target.ready === undefined || target.ready === "/") {
    target.ready = preview.ready;
    result.ready = "set";
  }
  return { manifest: next, ...result };
}

async function readSiteJson(filePath, label) {
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (caught) {
    if (caught?.code === "ENOENT") return null;
    throw caught;
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (caught) {
    throw new Error(`${label} is not valid JSON (${caught.message}); fix it, then rerun`);
  }
  if (!isPlainObject(value)) throw new Error(`${label} is not a JSON object; fix it, then rerun`);
  return { text, value };
}

/**
 * `timds consumer scaffold emdash --existing`: install the shared EmDash
 * template set into an Astro consumer that already has `timds.consumer.json`,
 * so the site gains an articles section fed through EmDash's API.
 *
 * Everything is decided before anything is written: a refusal leaves the site
 * untouched, and a failure part-way through the writes removes what this run
 * created and restores package.json and the manifest. Writes the template
 * files (never over an existing path), the dependencies and package keys the
 * templates need in package.json, the article routes, design pairs,
 * discovery exclusions and seed-loading ready route in the app's preview, and
 * the template version in `.timds/emdash.json`. Configuration it cannot
 * change safely (astro.config, wrangler.jsonc, .gitignore) is printed.
 */
export async function scaffoldExistingEmdashSite(rootInput, {
  platform = "cloudflare",
  layout: layoutInput = "",
  siteUrl = "",
  skipInstall = false,
  templatesRoot = EMDASH_TEMPLATES_ROOT,
  readDesigns = readPinnedDesigns,
  fetchImpl = fetch,
  writeFile: write = defaultWrite,
  runInstall = (cwd) => run("npm", ["install", "--no-audit", "--no-fund"], cwd),
  output = () => {},
} = {}) {
  if (!rootInput) throw new Error(`--root is required: the folder of the Astro site that holds ${CONSUMER_MANIFEST_FILE}\n${SCAFFOLD_HELP}`);
  if (!EMDASH_PLATFORMS.includes(platform)) throw new Error(`--platform ${platform} must be one of ${EMDASH_PLATFORMS.join(", ")}`);
  let origin = "";
  if (siteUrl) {
    emdashMcpUrl(siteUrl); // The same HTTP(S) rule and messages as the fresh scaffold.
    origin = new URL(String(siteUrl)).origin;
  }
  const requested = path.resolve(rootInput);
  const rootInfo = await fs.stat(requested).catch(() => null);
  if (!rootInfo?.isDirectory()) throw new Error(`--root ${rootInput} is not a directory. The existing-site mode installs into an Astro site that is already there; to create a new site, run timds consumer scaffold emdash without --existing.`);
  const repoRoot = await fs.realpath(requested);

  const manifestFile = await readSiteJson(path.join(repoRoot, CONSUMER_MANIFEST_FILE), CONSUMER_MANIFEST_FILE);
  if (!manifestFile) throw new Error(`${repoRoot} has no ${CONSUMER_MANIFEST_FILE}. The existing-site mode installs into a site that already consumes a Design System: adopt TimDS first with timds consumer init (--system ID for a published pin), then rerun. To create a new EmDash site instead, run timds consumer scaffold emdash without --existing.`);
  const manifest = validateConsumerManifest(manifestFile.value);
  const appName = selectEmdashApp(manifest);
  const appCwd = manifest.apps[appName].cwd;
  const appRoot = path.join(repoRoot, ...(appCwd === "." ? [] : appCwd.split("/")));
  const inApp = (relative) => (appCwd === "." ? relative : `${appCwd}/${relative}`);

  const packageFile = await readSiteJson(path.join(appRoot, "package.json"), inApp("package.json"));
  if (!packageFile) throw new Error(`${inApp("package.json")} does not exist. The existing-site mode installs into an Astro site; app "${appName}" in ${CONSUMER_MANIFEST_FILE} must be one.`);
  const packageJson = packageFile.value;
  const declared = (name) => packageJson.dependencies?.[name] ?? packageJson.devDependencies?.[name];
  if (!declared("astro")) throw new Error(`${inApp("package.json")} does not depend on astro. EmDash runs inside an Astro site, so the existing-site mode installs only into one; to create a new EmDash site, run timds consumer scaffold emdash without --existing.`);

  let layout;
  if (layoutInput) {
    const normalized = String(layoutInput).replace(/\\/g, "/");
    if (!isSafeRelativePath(normalized) || !normalized.endsWith(".astro")) throw new Error(`--layout ${layoutInput} must be an .astro path relative to the site root (${appCwd === "." ? "the repository root" : appCwd})`);
    if (!(await fs.stat(path.join(appRoot, ...normalized.split("/"))).catch(() => null))?.isFile()) throw new Error(`--layout ${layoutInput} does not exist in the site (${inApp(normalized)})`);
    layout = path.posix.normalize(normalized);
  } else if ((await fs.stat(path.join(appRoot, ...BASE_LAYOUT.split("/"))).catch(() => null))?.isFile()) {
    layout = BASE_LAYOUT;
  } else {
    throw new Error(`The site has no ${inApp(BASE_LAYOUT)}, so the article pages have no layout to render in. Name the site's layout component with --layout PATH (an .astro file relative to the site root), then rerun.`);
  }

  const siteName = String(packageJson.name || path.basename(appRoot));
  const plan = await planEmdashTemplates(appRoot, { platform, layout, siteUrl: origin, siteName, templatesRoot });
  const collisions = plan.collisions.map(inApp);
  if (existsSync(path.join(repoRoot, ...EMDASH_RECORD_PATH.split("/")))) collisions.push(EMDASH_RECORD_PATH);

  const nextPackage = structuredClone(packageJson);
  const packageCollisions = [];
  mergePackageKeys(nextPackage, plan.set.package, "", packageCollisions);
  const dependencies = { added: [], kept: [] };
  for (const [block, wanted] of [["dependencies", plan.dependencies], ["devDependencies", plan.devDependencies]]) {
    for (const [name, version] of Object.entries(wanted)) {
      const current = declared(name);
      if (current !== undefined) {
        dependencies.kept.push({ name, declared: current, template: version, dev: block === "devDependencies" });
        continue;
      }
      nextPackage[block] = { ...(nextPackage[block] ?? {}), [name]: version };
      dependencies.added.push({ name, version, dev: block === "devDependencies" });
    }
  }

  if (collisions.length || packageCollisions.length) {
    const liveConfig = collisions.includes(inApp("src/live.config.ts"))
      ? `\n${inApp("src/live.config.ts")} is the site's own content configuration. EmDash reads its entries through an _emdash live collection that the templates' src/live.config.ts defines: move the site's file aside, rerun to install the rest, then add the collections the site had to the installed file.`
      : "";
    throw new Error(`The existing-site mode never overwrites a file or edits an existing page, and these already exist:\n${[...collisions.map((entry) => `  ${entry}`), ...packageCollisions.map((entry) => `  ${entry}`)].join("\n")}${liveConfig}\nMove or rename them (or remove an earlier EmDash install), then rerun. Nothing was written.`);
  }

  // The pinned system's designs decide which routes are paired; unreadable designs pair nothing.
  let designs = null;
  let designsError = null;
  try {
    designs = await readDesigns({ repoRoot, manifest, fetchImpl });
    if (!Array.isArray(designs)) {
      designs = null;
      designsError = "the system reports no website designs";
    }
  } catch (caught) {
    designsError = caught instanceof Error ? caught.message : String(caught);
  }
  const previewPlan = planManifestPreview(manifestFile.value, appName, { preview: plan.set.preview, designs });
  const nextManifest = validateConsumerManifest(previewPlan.manifest);

  const record = { template: plan.set.version, platform };
  const packageText = formatJson(nextPackage, jsonStyle(packageFile.text));
  const manifestText = formatJson(previewPlan.manifest, jsonStyle(manifestFile.text));
  const writes = [
    ...plan.files.map((file) => ({ path: inApp(file.path), content: file.content })),
    ...(packageText !== packageFile.text ? [{ path: inApp("package.json"), content: packageText }] : []),
    ...(manifestText !== manifestFile.text ? [{ path: CONSUMER_MANIFEST_FILE, content: manifestText }] : []),
    { path: EMDASH_RECORD_PATH, content: toJson(record) },
  ];
  output(`Installing the EmDash template set (version ${plan.set.version}, ${platform}) into ${appCwd === "." ? repoRoot : `${repoRoot}/${appCwd}`}...`);
  const written = await applyWritesWithRollback(repoRoot, writes, { writeFile: write });

  const handover = plan.files.some((file) => file.path === EMDASH_HANDOVER_DOC);
  const todos = [
    ...(handover ? [`The handover checklist (first deploy and setup, the writer's token, the encryption key backup, deploy on push) is in ${inApp(EMDASH_HANDOVER_DOC)}`] : []),
    ...(skipInstall ? ["Run npm install and commit the lockfile; the preview installs from it"] : []),
    ...dependencies.kept.map(({ name, declared: current, template: version }) => `package.json already declares ${name} ${current}, kept as it is; the templates were written for ${version}, so compare the two`),
    ...(plan.manual.length ? [`Make the configuration changes printed above in ${[...new Set(plan.manual.map((entry) => inApp(entry.file)))].join(", ")}; the scaffold does not edit configuration it cannot change safely`] : []),
    ...(plan.gitignore.length ? [`Add the .gitignore lines printed above`] : []),
    ...(plan.exampleOrigin.length ? [`No --site-url was given, so ${plan.exampleOrigin.map(inApp).join(", ")} use ${EXAMPLE_SITE_URL} as the site's origin; replace it with the production origin`] : []),
    ...(!previewPlan.crawl ? [`App "${appName}" previews a static build, and the article routes are rendered on request; give its preview serve, port and routes, then add ${plan.set.preview.routes.join(", ")} to them`] : []),
    ...(previewPlan.crawl && previewPlan.ready === "unchanged" ? [`preview.ready stays ${manifest.apps[appName].preview.ready}; the article routes need the seed loaded, so make sure the preview opens ${plan.set.preview.ready} before it captures them`] : []),
    ...(previewPlan.crawl && designsError ? [`The Design System's designs could not be read (${designsError}), so no preview.designs pairs were added; pair ${Object.keys(plan.set.preview.designs).join(", ")} with their designs by hand once they can be`] : []),
    ...previewPlan.unpaired.map((route) => `${route} has no design yet in the pinned Design System version: move the pin to a release that has it, or author it in the Design System, then pair it in preview.designs`),
    ...(previewPlan.crawl ? [`Rerun timds consumer init so the consumer skill and the launch entries match the edited ${CONSUMER_MANIFEST_FILE}`] : []),
    `Review the diff, commit it, and run npm run timds -- consumer check`,
  ];

  // The files are in place from here on, so the changes only this run prints
  // go out before npm install: a failed install must not take them with it.
  output(`Installed the EmDash template set into app ${appName}:`);
  for (const file of written) output(`  ${file}`);
  if (dependencies.added.length) {
    output("");
    output("Dependencies added:");
    for (const { name, version, dev } of dependencies.added) output(`  ${name} ${version}${dev ? " (dev)" : ""}`);
  }
  if (dependencies.kept.length) {
    output("");
    output("Dependencies kept as the site declares them:");
    for (const { name, declared: current, template: version } of dependencies.kept) output(`  ${name} ${current} (templates written for ${version})`);
  }
  for (const entry of plan.manual) {
    output("");
    output(`Change ${inApp(entry.file)} by hand: ${entry.summary}`);
    output(entry.text.replace(/\s+$/, ""));
  }
  if (plan.gitignore.length) {
    output("");
    output("Add to .gitignore:");
    for (const line of plan.gitignore) output(`  ${line}`);
  }
  if (!skipInstall) {
    output("");
    output("Running npm install...");
    const installed = await runInstall(appRoot);
    if (installed.code !== 0) {
      throw new Error(`npm install failed in ${appRoot}:\n${tail(installed)}\nThe EmDash files are already in place and the configuration changes printed above still apply. Fix the error and run npm install; do not rerun the scaffold, which refuses paths that exist. The same changes are listed in ${inApp(EMDASH_HANDOVER_DOC)}.`);
    }
  }

  output("");
  output("For the developer to confirm:");
  for (const item of todos) output(`- ${item}`);

  return {
    repoRoot,
    appName,
    appCwd,
    platform,
    template: plan.set.version,
    record: EMDASH_RECORD_PATH,
    layout: inApp(layout),
    siteUrl: origin || null,
    written,
    dependencies,
    preview: {
      routesAdded: previewPlan.routesAdded,
      designsAdded: previewPlan.designsAdded,
      unpaired: previewPlan.unpaired,
      excludeAdded: previewPlan.excludeAdded,
      ready: previewPlan.ready,
      designsError,
    },
    manual: plan.manual.map((entry) => ({ ...entry, file: inApp(entry.file) })),
    gitignore: plan.gitignore,
    todos,
    manifest: nextManifest,
  };
}

function parseScaffoldArguments(argv) {
  const options = { stylesheets: [] };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("-")) {
      positional.push(value);
      continue;
    }
    const [rawName, inlineValue] = value.replace(/^--?/, "").split("=", 2);
    const name = rawName.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    if (["help", "h", "skipInstall", "existing"].includes(name)) {
      options[name === "h" ? "help" : name] = true;
      continue;
    }
    if (!["root", "designSystem", "platform", "stylesheet", "siteUrl", "portalUrl", "layout"].includes(name)) throw new Error(`Unknown option --${rawName}\n${SCAFFOLD_HELP}`);
    const next = inlineValue ?? argv[index + 1];
    if (next === undefined || String(next).startsWith("-")) throw new Error(`--${rawName} requires a value`);
    if (name === "stylesheet") options.stylesheets.push(next);
    else options[name] = next;
    if (inlineValue === undefined) index += 1;
  }
  return { options, positional };
}

/** `timds consumer scaffold emdash --root PATH --design-system GIT_URL [...]`, or `--existing --root PATH [...]` */
export async function runConsumerScaffold(args = [], { output = (message = "") => process.stdout.write(`${message}\n`), existingOptions = {} } = {}) {
  const { options, positional } = parseScaffoldArguments(args);
  if (options.help || !positional.length) {
    output(SCAFFOLD_HELP);
    return null;
  }
  if (positional.length > 1 || positional[0] !== "emdash") throw new Error(`Unknown site kind ${positional.join(" ")}; timds consumer scaffold creates emdash sites\n${SCAFFOLD_HELP}`);
  if (options.existing) {
    const fresh = [
      ...(options.designSystem ? ["--design-system"] : []),
      ...(options.stylesheets.length ? ["--stylesheet"] : []),
      ...(options.portalUrl ? ["--portal-url"] : []),
    ];
    if (fresh.length) throw new Error(`${fresh.join(", ")} ${fresh.length === 1 ? "belongs" : "belong"} to the fresh scaffold, not --existing: an existing site already pins its Design System in ${CONSUMER_MANIFEST_FILE} and was adopted by timds consumer init. Rerun without ${fresh.length === 1 ? "it" : "them"}.`);
    return scaffoldExistingEmdashSite(options.root, {
      ...(options.platform ? { platform: options.platform } : {}),
      layout: options.layout,
      siteUrl: options.siteUrl,
      skipInstall: Boolean(options.skipInstall),
      output,
      ...existingOptions,
    });
  }
  if (options.layout) throw new Error(`--layout applies only to --existing: the fresh scaffold generates its own ${BASE_LAYOUT}. Rerun without it, or add --existing to install into a site that already exists.`);
  return scaffoldEmdashSite(options.root, {
    designSystem: options.designSystem,
    ...(options.platform ? { platform: options.platform } : {}),
    stylesheets: options.stylesheets,
    siteUrl: options.siteUrl,
    skipInstall: Boolean(options.skipInstall),
    ...(options.portalUrl ? { portalUrl: options.portalUrl } : {}),
    output,
  });
}

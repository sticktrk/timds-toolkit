// `timds consumer scaffold emdash`: create an EmDash CMS site that consumes a
// TimDS Design System.
//
// EmDash (https://github.com/emdash-cms/emdash) is an Astro-based CMS: page
// content lives in its database, the theme is Astro source in the site
// repository. The scaffold pins the Design System as the `design-system`
// submodule of a new repository, generates the unstyled `starter` template
// with EmDash's own generator, and wires the theme to the pin:
//
//   src/styles/theme.css         imports the system's stylesheets from the
//                                submodule and styles the site shell with the
//                                tokens that fill the brand roles
//   src/utils/design-system.ts   (starter-build systems only) compiles the
//                                pinned tokens.json to custom properties by
//                                the rule the system's own build uses
//   src/layouts/Base.astro       loads both
//   timds.consumer.json          the site as one root app: seeded preview,
//                                theme-only design surface
//   DESIGN_SYSTEM.md             which change goes where (CMS content, theme
//                                pull request, Design System)
//
// then hands over to `initializeConsumer` for the consumer-managed files.
//
// Boundary: nothing is copied out of the Design System; the site reads the
// pin at build time, so moving the pin is what changes the brand. Everything
// written here is product source from then on: `upgrade` refreshes only the
// consumer-managed files `initializeConsumer` records. The Design System is
// inspected before the site is generated, and a failure before the managed
// files are in place removes what the scaffold created.

import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { CONSUMER_MANIFEST_FILE, validateConsumerManifest } from "./consumer.mjs";
import { CONSUMER_MCP_PATH, initializeConsumer, rootAppName } from "./consumer-init.mjs";
import { BRAND_ROLES, importReferences, normalizeBrandRoles, parseCssTokens, resolveBrandRoles, resolveTokens } from "./tokens.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The generator the scaffold runs: bounded to one major, like the toolkit's own release line. */
export const EMDASH_GENERATOR = "create-emdash@1";
export const EMDASH_MCP_SERVER_NAME = "emdash";

const DESIGN_SYSTEM_PATH = "design-system";
const DEFAULT_PORTAL_URL = "https://timds.com";
// Not Astro's default 4321: the starter Design System's own dev server and
// other Astro sites already listen there.
const DEV_PORT = 4380;
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
      [--stylesheet PATH]... [--site-url URL] [--portal-url URL] [--skip-install]

Creates a new EmDash CMS site repository at --root (which must not exist, or
be empty) that consumes a TimDS Design System: the Design System is pinned as
the design-system submodule, the EmDash starter template is generated with
${EMDASH_GENERATOR} (Node.js, SQLite), and its theme reads the pin, so every
color and font on the site comes from the system. It then runs the same
adoption as timds consumer init. Nothing is committed.

--stylesheet names a stylesheet, relative to the Design System root, that the
site imports from the submodule; repeat it for several. It defaults to
${STARTER_STYLESHEET} when the system has one. --site-url is the deployed
site's origin; with it, .mcp.json also gets the EmDash MCP server for content
editing.`;

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
  return { systemId, name: String(manifest.name || systemId), stylesheets: selected, tokens: Boolean(tokensJson), roles, missing };
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

/** `timds.consumer.json` for the site: one root app, previewed from a seeded local database. */
export function emdashConsumerManifest({ appName, systemId }) {
  const manifest = {
    schemaVersion: 1,
    designSystem: { path: DESIGN_SYSTEM_PATH, systemId },
    apps: {
      [appName]: {
        cwd: ".",
        // The preview needs content: seed the local SQLite database first.
        install: ["bash", "-c", "npm ci --no-audit --no-fund && npm run seed"],
        preview: {
          // --ignore-lock keeps astro dev in the foreground when an agent starts it.
          serve: ["npm", "run", "dev", "--", "--port", String(DEV_PORT), "--host", "127.0.0.1", "--ignore-lock"],
          port: DEV_PORT,
          ready: "/",
          routes: ["/"],
          discover: { from: ["/"], limit: 40, exclude: ["/_emdash/**"] },
          viewports: ["desktop", "phone"],
          schemes: ["light", "dark"],
        },
        designSurface: ["src/layouts/**", "src/components/**", "src/styles/**", "src/pages/**", "public/**"],
        protected: [],
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
async function createEmdashSite(directory, { name }) {
  const created = await run("npx", ["--yes", EMDASH_GENERATOR, name, "--template", "starter", "--platform", "node", "--pm", "npm", "--no-install", "--yes"], directory);
  if (created.code !== 0) throw new Error(`${EMDASH_GENERATOR} failed:\n${tail(created)}`);
  return path.join(directory, name);
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
  for (const stylesheet of stylesheets) {
    if (!isSafeRelativePath(stylesheet) || !stylesheet.endsWith(".css")) throw new Error(`--stylesheet ${stylesheet} must be a .css path relative to the Design System root`);
  }
  const mcpUrl = siteUrl ? emdashMcpUrl(siteUrl) : null;
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
    const generated = await createSite(staging, { name: slug(path.basename(repoRoot)) });
    const layout = await fs.readFile(path.join(generated, BASE_LAYOUT), "utf8").catch(() => null);
    const packageJson = await readJson(path.join(generated, "package.json"), "the generated package.json");
    if (layout === null || !packageJson) throw new Error(`${EMDASH_GENERATOR} did not produce ${BASE_LAYOUT} and package.json. The EmDash starter template has changed; report it to TimDS.`);
    const patchedLayout = patchBaseLayout(layout, { tokens: system.tokens });
    for (const entry of await fs.readdir(generated)) {
      // The repository holds only .git, .gitmodules, and the submodule so far.
      if (existsSync(path.join(repoRoot, entry))) throw new Error(`${EMDASH_GENERATOR} produced ${entry}, which the new repository already has`);
      await fs.cp(path.join(generated, entry), path.join(repoRoot, entry), { recursive: true });
    }

    await writeFile(path.join(repoRoot, BASE_LAYOUT), patchedLayout);
    written.push(BASE_LAYOUT);
    await writeFile(path.join(repoRoot, THEME_STYLESHEET), renderThemeCss(system));
    written.push(THEME_STYLESHEET);
    if (system.tokens) {
      await writeFile(path.join(repoRoot, TOKEN_MODULE), await template("design-system.ts"));
      written.push(TOKEN_MODULE);
    }

    const seed = String(packageJson.emdash?.seed || "seed/seed.json");
    packageJson.scripts = { ...(packageJson.scripts || {}), seed: packageJson.scripts?.seed || `emdash seed ${seed}` };
    await writeFile(path.join(repoRoot, "package.json"), toJson(packageJson));
    written.push("package.json");

    appName = rootAppName(packageJson.name, path.basename(repoRoot));
    await writeFile(path.join(repoRoot, CONSUMER_MANIFEST_FILE), toJson(emdashConsumerManifest({ appName, systemId: system.systemId })));
    written.push(CONSUMER_MANIFEST_FILE);

    const imports = [
      ...(system.tokens ? [`- \`${TOKEN_MODULE}\` compiles the pinned \`${DESIGN_SYSTEM_PATH}/tokens.json\` to CSS custom properties, by the rule the system's own build uses, and \`${BASE_LAYOUT}\` puts them on every page.`] : []),
      `- \`${THEME_STYLESHEET}\` ${system.stylesheets.length ? `imports ${system.stylesheets.map((stylesheet) => `\`${DESIGN_SYSTEM_PATH}/${stylesheet}\``).join(", ")} from the pin and` : ""} styles the site shell with the system's tokens.`.replace(/\s+/g, " "),
    ].join("\n");
    await writeFile(path.join(repoRoot, "DESIGN_SYSTEM.md"), (await template("DESIGN_SYSTEM.md"))
      .replaceAll("__SYSTEM_ID__", () => system.systemId)
      .replaceAll("__SYSTEM_NAME__", () => system.name)
      .replaceAll("__DESIGN_SYSTEM_PATH__", () => DESIGN_SYSTEM_PATH)
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
  } catch (caught) {
    await discard();
    throw caught;
  } finally {
    await fs.rm(staging, { force: true, recursive: true });
  }

  const adopted = await initializeConsumer(repoRoot, { skipInstall: true, portalUrl });
  written.push(...adopted.written.filter((file) => !written.includes(file)));

  if (!skipInstall) {
    output("Running npm install to write the lockfile...");
    const installed = await run("npm", ["install", "--no-audit", "--no-fund"], repoRoot);
    if (installed.code !== 0) throw new Error(`npm install failed in ${repoRoot}:\n${tail(installed)}\nFix the error and run npm install; the site and the TimDS files are already in place.`);
  }

  const todos = [
    ...(skipInstall ? ["Run npm install and commit package-lock.json; the preview installs with npm ci"] : []),
    ...(system.missing.length ? [`The Design System fills no token for ${system.missing.join(", ")}, so ${THEME_STYLESHEET} leaves ${system.missing.length === 1 ? "that declaration" : "those declarations"} out; add the tokens in the Design System (or map the roles in its timds.json brand.roles), then use them in the theme`] : []),
    "Run npm run dev and open /_emdash/admin to create the first administrator; npm run seed loads the starter's demo content into a fresh local database",
    `Commit everything (the ${DESIGN_SYSTEM_PATH} pin included), create the site's repository, and push; .env holds the local EMDASH_ENCRYPTION_KEY and stays out of git, so set that secret wherever the site is deployed`,
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
    if (["help", "h", "skipInstall"].includes(name)) {
      options[name === "h" ? "help" : name] = true;
      continue;
    }
    if (!["root", "designSystem", "stylesheet", "siteUrl", "portalUrl"].includes(name)) throw new Error(`Unknown option --${rawName}\n${SCAFFOLD_HELP}`);
    const next = inlineValue ?? argv[index + 1];
    if (next === undefined || String(next).startsWith("-")) throw new Error(`--${rawName} requires a value`);
    if (name === "stylesheet") options.stylesheets.push(next);
    else options[name] = next;
    if (inlineValue === undefined) index += 1;
  }
  return { options, positional };
}

/** `timds consumer scaffold emdash --root PATH --design-system GIT_URL [...]` */
export async function runConsumerScaffold(args = [], { output = (message = "") => process.stdout.write(`${message}\n`) } = {}) {
  const { options, positional } = parseScaffoldArguments(args);
  if (options.help || !positional.length) {
    output(SCAFFOLD_HELP);
    return null;
  }
  if (positional.length > 1 || positional[0] !== "emdash") throw new Error(`Unknown site kind ${positional.join(" ")}; timds consumer scaffold creates emdash sites\n${SCAFFOLD_HELP}`);
  return scaffoldEmdashSite(options.root, {
    designSystem: options.designSystem,
    stylesheets: options.stylesheets,
    siteUrl: options.siteUrl,
    skipInstall: Boolean(options.skipInstall),
    ...(options.portalUrl ? { portalUrl: options.portalUrl } : {}),
    output,
  });
}

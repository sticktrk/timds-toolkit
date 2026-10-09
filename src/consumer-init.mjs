// `timds consumer init`: adopt TimDS in a product repository.
//
// A consumer repo is a product that pins a TimDS Design System: as a
// published version (`--system <id>`, the customer path: no repository
// access needed, `npm install` fetches the bundle from the public prefix) or
// as its `design-system` git submodule (the developer path, when the product
// already carries one). Init writes the `timds.consumer.json` skeleton (apps
// discovered one directory down, plus the repository root when its
// package.json has a dev, start, preview, or build script, with guessed
// install, serve, port, and design surface for a developer to confirm),
// selects the toolkit in the root package.json (and, for a published pin,
// `postinstall: timds consumer sync` so the bundle arrives with every
// install), and installs the consumer-managed files:
//
//   .agents/skills/timds-consume-design-system/   the designer-facing skill,
//                                                 product half rendered from
//                                                 the manifest
//   .github/workflows/timds-consumer-preview.yml  the PR preview workflow
//   .github/workflows/timds-designer-change.yml   the zero-setup designer
//                                                 change workflow (OpenAI
//                                                 makes a requested change on
//                                                 a design/ branch)
//   .claude/launch.json                           one entry per crawl-mode app,
//                                                 merged beside existing ones
//   .mcp.json                                     the Design System read MCP
//                                                 server entry, merged beside
//                                                 existing servers
//
// Every managed file's sha256 (and every launch and MCP entry's) is recorded
// under `consumer` in root `.timds/installation.json`, so a rerun or a later
// `timds upgrade` (`upgradeConsumer`, same planning) refreshes files nobody
// edited and refuses customized ones unless forced. `renderConsumerSkill`,
// `consumerManagedFiles`, `consumerLaunchConfigurations`, and
// `consumerMcpServers` are exported for that reuse.
//
// Boundary: init never edits product source, the Design System submodule, or
// an existing manifest (it is kept unless --force regenerates it); upgrade
// never touches the manifest, package.json, or product source at all
// (`upgrade --version` in upgrade.mjs moves the toolkit pin, then calls the
// new CLI's upgrade). The guesses are a starting point; the printed TODO list
// names what a developer confirms.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { CONSUMER_MANIFEST_FILE, consumerPinMode, publishedBaseUrl, validateConsumerManifest } from "./consumer.mjs";
import { resolvePublishedBundle, syncConsumerBundle } from "./consumer-sync.mjs";
import { acceptsToolkitReleaseRange, runtimeIdentity, toolkitReleaseRange } from "./runtime.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const CONSUMER_SKILL_NAME = "timds-consume-design-system";
export const CONSUMER_SKILL_PATH = `.agents/skills/${CONSUMER_SKILL_NAME}`;
export const CONSUMER_WORKFLOW_PATH = ".github/workflows/timds-consumer-preview.yml";
export const CONSUMER_DESIGNER_WORKFLOW_PATH = ".github/workflows/timds-designer-change.yml";
export const CONSUMER_LAUNCH_PATH = ".claude/launch.json";
export const CONSUMER_MCP_PATH = ".mcp.json";
export const CONSUMER_MCP_SERVER_NAME = "timds-design-system-read";
export const CONSUMER_DESIGN_CHANGE_LABEL = "timds-design-change";
export const CONSUMER_INSTALLATION_PATH = ".timds/installation.json";

const DEFAULT_DESIGN_SYSTEM_PATH = "design-system";
const DEFAULT_PORTAL_URL = "https://timds.com";
const DEFAULT_DISCOVER = Object.freeze({ from: ["/"], limit: 40 });
const SURFACE_CANDIDATES = ["src/styles", "src/components", "src/pages", "src/app", "public"];
const SKIPPED_DIRECTORIES = new Set(["node_modules"]);

const INIT_HELP = `Usage:
  timds consumer init [--root PATH] [--force] [--skip-install] [--portal-url URL]
  timds consumer init --system ID [--version VERSION] [--url URL] [--root PATH] [--force] [--skip-install] [--portal-url URL]

Writes timds.consumer.json (apps discovered from package.json files one
directory down, and the root package.json when it has a dev, start, preview,
or build script), selects @dtconcepts/timds in the root package.json, and
installs the consumer skill, the preview and designer-change workflows,
.claude/launch.json entries, and the Design System read MCP server in
.mcp.json (at --portal-url, default ${DEFAULT_PORTAL_URL}). An existing
manifest is kept; --force regenerates it and replaces customized managed
files.

With --system, the product pins the published Design System ID at --version
(default: the current published version; "current" follows every release)
from --url (default: the public prefix for that system). No repository access
is needed: package.json gets postinstall "timds consumer sync", which fetches
the bundle into the gitignored design-system directory, and init runs it
once unless --skip-install. Without --system, the product must already carry
the Design System as the design-system git submodule.`;

const DEFAULT_POSTINSTALL = "timds consumer sync";

// ---------------------------------------------------------------------------
// Small helpers

const sha256 = (content) => createHash("sha256").update(content).digest("hex");

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

async function readText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (caught) {
    if (caught?.code === "ENOENT") return null;
    throw caught;
  }
}

async function readJsonFile(filePath, label) {
  const text = await readText(filePath);
  if (text === null) return null;
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not a JSON object");
    return value;
  } catch (caught) {
    throw new Error(`${label} is not a valid JSON object (${caught.message}); fix or remove it, then rerun timds consumer init`);
  }
}

async function writeFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

const toJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

function slug(value) {
  return String(value || "product").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "product";
}

async function template(name) {
  return fs.readFile(path.join(packageRoot, "templates", name), "utf8");
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

// ---------------------------------------------------------------------------
// Repository facts

async function findGitRoot(start) {
  const resolved = path.resolve(start);
  if (!existsSync(resolved)) throw new Error(`${resolved} does not exist`);
  const result = await run("git", ["rev-parse", "--show-toplevel"], resolved);
  if (result.code !== 0 || !result.stdout.trim()) {
    throw new Error(`${resolved} is not inside a git repository. Run timds consumer init at the root of the product repository.`);
  }
  return fs.realpath(result.stdout.trim());
}

async function gitlinkCommit(repoRoot, designSystemPath) {
  const staged = await run("git", ["ls-files", "--stage", "--", designSystemPath], repoRoot);
  const match = staged.stdout.match(/^160000\s+([0-9a-f]{7,64})\s+\d\t(.+)$/m);
  return match && match[2] === designSystemPath ? match[1] : null;
}

/** The repository's default branch name: origin/HEAD, else main or master, else the current branch. */
export async function consumerDefaultBranch(repoRoot) {
  const symbolic = await run("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], repoRoot);
  if (symbolic.code === 0 && symbolic.stdout.trim()) return symbolic.stdout.trim().replace(/^origin\//, "");
  for (const candidate of ["main", "master"]) {
    const result = await run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`], repoRoot);
    if (result.code === 0) return candidate;
  }
  const current = await run("git", ["branch", "--show-current"], repoRoot);
  return current.stdout.trim() || "main";
}

// ---------------------------------------------------------------------------
// App discovery

function packageManagerFor(appRoot) {
  const has = (file) => existsSync(path.join(appRoot, file));
  // package-lock wins over a stray bun lockfile: the stock workflow sets up Node.
  if (has("package-lock.json")) return { name: "npm", install: ["npm", "ci"], run: (script) => ["npm", "run", script], todo: has("bun.lockb") || has("bun.lock") ? "both package-lock.json and a bun lockfile exist; install uses npm ci" : null };
  if (has("bun.lockb") || has("bun.lock")) return { name: "bun", install: ["bun", "install", "--frozen-lockfile"], run: (script) => ["bun", "run", script], todo: "bun is not set up by the stock preview workflow; add oven-sh/setup-bun or switch install to npm" };
  if (has("pnpm-lock.yaml")) return { name: "pnpm", install: ["pnpm", "install", "--frozen-lockfile"], run: (script) => ["pnpm", "run", script], todo: "pnpm is not set up by the stock preview workflow; add pnpm/action-setup or switch install to npm" };
  if (has("yarn.lock")) return { name: "yarn", install: ["yarn", "install", "--frozen-lockfile"], run: (script) => ["yarn", "run", script], todo: null };
  return { name: "npm", install: ["npm", "install"], run: (script) => ["npm", "run", script], todo: "no lockfile found; install uses npm install, commit a lockfile and switch to npm ci" };
}

function guessPort(packageJson, script) {
  const explicit = String(script || "").match(/(?:--port[ =]|-p\s+)(\d{2,5})\b/);
  if (explicit) return { port: Number(explicit[1]), guessed: false };
  const dependencies = { ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}) };
  const text = String(script || "");
  if (dependencies.astro || /\bastro\b/.test(text)) return { port: 4321, guessed: true, framework: "astro" };
  if (dependencies.next || /\bnext\b/.test(text)) return { port: 3000, guessed: true, framework: "next" };
  if (dependencies.vite || /\bvite\b/.test(text)) return { port: 5173, guessed: true, framework: "vite" };
  return { port: 3000, guessed: true, framework: null };
}

// The scripts that make a package an app: a serve script (dev, start,
// preview) or a build. A root package.json without any of them is the one
// init itself writes for the toolkit, not an app.
const SERVE_SCRIPTS = ["dev", "start", "preview"];
const APP_SCRIPTS = [...SERVE_SCRIPTS, "build"];
const APP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function discoveredApp(appRoot, cwd, packageJson) {
  const manager = packageManagerFor(appRoot);
  const scripts = packageJson.scripts || {};
  const serveScript = SERVE_SCRIPTS.find((script) => scripts[script]);
  const { port, framework } = guessPort(packageJson, serveScript ? scripts[serveScript] : "");
  const surface = SURFACE_CANDIDATES.filter((candidate) => existsSync(path.join(appRoot, candidate))).map((candidate) => `${candidate}/**`);
  const app = {
    cwd,
    install: manager.install,
    preview: {
      serve: manager.run(serveScript || "dev"),
      port,
      ready: "/",
      routes: ["/"],
      discover: structuredClone(DEFAULT_DISCOVER),
      viewports: ["desktop", "phone"],
      schemes: ["light", "dark"],
    },
    designSurface: surface.length ? surface : ["src/styles/**"],
    protected: [],
  };
  const items = [
    `install is ${manager.install.join(" ")}${manager.todo ? ` (${manager.todo})` : ""}`,
    serveScript
      ? `preview.serve is ${manager.run(serveScript).join(" ")} (from the "${serveScript}" script); it must serve the app on a fixed port without opening a browser`
      : "no dev, start, or preview script found; set preview.serve, or switch to static mode with preview.build and preview.output",
    `preview.port is ${port}${framework ? ` (the ${framework} default)` : " (a guess)"}; match what the serve command listens on`,
    "preview.routes lists only \"/\" and preview.discover follows links from it (up to 40 pages); add routes that must always be reviewed, and preview.discover.exclude for pages designers should not see",
    surface.length
      ? `designSurface is ${surface.join(", ")}; trim it to what designers may change`
      : "designSurface is a placeholder (src/styles/**); set the folders designers may change",
    "protected is empty; add server code, data, scripts, and anything inside the design surface that designers must not touch",
  ];
  if (cwd === ".") {
    items.push("this app is the repository root, so its design surface globs are relative to the root; keep them narrow (never the whole repository) so other apps and developer files stay out of designer changes");
  }
  return { app, items };
}

/** An app name for the root package: its package name without a scope, sanitized, else the folder name. */
export function rootAppName(packageName, folderName) {
  const sanitize = (value) => String(value || "")
    .replace(/^@[^/]*\//, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 100)
    .replace(/[^A-Za-z0-9]+$/, "");
  for (const candidate of [sanitize(packageName), sanitize(folderName)]) {
    if (APP_NAME.test(candidate)) return candidate;
  }
  return "app";
}

async function discoverApps(repoRoot, designSystemPath) {
  const entries = await fs.readdir(repoRoot, { withFileTypes: true });
  const nested = {};
  const todos = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) continue;
    if (entry.name === designSystemPath) continue;
    const appRoot = path.join(repoRoot, entry.name);
    const packageJson = await readJsonFile(path.join(appRoot, "package.json"), `${entry.name}/package.json`);
    if (!packageJson) continue;
    const { app, items } = discoveredApp(appRoot, entry.name, packageJson);
    nested[entry.name] = app;
    todos.push({ app: entry.name, items });
  }
  // The repository root is an app too when its package.json can serve or
  // build one; it goes first.
  const rootPackage = await readJsonFile(path.join(repoRoot, "package.json"), "package.json");
  if (!rootPackage || !APP_SCRIPTS.some((script) => rootPackage.scripts?.[script])) return { apps: nested, todos };
  let name = rootAppName(rootPackage.name, path.basename(repoRoot));
  if (Object.hasOwn(nested, name)) name = rootAppName(`${name}-root`, "");
  const { app, items } = discoveredApp(repoRoot, ".", rootPackage);
  return { apps: { [name]: app, ...nested }, todos: [{ app: name, items }, ...todos] };
}

async function designSystemId(repoRoot, designSystemPath) {
  const contract = await readJsonFile(path.join(repoRoot, designSystemPath, "timds.json"), `${designSystemPath}/timds.json`).catch(() => null);
  const id = String(contract?.systemId || "").trim();
  if (id) return { systemId: id, guessed: false };
  return { systemId: `${slug(path.basename(repoRoot))}/core`, guessed: true };
}

async function buildConsumerManifest(repoRoot, designSystemPath, published = null) {
  const { apps, todos } = await discoverApps(repoRoot, designSystemPath);
  if (!Object.keys(apps).length) {
    throw new Error(`No apps found: timds consumer init looks for a package.json one directory below ${repoRoot} (skipping ${designSystemPath}, node_modules, and dot-folders) and for a root package.json with a dev, start, preview, or build script. Write ${CONSUMER_MANIFEST_FILE} by hand from the contract in the TimDS README, then rerun timds consumer init.`);
  }
  const { systemId, guessed } = published ? { systemId: published.systemId, guessed: false } : await designSystemId(repoRoot, designSystemPath);
  const rendered = (await template("timds-consumer.json"))
    .replaceAll("__DESIGN_SYSTEM_PATH__", () => designSystemPath)
    .replaceAll("__SYSTEM_ID__", () => systemId)
    .replace("__APPS__", () => JSON.stringify(apps));
  const manifest = JSON.parse(rendered);
  // A published pin is a manifest field: the version, and the prefix when it is not the default.
  if (published) manifest.designSystem = { ...manifest.designSystem, version: published.version, ...(published.url ? { url: published.url } : {}) };
  validateConsumerManifest(manifest);
  const general = guessed
    ? [`designSystem.systemId is a guess (${systemId}); copy systemId from ${designSystemPath}/timds.json once the submodule is checked out`]
    : [];
  return { manifest, todos, general };
}

// ---------------------------------------------------------------------------
// Rendering

function code(value) {
  return `\`${value}\``;
}

function list(values) {
  return values.map(code).join(", ");
}

function appSection(name, app) {
  const cwd = app.cwd === "." ? "repository root" : `${code(`${app.cwd}/`)}`;
  const preview = app.preview;
  const lines = [`### ${code(name)}`, ""];
  lines.push(`- Folder: ${cwd}. Paths below are relative to it; run its commands there.`);
  if (app.install) lines.push(`- Install: ${code(app.install.join(" "))}.`);
  if (preview.serve) {
    lines.push(`- Run locally: the ${code(name)} entry in ${code(CONSUMER_LAUNCH_PATH)} (${code(preview.serve.join(" "))}), then open http://localhost:${preview.port}${preview.ready || "/"}.`);
  } else {
    lines.push(`- Run locally: build with ${code(preview.build.join(" "))} (output in ${code(`${preview.output}/`)}), or from repository root run ${code(`npm run timds -- consumer preview --app ${name}`)} and open ${code(`.timds/preview/${name}/index.html`)}.`);
  }
  if (preview.routes?.length) lines.push(`- Review routes: ${list(preview.routes)}.`);
  const designs = Object.entries(preview.designs || {});
  if (designs.length) lines.push(`- Designs to match: ${designs.map(([route, reference]) => `${code(route)} matches ${code(reference)}`).join(", ")}. The preview shows each design beside its route; read it with ${code("read_design")} or under ${code(`${app.cwd === "." ? "" : "../"}design-system/dist/designs/`)} after the pin is built.`);
  lines.push(`- Review at: ${list(preview.viewports)} widths; ${list(preview.schemes)} schemes.`);
  lines.push(`- Design surface (may change): ${list(app.designSurface)}.`);
  lines.push(app.protected.length
    ? `- Protected (never change, even inside the surface): ${list(app.protected)}.`
    : "- Protected: nothing beyond the rule that everything outside the design surface is off limits.");
  return lines.join("\n");
}

/** The skill paragraphs that differ by pin mode: how the system arrives and what must never be touched. */
function pinSections(designSystem) {
  const dsPath = designSystem.path;
  if (consumerPinMode(designSystem) === "published") {
    const pin = designSystem.version === "current" ? "the current published version" : `version ${designSystem.version}`;
    return {
      __PIN_SETUP__: `Run \`npm ci\` at repository root; its \`postinstall\` fetches the pinned\n   Design System bundle (${pin}) into \`${dsPath}/\`. If that directory is\n   empty, run \`npm run timds -- consumer sync\`.`,
      __PIN_RULES__: `- \`${dsPath}/\` holds the published bundle of \`__SYSTEM_ID__\` at the version\n  \`timds.consumer.json\` pins, fetched by \`npm install\` and ignored by git.\n  Never edit, commit, or add files under it, and never change\n  \`designSystem.version\`. Moving the pin is a separate developer decision\n  (\`timds consumer update\`).\n- Never copy Design System stylesheets, fonts, or images into the product.\n  Reference what the app already loads from \`${dsPath}/\`.`,
      __DERIVED_LAYER__: `- The published system is one URL away: the \`describe_system\` tool names\n  it, and \`${dsPath}/.timds-bundle.json\` records the version and files that\n  were fetched. Read \`llms.txt\` at the published prefix for the brand\n  essentials (colors, fonts and where to get them, logos, asset formats),\n  \`brand.json\` and \`tokens.json\` beside it for the details. These are\n  published output: read them, never edit them.`,
    };
  }
  return {
    __PIN_SETUP__: `Run \`git submodule update --init ${dsPath}\` so the checkout\n   matches the pin, then \`npm ci\` at repository root.`,
    __PIN_RULES__: `- \`${dsPath}/\` is a git submodule at the exact commit this\n  product was reviewed against. Never \`git pull\`, switch, or commit inside it,\n  and never stage a new pin. Moving the pin is a separate developer decision.\n- Never copy Design System source, stylesheets, fonts, or images into the\n  product. Reference what the app already imports from the submodule.`,
    __DERIVED_LAYER__: `- After \`npm --prefix ${dsPath} ci\` and\n  \`npm --prefix ${dsPath} run timds -- check\`, the derived layer\n  sits beside the built entry page under \`${dsPath}/dist/\`\n  (usually \`dist/design-system/\`): \`brand.json\` (brand roles, each font\n  role with its family and the files or service that provide it, logos,\n  imagery), \`tokens.json\` (resolved CSS custom properties by scope),\n  \`formats.json\` (the asset format catalog, when the system keeps one),\n  \`llms.txt\` (the brand essentials and the page directory), \`llms-full.txt\`,\n  and a Markdown mirror of every guidance page. These are build output: read\n  them, never edit or commit them.`,
  };
}

/**
 * The managed SKILL.md for a consumer manifest. Generic guidance is static;
 * the pin sections follow the manifest's mode (published bundle or git
 * submodule), and `__APPS__` becomes one section per app.
 * `options.defaultBranch` names the pull-request base (default `main`).
 */
export async function renderConsumerSkill(manifest, options = {}) {
  const validated = validateConsumerManifest(manifest);
  const source = await fs.readFile(path.join(packageRoot, "skills", CONSUMER_SKILL_NAME, "SKILL.md"), "utf8");
  const apps = Object.entries(validated.apps).map(([name, app]) => appSection(name, app)).join("\n\n");
  let text = source;
  for (const [placeholder, replacement] of Object.entries(pinSections(validated.designSystem))) text = text.replace(placeholder, () => replacement);
  return text
    .replaceAll("__SYSTEM_ID__", () => validated.designSystem.systemId)
    .replaceAll("__DESIGN_SYSTEM_PATH__", () => validated.designSystem.path)
    .replaceAll("__DEFAULT_BRANCH__", () => options.defaultBranch || "main")
    .replace("__APPS__", () => apps);
}

/** `.claude/launch.json` configurations for every crawl-mode app with a serve command. */
export async function consumerLaunchConfigurations(manifest) {
  const validated = validateConsumerManifest(manifest);
  const source = await template("consumer-launch.json");
  return Object.entries(validated.apps)
    .filter(([, app]) => app.preview.serve)
    .map(([name, app]) => JSON.parse(source
      .replace("__LAUNCH_NAME__", () => name.replace(/["\\]/g, ""))
      .replace("__RUNTIME_EXECUTABLE__", () => app.preview.serve[0].replace(/["\\]/g, ""))
      .replace("__RUNTIME_ARGS__", () => JSON.stringify(app.preview.serve.slice(1)))
      .replace("__CWD__", () => app.cwd.replace(/["\\]/g, ""))
      .replace("__PORT__", () => String(app.preview.port))));
}

/**
 * Every whole file TimDS manages in a consumer repo for this manifest, as
 * `[{ path, content }]` with repo-relative POSIX paths. `.claude/launch.json`
 * is merged, not owned, so it is not listed (see consumerLaunchConfigurations).
 */
export async function consumerManagedFiles(manifest, options = {}) {
  const files = [{ path: `${CONSUMER_SKILL_PATH}/SKILL.md`, content: await renderConsumerSkill(manifest, options) }];
  const skillRoot = path.join(packageRoot, "skills", CONSUMER_SKILL_NAME);
  const walk = async (directory) => {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && absolute !== path.join(skillRoot, "SKILL.md")) {
        files.push({ path: `${CONSUMER_SKILL_PATH}/${path.relative(skillRoot, absolute).split(path.sep).join("/")}`, content: await fs.readFile(absolute, "utf8") });
      }
    }
  };
  await walk(skillRoot);
  files.push({ path: CONSUMER_WORKFLOW_PATH, content: await template("timds-consumer-preview.yml") });
  files.push({ path: CONSUMER_DESIGNER_WORKFLOW_PATH, content: await template("timds-designer-change.yml") });
  return files;
}

/**
 * `.mcp.json` servers TimDS manages, keyed by name: the Design System read
 * tools over HTTP at the portal, authorized with TIMDS_ACCESS_TOKEN from the
 * environment (never a literal token).
 */
export function consumerMcpServers({ portalUrl = DEFAULT_PORTAL_URL } = {}) {
  let base;
  try {
    base = new URL(String(portalUrl));
  } catch {
    throw new Error(`--portal-url ${portalUrl} is not a valid URL`);
  }
  if (!["http:", "https:"].includes(base.protocol)) throw new Error("--portal-url must use HTTP or HTTPS");
  return {
    [CONSUMER_MCP_SERVER_NAME]: {
      type: "http",
      url: new URL("/api/timds/mcp/read", `${base.origin}/`).toString(),
      headers: { Authorization: "Bearer ${TIMDS_ACCESS_TOKEN}" },
    },
  };
}

// ---------------------------------------------------------------------------
// Planning (all refusals happen before anything is written)

// Every managed file is "unchanged" (already the desired bytes), "created",
// "refreshed" (the on-disk sha256 matches the recorded one, or `force`), or
// "refused" (customized since TimDS wrote it). Callers refuse on any conflict.
async function planManagedFiles(repoRoot, files, recorded, force) {
  const writes = [];
  const conflicts = [];
  const statuses = [];
  for (const file of files) {
    const current = await readText(path.join(repoRoot, file.path));
    if (current === file.content) {
      statuses.push({ path: file.path, status: "unchanged" });
      continue;
    }
    if (current !== null && !force && sha256(current) !== recorded[file.path]) {
      conflicts.push(file.path);
      statuses.push({ path: file.path, status: "refused" });
      continue;
    }
    writes.push(file);
    statuses.push({ path: file.path, status: current === null ? "created" : "refreshed" });
  }
  return { writes, conflicts, statuses };
}

function refuseCustomizedFiles(conflicts, rerun) {
  if (!conflicts.length) return;
  throw new Error(`Refusing to replace customized TimDS consumer files:\n${conflicts.map((file) => `- ${file}`).join("\n")}\nReview them, or rerun ${rerun} with --force to replace them`);
}

async function planPackageJson(repoRoot, force, { published = false, command = "timds consumer init" } = {}) {
  const packagePath = path.join(repoRoot, "package.json");
  const existing = await readJsonFile(packagePath, "package.json");
  const packageJson = existing ? structuredClone(existing) : { name: slug(path.basename(repoRoot)), private: true };
  const identity = runtimeIdentity;
  const releaseRange = toolkitReleaseRange(identity);
  const current = packageJson.devDependencies?.[identity.name] ?? packageJson.dependencies?.[identity.name];
  if (current && !acceptsToolkitReleaseRange(current, identity) && !force) {
    throw new Error(`package.json already declares ${identity.name} as ${current}; rerun ${command} with --force to select ${releaseRange}`);
  }
  if (packageJson.scripts?.timds && packageJson.scripts.timds !== "timds" && !force) {
    throw new Error(`package.json scripts.timds is already ${JSON.stringify(packageJson.scripts.timds)}; rerun ${command} with --force to replace it`);
  }
  if (packageJson.dependencies?.[identity.name]) {
    delete packageJson.dependencies[identity.name];
    if (!Object.keys(packageJson.dependencies).length) delete packageJson.dependencies;
  }
  const selected = current && acceptsToolkitReleaseRange(current, identity) ? current : releaseRange;
  packageJson.scripts = { ...(packageJson.scripts || {}), timds: "timds" };
  if (published) {
    // The bundle arrives with every install. An existing postinstall keeps
    // running after the sync rather than being replaced.
    const postinstall = String(packageJson.scripts.postinstall || "").trim();
    if (!postinstall) packageJson.scripts.postinstall = DEFAULT_POSTINSTALL;
    else if (!postinstall.includes(DEFAULT_POSTINSTALL)) packageJson.scripts.postinstall = `${DEFAULT_POSTINSTALL} && ${postinstall}`;
  }
  packageJson.devDependencies = { ...(packageJson.devDependencies || {}), [identity.name]: selected };
  const content = toJson(packageJson);
  return { packagePath, content, changed: !existing || toJson(existing) !== content, created: !existing };
}

async function planLaunch(repoRoot, desired, recorded, force) {
  const launchPath = path.join(repoRoot, CONSUMER_LAUNCH_PATH);
  const existing = await readJsonFile(launchPath, CONSUMER_LAUNCH_PATH);
  const launch = existing ? structuredClone(existing) : { version: "0.0.1", configurations: [] };
  if (!Array.isArray(launch.configurations)) {
    throw new Error(`${CONSUMER_LAUNCH_PATH} has no configurations array; fix it, then rerun timds consumer init`);
  }
  const kept = [];
  const managed = {};
  const statuses = [];
  for (const entry of desired) {
    managed[entry.name] = sha256(JSON.stringify(entry));
    const index = launch.configurations.findIndex((configuration) => configuration?.name === entry.name);
    if (index === -1) {
      launch.configurations.push(entry);
      statuses.push({ name: entry.name, status: "created" });
      continue;
    }
    const current = launch.configurations[index];
    if (sameJson(current, entry)) {
      statuses.push({ name: entry.name, status: "unchanged" });
      continue;
    }
    if (force || sha256(JSON.stringify(current)) === recorded[entry.name]) {
      launch.configurations[index] = entry;
      statuses.push({ name: entry.name, status: "refreshed" });
      continue;
    }
    kept.push(entry.name);
    statuses.push({ name: entry.name, status: "refused" });
    managed[entry.name] = recorded[entry.name] ?? null;
    if (managed[entry.name] === null) delete managed[entry.name];
  }
  const content = toJson(launch);
  const changed = !existing || toJson(existing) !== content;
  return { launchPath, content, changed, kept, managed, statuses };
}

async function planMcp(repoRoot, desired, recorded, force) {
  const mcpPath = path.join(repoRoot, CONSUMER_MCP_PATH);
  const existing = await readJsonFile(mcpPath, CONSUMER_MCP_PATH);
  const config = existing ? structuredClone(existing) : { mcpServers: {} };
  if (config.mcpServers === undefined) config.mcpServers = {};
  if (!config.mcpServers || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers)) {
    throw new Error(`${CONSUMER_MCP_PATH} has an mcpServers value that is not an object; fix it, then rerun timds consumer init`);
  }
  const kept = [];
  const managed = {};
  const statuses = [];
  for (const [name, entry] of Object.entries(desired)) {
    managed[name] = sha256(JSON.stringify(entry));
    if (!Object.hasOwn(config.mcpServers, name)) {
      config.mcpServers[name] = entry;
      statuses.push({ name, status: "created" });
      continue;
    }
    const current = config.mcpServers[name];
    if (sameJson(current, entry)) {
      statuses.push({ name, status: "unchanged" });
      continue;
    }
    if (force || sha256(JSON.stringify(current)) === recorded[name]) {
      config.mcpServers[name] = entry;
      statuses.push({ name, status: "refreshed" });
      continue;
    }
    kept.push(name);
    statuses.push({ name, status: "refused" });
    managed[name] = recorded[name] ?? null;
    if (managed[name] === null) delete managed[name];
  }
  const content = toJson(config);
  const changed = !existing || toJson(existing) !== content;
  return { mcpPath, content, changed, kept, managed, statuses };
}

async function planGitignoreLines(repoRoot, lines) {
  const gitignorePath = path.join(repoRoot, ".gitignore");
  const existing = (await readText(gitignorePath)) ?? "";
  const present = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const missing = lines.filter((line) => !present.has(line));
  if (!missing.length) return null;
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  return { path: ".gitignore", content: `${existing}${prefix}${missing.join("\n")}\n` };
}

/**
 * Plan every consumer-managed file and entry for `manifest` against the
 * record of the previous installation. Shared by init and upgrade so both
 * apply the same rules; nothing is written here.
 */
async function planConsumerManagedState(repoRoot, manifest, previous, { defaultBranch, force, portalUrl }) {
  const files = await consumerManagedFiles(manifest, { defaultBranch });
  const filePlan = await planManagedFiles(repoRoot, files, previous.managedFiles || {}, force);
  const launchPlan = await planLaunch(repoRoot, await consumerLaunchConfigurations(manifest), previous.launchConfigurations || {}, force);
  const mcpPlan = await planMcp(repoRoot, consumerMcpServers({ portalUrl }), previous.mcpServers || {}, force);
  return { files, filePlan, launchPlan, mcpPlan };
}

function consumerInstallationRecord(files, launchPlan, mcpPlan) {
  return {
    name: runtimeIdentity.name,
    schemaVersion: 1,
    version: runtimeIdentity.version,
    managedFiles: Object.fromEntries(files.map((file) => [file.path, sha256(file.content)])),
    launchConfigurations: launchPlan.managed,
    mcpServers: mcpPlan.managed,
  };
}

/**
 * Plan init's installation against a supplied manifest without regenerating
 * it or requiring its pin to be in the index yet. Migration uses this before
 * removing the submodule; force applies only to the installation's files.
 */
export async function planConsumerInstallation(repoRoot, manifest, { force = false, portalUrl = null, command = "timds consumer init" } = {}) {
  const validated = validateConsumerManifest(manifest);
  const installationPath = path.join(repoRoot, CONSUMER_INSTALLATION_PATH);
  const installation = (await readJsonFile(installationPath, CONSUMER_INSTALLATION_PATH)) ?? {};
  const previous = installation.consumer && typeof installation.consumer === "object" ? installation.consumer : {};
  const defaultBranch = await consumerDefaultBranch(repoRoot);
  const { files, filePlan, launchPlan, mcpPlan } = await planConsumerManagedState(repoRoot, validated, previous, {
    defaultBranch, force, portalUrl: portalUrl ?? await installedPortalUrl(repoRoot),
  });
  refuseCustomizedFiles(filePlan.conflicts, command);
  const published = consumerPinMode(validated.designSystem) === "published";
  const packagePlan = await planPackageJson(repoRoot, force, { published, command });
  const gitignorePlan = await planGitignoreLines(repoRoot, ["node_modules/", ".timds/preview/", ...(published ? [`${validated.designSystem.path}/`] : [])]);
  installation.consumer = consumerInstallationRecord(files, launchPlan, mcpPlan);
  const writes = [
    ...filePlan.writes,
    ...(packagePlan.changed ? [{ path: "package.json", content: packagePlan.content }] : []),
    ...(launchPlan.changed ? [{ path: CONSUMER_LAUNCH_PATH, content: launchPlan.content }] : []),
    ...(mcpPlan.changed ? [{ path: CONSUMER_MCP_PATH, content: mcpPlan.content }] : []),
    ...(gitignorePlan ? [gitignorePlan] : []),
    { path: CONSUMER_INSTALLATION_PATH, content: toJson(installation) },
  ];
  return { writes, defaultBranch, launchPlan, mcpPlan, packagePlan, installation: installation.consumer };
}

/** Apply the already validated installation plan; never writes the manifest. */
export async function applyConsumerInstallation(repoRoot, plan) {
  for (const file of plan.writes) await writeFile(path.join(repoRoot, file.path), file.content);
  return plan.writes.map((file) => file.path);
}

// ---------------------------------------------------------------------------
// Init

/**
 * The published pin init resolves from `--system`: the version named, or the
 * current published version read from the prefix; `url` only when it is not
 * the default for the system, so the manifest stays minimal.
 */
async function resolvePublishedPin({ system, version, url, fetchImpl }) {
  const systemId = String(system).trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{1,159}$/.test(systemId)) throw new Error(`--system ${system} must be a Design System id such as client/core`);
  const base = url ? String(url).replace(/\/+$/, "") : publishedBaseUrl({ systemId });
  let pinned = version ? String(version).trim() : null;
  if (!pinned) {
    try {
      pinned = (await resolvePublishedBundle({ url: base, version: "current", fetchImpl })).version;
    } catch (error) {
      throw new Error(`Could not read the current published version of ${systemId} at ${base}: ${error.message}\nPass --version to pin one explicitly.`);
    }
  }
  return { systemId, version: pinned, url: url ? base : null };
}

/**
 * Initialize a consumer repository. Returns what was written; refuses (before
 * writing anything) without a design-system gitlink or a `--system` to pin,
 * on a conflicting toolkit declaration, or on customized managed files
 * unless `force`.
 */
export async function initializeConsumer(rootInput = process.cwd(), { force = false, skipInstall = false, portalUrl = DEFAULT_PORTAL_URL, system = null, version = null, url = null, fetchImpl = fetch, output = () => {} } = {}) {
  const repoRoot = await findGitRoot(rootInput);
  const manifestPath = path.join(repoRoot, CONSUMER_MANIFEST_FILE);
  const existingRaw = await readJsonFile(manifestPath, CONSUMER_MANIFEST_FILE);
  const keepManifest = Boolean(existingRaw) && !force;
  const existing = keepManifest ? validateConsumerManifest(existingRaw) : null;
  const designSystemPath = existing ? existing.designSystem.path : DEFAULT_DESIGN_SYSTEM_PATH;

  // Published mode: asked for with --system, or already declared by the kept manifest.
  const published = system
    ? await resolvePublishedPin({ system, version, url, fetchImpl })
    : existing && consumerPinMode(existing.designSystem) === "published" ? { systemId: existing.designSystem.systemId, version: existing.designSystem.version, url: existing.designSystem.url ?? null } : null;
  if (!published && !(await gitlinkCommit(repoRoot, designSystemPath))) {
    throw new Error(`${repoRoot} has no ${designSystemPath} submodule. A TimDS consumer pins its Design System either as a published version:\n  timds consumer init --system <system id>\nor as a git submodule:\n  git submodule add <design-system repository URL> ${designSystemPath}\nthen commit the pin and rerun timds consumer init.`);
  }
  if (published && (await gitlinkCommit(repoRoot, designSystemPath))) {
    throw new Error(`${repoRoot} still carries ${designSystemPath} as a git submodule. Remove it before pinning a published version:\n  git rm -r --cached ${designSystemPath} && rm -rf ${designSystemPath} .git/modules/${designSystemPath}\nand drop its entry from .gitmodules.`);
  }

  let manifest = existingRaw;
  let todos = [];
  let general = [];
  if (!keepManifest) ({ manifest, todos, general } = await buildConsumerManifest(repoRoot, designSystemPath, published));

  const plan = await planConsumerInstallation(repoRoot, manifest, { force, portalUrl });
  const { defaultBranch, launchPlan, mcpPlan, packagePlan } = plan;

  const written = [];
  if (!keepManifest) {
    await writeFile(manifestPath, toJson(manifest));
    written.push(CONSUMER_MANIFEST_FILE);
  }
  written.push(...await applyConsumerInstallation(repoRoot, plan));

  output(keepManifest
    ? `Kept the existing ${CONSUMER_MANIFEST_FILE}; rerun with --force to regenerate it from the app folders.`
    : `Wrote ${CONSUMER_MANIFEST_FILE} for ${Object.keys(manifest.apps).join(", ")}.`);
  for (const file of written) output(`  ${file}`);
  for (const name of launchPlan.kept) {
    output(`Kept the customized "${name}" entry in ${CONSUMER_LAUNCH_PATH}; rerun with --force to replace it.`);
  }
  for (const name of mcpPlan.kept) {
    output(`Kept the customized "${name}" server in ${CONSUMER_MCP_PATH}; rerun with --force to replace it.`);
  }

  if (!skipInstall && packagePlan.changed) {
    output("Running npm install to resolve @dtconcepts/timds into the lockfile...");
    const installed = await run("npm", ["install"], repoRoot);
    if (installed.code !== 0) {
      throw new Error(`npm install failed in ${repoRoot}:\n${(installed.stderr || installed.stdout).trim().split("\n").slice(-20).join("\n")}\nFix the error and run npm install; the TimDS files are already in place.`);
    }
  }
  // The first sync happens here rather than through npm's postinstall, so a
  // failure names the cause instead of surfacing as a failed install.
  let synced = null;
  if (published && !skipInstall) synced = await syncConsumerBundle(repoRoot, { fetchImpl, output });

  const checklist = [
    ...general,
    ...todos.flatMap(({ app, items }) => items.map((item) => `${app}: ${item}`)),
    ...(published
      ? [
        `${designSystemPath}/ is the published bundle of ${published.systemId} at ${published.version === "current" ? "the current release" : `version ${published.version}`}, fetched by npm install (postinstall) and ignored by git; never commit it. Move the pin with npm run timds -- consumer update [VERSION]`,
        ...(skipInstall ? [`Run npm install (or npm run timds -- consumer sync) to fetch the bundle into ${designSystemPath}/`] : []),
      ]
      : []),
    "Automatic previews are off by default; to enable them, set the TIMDS_PREVIEWS_ENABLED repository variable to true and add the TIMDS_ACCESS_TOKEN repository secret",
    ...(published
      ? []
      : ["For previews or designer changes: add DESIGN_SYSTEM_DEPLOY_KEY (read-only deploy key on the Design System repository) or TIMDS_CONSUMER_SUBMODULE_TOKEN (contents:read on it) so CI can check out the private submodule"]),
    "For designer changes: add the OPENAI_API_KEY repository or organization secret so the designer-change workflow can run Codex through the OpenAI API",
    `For designer changes: create the ${CONSUMER_DESIGN_CHANGE_LABEL} label, set the TIMDS_DESIGNER_BOTS repository variable to the TimDS portal's GitHub App bot login (comma-separated if more than one), and allow GitHub Actions to create pull requests (Settings > Actions > General)`,
    `${CONSUMER_MCP_PATH} reads the Design System through the portal with TIMDS_ACCESS_TOKEN from the environment; export it locally to use the ${CONSUMER_MCP_SERVER_NAME} tools`,
    `After editing ${CONSUMER_MANIFEST_FILE}, rerun timds consumer init so the skill's product section and the launch entries match it`,
    `Commit ${CONSUMER_MANIFEST_FILE}, package.json, the lockfile, and the managed files; then run npm run timds -- consumer check`,
  ];
  output("");
  output("For the developer to confirm:");
  for (const item of checklist) output(`- ${item}`);

  return {
    repoRoot,
    manifestPath,
    manifest,
    keptManifest: keepManifest,
    defaultBranch,
    written,
    todos: checklist,
    keptLaunchConfigurations: launchPlan.kept,
    keptMcpServers: mcpPlan.kept,
    installation: plan.installation,
    published,
    synced,
  };
}

// ---------------------------------------------------------------------------
// Upgrade

/** The portal origin the managed read MCP server points at today (default when absent or unreadable). */
async function installedPortalUrl(repoRoot) {
  const config = await readJsonFile(path.join(repoRoot, CONSUMER_MCP_PATH), CONSUMER_MCP_PATH);
  const url = config?.mcpServers?.[CONSUMER_MCP_SERVER_NAME]?.url;
  try {
    const parsed = new URL(String(url));
    if (["http:", "https:"].includes(parsed.protocol)) return parsed.origin;
  } catch {
    // Fall through to the default portal.
  }
  return DEFAULT_PORTAL_URL;
}

/**
 * `timds upgrade` in a consumer repository: refresh every consumer-managed
 * file and entry with this toolkit's templates, by the rules init applies
 * (identical: unchanged; recorded hash matches: refreshed; customized: refused
 * unless `force`, launch and MCP entries kept), then rewrite
 * `installation.consumer`. A file a previous release managed and this one no
 * longer ships is removed when unmodified. Never regenerates
 * `timds.consumer.json`, never edits package.json or product source, and never
 * runs an install (`upgrade --version` in upgrade.mjs does that, then calls
 * the newly installed CLI, which lands here).
 */
export async function upgradeConsumer(rootInput = process.cwd(), { force = false, output = () => {} } = {}) {
  const repoRoot = await findGitRoot(rootInput);
  const manifest = await readJsonFile(path.join(repoRoot, CONSUMER_MANIFEST_FILE), CONSUMER_MANIFEST_FILE);
  if (!manifest) throw new Error(`No ${CONSUMER_MANIFEST_FILE} at ${repoRoot}. Run timds consumer init to adopt TimDS in this product repository.`);
  validateConsumerManifest(manifest);
  const installationPath = path.join(repoRoot, CONSUMER_INSTALLATION_PATH);
  const installation = (await readJsonFile(installationPath, CONSUMER_INSTALLATION_PATH)) ?? {};
  const previous = installation.consumer;
  if (!previous || typeof previous !== "object" || Array.isArray(previous)) {
    throw new Error(`${repoRoot} has no TimDS consumer installation record (consumer in ${CONSUMER_INSTALLATION_PATH}). Run timds consumer init first; upgrade only refreshes the files init installed.`);
  }
  const defaultBranch = await consumerDefaultBranch(repoRoot);
  const portalUrl = await installedPortalUrl(repoRoot);
  const { files, filePlan, launchPlan, mcpPlan } = await planConsumerManagedState(repoRoot, manifest, previous, { defaultBranch, force, portalUrl });
  refuseCustomizedFiles(filePlan.conflicts, "timds upgrade");

  const shipped = new Set(files.map((file) => file.path));
  const retired = [];
  for (const [relative, recordedHash] of Object.entries(previous.managedFiles || {})) {
    // Only paths inside the consumer-managed boundary are ever removed.
    const managedPath = relative.startsWith(`${CONSUMER_SKILL_PATH}/`) || relative.startsWith(".github/workflows/timds-");
    if (shipped.has(relative) || !managedPath || relative.split("/").includes("..")) continue;
    const current = await readText(path.join(repoRoot, relative));
    if (current === null) continue;
    retired.push({ path: relative, status: force || sha256(current) === recordedHash ? "removed" : "kept" });
  }

  for (const file of filePlan.writes) await writeFile(path.join(repoRoot, file.path), file.content);
  for (const file of retired.filter((entry) => entry.status === "removed")) await fs.rm(path.join(repoRoot, file.path), { force: true });
  if (launchPlan.changed) await writeFile(launchPlan.launchPath, launchPlan.content);
  if (mcpPlan.changed) await writeFile(mcpPlan.mcpPath, mcpPlan.content);
  installation.consumer = consumerInstallationRecord(files, launchPlan, mcpPlan);
  await writeFile(installationPath, toJson(installation));

  const previousVersion = typeof previous.version === "string" ? previous.version : "unknown";
  output(`TimDS consumer files upgraded for ${repoRoot}`);
  output(`Toolkit: ${previousVersion} -> ${runtimeIdentity.version}`);
  for (const { path: relative, status } of filePlan.statuses) output(`  ${status.padEnd(9)} ${relative}`);
  for (const { path: relative, status } of retired) {
    output(status === "removed"
      ? `  removed   ${relative} (no longer shipped by TimDS)`
      : `  kept      ${relative} (no longer shipped by TimDS, customized; delete it when it is no longer needed)`);
  }
  for (const { name, status } of launchPlan.statuses) {
    output(`  ${status.padEnd(9)} ${CONSUMER_LAUNCH_PATH} entry "${name}"${status === "refused" ? " (customized; rerun timds upgrade --force to replace it)" : ""}`);
  }
  for (const { name, status } of mcpPlan.statuses) {
    output(`  ${status.padEnd(9)} ${CONSUMER_MCP_PATH} server "${name}"${status === "refused" ? " (customized; rerun timds upgrade --force to replace it)" : ""}`);
  }
  output(`Review the diff, then commit the managed files and ${CONSUMER_INSTALLATION_PATH}.`);

  return {
    repoRoot,
    previousVersion,
    version: runtimeIdentity.version,
    files: [...filePlan.statuses, ...retired],
    launchConfigurations: launchPlan.statuses,
    mcpServers: mcpPlan.statuses,
    installation: installation.consumer,
  };
}

function parseInitArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("-")) throw new Error(`Unexpected argument ${value}\n${INIT_HELP}`);
    const [rawName, inlineValue] = value.replace(/^--?/, "").split("=", 2);
    const name = rawName.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    if (["force", "help", "skipInstall"].includes(name)) {
      options[name] = true;
      continue;
    }
    if (!["root", "portalUrl", "system", "version", "url"].includes(name)) throw new Error(`Unknown option --${rawName}\n${INIT_HELP}`);
    const next = inlineValue ?? argv[index + 1];
    if (next === undefined || String(next).startsWith("-")) throw new Error(`--${rawName} requires a value`);
    options[name] = next;
    if (inlineValue === undefined) index += 1;
  }
  if ((options.version || options.url) && !options.system) throw new Error(`--version and --url apply with --system\n${INIT_HELP}`);
  return options;
}

/** `timds consumer init [--root PATH] [--system ID] [--version VERSION] [--url URL] [--force] [--skip-install] [--portal-url URL]` */
export async function runConsumerInit(args = [], { output = (message = "") => process.stdout.write(`${message}\n`) } = {}) {
  const options = parseInitArguments(args);
  if (options.help) {
    output(INIT_HELP);
    return null;
  }
  return initializeConsumer(options.root || process.cwd(), {
    force: Boolean(options.force),
    skipInstall: Boolean(options.skipInstall),
    ...(options.portalUrl ? { portalUrl: options.portalUrl } : {}),
    ...(options.system ? { system: options.system } : {}),
    ...(options.version ? { version: options.version } : {}),
    ...(options.url ? { url: options.url } : {}),
    output,
  });
}

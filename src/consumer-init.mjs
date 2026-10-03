// `timds consumer init`: adopt TimDS in a product repository.
//
// A consumer repo is a product that pins a TimDS Design System as its
// `design-system` git submodule. Init writes the `timds.consumer.json`
// skeleton (apps discovered one directory down, with guessed install, serve,
// port, and design surface for a developer to confirm), selects the toolkit
// in the root package.json, and installs the consumer-managed files:
//
//   .agents/skills/timds-consume-design-system/   the designer-facing skill,
//                                                 product half rendered from
//                                                 the manifest
//   .github/workflows/timds-consumer-preview.yml  the PR preview workflow
//   .claude/launch.json                           one entry per crawl-mode app,
//                                                 merged beside existing ones
//
// Every managed file's sha256 (and every launch entry's) is recorded under
// `consumer` in root `.timds/installation.json`, so a rerun or a later
// `upgrade` refreshes files nobody edited and refuses customized ones unless
// forced. `renderConsumerSkill`, `consumerManagedFiles`, and
// `consumerLaunchConfigurations` are exported for that reuse.
//
// Boundary: init never edits product source, the Design System submodule, or
// an existing manifest (it is kept unless --force regenerates it). The guesses
// are a starting point; the printed TODO list names what a developer confirms.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { CONSUMER_MANIFEST_FILE, validateConsumerManifest } from "./consumer.mjs";
import { acceptsToolkitReleaseRange, runtimeIdentity, toolkitReleaseRange } from "./runtime.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const CONSUMER_SKILL_NAME = "timds-consume-design-system";
export const CONSUMER_SKILL_PATH = `.agents/skills/${CONSUMER_SKILL_NAME}`;
export const CONSUMER_WORKFLOW_PATH = ".github/workflows/timds-consumer-preview.yml";
export const CONSUMER_LAUNCH_PATH = ".claude/launch.json";
export const CONSUMER_INSTALLATION_PATH = ".timds/installation.json";

const DEFAULT_DESIGN_SYSTEM_PATH = "design-system";
const SURFACE_CANDIDATES = ["src/styles", "src/components", "src/pages", "src/app", "public"];
const SKIPPED_DIRECTORIES = new Set(["node_modules"]);

const INIT_HELP = `Usage:
  timds consumer init [--root PATH] [--force] [--skip-install]

Writes timds.consumer.json (apps discovered from package.json files one
directory down), selects @dtconcepts/timds in the root package.json, and
installs the consumer skill, the preview workflow, and .claude/launch.json
entries. An existing manifest is kept; --force regenerates it and replaces
customized managed files.`;

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

async function discoverApps(repoRoot, designSystemPath) {
  const entries = await fs.readdir(repoRoot, { withFileTypes: true });
  const apps = {};
  const todos = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) continue;
    if (entry.name === designSystemPath) continue;
    const appRoot = path.join(repoRoot, entry.name);
    const packageJson = await readJsonFile(path.join(appRoot, "package.json"), `${entry.name}/package.json`);
    if (!packageJson) continue;
    const name = entry.name;
    const manager = packageManagerFor(appRoot);
    const scripts = packageJson.scripts || {};
    const serveScript = ["dev", "start", "preview"].find((script) => scripts[script]);
    const { port, framework } = guessPort(packageJson, serveScript ? scripts[serveScript] : "");
    const surface = SURFACE_CANDIDATES.filter((candidate) => existsSync(path.join(appRoot, candidate))).map((candidate) => `${candidate}/**`);
    apps[name] = {
      cwd: name,
      install: manager.install,
      preview: {
        serve: manager.run(serveScript || "dev"),
        port,
        ready: "/",
        routes: ["/"],
        viewports: ["desktop", "phone"],
        schemes: ["light", "dark"],
      },
      designSurface: surface.length ? surface : ["src/styles/**"],
      protected: [],
    };
    const appTodos = [
      `install is ${manager.install.join(" ")}${manager.todo ? ` (${manager.todo})` : ""}`,
      serveScript
        ? `preview.serve is ${manager.run(serveScript).join(" ")} (from the "${serveScript}" script); it must serve the app on a fixed port without opening a browser`
        : "no dev, start, or preview script found; set preview.serve, or switch to static mode with preview.build and preview.output",
      `preview.port is ${port}${framework ? ` (the ${framework} default)` : " (a guess)"}; match what the serve command listens on`,
      "preview.routes lists only \"/\"; add the pages a designer should review",
      surface.length
        ? `designSurface is ${surface.join(", ")}; trim it to what designers may change`
        : "designSurface is a placeholder (src/styles/**); set the folders designers may change",
      "protected is empty; add server code, data, scripts, and anything inside the design surface that designers must not touch",
    ];
    todos.push({ app: name, items: appTodos });
  }
  return { apps, todos };
}

async function designSystemId(repoRoot, designSystemPath) {
  const contract = await readJsonFile(path.join(repoRoot, designSystemPath, "timds.json"), `${designSystemPath}/timds.json`).catch(() => null);
  const id = String(contract?.systemId || "").trim();
  if (id) return { systemId: id, guessed: false };
  return { systemId: `${slug(path.basename(repoRoot))}/core`, guessed: true };
}

async function buildConsumerManifest(repoRoot, designSystemPath) {
  const { apps, todos } = await discoverApps(repoRoot, designSystemPath);
  if (!Object.keys(apps).length) {
    throw new Error(`No app folders found: timds consumer init looks for a package.json one directory below ${repoRoot} (skipping ${designSystemPath}, node_modules, and dot-folders). Write ${CONSUMER_MANIFEST_FILE} by hand from the contract in the TimDS README, then rerun timds consumer init.`);
  }
  const { systemId, guessed } = await designSystemId(repoRoot, designSystemPath);
  const rendered = (await template("timds-consumer.json"))
    .replaceAll("__DESIGN_SYSTEM_PATH__", () => designSystemPath)
    .replaceAll("__SYSTEM_ID__", () => systemId)
    .replace("__APPS__", () => JSON.stringify(apps));
  const manifest = JSON.parse(rendered);
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
  lines.push(`- Review at: ${list(preview.viewports)} widths; ${list(preview.schemes)} schemes.`);
  lines.push(`- Design surface (may change): ${list(app.designSurface)}.`);
  lines.push(app.protected.length
    ? `- Protected (never change, even inside the surface): ${list(app.protected)}.`
    : "- Protected: nothing beyond the rule that everything outside the design surface is off limits.");
  return lines.join("\n");
}

/**
 * The managed SKILL.md for a consumer manifest. Generic guidance is static;
 * `__APPS__` becomes one section per app. `options.defaultBranch` names the
 * pull-request base (default `main`).
 */
export async function renderConsumerSkill(manifest, options = {}) {
  const validated = validateConsumerManifest(manifest);
  const source = await fs.readFile(path.join(packageRoot, "skills", CONSUMER_SKILL_NAME, "SKILL.md"), "utf8");
  const apps = Object.entries(validated.apps).map(([name, app]) => appSection(name, app)).join("\n\n");
  return source
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
  return files;
}

// ---------------------------------------------------------------------------
// Planning (all refusals happen before anything is written)

async function planManagedFiles(repoRoot, files, recorded, force) {
  const writes = [];
  const conflicts = [];
  for (const file of files) {
    const current = await readText(path.join(repoRoot, file.path));
    if (current === file.content) continue;
    if (current !== null && !force && sha256(current) !== recorded[file.path]) {
      conflicts.push(file.path);
      continue;
    }
    writes.push(file);
  }
  if (conflicts.length) {
    throw new Error(`Refusing to replace customized TimDS consumer files:\n${conflicts.map((file) => `- ${file}`).join("\n")}\nReview them, or rerun timds consumer init with --force to replace them`);
  }
  return writes;
}

async function planPackageJson(repoRoot, force) {
  const packagePath = path.join(repoRoot, "package.json");
  const existing = await readJsonFile(packagePath, "package.json");
  const packageJson = existing ? structuredClone(existing) : { name: slug(path.basename(repoRoot)), private: true };
  const identity = runtimeIdentity;
  const releaseRange = toolkitReleaseRange(identity);
  const current = packageJson.devDependencies?.[identity.name] ?? packageJson.dependencies?.[identity.name];
  if (current && !acceptsToolkitReleaseRange(current, identity) && !force) {
    throw new Error(`package.json already declares ${identity.name} as ${current}; rerun timds consumer init with --force to select ${releaseRange}`);
  }
  if (packageJson.scripts?.timds && packageJson.scripts.timds !== "timds" && !force) {
    throw new Error(`package.json scripts.timds is already ${JSON.stringify(packageJson.scripts.timds)}; rerun timds consumer init with --force to replace it`);
  }
  if (packageJson.dependencies?.[identity.name]) {
    delete packageJson.dependencies[identity.name];
    if (!Object.keys(packageJson.dependencies).length) delete packageJson.dependencies;
  }
  const selected = current && acceptsToolkitReleaseRange(current, identity) ? current : releaseRange;
  packageJson.scripts = { ...(packageJson.scripts || {}), timds: "timds" };
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
  for (const entry of desired) {
    managed[entry.name] = sha256(JSON.stringify(entry));
    const index = launch.configurations.findIndex((configuration) => configuration?.name === entry.name);
    if (index === -1) {
      launch.configurations.push(entry);
      continue;
    }
    const current = launch.configurations[index];
    if (sameJson(current, entry)) continue;
    if (force || sha256(JSON.stringify(current)) === recorded[entry.name]) {
      launch.configurations[index] = entry;
      continue;
    }
    kept.push(entry.name);
    managed[entry.name] = recorded[entry.name] ?? null;
    if (managed[entry.name] === null) delete managed[entry.name];
  }
  const content = toJson(launch);
  const changed = !existing || toJson(existing) !== content;
  return { launchPath, content, changed, kept, managed };
}

async function ensureGitignoreLines(repoRoot, lines) {
  const gitignorePath = path.join(repoRoot, ".gitignore");
  const existing = (await readText(gitignorePath)) ?? "";
  const present = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const missing = lines.filter((line) => !present.has(line));
  if (!missing.length) return false;
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  await fs.writeFile(gitignorePath, `${existing}${prefix}${missing.join("\n")}\n`, "utf8");
  return true;
}

// ---------------------------------------------------------------------------
// Init

/**
 * Initialize a consumer repository. Returns what was written; refuses (before
 * writing anything) without a design-system gitlink, on a conflicting toolkit
 * declaration, or on customized managed files unless `force`.
 */
export async function initializeConsumer(rootInput = process.cwd(), { force = false, skipInstall = false, output = () => {} } = {}) {
  const repoRoot = await findGitRoot(rootInput);
  const manifestPath = path.join(repoRoot, CONSUMER_MANIFEST_FILE);
  const existingRaw = await readJsonFile(manifestPath, CONSUMER_MANIFEST_FILE);
  const keepManifest = Boolean(existingRaw) && !force;
  if (keepManifest) validateConsumerManifest(existingRaw);
  const designSystemPath = keepManifest
    ? validateConsumerManifest(existingRaw).designSystem.path
    : DEFAULT_DESIGN_SYSTEM_PATH;

  if (!(await gitlinkCommit(repoRoot, designSystemPath))) {
    throw new Error(`${repoRoot} has no ${designSystemPath} submodule. A TimDS consumer pins its Design System as a git submodule; add it first with:\n  git submodule add <design-system repository URL> ${designSystemPath}\nthen commit the pin and rerun timds consumer init.`);
  }

  let manifest = existingRaw;
  let todos = [];
  let general = [];
  if (!keepManifest) ({ manifest, todos, general } = await buildConsumerManifest(repoRoot, designSystemPath));

  const installationPath = path.join(repoRoot, CONSUMER_INSTALLATION_PATH);
  const installation = (await readJsonFile(installationPath, CONSUMER_INSTALLATION_PATH)) ?? {};
  const previous = installation.consumer && typeof installation.consumer === "object" ? installation.consumer : {};
  const defaultBranch = await consumerDefaultBranch(repoRoot);

  const files = await consumerManagedFiles(manifest, { defaultBranch });
  const writes = await planManagedFiles(repoRoot, files, previous.managedFiles || {}, force);
  const packagePlan = await planPackageJson(repoRoot, force);
  const launchPlan = await planLaunch(repoRoot, await consumerLaunchConfigurations(manifest), previous.launchConfigurations || {}, force);

  const written = [];
  if (!keepManifest) {
    await writeFile(manifestPath, toJson(manifest));
    written.push(CONSUMER_MANIFEST_FILE);
  }
  for (const file of writes) {
    await writeFile(path.join(repoRoot, file.path), file.content);
    written.push(file.path);
  }
  if (packagePlan.changed) {
    await writeFile(packagePlan.packagePath, packagePlan.content);
    written.push("package.json");
  }
  if (launchPlan.changed) {
    await writeFile(launchPlan.launchPath, launchPlan.content);
    written.push(CONSUMER_LAUNCH_PATH);
  }
  if (await ensureGitignoreLines(repoRoot, ["node_modules/", ".timds/preview/"])) written.push(".gitignore");

  installation.consumer = {
    name: runtimeIdentity.name,
    schemaVersion: 1,
    version: runtimeIdentity.version,
    managedFiles: Object.fromEntries(files.map((file) => [file.path, sha256(file.content)])),
    launchConfigurations: launchPlan.managed,
  };
  await writeFile(installationPath, toJson(installation));
  written.push(CONSUMER_INSTALLATION_PATH);

  output(keepManifest
    ? `Kept the existing ${CONSUMER_MANIFEST_FILE}; rerun with --force to regenerate it from the app folders.`
    : `Wrote ${CONSUMER_MANIFEST_FILE} for ${Object.keys(manifest.apps).join(", ")}.`);
  for (const file of written) output(`  ${file}`);
  for (const name of launchPlan.kept) {
    output(`Kept the customized "${name}" entry in ${CONSUMER_LAUNCH_PATH}; rerun with --force to replace it.`);
  }

  if (!skipInstall && packagePlan.changed) {
    output("Running npm install to resolve @dtconcepts/timds into the lockfile...");
    const installed = await run("npm", ["install"], repoRoot);
    if (installed.code !== 0) {
      throw new Error(`npm install failed in ${repoRoot}:\n${(installed.stderr || installed.stdout).trim().split("\n").slice(-20).join("\n")}\nFix the error and run npm install; the TimDS files are already in place.`);
    }
  }

  const checklist = [
    ...general,
    ...todos.flatMap(({ app, items }) => items.map((item) => `${app}: ${item}`)),
    "Add the TIMDS_ACCESS_TOKEN repository secret so the preview workflow can publish previews",
    "Add DESIGN_SYSTEM_DEPLOY_KEY (read-only deploy key on the Design System repository) or TIMDS_CONSUMER_SUBMODULE_TOKEN (contents:read on it) so CI can check out the private submodule",
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
    if (name !== "root") throw new Error(`Unknown option --${rawName}\n${INIT_HELP}`);
    const next = inlineValue ?? argv[index + 1];
    if (next === undefined || String(next).startsWith("-")) throw new Error(`--${rawName} requires a value`);
    options.root = next;
    if (inlineValue === undefined) index += 1;
  }
  return options;
}

/** `timds consumer init [--root PATH] [--force] [--skip-install]` */
export async function runConsumerInit(args = [], { output = (message = "") => process.stdout.write(`${message}\n`) } = {}) {
  const options = parseInitArguments(args);
  if (options.help) {
    output(INIT_HELP);
    return null;
  }
  return initializeConsumer(options.root || process.cwd(), {
    force: Boolean(options.force),
    skipInstall: Boolean(options.skipInstall),
    output,
  });
}

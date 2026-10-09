// Consumer repositories: products that pin a TimDS Design System.
//
// A consumer repo is a product (a website, an app) that pins a TimDS Design
// System and declares, once, in `timds.consumer.json` at its root: which apps
// it holds, how to preview each one, and which paths a designer pull request
// may touch. The pin takes one of two forms. In published mode
// (`designSystem.version`) the product tracks only a version; `timds consumer
// sync` (consumer-sync.mjs) fetches that version's published bundle into the
// gitignored `designSystem.path`, and no Design System bytes enter the
// repository. In submodule mode the same path is a git submodule at an exact
// commit, the form the first consumers adopted. This module reads and
// validates the manifest, resolves the pin either way (gitlink commit or the
// sync record), and guards the design-surface scope of a branch diff for
// `timds consumer check`. The scope is judged against the manifest at the
// merge base, so a branch cannot widen its own surface. The same diff names
// the apps worth previewing (`previewApps`), so the stock workflow skips the
// preview on a pull request that cannot change a look.
//
// Boundary: nothing here knows the product's stack. TimDS never builds,
// installs, or edits the product; the commands the manifest declares are run
// by `consumer-preview.mjs`, and the managed skill and workflow are installed
// by `consumer-init.mjs`. This module is the shared read side both import.

import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import * as z from "zod/v4";

export const CONSUMER_MANIFEST_FILE = "timds.consumer.json";
/** The record `consumer sync` leaves in the bundle directory: which version is there and which files. */
export const CONSUMER_BUNDLE_RECORD_FILE = ".timds-bundle.json";
/** Where a published system sits unless `designSystem.url` says otherwise: `<base>/<systemId>/artifact`. */
export const DEFAULT_PUBLISHED_BASE_URL = "https://design-systems.timds.com";
export const CONSUMER_VIEWPORTS = Object.freeze(["desktop", "tablet", "phone"]);
export const CONSUMER_SCHEMES = Object.freeze(["light", "dark"]);

/**
 * Paths a consumer PR may always change: the manifest, the TimDS-managed
 * files, and the root files `consumer init` and upgrades write (the root
 * package manifest, lockfiles, .gitignore, installation record). Root only:
 * an app's own package.json stays subject to its design surface.
 */
export const CONSUMER_ALWAYS_ALLOWED = Object.freeze([
  CONSUMER_MANIFEST_FILE,
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "bun.lock",
  "bun.lockb",
  "pnpm-lock.yaml",
  "yarn.lock",
  ".gitignore",
  ".timds/installation.json",
  ".agents/skills/timds-consume-design-system/**",
  ".github/workflows/timds-consumer-preview.yml",
  ".github/workflows/timds-designer-change.yml",
  ".claude/launch.json",
  ".mcp.json",
]);

const CONSUMER_HELP = `Usage:
  timds consumer check [--root PATH] [--app NAME] [--base REF] [--json]
  timds consumer sync [--root PATH]
  timds consumer update [VERSION] [--root PATH]
  timds consumer preview --app NAME [--root PATH] [--output DIR] [--base REF] [--publish] [--pull-request N]
  timds consumer init [--root PATH] [--system ID] [--version VERSION] [--url URL] [--force] [--skip-install] [--portal-url URL]
  timds consumer scaffold emdash --root PATH --design-system GIT_URL [--stylesheet PATH]... [--site-url URL] [--portal-url URL] [--skip-install]
  timds consumer notes [--root PATH] [--app NAME] [--pull-request N] [--all] [--json] [--portal-url URL]
  timds consumer notes resolve ID [ID...] [--commit SHA] [--dismiss]`;

// ---------------------------------------------------------------------------
// Manifest validation

function isSafeRelativePath(value) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) return false;
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return false;
  return normalized.split("/").every((segment) => segment !== "..");
}

function normalizeRelativePath(value) {
  const normalized = path.posix.normalize(String(value).replace(/\\/g, "/")).replace(/\/+$/, "");
  return normalized === "" ? "." : normalized;
}

const relativePath = (label) => z.string().refine(isSafeRelativePath, {
  message: `${label} must be a relative path inside the repository (no leading "/" and no "..")`,
}).transform(normalizeRelativePath);

const commandSchema = (label) => z.array(z.string().min(1, `${label} entries must be non-empty strings`), {
  error: `${label} must be a command as an array of strings, e.g. ["npm", "run", "build"]`,
}).min(1, `${label} must not be empty`);

const routePath = z.string().refine((value) => value.startsWith("/") && !value.includes("\0") && !/\s/.test(value), {
  message: 'routes must be absolute URL paths such as "/" or "/contact"',
});

const globList = (label) => z.array(z.string().min(1, `${label} globs must be non-empty`).refine(isSafeRelativePath, {
  message: `${label} globs are relative to the app's cwd and must not start with "/" or contain ".."`,
}), { error: `${label} must be an array of glob strings` });

const urlPathGlob = z.string().min(1, "preview.discover.exclude globs must be non-empty").refine((value) => value.startsWith("/") && !value.includes("\0") && !/\s/.test(value), {
  message: 'preview.discover.exclude globs are URL path globs such as "/admin/**" or "/blog/*/print"',
});

/** A design reference: `<design id>:<route>`, the page of a website design in the pinned system. */
const DESIGN_REFERENCE = /^([a-z0-9]+(?:-[a-z0-9]+)*):(\/[^\s\0]*)$/;

/** Parse `website:/contact` into `{ design, route }` with the route normalized (`/`, `/contact`). */
export function parseDesignReference(value) {
  const match = DESIGN_REFERENCE.exec(String(value ?? "").trim());
  if (!match) return null;
  const route = match[2].length > 1 ? `/${match[2].replace(/^\/+|\/+$/g, "")}` : "/";
  return { design: match[1], route };
}

const normalizeRoute = (value) => (value.length > 1 ? `/${value.replace(/^\/+|\/+$/g, "")}` : "/");

const designReference = z.string().refine((value) => DESIGN_REFERENCE.test(value), {
  message: 'preview.designs values name a page of a website design in the pinned Design System as "<design>:<route>", such as "website:/contact"',
});

/** Route discovery limits: how many routes beyond `routes` a crawl may add. */
export const CONSUMER_DISCOVER_LIMIT = Object.freeze({ default: 40, max: 200 });

const discoverSchema = z.object({
  from: z.array(routePath, { error: "preview.discover.from must be an array of URL paths" })
    .min(1, "preview.discover.from must list at least one URL path")
    .default(["/"]),
  limit: z.number({ error: "preview.discover.limit must be a number" }).int("preview.discover.limit must be a whole number")
    .min(1, `preview.discover.limit must be between 1 and ${CONSUMER_DISCOVER_LIMIT.max}`)
    .max(CONSUMER_DISCOVER_LIMIT.max, `preview.discover.limit must be between 1 and ${CONSUMER_DISCOVER_LIMIT.max}`)
    .default(CONSUMER_DISCOVER_LIMIT.default),
  exclude: z.array(urlPathGlob, { error: "preview.discover.exclude must be an array of URL path globs" }).default([]),
}, { error: "preview.discover must be an object with from, limit, and exclude" }).strict();

const previewSchema = z.object({
  build: commandSchema("preview.build").optional(),
  output: relativePath("preview.output").optional(),
  serve: commandSchema("preview.serve").optional(),
  port: z.number({ error: "preview.port must be a number" }).int().min(1).max(65_535, "preview.port must be between 1 and 65535").optional(),
  ready: routePath.default("/"),
  routes: z.array(routePath, { error: "preview.routes must be an array of URL paths" }).min(1, "preview.routes must list at least one route").optional(),
  viewports: z.array(z.enum(CONSUMER_VIEWPORTS, { error: `preview.viewports entries must be one of ${CONSUMER_VIEWPORTS.join(", ")}` }))
    .min(1, "preview.viewports must not be empty")
    .default(["desktop", "phone"]),
  schemes: z.array(z.enum(CONSUMER_SCHEMES, { error: `preview.schemes entries must be one of ${CONSUMER_SCHEMES.join(", ")}` }))
    .min(1, "preview.schemes must not be empty")
    .default(["light", "dark"]),
  discover: discoverSchema.optional(),
  designs: z.record(routePath, designReference, { error: 'preview.designs must be an object keyed by route, such as { "/contact": "website:/contact" }' }).optional(),
}, { error: "preview must be an object" }).strict().superRefine((preview, context) => {
  const staticKeys = ["build", "output"].filter((key) => preview[key] !== undefined);
  const crawlKeys = ["serve", "port"].filter((key) => preview[key] !== undefined);
  if (staticKeys.length && crawlKeys.length) {
    context.addIssue({ code: "custom", message: "preview must use exactly one mode: build + output (static) or serve + port + routes (crawl), not both" });
    return;
  }
  if (!staticKeys.length && !crawlKeys.length) {
    context.addIssue({ code: "custom", message: "preview must declare build + output (static mode) or serve + port + routes (crawl mode)" });
    return;
  }
  if (staticKeys.length && staticKeys.length !== 2) {
    context.addIssue({ code: "custom", message: "static preview needs both build (the build command) and output (the build output directory)" });
  }
  if (crawlKeys.length) {
    const missing = ["serve", "port", "routes"].filter((key) => preview[key] === undefined);
    if (missing.length) context.addIssue({ code: "custom", message: `crawl preview needs serve, port, and routes; missing ${missing.join(", ")}` });
  }
  for (const key of ["viewports", "schemes", "routes"]) {
    const list = preview[key];
    if (list && new Set(list).size !== list.length) context.addIssue({ code: "custom", path: [key], message: `preview.${key} must not repeat entries` });
  }
  if (preview.discover && !preview.serve && !preview.routes) {
    context.addIssue({ code: "custom", path: ["discover"], message: "preview.discover only works in crawl mode (serve + port + routes, or build + output + routes)" });
  }
  if (preview.designs) {
    if (!preview.routes) {
      context.addIssue({ code: "custom", path: ["designs"], message: "preview.designs pairs routes with design pages, so it needs preview.routes (crawl mode)" });
    } else {
      const declared = new Set(preview.routes.map(normalizeRoute));
      for (const route of Object.keys(preview.designs)) {
        if (!declared.has(normalizeRoute(route))) {
          context.addIssue({ code: "custom", path: ["designs", route], message: `preview.designs pairs ${route}, which preview.routes does not list; add it there so it is always captured` });
        }
      }
    }
  }
});

const appSchema = z.object({
  cwd: relativePath("cwd"),
  install: commandSchema("install").optional(),
  preview: previewSchema,
  designSurface: globList("designSurface").min(1, "designSurface must list at least one glob a designer PR may change"),
  protected: globList("protected").default([]),
}, { error: "each app must be an object" }).strict();

const APP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const publishedUrl = z.string().refine((value) => {
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}, { message: "designSystem.url must be the HTTP or HTTPS prefix the Design System is published at, without a query or credentials" }).transform((value) => value.replace(/\/+$/, ""));

const manifestSchema = z.object({
  $schema: z.string().optional(),
  schemaVersion: z.literal(1, { error: `${CONSUMER_MANIFEST_FILE} schemaVersion must be 1` }),
  designSystem: z.object({
    path: relativePath("designSystem.path").default("design-system"),
    systemId: z.string({ error: "designSystem.systemId is required (the Design System's systemId from its timds.json)" })
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{1,159}$/, "designSystem.systemId must use letters, numbers, dots, slashes, underscores, or hyphens"),
    // Published mode: the version the product is built against (or `current`
    // to follow every release at the next install) and, optionally, where the
    // system is published. Absent, the path is a git submodule.
    version: z.string().regex(/^(?:current|[A-Za-z0-9][A-Za-z0-9._-]{0,99})$/, 'designSystem.version must be a published version label such as "1.4.0", or "current"').optional(),
    url: publishedUrl.optional(),
  }, { error: "designSystem must be an object with path and systemId" }).strict().superRefine((designSystem, context) => {
    if (designSystem.url && !designSystem.version) {
      context.addIssue({ code: "custom", path: ["url"], message: "designSystem.url applies to a published pin; add designSystem.version" });
    }
  }),
  apps: z.record(z.string(), appSchema, { error: "apps must be an object keyed by app name" }).superRefine((apps, context) => {
    const names = Object.keys(apps);
    if (!names.length) context.addIssue({ code: "custom", message: "apps must declare at least one app" });
    for (const name of names) {
      if (!APP_NAME.test(name)) {
        context.addIssue({ code: "custom", path: [name], message: `app name "${name}" must start with a letter or digit and use only letters, digits, dots, underscores, or hyphens` });
      }
    }
  }),
}, { error: `${CONSUMER_MANIFEST_FILE} must be a JSON object` }).strict();

function issuePath(issue) {
  return (issue.path || []).map((segment) => (typeof segment === "number" ? `[${segment}]` : segment)).join(".").replace(/\.\[/g, "[");
}

function formatIssues(issues) {
  return issues.map((issue) => {
    const where = issuePath(issue);
    const message = issue.code === "unrecognized_keys"
      ? `unknown field${issue.keys.length === 1 ? "" : "s"} ${issue.keys.map((key) => `"${key}"`).join(", ")}`
      : issue.message;
    return `- ${where ? `${where}: ` : ""}${message}`;
  }).join("\n");
}

/** Validate a parsed `timds.consumer.json` and return it with defaults applied. Throws an actionable Error. */
export function validateConsumerManifest(value) {
  const result = manifestSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`${CONSUMER_MANIFEST_FILE} is invalid:\n${formatIssues(result.error.issues)}`);
  }
  const { $schema: _schema, ...manifest } = result.data;
  return manifest;
}

/** "static" when the build output is the preview, "crawl" when routes are visited (serve, or build + routes). */
export function consumerPreviewMode(preview) {
  return preview.serve || preview.routes ? "crawl" : "static";
}

/** `published` when the manifest pins a version, else `submodule`. */
export function consumerPinMode(designSystem) {
  return designSystem?.version ? "published" : "submodule";
}

/** The prefix a published system's derived layer and bundle sit under. */
export function publishedBaseUrl(designSystem) {
  return designSystem.url || `${DEFAULT_PUBLISHED_BASE_URL}/${designSystem.systemId}/artifact`;
}

// ---------------------------------------------------------------------------
// Repository and Design System resolution

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

const git = (args, cwd) => run("git", args, cwd);

/**
 * The root of the consumer repository containing `start`, or null when it is
 * not one: the git toplevel when it holds `timds.consumer.json`; outside git,
 * the nearest ancestor that holds it. Inside git the search never climbs past
 * the toplevel, so a Design System submodule checked out inside a product is
 * still its own repository. `timds upgrade` uses this to route consumers away
 * from the design-system workspace loader.
 */
export async function findConsumerManifestRoot(start = process.cwd()) {
  const resolved = path.resolve(start);
  if (!existsSync(resolved)) return null;
  const result = await git(["rev-parse", "--show-toplevel"], resolved);
  if (result.code === 0 && result.stdout.trim()) {
    const top = await fs.realpath(path.resolve(result.stdout.trim()));
    return existsSync(path.join(top, CONSUMER_MANIFEST_FILE)) ? top : null;
  }
  let current = resolved;
  while (true) {
    if (existsSync(path.join(current, CONSUMER_MANIFEST_FILE))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function findConsumerRoot(start) {
  const resolved = path.resolve(start);
  const result = await git(["rev-parse", "--show-toplevel"], resolved);
  if (result.code === 0 && result.stdout.trim()) {
    const top = path.resolve(result.stdout.trim());
    if (existsSync(path.join(top, CONSUMER_MANIFEST_FILE))) return top;
  }
  let current = resolved;
  while (true) {
    if (existsSync(path.join(current, CONSUMER_MANIFEST_FILE))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result.code === 0 && result.stdout.trim() ? path.resolve(result.stdout.trim()) : resolved;
}

async function gitlinkCommit(repoRoot, designSystemPath) {
  const tree = await git(["ls-tree", "HEAD", "--", designSystemPath], repoRoot);
  if (tree.code === 0) {
    const match = tree.stdout.trim().match(/^160000\s+commit\s+([0-9a-f]{7,64})\t/m);
    if (match) return match[1];
  }
  // No commit yet (or not a gitlink in HEAD): fall back to the index.
  const staged = await git(["ls-files", "--stage", "--", designSystemPath], repoRoot);
  if (staged.code === 0) {
    const match = staged.stdout.trim().match(/^160000\s+([0-9a-f]{7,64})\s+\d\t/m);
    if (match) return match[1];
  }
  return null;
}

async function checkoutCommit(root) {
  if (!existsSync(path.join(root, ".git"))) return null;
  const head = await git(["rev-parse", "HEAD"], root);
  return head.code === 0 ? head.stdout.trim() || null : null;
}

async function readBundleRecord(root) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(root, CONSUMER_BUNDLE_RECORD_FILE), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Load the consumer repo at or above `repoRootInput`: the validated manifest
 * and the pinned Design System (`root`, `mode`, gitlink `commit` or null, the
 * sync `record` or null, `present`). In published mode `present` means the
 * bundle has been synced; in submodule mode, that the checkout exists.
 */
export async function loadConsumer(repoRootInput = process.cwd()) {
  const repoRoot = await findConsumerRoot(repoRootInput);
  const manifestPath = path.join(repoRoot, CONSUMER_MANIFEST_FILE);
  let text;
  try {
    text = await fs.readFile(manifestPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`No ${CONSUMER_MANIFEST_FILE} found at ${repoRoot}. Run \`timds consumer init\` in the product repository to create one.`);
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${CONSUMER_MANIFEST_FILE} is not valid JSON: ${error.message}`);
  }
  const manifest = validateConsumerManifest(parsed);
  const designSystemRoot = path.resolve(repoRoot, manifest.designSystem.path);
  const mode = consumerPinMode(manifest.designSystem);
  const linked = mode === "published" && await fs.lstat(designSystemRoot).then((info) => info.isSymbolicLink(), () => false);
  const record = mode === "published" && !linked ? await readBundleRecord(designSystemRoot) : null;
  const designSystem = {
    path: manifest.designSystem.path,
    systemId: manifest.designSystem.systemId,
    mode,
    version: manifest.designSystem.version ?? null,
    url: mode === "published" ? publishedBaseUrl(manifest.designSystem) : null,
    root: designSystemRoot,
    commit: await gitlinkCommit(repoRoot, manifest.designSystem.path),
    record,
    linked,
    present: mode === "published" && !linked ? record !== null : existsSync(path.join(designSystemRoot, "timds.json")),
  };
  return { repoRoot, manifestPath, manifest, apps: manifest.apps, designSystem };
}

/** The app entry named `name` (or the only app when `name` is omitted), with its absolute `cwd`. */
export function resolveConsumerApp(consumer, name) {
  const names = Object.keys(consumer.apps);
  let selected = name;
  if (!selected) {
    if (names.length === 1) selected = names[0];
    else throw new Error(`This repository declares ${names.length} apps in ${CONSUMER_MANIFEST_FILE}; choose one with --app (${names.join(", ")})`);
  }
  const app = consumer.apps[selected];
  if (!app || !Object.hasOwn(consumer.apps, selected)) {
    throw new Error(`Unknown app "${selected}" in ${CONSUMER_MANIFEST_FILE}; available apps: ${names.join(", ")}`);
  }
  return { ...app, name: selected, cwdRelative: app.cwd, cwd: path.resolve(consumer.repoRoot, app.cwd) };
}

// ---------------------------------------------------------------------------
// Glob matching (`**`, `*`, `?`), no dependency

const globCache = new Map();

export function globToRegExp(glob) {
  if (globCache.has(glob)) return globCache.get(glob);
  const source = normalizeRelativePath(glob);
  let pattern = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "*") {
      if (source[index + 1] === "*") {
        const atStart = index === 0 || source[index - 1] === "/";
        const atEnd = index + 2 === source.length || source[index + 2] === "/";
        if (atStart && atEnd) {
          if (index + 2 === source.length) {
            pattern += ".*"; // trailing "**": everything below
          } else {
            pattern += "(?:[^/]+/)*"; // "**/": zero or more directories
            index += 1; // skip the slash after "**"
          }
          index += 1;
          continue;
        }
        pattern += "[^/]*";
        index += 1;
        continue;
      }
      pattern += "[^/]*";
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  // "dir/**" also matches "dir" itself; a literal path (no wildcard) matches
  // that file or everything under that directory.
  const literal = !/[*?]/.test(source);
  const expression = new RegExp(source.endsWith("/**")
    ? `^(?:${pattern.slice(0, -3)}|${pattern})$`
    : literal ? `^${pattern}(?:/.*)?$` : `^${pattern}$`);
  globCache.set(glob, expression);
  return expression;
}

export function matchesGlob(filePath, glob) {
  return globToRegExp(glob).test(filePath);
}

function relativeToApp(filePath, cwd) {
  if (cwd === ".") return filePath;
  if (filePath === cwd) return "";
  return filePath.startsWith(`${cwd}/`) ? filePath.slice(cwd.length + 1) : null;
}

/** Classify one repo-relative path against the manifest: "allowed", "protected" (with app), or "outside". */
export function classifyConsumerPath(filePath, manifest, apps = Object.keys(manifest.apps)) {
  if (CONSUMER_ALWAYS_ALLOWED.some((glob) => matchesGlob(filePath, glob))) return { status: "allowed", app: null };
  let protectedBy = null;
  for (const name of apps) {
    const app = manifest.apps[name];
    const inner = relativeToApp(filePath, app.cwd);
    if (inner === null || inner === "") continue;
    if (app.protected.some((glob) => matchesGlob(inner, glob))) {
      protectedBy ||= name;
      continue;
    }
    if (app.designSurface.some((glob) => matchesGlob(inner, glob))) return { status: "allowed", app: name };
  }
  return protectedBy ? { status: "protected", app: protectedBy } : { status: "outside", app: null };
}

// ---------------------------------------------------------------------------
// Check

// Both listings use NUL-separated output so odd file names are never quoted,
// and `--no-renames` so a file moved out of a protected area is still listed
// at its old path (a rename would otherwise show only the destination).
async function changedPaths(repoRoot, base, designSystemPath) {
  const committed = await git(["diff", "--name-only", "--no-renames", "-z", `${base}...HEAD`], repoRoot);
  if (committed.code !== 0) {
    throw new Error(`Could not diff against ${base}: ${committed.stderr.trim() || "unknown ref"}. Fetch the base branch first (e.g. git fetch origin main) or pass a different --base.`);
  }
  const status = await git(["status", "--porcelain", "-z", "--no-renames", "--untracked-files=all", "--ignore-submodules=dirty"], repoRoot);
  if (status.code !== 0) throw new Error(`Could not read the working tree status: ${status.stderr.trim() || "git status failed"}`);
  const paths = new Set(committed.stdout.split("\0").filter(Boolean));
  for (const entry of status.stdout.split("\0").filter(Boolean)) {
    const filePath = entry.slice(3);
    // An unstaged change at the Design System path is a checkout that drifted
    // from the pin (reported as a warning), not a change to the pin.
    if (filePath === designSystemPath && entry[0] === " ") continue;
    paths.add(filePath);
  }
  return [...paths].sort();
}

/**
 * The manifest the scope is judged against: the one at the merge base, so a
 * branch cannot widen its own design surface. `null` when the base has no
 * manifest (the branch adopts TimDS) or an unreadable one.
 */
async function manifestAtBase(repoRoot, base) {
  const mergeBase = await git(["merge-base", base, "HEAD"], repoRoot);
  if (mergeBase.code !== 0 || !mergeBase.stdout.trim()) return { manifest: null, missing: false };
  const shown = await git(["show", `${mergeBase.stdout.trim()}:${CONSUMER_MANIFEST_FILE}`], repoRoot);
  if (shown.code !== 0) return { manifest: null, missing: true };
  try {
    return { manifest: validateConsumerManifest(JSON.parse(shown.stdout)), missing: false };
  } catch {
    return { manifest: null, missing: false };
  }
}

/**
 * Validate a consumer repo: manifest, pinned and present Design System, each
 * app's cwd, and (with `base`) that the branch only touches design surface.
 */
export async function checkConsumer(repoRootInput = process.cwd(), options = {}) {
  const errors = [];
  const warnings = [];
  let consumer;
  try {
    consumer = await loadConsumer(repoRootInput);
  } catch (error) {
    return { status: "failed", errors: [error.message], warnings, apps: [], repoRoot: null, designSystem: null, changes: [], previewApps: null };
  }
  const { designSystem, manifest, repoRoot } = consumer;
  const selected = options.app ? [resolveConsumerApp(consumer, options.app).name] : Object.keys(manifest.apps);

  if (designSystem.mode === "published") {
    // A published pin keeps no Design System bytes in git: the sync record says what was fetched.
    if (designSystem.commit) {
      errors.push(`${designSystem.path} is still a git submodule but ${CONSUMER_MANIFEST_FILE} pins a published version. Remove the submodule (git rm -r --cached ${designSystem.path}, drop it from .gitmodules) so npm install can fetch the bundle.`);
    }
    if (designSystem.linked) {
      if (!designSystem.present) errors.push(`${designSystem.path} is a symbolic link but its target has no timds.json; point it at a Design System checkout.`);
      else warnings.push(`${designSystem.path} is a local Design System checkout; checking the working copy instead of published pin ${designSystem.version}.`);
    } else if (!designSystem.record) {
      errors.push(`${designSystem.path} has no synced Design System bundle. Run: npm run timds -- consumer sync (npm install runs it from postinstall)`);
    } else {
      const record = designSystem.record;
      if (designSystem.version !== "current" && record.version !== designSystem.version) {
        errors.push(`${designSystem.path} holds Design System version ${record.version ?? "unknown"} but ${CONSUMER_MANIFEST_FILE} pins ${designSystem.version}. Run: npm run timds -- consumer sync`);
      }
      if (record.systemId && record.systemId !== designSystem.systemId) {
        warnings.push(`${CONSUMER_MANIFEST_FILE} designSystem.systemId is ${designSystem.systemId} but the synced bundle belongs to ${record.systemId}`);
      }
      for (const file of Array.isArray(record.files) ? record.files : []) {
        if (typeof file?.path !== "string" || file.path.split("/").some((segment) => !segment || segment === "..")) continue;
        if (!existsSync(path.join(designSystem.root, ...file.path.split("/")))) {
          errors.push(`${designSystem.path}/${file.path} is missing from the synced bundle. Run: npm run timds -- consumer sync`);
          break;
        }
      }
    }
  } else if (!designSystem.commit) {
    errors.push(`${designSystem.path} is not pinned as a git submodule. Add it with: git submodule add <design-system-repo-url> ${designSystem.path}, or pin a published version with designSystem.version in ${CONSUMER_MANIFEST_FILE} (timds consumer init --system)`);
  }
  if (designSystem.mode === "submodule" && !designSystem.present) {
    errors.push(`${designSystem.path}/timds.json is missing. Check out the submodule with: git submodule update --init ${designSystem.path}`);
  } else if ((designSystem.mode === "submodule" && designSystem.commit) || (designSystem.linked && designSystem.present)) {
    if (designSystem.mode === "submodule") {
      const checkedOut = await checkoutCommit(designSystem.root);
      if (checkedOut && checkedOut !== designSystem.commit) {
        warnings.push(`${designSystem.path} is checked out at ${checkedOut.slice(0, 12)} but the repository pins ${designSystem.commit.slice(0, 12)}. Run git submodule update ${designSystem.path}, or commit the new pin deliberately.`);
      }
    }
    try {
      const dsManifest = JSON.parse(await fs.readFile(path.join(designSystem.root, "timds.json"), "utf8"));
      const dsId = String(dsManifest.systemId || dsManifest.system_id || dsManifest.client || "").trim();
      if (dsId && dsId !== designSystem.systemId) {
        warnings.push(`${CONSUMER_MANIFEST_FILE} designSystem.systemId is ${designSystem.systemId} but ${designSystem.path}/timds.json declares ${dsId}`);
      }
    } catch {
      warnings.push(`${designSystem.path}/timds.json could not be read as JSON`);
    }
  }

  // Design pairings are checked against the pin's own catalog, so a renamed
  // design or route fails here rather than silently leaving the preview bare.
  // A published pin's catalog is the designs summary the sync recorded.
  let designCatalog = null;
  if (designSystem.present && selected.some((name) => manifest.apps[name].preview.designs)) {
    if (designSystem.mode === "published" && !designSystem.linked) {
      const recorded = designSystem.record?.designs;
      if (Array.isArray(recorded)) {
        designCatalog = { exists: true, designs: recorded.map((design) => ({ id: design.id, pages: (design.routes ?? []).map((route) => ({ route })) })) };
      } else {
        warnings.push(`${designSystem.path} has no recorded website designs; republish the pinned release with the current toolkit and run npm run timds -- consumer sync to check the preview.designs pairings`);
      }
    } else {
      const { readDesignCatalog } = await import("./designs.mjs");
      try {
        designCatalog = await readDesignCatalog(designSystem.root);
      } catch (error) {
        warnings.push(`${designSystem.path} website designs could not be read: ${error.message}`);
      }
    }
  }

  const apps = [];
  for (const name of selected) {
    const app = resolveConsumerApp(consumer, name);
    const cwdExists = existsSync(app.cwd);
    if (!cwdExists) errors.push(`App "${name}": cwd ${app.cwdRelative} does not exist`);
    if (designCatalog) {
      for (const [route, reference] of Object.entries(app.preview.designs || {})) {
        const { design: designId, route: designRoute } = parseDesignReference(reference);
        const design = designCatalog.designs.find((entry) => entry.id === designId);
        if (!designCatalog.exists) {
          errors.push(`App "${name}": preview.designs pairs ${route} with ${reference}, but ${designSystem.path} has no src/designs/`);
        } else if (!design) {
          errors.push(`App "${name}": preview.designs pairs ${route} with ${reference}, but ${designSystem.path} has no design ${designId} (designs: ${designCatalog.designs.map((entry) => entry.id).join(", ") || "none"})`);
        } else if (!design.pages.some((page) => page.route === designRoute)) {
          errors.push(`App "${name}": preview.designs pairs ${route} with ${reference}, but design ${designId} has no route ${designRoute} (routes: ${design.pages.map((page) => page.route).join(", ")})`);
        }
      }
    }
    apps.push({ name, cwd: app.cwdRelative, cwdExists, mode: consumerPreviewMode(app.preview), designs: Object.keys(app.preview.designs || {}).length });
  }

  let changes = [];
  let previewApps = null;
  if (options.base) {
    // Scope is judged against every app, so a designer PR may touch any app's surface;
    // `--app` only narrows which apps' cwd and preview are checked.
    const paths = await changedPaths(repoRoot, options.base, designSystem.path);
    const atBase = await manifestAtBase(repoRoot, options.base);
    const scopeManifest = atBase.manifest || manifest;
    const pinMoved = Boolean(atBase.manifest) && JSON.stringify(atBase.manifest.designSystem) !== JSON.stringify(manifest.designSystem);
    if (atBase.manifest && JSON.stringify(atBase.manifest) !== JSON.stringify(manifest)) {
      warnings.push(`${CONSUMER_MANIFEST_FILE} changed on this branch; the design surface is judged against the manifest at ${options.base}. Changing the manifest needs a developer.`);
    }
    // A branch that adopts TimDS adds the submodule, or the manifest with a
    // published pin; afterwards the pin only moves by a developer decision.
    // In published mode the pin is a manifest field, so a moved version shows
    // as the manifest path with the pin status.
    const adoption = atBase.missing ? new Set([".gitmodules", designSystem.path]) : new Set();
    changes = paths.map((filePath) => {
      if (adoption.has(filePath)) return { path: filePath, status: "allowed", app: null };
      if (filePath === designSystem.path) return { path: filePath, status: "pin", app: null };
      if (filePath === CONSUMER_MANIFEST_FILE && pinMoved) return { path: filePath, status: "pin", app: null };
      return { path: filePath, ...classifyConsumerPath(filePath, scopeManifest) };
    });
    const outside = changes.filter((change) => change.status === "outside");
    const guarded = changes.filter((change) => change.status === "protected");
    if (changes.some((change) => change.status === "pin")) {
      errors.push(designSystem.mode === "published"
        ? `The Design System pin (designSystem in ${CONSUMER_MANIFEST_FILE}) changed. A design change never moves the pin; moving it is a separate developer decision (timds consumer update).`
        : `The Design System pin at ${designSystem.path} changed. A design change never moves the pin; moving it is a separate developer decision.`);
    }
    if (outside.length) {
      errors.push(`Changes outside the design surface declared in ${CONSUMER_MANIFEST_FILE}:\n${outside.map((change) => `- ${change.path}`).join("\n")}`);
    }
    if (guarded.length) {
      errors.push(`Changes to protected paths:\n${guarded.map((change) => `- ${change.path} (protected in app "${change.app}")`).join("\n")}`);
    }
    const developerOwned = changes.filter((change) => change.status === "allowed" && change.app === null && !adoption.has(change.path));
    if (developerOwned.length && !atBase.missing) {
      warnings.push(`Developer-owned files changed (allowed so adoption and upgrade branches pass; a design change should not touch them):\n${developerOwned.map((change) => `- ${change.path}`).join("\n")}`);
    }
    // The apps whose look this branch can change, which is what a preview is
    // for: an app whose design surface changed, or every app when the Design
    // System pin or the manifest (routes, commands, the surface itself) moved.
    const everyApp = atBase.missing || changes.some((change) => change.status === "pin" || change.path === CONSUMER_MANIFEST_FILE);
    const touched = new Set(changes.filter((change) => change.status === "allowed" && change.app).map((change) => change.app));
    previewApps = Object.keys(manifest.apps).filter((name) => everyApp || touched.has(name));
  }

  return {
    status: errors.length ? "failed" : "passed",
    errors,
    warnings,
    apps,
    repoRoot,
    designSystem,
    changes,
    previewApps,
  };
}

// ---------------------------------------------------------------------------
// CLI

const CHECK_BOOLEAN_FLAGS = new Set(["help", "json"]);
const CHECK_VALUE_FLAGS = new Set(["app", "base", "root"]);

// Strict on purpose: a mistyped or empty --base would otherwise skip the scope check and pass.
function parseCheckArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("-")) throw new Error(`Unexpected argument ${value}\n${CONSUMER_HELP}`);
    const [rawName, inlineValue] = value.replace(/^--?/, "").split("=", 2);
    const name = rawName.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    if (CHECK_BOOLEAN_FLAGS.has(name)) {
      options[name] = true;
      continue;
    }
    if (!CHECK_VALUE_FLAGS.has(name)) throw new Error(`Unknown option --${rawName}\n${CONSUMER_HELP}`);
    const next = inlineValue ?? argv[index + 1];
    if (next === undefined || next === "" || String(next).startsWith("-")) throw new Error(`--${rawName} requires a value`);
    options[name] = next;
    if (inlineValue === undefined) index += 1;
  }
  return options;
}

function defaultOutput(message = "") {
  process.stdout.write(`${message}\n`);
}

function checkReport(result) {
  const lines = [];
  if (result.repoRoot) lines.push(`Consumer: ${result.repoRoot}`);
  if (result.designSystem) {
    const ds = result.designSystem;
    lines.push(ds.mode === "published"
      ? `Design System: ${ds.systemId} at ${ds.path} (published, pinned ${ds.version}${ds.record?.version && ds.record.version !== ds.version ? `, synced ${ds.record.version}` : ""}${ds.present ? "" : ", not synced"})`
      : `Design System: ${ds.systemId} at ${ds.path} (${ds.commit ? `pinned ${ds.commit.slice(0, 12)}` : "not pinned"}${ds.present ? "" : ", not checked out"})`);
  }
  for (const app of result.apps) lines.push(`App ${app.name}: ${app.cwd} (${app.mode} preview)${app.cwdExists ? "" : " — missing"}`);
  if (result.changes.length) {
    const allowed = result.changes.filter((change) => change.status === "allowed").length;
    lines.push(`Changes: ${result.changes.length} (${allowed} inside the design surface)`);
  }
  if (result.previewApps) lines.push(`Preview: ${result.previewApps.join(", ") || "no app's design surface, Design System pin, or manifest changed"}`);
  for (const warning of result.warnings) lines.push(`Warning: ${warning}`);
  for (const error of result.errors) lines.push(`Error: ${error}`);
  lines.push(result.status === "passed" ? "TimDS consumer check passed." : "TimDS consumer check failed.");
  return lines.join("\n");
}

/** `timds consumer <check|sync|update|preview|init|scaffold|notes> ...` */
export async function runConsumerCli(args = [], { env = process.env, output = defaultOutput } = {}) {
  const [subcommand = "help", ...rest] = args;
  if (["help", "--help", "-h"].includes(subcommand)) {
    output(CONSUMER_HELP);
    return;
  }
  if (subcommand === "sync" || subcommand === "update") {
    const { runConsumerSync, runConsumerUpdate } = await import("./consumer-sync.mjs");
    return subcommand === "sync" ? runConsumerSync(rest, { output }) : runConsumerUpdate(rest, { output });
  }
  if (subcommand === "preview") {
    const { runConsumerPreview } = await import("./consumer-preview.mjs");
    return runConsumerPreview(rest, { output });
  }
  if (subcommand === "notes") {
    const { runConsumerNotes } = await import("./consumer-notes.mjs");
    return runConsumerNotes(rest, { output });
  }
  if (subcommand === "init") {
    const { runConsumerInit } = await import("./consumer-init.mjs");
    return runConsumerInit(rest, { output });
  }
  if (subcommand === "scaffold") {
    const { runConsumerScaffold } = await import("./consumer-scaffold.mjs");
    return runConsumerScaffold(rest, { output });
  }
  if (subcommand !== "check") throw new Error(`Unknown consumer command ${subcommand}\n${CONSUMER_HELP}`);
  const options = parseCheckArguments(rest);
  if (options.help) {
    output(CONSUMER_HELP);
    return;
  }
  const result = await checkConsumer(options.root || process.cwd(), { app: options.app, base: options.base });
  if (options.json) output(JSON.stringify(result, null, 2));
  else output(checkReport(result));
  // The stock workflow previews only these apps; written before a scope failure throws.
  if (result.previewApps && env.GITHUB_OUTPUT) {
    await fs.appendFile(env.GITHUB_OUTPUT, `preview-apps=${JSON.stringify(result.previewApps)}\n`, "utf8").catch(() => {});
  }
  if (result.status !== "passed") {
    const error = new Error(`consumer check failed with ${result.errors.length} error${result.errors.length === 1 ? "" : "s"}`);
    error.result = result;
    throw error;
  }
  return result;
}

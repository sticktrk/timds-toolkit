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
// commit, the form the first consumers adopted. A third form has no pin at
// all: `designSystem: { "workspace": true, "systemId": ... }` is a site inside
// its Design System's own workspace (`site/timds.consumer.json`, written by
// `consumer scaffold emdash --workspace`), and the system is the nearest
// folder above the site that holds `timds.json` (workspace-site.mjs). Such a
// site reads the workspace's source directly, so nothing syncs or moves, and
// a branch change outside the site folder is the system's own (status
// `system`), judged by the system's check. This module reads and
// validates the manifest, resolves the pin (gitlink commit, the sync record,
// or the workspace above), and guards the design-surface scope of a branch diff for
// `timds consumer check`. The check also confirms that git carries what a
// clone needs (the manifest, the root package and lockfile, the installed
// files): a root file an ignore pattern excludes passes locally and is absent
// from the commit. The scope is judged against the manifest at the
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
import { isDeepStrictEqual } from "node:util";
import { consumerToolkitLockRemedy, planConsumerToolkitLock, PUBLISHED_CONSUMER_MINIMUM_VERSION, toolkitVersionOlderThan } from "./consumer-install.mjs";
import { parseCssTokens, resolveTokens } from "./tokens.mjs";
import { assertBinaryInstallation, readBinaryInstallation } from "./binary-installation.mjs";
import { WORKSPACE_PIN_MODE, findDesignSystemAbove, isWorkspaceDesignSystem } from "./workspace-site.mjs";

export const CONSUMER_MANIFEST_FILE = "timds.consumer.json";
/** The record `consumer sync` leaves in the bundle directory: which version is there and which files. */
export const CONSUMER_BUNDLE_RECORD_FILE = ".timds-bundle.json";
/** Where `consumer init` records the managed files it installed (also read by upgrade). */
export const CONSUMER_INSTALLATION_PATH = ".timds/installation.json";
/** Where a published system sits unless `designSystem.url` says otherwise: `<base>/<systemId>/artifact`. */
export const DEFAULT_PUBLISHED_BASE_URL = "https://design-systems.timds.com";
export const CONSUMER_VIEWPORTS = Object.freeze(["desktop", "tablet", "phone"]);
export const CONSUMER_SCHEMES = Object.freeze(["light", "dark"]);

/** The designer's skill: a change inside the design surface of the product. */
export const CONSUMER_SKILL_NAME = "timds-consume-design-system";
/** The developer's counterpart: move the pin to a new release and port the designs that changed. */
export const CONSUMER_UPDATE_SKILL_NAME = "timds-update-design-system";
/** Every consumer skill `consumer init` renders and `upgrade` refreshes; the always-allowed paths derive from it. */
export const CONSUMER_SKILL_NAMES = Object.freeze([CONSUMER_SKILL_NAME, CONSUMER_UPDATE_SKILL_NAME]);

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
  CONSUMER_INSTALLATION_PATH,
  ...CONSUMER_SKILL_NAMES.map((name) => `.agents/skills/${name}/**`),
  ".github/workflows/timds-consumer-preview.yml",
  ".github/workflows/timds-designer-change.yml",
  ".claude/launch.json",
  ".mcp.json",
]);

const CONSUMER_HELP = `Usage:
  timds consumer check [--root PATH] [--app NAME] [--base REF] [--allow-pin-update LABEL] [--require-token=--NAME]... [--no-fix] [--json]
  timds consumer register [--portal-url URL] [--repository OWNER/REPO] [--base-branch REF] [--delivery auto|approve] [--notify] [--surface PATH]... [--root PATH] [--json]
  timds consumer updates [LABEL] [--portal-url URL] [--consumer-id UUID] [--root PATH] [--json]
  timds consumer sync [--root PATH]
  timds consumer update [VERSION] [--root PATH]
  timds consumer update --draft NAME [--portal-url URL] [--root PATH]
  timds consumer migrate [--version VERSION] [--url URL] [--root PATH] [--force] [--skip-sync]
  timds consumer preview [--app NAME] [--root PATH] [--output DIR] [--base REF] [--no-install] [--ready-timeout SECONDS] [--publish] [--pull-request N] [--portal-url URL]
  timds consumer init [--root PATH] [--system ID [--version VERSION] [--url URL]] [--force] [--skip-install] [--portal-url URL] [--draft-preview]
  timds consumer scaffold emdash --root PATH --design-system GIT_URL [--platform cloudflare|node] [--stylesheet PATH]... [--site-url URL] [--portal-url URL] [--skip-install]
  timds consumer scaffold emdash --workspace [--root PATH] [--skip-install]
  timds consumer notes [--root PATH] [--app NAME] [--pull-request N] [--all] [--json] [--portal-url URL]
  timds consumer notes resolve ID [ID...] [--commit SHA] [--dismiss] [--root PATH] [--portal-url URL]

Use npm run timds -- consumer COMMAND in npm repositories, or timds-cli consumer
COMMAND in binary repositories. Append --help or -h to a subcommand for details;
help does not require a workspace. preview and notes require --app when several
apps exist; check without --app checks all apps. Only check, register, updates,
and notes without resolve support --json. --require-token,
--surface and --stylesheet may repeat. init --version/--url require --system.
update without VERSION selects the current published release; --draft replaces
only the ignored bundle. --allow-pin-update LABEL requires --base and permits
only that exact published version to change, preserving all other manifest
values. --draft-preview explicitly adds product-owned browser integration.

A --workspace scaffold lives in site/ of its Design System and has no pin.
Run consumer commands with --root site (design-system/site when embedded),
using the enclosing system's toolkit. check may rewrite matching color/font
literals there by default, including with --json; --no-fix reports without
rewriting. It also validates declared sections and their seed. sync, update,
migrate, register and init need a pin and do not apply to workspace sites.
Run upgrade and installation adoption at the Design System root; they never
refresh the site's source or its scaffolded consumer skills. --existing is
withdrawn; use scaffold emdash --workspace for a system's own site.`;

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

const systemIdSchema = z.string({ error: "designSystem.systemId is required (the Design System's systemId from its timds.json)" })
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{1,159}$/, "designSystem.systemId must use letters, numbers, dots, slashes, underscores, or hyphens");

// A pinned system: a published version, or (without one) a git submodule at `path`.
const pinnedDesignSystemSchema = z.object({
  path: relativePath("designSystem.path").default("design-system"),
  systemId: systemIdSchema,
  // Published mode: the version the product is built against (or `current`
  // to follow every release at the next install) and, optionally, where the
  // system is published. Absent, the path is a git submodule.
  version: z.string().regex(/^(?:current|[A-Za-z0-9][A-Za-z0-9._-]{0,99})$/, 'designSystem.version must be a published version label such as "1.4.0", or "current"').optional(),
  url: publishedUrl.optional(),
}, { error: "designSystem must be an object with path and systemId" }).strict().superRefine((designSystem, context) => {
  if (designSystem.url && !designSystem.version) {
    context.addIssue({ code: "custom", path: ["url"], message: "designSystem.url applies to a published pin; add designSystem.version" });
  }
});

// A site inside its Design System's workspace: no path, no version, no url,
// because the system is the nearest folder above the site holding timds.json.
const WORKSPACE_REFUSED_KEYS = Object.freeze({
  path: "the Design System is the nearest folder above the site that holds timds.json",
  version: "a workspace site reads the system's source directly, so there is no version to pin",
  url: "a workspace site reads the system's source directly, so nothing is fetched from a published prefix",
});
const workspaceDesignSystemSchema = z.object({
  workspace: z.literal(true, { error: 'designSystem.workspace must be true (a site inside its Design System\'s workspace); remove it to pin the system with designSystem.version or a submodule at designSystem.path' }),
  systemId: systemIdSchema,
  path: z.unknown().optional(),
  version: z.unknown().optional(),
  url: z.unknown().optional(),
}, { error: "designSystem must be an object with workspace and systemId" }).strict().superRefine((designSystem, context) => {
  for (const [key, reason] of Object.entries(WORKSPACE_REFUSED_KEYS)) {
    if (designSystem[key] !== undefined) {
      context.addIssue({ code: "custom", path: [key], message: `designSystem.${key} does not apply with designSystem.workspace: ${reason}. Remove it.` });
    }
  }
}).transform(({ workspace, systemId }) => ({ workspace, systemId }));

function manifestSchema(designSystemSchema) {
  return z.object({
    $schema: z.string().optional(),
    schemaVersion: z.literal(1, { error: `${CONSUMER_MANIFEST_FILE} schemaVersion must be 1` }),
    designSystem: designSystemSchema,
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
}

const pinnedManifestSchema = manifestSchema(pinnedDesignSystemSchema);
const workspaceManifestSchema = manifestSchema(workspaceDesignSystemSchema);

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
  // Any `workspace` key selects the workspace form, so `workspace: false`
  // is refused there rather than read as an unknown field of a pin.
  const designSystem = value && typeof value === "object" ? value.designSystem : null;
  const workspaceForm = Boolean(designSystem && typeof designSystem === "object" && !Array.isArray(designSystem) && Object.hasOwn(designSystem, "workspace"));
  const result = (workspaceForm ? workspaceManifestSchema : pinnedManifestSchema).safeParse(value);
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

/** `workspace` for a site inside its Design System's workspace, `published` when the manifest pins a version, else `submodule`. */
export function consumerPinMode(designSystem) {
  if (isWorkspaceDesignSystem(designSystem)) return WORKSPACE_PIN_MODE;
  return designSystem?.version ? "published" : "submodule";
}

/** The prefix a published system's derived layer and bundle sit under. */
export function publishedBaseUrl(designSystem) {
  return designSystem.url || `${DEFAULT_PUBLISHED_BASE_URL}/${designSystem.systemId}/artifact`;
}

// ---------------------------------------------------------------------------
// Repository and Design System resolution

function run(command, args, cwd, { input = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"] });
    if (input !== null) {
      // A child that exits before reading its input (git outside a work tree)
      // closes the pipe; without a listener that write is an unhandled EPIPE.
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
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

const git = (args, cwd, options) => run("git", args, cwd, options);

/**
 * The paths among `paths` (relative to `repoRoot`) that an ignore pattern
 * keeps out of git, each with the pattern and where it comes from
 * (`.gitignore:12 /package-lock.json`). A tracked file is never reported,
 * whatever the patterns say: the result names only files the next `git add`
 * would skip. A negated match is a kept file, not an ignored one. Empty
 * outside a git work tree.
 */
export async function gitIgnoredPaths(repoRoot, paths) {
  const unique = [...new Set(paths)];
  if (!unique.length) return [];
  const result = await git(["check-ignore", "--verbose", "--stdin", "-z"], repoRoot, { input: unique.map((filePath) => `${filePath}\0`).join("") });
  // 0: something is ignored; 1: nothing is; anything else is not a work tree.
  if (result.code !== 0) return [];
  const fields = result.stdout.split("\0");
  const ignored = [];
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const [source, line, pattern, filePath] = fields.slice(index, index + 4);
    if (!pattern || pattern.startsWith("!")) continue;
    ignored.push({ path: filePath, source, line: Number(line), pattern });
  }
  return ignored;
}

/** Which of `paths` git tracks (in the index), or null outside a git work tree. */
export async function gitTrackedPaths(repoRoot, paths) {
  const unique = [...new Set(paths)];
  if (!unique.length) return new Set();
  const result = await git(["ls-files", "-z", "--", ...unique], repoRoot);
  if (result.code !== 0) return null;
  return new Set(result.stdout.split("\0").filter(Boolean));
}

/** The realpath of the git top level containing `start`, or null outside a work tree. */
async function gitTopLevel(start) {
  const result = await git(["rev-parse", "--show-toplevel"], start);
  if (result.code !== 0 || !result.stdout.trim()) return null;
  return fs.realpath(path.resolve(result.stdout.trim())).catch(() => path.resolve(result.stdout.trim()));
}

/** The nearest folder at or above `from` holding the manifest, never above `top` (when given). */
function nearestManifestFolder(from, top) {
  let current = from;
  while (true) {
    if (existsSync(path.join(current, CONSUMER_MANIFEST_FILE))) return current;
    if (top && current === top) return null;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * The root of the consumer repository containing `start`, or null when it is
 * not one: the nearest folder at or above `start` that holds
 * `timds.consumer.json`. Inside git the search never climbs past the
 * toplevel, so a Design System submodule checked out inside a product is
 * still its own repository; it may stop below it, which is where a workspace
 * site keeps its manifest (`site/timds.consumer.json`). The search only goes
 * up, so a Design System workspace root with a site below it is not a
 * consumer root. `timds upgrade` uses this to route consumers away from the
 * design-system workspace loader.
 */
export async function findConsumerManifestRoot(start = process.cwd()) {
  const resolved = path.resolve(start);
  if (!existsSync(resolved)) return null;
  const top = await gitTopLevel(resolved);
  if (top) return nearestManifestFolder(await fs.realpath(resolved), top);
  return nearestManifestFolder(resolved, null);
}

async function findConsumerRoot(start) {
  const resolved = path.resolve(start);
  const top = existsSync(resolved) ? await gitTopLevel(resolved) : null;
  if (top) return nearestManifestFolder(await fs.realpath(resolved), top) ?? top;
  return nearestManifestFolder(resolved, null) ?? resolved;
}

/**
 * The parsed manifest at `consumerRoot` when it declares the workspace form,
 * else null (absent, unreadable, or a pinned form). Unvalidated, so callers
 * that only route (upgrade, binary adoption) can refuse with the right advice
 * before `loadConsumer` would validate it.
 */
export async function readWorkspaceSiteManifest(consumerRoot) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(consumerRoot, CONSUMER_MANIFEST_FILE), "utf8"));
    return isWorkspaceDesignSystem(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Why a repository-level command (`timds upgrade`, `installation adopt
 * --binary`, `consumer init`) refuses a workspace site at `siteRoot`, and
 * where to run it instead: the workspace root, whose toolkit the site uses.
 */
export function workspaceSiteRefusal(siteRoot, command) {
  const systemRoot = findDesignSystemAbove(siteRoot);
  const site = systemRoot ? path.relative(systemRoot, siteRoot).split(path.sep).join("/") : path.basename(siteRoot);
  return `${siteRoot} is a site inside a Design System workspace (designSystem.workspace in ${site}/${CONSUMER_MANIFEST_FILE}); it has no toolkit, pin, or consumer installation of its own. Run ${command} at the workspace root${systemRoot ? ` (${systemRoot})` : ""} instead: the site uses that workspace's toolkit. The site's templates are recorded in ${site}/.timds/emdash.json.`;
}

/**
 * Where the toolkit installation record of the consumer at `consumerRoot`
 * lives: the consumer itself, or for a workspace site the Design System
 * above it, whose toolkit the site uses (the site declares none).
 */
export async function consumerInstallationRoot(consumerRoot) {
  if (!(await readWorkspaceSiteManifest(consumerRoot))) return consumerRoot;
  return findDesignSystemAbove(consumerRoot) ?? consumerRoot;
}

/**
 * The gitlink commit the index pins at `designSystemPath`, or null. The
 * index is what the next commit will pin, so a submodule staged for removal
 * (`consumer migrate`) is already gone here; HEAD is consulted only when the
 * index cannot be read.
 */
async function gitlinkCommit(repoRoot, designSystemPath) {
  const staged = await git(["ls-files", "--stage", "--", designSystemPath], repoRoot);
  if (staged.code === 0) {
    const match = staged.stdout.trim().match(/^160000\s+([0-9a-f]{7,64})\s+\d\t/m);
    return match ? match[1] : null;
  }
  const tree = await git(["ls-tree", "HEAD", "--", designSystemPath], repoRoot);
  if (tree.code === 0) {
    const match = tree.stdout.trim().match(/^160000\s+commit\s+([0-9a-f]{7,64})\t/m);
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
 * The root files a consumer commit has to carry for a clone to work: the
 * manifest, the root package.json and (for a published pin, whose bundle only
 * arrives through its postinstall) the lockfile, plus whatever init installed
 * and recorded in `.timds/installation.json`. `required` names the ones whose
 * absence alone breaks a clone.
 */
async function consumerCommittedFiles(repoRoot, mode, binary = false) {
  const lockFile = existsSync(path.join(repoRoot, "npm-shrinkwrap.json")) ? "npm-shrinkwrap.json" : "package-lock.json";
  if (mode === WORKSPACE_PIN_MODE) {
    // A workspace site is its own package (not an npm workspace of the root)
    // that a clone installs from its own lockfile. It has no installation
    // record: the workspace's toolkit and managed files serve it, and the
    // Design System's own check judges those.
    return { files: [CONSUMER_MANIFEST_FILE, "package.json", lockFile], required: new Set(["package.json", lockFile]) };
  }
  const files = new Set([CONSUMER_MANIFEST_FILE, "package.json", lockFile, CONSUMER_INSTALLATION_PATH]);
  const required = new Set(binary ? [CONSUMER_INSTALLATION_PATH] : mode === "published" ? ["package.json", lockFile] : []);
  let record = null;
  try {
    record = JSON.parse(await fs.readFile(path.join(repoRoot, CONSUMER_INSTALLATION_PATH), "utf8"))?.consumer;
  } catch {
    // Absent or unreadable: upgrade reports that; only recorded files are checked here.
  }
  if (record && typeof record === "object") {
    for (const relative of Object.keys(record.managedFiles ?? {})) if (isSafeRelativePath(relative)) files.add(relative);
    if (Object.keys(record.launchConfigurations ?? {}).length) files.add(".claude/launch.json");
    if (Object.keys(record.mcpServers ?? {}).length) files.add(".mcp.json");
  }
  return { files: [...files], required };
}

/**
 * Load the consumer repo at or above `repoRootInput`: the validated manifest
 * and the pinned Design System (`root`, `mode`, gitlink `commit` or null, the
 * sync `record` or null, `present`). In published mode `present` means the
 * bundle has been synced; in submodule mode, that the checkout exists. In the
 * workspace form `repoRoot` is the site folder and the system is the nearest
 * folder above it holding `timds.json`: `{ mode: "workspace", workspace:
 * true, systemId, root, path }` with `path` relative to the site (`..`),
 * `root` and `path` null when no folder above holds one, `present` whether
 * it does, and no version, url, commit, or record. `binaryInstallation` is
 * that workspace's, whose toolkit the site uses.
 */
export async function loadConsumer(repoRootInput = process.cwd()) {
  const repoRoot = await findConsumerRoot(repoRootInput);
  await assertBinaryInstallation(await consumerInstallationRoot(repoRoot));
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
  const mode = consumerPinMode(manifest.designSystem);
  if (mode === WORKSPACE_PIN_MODE) {
    const root = findDesignSystemAbove(repoRoot);
    const designSystem = {
      mode,
      workspace: true,
      systemId: manifest.designSystem.systemId,
      root,
      path: root ? path.relative(repoRoot, root).split(path.sep).join("/") || "." : null,
      version: null,
      url: null,
      commit: null,
      record: null,
      linked: false,
      present: Boolean(root) && existsSync(path.join(root, "timds.json")),
    };
    const { workspaceSectionApps } = await import("./consumer-scaffold-workspace.mjs");
    const apps = await workspaceSectionApps(repoRoot, manifest.apps, root);
    return { repoRoot, manifestPath, manifest, rawManifest: parsed, apps, designSystem, binaryInstallation: root ? await readBinaryInstallation(root) : null };
  }
  const designSystemRoot = path.resolve(repoRoot, manifest.designSystem.path);
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
  return { repoRoot, manifestPath, manifest, rawManifest: parsed, apps: manifest.apps, designSystem, binaryInstallation: await readBinaryInstallation(repoRoot) };
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
    if (designSystemPath && filePath === designSystemPath && entry[0] === " ") continue;
    paths.add(filePath);
  }
  return [...paths].sort();
}

/**
 * The manifest the scope is judged against: the one at the merge base, so a
 * branch cannot widen its own design surface. `null` when the base has no
 * manifest (the branch adopts TimDS) or an unreadable one. `prefix` is the
 * consumer's folder below the git top level (`site/` for a workspace site,
 * empty at the top), so the manifest is read at its real path.
 */
async function manifestAtBase(repoRoot, base, prefix = "") {
  const mergeBase = await git(["merge-base", base, "HEAD"], repoRoot);
  if (mergeBase.code !== 0 || !mergeBase.stdout.trim()) return { manifest: null, missing: false };
  const shown = await git(["show", `${mergeBase.stdout.trim()}:${prefix}${CONSUMER_MANIFEST_FILE}`], repoRoot);
  if (shown.code !== 0) return { manifest: null, missing: true };
  try {
    const rawManifest = JSON.parse(shown.stdout);
    return { manifest: validateConsumerManifest(rawManifest), rawManifest, missing: false };
  } catch {
    return { manifest: null, missing: false };
  }
}

/** The consumer folder's path below the git top level, with a trailing slash (`site/`), or empty at the top or outside git. */
async function gitPrefix(repoRoot) {
  const result = await git(["rev-parse", "--show-prefix"], repoRoot);
  return result.code === 0 ? result.stdout.trim() : "";
}

const validRequiredTokens = (required) => Array.isArray(required) && required.every((name) => typeof name === "string" && /^--[a-zA-Z_][a-zA-Z0-9_-]*$/.test(name));
const INVALID_REQUIRED_TOKENS = "Required tokens must be CSS custom property names, such as --focus-ring";

/** The errors for `required` against resolved token records: `missing(name)` words a token none declares. */
function requiredTokenErrors(tokens, required, missing) {
  const errors = [];
  for (const name of [...new Set(required)]) {
    const matches = tokens.filter((token) => token.name === name);
    if (!matches.length) errors.push(missing(name));
    else {
      const unresolved = [...new Set(matches.flatMap((token) => token.unresolved || (token.resolved.includes("var(") ? token.references : [])))];
      if (unresolved.length) errors.push(`Required Design System token ${name} has unresolved aliases: ${unresolved.join(", ")}`);
      if (matches.some((token) => !token.resolved)) errors.push(`Required Design System token ${name} has an empty definition`);
    }
  }
  return errors;
}

/**
 * Required tokens in the workspace form, answered from what each selected
 * app loads (`workspaceTokenInventory`, the two-way check's index: the
 * stylesheets the site's website design links, the compiled tokens when it
 * links /tokens.css, and the system stylesheets the site imports), never
 * from every stylesheet in the system.
 */
async function checkWorkspaceRequiredTokens(consumer, designSystem, required, selected) {
  if (!validRequiredTokens(required)) return [INVALID_REQUIRED_TOKENS];
  if (!required.length) return [];
  const { workspaceTokenInventory } = await import("./consumer-workspace-check.mjs");
  const errors = [];
  for (const name of selected) {
    const app = resolveConsumerApp(consumer, name);
    if (!existsSync(app.cwd)) continue;
    let inventory;
    try {
      inventory = await workspaceTokenInventory({ siteRoot: app.cwd, designSystemRoot: designSystem.root, designSurface: app.designSurface, protected: app.protected });
    } catch (error) {
      errors.push(`App "${name}": the required tokens could not be read from the workspace Design System: ${error.message}`);
      continue;
    }
    const design = inventory.design;
    const loads = inventory.stylesheets.length || inventory.tokensJson
      ? [...(inventory.tokensJson ? ["/tokens.css (the compiled tokens)"] : []), ...inventory.stylesheets].join(", ")
      : "no Design System stylesheet";
    errors.push(...requiredTokenErrors(inventory.tokens, required, (token) => {
      const declared = inventory.unloaded.get(token);
      if (declared) {
        const fix = declared.startsWith("tokens")
          ? `link /tokens.css from ${design?.shell ?? "the design's layout"} (the system must run the starter build to serve it)`
          : `link /${declared.replace(/^src\//, "")} from ${design?.shell ?? "the design's layout"}`;
        return `Required Design System token ${token} is declared in the workspace Design System (${declared}), but app "${name}" does not load it: the site loads ${loads}${design ? ` through the website design "${design.id}"` : ""}. Either ${fix}, or require a token the site loads.`;
      }
      return `Missing required Design System token ${token}: neither what app "${name}" loads (${loads}) nor any other stylesheet or token of the workspace Design System declares it. Add it to the Design System in this change, in a stylesheet the site loads or its tokens (tokens/ or tokens.json, served as /tokens.css), then rerun.`;
    }));
  }
  return errors;
}

/** Read only local Design System CSS; never follow a bundle path outside its root. */
async function checkRequiredTokens(designSystem, required) {
  if (!validRequiredTokens(required)) return [INVALID_REQUIRED_TOKENS];
  if (!required.length) return [];
  let paths;
  if (designSystem.mode === "published" && !designSystem.linked) {
    paths = (designSystem.record?.files || []).map((file) => file.path);
  } else {
    const listed = await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.css"], designSystem.root);
    if (listed.code !== 0) return ["Could not read Design System stylesheets for required tokens"];
    paths = listed.stdout.split("\0").filter(Boolean);
  }
  const records = [];
  const errors = [];
  const root = await fs.realpath(designSystem.root).catch(() => null);
  for (const relative of [...new Set(paths)].filter((file) => typeof file === "string" && file.endsWith(".css")).sort()) {
    if (!isSafeRelativePath(relative)) { errors.push(`Unsafe Design System stylesheet path: ${relative}`); continue; }
    const target = path.join(designSystem.root, relative);
    const real = await fs.realpath(target).catch(() => null);
    if (!root || !real || !real.startsWith(`${root}${path.sep}`)) {
      errors.push(`Cannot read Design System stylesheet inside the bundle: ${relative}`);
      continue;
    }
    try { records.push(...parseCssTokens(await fs.readFile(real, "utf8"), { source: relative })); }
    catch { errors.push(`Could not read Design System stylesheet: ${relative}`); }
  }
  // Match the parser's scope model; later declarations in a scope replace earlier ones.
  // This verifies available definitions and aliases, not product imports or browser cascade.
  const effective = new Map();
  for (const record of records) effective.set(JSON.stringify([record.condition, record.selector, record.name]), record);
  const tokens = resolveTokens([...effective.values()]);
  errors.push(...requiredTokenErrors(tokens, required, (name) => `Missing required Design System token ${name}. Report the gap to the designer, then sync the updated draft or release.`));
  return errors;
}

/**
 * Validate the consumer pin, required tokens, app paths, and optional branch
 * scope. In the workspace form there is no pin: the check confirms a Design
 * System sits above the site, and with `base` each change carries `sitePath`
 * (relative to the site, the folder the manifest's globs are relative to) and
 * `path` (relative to the repository top level, as git names it); a change
 * outside the site folder has status `system` and is left to the system's
 * own check. `options.fix === false` (`--no-fix`) asks the workspace check
 * to report without rewriting.
 */
export async function checkConsumer(repoRootInput = process.cwd(), options = {}) {
  const errors = [];
  const warnings = [];
  if (options.allowPinUpdate !== undefined && (!options.base || typeof options.allowPinUpdate !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(options.allowPinUpdate) || ["current", "latest"].includes(options.allowPinUpdate))) {
    throw new Error("--allow-pin-update requires --base and one immutable published release label");
  }
  let consumer;
  try {
    consumer = await loadConsumer(repoRootInput);
  } catch (error) {
    return { status: "failed", errors: [error.message], warnings, apps: [], repoRoot: null, designSystem: null, changes: [], previewApps: null };
  }
  const { designSystem, manifest, repoRoot } = consumer;
  const workspace = designSystem.mode === WORKSPACE_PIN_MODE;
  if (workspace && options.allowPinUpdate !== undefined) {
    throw new Error(`--allow-pin-update applies to a published pin, and this site has none: ${CONSUMER_MANIFEST_FILE} declares designSystem.workspace, so the site reads its Design System's workspace directly and a system change reaches it at the next build. Run timds consumer check --base ${options.base} without --allow-pin-update.`);
  }
  const binary = Boolean(consumer.binaryInstallation);
  const invocation = binary ? "timds-cli" : "npm run timds --";
  // How messages name the system: a pin's path, or the workspace the site sits in.
  const systemLabel = workspace ? "the workspace Design System" : designSystem.path;
  const selected = options.app ? [resolveConsumerApp(consumer, options.app).name] : Object.keys(manifest.apps);
  if (!workspace) errors.push(...await checkRequiredTokens(designSystem, options.requireTokens ?? []));
  else if (designSystem.present) errors.push(...await checkWorkspaceRequiredTokens(consumer, designSystem, options.requireTokens ?? [], selected));

  if (workspace) {
    // No pin, no bundle record, no gitlink, and no toolkit lock: the site
    // uses the workspace's toolkit and reads the system's source directly.
    if (!designSystem.present) {
      errors.push(`No folder above ${repoRoot} holds timds.json. ${CONSUMER_MANIFEST_FILE} declares designSystem.workspace, so this site must sit inside its Design System's workspace (as site/ beside timds.json, where timds consumer scaffold emdash --workspace puts it). Move the folder there, or pin the system instead with designSystem.version (timds consumer init --system ${designSystem.systemId}).`);
    } else {
      try {
        const dsManifest = JSON.parse(await fs.readFile(path.join(designSystem.root, "timds.json"), "utf8"));
        const dsId = String(dsManifest.systemId || dsManifest.system_id || dsManifest.client || "").trim();
        if (dsId && dsId !== designSystem.systemId) {
          warnings.push(`${CONSUMER_MANIFEST_FILE} designSystem.systemId is ${designSystem.systemId} but the workspace's timds.json (${designSystem.root}) declares ${dsId}`);
        }
      } catch {
        warnings.push(`${designSystem.root}/timds.json could not be read as JSON`);
      }
    }
  } else if (designSystem.mode === "published") {
    try {
      const locked = binary ? { version: null } : await planConsumerToolkitLock(repoRoot);
      if (locked.version && toolkitVersionOlderThan(locked.version, PUBLISHED_CONSUMER_MINIMUM_VERSION)) {
        errors.push(`${locked.path} locks @dtconcepts/timds@${locked.version}, which predates designSystem.version/url and consumer sync (requires ${PUBLISHED_CONSUMER_MINIMUM_VERSION} or newer). Refresh the lock before npm ci runs postinstall. Run: ${consumerToolkitLockRemedy()}`);
      }
    } catch (error) {
      errors.push(error.message);
    }
    // A published pin keeps no Design System bytes in git: the sync record says what was fetched.
    if (designSystem.commit) {
      errors.push(`${designSystem.path} is still a git submodule but ${CONSUMER_MANIFEST_FILE} pins a published version. Remove the submodule (git rm -r --cached ${designSystem.path}, drop it from .gitmodules) so ${invocation} consumer sync can fetch the bundle.`);
    }
    if (designSystem.linked) {
      if (!designSystem.present) errors.push(`${designSystem.path} is a symbolic link but its target has no timds.json; point it at a Design System checkout.`);
      else warnings.push(`${designSystem.path} is a local Design System checkout; checking the working copy instead of published pin ${designSystem.version}.`);
    } else if (!designSystem.record) {
      errors.push(`${designSystem.path} has no synced Design System bundle. Run: ${invocation} consumer sync${binary ? "" : " (npm install runs it from postinstall)"}`);
    } else {
      const record = designSystem.record;
      if (record.draft) warnings.push(`Local draft ${record.draft} (${record.revision}) overrides published pin ${designSystem.version}; consumer sync restores the production pin.`);
      if (designSystem.version !== "current" && record.version !== designSystem.version) {
        errors.push(`${designSystem.path} holds Design System version ${record.version ?? "unknown"} but ${CONSUMER_MANIFEST_FILE} pins ${designSystem.version}. Run: ${invocation} consumer sync`);
      }
      if (record.systemId && record.systemId !== designSystem.systemId) {
        warnings.push(`${CONSUMER_MANIFEST_FILE} designSystem.systemId is ${designSystem.systemId} but the synced bundle belongs to ${record.systemId}`);
      }
      for (const file of Array.isArray(record.files) ? record.files : []) {
        if (typeof file?.path !== "string" || file.path.split("/").some((segment) => !segment || segment === "..")) continue;
        if (!existsSync(path.join(designSystem.root, ...file.path.split("/")))) {
          errors.push(`${designSystem.path}/${file.path} is missing from the synced bundle. Run: ${invocation} consumer sync`);
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

  // What a clone needs is only there when git carries it. A root file an
  // ignore pattern excludes exists locally, so every local command passes,
  // while the commit leaves it out and CI fails on the install. An untracked
  // file is the same hazard one step earlier, so it is named too.
  const committed = await consumerCommittedFiles(repoRoot, designSystem.mode, binary);
  const present = committed.files.filter((file) => existsSync(path.join(repoRoot, file)));
  for (const file of committed.required) {
    if (!present.includes(file)) errors.push(workspace ? `${file} is missing. A workspace site is its own package, installed from its own lockfile by a clone and by a platform build: run npm install in ${repoRoot} and commit package.json and the lockfile.` : binary ? `${file} is missing. Commit the exact binary installation record before using this consumer.` : `${file} is missing. A published pin is fetched by npm install (postinstall timds consumer sync), so the root package.json and its lockfile must be committed. Run timds consumer init --system ${designSystem.systemId} and commit what it writes.`);
  }
  const ignored = await gitIgnoredPaths(repoRoot, present);
  for (const entry of ignored) {
    errors.push(`${entry.path} is ignored by git (${entry.source}:${entry.line} ${entry.pattern}), so it is never committed and a clone will not have it. Edit ${entry.source} so the path is no longer excluded, then git add ${entry.path}.`);
  }
  const tracked = await gitTrackedPaths(repoRoot, present);
  if (tracked) {
    const ignoredPaths = new Set(ignored.map((entry) => entry.path));
    const untracked = present.filter((file) => !tracked.has(file) && !ignoredPaths.has(file));
    if (untracked.length) warnings.push(`Not tracked by git yet (commit them so a clone has them):\n${untracked.map((file) => `- ${file}`).join("\n")}`);
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
        warnings.push(`${designSystem.path} has no recorded website designs; republish the pinned release with the current toolkit and run ${invocation} consumer sync to check the preview.designs pairings`);
      }
    } else {
      const { readDesignCatalog } = await import("./designs.mjs");
      try {
        designCatalog = await readDesignCatalog(designSystem.root);
      } catch (error) {
        warnings.push(`${systemLabel} website designs could not be read: ${error.message}`);
      }
    }
  }

  const apps = [];
  for (const name of selected) {
    const app = resolveConsumerApp(consumer, name);
    const cwdExists = existsSync(app.cwd);
    if (!cwdExists) errors.push(`App "${name}": cwd ${app.cwdRelative} does not exist`);
    if (workspace && cwdExists) {
      try {
        const { readWorkspaceSections, checkWorkspaceSectionSeed } = await import("./consumer-scaffold-workspace.mjs");
        const sections = await readWorkspaceSections(app.cwd);
        if (sections) await checkWorkspaceSectionSeed(app.cwd, sections);
      } catch (error) { errors.push(`App "${name}": ${error.message}`); }
    }
    if (designCatalog) {
      for (const [route, reference] of Object.entries(app.preview.designs || {})) {
        const { design: designId, route: designRoute } = parseDesignReference(reference);
        const design = designCatalog.designs.find((entry) => entry.id === designId);
        if (!designCatalog.exists) {
          errors.push(`App "${name}": preview.designs pairs ${route} with ${reference}, but ${systemLabel} has no src/designs/`);
        } else if (!design) {
          errors.push(`App "${name}": preview.designs pairs ${route} with ${reference}, but ${systemLabel} has no design ${designId} (designs: ${designCatalog.designs.map((entry) => entry.id).join(", ") || "none"})`);
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
    // A workspace site's diff is the whole repository's: git names paths from
    // the top level, the manifest's globs are relative to the site.
    const prefix = workspace ? await gitPrefix(repoRoot) : "";
    const paths = await changedPaths(repoRoot, options.base, workspace ? null : designSystem.path);
    const atBase = await manifestAtBase(repoRoot, options.base, prefix);
    const scopeManifest = atBase.manifest || manifest;
    const withoutVersion = value => ({ ...value, designSystem: Object.fromEntries(Object.entries(value.designSystem).filter(([key]) => key !== "version")) });
    const pinUpdateAllowed = !workspace && options.allowPinUpdate !== undefined && Boolean(atBase.manifest?.designSystem.version) && designSystem.mode === "published"
      && manifest.designSystem.version === options.allowPinUpdate
      && isDeepStrictEqual(withoutVersion(atBase.rawManifest), withoutVersion(consumer.rawManifest));
    if (options.allowPinUpdate !== undefined && !pinUpdateAllowed) errors.push("The approved pin update requires an existing published pin, the exact requested release label, and unchanged manifest metadata outside designSystem.version (including the Design System path, systemId and URL).");
    // A workspace site has no pin, so nothing is ever a pin move.
    const pinMoved = !workspace && Boolean(atBase.manifest) && JSON.stringify(atBase.manifest.designSystem) !== JSON.stringify(manifest.designSystem);
    if (atBase.manifest && JSON.stringify(atBase.manifest) !== JSON.stringify(manifest)) {
      warnings.push(`${CONSUMER_MANIFEST_FILE} changed on this branch; the design surface is judged against the manifest at ${options.base}. Changing the manifest needs a developer.`);
    }
    // A branch that adopts TimDS adds the submodule, or the manifest with a
    // published pin; afterwards the pin only moves by a developer decision.
    // In published mode the pin is a manifest field, so a moved version shows
    // as the manifest path with the pin status. A branch that adds a
    // workspace site adds the whole site folder.
    const adoption = atBase.missing && !workspace ? new Set([".gitmodules", designSystem.path]) : new Set();
    changes = paths.map((filePath) => {
      if (workspace) {
        // Outside the site folder is the Design System itself: its own check judges it.
        if (!filePath.startsWith(prefix)) return { path: filePath, sitePath: null, status: "system", app: null };
        const sitePath = filePath.slice(prefix.length);
        if (atBase.missing) return { path: filePath, sitePath, status: "allowed", app: null };
        return { path: filePath, sitePath, ...classifyConsumerPath(sitePath, scopeManifest) };
      }
      if (adoption.has(filePath)) return { path: filePath, status: "allowed", app: null };
      if (filePath === designSystem.path) return { path: filePath, status: "pin", app: null };
      if (filePath === CONSUMER_MANIFEST_FILE && pinMoved) return { path: filePath, status: "pin", app: null };
      return { path: filePath, ...classifyConsumerPath(filePath, scopeManifest) };
    });
    const outside = changes.filter((change) => change.status === "outside");
    const guarded = changes.filter((change) => change.status === "protected");
    if (changes.some((change) => change.status === "pin" && !(pinUpdateAllowed && change.path === CONSUMER_MANIFEST_FILE))) {
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
    // System pin or the manifest (routes, commands, the surface itself) moved,
    // or, for a workspace site, when the Design System itself changed.
    const manifestPath = (change) => (workspace ? change.sitePath : change.path) === CONSUMER_MANIFEST_FILE;
    const everyApp = atBase.missing || changes.some((change) => change.status === "pin" || change.status === "system" || manifestPath(change));
    const touched = new Set(changes.filter((change) => change.status === "allowed" && change.app).map((change) => change.app));
    previewApps = Object.keys(manifest.apps).filter((name) => everyApp || touched.has(name));
  }

  // The other direction, only where the site and its system are edited
  // together: a site style the system does not have. A literal that equals
  // exactly one token is rewritten to it (unless --no-fix); everything else is
  // a finding to resolve in the same change by adding to the system, so a
  // finding fails the check and a second run after the addition is clean.
  let workspaceCheck = null;
  if (workspace && designSystem.present) {
    const { checkWorkspaceSite, formatWorkspaceFindings, WORKSPACE_CHECK_SCHEMA_VERSION } = await import("./consumer-workspace-check.mjs");
    workspaceCheck = { schemaVersion: WORKSPACE_CHECK_SCHEMA_VERSION, fix: options.fix !== false, rewrites: [], findings: [], changedFiles: [], scanned: [], system: null };
    for (const name of selected) {
      const app = resolveConsumerApp(consumer, name);
      if (!existsSync(app.cwd)) continue;
      const inApp = (file) => (app.cwdRelative === "." ? file : `${app.cwdRelative}/${file}`);
      try {
        const found = await checkWorkspaceSite({
          siteRoot: app.cwd,
          designSystemRoot: designSystem.root,
          designSurface: app.designSurface,
          protected: app.protected,
          fix: options.fix !== false,
        });
        workspaceCheck.system ||= found.system;
        workspaceCheck.rewrites.push(...found.rewrites.map((rewrite) => ({ ...rewrite, file: inApp(rewrite.file), app: name })));
        workspaceCheck.findings.push(...found.findings.map((finding) => ({ ...finding, file: inApp(finding.file), app: name })));
        workspaceCheck.changedFiles.push(...found.changedFiles.map(inApp));
        workspaceCheck.scanned.push(...found.scanned.map(inApp));
      } catch (error) {
        errors.push(`App "${name}": the two-way check against the Design System could not run: ${error.message}`);
      }
    }
    const pending = workspaceCheck.rewrites.filter((rewrite) => !rewrite.applied);
    if (pending.length || workspaceCheck.findings.length) {
      errors.push(formatWorkspaceFindings({ ...workspaceCheck, rewrites: pending }));
    }
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
    ...(workspaceCheck ? { workspaceCheck } : {}),
  };
}

// ---------------------------------------------------------------------------
// CLI

const CHECK_BOOLEAN_FLAGS = new Set(["help", "json", "noFix"]);
const CHECK_VALUE_FLAGS = new Set(["app", "base", "root", "requireToken", "allowPinUpdate"]);

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
    if (name === "requireToken") {
      if (!/^--[a-zA-Z_][a-zA-Z0-9_-]*$/.test(next ?? "")) throw new Error("--require-token requires a CSS custom property name, such as --require-token=--focus-ring");
      (options.requireTokens ??= []).push(next);
    } else {
      if (next === undefined || next === "" || String(next).startsWith("-")) throw new Error(`--${rawName} requires a value`);
      options[name] = next;
    }
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
    lines.push(ds.mode === WORKSPACE_PIN_MODE
      ? `Design System: ${ds.systemId} in the workspace ${ds.present ? `at ${ds.root}` : "(no folder above the site holds timds.json)"} (no pin; the site reads its source)`
      : ds.mode === "published"
      ? `Design System: ${ds.systemId} at ${ds.path} (published, pinned ${ds.version}${ds.record?.version && ds.record.version !== ds.version ? `, synced ${ds.record.version}` : ""}${ds.present ? "" : ", not synced"})`
      : `Design System: ${ds.systemId} at ${ds.path} (${ds.commit ? `pinned ${ds.commit.slice(0, 12)}` : "not pinned"}${ds.present ? "" : ", not checked out"})`);
  }
  for (const app of result.apps) lines.push(`App ${app.name}: ${app.cwd} (${app.mode} preview)${app.cwdExists ? "" : " — missing"}`);
  if (result.changes.length) {
    const allowed = result.changes.filter((change) => change.status === "allowed").length;
    const system = result.changes.filter((change) => change.status === "system").length;
    lines.push(`Changes: ${result.changes.length} (${allowed} inside the design surface${system ? `, ${system} to the Design System, judged by its own check` : ""})`);
  }
  if (result.previewApps) lines.push(`Preview: ${result.previewApps.join(", ") || "no app's design surface, Design System pin, or manifest changed"}`);
  if (result.workspaceCheck) {
    const applied = result.workspaceCheck.rewrites.filter((rewrite) => rewrite.applied);
    if (applied.length) {
      lines.push(`Rewrote ${applied.length} literal${applied.length === 1 ? "" : "s"} to the Design System token with the same value (review and commit):`);
      for (const rewrite of applied) lines.push(`  ${rewrite.file}:${rewrite.line}:${rewrite.column} ${rewrite.property}: ${rewrite.from} -> ${rewrite.to}`);
    } else if (!result.workspaceCheck.findings.length && !result.workspaceCheck.rewrites.length) {
      lines.push(`Two-way check: ${result.workspaceCheck.scanned.length} site file${result.workspaceCheck.scanned.length === 1 ? "" : "s"} use only what the Design System declares.`);
    }
  }
  for (const warning of result.warnings) lines.push(`Warning: ${warning}`);
  for (const error of result.errors) lines.push(`Error: ${error}`);
  lines.push(result.status === "passed" ? "TimDS consumer check passed." : "TimDS consumer check failed.");
  return lines.join("\n");
}

/** `timds consumer <check|register|updates|sync|update|migrate|preview|init|scaffold|notes> ...` */
export async function runConsumerCli(args = [], { env = process.env, output = defaultOutput } = {}) {
  const [subcommand = "help", ...rawRest] = args;
  const rest = rawRest.map(value => value === "-h" ? "--help" : value);
  if (["help", "--help", "-h"].includes(subcommand)) {
    output(CONSUMER_HELP);
    return;
  }
  // Each subcommand still owns argument validation. Resolve just the shared
  // root before dispatch so a globally installed CLI cannot silently move
  // a consumer's selected release (including sync/update and preview).
  if (["check", "sync", "update", "migrate", "preview", "notes", "init", "register", "updates"].includes(subcommand) && !rest.some(value => ["--help", "-h"].includes(value))) {
    const rootFlag = rest.findLastIndex(value => /^--?root(?:=|$)/.test(value));
    const inlineRoot = rootFlag === -1 ? undefined : rest[rootFlag].split("=", 2)[1];
    const root = rootFlag === -1 ? process.cwd() : inlineRoot ?? rest[rootFlag + 1];
    if (root && !root.startsWith("--")) {
      const consumerRoot = await findConsumerManifestRoot(root);
      if (consumerRoot) await assertBinaryInstallation(await consumerInstallationRoot(consumerRoot), { allowNpm: subcommand === "init" });
    }
  }
  if (subcommand === "register" || subcommand === "updates") {
    const { runConsumerRegistration } = await import("./consumer-register.mjs");
    return runConsumerRegistration(subcommand, rest, { output });
  }
  if (subcommand === "sync" || subcommand === "update") {
    const { runConsumerSync, runConsumerUpdate } = await import("./consumer-sync.mjs");
    return subcommand === "sync" ? runConsumerSync(rest, { output }) : runConsumerUpdate(rest, { output });
  }
  if (subcommand === "migrate") {
    const { runConsumerMigrate } = await import("./consumer-migrate.mjs");
    return runConsumerMigrate(rest, { output });
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
  const result = await checkConsumer(options.root || process.cwd(), { app: options.app, base: options.base, requireTokens: options.requireTokens, allowPinUpdate: options.allowPinUpdate, fix: !options.noFix });
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

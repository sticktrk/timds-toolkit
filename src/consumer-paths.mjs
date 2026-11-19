// Shared by consumer check and the trusted workflow revision. Read Git objects as data.
import { execFile } from "node:child_process";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";

export const CONSUMER_MANIFEST_FILE = "timds.consumer.json";
export const CONSUMER_INSTALLATION_PATH = ".timds/installation.json";
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
  ".github/timds/consumer-pipeline.mjs",
  ".github/timds/consumer-paths.mjs",
  ".github/timds/product-build.sh",
  ".github/workflows/timds-consumer-preview.yml",
  ".github/workflows/timds-designer-change.yml",
  ".github/workflows/timds-designer-run.yml",
  ".claude/launch.json",
  ".mcp.json",
]);

export function normalizeRelativePath(value) {
  const normalized = path.posix.normalize(String(value).replace(/\\/g, "/")).replace(/\/+$/, "");
  return normalized === "" ? "." : normalized;
}

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

/** Designer automation may change only product design files, even with a root-wide surface. */
export function designerPathAllowed(file, manifest, appName) {
  const parts = file.split("/");
  if (parts.some(part => /^(?:\.git|\.github|\.gitattributes|\.gitmodules|\.gitignore|\.agents|\.claude|\.timds|\.mcp\.json|\.npmrc|node_modules|package\.json|package-lock\.json|npm-shrinkwrap\.json|bun\.lockb?|pnpm-lock\.yaml|yarn\.lock)$/i.test(part))) return false;
  const pin = normalizeRelativePath(manifest.designSystem.path || "design-system");
  if (file === pin || file.startsWith(pin + "/")) return false;
  for (const app of Object.values(manifest.apps)) {
    const inner = relativeToApp(file, app.cwd);
    if (inner && app.protected.some(pattern => matchesGlob(inner, pattern))) return false;
  }
  if (appName && !Object.hasOwn(manifest.apps, appName)) return false;
  const match = classifyConsumerPath(file, manifest, appName ? [appName] : Object.keys(manifest.apps));
  return match.app !== null && match.status === "allowed";
}

const run = promisify(execFile);
async function git(...args) {
  const { stdout } = await run("git", args, { maxBuffer: 8 * 1024 * 1024, encoding: "buffer" });
  return new TextDecoder("utf-8", { fatal: true }).decode(stdout);
}
async function manifestAt(sha) {
  const manifest = JSON.parse(await git("show", sha + ":" + CONSUMER_MANIFEST_FILE));
  for (const [name, app] of Object.entries(manifest.apps)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) throw new Error("Invalid consumer app name");
    app.cwd = normalizeRelativePath(app.cwd);
    app.protected ??= [];
  }
  return manifest;
}

/** Runs in a fresh trusted checkout. No program from the product revision is invoked. */
export async function checkWorkflowPaths(action, env) {
  for (const sha of [env.BASE_SHA, env.HEAD_SHA]) if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("Expected immutable Git revisions");
  const base = (await git("merge-base", env.BASE_SHA, env.HEAD_SHA)).trim();
  if (action === "designer") {
    const manifest = await manifestAt(env.BASE_SHA);
    // Enforce both the proposed edits and the complete PR against the default branch policy.
    for (const revision of new Set([env.HEAD_SHA, base])) {
      const entries = (await git("diff", "--cached", "--no-renames", "--no-ext-diff", "--raw", "-z", revision, "--")).split("\0");
      for (let index = 0; index < entries.length - 1; index += 2) {
        const [metadata, file] = entries.slice(index, index + 2);
        if (!/^:(?:100644|000000) (?:100644|000000) /.test(metadata) || !designerPathAllowed(file, manifest, env.APP)) {
          throw new Error("Designer patch changes a protected path or file mode: " + JSON.stringify(file));
        }
      }
    }
    return;
  }
  if (action !== "preview") throw new Error("Unknown workflow scope check");
  const head = await manifestAt(env.HEAD_SHA);
  const tree = await git("ls-tree", base, "--", CONSUMER_MANIFEST_FILE);
  const manifest = tree ? await manifestAt(base) : head;
  const pin = normalizeRelativePath(manifest.designSystem.path || "design-system");
  const files = (await git("diff", "--name-only", "--no-renames", "-z", base, env.HEAD_SHA, "--")).split("\0").filter(Boolean);
  const touched = new Set();
  let all = !tree, outside = Boolean(tree) && !isDeepStrictEqual(manifest.designSystem, head.designSystem);
  for (const file of files) {
    const result = classifyConsumerPath(file, manifest);
    if (file === pin || file === CONSUMER_MANIFEST_FILE) all = true;
    if (file === pin || result.status !== "allowed") outside = true;
    if (result.app && result.status === "allowed") touched.add(result.app);
  }
  const apps = Object.keys(head.apps).filter(name => all || touched.has(name));
  await appendFile(env.GITHUB_OUTPUT, `apps=${JSON.stringify(apps)}\nscope=${outside ? "outside" : "inside"}\n`);
}

// A site inside its Design System's workspace: where it sits and how each
// side finds the other.
//
// `timds consumer scaffold emdash --workspace` puts a site in `site/` of a
// Design System workspace. Its manifest is `site/timds.consumer.json` with
// `designSystem: { "workspace": true, "systemId": "..." }`: no path and no
// version, because the Design System is the nearest folder above the site
// that holds `timds.json`. The site reads that folder's stylesheets and
// tokens from their source paths, so there is no pin to move and nothing to
// sync.
//
// Boundary: this module only locates things, with `node:fs` and `node:path`
// and nothing else, so the viewer's dev server, the consumer commands and the
// scaffold can all import it. It never validates the manifest (consumer.mjs
// does) and never writes.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** The folder, relative to the Design System root, that holds a workspace site. */
export const WORKSPACE_SITE_DIRECTORY = "site";
/** The consumer manifest's name; consumer.mjs exports the same value as CONSUMER_MANIFEST_FILE. */
export const WORKSPACE_SITE_MANIFEST = "timds.consumer.json";
/** `designSystem.mode` (and `consumerPinMode`) for a site that reads its workspace. */
export const WORKSPACE_PIN_MODE = "workspace";
/** The URL prefix the Design System's dev server serves the site under. */
export const WORKSPACE_SITE_MOUNT = "/site";
/** The environment variable that carries that prefix to the site's dev server (Astro `base`). */
export const WORKSPACE_SITE_BASE_ENV = "TIMDS_SITE_BASE";
/**
 * The environment variable that carries the port the site's dev server must
 * listen on (Astro `server.port`); without it the site listens on the
 * manifest's `preview.port`, which is what `consumer preview` expects.
 */
export const WORKSPACE_SITE_PORT_ENV = "TIMDS_SITE_PORT";

/**
 * The consumer skills the workspace scaffold installs at the repository root,
 * beside the Design System's own. The same names as CONSUMER_SKILL_NAMES in
 * consumer.mjs (a test holds the two equal); repeated here so the system's
 * commands can name them without loading the consumer modules.
 */
export const WORKSPACE_SITE_SKILL_NAMES = Object.freeze(["timds-consume-design-system", "timds-update-design-system"]);

function readJsonObject(filePath) {
  try {
    const value = JSON.parse(readFileSync(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** True for a parsed manifest (or its `designSystem` block) in the workspace form. */
export function isWorkspaceDesignSystem(value) {
  const designSystem = value && typeof value === "object" && "designSystem" in value ? value.designSystem : value;
  return Boolean(designSystem && typeof designSystem === "object" && designSystem.workspace === true);
}

/**
 * The workspace site of the Design System at `designSystemRoot`, or null:
 * `{ root, manifestPath, manifest }` when `site/timds.consumer.json` exists
 * and declares the workspace form. `manifest` is the parsed file, unvalidated.
 */
export function findWorkspaceSite(designSystemRoot) {
  const root = path.join(path.resolve(designSystemRoot), WORKSPACE_SITE_DIRECTORY);
  const manifestPath = path.join(root, WORKSPACE_SITE_MANIFEST);
  if (!existsSync(manifestPath)) return null;
  const manifest = readJsonObject(manifestPath);
  return isWorkspaceDesignSystem(manifest) ? { root, manifestPath, manifest } : null;
}

/**
 * The workspace site's folder as a `/`-joined path relative to `repoRoot`
 * (`site` for a standalone system, `design-system/site` for an embedded one),
 * or null when the Design System at `designSystemRoot` has no workspace site.
 * The system's commands use it to leave the site alone: the site is its own
 * package, with its own build output, dependencies and local state.
 */
export function workspaceSitePath(repoRoot, designSystemRoot) {
  const site = findWorkspaceSite(designSystemRoot);
  if (!site) return null;
  return path.relative(path.resolve(repoRoot), site.root).split(path.sep).join("/");
}

/** True when the `/`-joined `relativePath` is `sitePath` or lies under it. */
export function isWorkspaceSitePath(relativePath, sitePath) {
  if (!sitePath) return false;
  const value = String(relativePath ?? "");
  return value === sitePath || value.startsWith(`${sitePath}/`);
}

/**
 * The Design System a workspace site belongs to: the nearest folder strictly
 * above `siteRoot` that holds `timds.json`, or null. The site's own folder is
 * never the answer, so a stray `timds.json` beside the manifest is not read
 * as the system.
 */
export function findDesignSystemAbove(siteRoot) {
  let current = path.dirname(path.resolve(siteRoot));
  while (true) {
    if (existsSync(path.join(current, "timds.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

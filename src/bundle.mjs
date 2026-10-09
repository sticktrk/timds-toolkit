// The consumer bundle: the files a website loads from a Design System,
// built into the artifact and published beside the derived layer.
//
// A website needs a handful of what a Design System holds — its stylesheets,
// a behaviour script, the logos and small assets — and nothing of the
// viewer, the video workspace, or the media catalog. `timds.json bundle`
// names those files with globs relative to the Design System root:
//
//   "bundle": { "include": ["src/styles/ds/**", "public/ds-marketing.js"],
//               "exclude": ["public/design-system/brand/**"] }
//
// `check` copies the matches into `<entry-dir>/bundle/` under their source
// paths and writes `bundle.json` beside the brand kit: every file with its
// size and sha256, and where it sits. Paths mirror the source tree on purpose:
// a developer who symlinks a website's bundle location to a Design System
// checkout serves the same paths live, and a website's build pins the
// published copy by version. `extract --publish` uploads the bundle under
// the current prefix and under an immutable `v/<version>/` prefix, so a pin
// resolves to the same bytes forever.
//
// The bundle is optional: a manifest without `bundle` builds none, and a stale
// bundle from an earlier manifest is removed so the artifact matches it.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const BUNDLE_SCHEMA_VERSION = 1;
export const BUNDLE_OUTPUT_DIRECTORY = "bundle";
export const BUNDLE_MANIFEST_FILE = "bundle.json";
/** The artifact-root prefix immutable per-version copies publish under. */
export const BUNDLE_VERSION_PREFIX = "v";

// Never part of a bundle, whatever the globs say: dependencies, history,
// local media, and the toolkit's own records.
const NEVER_WALKED = new Set(["node_modules", ".git", "media-local", "video-local", ".timds"]);
const PATTERN = /^[^\0\\]+$/;
const MAX_PATTERNS = 100;

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const sha256Of = (data) => createHash("sha256").update(data).digest("hex");

function normalizePattern(value, where) {
  // A trailing slash names a directory and everything under it; the match treats a plain path that way already.
  const pattern = String(value ?? "").trim().replace(/^\.\//, "").replace(/\/+$/, "");
  if (!pattern || !PATTERN.test(pattern)) throw new Error(`${where} must be a relative path or glob`);
  if (pattern.startsWith("/") || pattern.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${where} ${JSON.stringify(pattern)} must be relative to the Design System root with no . or .. segments`);
  }
  return pattern;
}

/** `timds.json bundle`: include and exclude globs, validated; null when the manifest declares none. */
export function normalizeBundleConfig(input) {
  if (input === undefined || input === null || input === false) return null;
  if (!isObject(input)) throw new Error("timds.json bundle must be an object with an include list");
  const lists = {};
  for (const name of ["include", "exclude"]) {
    const raw = input[name];
    if (raw === undefined) {
      lists[name] = [];
      continue;
    }
    if (!Array.isArray(raw)) throw new Error(`timds.json bundle.${name} must be an array of paths or globs`);
    if (raw.length > MAX_PATTERNS) throw new Error(`timds.json bundle.${name} lists more than ${MAX_PATTERNS} patterns`);
    lists[name] = raw.map((value, index) => normalizePattern(value, `timds.json bundle.${name}[${index}]`));
  }
  if (!lists.include.length) throw new Error("timds.json bundle.include must name at least one file or glob");
  return { include: lists.include, exclude: lists.exclude };
}

const hasGlob = (pattern) => /[*?]/.test(pattern);

/** A glob with `**` (any depth), `*` (within a segment), and `?` as a RegExp over `/`-joined paths. */
export function globToRegExp(pattern) {
  const segments = pattern.split("/").map((segment) => {
    if (segment === "**") return "(?:[^/]+/)*";
    const escaped = segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
    return `${escaped}/`;
  });
  // The last segment matches a file; a `**` tail matches anything beneath.
  const last = segments.at(-1);
  const body = segments.slice(0, -1).join("") + (last === "(?:[^/]+/)*" ? "[^/]+(?:/[^/]+)*" : last.slice(0, -1));
  return new RegExp(`^${body}$`);
}

/** Whether a file path matches a pattern: a glob, an exact file, or a directory and everything under it. */
export function matchesPattern(filePath, pattern) {
  if (hasGlob(pattern)) return globToRegExp(pattern).test(filePath);
  return filePath === pattern || filePath.startsWith(`${pattern}/`);
}

/**
 * The files the bundle holds, walked from the Design System root. `dist/` is
 * entered only when a pattern names something under it, since a built file
 * (the starter's `tokens.css`) can be the thing a website wants; the bundle's
 * own output is never part of itself. Symbolic links are skipped and
 * reported. A pattern that matches nothing is an error: the manifest is
 * wrong, and a website would silently lose a file.
 */
export async function collectBundleFiles(designSystemRoot, config, { outputDirectory = null } = {}) {
  const wantsDist = config.include.some((pattern) => pattern === "dist" || pattern.startsWith("dist/"));
  const ownOutput = outputDirectory ? `dist/${outputDirectory}` : null;
  const found = [];
  const skipped = [];
  const walk = async (directory, relativeDirectory) => {
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        if (config.include.some((pattern) => matchesPattern(relative, pattern))) skipped.push(relative);
        continue;
      }
      if (entry.isDirectory()) {
        if (!relativeDirectory && (NEVER_WALKED.has(entry.name) || (entry.name === "dist" && !wantsDist))) continue;
        if (ownOutput && (relative === ownOutput || relative === `${ownOutput}.json`)) continue;
        await walk(path.join(directory, entry.name), relative);
        continue;
      }
      if (!entry.isFile()) continue;
      if (ownOutput && (relative.startsWith(`${ownOutput}/`) || relative === `${path.posix.dirname(ownOutput)}/${BUNDLE_MANIFEST_FILE}`.replace(/^\.\//, ""))) continue;
      if (!config.include.some((pattern) => matchesPattern(relative, pattern))) continue;
      if (config.exclude.some((pattern) => matchesPattern(relative, pattern))) continue;
      found.push({ path: relative, absolutePath: path.join(directory, entry.name) });
    }
  };
  await walk(designSystemRoot, "");
  const unmatched = config.include.filter((pattern) => !found.some((file) => matchesPattern(file.path, pattern)));
  if (unmatched.length) {
    throw new Error(`timds.json bundle.include matches no file for ${unmatched.map((pattern) => JSON.stringify(pattern)).join(", ")}; fix the pattern or remove it`);
  }
  const files = [];
  for (const file of found) {
    const body = await fs.readFile(file.absolutePath);
    files.push({ path: file.path, absolutePath: file.absolutePath, bytes: body.length, sha256: sha256Of(body) });
  }
  return { files, skipped };
}

/** Where the bundle sits in the artifact for an entry such as `design-system/index.html`: `design-system/bundle`. */
export function bundleOutputDirectory(entry = "index.html") {
  const entryDirectory = path.posix.dirname(String(entry || "index.html"));
  return entryDirectory === "." ? BUNDLE_OUTPUT_DIRECTORY : `${entryDirectory}/${BUNDLE_OUTPUT_DIRECTORY}`;
}

/**
 * The `bundle.json` document: every file with its size and digest, and the
 * site-absolute directory the files sit under. `base` and `versioned` are
 * null until publish fills them with the CDN prefixes.
 */
export function bundleDocument(files, manifest, { basePrefix = "" } = {}) {
  const directory = `${basePrefix}/${BUNDLE_OUTPUT_DIRECTORY}`;
  const entries = files.map((file) => ({ path: file.path, url: `${directory}/${file.path}`, bytes: file.bytes, sha256: file.sha256 }));
  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    system: { id: manifest.systemId, name: manifest.name, version: manifest.version },
    url: `${basePrefix}/${BUNDLE_MANIFEST_FILE}`,
    directory,
    base: null,
    versioned: null,
    fileCount: entries.length,
    bytes: entries.reduce((sum, file) => sum + file.bytes, 0),
    files: entries,
  };
}

/**
 * Build the bundle into the artifact: the previous output is removed first,
 * the matched files are copied under their source paths, and `bundle.json`
 * is written beside the brand kit. A manifest without `bundle` removes any
 * stale output and reports that none is configured.
 */
export async function buildBundle(designSystemRoot, { manifest }) {
  const artifactRoot = path.join(designSystemRoot, "dist");
  const outputDirectory = bundleOutputDirectory(manifest.artifact?.entry);
  const entryDirectory = path.posix.dirname(outputDirectory);
  const manifestPath = path.join(artifactRoot, ...(entryDirectory === "." ? [] : entryDirectory.split("/")), BUNDLE_MANIFEST_FILE);
  await fs.rm(path.join(artifactRoot, ...outputDirectory.split("/")), { force: true, recursive: true });
  await fs.rm(manifestPath, { force: true });
  if (!manifest.bundle) return { enabled: false, document: null, outputDirectory, skipped: [], written: [] };

  const { files, skipped } = await collectBundleFiles(designSystemRoot, manifest.bundle, { outputDirectory });
  const written = [];
  for (const file of files) {
    const target = path.join(artifactRoot, ...outputDirectory.split("/"), ...file.path.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(file.absolutePath, target);
    written.push(target);
  }
  const basePrefix = entryDirectory === "." ? "" : `/${entryDirectory}`;
  const document = bundleDocument(files, manifest, { basePrefix });
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, `${JSON.stringify(document, null, 2)}\n`);
  written.push(manifestPath);
  return { enabled: true, document, outputDirectory, skipped, written };
}

/**
 * The bundle as published: `base` is the CDN prefix, `directory` where the
 * files sit under it, and `versioned` the immutable copy for this version.
 * The versioned document points its files at the versioned copy.
 */
export function rewriteBundleForPublish(document, { publicBase, entryDirectory, version, versioned = false }) {
  const base = String(publicBase).replace(/\/+$/, "");
  const prefix = entryDirectory === "." ? "" : `${entryDirectory}/`;
  const currentDirectory = `${base}/${prefix}${BUNDLE_OUTPUT_DIRECTORY}`;
  const versionedDirectory = `${base}/${BUNDLE_VERSION_PREFIX}/${version}/${BUNDLE_OUTPUT_DIRECTORY}`;
  const directory = versioned ? versionedDirectory : currentDirectory;
  return {
    ...document,
    url: versioned ? `${base}/${BUNDLE_VERSION_PREFIX}/${version}/${BUNDLE_MANIFEST_FILE}` : `${base}/${prefix}${BUNDLE_MANIFEST_FILE}`,
    directory,
    base,
    versioned: versionedDirectory,
    files: (document.files ?? []).map((file) => ({ ...file, url: `${directory}/${file.path}` })),
  };
}

/** The artifact-relative paths a bundle's files publish under: the current copy and the immutable versioned copy. */
export function bundlePublishPaths(filePath, { entryDirectory, version }) {
  const prefix = entryDirectory === "." ? "" : `${entryDirectory}/`;
  return {
    current: `${prefix}${BUNDLE_OUTPUT_DIRECTORY}/${filePath}`,
    versioned: `${BUNDLE_VERSION_PREFIX}/${version}/${BUNDLE_OUTPUT_DIRECTORY}/${filePath}`,
  };
}

/** The artifact-relative paths bundle.json publishes under, beside each copy of the files. */
export function bundleManifestPublishPaths({ entryDirectory, version }) {
  const prefix = entryDirectory === "." ? "" : `${entryDirectory}/`;
  return {
    current: `${prefix}${BUNDLE_MANIFEST_FILE}`,
    versioned: `${BUNDLE_VERSION_PREFIX}/${version}/${BUNDLE_MANIFEST_FILE}`,
  };
}

/** `12 files, 184.2 KB`, the way check and doctor report a bundle. */
export function describeBundle(document) {
  if (!document) return "Consumer bundle: not configured (add bundle.include to timds.json)";
  const bytes = document.bytes >= 1_000_000 ? `${(document.bytes / 1_000_000).toFixed(1)} MB` : `${(document.bytes / 1_000).toFixed(1)} KB`;
  return `Consumer bundle: ${document.fileCount} file${document.fileCount === 1 ? "" : "s"}, ${bytes}`;
}

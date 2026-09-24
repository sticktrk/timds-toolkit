// Read a design system's derived layer: the generated, contract-shaped view
// that `timds check` writes beside the built pages and `extract --publish`
// uploads to the system's stable CDN prefix.
//
//   index.json    every page as structured blocks, assets joined to media
//   tokens.json   every CSS custom property the pages load, resolved by scope,
//                 with the brand roles they fill
//   brand.json    the brand kit: role colors and fonts, logos, imagery, and
//                 guidance groups with their Markdown
//   llms.txt      the page directory in the llms.txt convention
//
// This is the surface a consumer — an MCP server, a render host, a pipeline —
// reads. It never needs the toolkit's internals or a checkout of authored
// source: a local reader takes a Design System root, a remote reader takes
// the published base URL, and both return the same shape. Every document
// carries `system.version`, so a consumer can pin exactly what it read.

import fs from "node:fs/promises";
import path from "node:path";

export const DERIVED_LAYER_FILES = Object.freeze({
  index: "index.json",
  tokens: "tokens.json",
  brand: "brand.json",
  llms: "llms.txt",
});
export const PROVENANCE_FILE = ".timds-artifact.json";

/** Artifact-relative paths of the derived files for an artifact entry such as `design-system/index.html`. */
export function derivedLayerPaths(entry = "index.html") {
  const entryDirectory = path.posix.dirname(String(entry || "index.html"));
  const prefix = entryDirectory === "." ? "" : `${entryDirectory}/`;
  return Object.fromEntries(Object.entries(DERIVED_LAYER_FILES).map(([name, file]) => [name, `${prefix}${file}`]));
}

/** Absolute path of one derived file for a workspace. */
export function derivedFilePath(designSystemRoot, manifest, name) {
  const relative = derivedLayerPaths(manifest?.artifact?.entry)[name];
  if (!relative) throw new Error(`unknown derived file ${name}`);
  return path.join(designSystemRoot, "dist", ...relative.split("/"));
}

async function readOptional(filePath, parse) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (caught) {
    if (caught?.code === "ENOENT") return null;
    throw caught;
  }
  try {
    return parse(raw);
  } catch (caught) {
    throw new Error(`${filePath} is not valid: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
}

/**
 * The derived layer of a local workspace. A file `check` has not written yet
 * is null rather than an error, and `stale` says the layer was derived for a
 * version other than the manifest's, so a consumer knows to rerun `check`.
 */
export async function readDerivedLayer(designSystemRoot, manifest) {
  const [index, tokens, brand, llms] = await Promise.all([
    readOptional(derivedFilePath(designSystemRoot, manifest, "index"), JSON.parse),
    readOptional(derivedFilePath(designSystemRoot, manifest, "tokens"), JSON.parse),
    readOptional(derivedFilePath(designSystemRoot, manifest, "brand"), JSON.parse),
    readOptional(derivedFilePath(designSystemRoot, manifest, "llms"), String),
  ]);
  const version = index?.system?.version ?? tokens?.system?.version ?? brand?.system?.version ?? null;
  return {
    source: { kind: "local", root: designSystemRoot, artifactRoot: path.join(designSystemRoot, "dist") },
    system: { id: manifest?.systemId ?? null, name: manifest?.name ?? null, version: manifest?.version ?? null },
    derived: index !== null || tokens !== null || brand !== null,
    stale: Boolean(version && manifest?.version && version !== manifest.version),
    provenance: null,
    index,
    tokens,
    brand,
    llms,
  };
}

/**
 * The derived layer as published: the provenance stamp at the CDN base names
 * the version, source commit, and where each derived file sits, so a remote
 * consumer needs nothing but the base URL. A missing derived file is null, the
 * way it is locally; a missing stamp means nothing is published there.
 */
export async function fetchDerivedLayer(publicBase, { fetchImpl = fetch } = {}) {
  const base = String(publicBase ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\/.+/.test(base)) throw new Error("published design system base must be an HTTP or HTTPS URL");
  const get = async (relative, parse, { required = false } = {}) => {
    const url = `${base}/${relative}`;
    const response = await fetchImpl(url);
    if (response.status === 404 && !required) return null;
    if (!response.ok) throw new Error(`${url} responded ${response.status}`);
    const text = await response.text();
    try {
      return parse(text);
    } catch (caught) {
      throw new Error(`${url} is not valid: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  };
  const provenance = await get(PROVENANCE_FILE, JSON.parse, { required: true });
  const paths = provenance.files ?? derivedLayerPaths(provenance.entry);
  const [index, tokens, brand, llms] = await Promise.all([
    get(paths.index, JSON.parse),
    get(paths.tokens, JSON.parse),
    get(paths.brand, JSON.parse),
    get(paths.llms, String),
  ]);
  const system = index?.system ?? tokens?.system ?? brand?.system ?? { id: null, name: null, version: provenance.version ?? null };
  return {
    source: { kind: "published", base },
    system,
    derived: index !== null || tokens !== null || brand !== null,
    stale: false,
    provenance,
    index,
    tokens,
    brand,
    llms,
  };
}

/** One-line readiness of a brand kit, for `doctor` and for a consumer deciding whether the kit is usable. */
export function summarizeBrandKit(kit) {
  if (!kit) return null;
  const filled = Object.keys(kit.roles ?? {});
  const missing = kit.missingRoles ?? [];
  return {
    version: kit.system?.version ?? null,
    roles: { filled: filled.length, missing, total: filled.length + missing.length },
    logos: (kit.logos ?? []).length,
    primaryLogo: (kit.logos ?? []).find((logo) => logo.primary)?.name ?? null,
    imagery: (kit.imagery ?? []).length,
    guidance: Object.keys(kit.guidance ?? {}),
  };
}

/** The `doctor` line for a brand kit summary. */
export function describeBrandKit(summary) {
  if (!summary) return "Brand kit: not derived; run timds check";
  const roles = `${summary.roles.filled}/${summary.roles.total} roles${summary.roles.missing.length ? ` (missing ${summary.roles.missing.join(", ")})` : ""}`;
  const guidance = summary.guidance.length ? summary.guidance.join(", ") : "none";
  return `Brand kit: ${roles}, ${summary.logos} logo${summary.logos === 1 ? "" : "s"}${summary.primaryLogo ? ` (primary: ${summary.primaryLogo})` : ""}, ${summary.imagery} imagery, guidance ${guidance} (derived for ${summary.version ?? "unknown"})`;
}

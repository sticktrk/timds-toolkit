// Publication snapshot schema 1. Property and array order are part of the wire
// contract: hash the normalized source contract and every built artifact file.
// The provenance stamp, build time and repository identity are outside it.
import { createHash } from "node:crypto";
import path from "node:path";

const text = (value, length, fallback = "") => String(value || fallback).trim().slice(0, length);
const slug = (value, fallback = "") => text(value, Infinity, fallback).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || fallback;
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function artifactPath(value) {
  const result = String(value).trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  if (!result || result.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Unsafe artifact path");
  return result.slice(0, 500);
}

function manifestSnapshot(input) {
  return {
    artifact: { entry: artifactPath(input.artifact?.entry || input.viewer?.entry || input.artifactEntry || "index.html"), publishRef: text(input.artifact?.publishRef, Infinity) },
    defaultTheme: text(input.defaultTheme || input.default_theme || input.themes?.[0], 100),
    description: text(input.description, 4_000),
    name: text(input.name, 200),
    nav: (Array.isArray(input.nav) ? input.nav : []).slice(0, 30).map((value) => {
      const item = value && !Array.isArray(value) && typeof value === "object" ? value : {};
      return {
        label: text(item.label || item.view || item.id, 100, "View"),
        pages: (Array.isArray(item.pages) ? item.pages : []).slice(0, 160).map((value) => {
          const page = value && !Array.isArray(value) && typeof value === "object" ? value : {};
          return { group: text(page.group, 100), slug: slug(page.slug), title: text(page.title || page.slug, 160, "Page") };
        }),
        view: slug(item.view || item.id || item.label, "view"),
      };
    }),
    schemaVersion: Number(input.schemaVersion || input.schema_version || 1),
    systemId: text(input.systemId || input.system_id || input.client, Infinity),
    themes: (Array.isArray(input.themes) ? input.themes : []).map((value) => String(value).trim().slice(0, 100)).slice(0, 20),
    version: text(input.version || input.publishedVersion || input.published_version, 100, "working"),
  };
}

function mediaSnapshot(input) {
  if (!input) return { assets: [], schemaVersion: 1 };
  const schemaVersion = Number(input.schemaVersion ?? 1);
  if (![1, 2].includes(schemaVersion)) throw new Error("Unsupported media schema");
  const assets = (Array.isArray(input.assets) ? input.assets : []).map((asset) => {
    const id = text(asset.id, Infinity);
    const rights = asset.rights && !Array.isArray(asset.rights) && typeof asset.rights === "object" ? asset.rights : {};
    return {
      bytes: Number(asset.bytes),
      contentType: text(asset.contentType, 200, "application/octet-stream"),
      filename: text(asset.filename, 300, "asset"),
      id,
      key: text(asset.key || (schemaVersion === 1 ? id.toLowerCase() : ""), Infinity).toLowerCase(),
      kind: text(asset.kind, 40, "other"),
      publicUrl: text(asset.publicUrl, Infinity),
      rights: { attribution: text(rights.attribution, 1_000), expiresOn: text(rights.expiresOn, 40), notes: text(rights.notes, 2_000), status: schemaVersion === 2 ? "" : text(rights.status, Infinity) },
      sha256: text(asset.sha256, Infinity).toLowerCase(),
      tags: (Array.isArray(asset.tags) ? asset.tags : []).map((tag) => String(tag).trim().slice(0, 80)).filter(Boolean).slice(0, 50),
      title: text(asset.title || asset.filename, 300, "Asset"),
      visibility: schemaVersion === 2 ? "public" : text(asset.visibility, Infinity, "private"),
    };
  });
  return { assets, schemaVersion };
}

function assetKind(extension) {
  for (const [kind, extensions] of Object.entries({ image: [".avif", ".gif", ".ico", ".jpeg", ".jpg", ".png", ".svg", ".webp"], font: [".otf", ".ttf", ".woff", ".woff2"], video: [".mov", ".mp4", ".webm"], document: [".doc", ".docx", ".pdf", ".txt"], template: [".fig", ".indd", ".key", ".ppt", ".pptx", ".psd", ".sketch"] })) {
    if (extensions.includes(extension)) return kind;
  }
  return "other";
}

function documents(files, directory, extensions) {
  return files.filter((file) => file.path.startsWith(`${directory}/`) && extensions.includes(path.posix.extname(file.path).toLowerCase()))
    .sort((a, b) => a.path.localeCompare(b.path)).map((file) => {
      const raw = String(file.content || "");
      const isJson = path.posix.extname(file.path).toLowerCase() === ".json";
      const content = isJson ? JSON.stringify(JSON.parse(raw), null, 2) : raw;
      const relative = file.path.slice(directory.length + 1);
      return {
        content,
        format: isJson ? "json" : "markdown",
        path: file.path,
        section: relative.includes("/") ? relative.split("/")[0] : directory,
        title: /^#\s+(.+)$/m.exec(content)?.[1]?.trim() || path.posix.basename(relative, path.posix.extname(relative)).replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
      };
    });
}

export function publicationSnapshot({ manifest: input, tokens, media, sourceFiles, artifactFiles }) {
  const manifest = manifestSnapshot(input);
  const files = artifactFiles.map((file) => ({ bytes: file.content.length, path: artifactPath(file.path), sha256: sha256(file.content) })).sort((a, b) => a.path.localeCompare(b.path));
  if (!files.some((file) => file.path === manifest.artifact.entry)) throw new Error(`Built artifact is missing ${manifest.artifact.entry}`);
  if (new Set(files.map((file) => file.path)).size !== files.length) throw new Error("Duplicate artifact paths");
  return {
    artifact: { entryPath: manifest.artifact.entry, fileCount: files.length, files, mode: "repository_dist", totalBytes: files.reduce((sum, file) => sum + file.bytes, 0) },
    // Source files arrive in Git tree order; unlike the artifact and document
    // arrays, assets retain that order in snapshot schema 1.
    assets: sourceFiles.filter((file) => file.path.startsWith("assets/")).slice(0, 600).map((file) => ({ bytes: file.bytes, kind: assetKind(path.posix.extname(file.path).toLowerCase()), name: path.posix.basename(file.path), path: file.path })),
    components: documents(sourceFiles, "components", [".json", ".md", ".mdx"]),
    docs: documents(sourceFiles, "docs", [".md", ".mdx"]),
    manifest,
    media: mediaSnapshot(media),
    tokens,
  };
}

export function publicationDigest(input) {
  return sha256(JSON.stringify(publicationSnapshot(input)));
}

/**
 * Create schema-1 provenance from committed source bytes supplied by a trusted
 * repository adapter. Paths are relative to the Design System root. This is
 * pure computation: no checkout, Git subprocess, filesystem or credentials.
 */
export function createPublicationStampFromFiles({ sourceCommit, sourceFiles, artifactFiles, systemId, version }) {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit || '')) throw new Error('Publication requires a committed source revision');
  if (!Array.isArray(sourceFiles) || !Array.isArray(artifactFiles)) throw new Error('Publication requires source and artifact file trees');
  const bytesFor = file => {
    if (file.content instanceof Uint8Array) return Buffer.from(file.content);
    if (typeof file.content !== 'string') throw new Error(`Publication file has no bytes: ${file.path}`);
    if (file.encoding === 'base64') {
      const bytes = Buffer.from(file.content, 'base64');
      if (bytes.toString('base64') !== file.content) throw new Error(`Publication file has invalid base64: ${file.path}`);
      return bytes;
    }
    if (file.encoding && file.encoding !== 'utf8') throw new Error(`Publication file has unsupported encoding: ${file.path}`);
    return Buffer.from(file.content, 'utf8');
  };
  const checkedPath = input => {
    if (typeof input !== 'string' || !input || input.startsWith('/') || input.includes('\\') || /[\x00-\x1f\x7f]/.test(input) || input.split('/').some(part => !part || ['.', '..'].includes(part))) throw new Error('Unsafe publication source path');
    return input;
  };
  const seen = new Set(), records = [];
  const readable = relative => ['timds.json', 'tokens.json', 'media.json'].includes(relative) || /^(docs\/.*\.(md|mdx)|components\/.*\.(json|md|mdx))$/i.test(relative);
  for (const file of sourceFiles) {
    const relative = checkedPath(file.path);
    if (seen.has(relative)) throw new Error(`Duplicate publication source path: ${relative}`);
    seen.add(relative);
    if (file.mode && !['100644', '100755'].includes(file.mode)) continue;
    if (!['timds.json', 'tokens.json', 'media.json'].includes(relative) && !/^(docs|components|assets)\//.test(relative)) continue;
    const bytes = bytesFor(file);
    if (readable(relative) && bytes.length > 1_000_000) throw new Error(`Source contract file is too large: ${relative}`);
    records.push({ path: relative, bytes: bytes.length, ...(readable(relative) ? { content: bytes.toString('utf8') } : {}) });
  }
  // Git compares path names by UTF-8 bytes, not locale or JSON insertion order.
  records.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const byPath = new Map(records.map(file => [file.path, file]));
  if (!byPath.has('timds.json') || !byPath.has('tokens.json')) throw new Error('Publication requires tracked timds.json and tokens.json');
  const manifest = JSON.parse(byPath.get('timds.json').content);
  const tokens = JSON.parse(byPath.get('tokens.json').content);
  const media = byPath.has('media.json') ? JSON.parse(byPath.get('media.json').content) : null;
  const manifestSystem = String(manifest.systemId || '').trim(), manifestVersion = String(manifest.version || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{1,159}$/.test(manifestSystem) || !/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,99}$/.test(manifestVersion)) throw new Error('Publication requires a safe system identity and version label');
  if (systemId !== undefined && systemId !== manifestSystem || version !== undefined && version !== manifestVersion) throw new Error('Publication identity differs from the committed manifest');
  const artifacts = artifactFiles.map(file => {
    if (file.mode && !['100644', '100755'].includes(file.mode)) throw new Error('Publication artifacts must be regular files');
    return { path: checkedPath(file.path), content: bytesFor(file) };
  });
  if (artifacts.some(file => file.path === '.timds-artifact.json')) throw new Error('The root .timds-artifact.json is reserved for publication metadata');
  return { schemaVersion: 1, systemId: manifestSystem, version: manifestVersion, sourceCommit,
    contentDigest: publicationDigest({ manifest, tokens, media, sourceFiles: records, artifactFiles: artifacts }) };
}

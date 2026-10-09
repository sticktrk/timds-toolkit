// Publish the machine-readable layer to the system's public CDN prefix.
//
// `extract` derives the machine layer beside the built viewer: index.json for
// pipelines, and llms.txt plus a Markdown mirror of every page for agents.
// Those files reference artifact-local assets (photos, engravings, logos) and
// pages by site-absolute path, which only resolves when the whole artifact is
// served from a domain root. Publishing makes the layer consumable from one
// stable URL: it uploads the referenced files and the page mirrors under the
// system's artifact prefix, rewrites index references to absolute URLs —
// stamping bytes and sha256 so consumers can detect a changed asset behind an
// unchanged key — rewrites llms.txt links the same way, and uploads the
// rewritten index, llms.txt, and a `.timds-artifact.json` provenance stamp
// last, so no entry point ever precedes the files it names.
//
// The portal signs every upload (same operator token as `assets publish`) and
// owns the key scheme. Contract, mirroring design-system-assets uploads:
//
//   POST {portal}/api/operator/design-system-artifacts/uploads
//   Authorization: Bearer <token>
//   { systemId, version, sourceCommit,
//     files: [{ path, contentType, bytes, sha256 }] }        // artifact-relative
//   → { publicBase,                                          // stable HTTPS prefix
//       uploads: [{ path, method: "single" | "multipart", url, headers?,
//                   partSize?, partsUrl?, completeUrl?, cancelUrl? }] }
//
// The portal returns uploads only for files whose sha256 is not already
// current — that omission is what makes the publish repeatable and
// incremental. Keys are stable and overwritten in place; index.json and
// .timds-artifact.json should be served with a short cache lifetime
// (≤5 minutes), asset files with a moderate one.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { resolveAccessToken } from "./auth.mjs";
import { portalEndpoint, portalJson, putMultipartFile, putSingleFile } from "./media.mjs";

const ARTIFACT_UPLOADS_PATH = "/api/operator/design-system-artifacts/uploads";

const CONTENT_TYPES = {
  ".css": "text/css",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

export const artifactContentType = (file) =>
  CONTENT_TYPES[path.posix.extname(String(file).toLowerCase())] ?? "application/octet-stream";

const sha256Of = (data) => createHash("sha256").update(data).digest("hex");

import { eachBrandKitMedia } from "./brand.mjs";
import { bundleManifestPublishPaths, bundlePublishPaths, rewriteBundleForPublish } from "./bundle.mjs";
import { eachDesignReference } from "./designs.mjs";
import { PROVENANCE_FILE, derivedLayerPaths } from "./derived.mjs";

const eachIndexMedia = (index, visit) => {
  for (const page of index.pages ?? []) {
    for (const block of page.blocks ?? []) {
      for (const asset of block.assets ?? []) {
        if (asset?.media) visit(asset.media);
      }
    }
  }
};

/**
 * The artifact files a site-absolute index reference resolves to, keyed by
 * artifact-relative path. Throws when the index names a file the artifact
 * does not contain: publishing a dangling reference would fail downstream in
 * a place much harder to diagnose.
 */
export async function collectIndexAssetFiles(index, artifactRoot) {
  const files = new Map();
  const references = [];
  eachIndexMedia(index, (media) => {
    if (typeof media.url === "string" && media.url.startsWith("/") && !media.url.startsWith("//")) references.push(media.url);
  });
  for (const url of references) {
    const relative = url.split("?", 1)[0].replace(/^\/+/, "");
    if (!relative || files.has(relative)) continue;
    const localPath = path.join(artifactRoot, ...relative.split("/"));
    let body;
    try {
      body = await fs.readFile(localPath);
    } catch {
      throw new Error(`Index references ${url} but the artifact has no ${relative}`);
    }
    files.set(relative, {
      bytes: body.length,
      contentType: artifactContentType(relative),
      localPath,
      sha256: sha256Of(body),
    });
  }
  return files;
}

/**
 * A copy of the index whose artifact-local references are absolute under
 * `publicBase` and carry the integrity of the file that was uploaded there.
 * TimDS media records are already absolute and pass through untouched.
 */
export function rewriteIndexForPublish(index, files, publicBase, each = eachIndexMedia) {
  const base = String(publicBase).replace(/\/+$/, "");
  const rewritten = structuredClone(index);
  for (const page of rewritten.pages ?? []) {
    if (page.markdownUrl?.startsWith("/") && !page.markdownUrl.startsWith("//")) page.markdownUrl = `${base}${page.markdownUrl}`;
  }
  each(rewritten, (media) => {
    if (typeof media.url !== "string" || !media.url.startsWith("/") || media.url.startsWith("//")) return;
    const relative = media.url.split("?", 1)[0].replace(/^\/+/, "");
    const file = files.get(relative);
    if (!file) return;
    media.url = `${base}/${relative}`;
    media.bytes = file.bytes;
    media.sha256 = file.sha256;
  });
  return rewritten;
}

/** The brand kit's logos, imagery, and font files resolve the same way as index assets. */
export const rewriteBrandKitForPublish = (kit, files, publicBase) => rewriteIndexForPublish(kit, files, publicBase, eachBrandKitMedia);

/**
 * The artifact files the brand kit names that the index does not: the font
 * files behind each font role. Logos and imagery are index assets and are
 * already in `files`; a font the stylesheet declares but the artifact lacks
 * is skipped, since the page renders without it and the kit then simply
 * keeps the unresolved path.
 */
export async function collectBrandKitFiles(kit, artifactRoot, files = new Map()) {
  const references = [];
  eachBrandKitMedia(kit, (media) => {
    if (typeof media.url === "string" && media.url.startsWith("/") && !media.url.startsWith("//")) references.push(media.url);
  });
  for (const url of references) {
    const relative = url.split("?", 1)[0].replace(/^\/+/, "");
    if (!relative || files.has(relative)) continue;
    const localPath = path.join(artifactRoot, ...relative.split("/"));
    let body;
    try {
      body = await fs.readFile(localPath);
    } catch {
      continue;
    }
    files.set(relative, {
      bytes: body.length,
      contentType: artifactContentType(relative),
      localPath,
      sha256: sha256Of(body),
    });
  }
  return files;
}

/**
 * The stylesheets, scripts, and media the website designs load, added to `files` so a
 * consumer reading designs.json from the CDN can resolve every site-absolute
 * reference under its `base`. The HTML itself travels inside designs.json.
 */
export async function collectDesignReferenceFiles(designs, artifactRoot, files = new Map()) {
  const references = [];
  eachDesignReference(designs, (reference) => references.push(reference));
  for (const url of references) {
    const relative = url.split("?", 1)[0].replace(/^\/+/, "");
    if (!relative || files.has(relative)) continue;
    const localPath = path.join(artifactRoot, ...relative.split("/"));
    let body;
    try {
      body = await fs.readFile(localPath);
    } catch {
      throw new Error(`Website designs reference ${url} but the artifact has no ${relative}`);
    }
    files.set(relative, {
      bytes: body.length,
      contentType: artifactContentType(relative),
      localPath,
      sha256: sha256Of(body),
    });
  }
  return files;
}

/**
 * The consumer bundle's files, added to `files` twice: under the current
 * prefix where `check` copied them, and under the immutable `v/<version>/`
 * prefix a website pins. The same local file serves both keys; the portal
 * skips a key whose digest is already current, so a republish of an
 * unchanged version uploads nothing.
 */
export async function collectBundleFiles(bundle, artifactRoot, { entryDirectory, version }, files = new Map()) {
  for (const entry of bundle.files ?? []) {
    const { current, versioned } = bundlePublishPaths(entry.path, { entryDirectory, version });
    const localPath = path.join(artifactRoot, ...current.split("/"));
    let body;
    try {
      body = await fs.readFile(localPath);
    } catch {
      throw new Error(`bundle.json names ${entry.path} but the artifact has no ${current}; run timds check`);
    }
    const record = { bytes: body.length, contentType: artifactContentType(current), localPath, sha256: sha256Of(body) };
    if (record.sha256 !== entry.sha256) throw new Error(`${current} does not match the digest bundle.json records; run timds check`);
    for (const key of [current, versioned]) if (!files.has(key)) files.set(key, record);
  }
  return files;
}

/** The extract-written page mirrors and llms.txt, as artifact-relative paths. */
export async function collectMachineDocFiles(artifactRoot, entryDirectory) {
  const baseDirectory = entryDirectory === "." ? artifactRoot : path.join(artifactRoot, ...entryDirectory.split("/"));
  const found = [];
  const visit = async (directory) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) found.push(absolutePath);
    }
  };
  await visit(baseDirectory);
  const prefix = entryDirectory === "." ? "" : `${entryDirectory}/`;
  return found
    .map((file) => `${prefix}${path.relative(baseDirectory, file).split(path.sep).join("/")}`)
    .sort();
}

/**
 * llms.txt is the agents' directory into the published layer, so its
 * site-absolute targets — Markdown link destinations and the machine-index
 * pointer — must resolve against the CDN prefix, not a viewer origin.
 */
export function rewriteLlmsForPublish(text, publicBase) {
  const base = String(publicBase).replace(/\/+$/, "");
  return String(text)
    .replace(/\]\(\/(?!\/)/g, `](${base}/`)
    .replace(/^(Machine-readable index: |Full text: |Design tokens: |Brand kit: |Asset formats: |Website designs: |Consumer bundle: )(\/(?!\/)\S+)/gm, (_match, label, target) => `${label}${base}${target}`)
    // Logo and font file lines in the essentials name site-absolute files after a colon.
    .replace(/^(\s*- .*?: )(\/(?!\/)\S+)$/gm, (_match, label, target) => `${label}${base}${target}`)
    .replace(/^(<!-- source: )(\/(?!\/)\S*)/gm, (_match, label, target) => `${label}${base}${target}`);
}

/** formats.json names each format's page by its mirror URL; on the CDN that URL is absolute like every other link. */
export function rewriteFormatsForPublish(document, publicBase) {
  const base = String(publicBase).replace(/\/+$/, "");
  const rewritten = structuredClone(document);
  rewritten.url = typeof rewritten.url === "string" && rewritten.url.startsWith("/") ? `${base}${rewritten.url}` : rewritten.url;
  for (const group of rewritten.groups ?? []) {
    for (const format of group.formats ?? []) {
      if (typeof format.pageUrl === "string" && format.pageUrl.startsWith("/")) format.pageUrl = `${base}${format.pageUrl}`;
    }
  }
  return rewritten;
}

export function detectSourceCommit(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function performUpload(fetchImpl, portalUrl, upload, filePath, contentType, token) {
  const resolved = {
    ...upload,
    cancelUrl: upload.cancelUrl ? portalEndpoint(portalUrl, upload.cancelUrl) : null,
    completeUrl: upload.completeUrl ? portalEndpoint(portalUrl, upload.completeUrl) : null,
    partsUrl: upload.partsUrl ? portalEndpoint(portalUrl, upload.partsUrl) : null,
  };
  try {
    let parts = [];
    if (resolved.method === "multipart") parts = await putMultipartFile(fetchImpl, resolved, filePath, contentType, token);
    else if (resolved.method === "single") await putSingleFile(fetchImpl, resolved, filePath, contentType);
    else throw new Error("TimDS returned an unsupported upload method");
    if (resolved.completeUrl) await portalJson(fetchImpl, resolved.completeUrl, token, { body: { parts }, method: "POST" });
  } catch (caught) {
    if (resolved.cancelUrl) {
      try {
        await portalJson(fetchImpl, resolved.cancelUrl, token, { method: "DELETE" });
      } catch {
        // Keep the original failure.
      }
    }
    throw caught;
  }
}

/** Refuse changing the content of a version that consumers can already pin. */
async function checkPublishedBundle(fetchImpl, publicBase, bundle, options) {
  const relative = bundleManifestPublishPaths(options).versioned;
  const response = await fetchImpl(`${publicBase}/${relative}`, { cache: "no-store" });
  if (response.status === 404) return;
  if (!response.ok) throw new Error(`Could not check published bundle ${relative}: responded ${response.status}`);
  const published = await response.json();
  const fileDigests = (document) => (document.files ?? []).map(({ path, sha256, bytes }) => ({ path, sha256, bytes })).sort((a, b) => a.path.localeCompare(b.path));
  if (published.system?.id !== bundle.system.id || published.system?.version !== options.version
    || JSON.stringify(fileDigests(published)) !== JSON.stringify(fileDigests(bundle))
    || (published.designs !== undefined && JSON.stringify(published.designs) !== JSON.stringify(bundle.designs))) {
    throw new Error(`Design System version ${options.version} already has a different published bundle. Bump the Design System version before publishing; ${relative} is immutable.`);
  }
}

/** Publish the extracted machine index and its referenced artifact files. */
export async function publishExtractedIndex(workspace, options = {}) {
  const entryDirectory = path.posix.dirname(workspace.manifest.artifact.entry);
  const artifactRoot = path.join(workspace.designSystemRoot, "dist");
  const indexRelative = entryDirectory === "." ? "index.json" : `${entryDirectory}/index.json`;
  const indexPath = path.join(artifactRoot, ...indexRelative.split("/"));

  let indexRaw;
  try {
    indexRaw = await fs.readFile(indexPath, "utf8");
  } catch {
    throw new Error(`${indexRelative} is not in the artifact — run \`timds extract\` first`);
  }
  const index = JSON.parse(indexRaw);
  if (index.system?.version !== workspace.manifest.version) {
    throw new Error(
      `Artifact index is stamped ${index.system?.version} but timds.json declares ${workspace.manifest.version}; rebuild before publishing`
    );
  }

  const portalUrl = options.portalUrl || workspace.manifest.media?.portalUrl || process.env.TIMDS_PORTAL_URL || "https://timds.com";
  const token = await resolveAccessToken(portalUrl, options);
  if (!token) throw new Error("Sign in with `timds auth login` or set TIMDS_ACCESS_TOKEN before publishing the machine index");
  const fetchImpl = options.fetchImpl || fetch;
  const sourceCommit = options.sourceCommit || detectSourceCommit(workspace.designSystemRoot);

  const requestUploads = (fileRecords) =>
    portalJson(fetchImpl, portalEndpoint(portalUrl, ARTIFACT_UPLOADS_PATH), token, {
      body: {
        files: fileRecords,
        sourceCommit,
        systemId: workspace.manifest.systemId,
        version: workspace.manifest.version,
      },
      method: "POST",
    });

  // Referenced files and page mirrors publish first, so no entry point ever
  // precedes the files it names.
  const files = await collectIndexAssetFiles(index, artifactRoot);
  // The brand kit names logos and imagery by artifact-local URL, rewritten to
  // the CDN like the index, and the font files behind each font role, which
  // publish beside the logos so a consumer can download the face.
  const brandRelative = entryDirectory === "." ? "brand.json" : `${entryDirectory}/brand.json`;
  const brandSource = await fs.readFile(path.join(artifactRoot, ...brandRelative.split("/")), "utf8").catch(() => null);
  const brandKit = brandSource === null ? null : JSON.parse(brandSource);
  if (brandKit) await collectBrandKitFiles(brandKit, artifactRoot, files);
  // Website designs publish with the stylesheets and media they load, and
  // learn the base they resolve against; a system without designs has no file.
  const designsRelative = entryDirectory === "." ? "designs.json" : `${entryDirectory}/designs.json`;
  const designsSource = await fs.readFile(path.join(artifactRoot, ...designsRelative.split("/")), "utf8").catch(() => null);
  const designs = designsSource === null ? null : JSON.parse(designsSource);
  if (designs) await collectDesignReferenceFiles(designs, artifactRoot, files);
  // The consumer bundle publishes under the current prefix and an immutable
  // versioned one; a system whose manifest declares no bundle has no file.
  const bundleRelative = entryDirectory === "." ? "bundle.json" : `${entryDirectory}/bundle.json`;
  const bundleSource = await fs.readFile(path.join(artifactRoot, ...bundleRelative.split("/")), "utf8").catch(() => null);
  // Keep the pairing catalog with the bundle version, so a fixed pin never
  // needs the current derived layer (or its provenance stamp) to check routes.
  const bundle = bundleSource === null ? null : {
    ...JSON.parse(bundleSource),
    designs: (designs?.designs ?? []).map((design) => ({ id: design.id, routes: (design.pages ?? []).map((page) => page.route) })),
  };
  const version = workspace.manifest.version;
  if (bundle && (bundle.system?.id !== workspace.manifest.systemId || bundle.system?.version !== version)) {
    throw new Error(`Artifact bundle is stamped ${bundle.system?.id ?? "unknown"} ${bundle.system?.version ?? "unknown"} but timds.json declares ${workspace.manifest.systemId} ${version}; rebuild before publishing`);
  }
  if (bundle) await collectBundleFiles(bundle, artifactRoot, { entryDirectory, version }, files);
  const docs = await collectMachineDocFiles(artifactRoot, entryDirectory);
  for (const relative of docs) {
    if (files.has(relative)) continue;
    const localPath = path.join(artifactRoot, ...relative.split("/"));
    const body = await fs.readFile(localPath);
    files.set(relative, {
      bytes: body.length,
      contentType: artifactContentType(relative),
      localPath,
      sha256: sha256Of(body),
    });
  }
  const assetSession = await requestUploads(
    [...files.entries()].map(([relative, file]) => ({
      bytes: file.bytes,
      contentType: file.contentType,
      path: relative,
      sha256: file.sha256,
    }))
  );
  const publicBase = String(assetSession.publicBase || "").replace(/\/+$/, "");
  if (!/^https:\/\/.+/.test(publicBase)) throw new Error("TimDS returned an invalid artifact publicBase");
  if (bundle) await checkPublishedBundle(fetchImpl, publicBase, bundle, { entryDirectory, version });

  let uploaded = 0;
  for (const upload of assetSession.uploads ?? []) {
    const file = files.get(upload.path);
    if (!file) throw new Error(`TimDS asked for ${upload.path}, which is not part of this publish`);
    await performUpload(fetchImpl, portalUrl, upload, file.localPath, file.contentType, token);
    uploaded += 1;
  }

  const llmsRelative = entryDirectory === "." ? "llms.txt" : `${entryDirectory}/llms.txt`;
  const llmsSource = await fs.readFile(path.join(artifactRoot, ...llmsRelative.split("/")), "utf8").catch(() => null);
  // llms-full.txt is the page mirrors in one file; its source comments and links resolve like llms.txt.
  const llmsFullRelative = entryDirectory === "." ? "llms-full.txt" : `${entryDirectory}/llms-full.txt`;
  const llmsFullSource = await fs.readFile(path.join(artifactRoot, ...llmsFullRelative.split("/")), "utf8").catch(() => null);
  // tokens.json carries resolved CSS values and no artifact-local references,
  // so it publishes as written; an older artifact without one still publishes.
  const tokensRelative = entryDirectory === "." ? "tokens.json" : `${entryDirectory}/tokens.json`;
  const tokensSource = await fs.readFile(path.join(artifactRoot, ...tokensRelative.split("/"))).catch(() => null);
  // formats.json names pages by their mirror URL, which the Markdown link rule resolves the same way.
  const formatsRelative = entryDirectory === "." ? "formats.json" : `${entryDirectory}/formats.json`;
  const formatsSource = index.formats ? await fs.readFile(path.join(artifactRoot, ...formatsRelative.split("/")), "utf8").catch(() => null) : null;
  const formats = formatsSource === null ? null : rewriteFormatsForPublish(JSON.parse(formatsSource), publicBase);

  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "timds-artifact-"));
  try {
    const rewritten = rewriteIndexForPublish(index, files, publicBase);
    const metaFiles = [
      { body: Buffer.from(`${JSON.stringify(rewritten, null, 2)}\n`), contentType: "application/json", path: indexRelative },
      ...(tokensSource === null ? [] : [{ body: tokensSource, contentType: "application/json", path: tokensRelative }]),
      ...(brandKit === null
        ? []
        : [{ body: Buffer.from(`${JSON.stringify(rewriteBrandKitForPublish(brandKit, files, publicBase), null, 2)}\n`), contentType: "application/json", path: brandRelative }]),
      ...(formats === null
        ? []
        : [{ body: Buffer.from(`${JSON.stringify(formats, null, 2)}\n`), contentType: "application/json", path: formatsRelative }]),
      ...(llmsSource === null
        ? []
        : [{ body: Buffer.from(rewriteLlmsForPublish(llmsSource, publicBase)), contentType: "text/plain; charset=utf-8", path: llmsRelative }]),
      ...(llmsFullSource === null
        ? []
        : [{ body: Buffer.from(rewriteLlmsForPublish(llmsFullSource, publicBase)), contentType: "text/plain; charset=utf-8", path: llmsFullRelative }]),
      ...(designs === null
        ? []
        : [{ body: Buffer.from(`${JSON.stringify({ ...designs, base: publicBase }, null, 2)}\n`), contentType: "application/json", path: designsRelative }]),
      // bundle.json at the current prefix names the versioned copy; the copy's own manifest points at itself.
      ...(bundle === null
        ? []
        : [
          { body: Buffer.from(`${JSON.stringify(rewriteBundleForPublish(bundle, { publicBase, entryDirectory, version }), null, 2)}\n`), contentType: "application/json", path: bundleRelative },
          { body: Buffer.from(`${JSON.stringify(rewriteBundleForPublish(bundle, { publicBase, entryDirectory, version, versioned: true }), null, 2)}\n`), contentType: "application/json", path: bundleManifestPublishPaths({ entryDirectory, version }).versioned },
        ]),
      // The stamp is the one file a remote consumer must know: it names the
      // version, the commit, and where every derived file sits under this base.
      {
        body: Buffer.from(`${JSON.stringify({
          schemaVersion: 1,
          sourceCommit,
          version: workspace.manifest.version,
          systemId: workspace.manifest.systemId,
          entry: workspace.manifest.artifact.entry,
          files: derivedLayerPaths(workspace.manifest.artifact.entry),
        }, null, 2)}\n`),
        contentType: "application/json",
        path: PROVENANCE_FILE,
      },
    ].map((file, position) => ({
      ...file,
      localPath: path.join(staging, `meta-${position}`),
    }));
    for (const file of metaFiles) await fs.writeFile(file.localPath, file.body);

    const metaSession = await requestUploads(
      metaFiles.map((file) => ({ bytes: file.body.length, contentType: file.contentType, path: file.path, sha256: sha256Of(file.body) }))
    );
    for (const upload of metaSession.uploads ?? []) {
      const file = metaFiles.find((candidate) => candidate.path === upload.path);
      if (!file) throw new Error(`TimDS asked for ${upload.path}, which is not part of this publish`);
      await performUpload(fetchImpl, portalUrl, upload, file.localPath, file.contentType, token);
      uploaded += 1;
    }
  } finally {
    await fs.rm(staging, { force: true, recursive: true });
  }

  const total = files.size + 2 + [llmsSource, llmsFullSource, tokensSource, brandKit, formats, designs, bundle, bundle].filter((document) => document !== null).length;
  const publishedBundle = bundle === null ? null : rewriteBundleForPublish(bundle, { publicBase, entryDirectory, version });
  return {
    brandUrl: brandKit === null ? null : `${publicBase}/${brandRelative}`,
    bundleUrl: publishedBundle?.url ?? null,
    bundleVersionedUrl: publishedBundle?.versioned ?? null,
    bundleFiles: publishedBundle?.fileCount ?? 0,
    designsUrl: designs === null ? null : `${publicBase}/${designsRelative}`,
    docCount: docs.length,
    formatsUrl: formats === null ? null : `${publicBase}/${formatsRelative}`,
    indexUrl: `${publicBase}/${indexRelative}`,
    llmsFullUrl: llmsFullSource === null ? null : `${publicBase}/${llmsFullRelative}`,
    llmsUrl: llmsSource === null ? null : `${publicBase}/${llmsRelative}`,
    tokensUrl: tokensSource === null ? null : `${publicBase}/${tokensRelative}`,
    publicBase,
    skipped: total - uploaded,
    total,
    uploaded,
  };
}

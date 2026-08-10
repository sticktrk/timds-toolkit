// Publish the machine-readable index to the system's public CDN prefix.
//
// `extract` derives index.json beside the built viewer. That file references
// artifact-local assets (photos, engravings, logos) by site-absolute path,
// which only resolves when the whole artifact is served from a domain root.
// Publishing makes the index consumable from one stable URL: it uploads the
// referenced files under the system's artifact prefix, rewrites those
// references to absolute URLs — stamping bytes and sha256 so consumers can
// detect a changed asset behind an unchanged key — and uploads the rewritten
// index plus a `.timds-artifact.json` provenance stamp last, so the index
// never points at files that are not there yet.
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
    if (typeof media.url === "string" && media.url.startsWith("/")) references.push(media.url);
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
export function rewriteIndexForPublish(index, files, publicBase) {
  const base = String(publicBase).replace(/\/+$/, "");
  const rewritten = structuredClone(index);
  eachIndexMedia(rewritten, (media) => {
    if (typeof media.url !== "string" || !media.url.startsWith("/")) return;
    const relative = media.url.split("?", 1)[0].replace(/^\/+/, "");
    const file = files.get(relative);
    if (!file) return;
    media.url = `${base}/${relative}`;
    media.bytes = file.bytes;
    media.sha256 = file.sha256;
  });
  return rewritten;
}

function detectSourceCommit(cwd) {
  const fromCi = String(process.env.GITHUB_SHA || "").trim();
  if (/^[a-f0-9]{40}$/i.test(fromCi)) return fromCi;
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

  // Referenced files publish first so the index never precedes its assets.
  const files = await collectIndexAssetFiles(index, artifactRoot);
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

  let uploaded = 0;
  for (const upload of assetSession.uploads ?? []) {
    const file = files.get(upload.path);
    if (!file) throw new Error(`TimDS asked for ${upload.path}, which is not part of this publish`);
    await performUpload(fetchImpl, portalUrl, upload, file.localPath, file.contentType, token);
    uploaded += 1;
  }

  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "timds-artifact-"));
  try {
    const rewritten = rewriteIndexForPublish(index, files, publicBase);
    const metaFiles = [
      { body: Buffer.from(`${JSON.stringify(rewritten, null, 2)}\n`), path: indexRelative },
      {
        body: Buffer.from(`${JSON.stringify({ schemaVersion: 1, sourceCommit, version: workspace.manifest.version }, null, 2)}\n`),
        path: ".timds-artifact.json",
      },
    ].map((file, position) => ({
      ...file,
      contentType: "application/json",
      localPath: path.join(staging, `meta-${position}.json`),
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

  const total = files.size + 2;
  return {
    indexUrl: `${publicBase}/${indexRelative}`,
    publicBase,
    skipped: total - uploaded,
    total,
    uploaded,
  };
}

import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { resolveAccessToken } from "./auth.mjs";

const MAX_MEDIA_ASSETS = 5_000;
const MAX_MEDIA_BYTES = 5 * 1024 ** 4;
const DEFAULT_MULTIPART_PART_BYTES = 16 * 1024 ** 2;
const LOCAL_MEDIA_ROUTE = "/__timds/media/";

const mediaContentTypes = {
  ".ai": "application/postscript",
  ".avif": "image/avif",
  ".eps": "application/postscript",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".m4a": "audio/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".psd": "image/vnd.adobe.photoshop",
  ".svg": "image/svg+xml",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".zip": "application/zip",
};

function objectValue(value, label) {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(`${label} must be a JSON object`);
  return value;
}

function boundedString(value, label, maxLength, { required = false } = {}) {
  const result = String(value || "").trim();
  if (required && !result) throw new Error(`${label} is required`);
  if (result.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters`);
  return result;
}

function mediaKey(value, label = "media key") {
  const key = boundedString(value, label, 80, { required: true }).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(key)) {
    throw new Error(`${label} must use lowercase letters, numbers, dots, underscores, or hyphens`);
  }
  return key;
}

function stablePublicUrl(value, label = "media asset publicUrl") {
  const url = boundedString(value, label, 2_000, { required: true });
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} must be an HTTPS URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new Error(`${label} must be a stable HTTPS URL`);
  }
  if ([...parsed.searchParams.keys()].some((key) => /^x-amz-/i.test(key))) {
    throw new Error(`${label} cannot contain an expiring storage signature`);
  }
  return parsed.toString();
}

function mediaKind(contentType) {
  const type = String(contentType || "").toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (["application/pdf", "application/postscript"].includes(type)) return "document";
  return "other";
}

function validatedBytes(value, label) {
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_MEDIA_BYTES) throw new Error(`${label} is invalid`);
  return bytes;
}

function validatedSha(value, label) {
  const sha256 = boundedString(value, label, 64, { required: true }).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`${label} is invalid`);
  return sha256;
}

function normalizedTags(value, label) {
  const tags = Array.isArray(value)
    ? value.slice(0, 50).map((tag) => boundedString(tag, label, 80, { required: true }))
    : [];
  return [...new Set(tags)];
}

function normalizedCatalogAsset(value, index, schemaVersion) {
  const label = `media.json assets[${index}]`;
  const asset = objectValue(value, label);
  const id = boundedString(asset.id, `${label}.id`, 100, { required: true });
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,99}$/.test(id)) throw new Error(`${label}.id is invalid`);
  const contentType = boundedString(asset.contentType, `${label}.contentType`, 200, { required: true });
  const legacy = schemaVersion === 1;
  const publicUrl = legacy && String(asset.visibility || "private") !== "public"
    ? boundedString(asset.publicUrl, `${label}.publicUrl`, 2_000)
    : stablePublicUrl(asset.publicUrl, `${label}.publicUrl`);
  if (publicUrl) stablePublicUrl(publicUrl, `${label}.publicUrl`);
  return {
    bytes: validatedBytes(asset.bytes, `${label}.bytes`),
    contentType,
    filename: boundedString(asset.filename, `${label}.filename`, 300, { required: true }),
    id,
    key: mediaKey(asset.key || (legacy ? id.toLowerCase() : ""), `${label}.key`),
    kind: boundedString(asset.kind || mediaKind(contentType), `${label}.kind`, 40, { required: true }),
    publicUrl,
    sha256: validatedSha(asset.sha256, `${label}.sha256`),
    tags: normalizedTags(asset.tags, `${label}.tags`),
    title: boundedString(asset.title, `${label}.title`, 300, { required: true }),
  };
}

export function validateMediaCatalog(input) {
  const catalog = objectValue(input, "media.json");
  const schemaVersion = Number(catalog.schemaVersion ?? 2);
  if (![1, 2].includes(schemaVersion)) {
    throw new Error(`media.json schemaVersion ${String(catalog.schemaVersion || "")} is unsupported`);
  }
  const rawAssets = Array.isArray(catalog.assets) ? catalog.assets : [];
  if (rawAssets.length > MAX_MEDIA_ASSETS) throw new Error(`media.json contains more than ${MAX_MEDIA_ASSETS} assets`);
  const assets = rawAssets.map((asset, index) => normalizedCatalogAsset(asset, index, schemaVersion));
  const ids = new Set();
  const keys = new Set();
  for (const asset of assets) {
    if (ids.has(asset.id)) throw new Error(`media.json contains duplicate asset id ${asset.id}`);
    if (keys.has(asset.key)) throw new Error(`media.json contains duplicate asset key ${asset.key}`);
    ids.add(asset.id);
    keys.add(asset.key);
  }
  return { assets, schemaVersion };
}

export async function readMediaCatalog(designSystemRoot, { required = false } = {}) {
  const catalogPath = path.join(designSystemRoot, "media.json");
  try {
    return { catalog: validateMediaCatalog(JSON.parse(await fs.readFile(catalogPath, "utf8"))), catalogPath };
  } catch (caught) {
    if (!required && caught?.code === "ENOENT") return { catalog: { assets: [], schemaVersion: 2 }, catalogPath };
    if (caught instanceof SyntaxError) throw new Error(`media.json is invalid JSON: ${caught.message}`);
    throw caught;
  }
}

function normalizedLocalAsset(value, index) {
  const label = `.timds/local-media.json assets[${index}]`;
  const asset = objectValue(value, label);
  const localPath = boundedString(asset.path, `${label}.path`, 600, { required: true }).replaceAll("\\", "/");
  if (!localPath.startsWith("media-local/") || localPath.split("/").some((part) => ["", ".", ".."].includes(part))) {
    throw new Error(`${label}.path must stay inside media-local/`);
  }
  const contentType = boundedString(asset.contentType, `${label}.contentType`, 200, { required: true });
  return {
    bytes: validatedBytes(asset.bytes, `${label}.bytes`),
    contentType,
    filename: boundedString(asset.filename, `${label}.filename`, 300, { required: true }),
    key: mediaKey(asset.key, `${label}.key`),
    kind: boundedString(asset.kind || mediaKind(contentType), `${label}.kind`, 40, { required: true }),
    path: localPath,
    sha256: validatedSha(asset.sha256, `${label}.sha256`),
    tags: normalizedTags(asset.tags, `${label}.tags`),
    title: boundedString(asset.title, `${label}.title`, 300, { required: true }),
  };
}

export function validateLocalMediaManifest(input) {
  const manifest = objectValue(input, ".timds/local-media.json");
  if (Number(manifest.schemaVersion ?? 1) !== 1) throw new Error(".timds/local-media.json schemaVersion is unsupported");
  const rawAssets = Array.isArray(manifest.assets) ? manifest.assets : [];
  if (rawAssets.length > MAX_MEDIA_ASSETS) throw new Error(`Local media contains more than ${MAX_MEDIA_ASSETS} assets`);
  const assets = rawAssets.map(normalizedLocalAsset);
  const keys = new Set();
  for (const asset of assets) {
    if (keys.has(asset.key)) throw new Error(`Local media contains duplicate asset key ${asset.key}`);
    keys.add(asset.key);
  }
  return { assets, schemaVersion: 1 };
}

export async function readLocalMediaManifest(designSystemRoot) {
  const manifestPath = path.join(designSystemRoot, ".timds", "local-media.json");
  try {
    return { manifest: validateLocalMediaManifest(JSON.parse(await fs.readFile(manifestPath, "utf8"))), manifestPath };
  } catch (caught) {
    if (caught?.code === "ENOENT") return { manifest: { assets: [], schemaVersion: 1 }, manifestPath };
    if (caught instanceof SyntaxError) throw new Error(`.timds/local-media.json is invalid JSON: ${caught.message}`);
    throw caught;
  }
}

async function fileSha256(filePath) {
  const handle = await fs.open(filePath, "r");
  const hash = createHash("sha256");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

function contentTypeForFile(filePath, explicit) {
  const supplied = String(explicit || "").trim().toLowerCase();
  return supplied || mediaContentTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function keyFromFile(filePath) {
  const stem = path.basename(filePath, path.extname(filePath)).toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
  return mediaKey(stem || "asset");
}

function insidePath(filePath, root) {
  const relative = path.relative(root, filePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function writeLocalManifest(manifestPath, manifest) {
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, `${JSON.stringify({ schemaVersion: 1, assets: manifest.assets }, null, 2)}\n`, "utf8");
}

export async function stageMediaFile(workspace, filePathInput, options = {}) {
  const sourcePath = path.resolve(workspace.repoRoot, filePathInput);
  const info = await fs.stat(sourcePath);
  if (!info.isFile() || info.size < 1 || info.size > MAX_MEDIA_BYTES) throw new Error("Media input must be a non-empty file smaller than 5 TiB");
  const key = mediaKey(options.key || keyFromFile(sourcePath));
  const mediaRoot = path.join(workspace.designSystemRoot, "media-local");
  await fs.mkdir(mediaRoot, { recursive: true });
  const sourceRealPath = await fs.realpath(sourcePath);
  const mediaRealPath = await fs.realpath(mediaRoot);
  let destination = sourceRealPath;
  if (!insidePath(sourceRealPath, mediaRealPath)) {
    destination = path.join(mediaRoot, `${key}${path.extname(sourcePath).toLowerCase()}`);
    try {
      const existing = await fs.stat(destination);
      if (existing.isFile() && await fileSha256(destination) === await fileSha256(sourceRealPath)) {
        // The exact file was already copied into the ignored local workspace.
      } else {
        throw new Error(`media-local/${path.basename(destination)} already exists; choose another --key or remove it explicitly`);
      }
    } catch (caught) {
      if (caught?.code !== "ENOENT") throw caught;
      await fs.copyFile(sourceRealPath, destination, fsConstants.COPYFILE_EXCL);
    }
  }
  const destinationRealPath = await fs.realpath(destination);
  if (!insidePath(destinationRealPath, mediaRealPath)) throw new Error("Staged media must stay inside media-local/");
  const destinationInfo = await fs.stat(destinationRealPath);
  const contentType = contentTypeForFile(destinationRealPath, options.contentType);
  const local = normalizedLocalAsset({
    bytes: destinationInfo.size,
    contentType,
    filename: path.basename(destinationRealPath),
    key,
    kind: mediaKind(contentType),
    path: path.relative(workspace.designSystemRoot, destinationRealPath).split(path.sep).join("/"),
    sha256: await fileSha256(destinationRealPath),
    tags: String(options.tags || "").split(",").map((tag) => tag.trim()).filter(Boolean),
    title: String(options.title || path.basename(sourcePath, path.extname(sourcePath))).trim(),
  }, 0);
  const { manifest, manifestPath } = await readLocalMediaManifest(workspace.designSystemRoot);
  const assets = manifest.assets.filter((asset) => asset.key !== key);
  assets.push(local);
  assets.sort((left, right) => left.key.localeCompare(right.key));
  await writeLocalManifest(manifestPath, { assets });
  return { asset: local, copied: destinationRealPath !== sourceRealPath, manifestPath };
}

function requestHeaders(token, contentType = "application/json") {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    ...(contentType ? { "Content-Type": contentType } : {}),
  };
}

async function portalJson(fetchImpl, url, token, { body, method = "GET" } = {}) {
  const response = await fetchImpl(url, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: requestHeaders(token),
    method,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(payload.error || payload.message || `${method} ${url} returned ${response.status}`));
  return payload;
}

function portalEndpoint(portalUrl, pathname) {
  const base = new URL(String(portalUrl || "https://timds.com"));
  if (!["http:", "https:"].includes(base.protocol)) throw new Error("TimDS portal URL must use HTTP or HTTPS");
  return new URL(pathname, `${base.origin}/`).toString();
}

async function putSingleFile(fetchImpl, upload, filePath, contentType) {
  const content = await fs.readFile(filePath);
  const response = await fetchImpl(upload.url, {
    body: content,
    headers: { "Content-Type": contentType, ...(upload.headers || {}) },
    method: "PUT",
  });
  if (!response.ok) {
    const detail = String(await response.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 500);
    throw new Error(`Object upload returned ${response.status}${detail ? `: ${detail}` : ""}`);
  }
}

async function putMultipartFile(fetchImpl, upload, filePath, contentType, token) {
  const handle = await fs.open(filePath, "r");
  const parts = [];
  const partSize = Number(upload.partSize || DEFAULT_MULTIPART_PART_BYTES);
  if (!Number.isSafeInteger(partSize) || partSize < 5 * 1024 ** 2) throw new Error("TimDS returned an invalid multipart part size");
  try {
    let partNumber = 1;
    let position = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(partSize);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      const signed = await portalJson(fetchImpl, upload.partsUrl, token, { body: { partNumber }, method: "POST" });
      const response = await fetchImpl(signed.url, {
        body: buffer.subarray(0, bytesRead),
        headers: { "Content-Type": contentType, ...(signed.headers || {}) },
        method: "PUT",
      });
      if (!response.ok) {
        const detail = String(await response.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 500);
        throw new Error(`Object upload part ${partNumber} returned ${response.status}${detail ? `: ${detail}` : ""}`);
      }
      const etag = String(response.headers.get("etag") || "").trim();
      if (!etag) throw new Error(`Object upload part ${partNumber} did not return an ETag`);
      parts.push({ etag, partNumber });
      position += bytesRead;
      partNumber += 1;
      if (partNumber > 10_001) throw new Error("Object upload exceeds the multipart part limit");
    }
  } finally {
    await handle.close();
  }
  return parts;
}

function catalogRecord(asset, local) {
  return normalizedCatalogAsset({
    ...local,
    id: asset.id,
    publicUrl: asset.publicUrl,
  }, 0, 2);
}

async function writeCatalog(catalogPath, catalog, asset) {
  const assets = catalog.assets.filter((entry) => entry.key !== asset.key && entry.id !== asset.id);
  assets.push(asset);
  assets.sort((left, right) => left.key.localeCompare(right.key));
  const next = { assets, schemaVersion: 2 };
  await fs.writeFile(catalogPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

async function uploadLocalAsset(workspace, local, options) {
  const filePath = path.join(workspace.designSystemRoot, local.path);
  const currentInfo = await fs.stat(filePath);
  if (!currentInfo.isFile() || currentInfo.size !== local.bytes || await fileSha256(filePath) !== local.sha256) {
    throw new Error(`Local media ${local.key} changed after staging; run assets add again`);
  }
  const portalUrl = options.portalUrl || workspace.manifest.media?.portalUrl || process.env.TIMDS_PORTAL_URL || "https://timds.com";
  const token = await resolveAccessToken(portalUrl, options);
  if (!token) throw new Error("Sign in with `timds auth login` or set TIMDS_ACCESS_TOKEN before publishing media");
  const fetchImpl = options.fetchImpl || fetch;
  const created = await portalJson(fetchImpl, portalEndpoint(portalUrl, "/api/operator/design-system-assets/uploads"), token, {
    body: {
      ...local,
      sourceId: options.sourceId || process.env.TIMDS_SOURCE_ID || "",
      systemId: workspace.manifest.systemId,
      visibility: "public",
    },
    method: "POST",
  });
  let asset = created.asset;
  if (created.upload) {
    const upload = {
      ...created.upload,
      cancelUrl: created.upload.cancelUrl
        ? portalEndpoint(portalUrl, created.upload.cancelUrl)
        : created.upload.id
          ? portalEndpoint(portalUrl, `/api/operator/design-system-assets/uploads/${encodeURIComponent(created.upload.id)}`)
          : null,
      completeUrl: portalEndpoint(portalUrl, created.upload.completeUrl),
      partsUrl: created.upload.partsUrl ? portalEndpoint(portalUrl, created.upload.partsUrl) : null,
    };
    try {
      let parts = [];
      if (upload.method === "multipart") parts = await putMultipartFile(fetchImpl, upload, filePath, local.contentType, token);
      else if (upload.method === "single") await putSingleFile(fetchImpl, upload, filePath, local.contentType);
      else throw new Error("TimDS returned an unsupported upload method");
      const completed = await portalJson(fetchImpl, upload.completeUrl, token, { body: { parts }, method: "POST" });
      asset = completed.asset;
    } catch (caught) {
      if (upload.cancelUrl) {
        try {
          await portalJson(fetchImpl, upload.cancelUrl, token, { method: "DELETE" });
        } catch {
          // Preserve the transfer error; the server-side upload lease still expires automatically.
        }
      }
      throw caught;
    }
  }
  if (!asset?.id || !asset?.publicUrl) throw new Error("TimDS did not return a public media asset record");
  return { asset: catalogRecord(asset, local), reused: Boolean(created.reused) };
}

export async function publishStagedMedia(workspace, options = {}) {
  const { manifest } = await readLocalMediaManifest(workspace.designSystemRoot);
  let { catalog, catalogPath } = await readMediaCatalog(workspace.designSystemRoot);
  const published = [];
  const unchanged = [];
  for (const local of manifest.assets) {
    const existing = catalog.assets.find((asset) => asset.key === local.key);
    if (existing?.sha256 === local.sha256 && existing.publicUrl) {
      unchanged.push(existing);
      continue;
    }
    const result = await uploadLocalAsset(workspace, local, options);
    catalog = await writeCatalog(catalogPath, catalog, result.asset);
    published.push(result);
  }
  return { catalogPath, published, staged: manifest.assets.length, unchanged };
}

export async function addMediaFile(workspace, filePathInput, options = {}) {
  const staged = await stageMediaFile(workspace, filePathInput, options);
  if (!options.publish) return staged;
  const result = await publishStagedMedia(workspace, options);
  return { ...staged, publication: result };
}

export async function pullMediaAsset(workspace, assetKey, options = {}) {
  const { catalog } = await readMediaCatalog(workspace.designSystemRoot, { required: true });
  const asset = catalog.assets.find((entry) => entry.key === assetKey || entry.id === assetKey);
  if (!asset) throw new Error(`Media asset ${assetKey} is not present in media.json`);
  if (!asset.publicUrl) throw new Error(`Media asset ${assetKey} does not have a public URL`);
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(asset.publicUrl);
  if (!response.ok || !response.body) throw new Error(`Media download returned ${response.status}`);
  const destination = options.output
    ? path.resolve(workspace.repoRoot, options.output)
    : path.join(workspace.designSystemRoot, "media-local", `${asset.key}${path.extname(asset.filename)}`);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const body = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(destination, body, { flag: options.force ? "w" : "wx" });
  const downloadedSha = await fileSha256(destination);
  if (downloadedSha !== asset.sha256) {
    await fs.unlink(destination).catch(() => {});
    throw new Error(`Downloaded media hash does not match media.json for ${assetKey}`);
  }
  const staged = await stageMediaFile(workspace, destination, { key: asset.key, tags: asset.tags.join(","), title: asset.title });
  return { asset, destination, staged };
}

export async function resolveMediaSource(designSystemRoot, keyInput, options = {}) {
  const key = mediaKey(keyInput);
  if (options.development) {
    const { manifest } = await readLocalMediaManifest(designSystemRoot);
    const local = manifest.assets.find((asset) => asset.key === key);
    if (local) return { ...local, local: true, src: `${LOCAL_MEDIA_ROUTE}${encodeURIComponent(key)}` };
  }
  const { catalog } = await readMediaCatalog(designSystemRoot, { required: true });
  const asset = catalog.assets.find((entry) => entry.key === key);
  if (!asset?.publicUrl) throw new Error(`TimDS media key ${key} is not published; run assets publish before building`);
  return { ...asset, local: false, src: asset.publicUrl };
}

function rangeForHeader(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(value || "").trim());
  if (!match) return null;
  let start = match[1] ? Number(match[1]) : null;
  let end = match[2] ? Number(match[2]) : null;
  if (start === null) {
    const suffix = Math.min(Number(end || 0), size);
    start = size - suffix;
    end = size - 1;
  } else {
    end = end === null ? size - 1 : Math.min(end, size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) return null;
  return { end, start };
}

export async function localMediaResponse(request, designSystemRoot) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(LOCAL_MEDIA_ROUTE)) return null;
  const key = mediaKey(decodeURIComponent(url.pathname.slice(LOCAL_MEDIA_ROUTE.length)));
  const { manifest } = await readLocalMediaManifest(designSystemRoot);
  const asset = manifest.assets.find((entry) => entry.key === key);
  if (!asset) return new Response("Not found", { status: 404 });
  const mediaRoot = await fs.realpath(path.join(designSystemRoot, "media-local"));
  const filePath = await fs.realpath(path.join(designSystemRoot, asset.path));
  if (!insidePath(filePath, mediaRoot)) return new Response("Not found", { status: 404 });
  const info = await fs.stat(filePath);
  const requestedRange = request.headers.get("range");
  const range = requestedRange ? rangeForHeader(requestedRange, info.size) : null;
  if (requestedRange && !range) {
    return new Response(null, { headers: { "Content-Range": `bytes */${info.size}` }, status: 416 });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? info.size - 1;
  const headers = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Content-Length": String(end - start + 1),
    "Content-Type": asset.contentType,
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${info.size}` } : {}),
  };
  if (request.method === "HEAD") return new Response(null, { headers, status: range ? 206 : 200 });
  const stream = createReadStream(filePath, { end, start });
  return new Response(Readable.toWeb(stream), { headers, status: range ? 206 : 200 });
}

export { LOCAL_MEDIA_ROUTE, mediaKind, portalEndpoint, portalJson, putMultipartFile, putSingleFile };

import { createHash } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const MAX_MEDIA_ASSETS = 5_000;
const MAX_MEDIA_BYTES = 5 * 1024 ** 4;
const DEFAULT_MULTIPART_PART_BYTES = 16 * 1024 ** 2;
const rightsStatuses = new Set(["client-owned", "licensed", "stock", "restricted", "unknown"]);
const visibilityValues = new Set(["private", "public"]);

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

function stablePublicUrl(value, label = "media asset publicUrl") {
  const url = boundedString(value, label, 2_000);
  if (!url) return "";
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

function normalizedCatalogAsset(value, index) {
  const asset = objectValue(value, `media.json assets[${index}]`);
  const id = boundedString(asset.id, `media.json assets[${index}].id`, 100, { required: true });
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,99}$/.test(id)) {
    throw new Error(`media.json assets[${index}].id is invalid`);
  }
  const sha256 = boundedString(asset.sha256, `media.json assets[${index}].sha256`, 64, { required: true }).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`media.json assets[${index}].sha256 is invalid`);
  const bytes = Number(asset.bytes);
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_MEDIA_BYTES) {
    throw new Error(`media.json assets[${index}].bytes is invalid`);
  }
  const visibility = boundedString(asset.visibility || "private", `media.json assets[${index}].visibility`, 20);
  if (!visibilityValues.has(visibility)) throw new Error(`media.json assets[${index}].visibility is invalid`);
  const rights = objectValue(asset.rights || {}, `media.json assets[${index}].rights`);
  const rightsStatus = boundedString(rights.status, `media.json assets[${index}].rights.status`, 40, { required: true });
  if (!rightsStatuses.has(rightsStatus)) throw new Error(`media.json assets[${index}].rights.status is invalid`);
  const publicUrl = stablePublicUrl(asset.publicUrl || "", `media.json assets[${index}].publicUrl`);
  if (visibility === "public" && !publicUrl) throw new Error(`media.json public asset ${id} requires publicUrl`);
  const tags = Array.isArray(asset.tags)
    ? asset.tags.slice(0, 50).map((tag) => boundedString(tag, `media.json assets[${index}].tags`, 80, { required: true }))
    : [];
  return {
    bytes,
    contentType: boundedString(asset.contentType, `media.json assets[${index}].contentType`, 200, { required: true }),
    filename: boundedString(asset.filename, `media.json assets[${index}].filename`, 300, { required: true }),
    id,
    kind: boundedString(asset.kind || mediaKind(asset.contentType), `media.json assets[${index}].kind`, 40, { required: true }),
    publicUrl,
    rights: {
      attribution: boundedString(rights.attribution, `media.json assets[${index}].rights.attribution`, 1_000),
      expiresOn: boundedString(rights.expiresOn, `media.json assets[${index}].rights.expiresOn`, 40),
      notes: boundedString(rights.notes, `media.json assets[${index}].rights.notes`, 2_000),
      status: rightsStatus,
    },
    sha256,
    tags: [...new Set(tags)],
    title: boundedString(asset.title, `media.json assets[${index}].title`, 300, { required: true }),
    visibility,
  };
}

export function validateMediaCatalog(input) {
  const catalog = objectValue(input, "media.json");
  const schemaVersion = Number(catalog.schemaVersion ?? 1);
  if (schemaVersion !== 1) throw new Error(`media.json schemaVersion ${String(catalog.schemaVersion || "")} is unsupported`);
  const rawAssets = Array.isArray(catalog.assets) ? catalog.assets : [];
  if (rawAssets.length > MAX_MEDIA_ASSETS) throw new Error(`media.json contains more than ${MAX_MEDIA_ASSETS} assets`);
  const assets = rawAssets.map(normalizedCatalogAsset);
  const ids = new Set();
  for (const asset of assets) {
    if (ids.has(asset.id)) throw new Error(`media.json contains duplicate asset id ${asset.id}`);
    ids.add(asset.id);
  }
  return { assets, schemaVersion };
}

export async function readMediaCatalog(designSystemRoot, { required = false } = {}) {
  const catalogPath = path.join(designSystemRoot, "media.json");
  try {
    return { catalog: validateMediaCatalog(JSON.parse(await fs.readFile(catalogPath, "utf8"))), catalogPath };
  } catch (caught) {
    if (!required && caught?.code === "ENOENT") return { catalog: { assets: [], schemaVersion: 1 }, catalogPath };
    if (caught instanceof SyntaxError) throw new Error(`media.json is invalid JSON: ${caught.message}`);
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
  if (supplied) return supplied;
  return mediaContentTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream";
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
  if (!response.ok) throw new Error(`Object upload returned ${response.status}`);
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
      const signed = await portalJson(fetchImpl, upload.partsUrl, token, {
        body: { partNumber },
        method: "POST",
      });
      const response = await fetchImpl(signed.url, {
        body: buffer.subarray(0, bytesRead),
        headers: { "Content-Type": contentType, ...(signed.headers || {}) },
        method: "PUT",
      });
      if (!response.ok) throw new Error(`Object upload part ${partNumber} returned ${response.status}`);
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
    bytes: local.bytes,
    contentType: local.contentType,
    filename: local.filename,
    id: asset.id,
    kind: asset.kind || local.kind,
    publicUrl: asset.publicUrl || "",
    rights: local.rights,
    sha256: local.sha256,
    tags: local.tags,
    title: local.title,
    visibility: local.visibility,
  }, 0);
}

async function writeCatalog(catalogPath, catalog, asset) {
  const assets = catalog.assets.filter((entry) => entry.id !== asset.id && entry.sha256 !== asset.sha256);
  assets.push(asset);
  assets.sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
  await fs.writeFile(catalogPath, `${JSON.stringify({ schemaVersion: 1, assets }, null, 2)}\n`, "utf8");
}

export async function addMediaFile(workspace, filePathInput, options = {}) {
  const filePath = path.resolve(workspace.repoRoot, filePathInput);
  const info = await fs.stat(filePath);
  if (!info.isFile() || info.size < 1 || info.size > MAX_MEDIA_BYTES) throw new Error("Media input must be a non-empty file smaller than 5 TiB");
  const rightsStatus = String(options.rights || "").trim();
  if (!rightsStatuses.has(rightsStatus)) {
    throw new Error("--rights must be client-owned, licensed, stock, restricted, or unknown");
  }
  const visibility = String(options.visibility || "private").trim();
  if (!visibilityValues.has(visibility)) throw new Error("--visibility must be private or public");
  if (visibility === "public" && rightsStatus === "unknown") {
    throw new Error("Public media requires known usage rights");
  }
  const contentType = contentTypeForFile(filePath, options.contentType);
  const sha256 = await fileSha256(filePath);
  const tags = String(options.tags || "").split(",").map((tag) => tag.trim()).filter(Boolean);
  const local = {
    bytes: info.size,
    contentType,
    filename: path.basename(filePath),
    kind: mediaKind(contentType),
    rights: {
      attribution: String(options.attribution || "").trim(),
      expiresOn: String(options.expiresOn || "").trim(),
      notes: String(options.rightsNotes || "").trim(),
      status: rightsStatus,
    },
    sha256,
    tags,
    title: String(options.title || path.basename(filePath, path.extname(filePath))).trim(),
    visibility,
  };
  const token = String(options.token || process.env.TIMDS_ACCESS_TOKEN || "").trim();
  if (!token) throw new Error("TIMDS_ACCESS_TOKEN is required for media upload");
  const portalUrl = options.portalUrl || workspace.manifest.media?.portalUrl || process.env.TIMDS_PORTAL_URL || "https://timds.com";
  const fetchImpl = options.fetchImpl || fetch;
  const created = await portalJson(fetchImpl, portalEndpoint(portalUrl, "/api/operator/design-system-assets/uploads"), token, {
    body: {
      ...local,
      sourceId: options.sourceId || process.env.TIMDS_SOURCE_ID || "",
      systemId: workspace.manifest.systemId,
    },
    method: "POST",
  });
  let asset = created.asset;
  if (created.upload) {
    const upload = {
      ...created.upload,
      completeUrl: portalEndpoint(portalUrl, created.upload.completeUrl),
      partsUrl: created.upload.partsUrl ? portalEndpoint(portalUrl, created.upload.partsUrl) : null,
    };
    let parts = [];
    if (upload.method === "multipart") {
      parts = await putMultipartFile(fetchImpl, upload, filePath, contentType, token);
    } else if (upload.method === "single") {
      await putSingleFile(fetchImpl, upload, filePath, contentType);
    } else {
      throw new Error("TimDS returned an unsupported upload method");
    }
    const completed = await portalJson(fetchImpl, upload.completeUrl, token, {
      body: { parts },
      method: "POST",
    });
    asset = completed.asset;
  }
  if (!asset?.id) throw new Error("TimDS did not return a media asset record");
  const { catalog, catalogPath } = await readMediaCatalog(workspace.designSystemRoot);
  const record = catalogRecord(asset, local);
  await writeCatalog(catalogPath, catalog, record);
  return { asset: record, catalogPath, reused: Boolean(created.reused) };
}

export async function pullMediaAsset(workspace, assetId, options = {}) {
  const { catalog } = await readMediaCatalog(workspace.designSystemRoot, { required: true });
  const asset = catalog.assets.find((entry) => entry.id === assetId);
  if (!asset) throw new Error(`Media asset ${assetId} is not present in media.json`);
  const token = String(options.token || process.env.TIMDS_ACCESS_TOKEN || "").trim();
  if (!token) throw new Error("TIMDS_ACCESS_TOKEN is required for media download");
  const portalUrl = options.portalUrl || workspace.manifest.media?.portalUrl || process.env.TIMDS_PORTAL_URL || "https://timds.com";
  const fetchImpl = options.fetchImpl || fetch;
  const handoff = await portalJson(
    fetchImpl,
    portalEndpoint(portalUrl, `/api/operator/design-system-assets/${encodeURIComponent(assetId)}/download`),
    token,
  );
  const response = await fetchImpl(handoff.url, { headers: handoff.headers || {} });
  if (!response.ok || !response.body) throw new Error(`Media download returned ${response.status}`);
  const destination = options.output
    ? path.resolve(workspace.repoRoot, options.output)
    : path.join(workspace.designSystemRoot, ".timds", "cache", "media", asset.id, asset.filename);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
  const downloadedSha = await fileSha256(destination);
  if (downloadedSha !== asset.sha256) {
    await fs.unlink(destination).catch(() => {});
    throw new Error(`Downloaded media hash does not match media.json for ${assetId}`);
  }
  return { asset, destination };
}

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { syncDefaults } from "./defaults.mjs";
import { fileSha256, readLocalMediaManifest, readMediaCatalog } from "./media.mjs";
import { createVideoProducer, validateVideoProducerConfig } from "./video-producer.mjs";
import { validateVideoVerticalMetadata } from "./video-crops.mjs";
import { deriveTokensFromArtifact } from "./extract.mjs";
import { readDerivedTokens } from "./tokens.mjs";
import { adjacentFootageRepeats, truncatedHeadline } from "../video/footage.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const VIDEO_SCHEMA_VERSION = 1;
const PUBLISHING_TARGETS = ["youtube_short", "facebook_reel", "instagram_reel"];
const productionFiles = ["request.json", "script.json", "publishing.json", "captions.json", "production.json"];
const DEFAULT_COMPONENTS_START = "// TIMDS_DEFAULT_COMPONENTS_START";
const DEFAULT_COMPONENTS_END = "// TIMDS_DEFAULT_COMPONENTS_END";
const DEFAULT_VIDEO_TEXT_SOURCE = String.raw`// A normal space keeps the font's intended advance width. The following word
// joiner prevents a line break without relying on the font's NBSP glyph, which
// can have a zero advance in subsetted webfonts. A non-breaking hyphen keeps a
// compound word intact at display sizes.
export const tieOrphan = (value: string) => value
  .replace(/(?<=\p{L})-(?=\p{L})/gu, "\u2011")
  .replace(/\s+(\S+)\s*$/u, " \u2060$1");

export function splitGoldHeadline(value: string, requestedPhrase?: string) {
  const headline = tieOrphan(value);
  const phrase = requestedPhrase || String(value).trim().split(/\s+/u).at(-1) || "";
  const candidates = phrase ? [tieOrphan(phrase), phrase] : [];
  const matched = candidates.find((candidate) => headline.toLocaleLowerCase().includes(candidate.toLocaleLowerCase())) || "";
  const index = matched ? headline.toLocaleLowerCase().lastIndexOf(matched.toLocaleLowerCase()) : -1;
  if (index < 0) return {before: headline, highlighted: "", after: ""};
  return {
    before: headline.slice(0, index),
    highlighted: headline.slice(index, index + matched.length),
    after: headline.slice(index + matched.length),
  };
}

const coverWords = (value: string) => String(value).trim().split(/\s+/u).filter(Boolean);

export type CoverHeadlineFitOptions = {
  width?: number;
  height?: number;
  maximum?: number;
  step?: number;
  lineHeight?: number;
  emPerCharacter?: number;
};

export function fitCoverHeadline(value: string, options: CoverHeadlineFitOptions = {}) {
  const width = Number(options.width || 896);
  const height = Number(options.height || 353);
  const maximum = Number(options.maximum || 120);
  const step = Number(options.step || 4);
  const lineHeight = Number(options.lineHeight || 1.01);
  const emPerCharacter = Number(options.emPerCharacter || 0.44);
  const words = coverWords(value);
  const longestWord = words.reduce((longest, word) => Math.max(longest, word.length), 0);
  for (let size = maximum; size > step; size -= step) {
    const charactersPerLine = width / (size * emPerCharacter);
    if (longestWord > charactersPerLine) continue;
    let rows = 1;
    let used = 0;
    for (const word of words) {
      if (used && used + 1 + word.length > charactersPerLine) {
        rows += 1;
        used = word.length;
      } else {
        used = used ? used + 1 + word.length : word.length;
      }
    }
    if (rows * size * lineHeight <= height) return size;
  }
  return step;
}`;

const object = (value, label) => {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(`${label} must be a JSON object`);
  return value;
};

const text = (value, label) => {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
};

const slug = (value, label = "slug") => {
  const result = text(value, label);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(result)) throw new Error(`${label} must use lowercase letters, numbers, and hyphens`);
  return result;
};

const safeRelativePath = (value, label) => {
  const result = text(value, label).replaceAll("\\", "/").replace(/^\/+/, "");
  if (result.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} must stay inside the Design System`);
  }
  return result;
};

const words = (value) => String(value ?? "").trim().split(/\s+/u).filter(Boolean);
const unique = (values) => [...new Set(values)];
const pascal = (value) => value.split("-").map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join("");

const fontFormatForPath = (filePath) => {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".woff2") return "woff2";
  if (extension === ".woff") return "woff";
  if (extension === ".otf") return "opentype";
  if (extension === ".ttf") return "truetype";
  throw new Error(`video font uses an unsupported file extension: ${filePath}`);
};

async function readJson(filePath, label, { required = true } = {}) {
  try {
    return object(JSON.parse(await fs.readFile(filePath, "utf8")), label);
  } catch (caught) {
    if (!required && caught?.code === "ENOENT") return null;
    if (caught instanceof SyntaxError) throw new Error(`${label} contains invalid JSON: ${caught.message}`);
    if (caught?.code === "ENOENT") throw new Error(`${label} is required at ${filePath}`);
    throw caught;
  }
}

export function normalizeVideoManifest(value) {
  if (value === undefined || value === null || value === false) return null;
  const video = value === true ? {} : object(value, "timds.json video");
  return {
    contract: safeRelativePath(video.contract || "video/contract.json", "timds.json video.contract"),
    assets: safeRelativePath(video.assets || "video/assets.json", "timds.json video.assets"),
    verticalMetadata: video.verticalMetadata ? safeRelativePath(video.verticalMetadata, "timds.json video.verticalMetadata") : null,
    productions: safeRelativePath(video.productions || "video/productions", "timds.json video.productions"),
    local: safeRelativePath(video.local || "video-local", "timds.json video.local"),
    lab: safeRelativePath(video.lab || "video/lab", "timds.json video.lab"),
    components: video.components
      ? safeRelativePath(video.components, "timds.json video.components")
      : null,
  };
}

const optionalText = (value, label) => (value === undefined || value === null || value === "" ? undefined : text(value, label));

/**
 * Persistent on-screen calls to action. Outros are rarely watched — least of all in
 * vertical Shorts — so a client can ask the default components to keep a CTA on every
 * frame instead: a pill top-right in horizontal renders and a kicker + URL banner under
 * the logo in vertical renders. Both are optional; wording stays client-owned.
 */
function normalizeVideoBanners(input) {
  if (input === undefined || input === null) return {};
  const banners = object(input, "video contract brand.banners");
  const normalized = {};
  const longform = optionalText(banners.longform, "video contract brand.banners.longform");
  if (longform) normalized.longform = longform;
  if (banners.short !== undefined && banners.short !== null) {
    const short = object(banners.short, "video contract brand.banners.short");
    const kicker = optionalText(short.kicker, "video contract brand.banners.short.kicker");
    normalized.short = { ...(kicker ? { kicker } : {}), url: text(short.url, "video contract brand.banners.short.url") };
  }
  return normalized;
}

/**
 * Package-time publishing copy. `shortDisclaimer` and `shortArticleLink` let a client keep
 * the full long-form description while the Short's description stays short: a Short's
 * description is not clickable on most platforms and the first line is all anyone reads.
 */
function normalizeVideoPublishing(input) {
  const publishing = input === undefined || input === null ? {} : object(input, "video contract publishing");
  const normalized = { ...publishing, shortArticleLink: publishing.shortArticleLink !== false };
  for (const key of ["articleLabel", "shortBridge", "disclaimer", "shortDisclaimer"]) {
    const value = optionalText(publishing[key], `video contract publishing.${key}`);
    if (value) normalized[key] = value; else delete normalized[key];
  }
  if (publishing.targetDefaults !== undefined) {
    normalized.targetDefaults = normalizeTargetOverrides(publishing.targetDefaults, "publishing.targetDefaults");
  }
  if (publishing.targets !== undefined) {
    normalized.targets = {};
    for (const [target, value] of Object.entries(object(publishing.targets, "publishing.targets"))) {
      if (!PUBLISHING_TARGETS.includes(target)) throw new Error(`Unknown publishing target: ${target}`);
      const policy = object(value, `publishing.targets.${target}`);
      normalized.targets[target] = {
        brief: text(policy.brief, `publishing.targets.${target}.brief`),
        maxCharacters: positiveInteger(policy.maxCharacters, `publishing.targets.${target}.maxCharacters`),
        maxCopyCharacters: positiveInteger(policy.maxCopyCharacters, `publishing.targets.${target}.maxCopyCharacters`),
        ...normalizeTargetOverrides(policy, `publishing.targets.${target}`),
      };
      if (normalized.targets[target].maxCopyCharacters > normalized.targets[target].maxCharacters) throw new Error(`${target} copy budget exceeds the final description budget`);
    }
  }
  return normalized;
}

// A brand file is either a path committed to the Design System or a published
// TimDS media record, `{ "mediaKey": "..." }`. Those are the only two sources
// every render host has: a Design System checkout and media.json.
function normalizeBrandSource(value, label) {
  if (typeof value === "string") return safeRelativePath(value, label);
  const source = object(value, label);
  return { mediaKey: text(source.mediaKey, `${label}.mediaKey`) };
}

function nonNegativeNumber(value, label, { integer = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || (integer && !Number.isSafeInteger(number))) {
    throw new Error(`${label} must be a non-negative ${integer ? "integer" : "number"}`);
  }
  return number;
}

function normalizeVideoAudio(input) {
  if (input === undefined || input === null) return undefined;
  const audio = { ...object(input, "video contract brand.audio") };
  for (const key of ["bed", "transition"]) {
    if (audio[key] === undefined || audio[key] === null || audio[key] === "") delete audio[key];
    else audio[key] = normalizeBrandSource(audio[key], `video contract brand.audio.${key}`);
  }
  for (const key of ["voiceGain", "restVolume", "duckVolume"]) {
    if (audio[key] !== undefined) audio[key] = nonNegativeNumber(audio[key], `video contract brand.audio.${key}`);
  }
  for (const key of ["attackFrames", "releaseFrames"]) {
    if (audio[key] !== undefined) audio[key] = nonNegativeNumber(audio[key], `video contract brand.audio.${key}`, { integer: true });
  }
  return audio;
}

function normalizeTargetOverrides(input, label) {
  const policy = object(input, label);
  const result = {};
  if (policy.shortArticleLink !== undefined) {
    if (typeof policy.shortArticleLink !== "boolean") throw new Error(`${label}.shortArticleLink must be boolean`);
    result.shortArticleLink = policy.shortArticleLink;
  }
  for (const key of ["shortBridge", "shortDisclaimer"]) {
    if (policy[key] !== undefined) result[key] = policy[key] === "" ? "" : text(policy[key], `${label}.${key}`);
  }
  return result;
}

function positiveInteger(value, label) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${label} must be a positive integer`);
  return result;
}

function normalizeFormat(value, label, defaults) {
  const format = object(value || {}, label);
  return {
    width: positiveInteger(format.width || defaults.width, `${label}.width`),
    height: positiveInteger(format.height || defaults.height, `${label}.height`),
  };
}

function normalizeStructure(value, label) {
  const structure = object(value || {}, label);
  if (structure.graphicScenes !== undefined && typeof structure.graphicScenes !== "boolean") throw new Error(`${label}.graphicScenes must be a boolean`);
  return {
    requireIntro: structure.requireIntro === true,
    requireOutro: structure.requireOutro === true,
    // A graphic scene carries a client-rendered `visual` board instead of, or
    // over, footage. Off by default: the client's components must draw it.
    graphicScenes: structure.graphicScenes === true,
  };
}

// Static files a client's components read with staticFile(): whole
// directories (an illustration library) or single files, mounted under a
// stable name in the render's public root. Everything must be committed
// Design System source so every render host can obtain it.
// The top-level directories the render public root uses: staged brand files,
// prepared footage and covers, and generated narration. Every stager below
// writes beneath one of these, and a static mount may not, so the reserved
// list is derived from the same names the stagers use.
export const VIDEO_PUBLIC_ROOTS = Object.freeze({ brand: "brand", media: "media", audio: "audio" });
const RESERVED_STATIC_MOUNTS = new Set(Object.values(VIDEO_PUBLIC_ROOTS));
// Whether `child` is `parent` or a path beneath it. Case-folded because macOS
// and Windows stage onto case-insensitive disks, where Media/ and media/ are
// one directory.
const pathWithin = (child, parent) => {
  const inner = child.toLowerCase();
  const outer = parent.toLowerCase();
  return inner === outer || inner.startsWith(`${outer}/`);
};
const mountOverlaps = (left, right) => pathWithin(left, right) || pathWithin(right, left);

function normalizeStaticFiles(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const mounts = [];
  return value.map((entry, index) => {
    const item = object(entry, `${label}[${index}]`);
    const source = safeRelativePath(text(item.path, `${label}[${index}].path`), `${label}[${index}].path`);
    const mount = text(item.mount || path.basename(source), `${label}[${index}].mount`).replace(/^\/+|\/+$/gu, "");
    // Lowercase only: Linux render hosts resolve staticFile() names exactly,
    // so a mixed-case mount would work on a Mac and 404 in CI.
    if (!/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/u.test(mount)) throw new Error(`${label}[${index}].mount must be a lowercase relative mount path`);
    if (RESERVED_STATIC_MOUNTS.has(mount.split("/")[0])) throw new Error(`${label}[${index}].mount ${mount} is reserved for staged brand files, prepared media, and narration; mount under another name`);
    const clash = mounts.find((other) => mountOverlaps(other, mount));
    if (clash) throw new Error(`${label}[${index}].mount ${mount} overlaps the earlier mount ${clash}`);
    mounts.push(mount);
    return { path: source, mount };
  });
}

export function validateVideoContract(input) {
  const contract = object(input, "video contract");
  if (Number(contract.schemaVersion) !== VIDEO_SCHEMA_VERSION) {
    throw new Error(`video contract schemaVersion must be ${VIDEO_SCHEMA_VERSION}`);
  }
  const formats = object(contract.formats || {}, "video contract formats");
  const packagePolicy = object(contract.package || {}, "video contract package");
  const structure = object(contract.structure || {}, "video contract structure");
  const staticFiles = normalizeStaticFiles(contract.brand?.staticFiles, "video contract brand.staticFiles");
  const copy = object(contract.copy || {}, "video contract copy");
  const brand = object(contract.brand || {}, "video contract brand");
  const colors = object(brand.colors || {}, "video contract brand.colors");
  const fonts = object(brand.fonts || {}, "video contract brand.fonts");
  const shortCount = Number(packagePolicy.shortCount ?? 0);
  const fontFiles = (brand.fontFiles || []).map((raw, index) => {
    const font = object(raw, `video contract brand.fontFiles[${index}]`);
    return {
      family: text(font.family, `video contract brand.fontFiles[${index}].family`),
      path: safeRelativePath(font.path, `video contract brand.fontFiles[${index}].path`),
      style: text(font.style || "normal", `video contract brand.fontFiles[${index}].style`),
      weight: text(font.weight || "400", `video contract brand.fontFiles[${index}].weight`),
    };
  });
  if (!Number.isSafeInteger(shortCount) || shortCount < 0 || shortCount > 20) {
    throw new Error("video contract package.shortCount must be an integer from 0 through 20");
  }
  const limits = {
    eyebrowWords: positiveInteger(copy.eyebrowWords || 5, "video contract copy.eyebrowWords"),
    horizontalHeadlineWords: positiveInteger(copy.horizontalHeadlineWords || 8, "video contract copy.horizontalHeadlineWords"),
    shortHeadlineWords: positiveInteger(copy.shortHeadlineWords || 4, "video contract copy.shortHeadlineWords"),
    horizontalSublineWords: positiveInteger(copy.horizontalSublineWords || 10, "video contract copy.horizontalSublineWords"),
    captionPageWords: positiveInteger(copy.captionPageWords || 5, "video contract copy.captionPageWords"),
    coverHeadlineWords: positiveInteger(copy.coverHeadlineWords || 20, "video contract copy.coverHeadlineWords"),
    coverHeadlineCharacters: positiveInteger(copy.coverHeadlineCharacters || 180, "video contract copy.coverHeadlineCharacters"),
  };
  return {
    ...contract,
    schemaVersion: VIDEO_SCHEMA_VERSION,
    id: slug(contract.id, "video contract id"),
    name: text(contract.name, "video contract name"),
    fps: positiveInteger(contract.fps || 30, "video contract fps"),
    formats: {
      longform: normalizeFormat(formats.longform, "video contract formats.longform", { width: 1920, height: 1080 }),
      cover: normalizeFormat(formats.cover, "video contract formats.cover", { width: 3840, height: 2160 }),
      short: normalizeFormat(formats.short, "video contract formats.short", { width: 1080, height: 1920 }),
    },
    package: {
      shortCount,
      timeZone: text(packagePolicy.timeZone || "UTC", "video contract package.timeZone"),
      longformDirectory: text(packagePolicy.longformDirectory || "Longform", "video contract package.longformDirectory"),
      shortDirectoryPrefix: text(packagePolicy.shortDirectoryPrefix || "Short form - ", "video contract package.shortDirectoryPrefix"),
    },
    structure: {
      longform: normalizeStructure(structure.longform, "video contract structure.longform"),
      short: normalizeStructure(structure.short, "video contract structure.short"),
    },
    copy: limits,
    producer: validateVideoProducerConfig(contract.producer, contract),
    brand: {
      ...brand,
      colors: {
        background: text(colors.background, "video contract brand.colors.background"),
        panel: text(colors.panel || colors.background, "video contract brand.colors.panel"),
        accent: text(colors.accent, "video contract brand.colors.accent"),
        text: text(colors.text, "video contract brand.colors.text"),
        muted: text(colors.muted || colors.text, "video contract brand.colors.muted"),
      },
      fonts: {
        display: text(fonts.display || "serif", "video contract brand.fonts.display"),
        body: text(fonts.body || "serif", "video contract brand.fonts.body"),
        ui: text(fonts.ui || "sans-serif", "video contract brand.fonts.ui"),
      },
      fontFiles,
      logo: safeRelativePath(brand.logo, "video contract brand.logo"),
      series: text(brand.series, "video contract brand.series"),
      site: text(brand.site, "video contract brand.site"),
      tagline: text(brand.tagline, "video contract brand.tagline"),
      watermark: {
        left: text(brand.watermark?.left || brand.series, "video contract brand.watermark.left"),
        right: text(brand.watermark?.right || brand.site, "video contract brand.watermark.right"),
      },
      banners: normalizeVideoBanners(brand.banners),
      staticFiles,
      ...(brand.audio === undefined || brand.audio === null ? {} : { audio: normalizeVideoAudio(brand.audio) }),
    },
    publishing: normalizeVideoPublishing(contract.publishing),
  };
}

function validateAssetCatalog(input) {
  const catalog = object(input, "video assets");
  if (Number(catalog.schemaVersion) !== VIDEO_SCHEMA_VERSION) throw new Error(`video assets schemaVersion must be ${VIDEO_SCHEMA_VERSION}`);
  const assets = object(catalog.assets || {}, "video assets.assets");
  for (const [key, raw] of Object.entries(assets)) {
    slug(key, `video asset key ${key}`);
    const asset = object(raw, `video asset ${key}`);
    const sources = [asset.mediaKey, asset.publicPath, asset.localPath].filter(Boolean);
    if (sources.length !== 1) throw new Error(`video asset ${key} needs exactly one of mediaKey, publicPath, or localPath`);
    if (asset.mediaKey) slug(asset.mediaKey, `video asset ${key}.mediaKey`);
    if (asset.publicPath) safeRelativePath(asset.publicPath, `video asset ${key}.publicPath`);
    if (asset.localPath) safeRelativePath(asset.localPath, `video asset ${key}.localPath`);
    if (asset.kind && !["image", "video"].includes(asset.kind)) throw new Error(`video asset ${key}.kind must be image or video`);
    if (asset.durationSeconds !== undefined && (!Number.isFinite(asset.durationSeconds) || asset.durationSeconds <= 0)) {
      throw new Error(`video asset ${key}.durationSeconds must be a positive number`);
    }
    if (asset.vertical) slug(asset.vertical, `video asset ${key}.vertical`);
    // Top zones keep the copy box above a clip whose action crosses the middle band.
    if (asset.text && !["left-top", "left-center", "left-bottom", "right-top", "right-center", "right-bottom", "bottom", "upper", "lower"].includes(asset.text)) {
      throw new Error(`video asset ${key}.text is unsupported`);
    }
  }
  return { ...catalog, schemaVersion: VIDEO_SCHEMA_VERSION, assets };
}

function validateNaturalSpeedFootage(scene, line, pads, contract, assetCatalog, label) {
  if (scene.intro || scene.outro) return;
  const keys = scene.assets ?? (scene.asset ? [scene.asset] : []);
  if (!keys.length && isGraphicScene(scene)) return;
  const sceneAssets = keys.map((key) => {
    const asset = assetCatalog.assets[key];
    if (!asset) throw new Error(`${label} references undeclared video asset ${key}`);
    if (!Number.isFinite(asset.durationSeconds) || asset.durationSeconds <= 0) {
      throw new Error(`${label} video asset ${key} needs durationSeconds so TimDS can enforce natural 1x playback`);
    }
    return asset;
  });
  const pad = pads?.[scene.id] || {};
  const requiredFrames = Number(pad.lead || 0) + Math.max(1, Math.round(line.durationMs / 1000 * contract.fps)) + Number(pad.tail || 0);
  const availableFrames = sceneAssets.reduce((sum, asset) => sum + Math.max(1, Math.floor(asset.durationSeconds * contract.fps)), 0);
  if (availableFrames < requiredFrames) {
    throw new Error(`${label} needs ${(requiredFrames / contract.fps).toFixed(2)}s but its natural-speed footage chain provides only ${(availableFrames / contract.fps).toFixed(2)}s`);
  }
}

function validateCaptionLine(line, label) {
  object(line, label);
  const id = slug(line.id, `${label}.id`);
  if (!Number.isFinite(line.durationMs) || line.durationMs <= 0) throw new Error(`${label}.durationMs must be positive`);
  if (!Array.isArray(line.words)) throw new Error(`${label}.words must be an array`);
  return { ...line, id };
}

/**
 * A graphic scene declares `visual: { kind, ... }`. TimDS validates only the
 * shape and the client opt-in; the client's components own every board kind,
 * its copy budget, and its motion. Without footage it renders on the brand
 * background; with footage the board sits over the clip.
 */
export function isGraphicScene(scene) {
  return Boolean(scene && !scene.intro && !scene.outro && scene.visual && typeof scene.visual === "object");
}

function validateSceneVisual(scene, label, contract, format) {
  if (scene.visual === undefined || scene.visual === null) return undefined;
  const structure = contract.structure[format === "short" ? "short" : "longform"];
  if (!structure.graphicScenes) throw new Error(`${label}.visual needs structure.${format === "short" ? "short" : "longform"}.graphicScenes enabled in the video contract`);
  const visual = object(scene.visual, `${label}.visual`);
  const kind = slug(visual.kind, `${label}.visual.kind`);
  return { ...visual, kind };
}

function validateScene(scene, label, contract, format) {
  object(scene, label);
  const id = slug(scene.id, `${label}.id`);
  if (scene.intro && scene.outro) throw new Error(`${label} cannot be both intro and outro`);
  const visual = validateSceneVisual(scene, label, contract, format);
  if (scene.chapter !== undefined && scene.chapter !== null) slug(scene.chapter, `${label}.chapter`);
  if (!scene.intro && !scene.outro && visual) {
    // A board owns its copy; a headline box is optional and, when present,
    // holds the same budget as any footage scene.
    if (scene.headline !== undefined && scene.headline !== null) {
      const headline = text(scene.headline, `${label}.headline`);
      const headlineLimit = format === "short" ? contract.copy.shortHeadlineWords : contract.copy.horizontalHeadlineWords;
      if (words(headline).length > headlineLimit) throw new Error(`${label}.headline exceeds ${headlineLimit} words`);
    }
    if (scene.eyebrow && words(scene.eyebrow).length > contract.copy.eyebrowWords) throw new Error(`${label}.eyebrow exceeds ${contract.copy.eyebrowWords} words`);
    const assetKeys = scene.assets ?? (scene.asset ? [scene.asset] : []);
    if (!Array.isArray(assetKeys)) throw new Error(`${label}.assets must be an array`);
    for (const asset of assetKeys) slug(asset, `${label} asset`);
  }
  if (!scene.intro && !scene.outro && !visual) {
    const headline = text(scene.headline, `${label}.headline`);
    const headlineLimit = format === "short" ? contract.copy.shortHeadlineWords : contract.copy.horizontalHeadlineWords;
    if (words(headline).length > headlineLimit) throw new Error(`${label}.headline exceeds ${headlineLimit} words`);
    if (truncatedHeadline(headline)) throw new Error(`${label}.headline must be a complete thought within its word limit; it appears truncated: ${JSON.stringify(headline)}`);
    if (scene.eyebrow && words(scene.eyebrow).length > contract.copy.eyebrowWords) throw new Error(`${label}.eyebrow exceeds ${contract.copy.eyebrowWords} words`);
    if (format === "short" && scene.subline) throw new Error(`${label}.subline is not supported in shorts`);
    if (scene.subline && words(scene.subline).length > contract.copy.horizontalSublineWords) throw new Error(`${label}.subline exceeds ${contract.copy.horizontalSublineWords} words`);
    const assetKeys = scene.assets ?? (scene.asset ? [scene.asset] : []);
    if (!Array.isArray(assetKeys) || !assetKeys.length) throw new Error(`${label} needs asset or assets`);
    for (const asset of assetKeys) slug(asset, `${label} asset`);
  }
  return { ...scene, id, ...(visual ? { visual } : {}) };
}

function validateCover(cover, label, contract) {
  object(cover, label);
  const headline = text(cover.headline, `${label}.headline`);
  if (words(headline).length > contract.copy.coverHeadlineWords) throw new Error(`${label}.headline exceeds ${contract.copy.coverHeadlineWords} words`);
  if (headline.length > contract.copy.coverHeadlineCharacters) throw new Error(`${label}.headline exceeds ${contract.copy.coverHeadlineCharacters} characters`);
  if (contract.copy.coverMustBeQuestion !== false && !headline.endsWith("?")) throw new Error(`${label}.headline must end in a question mark`);
  if (cover.goldPhrase && !headline.toLocaleLowerCase().includes(String(cover.goldPhrase).toLocaleLowerCase())) {
    throw new Error(`${label}.goldPhrase must be an exact part of its headline`);
  }
  if (cover.atSeconds !== undefined && (!Number.isFinite(cover.atSeconds) || cover.atSeconds < 0)) {
    throw new Error(`${label}.atSeconds must be a non-negative number`);
  }
  return { ...cover, headline, asset: slug(cover.asset, `${label}.asset`) };
}

function assertNoAdjacentFootageRepeats(scenes, label) {
  const [repeat] = adjacentFootageRepeats(scenes);
  if (repeat) {
    throw new Error(`${label} plays ${repeat.previous.key} (scene ${repeat.previous.scene}) directly into ${repeat.current.key} (scene ${repeat.current.scene}); back-to-back footage from one family is not allowed`);
  }
}

function validateProduction(records, contract, assetCatalog, label) {
  const { production, captions, publishing, request, script } = records;
  if (Number(production.schemaVersion) !== VIDEO_SCHEMA_VERSION) throw new Error(`${label}/production.json schemaVersion must be ${VIDEO_SCHEMA_VERSION}`);
  const productionSlug = slug(production.slug, `${label}/production.json slug`);
  if (script.slug && script.slug !== productionSlug) throw new Error(`${label}/script.json slug must match production.json`);
  const lines = (captions.lines || []).map((line, index) => validateCaptionLine(line, `${label}/captions.json lines[${index}]`));
  const lineIds = new Set(lines.map((line) => line.id));
  const linesById = new Map(lines.map((line) => [line.id, line]));
  const longform = object(production.longform, `${label}/production.json longform`);
  const longScenes = (longform.scenes || []).map((scene, index) => validateScene(scene, `${label} longform scene ${index + 1}`, contract, "horizontal"));
  if (!longScenes.length) throw new Error(`${label} needs longform scenes`);
  if (contract.structure.longform.requireIntro && !longScenes[0].intro) throw new Error(`${label} longform must begin with intro`);
  if (contract.structure.longform.requireOutro && !longScenes.at(-1).outro) throw new Error(`${label} longform must end with outro`);
  for (const scene of longScenes) if (!lineIds.has(scene.id)) throw new Error(`${label} longform scene ${scene.id} has no caption line`);
  for (const scene of longScenes) validateNaturalSpeedFootage(scene, linesById.get(scene.id), longform.pads, contract, assetCatalog, `${label} longform scene ${scene.id}`);
  assertNoAdjacentFootageRepeats(longScenes, `${label} longform`);
  const shorts = (production.shorts || []).map((short, shortIndex) => {
    object(short, `${label} short ${shortIndex + 1}`);
    const id = slug(short.id, `${label} short ${shortIndex + 1}.id`);
    const harvest = Array.isArray(short.harvest) ? short.harvest.map((line) => slug(line, `${label} short ${id} harvest`)) : [];
    if (!harvest.length) throw new Error(`${label} short ${id} needs harvest line ids`);
    for (const line of harvest) if (!lineIds.has(line)) throw new Error(`${label} short ${id} references missing line ${line}`);
    const scenes = (short.scenes || []).map((scene, index) => validateScene(scene, `${label} short ${id} scene ${index + 1}`, contract, "short"));
    if (!scenes.length) throw new Error(`${label} short ${id} needs scenes`);
    if (scenes.map((scene) => scene.id).join("|") !== harvest.join("|")) throw new Error(`${label} short ${id} scenes must match harvest order`);
    if (contract.structure.short.requireIntro && !scenes[0].intro) throw new Error(`${label} short ${id} must begin with intro`);
    if (contract.structure.short.requireOutro && !scenes.at(-1).outro) throw new Error(`${label} short ${id} must end with outro`);
    for (const scene of scenes) validateNaturalSpeedFootage(scene, linesById.get(scene.id), short.pads, contract, assetCatalog, `${label} short ${id} scene ${scene.id}`);
    assertNoAdjacentFootageRepeats(scenes, `${label} short ${id}`);
    return { ...short, id, harvest, scenes, cover: validateCover(short.cover, `${label} short ${id}.cover`, contract) };
  });
  if (shorts.length !== contract.package.shortCount) throw new Error(`${label} has ${shorts.length} shorts; contract requires ${contract.package.shortCount}`);
  const cover = validateCover(longform.cover, `${label} longform.cover`, contract);
  const usedAssets = unique([
    cover.asset,
    ...longScenes.flatMap((scene) => scene.assets ?? (scene.asset ? [scene.asset] : [])),
    ...shorts.flatMap((short) => [short.cover.asset, ...short.scenes.flatMap((scene) => scene.assets ?? (scene.asset ? [scene.asset] : []))]),
  ]);
  for (const key of usedAssets) if (!assetCatalog.assets[key]) throw new Error(`${label} references undeclared video asset ${key}`);
  for (const short of publishing.shorts || []) {
    // Adding a variants map opts this record into platform validation.
    if (!short.descriptions) continue;
    for (const target of Object.keys(contract.publishing.targets || {})) {
      descriptionFor({ production: { publishing }, video: { contract } }, short, target);
    }
  }
  return { captions: { ...captions, lines }, production: { ...production, slug: productionSlug, longform: { ...longform, scenes: longScenes, cover }, shorts }, publishing, request, script, usedAssets };
}

// --- brand token references -------------------------------------------------
//
// The Design System declares its colors and fonts once, as CSS custom
// properties that `timds check` derives into dist tokens.json. A video contract
// can reference them — `"{color.accent}"` for a brand role, `"{--gold-300}"`
// for a token — instead of copying values that then drift. References resolve
// when the workspace loads, so the renderer and every consumer see values.

const BRAND_REFERENCE = /^\{\s*((?:color|font)\.[a-z][a-z0-9-]*|--[a-zA-Z0-9_-]+)\s*\}$/;
const BRAND_VALUE_FIELDS = [["colors", "background"], ["colors", "panel"], ["colors", "accent"], ["colors", "text"], ["colors", "muted"], ["fonts", "display"], ["fonts", "body"], ["fonts", "ui"]];

export const parseBrandReference = (value) => BRAND_REFERENCE.exec(String(value ?? "").trim())?.[1] ?? null;

function lookupBrandReference(name, tokens) {
  if (name.startsWith("--")) {
    const token = [...tokens.tokens].reverse().find((entry) => entry.name === name && entry.base);
    return token ? { value: token.resolved, kind: token.kind } : null;
  }
  const role = tokens.roles?.[name];
  return role ? { value: role.value, kind: role.kind } : null;
}

/**
 * Replace every brand reference in the contract with its derived value.
 * A reference without derived tokens is an error with the fix in it, since a
 * render host cannot guess the brand — unless the caller only validates
 * (`optional`), in which case the reference stays as written and is reported
 * in `unresolved` so a check can warn instead of failing before the build.
 */
export function resolveVideoBrand(contract, tokens, { optional = false } = {}) {
  const references = [];
  const unresolved = [];
  const resolved = { ...contract, brand: { ...contract.brand, colors: { ...contract.brand.colors }, fonts: { ...contract.brand.fonts } } };
  for (const [group, field] of BRAND_VALUE_FIELDS) {
    const name = parseBrandReference(contract.brand[group][field]);
    if (!name) continue;
    const label = `video contract brand.${group}.${field}`;
    if (!tokens) {
      if (optional) {
        unresolved.push({ field: `brand.${group}.${field}`, reference: name });
        continue;
      }
      throw new Error(`${label} references ${name}, but the design tokens are not derived; build the artifact with timds check first`);
    }
    const found = lookupBrandReference(name, tokens);
    if (!found) throw new Error(`${label} references ${name}, which the derived tokens do not fill${name.startsWith("--") ? " on :root" : "; map it in timds.json brand.roles"}`);
    const expected = group === "colors" ? "color" : "font-family";
    if (found.kind !== expected) throw new Error(`${label} references ${name}, which resolves to ${found.value} (${found.kind}), not a ${expected}`);
    resolved.brand[group][field] = found.value;
    references.push({ field: `brand.${group}.${field}`, reference: name, value: found.value });
  }
  return { contract: resolved, references, unresolved };
}

// Quoting is optional around most font family names, so compare without it.
const normalizeBrandValue = (value) => String(value ?? "").replace(/["']/g, "").replace(/\s+/g, " ").replace(/\s*,\s*/g, ",").trim().toLowerCase();

/** Literal brand values that duplicate a derived token: they should be references. */
export function brandDriftWarnings(contract, tokens) {
  if (!tokens) return [];
  const warnings = [];
  const roleByValue = new Map();
  for (const [role, entry] of Object.entries(tokens.roles ?? {})) if (!roleByValue.has(normalizeBrandValue(entry.value))) roleByValue.set(normalizeBrandValue(entry.value), role);
  const tokenByValue = new Map();
  for (const token of tokens.tokens ?? []) if (token.base && !tokenByValue.has(normalizeBrandValue(token.resolved))) tokenByValue.set(normalizeBrandValue(token.resolved), token.name);
  for (const [group, field] of BRAND_VALUE_FIELDS) {
    const raw = contract.brand[group][field];
    if (parseBrandReference(raw)) continue;
    const value = normalizeBrandValue(raw);
    if (!value) continue;
    const match = roleByValue.get(value) ?? tokenByValue.get(value);
    if (match) warnings.push(`brand.${group}.${field} "${raw}" duplicates design token ${match}; reference it as "{${match}}" so it cannot drift`);
  }
  return warnings;
}

/**
 * The derived tokens for a workspace: the tokens.json `timds check` wrote, or
 * a derivation from the built pages when that file is missing, or null when
 * nothing is built yet.
 */
async function loadWorkspaceTokens(workspace) {
  return (await readDerivedTokens(workspace.designSystemRoot, workspace.manifest))
    ?? deriveTokensFromArtifact({ artifactRoot: path.join(workspace.designSystemRoot, "dist"), manifest: workspace.manifest });
}

/**
 * `brandValues: "optional"` is for validation before a build: brand references
 * stay unresolved and are reported, instead of failing for want of tokens.
 * Every path that hands the contract to a renderer or the lab keeps the
 * default, where an unresolvable reference is an error.
 */
export async function loadVideoWorkspace(workspace, { slug: selectedSlug, brandValues = "required" } = {}) {
  if (!workspace.manifest.video) throw new Error("timds.json does not enable the video contract; run timds video init");
  const video = workspace.manifest.video;
  const contractPath = path.join(workspace.designSystemRoot, video.contract);
  const assetsPath = path.join(workspace.designSystemRoot, video.assets);
  const productionsRoot = path.join(workspace.designSystemRoot, video.productions);
  const localRoot = path.join(workspace.designSystemRoot, video.local);
  const labRoot = path.join(workspace.designSystemRoot, video.lab || "video/lab");
  const componentsPath = video.components
    ? path.join(workspace.designSystemRoot, video.components)
    : null;
  if (componentsPath && !existsSync(componentsPath)) {
    throw new Error(`video component override is required at ${componentsPath}`);
  }
  const tokens = await loadWorkspaceTokens(workspace);
  const { contract, references: brandReferences, unresolved: brandUnresolved } = resolveVideoBrand(
    validateVideoContract(await readJson(contractPath, "video contract")),
    tokens,
    { optional: brandValues === "optional" },
  );
  const assets = validateAssetCatalog(await readJson(assetsPath, "video assets"));
  const verticalMetadata = video.verticalMetadata ? validateVideoVerticalMetadata(
    await readJson(path.join(workspace.designSystemRoot, video.verticalMetadata), "video vertical metadata"),
    { assetCatalog: assets, mediaCatalog: (await readMediaCatalog(workspace.designSystemRoot)).catalog, footagePrefix: contract.producer?.footage.assetPrefix },
  ) : null;
  const entries = selectedSlug
    ? [slug(selectedSlug)]
    : (await fs.readdir(productionsRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const productions = [];
  for (const productionSlug of entries) {
    const root = path.join(productionsRoot, productionSlug);
    const values = Object.fromEntries(await Promise.all(productionFiles.map(async (name) => [name.replace(".json", ""), await readJson(path.join(root, name), `${productionSlug}/${name}`)])));
    productions.push(validateProduction(values, contract, assets, productionSlug));
  }
  if (selectedSlug && !productions.length) throw new Error(`video production ${selectedSlug} was not found`);
  return { ...workspace, video: { ...video, assets, assetsPath, brandReferences, brandUnresolved, verticalMetadata, componentsPath, contract, contractPath, labRoot, localRoot, productions, productionsRoot, tokens } };
}

export async function checkVideoWorkspace(workspace, options = {}) {
  // A check may run before the artifact is built (CI often runs it first), so
  // brand references are verified when tokens exist and reported otherwise.
  const loaded = await loadVideoWorkspace(workspace, { ...options, brandValues: "optional" });
  const { catalog } = await readMediaCatalog(workspace.designSystemRoot);
  const registered = new Set(catalog.assets.map((asset) => asset.key));
  const brandProblems = await checkVideoBrandSources({ designSystemRoot: workspace.designSystemRoot, contract: loaded.video.contract, mediaCatalog: catalog, localDir: loaded.video.local });
  if (brandProblems.length) throw brandSourceError(brandProblems);
  const warnings = brandDriftWarnings(validateVideoContract(await readJson(loaded.video.contractPath, "video contract")), loaded.video.tokens);
  if (loaded.video.brandUnresolved.length) {
    warnings.push(`brand references ${loaded.video.brandUnresolved.map((entry) => entry.reference).join(", ")} are not verified: the artifact is not built, so no design tokens are derived; timds check resolves them`);
  }
  // A production is only as portable as its media. A scene or cover that
  // names a mediaKey media.json has not published renders on the machine that
  // staged the clip and fails on every other host, so it is refused here, the
  // same way an unpublished brand file is. A catalog entry nothing references
  // yet only warns: a designer may register footage before a production uses it.
  const published = new Set(catalog.assets.filter((asset) => asset.publicUrl).map((asset) => asset.key));
  const referenced = new Set(loaded.video.productions.flatMap((production) => production.usedAssets));
  const unpublished = [];
  for (const [key, asset] of Object.entries(loaded.video.assets.assets)) {
    if (!asset.mediaKey || registered.has(asset.mediaKey)) continue;
    if (referenced.has(key)) unpublished.push(`${key}: mediaKey ${asset.mediaKey} is not published in media.json`);
    else warnings.push(`${key}: mediaKey ${asset.mediaKey} is not registered in media.json`);
  }
  for (const key of referenced) {
    const mediaKey = loaded.video.assets.assets[key]?.mediaKey;
    if (mediaKey && registered.has(mediaKey) && !published.has(mediaKey)) unpublished.push(`${key}: mediaKey ${mediaKey} has no public URL in media.json`);
  }
  if (unpublished.length) {
    throw new Error(`video productions reference media that no render host can fetch; publish it with timds assets publish (timds submit publishes staged media) before submitting:\n${unpublished.map((problem) => `- ${problem}`).join("\n")}`);
  }
  // Every lab input must compile: it is the request an automated Video Lab
  // hands the producer, so a broken one is a broken preview. Finalizing needs
  // registered footage and a cover library, which a new system may not have
  // yet, so that stage only warns here; `timds video lab` fails on it.
  const labInputs = [];
  for (const name of await listVideoLabInputs(loaded.video.labRoot)) {
    const { compiled, producer } = await compileVideoLabInput(loaded, catalog, name);
    try {
      producer.finalizeProduction({ schemaVersion: VIDEO_SCHEMA_VERSION, compiled, timings: silentSceneTimings(compiled.scenes), audioSrc: null });
      labInputs.push({ name, finalized: true });
    } catch (caught) {
      warnings.push(`lab input ${name} compiles but cannot finalize yet: ${caught instanceof Error ? caught.message : String(caught)}`);
      labInputs.push({ name, finalized: false });
    }
  }
  return { ...loaded, productionCount: loaded.video.productions.length, labInputs, warnings };
}

// --- video lab -----------------------------------------------------------------
//
// A lab input is the compile request an automated Video Lab hands the producer:
// the exact question, a topic label, and ordered answer beats. The lab takes it
// the rest of the way exactly as an automated render host does — compile
// through the client's producer block, time the narration, finalize footage
// and cover deterministically, stage brand files and published media, mount
// the single-format root with the client's components — and then opens
// Remotion Studio instead of rendering, so the Design System editor sees the
// frames the lab will ship.

export async function listVideoLabInputs(labRoot) {
  try {
    return (await fs.readdir(labRoot)).filter((entry) => entry.endsWith(".json")).map((entry) => entry.slice(0, -".json".length)).sort();
  } catch (caught) {
    if (caught?.code === "ENOENT") return [];
    throw caught;
  }
}

/**
 * Silent narration timing, the way an automated lab times a render without
 * audio: the total runtime follows the narration length, each scene takes its
 * share by word count, and the words spread evenly inside the scene so
 * captions still page. A voiced production replaces this with measured words.
 */
export function silentSceneTimings(scenes, { wordsPerMinute = 150, minimumSceneSeconds = 2 } = {}) {
  const counts = scenes.map((scene) => words(scene.narration).length);
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (!total) throw new Error("video lab: every scene needs narration");
  const totalMs = (total / wordsPerMinute) * 60 * 1000;
  return scenes.map((scene, index) => {
    const durationMs = Math.max(minimumSceneSeconds * 1000, Math.round((totalMs * counts[index]) / total));
    const tokens = words(scene.narration);
    const slice = durationMs / Math.max(1, tokens.length);
    return {
      id: scene.id,
      durationMs,
      words: tokens.map((token, position) => ({ text: token, startMs: Math.round(position * slice), endMs: Math.max(1, Math.round((position + 1) * slice)) })),
    };
  });
}

async function compileVideoLabInput(loaded, mediaCatalog, name) {
  if (!loaded.video.contract.producer) throw new Error(`video lab input ${name} needs a producer block in ${loaded.video.contract.name}'s video contract`);
  const input = await readJson(path.join(loaded.video.labRoot, `${name}.json`), `video lab input ${name}`);
  const producer = createVideoProducer({ contract: loaded.video.contract, assetCatalog: loaded.video.assets, mediaCatalog, verticalMetadata: loaded.video.verticalMetadata });
  const compiled = producer.compileProduction(input);
  for (const scene of compiled.scenes) {
    if (truncatedHeadline(scene.headline)) throw new Error(`video lab input ${name}: scene ${scene.id} headline appears truncated: ${JSON.stringify(scene.headline)}`);
  }
  return { input, producer, compiled };
}

export async function planVideoLab(workspace, requestedName) {
  const loaded = await loadVideoWorkspace(workspace);
  const names = await listVideoLabInputs(loaded.video.labRoot);
  const name = requestedName ? (names.includes(requestedName) ? requestedName : null) : (names[0] ?? null);
  if (!name) {
    throw new Error(requestedName
      ? `video lab input ${requestedName} was not found under ${loaded.video.lab} (available: ${names.join(", ") || "none"})`
      : `no video lab input under ${loaded.video.lab}; add a compile request there (see its README.md)`);
  }
  const { catalog: mediaCatalog } = await readMediaCatalog(workspace.designSystemRoot);
  const { input, producer, compiled } = await compileVideoLabInput(loaded, mediaCatalog, name);
  const timings = silentSceneTimings(compiled.scenes);
  const finalized = producer.finalizeProduction({ schemaVersion: VIDEO_SCHEMA_VERSION, compiled, timings, audioSrc: null });
  return { ...loaded, lab: { name, names, input, compiled, timings, finalized } };
}

/**
 * The one-line footage summary a plan scene shows, shared by the CLI printout
 * and the lab UI: the question card, the board, and the clips it plays over.
 */
export function describeSceneFootage(scene, keys = scene.assets || [scene.asset]) {
  if (scene.intro || scene.outro) return "card";
  const clips = (keys || []).filter(Boolean).join(" → ");
  const board = scene.visual ? `board ${scene.visual.kind}` : "";
  return [board, board && clips ? "over" : "", clips].filter(Boolean).join(" ");
}

export function describeVideoLabPlan({ compiled, timings, finalized }) {
  const byId = new Map(timings.map((line) => [line.id, line]));
  const lines = [`${compiled.slug} · ${compiled.outputFormat} · ${compiled.exactQuestion}`];
  for (const scene of finalized.plan.scenes) {
    const seconds = (byId.get(scene.id).durationMs / 1000).toFixed(1);
    lines.push(`  ${scene.id.padEnd(14)} ${seconds.padStart(5)}s  ${(scene.eyebrow || "").padEnd(22)} ${scene.headline || ""}`);
    lines.push(`  ${"".padEnd(14)}        ${describeSceneFootage(scene)}`);
  }
  lines.push(`  cover          ${finalized.coverSubject.key} · ${finalized.plan.cover.eyebrow} · ${finalized.plan.cover.headline}`);
  return lines.join("\n");
}

/** The scene list a single-format root plays, using the producer's chosen keys for that format. */
export const singleFormatScenes = (finalized) => finalized.plan.scenes.map((scene) => {
  const { asset, assets, verticalAsset, verticalAssets, ...copy } = scene;
  if (scene.intro || scene.outro) return copy;
  if (finalized.plan.outputFormat === "short") {
    if (!verticalAsset && !verticalAssets?.length) throw new Error(`video lab: short scene ${scene.id} has no vertical footage; register each clip's vertical derivative`);
    return { ...copy, ...(verticalAssets?.length ? { assets: verticalAssets } : { asset: verticalAsset }) };
  }
  return { ...copy, ...(assets?.length ? { assets } : { asset }) };
});

async function prepareLabNarration(workspace, planned, labLocal, publicRoot, options) {
  const config = object(planned.video.contract.voiceover || {}, "video contract voiceover");
  const script = {
    slug: planned.lab.compiled.slug,
    voice: text(options.voice || config.voice || "en-US-AriaNeural", "video lab voice"),
    rate: text(config.rate || "+0%", "video lab voice rate"),
    pitch: text(config.pitch || "+0Hz", "video lab voice pitch"),
    lines: planned.lab.compiled.scenes.map(({ id, narration }) => ({ id, tts: narration })),
  };
  const generator = path.join(packageRoot, "video", "generate_voiceover.py");
  // A lab take belongs to its exact script and voice. Never reuse timings from
  // an edited script or replace a production's authored/locked voice take.
  const key = createHash("sha256").update(JSON.stringify(script)).update(await fs.readFile(generator)).digest("hex");
  const cacheRoot = path.join(labLocal, "voiceover", key);
  const captionsPath = path.join(cacheRoot, "captions.json");
  const readTake = async () => {
    const captions = await readJson(captionsPath, "video lab measured captions");
    if (!Array.isArray(captions.lines) || captions.lines.length !== script.lines.length) throw new Error("video lab narration must cover every scene");
    const lines = captions.lines.map((line, index) => validateCaptionLine(line, `video lab narration ${index}`));
    for (const [index, line] of lines.entries()) {
      if (line.id !== script.lines[index].id || !line.words.length) throw new Error("video lab narration does not match the compiled scenes");
      const audio = await fs.stat(path.join(cacheRoot, `${line.id}.mp3`));
      if (!audio.isFile() || !audio.size) throw new Error(`video lab narration is missing audio for ${line.id}`);
    }
    return lines;
  };
  let timings = await readTake().catch(() => null);
  if (!timings) {
    await fs.mkdir(cacheRoot, { recursive: true });
    const scriptPath = path.join(cacheRoot, "script.json");
    await fs.writeFile(scriptPath, `${JSON.stringify(script, null, 2)}\n`);
    // An incomplete generated lab cache is not a locked production take.
    await fs.rm(captionsPath, { force: true });
    const localPython = path.join(workspace.designSystemRoot, ".venv-tts", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    const python = options.python || process.env.TIMDS_PYTHON || (existsSync(localPython) ? localPython : "python3");
    options.log?.(`Generating spoken narration (${script.voice})…`);
    try {
      await run(python, [generator, "--script", scriptPath, "--captions", captionsPath, "--output", cacheRoot], {
        cwd: workspace.designSystemRoot, onLine: options.log || (() => {}),
      });
      timings = await readTake();
    } catch (cause) {
      throw new Error(`Video Lab narration failed. Use Python with edge-tts installed (--python or TIMDS_PYTHON), or choose an explicit silent preview. ${cause.message}`, { cause });
    }
  } else options.log?.("Using cached spoken narration.");
  const audioRoot = path.join(publicRoot, VIDEO_PUBLIC_ROOTS.audio, script.slug);
  await fs.mkdir(audioRoot, { recursive: true });
  for (const line of timings) await fs.copyFile(path.join(cacheRoot, `${line.id}.mp3`), path.join(audioRoot, `${line.id}.mp3`));
  return { timings, script };
}

export async function prepareVideoLab(workspace, requestedName, options = {}) {
  const planned = await planVideoLab(workspace, requestedName);
  const { name } = planned.lab;
  const labLocal = path.join(planned.video.localRoot, "lab", name);
  const publicRoot = path.join(labLocal, "public");
  const generatedRoot = path.join(labLocal, "generated");
  await fs.mkdir(publicRoot, { recursive: true });
  await fs.mkdir(generatedRoot, { recursive: true });
  const { manifest: localManifest } = await readLocalMediaManifest(workspace.designSystemRoot);
  const { catalog: mediaCatalog } = await readMediaCatalog(workspace.designSystemRoot);
  let script = {};
  if (!options.silent) {
    const narration = await prepareLabNarration(workspace, planned, labLocal, publicRoot, options);
    script = narration.script;
    planned.lab.timings = narration.timings;
    const producer = createVideoProducer({ contract: planned.video.contract, assetCatalog: planned.video.assets, mediaCatalog, verticalMetadata: planned.video.verticalMetadata });
    planned.lab.finalized = producer.finalizeProduction({ schemaVersion: VIDEO_SCHEMA_VERSION, compiled: planned.lab.compiled, timings: narration.timings });
  }
  const { finalized } = planned.lab;
  const stagedAssets = {};
  for (const media of [...finalized.footage, finalized.coverSubject]) {
    stagedAssets[media.key] = await stageAsset(workspace, media.key, media, publicRoot, localManifest, mediaCatalog);
  }
  stagedAssets[finalized.coverSubject.key] = { ...stagedAssets[finalized.coverSubject.key], kind: "image" };
  const brand = await stageVideoBrand({ designSystemRoot: workspace.designSystemRoot, contract: planned.video.contract, publicRoot, mediaCatalog, localManifest, localDir: planned.video.local, sound: !options.silent });
  const project = {
    schemaVersion: VIDEO_SCHEMA_VERSION,
    engine: { name: "@dtconcepts/timds", version: (await readJson(path.join(packageRoot, "package.json"), "TimDS package.json")).version },
    contract: { ...planned.video.contract, brand },
    assets: stagedAssets,
    records: {
      captions: { lines: finalized.plan.lines },
      production: {
        schemaVersion: VIDEO_SCHEMA_VERSION,
        slug: finalized.plan.slug,
        outputFormat: finalized.plan.outputFormat,
        scenes: singleFormatScenes(finalized),
        pads: finalized.plan.pads,
        audioSrc: finalized.plan.audioSrc,
        cover: { eyebrow: finalized.plan.cover.eyebrow, headline: finalized.plan.cover.headline, asset: finalized.coverSubject.key },
      },
      publishing: {},
      request: {},
      script,
    },
  };
  await assertVideoProjectStaged(project, publicRoot);
  const projectPath = path.join(generatedRoot, `${name}.json`);
  const entryPath = path.join(generatedRoot, `${name}.mjs`);
  const componentImport = planned.video.componentsPath
    ? `import videoProjectComponents from ${JSON.stringify(path.relative(generatedRoot, planned.video.componentsPath).replaceAll(path.sep, "/").replace(/^(?!\.)/u, "./"))};\n`
    : "const videoProjectComponents = {};\n";
  await fs.writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
  await fs.writeFile(entryPath, `import project from ${JSON.stringify(`./${path.basename(projectPath)}`)};\n${componentImport}import { registerRoot } from "remotion";\nimport { createSingleVideoProjectRoot, loadVideoProjectFonts } from "@dtconcepts/timds/video/remotion";\nloadVideoProjectFonts(project);\nregisterRoot(createSingleVideoProjectRoot(project, videoProjectComponents));\n`, "utf8");
  return { ...planned, entryPath, project, projectPath, publicRoot, outputRoot: path.join(labLocal, "out") };
}

export async function runVideoLab(workspace, requestedName, options = {}) {
  const log = options.log || (() => {});
  if (options.list) {
    const loaded = await loadVideoWorkspace(workspace);
    const names = await listVideoLabInputs(loaded.video.labRoot);
    const lines = [
      `Lab inputs (${loaded.video.lab}/): ${names.join(", ") || "none"}`,
      `Ready productions (${workspace.manifest.video.productions}/): ${loaded.video.productions.map((production) => production.production.slug).join(", ") || "none"}`,
    ];
    for (const line of lines) log(line);
    return { ...loaded, lines };
  }
  if (options.plan) {
    const planned = await planVideoLab(workspace, requestedName);
    const lines = [describeVideoLabPlan(planned.lab)];
    for (const line of lines) log(line);
    return { ...planned, lines };
  }
  const prepared = await prepareVideoLab(workspace, requestedName, options);
  const lines = [describeVideoLabPlan(prepared.lab), `Entry ${path.relative(workspace.designSystemRoot, prepared.entryPath)} (${prepared.video.componentsPath ? path.relative(workspace.designSystemRoot, prepared.video.componentsPath) : "TimDS default components"})`];
  for (const line of lines) log(line);
  if (options.prepare) return { ...prepared, lines };
  const remotion = path.join(path.dirname(require.resolve("@remotion/cli/package.json")), "remotion-cli.js");
  const common = ["--public-dir", prepared.publicRoot];
  if (options.render) {
    const onLine = options.captureOutput ? log : undefined;
    await fs.mkdir(prepared.outputRoot, { recursive: true });
    await run(process.execPath, [remotion, "render", prepared.entryPath, "TimDSVideo", path.join(prepared.outputRoot, `${prepared.lab.name}.mp4`), "--codec=h264", ...common, "--log=error"], { cwd: workspace.designSystemRoot, onLine });
    await run(process.execPath, [remotion, "still", prepared.entryPath, "TimDSCover", path.join(prepared.outputRoot, "thumbnail.jpg"), "--image-format=jpeg", "--jpeg-quality=90", ...common, "--log=error"], { cwd: workspace.designSystemRoot, onLine });
    log(`Rendered ${path.relative(workspace.designSystemRoot, prepared.outputRoot)}`);
    return { ...prepared, lines };
  }
  await run(process.execPath, [remotion, "studio", prepared.entryPath, ...common], { cwd: workspace.designSystemRoot });
  return { ...prepared, lines };
}

async function copyTemplate(source, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

async function defaultVideoComponentsTemplate() {
  const remotionSource = await fs.readFile(path.join(packageRoot, "video", "remotion.tsx"), "utf8");
  const start = remotionSource.indexOf(DEFAULT_COMPONENTS_START);
  const end = remotionSource.indexOf(DEFAULT_COMPONENTS_END);
  if (start < 0 || end < start) throw new Error("TimDS default video component snapshot markers are missing");
  // The toolkit's own default object is Required<> so every slot has a
  // fallback. A client copy is not: a slot the client leaves out resolves to
  // the TimDS default at runtime, so a new slot in a later release must not
  // break the client's typecheck.
  const componentSource = remotionSource.slice(start, end + DEFAULT_COMPONENTS_END.length).replace("} satisfies Required<VideoProjectComponentOverrides>;", "} satisfies VideoProjectComponentOverrides;");
  return `// Generated once from the installed TimDS defaults. This file is now owned by this Design System.\n// TimDS upgrades do not overwrite it; use \`timds video components init --force\` only to reset it.\n// Footage-chain rules are imported from the toolkit on purpose: they are production rules, not styling,\n// and \`timds video check\` enforces the same module, so a toolkit fix reaches these frames without a reset.\nimport React, {useMemo} from "react";\nimport {Audio} from "@remotion/media";\nimport {AbsoluteFill, Img, OffthreadVideo, Sequence, interpolate, staticFile, useCurrentFrame, useVideoConfig} from "remotion";\nimport {MINIMUM_CHAIN_CLIP_SECONDS, adjacentFootageRepeats, chainClipFrames, sceneAssetKeys, verticalTextZone} from "@dtconcepts/timds/video/footage";\nimport type {\n  VideoProject,\n  VideoProjectAsset,\n  VideoProjectCaptionLine,\n  VideoProjectComponentOverrides,\n  VideoProjectCover,\n  VideoProjectCoverProps,\n  VideoProjectGraphicProps,\n  VideoProjectIntroProps,\n  VideoProjectOutroProps,\n  VideoProjectScene,\n  VideoProjectSceneProps,\n  VideoProjectVideoProps,\n} from "@dtconcepts/timds/video/remotion";\n\n${DEFAULT_VIDEO_TEXT_SOURCE}\n\n${componentSource}\n\nexport {BrandWatermark, CaptionPages, Cover, CoverVisual, GoldHeadline, HorizontalCover, Intro, Media, Outro, SceneView, VerticalCover, Video};\nexport default defaultVideoProjectComponents;\n`;
}

export async function initializeVideoComponents(workspace, { force = false } = {}) {
  if (!workspace.manifest.video) throw new Error("timds.json does not enable the video contract; run timds video init");
  const rawManifest = await readJson(workspace.manifestPath, "timds.json");
  const rawVideo = rawManifest.video === true ? {} : object(rawManifest.video, "timds.json video");
  const relativePath = safeRelativePath(rawVideo.components || "video/remotion.tsx", "timds.json video.components");
  const destination = path.join(workspace.designSystemRoot, relativePath);
  if (existsSync(destination) && !force) {
    throw new Error(`Design System video components already exist at ${destination}; rerun with --force only to reset them to the installed TimDS defaults`);
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, await defaultVideoComponentsTemplate(), "utf8");
  rawVideo.components = relativePath;
  rawManifest.video = rawVideo;
  await fs.writeFile(workspace.manifestPath, `${JSON.stringify(rawManifest, null, 2)}\n`, "utf8");
  return { components: destination, relativePath };
}

export async function initializeVideoWorkspace(workspace, { force = false } = {}) {
  const manifestPath = workspace.manifestPath;
  const rawManifest = await readJson(manifestPath, "timds.json");
  if (rawManifest.video && !force) throw new Error("timds.json already declares a video contract");
  const destination = path.join(workspace.designSystemRoot, "video");
  const scaffold = force || !existsSync(path.join(destination, "contract.json"));
  rawManifest.video = {
    contract: "video/contract.json",
    assets: "video/assets.json",
    ...(scaffold ? { verticalMetadata: "video/vertical-meta.json" } : {}),
    productions: "video/productions",
    local: "video-local",
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(rawManifest, null, 2)}\n`, "utf8");
  await fs.mkdir(path.join(destination, "productions"), { recursive: true });
  for (const name of ["contract.json", "assets.json", ...(scaffold ? ["vertical-meta.json"] : []), "lab/README.md", "lab/sample-answer.json", "publishing.md"]) {
    const target = path.join(destination, name);
    if (!existsSync(target) || force) await copyTemplate(path.join(packageRoot, "templates", "video", name), target);
  }
  if (force) await fs.rm(path.join(workspace.designSystemRoot, ".timds", "defaults.json"), { force: true });
  await syncDefaults({ ...workspace, manifest: { ...workspace.manifest, video: rawManifest.video } }, { apply: true, scaffold });
  const skillDestination = path.join(workspace.repoRoot, ".agents", "skills", "timds-create-video");
  if (force) await fs.rm(skillDestination, { recursive: true, force: true });
  await fs.cp(path.join(packageRoot, "skills", "timds-create-video"), skillDestination, { recursive: true, force });
  const ignorePath = path.join(workspace.designSystemRoot, ".gitignore");
  const currentIgnore = await fs.readFile(ignorePath, "utf8").catch(() => "");
  if (!currentIgnore.split(/\r?\n/).includes("video-local/")) await fs.appendFile(ignorePath, `${currentIgnore.endsWith("\n") || !currentIgnore ? "" : "\n"}video-local/\n`);
  return { contract: path.join(destination, "contract.json"), assets: path.join(destination, "assets.json"), lab: path.join(destination, "lab"), skillDestination };
}

function referencedAssetKeys(production) {
  return production.usedAssets;
}

async function sourceForAsset(workspace, asset, localManifest, mediaCatalog) {
  if (asset.publicPath) return path.join(workspace.designSystemRoot, safeRelativePath(asset.publicPath, "video asset publicPath"));
  if (asset.localPath) return path.join(workspace.designSystemRoot, safeRelativePath(asset.localPath, "video asset localPath"));
  const published = mediaCatalog.assets.find((entry) => entry.key === asset.mediaKey);
  const local = localManifest.assets.find((entry) => entry.key === asset.mediaKey);
  if (local) {
    const localPath = path.join(workspace.designSystemRoot, safeRelativePath(local.path, "video local media path"));
    const stat = await fs.stat(localPath).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    // Crop approval is tied to the published bytes, not just the media key.
    // A stale manifest or a file changed after registration is not a cache hit.
    if (stat?.isFile() && stat.size > 0 && (!published || (stat.size === published.bytes && await fileSha256(localPath) === published.sha256))) return localPath;
  }
  if (!published?.publicUrl) throw new Error(`video asset ${asset.mediaKey} is not available locally or from media.json`);
  return { url: published.publicUrl, filename: published.filename, metadata: published };
}

async function stageAsset(workspace, key, asset, publicRoot, localManifest, mediaCatalog) {
  const source = await sourceForAsset(workspace, asset, localManifest, mediaCatalog);
  const sourceName = typeof source === "string" ? path.basename(source) : source.filename;
  const extension = path.extname(sourceName).toLowerCase() || ".bin";
  const relative = `${VIDEO_PUBLIC_ROOTS.media}/${key}${extension}`;
  const destination = path.join(publicRoot, relative);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  if (typeof source === "string") {
    const resolved = path.resolve(source);
    const designRoot = `${path.resolve(workspace.designSystemRoot)}${path.sep}`;
    if (!resolved.startsWith(designRoot) || !existsSync(resolved)) throw new Error(`video asset ${key} source is missing or outside the Design System: ${source}`);
    await fs.copyFile(resolved, destination);
    return { ...asset, key, src: relative };
  }
  const response = await fetch(source.url);
  if (!response.ok) throw new Error(`video asset ${key} download returned HTTP ${response.status}`);
  await fs.writeFile(destination, Buffer.from(await response.arrayBuffer()));
  return { ...source.metadata, ...asset, key, src: relative };
}

// --- brand files -------------------------------------------------------------------
//
// The contract names brand files (logo, fonts, sound design) that the
// components load with staticFile(). A render host has exactly two sources for
// them: the Design System checkout (committed files) and media.json (published
// TimDS media). Anything else, such as a file generated under ignored
// video-local/, exists only on the machine that generated it and 404s mid-render
// everywhere else, so `video check` refuses it and staging never skips it.

const execFileAsync = promisify(execFile);

export function videoBrandSources(contract) {
  const brand = contract?.brand || {};
  const audio = brand.audio || {};
  return [
    { field: "brand.logo", kind: "logo", source: brand.logo },
    ...(brand.fontFiles || []).map((font, index) => ({ field: `brand.fontFiles[${index}].path`, kind: "font", index, source: font.path })),
    ...["bed", "transition"].filter((key) => audio[key]).map((key) => ({ field: `brand.audio.${key}`, kind: "audio", key, source: audio[key] })),
    ...(brand.staticFiles || []).map((entry, index) => ({ field: `brand.staticFiles[${index}].path`, kind: "static", index, source: entry.path, mount: entry.mount })),
  ];
}

async function gitIgnored(designSystemRoot, relative) {
  try {
    await execFileAsync("git", ["-C", designSystemRoot, "check-ignore", "-q", "--", relative]);
    return true;
  } catch (caught) {
    // Exit 1 is "not ignored"; anything else (no git, not a repository) cannot
    // tell, and existence alone decides.
    return false;
  }
}

async function brandSourceProblem(designSystemRoot, entry, { mediaCatalog, localDir }) {
  const { field, source } = entry;
  if (source && typeof source === "object") {
    const published = mediaCatalog?.assets?.find((asset) => asset.key === source.mediaKey);
    if (!published) return `${field}: media key ${source.mediaKey} is not registered in media.json; publish it with timds assets first`;
    if (!published.publicUrl) return `${field}: media key ${source.mediaKey} has no publicUrl in media.json; publish it before referencing it`;
    return null;
  }
  const relative = safeRelativePath(source, `video contract ${field}`);
  const local = localDir ? safeRelativePath(localDir, "timds.json video.local") : null;
  if (entry.kind === "static") {
    const stat = await fs.stat(path.join(designSystemRoot, relative)).catch(() => null);
    if (!stat) return `${field}: ${relative} does not exist`;
    if (local && pathWithin(relative, local)) return `${field}: ${relative} is under ignored ${local}; commit static files as Design System source`;
    if (await gitIgnored(designSystemRoot, relative)) return `${field}: ${relative} is ignored by git, so a clean checkout cannot render it`;
    return null;
  }
  if (local && pathWithin(relative, local)) {
    return `${field}: ${relative} is generated under ignored ${local}/, which no render host has; commit the file or publish it with timds assets and reference { "mediaKey": "..." }`;
  }
  const absolute = path.join(designSystemRoot, relative);
  const stat = await fs.stat(absolute).catch((caught) => { if (caught.code === "ENOENT") return null; throw caught; });
  if (!stat?.isFile() || !stat.size) {
    return `${field}: ${relative} is not a committed file in the Design System; commit it, or publish it with timds assets and reference { "mediaKey": "..." }`;
  }
  if (await gitIgnored(designSystemRoot, relative)) {
    return `${field}: ${relative} is ignored by git, so render hosts never receive it; commit it or publish it with timds assets and reference { "mediaKey": "..." }`;
  }
  return null;
}

// Returns every contract brand file a render host could not obtain.
export async function checkVideoBrandSources({ designSystemRoot, contract, mediaCatalog, localDir = "video-local" }) {
  const problems = [];
  for (const entry of videoBrandSources(contract)) {
    const problem = await brandSourceProblem(designSystemRoot, entry, { mediaCatalog, localDir });
    if (problem) problems.push(problem);
  }
  return problems;
}

const brandSourceError = (problems) => new Error(`video contract names brand files no render host can obtain:\n  ${problems.join("\n  ")}`);

async function downloadBrandMedia(published, destination, cacheRoot) {
  const cached = cacheRoot && published.sha256 ? path.join(cacheRoot, `${published.sha256}${path.extname(published.filename || "")}`) : null;
  if (cached) {
    const stat = await fs.stat(cached).catch(() => null);
    if (stat?.isFile() && (!published.bytes || stat.size === published.bytes)) {
      await fs.copyFile(cached, destination);
      return;
    }
  }
  const response = await fetch(published.publicUrl);
  if (!response.ok) throw new Error(`video brand media ${published.key} download returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error(`video brand media ${published.key} downloaded empty`);
  await fs.writeFile(destination, bytes);
  if (cached) {
    await fs.mkdir(cacheRoot, { recursive: true });
    await fs.writeFile(cached, bytes);
  }
}

// Where a brand file lives under the render public root: a file already under
// public/ keeps its path, so the staticFile() names client components use
// still resolve; everything else is copied beneath brand/.
function brandRuntimePath(entry, extension = "") {
  const name = `${entry.kind}-${entry.key ?? entry.index ?? 0}`;
  if (typeof entry.source === "object") return `${VIDEO_PUBLIC_ROOTS.brand}/${name}-${entry.source.mediaKey}${extension}`;
  const safe = safeRelativePath(entry.source, `video contract ${entry.field}`);
  return safe.startsWith("public/") ? safe.slice("public/".length) : `${VIDEO_PUBLIC_ROOTS.brand}/${name}-${path.basename(safe)}`;
}

// Stages every brand file the contract names into a Remotion public directory
// and returns the brand with runtime paths. Render hosts call this instead of
// copying brand files themselves, so a new contract field is staged everywhere
// at once. `sound: false` leaves the bed and transition out (a silent preview).
export async function stageVideoBrand({ designSystemRoot, contract, publicRoot, mediaCatalog, localManifest = { assets: [] }, localDir = "video-local", cacheRoot = null, sound = true }) {
  const problems = await checkVideoBrandSources({ designSystemRoot, contract, mediaCatalog, localDir });
  if (problems.length) throw brandSourceError(problems);
  const brand = { ...contract.brand, logo: "", fontFiles: [] };
  const audio = contract.brand.audio ? { ...contract.brand.audio } : undefined;
  const staticMounts = [];
  const sources = videoBrandSources(contract);
  const staticEntries = sources.filter((entry) => entry.kind === "static");
  const fileEntries = sources.filter((entry) => entry.kind !== "static");
  // A mount may not land on any brand file's runtime path, whether or not this
  // staging copies that file: a silent preview leaves the audio bed out, and a
  // collision it let through would surface only at the real render. The check
  // runs before anything is written. (A media-key extension is unknown here,
  // but those files live under the reserved brand/ root anyway.)
  const runtimePaths = fileEntries.map((entry) => brandRuntimePath(entry));
  for (const entry of staticEntries) {
    const collision = runtimePaths.find((staged) => mountOverlaps(staged, entry.mount));
    if (collision) throw new Error(`video contract ${entry.field}: mount ${entry.mount} would overwrite the staged brand file ${collision}; mount it under another name`);
  }
  for (const entry of fileEntries) {
    if (entry.kind === "audio" && !sound) {
      delete audio[entry.key];
      continue;
    }
    let runtimePath;
    if (typeof entry.source === "object") {
      const source = await sourceForAsset({ designSystemRoot }, { mediaKey: entry.source.mediaKey }, localManifest, mediaCatalog);
      const extension = path.extname(typeof source === "string" ? source : source.filename || "").toLowerCase();
      runtimePath = brandRuntimePath(entry, extension);
      const destination = path.join(publicRoot, runtimePath);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      if (typeof source === "string") await fs.copyFile(source, destination);
      else await downloadBrandMedia(source.metadata, destination, cacheRoot);
    } else {
      runtimePath = brandRuntimePath(entry);
      await fs.mkdir(path.dirname(path.join(publicRoot, runtimePath)), { recursive: true });
      await fs.copyFile(path.join(designSystemRoot, safeRelativePath(entry.source, `video contract ${entry.field}`)), path.join(publicRoot, runtimePath));
    }
    if (entry.kind === "logo") brand.logo = runtimePath;
    else if (entry.kind === "audio") audio[entry.key] = runtimePath;
    else {
      const source = typeof entry.source === "string" ? path.join(designSystemRoot, entry.source) : path.join(publicRoot, runtimePath);
      brand.fontFiles.push({
        ...contract.brand.fontFiles[entry.index],
        path: runtimePath,
        format: fontFormatForPath(runtimePath),
        dataBase64: (await fs.readFile(source)).toString("base64"),
      });
    }
  }
  for (const entry of staticEntries) {
    const source = path.join(designSystemRoot, safeRelativePath(entry.source, `video contract ${entry.field}`));
    const destination = path.join(publicRoot, entry.mount);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.cp(source, destination, { recursive: true, force: true });
    staticMounts.push({ path: entry.source, mount: entry.mount });
  }
  if (audio) brand.audio = audio;
  brand.staticFiles = staticMounts;
  return brand;
}

// Every file the components will request through staticFile(), with the
// project field that names it. Keep in step with video/remotion.tsx.
export function videoProjectStaticFiles(project) {
  const files = [];
  const add = (field, value) => { if (typeof value === "string" && value) files.push({ field, path: value }); };
  const brand = project.contract?.brand || {};
  add("contract.brand.logo", brand.logo);
  (brand.fontFiles || []).forEach((font, index) => { if (!font.dataBase64) add(`contract.brand.fontFiles[${index}].path`, font.path); });
  add("contract.brand.audio.bed", brand.audio?.bed);
  add("contract.brand.audio.transition", brand.audio?.transition);
  for (const [key, asset] of Object.entries(project.assets || {})) add(`assets.${key}.src`, asset?.src);
  const production = project.records?.production || {};
  if (typeof production.audioSrc === "string") add("records.production.audioSrc", production.audioSrc);
  else if (production.audioSrc === undefined) {
    for (const line of project.records?.captions?.lines || []) add(`narration for line ${line.id}`, `${VIDEO_PUBLIC_ROOTS.audio}/${production.slug}/${line.id}.mp3`);
  }
  return files;
}

// Fails before Remotion starts when any requested file is not in the public
// directory, naming the project field instead of a 404 halfway through a render.
export async function assertVideoProjectStaged(project, publicRoot) {
  const missing = [];
  for (const file of videoProjectStaticFiles(project)) {
    const relative = safeRelativePath(file.path, file.field);
    const stat = await fs.stat(path.join(publicRoot, relative)).catch(() => null);
    if (!stat?.isFile() || !stat.size) missing.push(`${file.field} -> ${relative}`);
  }
  if (missing.length) throw new Error(`video project requests files that are not staged in ${publicRoot}:\n  ${missing.join("\n  ")}`);
}

export async function prepareVideoWorkspace(workspace, selectedSlug) {
  const loaded = await loadVideoWorkspace(workspace, { slug: selectedSlug });
  const production = loaded.video.productions[0];
  const publicRoot = path.join(loaded.video.localRoot, "public");
  const generatedRoot = path.join(loaded.video.localRoot, "generated");
  await fs.mkdir(publicRoot, { recursive: true });
  await fs.mkdir(generatedRoot, { recursive: true });
  const { manifest: localManifest } = await readLocalMediaManifest(workspace.designSystemRoot);
  const { catalog: mediaCatalog } = await readMediaCatalog(workspace.designSystemRoot);
  const stagedAssets = {};
  for (const key of referencedAssetKeys(production)) {
    stagedAssets[key] = await stageAsset(workspace, key, loaded.video.assets.assets[key], publicRoot, localManifest, mediaCatalog);
  }
  const brand = await stageVideoBrand({ designSystemRoot: workspace.designSystemRoot, contract: loaded.video.contract, publicRoot, mediaCatalog, localManifest, localDir: loaded.video.local });
  const project = {
    schemaVersion: VIDEO_SCHEMA_VERSION,
    engine: { name: "@dtconcepts/timds", version: (await readJson(path.join(packageRoot, "package.json"), "TimDS package.json")).version },
    contract: {
      ...loaded.video.contract,
      brand,
    },
    assets: stagedAssets,
    records: {
      captions: production.captions,
      production: production.production,
      publishing: production.publishing,
      request: production.request,
      script: production.script,
    },
  };
  const projectPath = path.join(generatedRoot, `${production.production.slug}.json`);
  const entryPath = path.join(generatedRoot, `${production.production.slug}.mjs`);
  const componentImport = loaded.video.componentsPath
    ? `import videoProjectComponents from ${JSON.stringify(path.relative(generatedRoot, loaded.video.componentsPath).replaceAll(path.sep, "/").replace(/^(?!\.)/u, "./"))};\n`
    : "const videoProjectComponents = {};\n";
  await fs.rm(path.join(generatedRoot, `${production.production.slug}.tsx`), { force: true });
  await fs.writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
  await fs.writeFile(entryPath, `import project from ${JSON.stringify(`./${path.basename(projectPath)}`)};\n${componentImport}import { registerRoot } from "remotion";\nimport { createVideoProjectRoot, loadVideoProjectFonts } from "@dtconcepts/timds/video/remotion";\nloadVideoProjectFonts(project);\nregisterRoot(createVideoProjectRoot(project, videoProjectComponents));\n`, "utf8");
  return { ...loaded, entryPath, project, projectPath, publicRoot, production };
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    // With an `onLine` sink (the video lab server) the child's output is captured
    // line by line so a render log can reach a browser; otherwise it inherits the
    // terminal as before.
    const capture = typeof options.onLine === "function";
    const child = spawn(command, args, { cwd: options.cwd, env: options.env || process.env, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    const tail = [];
    if (capture) {
      for (const stream of [child.stdout, child.stderr]) {
        let buffered = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => {
          buffered += chunk;
          const lines = buffered.split(/\r?\n/u);
          buffered = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            tail.push(line);
            if (tail.length > 40) tail.shift();
            options.onLine(line);
          }
        });
        stream.on("end", () => { if (buffered.trim()) { tail.push(buffered); options.onLine(buffered); } });
      }
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve();
      const detail = tail.length ? `\n${tail.slice(-12).join("\n")}` : "";
      reject(new Error(`${path.basename(command)} ${args[1] || args[0] || ""} failed with exit code ${code}${detail}`));
    });
  });
}

function localDate(timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function safeFolder(value, label) {
  const result = text(value, label);
  if (/[/\\]/.test(result) || result === "." || result === "..") throw new Error(`${label} is not folder-safe`);
  return result;
}

function renderPaths(prepared, date = localDate(prepared.video.contract.package.timeZone)) {
  const publishing = prepared.production.publishing;
  const root = path.join(prepared.video.localRoot, "out", `${safeFolder(publishing.topicName, "publishing topicName")} - ${date}`);
  return {
    root,
    longform: path.join(root, prepared.video.contract.package.longformDirectory),
    shorts: prepared.production.production.shorts.map((short) => path.join(root, `${prepared.video.contract.package.shortDirectoryPrefix}${safeFolder(short.subtopic, `short ${short.id} subtopic`)}`)),
  };
}

export async function runVideoStudio(workspace, selectedSlug) {
  const prepared = await prepareVideoWorkspace(workspace, selectedSlug);
  const remotion = path.join(path.dirname(require.resolve("@remotion/cli/package.json")), "remotion-cli.js");
  await run(process.execPath, [remotion, "studio", prepared.entryPath, "--public-dir", prepared.publicRoot], { cwd: workspace.designSystemRoot });
  return prepared;
}

export function descriptionFor(prepared, short, target) {
  const publishing = prepared.production.publishing;
  const basePolicy = prepared.video.contract.publishing || {};
  const targetPolicy = target ? basePolicy.targets?.[target] : undefined;
  if (target && (!short || !targetPolicy)) throw new Error(`No short publishing policy for ${target}`);
  const contractPublishing = { ...basePolicy, ...(target ? basePolicy.targetDefaults : {}), ...targetPolicy };
  const source = short || publishing;
  if (target && (typeof source.descriptions?.[target] !== "string" || !source.descriptions[target].trim())) {
    throw new Error(`Missing ${target} description for ${short.id}`);
  }
  if (targetPolicy && source.descriptions[target].trim().length > targetPolicy.maxCopyCharacters) throw new Error(`${target} copy exceeds ${targetPolicy.maxCopyCharacters} characters`);
  const articleLabel = contractPublishing.articleLabel || "Read the full article:";
  const lead = (target ? source.descriptions[target].trim() : source.description) || [
    source.descriptionHook || (source.question ? `Q: ${source.question}` : ""),
    source.answer ? `A: ${source.answer}` : "",
  ].filter(Boolean).join("\n\n");
  const parts = [lead, publishing.seriesLine || prepared.video.contract.brand.series];
  if (short && contractPublishing.shortBridge && !parts.includes(contractPublishing.shortBridge)) parts.push(contractPublishing.shortBridge);
  // A Short's description is rarely clickable and rarely expanded; the contract may drop
  // the article link and swap the full disclaimer for a one-liner there only.
  if (publishing.articleUrl && (!short || contractPublishing.shortArticleLink !== false)) parts.push(`${articleLabel} ${publishing.articleUrl}`);
  const disclaimer = short && contractPublishing.shortDisclaimer
    ? contractPublishing.shortDisclaimer
    : publishing.disclaimer || contractPublishing.disclaimer;
  if (disclaimer) parts.push(disclaimer);
  const result = `${parts.filter(Boolean).join("\n\n")}\n`;
  if (targetPolicy && result.trimEnd().length > targetPolicy.maxCharacters) {
    throw new Error(`${target} description exceeds ${targetPolicy.maxCharacters} characters; revise the copy without truncating it`);
  }
  return result;
}

/** Export copy independently of rendering; a publishing edit does not require a new MP4. */
export async function exportVideoPublishing(workspace, selectedSlug, options = {}) {
  const loaded = await loadVideoWorkspace(workspace, { slug: selectedSlug });
  const prepared = { ...loaded, production: loaded.video.productions[0] };
  const paths = renderPaths(prepared, options.date);
  await writeVideoPublishing(prepared, paths);
  return { outputRoot: paths.root };
}

async function writeVideoPublishing(prepared, paths) {
  await fs.mkdir(paths.longform, { recursive: true });
  await fs.writeFile(path.join(paths.longform, "description.md"), descriptionFor(prepared), "utf8");
  await fs.writeFile(path.join(paths.longform, "publishing.json"), `${JSON.stringify(prepared.production.publishing, null, 2)}\n`, "utf8");
  for (let index = 0; index < prepared.production.production.shorts.length; index += 1) {
    const short = prepared.production.production.shorts[index];
    const source = prepared.production.publishing.shorts?.find((entry) => entry.id === short.id) || short;
    const directory = paths.shorts[index];
    const descriptions = Object.fromEntries(Object.keys(source.descriptions ? prepared.video.contract.publishing.targets || {} : {}).map((target) => [target, descriptionFor(prepared, source, target)]));
    await fs.mkdir(directory, { recursive: true });
    for (const [target, description] of Object.entries(descriptions)) {
      await fs.writeFile(path.join(directory, `description.${target}.md`), description, "utf8");
    }
    for (const target of PUBLISHING_TARGETS) {
      if (!Object.hasOwn(descriptions, target)) await fs.rm(path.join(directory, `description.${target}.md`), { force: true });
    }
    await fs.writeFile(path.join(directory, "description.md"), descriptions.youtube_short || descriptionFor(prepared, source), "utf8");
    await fs.writeFile(path.join(directory, "publishing.json"), `${JSON.stringify({ ...source, compiledDescriptions: descriptions }, null, 2)}\n`, "utf8");
  }
}

export async function renderVideoWorkspace(workspace, selectedSlug, options = {}) {
  const prepared = await prepareVideoWorkspace(workspace, selectedSlug);
  await assertVideoProjectStaged(prepared.project, prepared.publicRoot);
  const remotion = path.join(path.dirname(require.resolve("@remotion/cli/package.json")), "remotion-cli.js");
  const prefix = pascal(prepared.production.production.slug);
  const paths = renderPaths(prepared, options.date);
  await fs.mkdir(paths.longform, { recursive: true });
  const common = ["--public-dir", prepared.publicRoot, "--log=error"];
  await run(process.execPath, [remotion, "still", prepared.entryPath, `${prefix}Cover`, path.join(paths.longform, "thumbnail.jpg"), "--image-format=jpeg", "--jpeg-quality=90", ...common], { cwd: workspace.designSystemRoot });
  await run(process.execPath, [remotion, "render", prepared.entryPath, `${prefix}Long`, path.join(paths.longform, `${prepared.production.production.slug}-longform.mp4`), "--codec=h264", ...common], { cwd: workspace.designSystemRoot });
  for (let index = 0; index < prepared.production.production.shorts.length; index += 1) {
    const short = prepared.production.production.shorts[index];
    const directory = paths.shorts[index];
    await fs.mkdir(directory, { recursive: true });
    await run(process.execPath, [remotion, "still", prepared.entryPath, `${prefix}Short${index + 1}Cover`, path.join(directory, "thumbnail.jpg"), "--image-format=jpeg", "--jpeg-quality=90", ...common], { cwd: workspace.designSystemRoot });
    await run(process.execPath, [remotion, "render", prepared.entryPath, `${prefix}Short${index + 1}`, path.join(directory, `${short.id}.mp4`), "--codec=h264", ...common], { cwd: workspace.designSystemRoot });
  }
  const lock = {
    schemaVersion: 1,
    engine: prepared.project.engine,
    designSystem: { id: prepared.video.contract.id, version: prepared.manifest.version },
    production: prepared.production.production.slug,
    assets: Object.fromEntries(Object.entries(prepared.project.assets).map(([key, asset]) => [key, { mediaKey: asset.mediaKey, sha256: asset.sha256, src: asset.src }])),
  };
  await fs.writeFile(path.join(paths.root, "production.lock.json"), `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  await writeVideoPublishing(prepared, paths);
  return { ...prepared, outputRoot: paths.root };
}

export async function voiceoverVideoWorkspace(workspace, selectedSlug, options = {}) {
  // The first take of a new production has no captions.json yet, so the full
  // workspace (which validates every scene against its caption line) cannot
  // load. Voiceover needs only the script; validation follows with `video check`.
  if (!workspace.manifest.video) throw new Error("timds.json does not enable the video contract; run timds video init");
  const productionSlug = slug(selectedSlug, "video production slug");
  const topicRoot = path.join(workspace.designSystemRoot, workspace.manifest.video.productions, productionSlug);
  const script = await readJson(path.join(topicRoot, "script.json"), `${productionSlug}/script.json`);
  if (script.slug && script.slug !== productionSlug) throw new Error(`${productionSlug}/script.json slug must match the production folder`);
  const outputRoot = path.join(workspace.designSystemRoot, workspace.manifest.video.local, "public", VIDEO_PUBLIC_ROOTS.audio, productionSlug);
  const production = { production: { slug: productionSlug } };
  const args = [path.join(packageRoot, "video", "generate_voiceover.py"), "--script", path.join(topicRoot, "script.json"), "--captions", path.join(topicRoot, "captions.json"), "--output", outputRoot];
  if (options.force) args.push("--force");
  const spawnRun = typeof options.run === "function" ? options.run : run;
  await spawnRun(options.python || "python3", args, { cwd: workspace.designSystemRoot });
  return { outputRoot, production: production.production.slug };
}

export const VIDEO_HELP = `TimDS video workflow\n\nUsage:\n  timds video init [--root PATH] [--force]\n  timds video components init [--root PATH] [--force]\n  timds video doctor [--root PATH]\n  timds video check [SLUG] [--root PATH]\n  timds video lab [NAME] [--root PATH] [--plan] [--prepare] [--render] [--silent] [--voice NAME] [--python PATH] [--list]\n  timds video lab --serve [--port 4410] [--root PATH]\n  timds video publishing SLUG [--root PATH] [--date YYYY-MM-DD]\n  timds video prepare SLUG [--root PATH]\n  timds video voiceover SLUG [--root PATH] [--force]\n  timds video studio SLUG [--root PATH]\n  timds video render SLUG [--root PATH] [--date YYYY-MM-DD]\n\nThe client Design System owns video/contract.json, video/assets.json, video/lab/ compile requests, brand files, production records, and any generated component snapshot. TimDS owns validation, the producer, media staging, voiceover orchestration, default components, the lab, rendering, and review packaging. Generating components copies the installed defaults once; upgrades never overwrite that client-owned file.\n\nThe lab runs a video/lab/NAME.json compile request the way an automated Video Lab does — producer compile, spoken narration with measured word timings, deterministic footage and cover, staged media — and opens Remotion Studio on the result with the client's components; --plan estimates timing without audio generation, --silent explicitly requests a silent preview, --prepare stages narration and media without launching, --render writes the video and cover under video-local/lab/NAME/out/. check compiles every lab input and warns when the catalog cannot finalize one yet.`;

export { VIDEO_SCHEMA_VERSION };

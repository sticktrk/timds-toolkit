import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLocalMediaManifest, readMediaCatalog } from "./media.mjs";
import { validateVideoProducerConfig } from "./video-producer.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const VIDEO_SCHEMA_VERSION = 1;
const productionFiles = ["request.json", "script.json", "publishing.json", "captions.json", "production.json"];

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
    productions: safeRelativePath(video.productions || "video/productions", "timds.json video.productions"),
    local: safeRelativePath(video.local || "video-local", "timds.json video.local"),
  };
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
  return {
    requireIntro: structure.requireIntro === true,
    requireOutro: structure.requireOutro === true,
  };
}

export function validateVideoContract(input) {
  const contract = object(input, "video contract");
  if (Number(contract.schemaVersion) !== VIDEO_SCHEMA_VERSION) {
    throw new Error(`video contract schemaVersion must be ${VIDEO_SCHEMA_VERSION}`);
  }
  const formats = object(contract.formats || {}, "video contract formats");
  const packagePolicy = object(contract.package || {}, "video contract package");
  const structure = object(contract.structure || {}, "video contract structure");
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
    },
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
    if (asset.text && !["left-center", "left-bottom", "right-center", "right-bottom", "bottom", "upper", "lower"].includes(asset.text)) {
      throw new Error(`video asset ${key}.text is unsupported`);
    }
  }
  return { ...catalog, schemaVersion: VIDEO_SCHEMA_VERSION, assets };
}

function validateNaturalSpeedFootage(scene, line, pads, contract, assetCatalog, label) {
  if (scene.intro || scene.outro) return;
  const keys = scene.assets ?? (scene.asset ? [scene.asset] : []);
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

function validateScene(scene, label, contract, format) {
  object(scene, label);
  const id = slug(scene.id, `${label}.id`);
  if (scene.intro && scene.outro) throw new Error(`${label} cannot be both intro and outro`);
  if (!scene.intro && !scene.outro) {
    const headline = text(scene.headline, `${label}.headline`);
    const headlineLimit = format === "short" ? contract.copy.shortHeadlineWords : contract.copy.horizontalHeadlineWords;
    if (words(headline).length > headlineLimit) throw new Error(`${label}.headline exceeds ${headlineLimit} words`);
    if (scene.eyebrow && words(scene.eyebrow).length > contract.copy.eyebrowWords) throw new Error(`${label}.eyebrow exceeds ${contract.copy.eyebrowWords} words`);
    if (format === "short" && scene.subline) throw new Error(`${label}.subline is not supported in shorts`);
    if (scene.subline && words(scene.subline).length > contract.copy.horizontalSublineWords) throw new Error(`${label}.subline exceeds ${contract.copy.horizontalSublineWords} words`);
    const assetKeys = scene.assets ?? (scene.asset ? [scene.asset] : []);
    if (!Array.isArray(assetKeys) || !assetKeys.length) throw new Error(`${label} needs asset or assets`);
    for (const asset of assetKeys) slug(asset, `${label} asset`);
  }
  return { ...scene, id };
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
  return { captions: { ...captions, lines }, production: { ...production, slug: productionSlug, longform: { ...longform, scenes: longScenes, cover }, shorts }, publishing, request, script, usedAssets };
}

export async function loadVideoWorkspace(workspace, { slug: selectedSlug } = {}) {
  if (!workspace.manifest.video) throw new Error("timds.json does not enable the video contract; run timds video init");
  const video = workspace.manifest.video;
  const contractPath = path.join(workspace.designSystemRoot, video.contract);
  const assetsPath = path.join(workspace.designSystemRoot, video.assets);
  const productionsRoot = path.join(workspace.designSystemRoot, video.productions);
  const localRoot = path.join(workspace.designSystemRoot, video.local);
  const contract = validateVideoContract(await readJson(contractPath, "video contract"));
  const assets = validateAssetCatalog(await readJson(assetsPath, "video assets"));
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
  return { ...workspace, video: { ...video, assets, assetsPath, contract, contractPath, localRoot, productions, productionsRoot } };
}

export async function checkVideoWorkspace(workspace, options = {}) {
  const loaded = await loadVideoWorkspace(workspace, options);
  const { catalog } = await readMediaCatalog(workspace.designSystemRoot);
  const registered = new Set(catalog.assets.map((asset) => asset.key));
  const warnings = [];
  for (const [key, asset] of Object.entries(loaded.video.assets.assets)) {
    if (asset.mediaKey && !registered.has(asset.mediaKey)) warnings.push(`${key}: mediaKey ${asset.mediaKey} is not registered in media.json`);
  }
  return { ...loaded, productionCount: loaded.video.productions.length, warnings };
}

async function copyTemplate(source, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

export async function initializeVideoWorkspace(workspace, { force = false } = {}) {
  const manifestPath = workspace.manifestPath;
  const rawManifest = await readJson(manifestPath, "timds.json");
  if (rawManifest.video && !force) throw new Error("timds.json already declares a video contract");
  rawManifest.video = {
    contract: "video/contract.json",
    assets: "video/assets.json",
    productions: "video/productions",
    local: "video-local",
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(rawManifest, null, 2)}\n`, "utf8");
  const destination = path.join(workspace.designSystemRoot, "video");
  await fs.mkdir(path.join(destination, "productions"), { recursive: true });
  for (const name of ["contract.json", "assets.json"]) {
    const target = path.join(destination, name);
    if (!existsSync(target) || force) await copyTemplate(path.join(packageRoot, "templates", "video", name), target);
  }
  const skillDestination = path.join(workspace.repoRoot, ".agents", "skills", "timds-create-video");
  if (force) await fs.rm(skillDestination, { recursive: true, force: true });
  await fs.cp(path.join(packageRoot, "skills", "timds-create-video"), skillDestination, { recursive: true, force });
  const ignorePath = path.join(workspace.designSystemRoot, ".gitignore");
  const currentIgnore = await fs.readFile(ignorePath, "utf8").catch(() => "");
  if (!currentIgnore.split(/\r?\n/).includes("video-local/")) await fs.appendFile(ignorePath, `${currentIgnore.endsWith("\n") || !currentIgnore ? "" : "\n"}video-local/\n`);
  return { contract: path.join(destination, "contract.json"), assets: path.join(destination, "assets.json"), skillDestination };
}

function referencedAssetKeys(production) {
  return production.usedAssets;
}

async function sourceForAsset(workspace, asset, localManifest, mediaCatalog) {
  if (asset.publicPath) return path.join(workspace.designSystemRoot, safeRelativePath(asset.publicPath, "video asset publicPath"));
  if (asset.localPath) return path.join(workspace.designSystemRoot, safeRelativePath(asset.localPath, "video asset localPath"));
  const local = localManifest.assets.find((entry) => entry.key === asset.mediaKey);
  if (local) return path.join(workspace.designSystemRoot, local.path);
  const published = mediaCatalog.assets.find((entry) => entry.key === asset.mediaKey);
  if (!published?.publicUrl) throw new Error(`video asset ${asset.mediaKey} is not available locally or from media.json`);
  return { url: published.publicUrl, filename: published.filename, metadata: published };
}

async function stageAsset(workspace, key, asset, publicRoot, localManifest, mediaCatalog) {
  const source = await sourceForAsset(workspace, asset, localManifest, mediaCatalog);
  const sourceName = typeof source === "string" ? path.basename(source) : source.filename;
  const extension = path.extname(sourceName).toLowerCase() || ".bin";
  const relative = `media/${key}${extension}`;
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

async function stageBrandFiles(workspace, contract, publicRoot) {
  const files = [
    { kind: "logo", path: contract.brand.logo },
    ...(contract.brand.fontFiles || []).map((font, index) => ({ kind: "font", index, path: font.path })),
  ];
  const staged = { fontFiles: [], logo: "" };
  for (const file of files) {
    const relative = file.path;
    const safe = safeRelativePath(relative, "video brand file");
    const source = path.join(workspace.designSystemRoot, safe);
    if (!existsSync(source)) throw new Error(`video brand file is missing: ${safe}`);
    const runtimePath = safe.startsWith("public/") ? safe.slice("public/".length) : `brand/${file.kind}-${file.index ?? 0}-${path.basename(safe)}`;
    await fs.mkdir(path.dirname(path.join(publicRoot, runtimePath)), { recursive: true });
    await fs.copyFile(source, path.join(publicRoot, runtimePath));
    if (file.kind === "logo") staged.logo = runtimePath;
    else staged.fontFiles.push({
      ...contract.brand.fontFiles[file.index],
      path: runtimePath,
      format: fontFormatForPath(safe),
      dataBase64: (await fs.readFile(source)).toString("base64"),
    });
  }
  return staged;
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
  const stagedBrand = await stageBrandFiles(workspace, loaded.video.contract, publicRoot);
  const project = {
    schemaVersion: VIDEO_SCHEMA_VERSION,
    engine: { name: "@dtconcepts/timds", version: (await readJson(path.join(packageRoot, "package.json"), "TimDS package.json")).version },
    contract: {
      ...loaded.video.contract,
      brand: { ...loaded.video.contract.brand, ...stagedBrand },
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
  await fs.rm(path.join(generatedRoot, `${production.production.slug}.tsx`), { force: true });
  await fs.writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
  await fs.writeFile(entryPath, `import project from ${JSON.stringify(`./${path.basename(projectPath)}`)};\nimport { registerRoot } from "remotion";\nimport { createVideoProjectRoot, loadVideoProjectFonts } from "@dtconcepts/timds/video/remotion";\nloadVideoProjectFonts(project);\nregisterRoot(createVideoProjectRoot(project));\n`, "utf8");
  return { ...loaded, entryPath, project, projectPath, publicRoot, production };
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env || process.env, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`)));
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

function descriptionFor(prepared, short) {
  const publishing = prepared.production.publishing;
  const source = short || publishing;
  const articleLabel = prepared.video.contract.publishing?.articleLabel || "Read the full article:";
  const lead = source.description || [
    source.descriptionHook || (source.question ? `Q: ${source.question}` : ""),
    source.answer ? `A: ${source.answer}` : "",
  ].filter(Boolean).join("\n\n");
  const parts = [lead, publishing.seriesLine || prepared.video.contract.brand.series];
  if (short && prepared.video.contract.publishing?.shortBridge) parts.push(prepared.video.contract.publishing.shortBridge);
  if (publishing.articleUrl) parts.push(`${articleLabel} ${publishing.articleUrl}`);
  const disclaimer = publishing.disclaimer || prepared.video.contract.publishing?.disclaimer;
  if (disclaimer) parts.push(disclaimer);
  return `${parts.filter(Boolean).join("\n\n")}\n`;
}

export async function renderVideoWorkspace(workspace, selectedSlug, options = {}) {
  const prepared = await prepareVideoWorkspace(workspace, selectedSlug);
  const remotion = path.join(path.dirname(require.resolve("@remotion/cli/package.json")), "remotion-cli.js");
  const prefix = pascal(prepared.production.production.slug);
  const paths = renderPaths(prepared, options.date);
  await fs.mkdir(paths.longform, { recursive: true });
  const common = ["--public-dir", prepared.publicRoot, "--log=error"];
  await run(process.execPath, [remotion, "still", prepared.entryPath, `${prefix}Cover`, path.join(paths.longform, "thumbnail.jpg"), "--image-format=jpeg", "--jpeg-quality=90", ...common], { cwd: workspace.designSystemRoot });
  await run(process.execPath, [remotion, "render", prepared.entryPath, `${prefix}Long`, path.join(paths.longform, `${prepared.production.production.slug}-longform.mp4`), "--codec=h264", ...common], { cwd: workspace.designSystemRoot });
  await fs.writeFile(path.join(paths.longform, "description.md"), descriptionFor(prepared), "utf8");
  await fs.writeFile(path.join(paths.longform, "publishing.json"), `${JSON.stringify(prepared.production.publishing, null, 2)}\n`, "utf8");
  for (let index = 0; index < prepared.production.production.shorts.length; index += 1) {
    const short = prepared.production.production.shorts[index];
    const directory = paths.shorts[index];
    await fs.mkdir(directory, { recursive: true });
    await run(process.execPath, [remotion, "still", prepared.entryPath, `${prefix}Short${index + 1}Cover`, path.join(directory, "thumbnail.jpg"), "--image-format=jpeg", "--jpeg-quality=90", ...common], { cwd: workspace.designSystemRoot });
    await run(process.execPath, [remotion, "render", prepared.entryPath, `${prefix}Short${index + 1}`, path.join(directory, `${short.id}.mp4`), "--codec=h264", ...common], { cwd: workspace.designSystemRoot });
    const publish = prepared.production.publishing.shorts?.find((candidate) => candidate.id === short.id) || short;
    await fs.writeFile(path.join(directory, "description.md"), descriptionFor(prepared, publish), "utf8");
    await fs.writeFile(path.join(directory, "publishing.json"), `${JSON.stringify(publish, null, 2)}\n`, "utf8");
  }
  const lock = {
    schemaVersion: 1,
    engine: prepared.project.engine,
    designSystem: { id: prepared.video.contract.id, version: prepared.manifest.version },
    production: prepared.production.production.slug,
    assets: Object.fromEntries(Object.entries(prepared.project.assets).map(([key, asset]) => [key, { mediaKey: asset.mediaKey, sha256: asset.sha256, src: asset.src }])),
  };
  await fs.writeFile(path.join(paths.root, "production.lock.json"), `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  return { ...prepared, outputRoot: paths.root };
}

export async function voiceoverVideoWorkspace(workspace, selectedSlug, options = {}) {
  const loaded = await loadVideoWorkspace(workspace, { slug: selectedSlug });
  const production = loaded.video.productions[0];
  const topicRoot = path.join(loaded.video.productionsRoot, production.production.slug);
  const outputRoot = path.join(loaded.video.localRoot, "public", "audio", production.production.slug);
  const args = [path.join(packageRoot, "video", "generate_voiceover.py"), "--script", path.join(topicRoot, "script.json"), "--captions", path.join(topicRoot, "captions.json"), "--output", outputRoot];
  if (options.force) args.push("--force");
  await run(options.python || "python3", args, { cwd: workspace.designSystemRoot });
  return { outputRoot, production: production.production.slug };
}

export const VIDEO_HELP = `TimDS video workflow\n\nUsage:\n  timds video init [--root PATH] [--force]\n  timds video doctor [--root PATH]\n  timds video check [SLUG] [--root PATH]\n  timds video prepare SLUG [--root PATH]\n  timds video voiceover SLUG [--root PATH] [--force]\n  timds video studio SLUG [--root PATH]\n  timds video render SLUG [--root PATH] [--date YYYY-MM-DD]\n\nThe client Design System owns video/contract.json, video/assets.json, brand files, and production records. TimDS owns validation, media staging, voiceover orchestration, Remotion compositions, rendering, and review packaging.`;

export { VIDEO_SCHEMA_VERSION };

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { brandKitFoundationTokens } from "./brand-kit.mjs";
import { checkConceptPath, readConceptAssets, readConceptFile } from "./concept-assets.mjs";
import { readManifestLike, toolkitPage } from "./designs.mjs";
import { normalizeMachineConfig } from "./extract.mjs";
import { escapeHtml } from "./html.mjs";
import { stylesheetReferences } from "./tokens.mjs";

export const CONCEPT_KINDS = Object.freeze(["website", "logo", "card", "social", "photo", "merch", "pattern", "other"]);
export const CONCEPT_STATUSES = Object.freeze(["proposed", "approved", "archived"]);
export { CONCEPT_USAGE } from "./concept-read-tools.mjs";
import { CONCEPT_USAGE } from "./concept-read-tools.mjs";
const kinds = { website: "Website", logo: "Logos", card: "Cards", social: "Social", photo: "Photography", merch: "Merchandise", pattern: "Patterns", other: "Other pieces" };
const image = /\.(svg|png|jpe?g|webp)$/i;
const hex = /^#[a-f\d]{6}$/i;
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const encoded = file => file.split("/").map(encodeURIComponent).join("/");
const own = (object, key) => Object.hasOwn(object, key);

function text(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be nonempty text`);
  return value.trim();
}

function shape(value, keys, label, warnings) {
  if (typeof value !== "object" || !value || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) warnings.push(`${label}: ignored unknown key ${key}`);
}

function swatch(value, label) {
  if (typeof value !== "string" || !hex.test(value)) throw new Error(`${label} must be #RRGGBB`);
  return value;
}

export function normalizeConcept(raw, { id, warnings = [] } = {}) {
  const label = `src/concepts/${id ?? "<id>"}/concept.json`;
  if (id !== undefined && !idPattern.test(id)) throw new Error(`${label}: expected a lowercase, hyphenated concept id`);
  shape(raw, ["schemaVersion", "title", "summary", "status", "decided", "colors", "fonts", "voice", "pieces"], label, warnings);
  if (raw.schemaVersion !== 1) throw new Error(`${label}.schemaVersion must be 1`);
  const status = own(raw, "status") ? raw.status : "proposed";
  if (!CONCEPT_STATUSES.includes(status)) throw new Error(`${label}.status must be one of ${CONCEPT_STATUSES.join(", ")}`);
  const concept = { schemaVersion: 1, ...(id === undefined ? {} : { id }), title: text(raw.title, `${label}.title`), summary: text(raw.summary, `${label}.summary`), status };
  if (own(raw, "decided")) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.decided) || !Number.isFinite(Date.parse(raw.decided)) || new Date(raw.decided).toISOString().slice(0, 10) !== raw.decided) throw new Error(`${label}.decided must be a date in YYYY-MM-DD form`);
    concept.decided = raw.decided;
  }
  if (own(raw, "colors")) {
    const colors = raw.colors;
    shape(colors, ["roles", "palette"], `${label}.colors`, warnings);
    concept.colors = {};
    if (own(colors, "roles")) {
      const roles = Object.keys(brandKitFoundationTokens.color);
      shape(colors.roles, roles, `${label}.colors.roles`, warnings);
      concept.colors.roles = Object.fromEntries(roles.filter(key => own(colors.roles, key)).map(key => [key, swatch(colors.roles[key], `${label}.colors.roles.${key}`)]));
    }
    if (own(colors, "palette")) {
      if (!Array.isArray(colors.palette)) throw new Error(`${label}.colors.palette must be a list`);
      concept.colors.palette = colors.palette.map((entry, i) => {
        const field = `${label}.colors.palette[${i}]`;
        shape(entry, ["name", "hex"], field, warnings);
        return { name: text(entry.name, field + ".name"), hex: swatch(entry.hex, field + ".hex") };
      });
    }
  }
  if (own(raw, "fonts")) {
    shape(raw.fonts, ["display", "body", "label"], label + ".fonts", warnings);
    concept.fonts = {};
    for (const role of ["display", "body", "label"]) {
      if (role === "label" && !own(raw.fonts, role)) continue;
      const field = `${label}.fonts.${role}`;
      const font = raw.fonts[role];
      shape(font, ["family", "weight"], field, warnings);
      if (!Number.isInteger(Number(font.weight)) || Number(font.weight) < 1 || Number(font.weight) > 1000 || !["string", "number"].includes(typeof font.weight)) throw new Error(`${field}.weight must be a font weight from 1 to 1000`);
      concept.fonts[role] = { family: text(font.family, field + ".family"), weight: Number(font.weight) };
    }
  }
  if (own(raw, "voice")) {
    if (!Array.isArray(raw.voice)) throw new Error(`${label}.voice must be a list of words`);
    concept.voice = raw.voice.map((item, i) => text(item, `${label}.voice[${i}]`));
  }
  if (!Array.isArray(raw.pieces) || !raw.pieces.length || raw.pieces.length > 60) throw new Error(`${label}.pieces must contain 1 to 60 pieces`);
  concept.pieces = raw.pieces.map((entry, i) => {
    const field = `${label}.pieces[${i}]`;
    const captions = ["alt", "ground", "side", "caption", "label"];
    shape(entry, ["kind", "file", "height", ...captions], field, warnings);
    if (!CONCEPT_KINDS.includes(entry.kind)) throw new Error(`${field}.kind must be one of ${CONCEPT_KINDS.join(", ")}`);
    try { checkConceptPath(entry.file); } catch (caught) { throw new Error(`${field}.file (${entry.file}): ${caught.message}`); }
    const piece = { kind: entry.kind, file: entry.file };
    for (const key of captions) if (own(entry, key)) piece[key] = text(entry[key], field + "." + key);
    if (own(entry, "height")) {
      if (!Number.isSafeInteger(entry.height) || entry.height < 1) throw new Error(`${field}.height must be a positive integer`);
      piece.height = entry.height;
    }
    if (image.test(piece.file) && !piece.alt) warnings.push(`${field}: ${piece.file} has no alt text`);
    return piece;
  });
  return concept;
}

export async function readConcept(directory, { id = path.basename(path.resolve(directory)) } = {}) {
  const label = `src/concepts/${id}`;
  let raw;
  try {
    if (!(await fs.lstat(directory)).isDirectory()) throw new Error("expected a directory, not a link");
    raw = JSON.parse(await readConceptFile(directory, "concept.json", 512 * 1024));
  } catch (caught) { throw new Error(`${label}/concept.json: ${caught.message}`); }
  const warnings = [];
  const concept = normalizeConcept(raw, { id, warnings });
  const files = await readConceptAssets(directory, concept.pieces, label);
  return { concept, warnings, files };
}

async function optionalStat(file) {
  return fs.lstat(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
}

export async function readConceptCatalog(designSystemRoot) {
  const source = path.join(designSystemRoot, "src", "concepts");
  const stat = await optionalStat(source);
  const result = { exists: Boolean(stat), concepts: [], warnings: [], files: new Map() };
  if (!stat) return result;
  if (!stat.isDirectory() || !(await fs.lstat(path.dirname(source))).isDirectory()) throw new Error("src/concepts must be a directory without symbolic links");
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    if (entry.isFile() && entry.name.startsWith(".")) continue;
    if (!entry.isDirectory()) throw new Error(`src/concepts/${entry.name}: expected a concept directory`);
    const { concept, warnings, files } = await readConcept(path.join(source, entry.name));
    result.concepts.push(concept);
    result.files.set(concept.id, files);
    result.warnings.push(...warnings);
  }
  const approved = result.concepts.filter(entry => entry.status === "approved");
  if (approved.length > 1) throw new Error(`src/concepts: multiple approved concepts: ${approved.map(entry => entry.id).join(", ")}`);
  result.concepts.sort((a, b) => Number(b.status === "approved") - Number(a.status === "approved"));
  return result;
}

// `root` is the entry directory as a link prefix: site-absolute ("" or
// "/guide") in concepts.json and the viewer's guidance cards, and
// document-relative (".." or "../..") in the section's own pages, which are
// published under a path-prefixed CDN and must not leave it.
function conceptUrl(concept, root) { return `${root}/concepts/${concept.id}/`; }
function pieceUrl(concept, piece, root) { return `${conceptUrl(concept, root)}pieces/${encoded(piece.file)}`; }

function piecePreview(concept, piece, root, lead = false) {
  const url = escapeHtml(pieceUrl(concept, piece, root));
  const label = escapeHtml(piece.alt || piece.label || piece.file);
  if (/\.html$/i.test(piece.file)) return `<iframe title="${label}" src="${url}" sandbox="" referrerpolicy="no-referrer" loading="lazy" height="${lead ? 220 : piece.height ?? 600}" style="width:100%;border:0"></iframe>`;
  if (image.test(piece.file)) return `<img src="${url}" alt="${label}" loading="lazy" style="max-width:100%;height:auto">`;
  return `<a href="${url}" download>${label}</a>`;
}

function swatches(concept) {
  const entries = (concept.colors?.palette?.length ? concept.colors.palette : Object.entries(concept.colors?.roles ?? {}).map(([name, hex]) => ({ name, hex })));
  return entries.map(({ name, hex }) => `<span><span aria-hidden="true" style="display:inline-block;width:1em;height:1em;background:${hex}"></span> ${escapeHtml(name)} ${hex}</span>`).join(" · ");
}

export function conceptCard(concept, root = "") {
  return `<article class="td-directory-section" data-concept-card><h3><a href="${conceptUrl(concept, root)}">${escapeHtml(concept.title)}</a></h3><p>${escapeHtml(concept.status)} · ${escapeHtml(concept.summary)}</p>${piecePreview(concept, concept.pieces[0], root, true)}<p>${swatches(concept)}</p></article>`;
}

function conceptDetail(concept, root) {
  const sections = [];
  for (const kind of CONCEPT_KINDS) {
    const pieces = concept.pieces.filter(piece => piece.kind === kind);
    if (!pieces.length) continue;
    const figures = pieces.map(piece => {
      const caption = [piece.label, piece.side, piece.ground, piece.caption].filter(Boolean).map(escapeHtml).join(" · ");
      return `<figure>${piecePreview(concept, piece, root)}${caption ? `<figcaption>${caption}</figcaption>` : ""}</figure>`;
    });
    sections.push(`<section id="${kind}" class="td-directory-section"><h2>${kinds[kind]}</h2>${figures.join("\n")}</section>`);
  }
  const palette = swatches(concept);
  if (palette) sections.push(`<section id="palette"><h2>Palette</h2><p>${palette}</p></section>`);
  if (concept.fonts) sections.push(`<section id="type"><h2>Type</h2><dl>${Object.entries(concept.fonts).map(([role, font]) => `<dt>${role}</dt><dd>${escapeHtml(font.family)} (${font.weight})</dd>`).join("")}</dl></section>`);
  if (concept.voice?.length) sections.push(`<section id="voice"><h2>Voice</h2><p>${concept.voice.map(escapeHtml).join(", ")}</p></section>`);
  return [`<p><a href="${root}/concepts/">All concepts</a></p><h1>${escapeHtml(concept.title)}</h1><p>${concept.status}${concept.decided ? " · " + concept.decided : ""}</p><p>${escapeHtml(concept.summary)}</p>`, ...sections].join("\n");
}

// Keep the reader pure with respect to dist. A generator (or extract with
// write disabled) can derive the document without invoking a workspace build.
async function prepareSection(root, suppliedManifest) {
  const manifest = await readManifestLike(root, suppliedManifest);
  const entry = manifest.artifact?.entry || "index.html";
  if (typeof entry !== "string" || entry.includes("\\") || entry.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("artifact.entry must be a relative artifact file");
  }
  const base = path.posix.dirname(entry);
  const basePrefix = base === "." ? "" : "/" + base;
  // Pages link llms.txt only when the build writes it.
  const machine = normalizeMachineConfig(manifest.machine ?? undefined).enabled;
  const catalog = await readConceptCatalog(root);
  if (!catalog.exists) {
    const record = path.join(root, ".timds/starter.json");
    const starter = await fs.readFile(record, "utf8").then(JSON.parse).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (starter?.starter !== "brand-kit") return { document: null, warnings: [], base, basePrefix, machine };
  }
  const concepts = catalog.concepts.map(concept => {
    const files = catalog.files.get(concept.id);
    const url = conceptUrl(concept, basePrefix);
    const pieces = concept.pieces.map(piece => {
      const bytes = files.get(piece.file);
      return {
        ...piece, url: pieceUrl(concept, piece, basePrefix), bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        ...(/\.html$/i.test(piece.file) ? { html: bytes.toString("utf8") } : {}),
      };
    });
    return { ...concept, url, markdownUrl: url + "index.md", pieces };
  });
  const approved = concepts.find(concept => concept.status === "approved")?.id ?? null;
  if (concepts.length && !approved && manifest.version) catalog.warnings.push("src/concepts: this version has concepts but no approved direction");
  const document = {
    schemaVersion: 1, system: { id: manifest.systemId, name: manifest.name, version: manifest.version },
    url: basePrefix + "/concepts.json", base: null, usage: CONCEPT_USAGE, count: concepts.length, approved, concepts,
  };
  return { document, warnings: catalog.warnings, base, basePrefix, entry, machine, files: catalog.files };
}

function markdownMirror(concept) {
  const palette = [
    ...Object.entries(concept.colors?.roles ?? {}).map(([name, hex]) => ({ name, hex })),
    ...(concept.colors?.palette ?? []),
  ];
  return [
    `# ${concept.title}`, "", concept.summary, "",
    `Status: ${concept.status}${concept.decided ? " · " + concept.decided : ""}`, "", CONCEPT_USAGE, "",
    // Relative to the mirror at concepts/<id>/index.md, so the links hold under any published prefix.
    ...concept.pieces.map(piece => `- ${kinds[piece.kind]}: [${piece.alt ?? piece.label ?? piece.file}](pieces/${encoded(piece.file)})`),
    "", ...palette.map(({name, hex}) => `- ${name}: ${hex}`),
    ...Object.entries(concept.fonts ?? {}).map(([role, font]) => `- ${role}: ${font.family} (${font.weight})`),
    ...(concept.voice?.length ? [`Voice: ${concept.voice.join(", ")}`] : []),
  ].join("\n").trimEnd() + "\n";
}

const directoryMarker = "<!-- Generated by TimDS from src/concepts/ -->";

// `stylesheets` are artifact-relative paths; each page links them relative to itself.
async function writeSection(directory, section, stylesheets) {
  const { document, base, machine } = section;
  // A page in concepts/ (the directory) or concepts/<id>/ (a direction).
  const page = (title, id, body) => {
    const pageDirectory = path.posix.join(base, "concepts", ...(id ? [id] : []));
    const root = id ? "../.." : "..";
    // The configured entry is a file (guide/brand.html), not always its directory's index.
    const home = escapeHtml(`${root}/${encoded(path.posix.basename(section.entry))}`);
    return toolkitPage({
      title: escapeHtml(title + " · " + document.system.name), basePrefix: root, agentPointers: machine,
      stylesheets: stylesheets.map(({ file, suffix }) => path.posix.relative(pageDirectory, file) + suffix),
      directoryStylesheet: `${root}/concepts/_directory.css`, bodyClass: "timds-design-directory",
      body: [
        `<header class="td-directory-bar"><a class="td-directory-brand" href="${home}">${escapeHtml(document.system.name)}</a><a class="td-directory-back" href="${home}">Back to design system</a></header>`,
        `<main class="td-directory-main">${body}</main>`,
      ],
    });
  };
  const cards = document.concepts.map(entry => conceptCard(entry, "..")).join("\n");
  const empty = "<p>No concepts yet. Run <code>timds concepts add PATH</code> to add a direction.</p>";
  await fs.writeFile(path.join(directory, "index.html"), page("Concepts", null, directoryMarker + "<h1>Concepts</h1>" + (cards || empty)));
  await fs.copyFile(new URL("../templates/designs-directory.css", import.meta.url), path.join(directory, "_directory.css"));
  for (const concept of document.concepts) {
    const folder = path.join(directory, concept.id);
    for (const [file, bytes] of section.files.get(concept.id)) {
      const output = path.join(folder, "pieces", file);
      await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.writeFile(output, bytes);
    }
    await fs.writeFile(path.join(folder, "index.html"), page(concept.title, concept.id, conceptDetail(concept, "../..")));
    await fs.writeFile(path.join(folder, "index.md"), markdownMirror(concept));
  }
}

export async function buildConcepts(root, { manifest = null } = {}) {
  const section = await prepareSection(root, manifest);
  const { document, warnings, base } = section;
  let parent = root;
  for (const part of ["dist", ...base.split("/").filter(part => part !== ".")]) {
    parent = path.join(parent, part);
    const stat = await optionalStat(parent);
    if (stat && !stat.isDirectory()) throw new Error(parent + " must be a real directory");
  }
  const directory = path.join(parent, "concepts");
  const existing = await optionalStat(directory);
  if (existing) {
    if (!existing.isDirectory()) throw new Error(directory + " is reserved for concepts");
    const index = path.join(directory, "index.html");
    const generated = (await optionalStat(index))?.isFile() && (await fs.readFile(index, "utf8")).includes(directoryMarker);
    if (!generated) throw new Error(directory + " is reserved for concepts and already contains workspace output");
  }
  if (!document) {
    if (existing) await fs.rm(directory, { recursive: true });
    return { document, warnings };
  }
  const entryHtml = await fs.readFile(path.join(root, "dist", section.entry), "utf8").catch(error => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const stylesheets = stylesheetReferences(entryHtml).links.map(href => {
    const [, target, suffix] = href.match(/^([^?#]*)(.*)$/s);
    return { file: path.posix.normalize(target.startsWith("/") ? target.slice(1) : path.posix.join(base, target)), suffix };
  });
  await fs.mkdir(parent, { recursive: true });
  const stage = await fs.mkdtemp(path.join(parent, ".timds-concepts-"));
  try {
    await writeSection(stage, section, stylesheets);
    if (existing) await fs.rm(directory, { recursive: true });
    await fs.rename(stage, directory);
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
  return { document, warnings };
}

export async function readConceptsDocument(root, manifest = null) {
  const { document, warnings } = await prepareSection(root, manifest);
  return { document, warnings };
}

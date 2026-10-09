// Derive machine-readable artifacts from a built design-system artifact.
//
// A published TimDS artifact is written for people. The same content is also
// the system's contract, and agents and downstream pipelines need to read it
// without scraping HTML or maintaining a parallel hand-written JSON file. This
// module harvests the built pages and emits, beside them:
//
//   <entry-dir>/index.json     structured tree, assets joined to media records
//   <entry-dir>/tokens.json    every CSS custom property the pages load, resolved
//   <entry-dir>/brand.json     the brand kit: role colors and fonts (with the
//                              files or font service that serve them), logos, imagery
//   <entry-dir>/formats.json   the asset format catalog, when the system keeps one
//   <entry-dir>/llms.txt       the brand essentials and the page index, in the
//                              llms.txt convention: one URL a person pastes into
//                              any AI tool to produce something on-brand
//   <entry-dir>/llms-full.txt  every page's Markdown in one file
//   <page>/index.md            a Markdown mirror of every page
//
// Extraction keys on HTML semantics (main, section, h1/h2, table, figure, pre)
// so it works with no configuration. A design system whose markup needs a hint
// declares one in timds.json `machine`; nothing here is design-system specific.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  attr,
  byTag,
  classList,
  elementChildren,
  findAll,
  findOne,
  hasClass,
  parseHtml,
  rawTextOf,
  slugify,
  textOf,
  walk,
} from "./html.mjs";
import { annotationFor, buildBrandKit } from "./brand.mjs";
import { designsDocument } from "./designs.mjs";
import { describeFormatSize, formatsDocument } from "./formats.mjs";
import { buildTokensDocument, importReferences, parseCssTokens, parseFontFaces, stylesheetReferences } from "./tokens.mjs";

export const EXTRACT_SCHEMA_VERSION = 1;

/* ── selector hints ─────────────────────────────────────────────────────── */

// A deliberately tiny selector language: `tag`, `.class`, or `tag.class`.
// Anything richer belongs in the design system's markup, not in configuration.
export function parseSelector(input) {
  const value = String(input ?? "").trim();
  if (!value) return null;
  const match = /^([a-zA-Z][a-zA-Z0-9-]*)?(?:\.([a-zA-Z0-9_-]+))?$/.exec(value);
  if (!match || (!match[1] && !match[2])) {
    throw new Error(`timds.json machine selector "${value}" must be tag, .class, or tag.class`);
  }
  return { tag: match[1]?.toLowerCase() ?? null, className: match[2] ?? null };
}

const selectorList = (input) => {
  if (input === undefined || input === null) return [];
  const values = Array.isArray(input) ? input : [input];
  return values.map((value) => parseSelector(value)).filter(Boolean);
};

const matches = (node, selector) =>
  (!selector.tag || node.tag === selector.tag) && (!selector.className || hasClass(node, selector.className));

const matchesAny = (node, selectors) => selectors.some((selector) => matches(node, selector));

export function normalizeMachineConfig(input = {}) {
  if (input === false) return { enabled: false };
  const config = input && typeof input === "object" ? input : {};
  return {
    enabled: config.enabled !== false,
    root: selectorList(config.root),
    block: selectorList(config.block),
    note: selectorList(config.note),
    code: selectorList(config.code),
    ignore: selectorList(config.ignore),
  };
}

/* ── defaults ───────────────────────────────────────────────────────────── */

const DEFAULT_ROOT = [{ tag: "main", className: null }, { tag: "body", className: null }];
const DEFAULT_BLOCK = [{ tag: "section", className: null }];
const DEFAULT_NOTE = [
  { tag: "aside", className: null },
  { tag: "blockquote", className: null },
  { tag: null, className: "note" },
];
const DEFAULT_CODE = [{ tag: "pre", className: null }];
const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/* ── page extraction ────────────────────────────────────────────────────── */

function findRoot(document, selectors) {
  for (const selector of [...selectors, ...DEFAULT_ROOT]) {
    const found = findOne(document, (node) => matches(node, selector));
    if (found) return found;
  }
  return document;
}

function isHeaderText(node) {
  return node.type === "element" && !HEADINGS.has(node.tag) && textOf(node);
}

/** title = first h1; eyebrow = the labelled element before it; lede = first paragraph after. */
function pageHeader(root) {
  const h1 = findOne(root, (node) => node.tag === "h1");
  const title = h1 ? textOf(h1) : "";
  let eyebrow = "";
  let lede = "";
  if (h1) {
    const siblings = elementChildren(root);
    const index = siblings.indexOf(h1);
    if (index > 0) {
      const previous = siblings[index - 1];
      if (isHeaderText(previous) && textOf(previous).length <= 120) eyebrow = textOf(previous);
    }
    for (const node of siblings.slice(index + 1)) {
      if (node.tag === "p") {
        lede = textOf(node, { markdown: true });
        break;
      }
      if (node.tag === "section" || HEADINGS.has(node.tag)) break;
    }
  }
  return { title, eyebrow, lede };
}

/**
 * Ids are the contract: an agent cites one and a reviewer resolves it. A repeated
 * id resolves to the wrong record, so collisions get a numeric suffix.
 */
function uniqueId(seen, candidate) {
  if (!seen.has(candidate)) {
    seen.add(candidate);
    return candidate;
  }
  let counter = 2;
  while (seen.has(`${candidate}-${counter}`)) counter += 1;
  const resolved = `${candidate}-${counter}`;
  seen.add(resolved);
  return resolved;
}

function extractTable(table, blockId, pageId, seen) {
  const head = byTag(table, "thead")[0];
  const columns = (head ? byTag(head, "th") : byTag(table, "th")).map((cell) => textOf(cell));
  const body = byTag(table, "tbody")[0] ?? table;
  const rows = [];
  for (const row of byTag(body, "tr")) {
    const cells = elementChildren(row).filter((cell) => cell.tag === "td");
    if (!cells.length) continue;
    const fields = {};
    const markdown = {};
    cells.forEach((cell, position) => {
      const column = columns[position] || `column${position + 1}`;
      fields[column] = textOf(cell);
      markdown[column] = textOf(cell, { markdown: true });
    });
    rows.push({
      id: uniqueId(seen, `${pageId}#${blockId}/${slugify(textOf(cells[0]), `row-${rows.length + 1}`)}`),
      fields,
      markdown,
    });
  }
  return { columns, rows };
}

function mediaSource(node) {
  return attr(node, "src") || attr(node, "data-src") || null;
}

function extractAsset(node, blockId, pageId, joinMedia, seen, parents = new Map()) {
  const holder = node.tag === "figure" ? node : null;
  const carrier = holder
    ? findOne(holder, (child) => ["img", "video", "audio", "source"].includes(child.tag) && mediaSource(child))
    : node;
  const source = carrier ? mediaSource(carrier) : null;
  if (!source) return null;

  const caption = holder ? findOne(holder, (child) => child.tag === "figcaption") : null;
  // Caption lines, in order: the first is the asset's name, the rest describe it.
  const lines = [];
  if (caption) {
    const collect = (candidate) => {
      const ownText = (candidate.children ?? []).some((child) => child.type === "text" && child.value.trim());
      if (ownText) {
        const value = textOf(candidate, { markdown: true });
        if (value) lines.push(value);
        return;
      }
      elementChildren(candidate).forEach(collect);
    };
    elementChildren(caption).forEach(collect);
    if (!lines.length && textOf(caption)) lines.push(textOf(caption, { markdown: true }));
  }

  const name = lines[0] || attr(carrier, "alt") || source.split("/").pop();
  const brand = annotationFor(carrier, parents);
  return {
    id: uniqueId(seen, `${pageId}#${blockId}/${slugify(name, slugify(source.split("/").pop()))}`),
    name,
    lines: lines.slice(1).length ? lines.slice(1) : undefined,
    media: joinMedia(source),
    ...(brand ? { brand } : {}),
  };
}

function extractBlock(section, pageId, config, joinMedia, index, seenBlockIds, seen) {
  const heading = findOne(section, (node) => HEADINGS.has(node.tag));
  const blockId = uniqueId(seenBlockIds, attr(section, "id") || slugify(heading ? textOf(heading) : "", `block-${index + 1}`));
  const title = heading ? textOf(heading) : "";

  const noteSelectors = config.note.length ? config.note : DEFAULT_NOTE;
  const codeSelectors = config.code.length ? config.code : DEFAULT_CODE;

  const tables = findAll(section, (node) => node.tag === "table");
  const notes = findAll(section, (node) => matchesAny(node, noteSelectors));
  const codeNodes = findAll(section, (node) => matchesAny(node, codeSelectors));
  const figures = findAll(section, (node) => node.tag === "figure");
  const looseMedia = findAll(
    section,
    (node) => ["img", "video"].includes(node.tag) && mediaSource(node) && !figures.some((figure) => [...walk(figure)].includes(node)),
  );

  const specs = tables.map((table) => extractTable(table, blockId, pageId, seen)).filter((table) => table.rows.length);
  const code = codeNodes
    .map((node, position) => ({ id: `${pageId}#${blockId}/code-${position + 1}`, text: rawTextOf(node) }))
    .filter((entry) => entry.text);
  // Parent links let an asset inherit a brand annotation from any wrapper in its block.
  const parents = new Map();
  for (const node of [section, ...walk(section)]) for (const child of node.children ?? []) parents.set(child, node);
  const assets = [...figures, ...looseMedia]
    .map((node) => extractAsset(node, blockId, pageId, joinMedia, seen, parents))
    .filter(Boolean);
  const noteRecords = notes
    .map((node, position) => ({ id: `${pageId}#${blockId}/note-${position + 1}`, text: textOf(node, { markdown: true }) }))
    .filter((entry) => entry.text);

  // The heading and any prose before the first table/figure/note is the intro.
  const claimed = new Set([...tables, ...notes, ...codeNodes, ...figures, ...looseMedia]);
  const claimedSubtrees = new Set();
  for (const node of claimed) for (const child of walk(node)) claimedSubtrees.add(child);
  if (heading) claimedSubtrees.add(heading);

  const introParts = [];
  const prose = [];
  let reachedContent = false;
  const sweep = (node) => {
    if (node.type !== "element") return;
    if (claimed.has(node)) {
      reachedContent = true;
      return;
    }
    if (claimedSubtrees.has(node) || matchesAny(node, config.ignore)) return;
    if (node === heading) return;
    const ownText = (node.children ?? []).some((child) => child.type === "text" && child.value.trim());
    if (ownText) {
      const value = textOf(node, { markdown: true });
      if (!value) return;
      if (!reachedContent && node.tag === "p") introParts.push(value);
      else prose.push({ id: `${pageId}#${blockId}/prose-${prose.length + 1}`, text: value });
      return;
    }
    elementChildren(node).forEach(sweep);
  };
  elementChildren(section).forEach(sweep);

  return {
    id: `${pageId}#${blockId}`,
    title,
    intro: introParts.join("\n\n") || undefined,
    specs: specs.length ? specs : undefined,
    notes: noteRecords.length ? noteRecords : undefined,
    code: code.length ? code : undefined,
    assets: assets.length ? assets : undefined,
    prose: prose.length ? prose : undefined,
  };
}

export function extractPage(html, { pageId, url, config = normalizeMachineConfig(), joinMedia = (src) => ({ url: src }) } = {}) {
  const document = parseHtml(html);
  const root = findRoot(document, config.root);
  const { title, eyebrow, lede } = pageHeader(root);

  const blockSelectors = config.block.length ? config.block : DEFAULT_BLOCK;
  let sections = findAll(root, (node) => matchesAny(node, blockSelectors));
  // Drop nested sections: the outermost match owns its content.
  sections = sections.filter((section) => !sections.some((other) => other !== section && [...walk(other)].includes(section)));
  if (!sections.length) sections = [root];

  const seenBlockIds = new Set();
  const seenRecordIds = new Set();
  const blocks = sections.map((section, index) =>
    extractBlock(section, pageId, config, joinMedia, index, seenBlockIds, seenRecordIds));
  return { id: pageId, url, view: pageId.split("/")[0], eyebrow, title, lede, blocks };
}

/* ── emitters ───────────────────────────────────────────────────────────── */

/** One block as Markdown, heading included — the unit a guidance group or a citation hands to an agent. */
export function blockToMarkdown(block) {
  const lines = [];
  const anchor = block.id.includes("#") ? block.id.slice(block.id.indexOf("#") + 1) : block.id;
  lines.push(`## ${block.title || anchor}   \`#${anchor}\``, "");
  if (block.intro) lines.push(block.intro, "");
  for (const table of block.specs ?? []) {
    const columns = table.columns.length ? table.columns : Object.keys(table.rows[0].fields);
    lines.push(`| ${columns.join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`);
    for (const row of table.rows) {
      const source = row.markdown ?? row.fields;
      lines.push(`| ${columns.map((column) => String(source[column] ?? "").replace(/\|/g, "\\|")).join(" | ")} |`);
    }
    lines.push("");
  }
  for (const note of block.notes ?? []) lines.push(`> **Note.** ${note.text}`, "");
  for (const entry of block.code ?? []) lines.push("```", entry.text, "```", "");
  if (block.assets?.length) {
    lines.push("| Asset | Media key | Notes |", "| --- | --- | --- |");
    for (const asset of block.assets) {
      const brand = asset.brand
        ? [asset.brand.role, asset.brand.primary ? "primary" : null, asset.brand.variant, asset.brand.lockup, asset.brand.on ? `on ${asset.brand.on}` : null].filter(Boolean).join(" ")
        : null;
      const detail = [brand ? `**${brand}**` : null, ...(asset.lines ?? [])].filter(Boolean).join(" · ").replace(/\|/g, "\\|");
      lines.push(`| ${asset.name} | \`${asset.media.key ?? "—"}\` | ${detail} |`);
    }
    lines.push("");
  }
  for (const entry of block.prose ?? []) lines.push(entry.text, "");
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

export function pageToMarkdown(page) {
  const lines = [`# ${page.title || page.id}`, ""];
  if (page.eyebrow) lines.push(`*${page.eyebrow}*`, "");
  if (page.lede) lines.push(page.lede, "");
  lines.push(`<!-- source: ${page.url} · id: ${page.id} -->`, "");
  for (const block of page.blocks) lines.push(blockToMarkdown(block));
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

const ROLE_LABELS = Object.freeze({
  "color.background": "Background",
  "color.panel": "Panel",
  "color.accent": "Accent",
  "color.text": "Text",
  "color.muted": "Muted text",
  "font.display": "Display (headlines)",
  "font.body": "Body",
  "font.ui": "UI",
});
const roleLabel = (role) => ROLE_LABELS[role] ?? role.replace(/^(color|font)\./, "").replace(/-/g, " ");

/**
 * The brand essentials as Markdown: what a person with nothing but this file
 * needs to make something on-brand. Colors as hex, fonts with the files or
 * service that provide them, logos by variant with their URLs, and the
 * asset formats with their sizes. Every URL is site-absolute here and
 * rewritten to the CDN on publish, like the page links.
 */
function llmsEssentials(kit, formats) {
  const lines = [];
  const roles = Object.entries(kit?.roles ?? {});
  const colors = roles.filter(([, role]) => role.kind === "color");
  const fonts = roles.filter(([, role]) => role.kind === "font-family");
  if (colors.length) {
    lines.push("## Colors", "");
    for (const [name, role] of colors) lines.push(`- ${roleLabel(name)} (\`${name}\`): \`${role.value}\` — CSS \`var(${role.token})\``);
    lines.push("");
  }
  if (fonts.length) {
    lines.push("## Fonts", "");
    for (const [name, role] of fonts) {
      const where = [
        ...(role.specimen ? [`download: ${role.specimen}`] : []),
        ...(role.stylesheets ?? []).map((url) => `stylesheet: ${url}`),
        ...(role.files ?? []).map((file) => `${file.weight} ${file.style}${file.format ? ` ${file.format}` : ""}: ${file.url}`),
      ];
      const standing = role.system ? " — a system font, installed on every device" : where.length ? "" : " — no font file or service is published for this family";
      lines.push(`- ${roleLabel(name)} (\`${name}\`): **${role.family ?? role.value}** — CSS \`${role.value}\`${standing}`);
      for (const entry of where) lines.push(`  - ${entry}`);
    }
    lines.push("");
  }
  const logos = kit?.logos ?? [];
  if (logos.length) {
    lines.push("## Logos", "");
    for (const logo of logos) {
      const qualifiers = [logo.primary ? "primary" : null, logo.variant, logo.lockup, logo.on ? `on ${logo.on}` : null, logo.format].filter(Boolean).join(", ");
      lines.push(`- ${logo.name}${qualifiers ? ` (${qualifiers})` : ""}: ${logo.media.url}`);
    }
    lines.push("", "Use a logo file as published; never redraw, recolor, or stretch a mark.", "");
  }
  if (formats?.groups?.length) {
    lines.push("## Asset formats", "");
    for (const group of formats.groups) {
      lines.push(`### ${group.id}`, "");
      for (const format of group.formats) {
        const detail = [
          describeFormatSize(format),
          format.bleed ? `bleed ${format.bleed} ${format.unit}` : null,
          `safe ${format.safe} ${format.unit}`,
          format.maxKB ? `max ${format.maxKB} KB` : null,
          format.file ?? null,
          format.stock ?? null,
          format.note ?? null,
        ].filter(Boolean).join(" · ");
        lines.push(`- ${format.pageUrl ? `[${format.name}](${format.pageUrl})` : format.name} (\`${format.id}\`): ${detail}`);
      }
      lines.push("");
    }
  }
  return lines;
}

/**
 * llms.txt: the one URL a person or an agent needs. It opens with how to use
 * the file, the brand essentials, and then the page directory, so a chat tool
 * given nothing else can still find the logo, the colors, the fonts, and the
 * business card's size, and follow a link only for the detail.
 */
export function buildLlmsText(manifest, pages, { indexUrl, tokensUrl = null, brandUrl = null, designsUrl = null, formatsUrl = null, fullUrl = null, kit = null, formats = null } = {}) {
  const lines = [`# ${manifest.name}`, ""];
  if (manifest.description) lines.push(`> ${manifest.description}`, "");
  lines.push(
    `This file is the entry point to the ${manifest.name}${manifest.version ? ` (version ${manifest.version})` : ""} for people and AI tools. Everything a piece of on-brand work needs is here or one link away: the colors, the fonts and where to get them, the logo files, the asset formats, and the guidance pages. Take every color, font, logo, and image from this system; when it lacks something, say so rather than inventing it.`,
    "",
  );
  lines.push(`Machine-readable index: ${indexUrl} — every page below also exists as \`index.md\`.`);
  if (fullUrl) lines.push(`Full text: ${fullUrl} — every page's Markdown in one file.`);
  if (tokensUrl) lines.push(`Design tokens: ${tokensUrl} — every CSS custom property the pages load, resolved by scope.`);
  if (brandUrl) lines.push(`Brand kit: ${brandUrl} — role colors and fonts, logos, and imagery for on-brand production.`);
  if (formatsUrl) lines.push(`Asset formats: ${formatsUrl} — every print sheet and screen canvas with its size, bleed, and safe margin.`);
  if (designsUrl) lines.push(`Website designs: ${designsUrl} — whole pages as plain HTML on the system's stylesheets, the reference a product port must match.`);
  lines.push("");
  lines.push(...llmsEssentials(kit, formats));
  for (const view of [...new Set(pages.map((page) => page.view))]) {
    lines.push(`## ${view || "pages"}`, "");
    for (const page of pages.filter((page) => page.view === view)) {
      const summary = page.lede.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").slice(0, 200);
      lines.push(`- [${page.title}](${page.url}/index.md)${summary ? `: ${summary}` : ""}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** llms-full.txt: every page's Markdown mirror in one file, in page order, each marked with its source. */
export function buildLlmsFullText(manifest, pages) {
  const lines = [`# ${manifest.name}`, ""];
  if (manifest.description) lines.push(`> ${manifest.description}`, "");
  lines.push(`Every page of the system${manifest.version ? ` at version ${manifest.version}` : ""}, in one file. Each page begins with its title and names its source URL.`, "");
  for (const page of pages) lines.push("---", "", pageToMarkdown(page).trimEnd(), "");
  return `${lines.join("\n").trimEnd()}\n`;
}

/* ── stylesheet harvest ─────────────────────────────────────────────────── */

const sha256Of = (content) => createHash("sha256").update(content).digest("hex");

/** Resolve a page or stylesheet reference to an artifact-relative path, or null when it leaves the artifact. */
function resolveArtifactReference(reference, fromRelative, artifactRoot) {
  const clean = reference.split(/[?#]/, 1)[0];
  if (!clean) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    return null;
  }
  const relative = decoded.startsWith("/")
    ? path.posix.normalize(decoded.replace(/^\/+/, ""))
    : path.posix.normalize(path.posix.join(path.posix.dirname(fromRelative), decoded));
  if (!relative || relative === "." || relative.startsWith("../") || relative === "..") return null;
  return { absolutePath: path.join(artifactRoot, ...relative.split("/")), relative };
}

/**
 * A `@font-face` source as the artifact serves it: a site-absolute path for a
 * file inside the artifact, the URL as written for one outside it, or null
 * for a reference that resolves nowhere.
 */
function fontSourceUrl(url, fromRelative, artifactRoot) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) return url;
  const target = resolveArtifactReference(url, fromRelative, artifactRoot);
  return target ? `/${target.relative}` : null;
}

/**
 * Every stylesheet the pages load — linked files (following `@import`) and
 * inline `<style>` blocks — parsed into scoped custom-property records, plus
 * the `@font-face` faces they declare and the external stylesheets the pages
 * link, which together say where each font role's family comes from.
 * A linked file is read once however many pages name it; a file the artifact
 * lacks is skipped here and reported by artifact validation.
 */
async function harvestStylesheets(pageFiles, baseDirectory, artifactRoot) {
  const stylesheets = [];
  const records = [];
  const faces = [];
  const external = new Set();
  const queue = [];
  const queued = new Set();
  const enqueue = (reference, fromRelative) => {
    const target = resolveArtifactReference(reference, fromRelative, artifactRoot);
    if (!target || queued.has(target.relative)) return;
    queued.add(target.relative);
    queue.push(target);
  };
  const collectFaces = (css, source, fromRelative) => {
    for (const face of parseFontFaces(css, { source })) {
      const sources = face.sources.map((entry) => ({ ...entry, url: fontSourceUrl(entry.url, fromRelative, artifactRoot) })).filter((entry) => entry.url);
      if (sources.length) faces.push({ ...face, sources });
    }
  };

  for (const file of pageFiles) {
    const pageRelative = path.relative(artifactRoot, file).split(path.sep).join("/");
    const references = stylesheetReferences(await fs.readFile(file, "utf8"));
    for (const href of references.links) enqueue(href, pageRelative);
    for (const href of references.external) external.add(href);
    // An inline block is a source only when it declares a token; page chrome
    // styles would otherwise list one empty entry per page.
    references.inline.forEach((css, position) => {
      const source = `/${pageRelative}#style-${position + 1}`;
      collectFaces(css, source, pageRelative);
      const found = parseCssTokens(css, { source });
      if (!found.length) return;
      stylesheets.push({ path: source, bytes: Buffer.byteLength(css), sha256: sha256Of(css), inline: true });
      records.push(...found);
    });
  }

  while (queue.length) {
    const target = queue.shift();
    let css;
    try {
      css = await fs.readFile(target.absolutePath, "utf8");
    } catch {
      continue;
    }
    const source = `/${target.relative}`;
    stylesheets.push({ path: source, bytes: Buffer.byteLength(css), sha256: sha256Of(css) });
    for (const reference of importReferences(css)) enqueue(reference, target.relative);
    collectFaces(css, source, target.relative);
    records.push(...parseCssTokens(css, { source }));
  }

  // Linked files in path order, inline blocks in page order after them, so the
  // document is stable across builds that only reorder page discovery.
  const ordered = [
    ...stylesheets.filter((sheet) => !sheet.inline).sort((left, right) => left.path.localeCompare(right.path)),
    ...stylesheets.filter((sheet) => sheet.inline),
  ];
  const position = new Map(ordered.map((sheet, index) => [sheet.path, index]));
  const orderedRecords = records
    .map((record, index) => ({ record, index }))
    .sort((left, right) => position.get(left.record.source) - position.get(right.record.source) || left.index - right.index)
    .map(({ record }) => record);
  // Faces in stylesheet order like the records; external links sorted so the kit is stable across builds.
  const orderedFaces = faces
    .map((face, index) => ({ face, index }))
    .sort((left, right) => (position.get(left.face.source) ?? Number.MAX_SAFE_INTEGER) - (position.get(right.face.source) ?? Number.MAX_SAFE_INTEGER) || left.index - right.index)
    .map(({ face }) => face);
  return { stylesheets: ordered, records: orderedRecords, fonts: { faces: orderedFaces, stylesheets: [...external].sort() } };
}

/* ── artifact walk ──────────────────────────────────────────────────────── */

async function htmlPages(root, { skip = [] } = {}) {
  const found = [];
  const skipped = new Set(skip.map((directory) => path.resolve(directory)));
  const visit = async (directory) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!skipped.has(path.resolve(absolutePath))) await visit(absolutePath);
      }
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".html")) found.push(absolutePath);
    }
  };
  await visit(root);
  return found.sort();
}

/**
 * Derive only the tokens document from a built artifact, in memory. The video
 * workspace uses this when `timds check` has not written tokens.json yet but
 * the pages are built, so a brand reference still resolves. Null when the
 * artifact entry is not built.
 */
export async function deriveTokensFromArtifact({ artifactRoot, manifest }) {
  const entry = manifest.artifact?.entry || "index.html";
  const entryDirectory = path.posix.dirname(entry);
  const baseDirectory = entryDirectory === "." ? artifactRoot : path.join(artifactRoot, entryDirectory);
  try {
    await fs.access(path.join(artifactRoot, ...entry.split("/")));
  } catch {
    return null;
  }
  const harvested = await harvestStylesheets(await htmlPages(baseDirectory), baseDirectory, artifactRoot);
  return buildTokensDocument({ manifest, stylesheets: harvested.stylesheets, records: harvested.records });
}

/**
 * Harvest a built artifact and write the machine-readable files beside it.
 * Returns the index plus counts, and writes nothing when `machine.enabled` is false.
 * `designs` is the rendered design set from designs.mjs, or null when the
 * system designs no pages; its output directory is not guidance and is
 * skipped by the page walk. `formats` is the validated format catalog from
 * formats.mjs, or null when the system keeps none.
 */
export async function extractArtifact({ artifactRoot, manifest, mediaCatalog = { assets: [] }, video = null, designs = null, formats = null, write = true }) {
  const config = normalizeMachineConfig(manifest.machine);
  if (!config.enabled) return { enabled: false, pages: [], written: [] };

  const entryDirectory = path.posix.dirname(manifest.artifact.entry);
  const baseDirectory = entryDirectory === "." ? artifactRoot : path.join(artifactRoot, entryDirectory);
  const basePrefix = entryDirectory === "." ? "" : `/${entryDirectory}`;

  const byUrl = new Map(mediaCatalog.assets.map((asset) => [asset.publicUrl, asset]));
  const joinMedia = (source) => {
    const record = byUrl.get(source);
    if (!record) return { url: source };
    return {
      key: record.key,
      url: record.publicUrl,
      contentType: record.contentType,
      bytes: record.bytes,
      sha256: record.sha256,
      ...(record.durationSeconds ? { durationSeconds: record.durationSeconds } : {}),
      ...(record.width ? { width: record.width } : {}),
      ...(record.height ? { height: record.height } : {}),
      ...(record.frameRate ? { frameRate: record.frameRate } : {}),
      ...(record.codec ? { codec: record.codec } : {}),
    };
  };

  const pages = [];
  const written = [];
  const pageFiles = await htmlPages(baseDirectory, { skip: designs ? [path.join(artifactRoot, ...designs.outputDirectory.split("/"))] : [] });
  for (const file of pageFiles) {
    const relativeDirectory = path.relative(baseDirectory, path.dirname(file)).split(path.sep).filter(Boolean).join("/");
    const name = path.basename(file, ".html");
    const pageId = name === "index" ? relativeDirectory || "index" : [relativeDirectory, name].filter(Boolean).join("/");
    const url = `${basePrefix}${pageId === "index" ? "" : `/${pageId}`}` || "/";

    const page = extractPage(await fs.readFile(file, "utf8"), { pageId, url, config, joinMedia });
    if (!page.title) continue;
    pages.push(page);

    if (write) {
      const markdownPath = name === "index"
        ? path.join(path.dirname(file), "index.md")
        : path.join(path.dirname(file), `${name}.md`);
      await fs.writeFile(markdownPath, pageToMarkdown(page));
      written.push(markdownPath);
    }
  }
  pages.sort((left, right) => left.id.localeCompare(right.id));

  const harvested = await harvestStylesheets(pageFiles, baseDirectory, artifactRoot);
  const tokens = buildTokensDocument({ manifest, stylesheets: harvested.stylesheets, records: harvested.records });
  const tokensUrl = `${basePrefix}/tokens.json`;
  const { kit: brand, warnings: brandWarnings } = buildBrandKit({ manifest, tokens, pages, renderBlock: blockToMarkdown, fonts: harvested.fonts });
  const brandUrl = `${basePrefix}/brand.json`;
  const designsUrl = designs ? `${basePrefix}/designs.json` : null;
  const designsDoc = designs ? designsDocument(designs, manifest) : null;
  const formatsUrl = formats ? `${basePrefix}/formats.json` : null;
  const formatsResult = formats ? formatsDocument(formats, manifest, { pages, basePrefix }) : null;
  const formatsDoc = formatsResult?.document ?? null;
  const fullUrl = `${basePrefix}/llms-full.txt`;

  const index = {
    schemaVersion: EXTRACT_SCHEMA_VERSION,
    system: { id: manifest.systemId, name: manifest.name, version: manifest.version },
    pageCount: pages.length,
    tokens: { url: tokensUrl, count: tokens.count, stylesheets: tokens.stylesheets.length, roles: Object.keys(tokens.roles).length },
    brand: { url: brandUrl, logos: brand.logos.length, imagery: brand.imagery.length, guidance: Object.keys(brand.guidance).length },
    // The asset format catalog, when the system keeps one: where it sits and how much it holds.
    ...(formatsDoc ? { formats: { url: formatsUrl, groups: formatsDoc.groupCount, count: formatsDoc.count } } : {}),
    // The website designs, when the system has any: where the document sits and how much it holds.
    ...(designsDoc ? { designs: { url: designsUrl, count: designsDoc.designCount, pages: designsDoc.pageCount, states: designsDoc.stateCount } } : {}),
    // The video board catalog summary (kinds, guidance, budgets, cadence) when the system has one.
    ...(video ? {video} : {}),
    pages,
  };

  if (write) {
    const indexPath = path.join(baseDirectory, "index.json");
    const tokensPath = path.join(baseDirectory, "tokens.json");
    const brandPath = path.join(baseDirectory, "brand.json");
    const llmsPath = path.join(baseDirectory, "llms.txt");
    const llmsFullPath = path.join(baseDirectory, "llms-full.txt");
    // Markdown carries inline emphasis; JSON stays plain so consumers can match on it.
    await fs.writeFile(indexPath, `${JSON.stringify(index, (key, value) => (key === "markdown" ? undefined : value), 2)}\n`);
    await fs.writeFile(tokensPath, `${JSON.stringify(tokens, null, 2)}\n`);
    await fs.writeFile(brandPath, `${JSON.stringify(brand, null, 2)}\n`);
    await fs.writeFile(llmsPath, buildLlmsText(manifest, pages, { indexUrl: `${basePrefix}/index.json`, tokensUrl, brandUrl, designsUrl, formatsUrl, fullUrl, kit: brand, formats: formatsDoc }));
    await fs.writeFile(llmsFullPath, buildLlmsFullText(manifest, pages));
    written.push(indexPath, tokensPath, brandPath, llmsPath, llmsFullPath);
    if (formatsDoc) {
      const formatsPath = path.join(baseDirectory, "formats.json");
      await fs.writeFile(formatsPath, `${JSON.stringify(formatsDoc, null, 2)}\n`);
      written.push(formatsPath);
    }
    if (designsDoc) {
      const designsPath = path.join(baseDirectory, "designs.json");
      await fs.writeFile(designsPath, `${JSON.stringify(designsDoc, null, 2)}\n`);
      written.push(designsPath);
    }
  }

  const counts = pages.reduce(
    (totals, page) => {
      totals.blocks += page.blocks.length;
      for (const block of page.blocks) {
        totals.rules += (block.specs ?? []).reduce((sum, table) => sum + table.rows.length, 0);
        totals.notes += (block.notes ?? []).length;
        totals.code += (block.code ?? []).length;
        totals.assets += (block.assets ?? []).length;
        totals.linkedAssets += (block.assets ?? []).filter((asset) => asset.media.key).length;
        totals.untyped += (block.prose ?? []).length;
      }
      return totals;
    },
    { blocks: 0, rules: 0, notes: 0, code: 0, assets: 0, linkedAssets: 0, untyped: 0 },
  );
  counts.tokens = tokens.count;
  counts.stylesheets = tokens.stylesheets.length;
  counts.roles = Object.keys(tokens.roles).length;
  counts.logos = brand.logos.length;
  counts.imagery = brand.imagery.length;
  counts.guidance = Object.keys(brand.guidance).length;
  counts.formats = formatsDoc?.count ?? 0;
  const warnings = [
    ...(tokens.missingRoles ?? []).map((role) =>
      `brand role ${role} is not filled: no loaded stylesheet declares a conventional token on :root; map it in timds.json brand.roles`),
    ...brandWarnings,
    ...(formatsResult?.warnings ?? []),
  ];

  return { enabled: true, brand, counts, designs: designsDoc, formats: formatsDoc, index, pages, tokens, warnings, written };
}

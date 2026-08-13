// Derive machine-readable artifacts from a built design-system artifact.
//
// A published TimDS artifact is written for people. The same content is also
// the system's contract, and agents and downstream pipelines need to read it
// without scraping HTML or maintaining a parallel hand-written JSON file. This
// module harvests the built pages and emits, beside them:
//
//   <entry-dir>/index.json     structured tree, assets joined to media records
//   <entry-dir>/llms.txt       page index in the llms.txt convention
//   <page>/index.md            a Markdown mirror of every page
//
// Extraction keys on HTML semantics (main, section, h1/h2, table, figure, pre)
// so it works with no configuration. A design system whose markup needs a hint
// declares one in timds.json `machine`; nothing here is design-system specific.

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

function extractAsset(node, blockId, pageId, joinMedia, seen) {
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
  return {
    id: uniqueId(seen, `${pageId}#${blockId}/${slugify(name, slugify(source.split("/").pop()))}`),
    name,
    lines: lines.slice(1).length ? lines.slice(1) : undefined,
    media: joinMedia(source),
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
  const assets = [...figures, ...looseMedia]
    .map((node) => extractAsset(node, blockId, pageId, joinMedia, seen))
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

export function pageToMarkdown(page) {
  const lines = [`# ${page.title || page.id}`, ""];
  if (page.eyebrow) lines.push(`*${page.eyebrow}*`, "");
  if (page.lede) lines.push(page.lede, "");
  lines.push(`<!-- source: ${page.url} · id: ${page.id} -->`, "");

  for (const block of page.blocks) {
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
        const detail = (asset.lines ?? []).join(" · ").replace(/\|/g, "\\|");
        lines.push(`| ${asset.name} | \`${asset.media.key ?? "—"}\` | ${detail} |`);
      }
      lines.push("");
    }
    for (const entry of block.prose ?? []) lines.push(entry.text, "");
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

export function buildLlmsText(manifest, pages, indexUrl) {
  const lines = [`# ${manifest.name}`, ""];
  if (manifest.description) lines.push(`> ${manifest.description}`, "");
  lines.push(`Machine-readable index: ${indexUrl} — every page below also exists as \`index.md\`.`, "");
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

/* ── artifact walk ──────────────────────────────────────────────────────── */

async function htmlPages(root) {
  const found = [];
  const visit = async (directory) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".html")) found.push(absolutePath);
    }
  };
  await visit(root);
  return found.sort();
}

/**
 * Harvest a built artifact and write the machine-readable files beside it.
 * Returns the index plus counts, and writes nothing when `machine.enabled` is false.
 */
export async function extractArtifact({ artifactRoot, manifest, mediaCatalog = { assets: [] }, write = true }) {
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
  for (const file of await htmlPages(baseDirectory)) {
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

  const index = {
    schemaVersion: EXTRACT_SCHEMA_VERSION,
    system: { id: manifest.systemId, name: manifest.name, version: manifest.version },
    pageCount: pages.length,
    pages,
  };

  if (write) {
    const indexPath = path.join(baseDirectory, "index.json");
    const llmsPath = path.join(baseDirectory, "llms.txt");
    // Markdown carries inline emphasis; JSON stays plain so consumers can match on it.
    await fs.writeFile(indexPath, `${JSON.stringify(index, (key, value) => (key === "markdown" ? undefined : value), 2)}\n`);
    await fs.writeFile(llmsPath, buildLlmsText(manifest, pages, `${basePrefix}/index.json`));
    written.push(indexPath, llmsPath);
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

  return { enabled: true, counts, index, pages, written };
}

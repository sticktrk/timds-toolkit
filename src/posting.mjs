// The blog posting template: the layout of an article a publishing engine
// writes for a site on this Design System.
//
// The designer owns the layout and the publishing engine owns the content.
// A designer keeps the template in `src/posting/blog.json`: the article's
// named blocks in page order, each block's element and fixed heading, and
// what each block is for. An engine decides which blocks an article fills and
// what each says, asks its writer for that content only, and builds the HTML
// from this file, so a writer never writes a wrapper, a fixed heading or a
// class. `required` is the designer's note that the layout expects a block,
// and `html.classes` a record of the extra classes the stylesheet styles in a
// body; neither is an instruction to a writer. The system's
// stylesheet styles each block by its id (`.prose #answer-box`), the viewer
// shows the template with those styles ({{posting:preview}} and
// {{posting:blocks}} in a page), and a release publishes the file in the
// consumer bundle, where a publishing engine and a website read the same
// bytes. Structure, style and preview therefore live in one system and ship
// in one release.
//
// Every Design System's file has the same structure, and the structure only
// grows:
//   - `schemaVersion` stays 1.
//   - Only `schemaVersion`, `template` and each block's `id` are required.
//     Every other key is optional and its absence means the behaviour before
//     the key existed.
//   - A reader ignores keys it does not know, so a file written for a newer
//     toolkit still loads. `check` names such keys, since an unknown key is
//     more often a misspelling than a newer file.
//   - A key is never renamed and never changes meaning; a block id, once
//     published, stays, because sites style blocks by id.
//
// The template is optional: a system without the file publishes none and
// nothing else changes.

import fs from "node:fs/promises";
import path from "node:path";

export const POSTING_SCHEMA_VERSION = 1;
export const POSTING_TEMPLATE_KIND = "blog";
export const POSTING_SOURCE_FILE = "src/posting/blog.json";
/** The wrapper a site renders an article body in; the stock stylesheets style blocks inside it. */
export const POSTING_BODY_CLASS = "prose";

const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const ELEMENTS = Object.freeze(["section", "aside", "div"]);
const LIMITS = Object.freeze({ blocks: 24, classes: 40, supplies: 16, name: 120, supply: 80, heading: 80, write: 600, use: 200 });
const KNOWN = Object.freeze({
  root: ["$comment", "schemaVersion", "template", "name", "page", "html", "blocks"],
  page: ["supplies"],
  html: ["classes"],
  class: ["name", "use"],
  block: ["id", "element", "heading", "required", "plain", "write"],
});

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const escapeHtml = (value) => String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);

function text(value, limit, at) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${at} must be text`);
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length > limit) throw new Error(`${at} is ${trimmed.length} characters; the limit is ${limit}`);
  return trimmed;
}

/**
 * Validate a template object. Throws with the offending path, so a designer
 * fixes the file rather than guessing. `unknown` lists the keys this toolkit
 * does not know: they are kept out of the result and never an error.
 */
export function normalizePostingTemplate(input, { where = POSTING_SOURCE_FILE } = {}) {
  if (!isObject(input)) throw new Error(`${where} must be a JSON object`);
  const unknown = [];
  const note = (object, known, prefix) => {
    for (const key of Object.keys(object)) if (!known.includes(key)) unknown.push(`${prefix}${key}`);
  };
  note(input, KNOWN.root, "");
  if (input.schemaVersion !== POSTING_SCHEMA_VERSION) throw new Error(`${where} schemaVersion must be ${POSTING_SCHEMA_VERSION}; the structure grows by new optional keys, never by a new version`);
  if (input.template !== POSTING_TEMPLATE_KIND) throw new Error(`${where} template must be "${POSTING_TEMPLATE_KIND}"`);

  const supplies = [];
  if (input.page !== undefined) {
    if (!isObject(input.page)) throw new Error(`${where} page must be an object`);
    note(input.page, KNOWN.page, "page.");
    if (input.page.supplies !== undefined) {
      if (!Array.isArray(input.page.supplies)) throw new Error(`${where} page.supplies must be a list of what the page shows by itself`);
      if (input.page.supplies.length > LIMITS.supplies) throw new Error(`${where} page.supplies lists ${input.page.supplies.length} entries; the limit is ${LIMITS.supplies}`);
      input.page.supplies.forEach((entry, index) => supplies.push(text(entry, LIMITS.supply, `${where} page.supplies[${index}]`)));
    }
  }

  const classes = [];
  if (input.html !== undefined) {
    if (!isObject(input.html)) throw new Error(`${where} html must be an object`);
    note(input.html, KNOWN.html, "html.");
    if (input.html.classes !== undefined) {
      if (!Array.isArray(input.html.classes)) throw new Error(`${where} html.classes must be a list of classes with a name and a use`);
      if (input.html.classes.length > LIMITS.classes) throw new Error(`${where} html.classes lists ${input.html.classes.length} classes; the limit is ${LIMITS.classes}`);
      input.html.classes.forEach((entry, index) => {
        const at = `${where} html.classes[${index}]`;
        if (!isObject(entry)) throw new Error(`${at} must be an object with a name and a use`);
        note(entry, KNOWN.class, `html.classes[${index}].`);
        if (typeof entry.name !== "string" || !NAME.test(entry.name)) throw new Error(`${at} name must be lowercase letters, digits and hyphens, starting with a letter`);
        if (classes.some((item) => item.name === entry.name)) throw new Error(`${where} html.classes names ${entry.name} twice`);
        classes.push({ name: entry.name, use: text(entry.use, LIMITS.use, `${at} use`) });
      });
    }
  }

  if (!Array.isArray(input.blocks) || !input.blocks.length) throw new Error(`${where} blocks must list at least one block`);
  if (input.blocks.length > LIMITS.blocks) throw new Error(`${where} lists ${input.blocks.length} blocks; the limit is ${LIMITS.blocks}`);
  const blocks = input.blocks.map((entry, index) => {
    const at = `${where} blocks[${index}]`;
    if (!isObject(entry)) throw new Error(`${at} must be an object with an id`);
    if (typeof entry.id !== "string" || !NAME.test(entry.id)) throw new Error(`${at} id must be lowercase letters, digits and hyphens, starting with a letter`);
    note(entry, KNOWN.block, `blocks.${entry.id}.`);
    if (entry.element !== undefined && !ELEMENTS.includes(entry.element)) throw new Error(`${where} block ${entry.id} element must be one of ${ELEMENTS.join(", ")}`);
    for (const field of ["required", "plain"]) {
      if (entry[field] !== undefined && typeof entry[field] !== "boolean") throw new Error(`${where} block ${entry.id} ${field} must be true or false`);
    }
    return {
      id: entry.id,
      element: entry.element ?? "section",
      heading: entry.heading === undefined ? "" : text(entry.heading, LIMITS.heading, `${where} block ${entry.id} heading`),
      required: entry.required === true,
      plain: entry.plain === true,
      write: entry.write === undefined ? "" : text(entry.write, LIMITS.write, `${where} block ${entry.id} write`),
    };
  });
  const seen = new Set();
  for (const block of blocks) {
    if (seen.has(block.id)) throw new Error(`${where} declares the block ${block.id} twice; an id is used once`);
    seen.add(block.id);
  }

  return {
    template: {
      schemaVersion: POSTING_SCHEMA_VERSION,
      template: POSTING_TEMPLATE_KIND,
      name: input.name === undefined ? "" : text(input.name, LIMITS.name, `${where} name`),
      supplies,
      classes,
      blocks,
    },
    unknown,
  };
}

/** The template a Design System keeps at `src/posting/blog.json`, validated; null when the system has none. */
export async function readPostingTemplate(designSystemRoot) {
  let raw;
  try {
    raw = await fs.readFile(path.join(designSystemRoot, ...POSTING_SOURCE_FILE.split("/")), "utf8");
  } catch (caught) {
    if (caught?.code === "ENOENT") return null;
    throw caught;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (caught) {
    throw new Error(`${POSTING_SOURCE_FILE} is not valid JSON: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
  return normalizePostingTemplate(parsed);
}

/**
 * The blocks no stylesheet styles: a block counts as styled when a selector
 * in any of the sheets names its id (`.prose #cta`, `#cta > *`). A hex colour
 * inside a declaration is not a selector and never counts.
 */
export function unstyledPostingBlocks(template, stylesheets) {
  const selectors = [];
  for (const sheet of stylesheets) {
    const css = String(sheet).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of css.matchAll(/[^{}]+(?=\{)/g)) selectors.push(match[0]);
  }
  return template.blocks
    .filter((block) => !selectors.some((selector) => new RegExp(`#${block.id}(?![A-Za-z0-9_-])`).test(selector)))
    .map((block) => block.id);
}

/**
 * The template as a sample article body: every block in page order, in its
 * element, with its heading and what a writer puts in it as the sample text.
 * Rendered inside the body wrapper, so the system's own block styles apply.
 */
export function renderPostingPreview(template) {
  if (!template) return `<div class="${POSTING_BODY_CLASS}"><p>This system keeps no blog template yet. Add <code>${POSTING_SOURCE_FILE}</code> to describe its article blocks.</p></div>`;
  const blocks = template.blocks.map((block) => {
    const heading = block.heading ? `\n  <h2>${escapeHtml(block.heading)}</h2>` : "";
    const sample = block.write || "Sample text for this block.";
    return `<${block.element} id="${block.id}">${heading}\n  <p>${escapeHtml(sample)}</p>\n</${block.element}>`;
  });
  return `<div class="${POSTING_BODY_CLASS}">\n${blocks.join("\n")}\n</div>`;
}

/** The template's blocks as a spec table: id, element, heading, whether the layout expects it in every article, and what goes in it. */
export function renderPostingTable(template) {
  const head = "<thead><tr><th>Block</th><th>Element</th><th>Heading</th><th>The layout expects it</th><th>What goes in it</th></tr></thead>";
  if (!template) return `<table class="spec">\n${head}\n<tbody>\n<tr><td>None</td><td></td><td></td><td></td><td>No <code>${POSTING_SOURCE_FILE}</code> in this system</td></tr>\n</tbody>\n</table>`;
  const rows = template.blocks.map((block) => `<tr><td><code>#${block.id}</code></td><td><code>${block.element}</code></td><td>${block.heading ? escapeHtml(block.heading) : "None fixed"}</td><td>${block.required ? "In every article" : "When it applies"}</td><td>${escapeHtml(block.write || "Not stated")}${block.plain ? " One plain paragraph." : ""}</td></tr>`);
  return `<table class="spec">\n${head}\n<tbody>\n${rows.join("\n")}\n</tbody>\n</table>`;
}

/**
 * What `check` says about a system's template beyond its validity: keys this
 * toolkit does not know, blocks no stylesheet styles, and a template the
 * manifest does not publish: either it declares no bundle, or an `exclude`
 * pattern leaves the file out of the one it declares. `stylesheets` are the
 * texts of the sheets a website loads; `bundlePaths` the files the consumer
 * bundle holds, or null when the manifest declares no bundle.
 */
export function postingTemplateWarnings({ template, unknown }, { stylesheets = [], bundlePaths = null } = {}) {
  const warnings = [];
  if (unknown.length) warnings.push(`${POSTING_SOURCE_FILE} has ${unknown.length === 1 ? "a key" : "keys"} this toolkit does not know (${unknown.join(", ")}); readers ignore ${unknown.length === 1 ? "it" : "them"}, so check the spelling`);
  const unstyled = stylesheets.length ? unstyledPostingBlocks(template, stylesheets) : [];
  if (unstyled.length) warnings.push(`${POSTING_SOURCE_FILE} names ${unstyled.length === 1 ? "a block" : "blocks"} no stylesheet styles (${unstyled.map((id) => `#${id}`).join(", ")}); a site shows ${unstyled.length === 1 ? "it" : "them"} as ordinary text until a rule such as .${POSTING_BODY_CLASS} #${unstyled[0]} exists`);
  if (!bundlePaths) warnings.push(`${POSTING_SOURCE_FILE} is not published: timds.json declares no bundle; add "${POSTING_SOURCE_FILE}" to bundle.include so a release carries it`);
  else if (!bundlePaths.includes(POSTING_SOURCE_FILE)) warnings.push(`${POSTING_SOURCE_FILE} is not published: a bundle.exclude pattern in timds.json leaves it out; remove that pattern so a release carries it`);
  return warnings;
}

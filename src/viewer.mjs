// The TimDS starter renderer: the viewer, build, check and dev logic every
// starter-based Design System runs, resolved from the package rather than
// copied into it (`@dtconcepts/timds/viewer`). The design system's
// scripts/build.mjs, check.mjs and dev.mjs are stubs that call `build`,
// `check` and `dev` here with their own root; every function takes that root.
//
// src/site.json declares the views and their pages, src/layout.html is the
// shell every page shares, and src/pages/ holds one content fragment per
// authored page. Rendering fills the shell's navigation from the site model
// and each fragment's token tables from tokens.json, so a page never restates
// a value and the navigation never drifts from the pages that exist.
// site.json home may move a view's own page to / and its overview to
// /overview/. {{page:ID}} resolves either address so stock fragments can
// link the Use page wherever the system serves it.
//
// src/formats.json is the catalog of every asset format the system produces
// (print sheets in inches, screen canvases in pixels), each tied to the page
// that shows it. {{formats:GROUP}} renders a group's table, {{canvas:ID}}
// fills a preview's style attribute (src/styles/canvas.css), and
// {{presets:GROUP}} renders the composer's preset cards, so a size lives in
// exactly one place. {{count:formats|views|pages|designs}} states a count.
//
// A page declared with "layout": "landing" in src/site.json is rendered
// without the side navigation and the previous/next links: the starter's
// front page (the Use view's own page) is one, a portal with a hero, rails of
// the formats the system makes, and the way to the composer. {{page:ID}} is a
// page's address and refuses a planned page; {{nearest:ID}} falls back to the
// nearest authored page, for a toolkit-written fragment that links the
// client's own pages.
//
// Website designs under src/designs/ are whole pages on the system's own
// stylesheets, rendered by TimDS (see build.mjs). The viewer only lists them:
// the app bar links /designs/ and the overview's sitemap names each one.
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { access, cp, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { brandKitCopySamples, brandKitMediaSamples, brandKitSlots, brandKitLabels } from "./brand-kit.mjs";

/** The design system's own folders, from the root a stub passes. */
function folders(root) {
  if (typeof root !== "string" || !root) throw new Error("The TimDS viewer needs the design system root");
  const resolved = path.resolve(root);
  return { root: resolved, source: path.join(resolved, "src"), destination: path.join(resolved, "dist") };
}
const copiedDirectories = ["assets", "scripts", "styles"];
const placeholder = /\{\{\s*([a-z]+)(?::([a-z0-9.-]+(?:\/[a-z0-9.-]+)*))?\s*\}\}/g;
const colorValue = /^(?:#|rgba?\(|hsla?\(|oklch\(|oklab\(|color\()/i;
const colorLiteral = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab)\(/i;

function cssName(group, name) {
  return `--${group}-${name}`.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function readRootJson(root, file) {
  try {
    return JSON.parse(await readFile(path.join(root, file), "utf8"));
  } catch (error) {
    throw new Error(`${file} could not be read as JSON: ${error.message}`);
  }
}

/** Copy stays a string map. Media keys resolve only to regular local assets,
 * never remote URLs or paths outside the published source asset directory. */
async function readSlotData({ root, source }) {
  const copy = existsSync(path.join(source, "copy.json")) ? await readRootJson(root, "src/copy.json") : {};
  if (!copy || typeof copy !== "object" || Array.isArray(copy) || Object.values(copy).some(value => typeof value !== "string")) {
    throw new Error("src/copy.json must be an object of string values");
  }
  const media = new Map();
  const add = (asset, key = asset?.key) => {
    if (!asset || typeof asset !== "object" || typeof key !== "string" || key !== asset.key || media.has(key)) throw new Error("The media catalog has an invalid or duplicate slot key");
    media.set(key, asset);
  };
  if (existsSync(path.join(root, ".timds/contract-layout.json"))) {
    const groups = async directory => {
      for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
        if (entry.isDirectory()) await groups(`${directory}/${entry.name}`);
        else if (entry.isFile() && entry.name.endsWith(".json")) {
          const values = await readRootJson(root, `${directory}/${entry.name}`);
          if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("Media groups must be key maps");
          for (const [key, asset] of Object.entries(values)) add(asset, key);
        } else throw new Error(`Invalid media group file ${entry.name}`);
      }
    };
    await groups("media");
  } else if (existsSync(path.join(root, "media.json"))) {
    for (const asset of (await readRootJson(root, "media.json")).assets || []) add(asset);
  }
  const paths = new Map();
  for (const [key, asset] of media) {
    const explicit = asset.path !== undefined;
    const candidate = explicit ? asset.path : `src/assets/${asset.filename || ""}`;
    if (typeof candidate !== "string" || !/^src\/assets\/[a-zA-Z0-9._/-]+$/.test(candidate) || candidate.split("/").some(part => !part || part === "." || part === "..")) {
      if (explicit) throw new Error(`Media ${key} path must name an exact file under src/assets/`);
      continue;
    }
    let current = root, present = true;
    const parts = candidate.split("/");
    for (const [index, part] of parts.entries()) {
      current = path.join(current, part);
      const info = await lstat(current).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (!info) { present = false; break; }
      if (info.isSymbolicLink() || (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())) throw new Error(`Media ${key} local path must be a regular file without symbolic links`);
    }
    if (!present) {
      if (explicit) throw new Error(`Media ${key} names a missing local asset: ${candidate}`);
      continue;
    }
    paths.set(key, `/${candidate.slice(4)}`);
  }
  return { copy, media, paths };
}

function slotRenderers(data, tokens, fallbacks) {
  const shortKey = (key, prefix) => key?.startsWith(`${prefix}.`) ? key.slice(prefix.length + 1) : key;
  const resolveCopy = key => {
    key = shortKey(key, "copy");
    const indexed = key?.match(/^(headlines|ctas)\.(\d+)$/);
    if (indexed) {
      const [, bank, index] = indexed;
      const lines = resolveCopy(bank).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      if (lines[Number(index)]) return lines[Number(index)];
      const sample = brandKitCopySamples[bank].split("\n")[Number(index)];
      if (sample === undefined) throw new Error(`Copy slot ${bank} has no sample at index ${index}`);
      fallbacks.add(`copy.${key}`);
      return sample;
    }
    if (Object.hasOwn(data.copy, key) && data.copy[key].trim()) return data.copy[key];
    if (!Object.hasOwn(brandKitCopySamples, key)) throw new Error(`Unknown copy slot ${key}; declare a string in src/copy.json`);
    fallbacks.add(`copy.${key}`);
    return brandKitCopySamples[key];
  };
  const resolveMedia = key => {
    key = shortKey(key, "media");
    if (data.paths.has(key)) return data.paths.get(key);
    if (!Object.hasOwn(brandKitMediaSamples, key) && !data.media.has(key)) throw new Error(`Unknown media slot ${key}; declare it in the media catalog`);
    fallbacks.add(`media.${key}`);
    return brandKitMediaSamples[key] || "";
  };
  const slots = group => {
    const selected = brandKitSlots.filter(slot => slot.group === group || slot.key === group);
    if (!selected.length) throw new Error(`Unknown slot group ${group}`);
    const rows = selected.map(slot => {
      const key = slot.key.slice(slot.group.length + 1);
      const record = slot.kind === "token" ? tokens[slot.group]?.[key] : slot.kind === "media" ? data.media.get(key) : null;
      const label = record?.value === "initial" ? "unresolved" : record?.label || slot.label;
      if (!brandKitLabels.includes(label)) throw new Error(`${slot.key} has an invalid label; use ${brandKitLabels.join(", ")}`);
      const value = slot.kind === "token" ? record?.value || "initial" : slot.kind === "copy" ? resolveCopy(key) : slot.kind === "media" ? resolveMedia(key) || "No asset; sample treatment" : slot.sample;
      return `<tr data-slot="${slot.key}"><td><code>${slot.key}</code></td><td>${escapeHtml(label)}</td><td>${escapeHtml(value)}</td><td>${escapeHtml(slot.source)}</td><td>${escapeHtml(slot.assumption)}</td><td>${escapeHtml(slot.guidance)}</td></tr>`;
    });
    return `${slotTableOpen}${rows.join("\n")}</tbody></table>`;
  };
  return { copy: key => escapeHtml(resolveCopy(key)), media: key => escapeHtml(resolveMedia(key)), slots };
}

const slotTableOpen = '<table class="spec slot-table"><thead><tr><th>Slot</th><th>Label</th><th>Value</th><th>Observed from</th><th>When missing</th><th>Check</th></tr></thead><tbody>';

/** Consecutive {{slots:...}} placeholders read as one table: the header row is drawn once and every slot keeps its own row. */
function mergeSlotTables(html) {
  return html.replace(/<\/tbody><\/table>\s*<table class="spec slot-table"><thead>[^]*?<\/thead><tbody>/g, "\n");
}

function compileTokens(tokens) {
  const groups = Object.entries(tokens);
  if (!groups.length) throw new Error("tokens.json must define at least one token group");
  const declarations = [];

  for (const [group, entries] of groups) {
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      throw new Error(`Token group ${group} must be an object`);
    }
    for (const [name, token] of Object.entries(entries)) {
      if (!token || typeof token.value !== "string" || !token.value.trim()) {
        throw new Error(`Token ${group}.${name} must have a non-empty string value`);
      }
      if (token.description !== undefined && typeof token.description !== "string") {
        throw new Error(`Token ${group}.${name} description must be a string`);
      }
      declarations.push(`  ${cssName(group, name)}: ${token.value.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (_match, name) => `var(--${name.replace(/[^a-z0-9-]/gi, "-").toLowerCase()})`)};`);
    }
  }

  return { count: declarations.length, css: `:root {\n${declarations.sort().join("\n")}\n}\n`, groups: groups.length };
}

/** The site model: every declared page in navigation order, the overview first. */
function readSiteModel(site) {
  if (!Array.isArray(site.views) || !site.views.length) throw new Error("src/site.json must declare at least one view");
  const home = { id: "overview", view: null, title: "Overview", file: "index.html", href: "/", output: "index.html", planned: false };
  const pages = [home];
  const views = [];

  for (const view of site.views) {
    if (!slugPattern.test(view.id ?? "")) throw new Error(`src/site.json view id ${JSON.stringify(view.id)} must be lowercase words joined by hyphens`);
    if (views.some((existing) => existing.id === view.id)) throw new Error(`src/site.json declares the view ${view.id} twice`);
    if (!view.label) throw new Error(`src/site.json view ${view.id} needs a label`);
    if (!Array.isArray(view.pages) || !view.pages.length) throw new Error(`src/site.json view ${view.id} must declare at least one page`);

    const viewPages = view.pages.map((page) => {
      const slug = page.slug ?? "";
      if (slug && !/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/.test(slug)) {
        throw new Error(`src/site.json page slug ${JSON.stringify(slug)} in view ${view.id} must be lowercase words joined by hyphens`);
      }
      if (slug.split("/").includes("index")) throw new Error(`src/site.json page slug ${slug} in view ${view.id} may not use the segment "index"; use an empty slug for the view's own page`);
      if (!page.title) throw new Error(`src/site.json page ${view.id}/${slug} needs a title`);
      const id = slug ? `${view.id}/${slug}` : view.id;
      // A landing page fills the shell's content area on its own: no side
      // navigation and no previous/next links, so a front page can lead with
      // a hero and rails the way a product's home does.
      const layout = page.layout ?? "page";
      if (!["page", "landing"].includes(layout)) throw new Error(`src/site.json page ${id} layout must be "page" or "landing", not ${JSON.stringify(page.layout)}`);
      if (pages.some((existing) => existing.id === id)) throw new Error(`src/site.json declares the page ${id} twice`);
      const entry = {
        id,
        view: view.id,
        title: page.title,
        group: page.group || "",
        summary: page.summary || "",
        planned: page.planned === true,
        layout,
        // A promoted page is linked as a call to action in the app bar of every page.
        promote: typeof page.promote === "string" ? page.promote : page.promote === true ? page.title : "",
        file: slug ? `${id}.html` : `${view.id}/index.html`,
        href: `/${id}/`,
        output: `${id}/index.html`,
      };
      pages.push(entry);
      return entry;
    });
    views.push({ id: view.id, label: view.label, blurb: view.blurb || "", pages: viewPages });
  }

  // `home` names the view whose own page is the front page: that page is
  // served at / and the overview moves to /overview/. The starter leads with
  // the Use page, which the toolkit keeps current, so a visitor lands on the
  // composer while the client's own overview stays authored and reachable.
  if (site.home !== undefined) {
    const view = views.find((candidate) => candidate.id === site.home);
    const front = view?.pages.find((page) => page.id === view.id);
    if (!front) throw new Error(`src/site.json home must name a declared view with a page whose slug is empty; ${JSON.stringify(site.home)} is not one`);
    if (front.planned) throw new Error(`src/site.json home names ${front.id}, which is planned; author src/pages/${front.file} or choose another view`);
    Object.assign(front, { href: "/", output: "index.html" });
    Object.assign(home, { href: "/overview/", output: "overview/index.html" });
  }

  return { home, pages, views };
}

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The format catalog: every print sheet and screen canvas, each tied to the page that shows it. */
function readFormats(catalog, model) {
  const groups = new Map();
  const byId = new Map();
  if (catalog === null) return { groups, byId };
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) throw new Error("src/formats.json must be an object of format groups");
  for (const [group, entry] of Object.entries(catalog)) {
    if (group.startsWith("$")) continue;
    if (!slugPattern.test(group)) throw new Error(`src/formats.json group ${JSON.stringify(group)} must be lowercase words joined by hyphens`);
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`src/formats.json group ${group} must be an object with a unit and formats`);
    if (!["in", "px"].includes(entry.unit)) throw new Error(`src/formats.json group ${group} needs a unit of "in" (print) or "px" (screen)`);
    const declared = entry.formats && typeof entry.formats === "object" && !Array.isArray(entry.formats) ? Object.entries(entry.formats) : [];
    if (!declared.length) throw new Error(`src/formats.json group ${group} must declare at least one format`);
    const formats = [];
    for (const [id, format] of declared) {
      const where = `src/formats.json format ${group}.${id}`;
      if (!slugPattern.test(id)) throw new Error(`${where} must be named with lowercase words joined by hyphens`);
      if (byId.has(id)) throw new Error(`src/formats.json declares the format ${id} twice; ids are shared across groups so {{canvas:${id}}} names one format`);
      if (!format || typeof format !== "object" || Array.isArray(format)) throw new Error(`${where} must be an object`);
      if (typeof format.name !== "string" || !format.name.trim()) throw new Error(`${where} needs a name`);
      const number = (value, minimum) => typeof value === "number" && Number.isFinite(value) && value >= minimum;
      for (const field of ["width", "height"]) if (!number(format[field], Number.MIN_VALUE)) throw new Error(`${where} needs a positive number for ${field}`);
      if (!number(format.safe, 0)) throw new Error(`${where} needs a non-negative number for safe`);
      for (const field of ["bleed", "maxKB"]) if (format[field] !== undefined && !number(format[field], 0)) throw new Error(`${where} ${field} must be a non-negative number`);
      for (const [field, sides] of [["ui", ["top", "bottom", "left", "right"]], ["keepClear", ["left", "right"]]]) {
        const value = format[field];
        if (value === undefined) continue;
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} ${field} must be an object of ${sides.join(", ")}`);
        for (const [side, amount] of Object.entries(value)) {
          if (!sides.includes(side) || !number(amount, 0)) throw new Error(`${where} ${field}.${side} must be one of ${sides.join(", ")} with a non-negative number`);
        }
      }
      for (const field of ["stock", "file", "note"]) if (format[field] !== undefined && typeof format[field] !== "string") throw new Error(`${where} ${field} must be a string`);
      const page = model.pages.find((candidate) => candidate.id === format.page);
      if (!page) throw new Error(`${where} names the page ${JSON.stringify(format.page)}, which src/site.json does not declare; every format is shown on one page`);
      const record = { ...format, id, group, unit: entry.unit, page };
      formats.push(record);
      byId.set(id, record);
    }
    groups.set(group, { id: group, unit: entry.unit, formats });
  }
  return { groups, byId };
}

/** The website designs declared under src/designs/, for the app bar and the sitemap; TimDS renders them. */
async function designList({ root, source }) {
  const directory = path.join(source, "designs");
  if (!existsSync(directory)) return [];
  const designs = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !existsSync(path.join(directory, entry.name, "design.json"))) continue;
    const design = await readRootJson(root, `src/designs/${entry.name}/design.json`);
    const pages = existsSync(path.join(directory, entry.name, "pages")) ? await pageFiles(path.join(directory, entry.name, "pages")) : [];
    designs.push({
      id: entry.name,
      title: design.title || entry.name,
      summary: design.summary || "",
      href: `/designs/${entry.name}/`,
      // A state file (contact.sent.html) belongs to its page (contact.html).
      pages: pages.filter((file) => !/\.[^./]+\.html$/.test(file)).length,
    });
  }
  return designs;
}

async function pageFiles(directory, prefix = "") {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await pageFiles(path.join(directory, entry.name), relative));
    else if (entry.name.endsWith(".html")) found.push(relative);
  }
  return found.sort();
}

function renderTokenTable(tokens, group, file) {
  const entries = tokens[group];
  if (!entries) throw new Error(`src/pages/${file} uses {{tokens:${group}}}, but tokens.json has no ${group} group`);
  const described = Object.values(entries).some((token) => token.description);
  const rows = Object.entries(entries).map(([name, token]) => {
    const property = cssName(group, name);
    const chip = colorValue.test(token.value.trim()) ? `<span class="chip" style="background:var(${property})"></span>` : "";
    return `      <tr><td><code>${escapeHtml(`${group}.${name}`)}</code></td><td><code>${property}</code></td><td>${chip}<code>${escapeHtml(token.value)}</code></td>${described ? `<td>${escapeHtml(token.description || "")}</td>` : ""}</tr>`;
  });
  return [
    '<table class="spec">',
    `      <thead><tr><th>Token</th><th>Custom property</th><th>Value</th>${described ? "<th>Use</th>" : ""}</tr></thead>`,
    "      <tbody>",
    ...rows,
    "      </tbody>",
    "    </table>",
  ].join("\n");
}

function formatLength(value, unit) {
  return unit === "in" ? `${value}″` : `${value} px`;
}

function formatWeight(kilobytes) {
  if (kilobytes === undefined) return "";
  return kilobytes >= 1024 ? `${Math.round(kilobytes / 1024)} MB` : `${kilobytes} KB`;
}

function renderFormatTable(formats, group, file) {
  const entry = formats.groups.get(group);
  if (!entry) throw new Error(`src/pages/${file} uses {{formats:${group}}}, but src/formats.json has no ${group} group`);
  const print = entry.unit === "in";
  const noted = entry.formats.some((format) => format.note);
  const head = print ? ["Format", "Trim", "Bleed", "Safe area", "Stock", "Page"] : ["Format", "Size", "Safe area", "File", "Max weight", "Page"];
  if (noted) head.push("Notes");
  const rows = entry.formats.map((format) => {
    // A planned page is named, never linked, the same as in the sitemap.
    const page = format.page.planned
      ? `${escapeHtml(format.page.title)} <span class="tag">Planned</span>`
      : `<a href="${format.page.href}">${escapeHtml(format.page.title)}</a>`;
    const size = `<span style="white-space:nowrap">${print ? `${format.width}″ × ${format.height}″` : `${format.width} × ${format.height} px`}</span>`;
    const cells = print
      ? [`<strong>${escapeHtml(format.name)}</strong>`, size, formatLength(format.bleed ?? 0, "in"), formatLength(format.safe, "in"), escapeHtml(format.stock || ""), page]
      : [`<strong>${escapeHtml(format.name)}</strong>`, size, formatLength(format.safe, "px"), escapeHtml(format.file || ""), formatWeight(format.maxKB), page];
    if (noted) cells.push(escapeHtml(format.note || ""));
    return `      <tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
  });
  return [
    '<table class="spec">',
    `      <thead><tr>${head.map((column) => `<th>${column}</th>`).join("")}</tr></thead>`,
    "      <tbody>",
    ...rows,
    "      </tbody>",
    "    </table>",
  ].join("\n");
}

/** The custom properties a preview reads (src/styles/canvas.css), for a .canvas-frame's style attribute. */
function canvasVars(formats, id, file) {
  const format = formats.byId.get(id);
  if (!format) throw new Error(`src/pages/${file} uses {{canvas:${id}}}, but src/formats.json declares no format ${id}`);
  const ui = format.ui || {};
  const clear = format.keepClear || {};
  return [
    `--cw:${format.width}`, `--ch:${format.height}`, `--safe:${format.safe}`, `--bleed:${format.bleed ?? 0}`,
    `--ui-t:${ui.top ?? 0}`, `--ui-b:${ui.bottom ?? 0}`, `--ui-l:${ui.left ?? 0}`, `--ui-r:${ui.right ?? 0}`,
    `--clear-l:${clear.left ?? 0}`, `--clear-r:${clear.right ?? 0}`,
  ].join(";");
}

/**
 * The composer's preset cards for one format group: every format the catalog
 * declares, each a radio with its name and size and a thumbnail drawn at the
 * format's proportion from the same custom properties a preview reads. The
 * first preset a page renders is checked, so the composer opens on it.
 */
function renderPresets(formats, group, file, state) {
  const entry = formats.groups.get(group);
  if (!entry) throw new Error(`src/pages/${file} uses {{presets:${group}}}, but src/formats.json has no ${group} group`);
  const print = entry.unit === "in";
  const prompt = print ? "What is it for, and who will hold it?" : "What is it about?";
  return entry.formats.map((format) => {
    const checked = state.checked ? "" : " checked";
    state.checked = true;
    const size = print ? `${format.width} × ${format.height} in` : `${format.width} × ${format.height}`;
    return [
      '        <label class="preset">',
      `          <input type="radio" name="preset" value="${escapeHtml(format.id)}" data-name="${escapeHtml(format.name)}" data-unit="${entry.unit}" data-prompt="${prompt}"${checked}>`,
      `          <span class="preset__thumb" style="${canvasVars(formats, format.id, file)}"><span class="preset__shape${print ? " preset__shape--paper" : ""}"></span></span>`,
      `          <b>${escapeHtml(format.name)}</b><small>${size}</small>`,
      "        </label>",
    ].join("\n");
  }).join("\n");
}

/** A count a page states in prose, so a number never goes stale: the formats, views, pages, or designs the system declares. */
function countOf(what, { formats, model, authored, designs }, file) {
  const counts = { formats: formats.byId.size, views: model.views.length, pages: authored.length, designs: designs.length };
  if (!(what in counts)) throw new Error(`src/pages/${file} uses {{count:${what}}}; count one of ${Object.keys(counts).join(", ")}`);
  return String(counts[what]);
}

function pageHref(model, id, file) {
  const page = model.pages.find((candidate) => candidate.id === id);
  if (!page) throw new Error(`src/pages/${file} uses {{page:${id}}}, but src/site.json declares no page ${id}`);
  if (page.planned) throw new Error(`src/pages/${file} uses {{page:${id}}}, but that page is planned; author it or link another page`);
  return page.href;
}

/**
 * The page's address, or the nearest authored one when it is planned: the
 * first authored page of its view, else the overview. A front page the toolkit
 * writes links the client's pages this way, so it builds on a system that has
 * not authored them yet and the link improves as the system fills in.
 */
function nearestHref(model, id, file) {
  const page = model.pages.find((candidate) => candidate.id === id);
  if (!page) throw new Error(`src/pages/${file} uses {{nearest:${id}}}, but src/site.json declares no page ${id}`);
  if (!page.planned) return page.href;
  const view = model.views.find((candidate) => candidate.id === page.view);
  return (view && firstAuthored(view))?.href || model.home.href;
}

function renderSitemap(model, designs) {
  const rows = model.views.flatMap((view) => view.pages.map((page) => {
    const name = page.planned ? escapeHtml(page.title) : `<a href="${page.href}">${escapeHtml(page.title)}</a>`;
    const status = page.planned ? '<span class="tag">Planned</span>' : "Authored";
    return `      <tr><td>${name}</td><td>${escapeHtml(view.label)}</td><td>${escapeHtml(page.summary)}</td><td>${status}</td></tr>`;
  }));
  for (const design of designs) {
    rows.push(`      <tr><td><a href="${design.href}">${escapeHtml(design.title)}</a></td><td>Designs</td><td>${escapeHtml(design.summary)}</td><td>${design.pages} page${design.pages === 1 ? "" : "s"}</td></tr>`);
  }
  return [
    '<table class="spec">',
    "      <thead><tr><th>Page</th><th>View</th><th>What it owns</th><th>Status</th></tr></thead>",
    "      <tbody>",
    ...rows,
    "      </tbody>",
    "    </table>",
  ].join("\n");
}

function firstAuthored(view) {
  return view.pages.find((page) => !page.planned) || null;
}

/** The entries the viewer adds to the app bar itself; a view labelled the same reads as a second tab of that name. */
export const viewerAppBarEntries = Object.freeze([{ label: "Designs", href: "/designs/" }]);

function renderViews(model, current, designs, hasDesigns = designs.length > 0) {
  const views = model.views.map((view) => {
    const target = firstAuthored(view);
    const label = `<b>${escapeHtml(view.label)}</b>${view.blurb ? `<small>${escapeHtml(view.blurb)}</small>` : ""}`;
    if (!target) return `<span class="appbar__view is-planned">${label}</span>`;
    return `<a class="appbar__view" href="${target.href}"${view.id === current.view ? ' aria-current="true"' : ""}>${label}</a>`;
  });
  if (hasDesigns) views.push(`<a class="appbar__view" href="${viewerAppBarEntries[0].href}"><b>${viewerAppBarEntries[0].label}</b><small>Whole pages</small></a>`);
  for (const page of model.pages) {
    if (page.promote && !page.planned) views.push(`<a class="appbar__cta" href="${page.href}"${page.id === current.id ? ' aria-current="page"' : ""}>${escapeHtml(page.promote)}</a>`);
  }
  // On a phone the row scrolls sideways, so the current view is brought into view rather than left past the edge.
  views.push('<script>document.querySelector(".appbar__view[aria-current]")?.scrollIntoView({ block: "nearest", inline: "center" });</script>');
  return views.join("\n        ");
}

function renderSidenav(model, current) {
  // A view page lists its own view; the overview lists every view.
  const views = current.view ? model.views.filter((view) => view.id === current.view) : model.views;
  const lines = [];
  for (const view of views) {
    let group = current.view ? "" : view.label;
    if (group) lines.push(`<div class="sidenav__group">${escapeHtml(group)}</div>`);
    for (const page of view.pages) {
      if (current.view && page.group && page.group !== group) {
        group = page.group;
        lines.push(`<div class="sidenav__group">${escapeHtml(group)}</div>`);
      }
      lines.push(page.planned
        ? `<span class="sidenav__planned">${escapeHtml(page.title)} <small>Planned</small></span>`
        : `<a href="${page.href}"${page.id === current.id ? ' aria-current="page"' : ""}>${escapeHtml(page.title)}</a>`);
    }
  }
  return lines.join("\n        ");
}

// Progressive enhancement every page gets: [data-root], [data-root-bare],
// [data-origin] and [data-system-id] are filled with this system's own
// published address and id (the app bar's brand link is that address whatever
// the page is served from: the dev server, the host's canonical path, or a
// per-system hostname; the id comes from the derived layer); [data-tabs]
// becomes a tablist of its .tabs__panel children; pre[data-copy] gets a copy
// button. Accent previews with data-logo="auto" select the logo variant from
// their computed text ink; CSS keeps a primary logo on a plate until then.
// Without the script every panel shows under its own label and every
// snippet reads as written, so nothing a page says depends on it.
const enhancements = `<script>
(() => {
  const brand = document.querySelector(".appbar__brand");
  const root = new URL(brand ? brand.getAttribute("href") : "/", location.href);
  for (const node of document.querySelectorAll("[data-root]")) node.textContent = root.href;
  for (const node of document.querySelectorAll("[data-root-bare]")) node.textContent = root.href.replace(/\\/$/, "");
  for (const node of document.querySelectorAll("[data-origin]")) node.textContent = root.origin;
  if (document.querySelector("[data-system-id]")) {
    fetch(new URL("index.json", root)).then((response) => (response.ok ? response.json() : null)).then((index) => {
      const id = index && index.system && index.system.id;
      if (id) for (const node of document.querySelectorAll("[data-system-id]")) node.textContent = id;
    }).catch(() => {});
  }
  const autoLogos = [...document.querySelectorAll('.canvas--accent[data-logo="auto"]')];
  if (autoLogos.length) {
    for (const node of autoLogos) node.setAttribute("data-logo-auto", "");
    const sample = document.createElement("canvas");
    sample.width = sample.height = 1;
    const context = sample.getContext("2d", { willReadFrequently: true });
    const selectLogos = () => {
      if (!context) return;
      for (const node of autoLogos) {
        // Canvas normalizes any computed CSS color space to sRGB bytes.
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = getComputedStyle(node).color;
        context.fillRect(0, 0, 1, 1);
        const channels = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3)
          .map(value => value / 255)
          .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
        const lightness = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
        node.dataset.logo = lightness > 0.179 ? "dark" : "light";
      }
    };
    selectLogos();
    // Re-read the rendered ink after a color-scheme media change settles.
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      requestAnimationFrame(() => requestAnimationFrame(selectLogos));
    });
  }
  for (const tabs of document.querySelectorAll("[data-tabs]")) {
    const panels = [...tabs.querySelectorAll(":scope > .tabs__panel")];
    if (panels.length < 2) continue;
    const list = document.createElement("div");
    list.className = "tabs__list";
    list.setAttribute("role", "tablist");
    if (tabs.getAttribute("aria-label")) list.setAttribute("aria-label", tabs.getAttribute("aria-label"));
    const select = (active) => panels.forEach((panel, index) => {
      panel.hidden = index !== active;
      list.children[index].setAttribute("aria-selected", String(index === active));
      list.children[index].tabIndex = index === active ? 0 : -1;
    });
    panels.forEach((panel, index) => {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "tabs__tab";
      tab.setAttribute("role", "tab");
      tab.textContent = panel.dataset.tab || \`Option \${index + 1}\`;
      if (!panel.id) panel.id = \`\${tabs.closest("section")?.id || "tabs"}-\${index + 1}\`;
      tab.setAttribute("aria-controls", panel.id);
      panel.setAttribute("role", "tabpanel");
      tab.addEventListener("click", () => select(index));
      tab.addEventListener("keydown", (event) => {
        const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        if (!delta) return;
        event.preventDefault();
        const next = (index + delta + panels.length) % panels.length;
        select(next);
        list.children[next].focus();
      });
      list.append(tab);
    });
    tabs.prepend(list);
    tabs.classList.add("is-enhanced");
    select(0);
  }
  for (const landing of document.querySelectorAll(".landing")) {
    const items = [...landing.querySelectorAll("[data-reveal]")];
    if (!items.length || !("IntersectionObserver" in window) || matchMedia("(prefers-reduced-motion: reduce)").matches) continue;
    landing.classList.add("is-enhanced");
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-in");
        observer.unobserve(entry.target);
      }
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.1 });
    for (const item of items) observer.observe(item);
  }
  for (const pre of document.querySelectorAll("pre[data-copy]")) {
    const snippet = document.createElement("div");
    snippet.className = "snippet";
    const bar = document.createElement("div");
    bar.className = "snippet__bar";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "copy";
    button.textContent = "Copy";
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(pre.textContent.trim());
        button.textContent = "Copied";
      } catch {
        button.textContent = "Select and copy";
      }
      setTimeout(() => { button.textContent = "Copy"; }, 1600);
    });
    bar.append(button);
    pre.replaceWith(snippet);
    snippet.append(bar, pre);
  }
})();
</script>`;

function renderPagenav(authored, current) {
  const index = authored.indexOf(current);
  const previous = authored[index - 1];
  const next = authored[index + 1];
  return [
    '<nav class="pagenav" aria-label="Previous and next page">',
    previous ? `          <a href="${previous.href}">← ${escapeHtml(previous.title)}</a>` : "          <span></span>",
    next ? `          <a href="${next.href}">${escapeHtml(next.title)} →</a>` : "          <span></span>",
    "        </nav>",
  ].join("\n");
}

// Agents are sent to the site as often as to llms.txt, so every rendered page
// says where the agent-readable layer is: a comment and links in the head for
// a reader of the raw HTML, and one visible line at the end of the body for a
// reader of the extracted text, which drops the head. The line sits outside
// <main>, so the Markdown mirrors TimDS harvests from it stay free of it. The
// viewer adds both itself, so a client's layout needs no placeholder.
const agentPointers = {
  head: [
    "<!-- AI agents: this design system's entry point is /llms.txt (how to use it, the brand essentials, then every page with a link to its Markdown). This page as Markdown: index.md beside it. Every page in one file: /llms-full.txt. -->",
    '<link rel="llms-txt" type="text/plain" href="/llms.txt">',
    '<link rel="alternate" type="text/markdown" href="index.md" title="This page as Markdown">',
  ],
  body: '<p class="agents">AI agents: start at <a href="/llms.txt">/llms.txt</a>. This page as Markdown: <a href="index.md">index.md</a>.</p>',
};

function withAgentPointers(html) {
  const head = /[ \t]*<\/head>/i;
  const body = /[ \t]*<\/body>/i;
  if (!head.test(html) || !body.test(html)) throw new Error("src/layout.html must contain </head> and </body>");
  return html
    .replace(head, `${agentPointers.head.map((line) => `    ${line}`).join("\n")}\n  </head>`)
    .replace(body, `    ${agentPointers.body}\n  </body>`);
}

function fill(template, file, values) {
  return template.replace(placeholder, (match, name, argument) => {
    const value = values[name];
    if (value === undefined) throw new Error(`${file} uses the unknown placeholder ${match}`);
    return typeof value === "function" ? value(argument) : value;
  });
}

/**
 * Render every authored page in memory. Throws on anything that would ship a
 * broken viewer: a page without a source file, a source file the navigation
 * does not declare, an unknown placeholder, a format without its page, or a
 * fragment without one <h1>.
 */
export async function renderSite(designSystemRoot) {
  const { root, source } = folders(designSystemRoot);
  const readJson = (file) => readRootJson(root, file);
  const manifest = await readJson("timds.json");
  // Group maps are canonical on upgraded systems. Whole-file views remain
  // available to custom builds and are generated by the toolkit boundary.
  let tokens;
  try {
    await readJson(".timds/contract-layout.json");
    tokens = {};
    async function readGroups(directory, prefix = "") {
      for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
        if (entry.isDirectory()) await readGroups(`${directory}/${entry.name}`, `${prefix}${entry.name}.`);
        else if (entry.isFile() && entry.name.endsWith(".json")) tokens[`${prefix}${entry.name.slice(0, -5)}`] = await readJson(`${directory}/${entry.name}`);
        else throw new Error(`Invalid token group file ${entry.name}`);
      }
    }
    await readGroups("tokens");
  } catch (error) {
    if (!error.message.includes("contract-layout.json")) throw error;
    tokens = await readJson("tokens.json");
  }
  const compiled = compileTokens(tokens);
  const model = readSiteModel(await readJson("src/site.json"));
  const formats = readFormats(existsSync(path.join(source, "formats.json")) ? await readJson("src/formats.json") : null, model);
  const designs = await designList({ root, source });
  const data = await readSlotData({ root, source });
  const fallbacks = new Set();
  const slotValues = slotRenderers(data, tokens, fallbacks);
  const warnings = [];
  const starter = existsSync(path.join(root, ".timds/starter.json")) ? await readJson(".timds/starter.json") : null;
  if (starter?.starter === "brand-kit" && (!data.copy.voice?.trim() || data.copy.voice === brandKitCopySamples.voice)) warnings.push("Brand kit voice is assumed; replace copy.voice with evidence-backed guidance before publishing.");
  // Structure offshoots omit authored design source, including an empty
  // directory's marker. The selected kit still reserves its Designs section.
  const hasDesigns = starter?.starter === "brand-kit" || existsSync(path.join(source, "designs"));
  // TimDS builds the designs to dist/designs/, so no view may claim that path.
  if (hasDesigns && model.views.some((view) => view.id === "designs")) throw new Error("src/site.json may not declare a view named designs while src/designs/ exists or the brand-kit starter reserves that route; the designs are built there");
  const layout = await readFile(path.join(source, "layout.html"), "utf8");
  if (!/\{\{\s*content\s*\}\}/.test(layout)) throw new Error("src/layout.html must contain {{content}}");

  const files = await pageFiles(path.join(source, "pages"));
  for (const page of model.pages) {
    const exists = files.includes(page.file);
    if (page.planned && exists) throw new Error(`src/pages/${page.file} exists, so remove "planned": true from ${page.id} in src/site.json`);
    if (!page.planned && !exists) throw new Error(`src/site.json declares ${page.id}, but src/pages/${page.file} is missing; author it or mark the page "planned": true`);
  }
  for (const file of files) {
    if (!model.pages.some((page) => page.file === file)) throw new Error(`src/pages/${file} is not declared in src/site.json; add it to a view so the navigation reaches it`);
  }

  const shared = {
    name: escapeHtml(manifest.name || "Design System"),
    description: escapeHtml(manifest.description || "Repository-owned visual and interface standards."),
    version: escapeHtml(manifest.version || "0.1.0"),
  };
  const authored = model.pages.filter((page) => !page.planned);
  const rendered = new Map();

  for (const page of authored) {
    const file = `src/pages/${page.file}`;
    const fragment = await readFile(path.join(source, "pages", page.file), "utf8");
    if ((fragment.match(/<h1[\s>]/gi) || []).length !== 1) throw new Error(`${file} must contain exactly one <h1>`);
    const presetState = { checked: false };
    const content = mergeSlotTables(fill(fragment, file, {
      ...shared,
      ...slotValues,
      canvas: (id) => canvasVars(formats, id, page.file),
      count: (what) => countOf(what, { formats, model, authored, designs }, page.file),
      formats: (group) => renderFormatTable(formats, group, page.file),
      presets: (group) => renderPresets(formats, group, page.file, presetState),
      // {{page:ID}} is a page's address (overview, use, use/install, ...), so a
      // fragment the toolkit refreshes links the same page whether or not the
      // system moved it to the front.
      page: (id) => pageHref(model, id, page.file),
      nearest: (id) => nearestHref(model, id, page.file),
      sitemap: () => renderSitemap(model, designs),
      tokens: (group) => renderTokenTable(tokens, group, page.file),
    }));
    // A landing page stands alone in the shell: the side navigation and the
    // previous/next links are left out, and the content is wrapped so the
    // chrome's stylesheet can widen the content column for it.
    const landing = page.layout === "landing";
    rendered.set(page.output, withAgentPointers(fill(layout, "src/layout.html", {
      ...shared,
      title: escapeHtml(page.title),
      views: renderViews(model, page, designs, hasDesigns),
      sidenav: landing ? "" : renderSidenav(model, page),
      pagenav: `${landing ? "" : renderPagenav(authored, page)}\n        ${enhancements}`,
      content: landing ? `<div class="landing">\n${content.trim()}\n</div>` : content.trim(),
    })));
  }

  return {
    designs,
    fallbacks: [...fallbacks].sort(),
    warnings,
    files: rendered,
    formatCount: formats.byId.size,
    formatGroups: formats.groups.size,
    pages: authored.length,
    planned: model.pages.filter((page) => page.planned).map((page) => page.id),
    tokens,
    tokenCss: compiled.css,
    tokenCount: compiled.count,
    tokenGroups: compiled.groups,
  };
}

/** Colors live in tokens.json; a literal in a stylesheet would escape every retheme. */
export async function colorLiterals(designSystemRoot) {
  const directory = path.join(folders(designSystemRoot).source, "styles");
  const found = [];
  if (!existsSync(directory)) return found;
  for (const name of (await readdir(directory)).filter((entry) => entry.endsWith(".css")).sort()) {
    const css = (await readFile(path.join(directory, name), "utf8")).replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
    // A declaration ends at ";" or "}"; a selector such as "a:hover #add" ends at "{" and is skipped.
    for (const declaration of css.matchAll(/(?:^|[{};])\s*[-\w]+\s*:([^;{}]+)(?=[;}]|$)/g)) {
      if (!colorLiteral.test(declaration[1])) continue;
      const line = css.slice(0, declaration.index + declaration[0].length).split("\n").length;
      found.push(`src/styles/${name}:${line}`);
    }
  }
  return found;
}

/**
 * Render the viewer into dist/: every authored page, the copied source
 * folders, tokens.css and tokens.json. The first step of the stock build.
 */
export async function buildViewer(designSystemRoot) {
  const { root, source, destination } = folders(designSystemRoot);
  const site = await renderSite(root);

  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const directory of copiedDirectories) {
    if (existsSync(path.join(source, directory))) await cp(path.join(source, directory), path.join(destination, directory), { recursive: true });
  }
  for (const [output, html] of site.files) {
    await mkdir(path.dirname(path.join(destination, output)), { recursive: true });
    await writeFile(path.join(destination, output), html, "utf8");
  }
  if (existsSync(path.join(root, "_headers"))) await cp(path.join(root, "_headers"), path.join(destination, "_headers"));
  await writeFile(path.join(destination, "tokens.css"), site.tokenCss, "utf8");
  await writeFile(path.join(destination, "tokens.json"), `${JSON.stringify(site.tokens, null, 2)}\n`, "utf8");

  console.log(`Built starter viewer with ${site.pages} pages and ${site.tokenCount} tokens`);
  if (site.fallbacks.length) console.log(`Stock samples used for unfilled slots: ${site.fallbacks.join(", ")}`);
  for (const warning of site.warnings) console.warn(`Warning: ${warning}`);
  return site;
}

/**
 * `workspace.after` in timds.json: the system's own steps after the stock
 * build, as `{ build: [argv, ...] }`. Commands only, never a module the
 * build imports, so a system's extra step never couples it to renderer
 * internals. Returns `{ build: [] }` when absent; throws on any other shape.
 */
export function normalizeWorkspaceAfter(value) {
  if (value === undefined || value === null) return { build: [] };
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("timds.json workspace.after must be an object such as { \"build\": [[\"node\", \"scripts/extra.mjs\"]] }");
  const unknown = Object.keys(value).filter((key) => key !== "build");
  if (unknown.length) throw new Error(`timds.json workspace.after supports only build; remove ${unknown.join(", ")}`);
  const commands = value.build ?? [];
  if (!Array.isArray(commands) || commands.some((command) => !Array.isArray(command) || !command.length || command.some((part) => typeof part !== "string" || !part.trim()))) {
    throw new Error("timds.json workspace.after.build must be a list of commands, each a non-empty string array such as [\"node\", \"scripts/extra.mjs\"]");
  }
  return { build: commands.map((command) => command.map((part) => part.trim())) };
}

// `timds-cli run FILE` runs FILE on the executable's own Node, the way the
// stock workspace commands do in binary mode; anything else runs as written.
async function afterCommand(command) {
  if (command[0] !== "timds-cli" || command[1] !== "run") return command;
  const { javascriptCommand } = await import("./executable.mjs");
  return javascriptCommand(command.slice(2));
}

/** Run timds.json workspace.after.build in order from the root; a non-zero exit fails the build. */
export async function runAfterBuild(designSystemRoot) {
  const { root } = folders(designSystemRoot);
  const manifest = await readRootJson(root, "timds.json");
  const { build: commands } = normalizeWorkspaceAfter(manifest.workspace?.after);
  for (const command of commands) {
    console.log(`Running after build: ${command.join(" ")}`);
    const [file, ...args] = await afterCommand(command);
    const code = await new Promise((resolve, reject) => {
      const child = spawn(file, args, { cwd: root, env: process.env, shell: false, stdio: "inherit" });
      child.on("error", (error) => reject(error.code === "ENOENT" ? new Error(`timds.json workspace.after.build names ${JSON.stringify(file)}, which is not available`) : error));
      child.on("close", (exit, signal) => resolve(signal ? signal : exit));
    });
    if (code !== 0) throw new Error(`timds.json workspace.after.build command ${JSON.stringify(command.join(" "))} failed with ${typeof code === "string" ? code : `exit code ${code}`}`);
  }
  return commands.length;
}

/**
 * The stock build: the viewer, then the website designs under src/designs/
 * and the changelog page, then the system's own `workspace.after.build`
 * commands. `timds check` builds the designs and changelog again itself.
 */
export async function build(designSystemRoot) {
  const { root } = folders(designSystemRoot);
  await buildViewer(root);
  const { buildDesigns } = await import("./designs.mjs");
  const { pageCount, stateCount } = await buildDesigns(root);
  if (pageCount) console.log(`Built ${pageCount} design page${pageCount === 1 ? "" : "s"} (${stateCount} state${stateCount === 1 ? "" : "s"}) under dist/designs/`);
  const { buildChangelog } = await import("./changelog.mjs");
  const { releaseCount } = await buildChangelog(root);
  if (releaseCount) console.log(`Built the changelog with ${releaseCount} release${releaseCount === 1 ? "" : "s"} under dist/changelog/`);
  await runAfterBuild(root);
}

/** The stock check: render every page in memory and refuse color literals outside tokens. */
export async function check(designSystemRoot) {
  const { root } = folders(designSystemRoot);
  const site = await renderSite(root);

  const literals = await colorLiterals(root);
  if (literals.length) {
    throw new Error(`Color literals belong in tokens.json; add a token and use its custom property instead (${literals.join(", ")})`);
  }

  console.log(`Validated ${site.tokenGroups} token groups, ${site.formatCount} formats, and ${site.pages} authored pages`);
  if (site.fallbacks.length) console.log(`Stock samples used for unfilled slots: ${site.fallbacks.join(", ")}`);
  for (const warning of site.warnings) console.warn(`Warning: ${warning}`);
  if (site.planned.length) console.log(`Planned pages not yet authored: ${site.planned.join(", ")}`);
  return site;
}

const contentTypes = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

/**
 * The stock dev server: build once, then serve dist/ on 127.0.0.1 (PORT, else
 * 4321). It does not watch files; rerun it after a change. Resolves with the
 * listening server.
 */
export async function dev(designSystemRoot, { port = Number(process.env.PORT || 4321) } = {}) {
  const { root, destination } = folders(designSystemRoot);
  await build(root);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://localhost");
      const pathname = decodeURIComponent(url.pathname);
      // Pages are directories: /brand/color and /brand/color/ both serve its index.html.
      const requested = pathname.endsWith("/") ? `${pathname}index.html` : path.extname(pathname) ? pathname : `${pathname}/index.html`;
      const filePath = path.resolve(destination, `.${requested}`);

      if (!filePath.startsWith(`${destination}${path.sep}`)) {
        response.writeHead(403).end("Forbidden");
        return;
      }

      await access(filePath);
      const details = await stat(filePath);
      if (!details.isFile()) throw new Error("Not a file");
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream"
      });
      createReadStream(filePath).pipe(response);
    } catch {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
    }
  });

  server.on("error", (error) => {
    if (error.code !== "EADDRINUSE") throw error;
    console.error(`Starter viewer port ${port} is already in use. Run timds dev --port ${port < 65535 ? port + 1 : 4321}.`);
    process.exitCode = 1;
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`Starter viewer: http://127.0.0.1:${port}`);
  });
  return server;
}

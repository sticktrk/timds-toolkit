// Starter viewer renderer shared by build.mjs and check.mjs.
//
// src/site.json declares the views and their pages, src/layout.html is the
// shell every page shares, and src/pages/ holds one content fragment per
// authored page. Rendering fills the shell's navigation from the site model
// and each fragment's token tables from tokens.json, so a page never restates
// a value and the navigation never drifts from the pages that exist.
//
// src/formats.json is the catalog of every asset format the system produces
// (print sheets in inches, screen canvases in pixels), each tied to the page
// that shows it. {{formats:GROUP}} renders a group's table and {{canvas:ID}}
// fills a preview's style attribute (src/styles/canvas.css), so a size lives
// in exactly one place.
//
// Website designs under src/designs/ are whole pages on the system's own
// stylesheets, rendered by TimDS (see build.mjs). The viewer only lists them:
// the app bar links /designs/ and the overview's sitemap names each one.
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "src");
const destination = path.join(root, "dist");
const copiedDirectories = ["assets", "styles"];
const placeholder = /\{\{\s*([a-z]+)(?::([a-z0-9-]+))?\s*\}\}/g;
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

async function readJson(file) {
  try {
    return JSON.parse(await readFile(path.join(root, file), "utf8"));
  } catch (error) {
    throw new Error(`${file} could not be read as JSON: ${error.message}`);
  }
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
      declarations.push(`  ${cssName(group, name)}: ${token.value};`);
    }
  }

  return { count: declarations.length, css: `:root {\n${declarations.sort().join("\n")}\n}\n`, groups: groups.length };
}

/** The site model: every declared page in navigation order, the overview first. */
function readSiteModel(site) {
  if (!Array.isArray(site.views) || !site.views.length) throw new Error("src/site.json must declare at least one view");
  const home = { id: "index", view: null, title: "Overview", file: "index.html", href: "/", output: "index.html", planned: false };
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
      if (pages.some((existing) => existing.id === id)) throw new Error(`src/site.json declares the page ${id} twice`);
      const entry = {
        id,
        view: view.id,
        title: page.title,
        group: page.group || "",
        summary: page.summary || "",
        planned: page.planned === true,
        file: slug ? `${id}.html` : `${view.id}/index.html`,
        href: `/${id}/`,
        output: `${id}/index.html`,
      };
      pages.push(entry);
      return entry;
    });
    views.push({ id: view.id, label: view.label, blurb: view.blurb || "", pages: viewPages });
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
async function designList() {
  const directory = path.join(source, "designs");
  if (!existsSync(directory)) return [];
  const designs = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !existsSync(path.join(directory, entry.name, "design.json"))) continue;
    const design = await readJson(`src/designs/${entry.name}/design.json`);
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

async function pageFiles(directory = path.join(source, "pages"), prefix = "") {
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

function renderViews(model, current, designs) {
  const views = model.views.map((view) => {
    const target = firstAuthored(view);
    const label = `<b>${escapeHtml(view.label)}</b>${view.blurb ? `<small>${escapeHtml(view.blurb)}</small>` : ""}`;
    if (!target) return `<span class="appbar__view is-planned">${label}</span>`;
    return `<a class="appbar__view" href="${target.href}"${view.id === current.view ? ' aria-current="true"' : ""}>${label}</a>`;
  });
  if (designs.length) views.push('<a class="appbar__view" href="/designs/"><b>Designs</b><small>Whole pages</small></a>');
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
export async function renderSite() {
  const manifest = await readJson("timds.json");
  const tokens = await readJson("tokens.json");
  const compiled = compileTokens(tokens);
  const model = readSiteModel(await readJson("src/site.json"));
  const formats = readFormats(existsSync(path.join(source, "formats.json")) ? await readJson("src/formats.json") : null, model);
  const designs = await designList();
  // TimDS builds the designs to dist/designs/, so no view may claim that path.
  if (designs.length && model.views.some((view) => view.id === "designs")) throw new Error("src/site.json may not declare a view named designs while src/designs/ exists; the designs are built there");
  const layout = await readFile(path.join(source, "layout.html"), "utf8");
  if (!/\{\{\s*content\s*\}\}/.test(layout)) throw new Error("src/layout.html must contain {{content}}");

  const files = await pageFiles();
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
    const content = fill(fragment, file, {
      ...shared,
      canvas: (id) => canvasVars(formats, id, page.file),
      formats: (group) => renderFormatTable(formats, group, page.file),
      sitemap: () => renderSitemap(model, designs),
      tokens: (group) => renderTokenTable(tokens, group, page.file),
    });
    rendered.set(page.output, fill(layout, "src/layout.html", {
      ...shared,
      title: escapeHtml(page.title),
      views: renderViews(model, page, designs),
      sidenav: renderSidenav(model, page),
      pagenav: renderPagenav(authored, page),
      content: content.trim(),
    }));
  }

  return {
    designs,
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
export async function colorLiterals() {
  const directory = path.join(source, "styles");
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

export async function build() {
  const site = await renderSite();

  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const directory of copiedDirectories) {
    if (existsSync(path.join(source, directory))) await cp(path.join(source, directory), path.join(destination, directory), { recursive: true });
  }
  for (const [output, html] of site.files) {
    await mkdir(path.dirname(path.join(destination, output)), { recursive: true });
    await writeFile(path.join(destination, output), html, "utf8");
  }
  await writeFile(path.join(destination, "tokens.css"), site.tokenCss, "utf8");
  await writeFile(path.join(destination, "tokens.json"), `${JSON.stringify(site.tokens, null, 2)}\n`, "utf8");

  console.log(`Built starter viewer with ${site.pages} pages and ${site.tokenCount} tokens`);
}

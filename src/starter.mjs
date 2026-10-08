// Starter sync: the recurring migration that keeps a starter-based Design
// System on the current scaffold structure, the way a CMS update keeps its
// core files current without touching a site's own content.
//
// The starter has two layers, and the line between them is recorded in
// .timds/starter.json rather than guessed:
//
// - Plumbing the toolkit owns while it is unmodified: the viewer, build, dev,
//   and check scripts, and the viewer and canvas stylesheets. The stock hash
//   of each file is recorded when it is written. A file that still matches is
//   refreshed; a changed one is reported as customized and never replaced
//   without --force.
// - Structure catalogs the client extends: the views and pages in
//   src/site.json and the asset formats in src/formats.json. The record keeps
//   the stock catalogs the system was last synced against, and each sync is a
//   three-way merge against them: entries the client lacks are appended
//   (pages as planned), entries still equal to the old baseline advance to
//   the new one, and anything the client changed is kept and reported.
//   Nothing is removed, reordered, or retitled.
// - Authored fragments the starter mirrors from the golden system (the
//   Digital, Social, and Print overviews) are written when the sync adds
//   their page and refreshed only while they still match what the toolkit
//   wrote. Every other fragment, tokens.json, the system stylesheet, and the
//   layout shell are the client's; the layout only gains a missing
//   stylesheet link.
//
// A system scaffolded before the record existed is bootstrapped from the stock
// versions earlier releases shipped: `legacyStarterFileHashes` below and the
// catalog snapshots under templates/starter-history/. `init` writes the
// record for a fresh scaffold, `timds starter sync` adopts an existing system,
// and `upgrade` runs the sync on every adopted system from then on. The sync
// ends with the workspace check and rolls back everything it wrote when that
// check fails, so it never leaves a system broken.
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const templatesRoot = fileURLToPath(new URL("../templates/", import.meta.url));

export const STARTER_RECORD_FILE = ".timds/starter.json";
export const STARTER_SITE_FILE = "src/site.json";
export const STARTER_FORMATS_FILE = "src/formats.json";
export const STARTER_LAYOUT_FILE = "src/layout.html";

/** Plumbing the sync replaces by hash: [design-system path, template name]. */
export const starterPlumbingFiles = Object.freeze([
  ["scripts/build.mjs", "starter/scripts/build.mjs"],
  ["scripts/check.mjs", "starter/scripts/check.mjs"],
  ["scripts/dev.mjs", "starter/scripts/dev.mjs"],
  ["scripts/viewer.mjs", "starter/scripts/viewer.mjs"],
  ["src/styles/canvas.css", "starter/src/styles/canvas.css"],
  ["src/styles/viewer.css", "starter/src/styles/viewer.css"],
]);

/**
 * Authored fragments the starter mirrors from the golden system. Each renders
 * the page its path names (src/pages/<view>/index.html is the view's own
 * page, src/pages/<view>/<slug>.html the page <view>/<slug>). A fragment is
 * written when the sync adds its page and refreshed while it is unmodified.
 */
export const starterManagedFragments = Object.freeze([
  ["src/pages/digital/index.html", "starter/src/pages/digital/index.html"],
  ["src/pages/print/index.html", "starter/src/pages/print/index.html"],
  ["src/pages/social/index.html", "starter/src/pages/social/index.html"],
]);

/** The stylesheet links the sync adds to a layout that lacks them. */
const starterLayoutStylesheets = Object.freeze(["/styles/canvas.css", "/styles/viewer.css"]);

/**
 * sha256 of every stock version a managed file shipped with before the record
 * existed. Once a system has a record, the hash the toolkit last wrote is
 * known from it; this table only recognizes systems scaffolded earlier, so it
 * never needs to grow for a change made after the record was introduced.
 */
export const legacyStarterFileHashes = new Map([
  ["scripts/build.mjs", [
    "9fcddb635f5738f2e722e711483bbde182518e68a2ab6da97b097aaf567b2001",
    "1bac8e95f8ee166d4f7b1e5f080dd78dd056afe9f4be7967b5c8e755d71f1479",
    "de4552daa3059f6481441ef0507ed94535491dcfa8f53368704a5e89858e6419",
  ]],
  ["scripts/check.mjs", [
    "ea176b0e884fd01a8222412d52ac8dedb87bfb8921e9fd2f7b70c822832f6b55",
    "7a18bd314c23b4a9220f6a507354458d6c6dee61aa97ad5938cdda1804e3b15c",
    "dc008e0ea93a7480edd819329a057b38c9ebc692f75ba2069556723ec3c5e88c",
  ]],
  ["scripts/dev.mjs", [
    "5f44ab1709f40b2542714b1f2092c6ac535914431066c25ac8e2631aa1cb6926",
    "f870c565d4b1e45797346ce9086626f7c56ebc3a64b197cdcd230262f703e795",
    "6b8c65eef62f1a15ee3e86ca90fad1dd03fd8053fb4c2a619063733bf90a5024",
  ]],
  ["scripts/viewer.mjs", [
    "7c534a20e242f2ba51f86907233684ae3b61161d8ba1dbcc92665d379968b721",
    "673344052d11194f219bc32ba724ad4c5cd954b19ba95be684b7001774074bc9",
    "e8d44a94a49d01abbd379d98ddc224f4cba0fc3445782523550263f562e605f7",
  ]],
  ["src/styles/canvas.css", ["dd0413554f9308cf3b1c6daedfb51ebb18c464672766b815eebbe77f0c3c6d98"]],
  ["src/styles/viewer.css", ["bb9a4ff63a56bcdea1a91b7322e4b7a480c57af6597a332a774cdbe8c9d98c63"]],
]);

/** Stock catalogs earlier releases scaffolded, for a system without a record. */
const historicalSiteSnapshots = ["starter-history/site-1.json", "starter-history/site-2.json"];

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const pageId = (view, slug) => (slug ? `${view}/${slug}` : view);

export async function template(name) {
  return fs.readFile(path.join(templatesRoot, name), "utf8");
}

async function readOptional(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (caught) {
    if (caught?.code !== "ENOENT") throw caught;
    return null;
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (caught) {
    throw new Error(`${label} could not be read as JSON: ${caught.message}`);
  }
}

/**
 * Decide what to do with one toolkit-written file. `created` when absent,
 * `current` when identical to the stock text, `updated` when it matches a
 * known stock hash (or --force), otherwise `customized` and left alone. The
 * caller writes; this only plans.
 */
export async function planStockFile(target, desired, { force = false, knownHashes = [] } = {}) {
  const current = await readOptional(target);
  if (current === null) return { current, status: "created", write: true };
  if (current === desired) return { current, status: "current", write: false };
  const hash = sha256(current);
  if (knownHashes.includes(hash)) return { current, status: "updated", write: true };
  if (force) return { current, forced: true, status: "updated", write: true };
  return { current, status: "customized", write: false };
}

/** True when `value` equals the field in any baseline, both-absent included. */
function unchanged(value, baselines, pick) {
  return baselines.some((baseline) => isDeepStrictEqual(pick(baseline), value));
}

function assign(target, field, value) {
  if (value === undefined) delete target[field];
  else target[field] = value;
}

/**
 * Merge the stock site model into the client's. Views the client lacks are
 * appended with every page planned unless its fragment exists; pages a
 * declared view lacks are inserted after the last of their stock predecessors
 * the view has, planned the same way, so the client's own order never moves. A label, blurb, title, group, or summary
 * still equal to a baseline advances to the stock value; one the client
 * changed is kept and reported. `planned` is never changed on a declared page
 * except for the ids in `authoredPages`, whose fragments the caller writes.
 */
export function mergeSiteModel(current, next, baselines, { fragmentExists = () => false, authoredPages = new Set() } = {}) {
  const site = isObject(current) ? structuredClone(current) : {};
  if (!Array.isArray(site.views)) site.views = [];
  const changes = { addedPages: [], addedViews: [], advanced: [], kept: [] };
  const advanceOrKeep = (target, field, stock, candidates, label) => {
    if (isDeepStrictEqual(target[field], stock)) return;
    if (unchanged(target[field], candidates, (candidate) => candidate[field])) {
      assign(target, field, stock);
      changes.advanced.push(label);
    } else {
      changes.kept.push({ current: target[field], path: label, stock });
    }
  };
  const plannedCopy = (view, page) => {
    const copy = structuredClone(page);
    const id = pageId(view, page.slug ?? "");
    if (copy.planned !== true && !fragmentExists(id)) copy.planned = true;
    return copy;
  };

  for (const nextView of next.views) {
    const view = site.views.find((candidate) => candidate?.id === nextView.id);
    if (!view) {
      site.views.push({ ...structuredClone(nextView), pages: nextView.pages.map((page) => plannedCopy(nextView.id, page)) });
      changes.addedViews.push(nextView.id);
      continue;
    }
    const baseViews = baselines.map((baseline) => baseline?.views?.find((candidate) => candidate?.id === nextView.id)).filter(Boolean);
    for (const field of ["label", "blurb"]) advanceOrKeep(view, field, nextView[field], baseViews, `${nextView.id}.${field}`);
    if (!Array.isArray(view.pages)) view.pages = [];
    let anchor = -1;
    for (const nextPage of nextView.pages) {
      const slug = nextPage.slug ?? "";
      const id = pageId(nextView.id, slug);
      const index = view.pages.findIndex((candidate) => (candidate?.slug ?? "") === slug);
      if (index === -1) {
        view.pages.splice(anchor + 1, 0, plannedCopy(nextView.id, nextPage));
        anchor += 1;
        changes.addedPages.push(id);
        continue;
      }
      anchor = Math.max(anchor, index);
      const page = view.pages[index];
      const basePages = baseViews.map((baseView) => baseView.pages?.find((candidate) => (candidate?.slug ?? "") === slug)).filter(Boolean);
      for (const field of ["title", "group", "summary"]) advanceOrKeep(page, field, nextPage[field], basePages, `${id}.${field}`);
      if (authoredPages.has(id) && page.planned === true) {
        delete page.planned;
        changes.advanced.push(`${id}.planned`);
      }
    }
  }
  return { changes, site };
}

/** Every page id the site model declares, for the format catalog's `page` references. */
export function declaredPageIds(site) {
  const ids = new Set();
  for (const view of Array.isArray(site?.views) ? site.views : []) {
    for (const page of Array.isArray(view?.pages) ? view.pages : []) ids.add(pageId(view.id, page?.slug ?? ""));
  }
  return ids;
}

/**
 * Merge the stock format catalog into the client's. A format is added only
 * when its page is declared and its id is unused, since the viewer rejects
 * both; a field still equal to a baseline advances, a changed one is kept.
 */
export function mergeFormatCatalog(current, next, baselines, declaredPages) {
  const catalog = isObject(current) ? structuredClone(current) : {};
  const changes = { addedFormats: [], addedGroups: [], advanced: [], kept: [], skipped: [] };
  const owners = new Map();
  for (const [group, entry] of Object.entries(catalog)) {
    if (group.startsWith("$") || !isObject(entry)) continue;
    for (const id of Object.keys(isObject(entry.formats) ? entry.formats : {})) owners.set(id, group);
  }
  const advanceOrKeep = (target, field, stock, candidates, label) => {
    if (isDeepStrictEqual(target[field], stock)) return;
    if (unchanged(target[field], candidates, (candidate) => candidate?.[field])) {
      assign(target, field, stock);
      changes.advanced.push(label);
    } else {
      changes.kept.push({ current: target[field], path: label, stock });
    }
  };
  const admit = (group, id, format) => {
    if (!declaredPages.has(format?.page)) {
      changes.skipped.push({ id: `${group}.${id}`, reason: `its page ${JSON.stringify(format?.page)} is not declared in ${STARTER_SITE_FILE}` });
      return false;
    }
    if (owners.has(id)) {
      changes.skipped.push({ id: `${group}.${id}`, reason: `the id is already used by the ${owners.get(id)} group` });
      return false;
    }
    return true;
  };

  for (const [group, stock] of Object.entries(next)) {
    if (group.startsWith("$")) {
      // A catalog the sync creates starts with the stock notes; an existing
      // one keeps or advances them like any other field.
      if (!isObject(current)) catalog[group] = structuredClone(stock);
      else advanceOrKeep(catalog, group, stock, baselines, group);
      continue;
    }
    const entry = catalog[group];
    const baseGroups = baselines.map((baseline) => baseline?.[group]).filter(isObject);
    if (!isObject(entry)) {
      const formats = {};
      for (const [id, format] of Object.entries(isObject(stock.formats) ? stock.formats : {})) {
        if (!admit(group, id, format)) continue;
        formats[id] = structuredClone(format);
        owners.set(id, group);
        changes.addedFormats.push(`${group}.${id}`);
      }
      if (!Object.keys(formats).length) {
        changes.skipped.push({ id: group, reason: "none of its formats has a declared page" });
        continue;
      }
      catalog[group] = { ...structuredClone(stock), formats };
      changes.addedGroups.push(group);
      continue;
    }
    for (const field of Object.keys(stock)) {
      if (field === "formats") continue;
      advanceOrKeep(entry, field, stock[field], baseGroups, `${group}.${field}`);
    }
    if (!isObject(entry.formats)) entry.formats = {};
    for (const [id, format] of Object.entries(isObject(stock.formats) ? stock.formats : {})) {
      const existing = entry.formats[id];
      if (!isObject(existing)) {
        if (!admit(group, id, format)) continue;
        entry.formats[id] = structuredClone(format);
        owners.set(id, group);
        changes.addedFormats.push(`${group}.${id}`);
        continue;
      }
      const baseFormats = baseGroups.map((baseGroup) => baseGroup.formats?.[id]).filter(isObject);
      for (const field of Object.keys(format)) {
        if (field === "page" && !declaredPages.has(format.page)) continue;
        advanceOrKeep(existing, field, format[field], baseFormats, `${group}.${id}.${field}`);
      }
    }
  }
  return { catalog, changes };
}

/**
 * Add the stock stylesheet links a layout lacks, each on its own line beside
 * the nearest stock link the layout already has. A layout with none of the
 * neighbours is left alone and reported, since its head is not the starter's.
 */
export function insertStylesheetLinks(layout, templateLayout, hrefs = starterLayoutStylesheets) {
  const linkPattern = /<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/g;
  const stock = [...templateLayout.matchAll(linkPattern)].map((match) => ({ href: match[1], tag: match[0] }));
  const has = (lines, href) => lines.findIndex((line) => line.includes(`href="${href}"`));
  const lines = layout.split("\n");
  const inserted = [];
  const unplaced = [];
  stock.forEach(({ href, tag }, position) => {
    if (!hrefs.includes(href) || has(lines, href) !== -1) return;
    const following = stock.slice(position + 1).find((link) => has(lines, link.href) !== -1);
    const preceding = stock.slice(0, position).reverse().find((link) => has(lines, link.href) !== -1);
    const anchor = following ?? preceding;
    if (!anchor) {
      unplaced.push(href);
      return;
    }
    const index = has(lines, anchor.href);
    const indent = lines[index].match(/^\s*/)[0];
    lines.splice(following ? index : index + 1, 0, `${indent}${tag}`);
    inserted.push(href);
  });
  return { html: lines.join("\n"), inserted, unplaced };
}

// The catalogs are written in the starter's own style, one page or format per
// line, so a sync produces a reviewable diff instead of reflowing the file.
function inline(value) {
  if (Array.isArray(value)) return `[${value.map(inline).join(", ")}]`;
  if (isObject(value)) {
    const entries = Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)}: ${inline(entry)}`);
    return entries.length ? `{ ${entries.join(", ")} }` : "{}";
  }
  return JSON.stringify(value);
}

export function formatSiteJson(site) {
  const lines = ["{"];
  const keys = Object.keys(site);
  keys.forEach((key, position) => {
    const comma = position < keys.length - 1 ? "," : "";
    if (key !== "views" || !Array.isArray(site.views)) {
      lines.push(`  ${JSON.stringify(key)}: ${inline(site[key])}${comma}`);
      return;
    }
    lines.push('  "views": [');
    site.views.forEach((view, viewPosition) => {
      lines.push("    {");
      const fields = Object.keys(view);
      fields.forEach((field, fieldPosition) => {
        const fieldComma = fieldPosition < fields.length - 1 ? "," : "";
        if (field !== "pages" || !Array.isArray(view.pages)) {
          lines.push(`      ${JSON.stringify(field)}: ${inline(view[field])}${fieldComma}`);
          return;
        }
        lines.push('      "pages": [');
        view.pages.forEach((page, pagePosition) => {
          lines.push(`        ${inline(page)}${pagePosition < view.pages.length - 1 ? "," : ""}`);
        });
        lines.push(`      ]${fieldComma}`);
      });
      lines.push(`    }${viewPosition < site.views.length - 1 ? "," : ""}`);
    });
    lines.push(`  ]${comma}`);
  });
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

export function formatFormatsJson(catalog) {
  const lines = ["{"];
  const keys = Object.keys(catalog);
  keys.forEach((key, position) => {
    const comma = position < keys.length - 1 ? "," : "";
    const group = catalog[key];
    if (key.startsWith("$") || !isObject(group)) {
      lines.push(`  ${JSON.stringify(key)}: ${inline(group)}${comma}`);
      return;
    }
    lines.push(`  ${JSON.stringify(key)}: {`);
    const fields = Object.keys(group);
    fields.forEach((field, fieldPosition) => {
      const fieldComma = fieldPosition < fields.length - 1 ? "," : "";
      if (field !== "formats" || !isObject(group.formats)) {
        lines.push(`    ${JSON.stringify(field)}: ${inline(group[field])}${fieldComma}`);
        return;
      }
      lines.push('    "formats": {');
      const ids = Object.keys(group.formats);
      ids.forEach((id, idPosition) => {
        lines.push(`      ${JSON.stringify(id)}: ${inline(group.formats[id])}${idPosition < ids.length - 1 ? "," : ""}`);
      });
      lines.push(`    }${fieldComma}`);
    });
    lines.push(`  }${comma}`);
  });
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

export async function readStarterRecord(designSystemRoot) {
  const text = await readOptional(path.join(designSystemRoot, STARTER_RECORD_FILE));
  if (text === null) return null;
  const record = parseJson(text, STARTER_RECORD_FILE);
  if (!isObject(record) || !isObject(record.files) || !isObject(record.baseline)) {
    throw new Error(`${STARTER_RECORD_FILE} is not a TimDS starter record; restore it from git or delete it and rerun timds starter sync`);
  }
  return record;
}

async function writeStarterRecord(designSystemRoot, record) {
  const file = path.join(designSystemRoot, STARTER_RECORD_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return file;
}

/** The stock catalogs and file hashes of the installed toolkit's starter. */
async function stockStarter() {
  const files = {};
  for (const [relative, templateName] of [...starterPlumbingFiles, ...starterManagedFragments]) {
    files[relative] = sha256(await template(templateName));
  }
  return {
    files,
    formats: parseJson(await template("starter/src/formats.json"), "the starter formats template"),
    site: parseJson(await template("starter/src/site.json"), "the starter site template"),
  };
}

/**
 * Record a fresh scaffold as adopted: every managed file at its stock hash and
 * the stock catalogs as the baseline, so the first `upgrade` already knows
 * what the toolkit wrote.
 */
export async function recordFreshStarter(designSystemRoot, version) {
  const stock = await stockStarter();
  return writeStarterRecord(designSystemRoot, {
    baseline: { formats: stock.formats, site: stock.site },
    files: stock.files,
    schemaVersion: 1,
    version,
  });
}

/** Whether this Design System is starter-based at all: it has the starter's site model. */
export async function isStarterSystem(designSystemRoot) {
  return (await readOptional(path.join(designSystemRoot, STARTER_SITE_FILE))) !== null;
}

/**
 * Bring a starter-based Design System up to the installed toolkit's scaffold.
 * Plans every change first, writes them together, records what it wrote, and
 * runs `check`; if the check fails, every file is restored and the error says
 * what failed, so the system is never left between two structures.
 */
export async function syncStarter({ designSystemRoot, version, check = null, force = false }) {
  const resolve = (relative) => path.join(designSystemRoot, ...relative.split("/"));
  const siteText = await readOptional(resolve(STARTER_SITE_FILE));
  if (siteText === null) {
    throw new Error(`${designSystemRoot} has no ${STARTER_SITE_FILE}, so it is not a starter-based Design System; starter sync only applies to systems scaffolded by timds init`);
  }
  const record = await readStarterRecord(designSystemRoot);
  const stock = await stockStarter();
  const files = [];
  const writes = [];
  const recordedFiles = {};
  const knownHashes = (relative) => [...(legacyStarterFileHashes.get(relative) ?? []), ...(record?.files?.[relative] ? [record.files[relative]] : [])];
  const plan = (relative, status, content, current, note) => {
    files.push(note ? { note, path: relative, status } : { path: relative, status });
    if (content !== null && content !== undefined && content !== current) writes.push({ content, current, file: resolve(relative), relative });
  };

  // 1. Plumbing, by hash.
  for (const [relative, templateName] of starterPlumbingFiles) {
    const desired = await template(templateName);
    const planned = await planStockFile(resolve(relative), desired, { force, knownHashes: knownHashes(relative) });
    if (planned.status !== "customized") recordedFiles[relative] = stock.files[relative];
    plan(relative, planned.status, planned.write ? desired : null, planned.current, planned.forced ? "replaced with --force" : undefined);
  }

  // 2. The catalogs. The site model is merged first because formats and
  //    fragments both refer to its pages.
  const currentSite = parseJson(siteText, STARTER_SITE_FILE);
  const siteBaselines = record ? [record.baseline.site] : [stock.site, ...await Promise.all(historicalSiteSnapshots.map(async (name) => parseJson(await template(name), name)))];
  const fragmentPages = new Map(starterManagedFragments.map(([relative, templateName]) => {
    const [, view, name] = relative.match(/^src\/pages\/([^/]+)\/([^/]+)\.html$/);
    return [pageId(view, name === "index" ? "" : name), { relative, templateName }];
  }));
  const declaredBefore = declaredPageIds(currentSite);
  const findPage = (site, id) => {
    for (const view of Array.isArray(site?.views) ? site.views : []) {
      const page = (Array.isArray(view?.pages) ? view.pages : []).find((candidate) => pageId(view.id, candidate?.slug ?? "") === id);
      if (page) return page;
    }
    return null;
  };
  const fragmentsToWrite = new Set();
  const authoredPages = new Set();
  const fragmentPlans = new Map();
  for (const [id, { relative, templateName }] of fragmentPages) {
    const desired = await template(templateName);
    const planned = await planStockFile(resolve(relative), desired, { force, knownHashes: knownHashes(relative) });
    if (planned.status !== "created") {
      fragmentPlans.set(relative, { desired, planned });
      continue;
    }
    // An absent fragment is written when the sync adds its page, and when the
    // page is declared but still planned: a planned page has no content to
    // lose, and the stock overview is the primitive the view starts from (the
    // client's own title and summary stay). A page the client declares as
    // authored keeps whatever fragment plans they have.
    const stockPage = findPage(stock.site, id);
    const declaredPage = findPage(currentSite, id);
    if (stockPage?.planned !== true && (!declaredBefore.has(id) || declaredPage?.planned === true)) {
      fragmentsToWrite.add(id);
      if (declaredBefore.has(id)) authoredPages.add(id);
      fragmentPlans.set(relative, { desired, planned });
    } else {
      fragmentPlans.set(relative, { desired, planned: { ...planned, status: "skipped", write: false } });
    }
  }
  const fragmentExists = (id) => {
    if (fragmentsToWrite.has(id)) return true;
    const [view, ...rest] = id.split("/");
    return existsSync(resolve(`src/pages/${view}/${rest.length ? rest.join("/") : "index"}.html`));
  };
  const merged = mergeSiteModel(currentSite, stock.site, siteBaselines, { authoredPages, fragmentExists });
  const siteChanged = !isDeepStrictEqual(merged.site, currentSite);
  const nextSiteText = formatSiteJson(merged.site);
  plan(STARTER_SITE_FILE, siteChanged ? "updated" : "current", siteChanged ? nextSiteText : null, siteText);

  const formatsText = await readOptional(resolve(STARTER_FORMATS_FILE));
  const currentFormats = formatsText === null ? null : parseJson(formatsText, STARTER_FORMATS_FILE);
  const formatBaselines = record ? [record.baseline.formats] : [stock.formats];
  const mergedFormats = mergeFormatCatalog(currentFormats, stock.formats, formatBaselines, declaredPageIds(merged.site));
  const formatsChanged = currentFormats === null || !isDeepStrictEqual(mergedFormats.catalog, currentFormats);
  plan(STARTER_FORMATS_FILE, currentFormats === null ? "created" : formatsChanged ? "updated" : "current", formatsChanged ? formatFormatsJson(mergedFormats.catalog) : null, formatsText);

  // 3. Fragments, now that the site model says which pages exist.
  for (const [relative, { desired, planned }] of fragmentPlans) {
    if (planned.status !== "customized" && planned.status !== "skipped") recordedFiles[relative] = stock.files[relative];
    const note = planned.status === "skipped"
      ? "its page is declared as authored by this system; copy the stock fragment by hand if wanted"
      : planned.forced ? "replaced with --force" : undefined;
    plan(relative, planned.status, planned.write ? desired : null, planned.current, note);
  }

  // 4. The layout shell gains the links it lacks and nothing else.
  const layoutText = await readOptional(resolve(STARTER_LAYOUT_FILE));
  if (layoutText === null) {
    plan(STARTER_LAYOUT_FILE, "skipped", null, null, "absent");
  } else {
    const { html, inserted, unplaced } = insertStylesheetLinks(layoutText, await template("starter/src/layout.html"));
    const status = inserted.length ? "updated" : unplaced.length ? "customized" : "current";
    const note = inserted.length ? `linked ${inserted.join(", ")}` : unplaced.length ? `could not place ${unplaced.join(", ")}; link it in <head> by hand` : undefined;
    plan(STARTER_LAYOUT_FILE, status, inserted.length ? html : null, layoutText, note);
  }

  // 5. Write, record, check; roll everything back when the check fails.
  const nextRecord = { baseline: { formats: stock.formats, site: stock.site }, files: recordedFiles, schemaVersion: 1, version };
  const recordPath = resolve(STARTER_RECORD_FILE);
  const previousRecordText = await readOptional(recordPath);
  const recordChanged = previousRecordText !== `${JSON.stringify(nextRecord, null, 2)}\n`;
  const report = {
    adopted: record === null,
    check: null,
    designSystemRoot,
    files,
    formats: mergedFormats.changes,
    record: recordPath,
    site: merged.changes,
    written: writes.map((write) => write.relative),
  };
  if (!writes.length && !recordChanged) return report;
  for (const write of writes) {
    await fs.mkdir(path.dirname(write.file), { recursive: true });
    await fs.writeFile(write.file, write.content, "utf8");
  }
  if (recordChanged) await writeStarterRecord(designSystemRoot, nextRecord);
  if (writes.length && check) {
    try {
      report.check = await check();
    } catch (caught) {
      for (const write of writes) {
        if (write.current === null) await fs.rm(write.file, { force: true });
        else await fs.writeFile(write.file, write.current, "utf8");
      }
      if (previousRecordText === null) await fs.rm(recordPath, { force: true });
      else await fs.writeFile(recordPath, previousRecordText, "utf8");
      const customized = files.filter((file) => file.status === "customized").map((file) => file.path);
      throw new Error(`Starter sync was rolled back because the workspace check failed afterwards: ${caught.message}${customized.length
        ? `\nCustomized files were kept (${customized.join(", ")}); the new pages may need their stock versions. Port your changes, or rerun with --force to replace them.`
        : ""}`);
    }
  }
  return report;
}

/** The per-file status table and merge summary a CLI prints for a sync report. */
export function describeStarterSync(report) {
  const lines = [];
  const width = Math.max(...report.files.map((file) => file.status.length));
  for (const file of report.files) {
    lines.push(`  ${file.status.padEnd(width)}  ${file.path}${file.note ? `  (${file.note})` : ""}`);
  }
  const { formats, site } = report;
  if (site.addedViews.length) lines.push(`Added views: ${site.addedViews.join(", ")} (every page planned until it is authored).`);
  if (site.addedPages.length) lines.push(`Added planned pages: ${site.addedPages.join(", ")}.`);
  if (site.advanced.length) lines.push(`Advanced unchanged stock fields: ${site.advanced.join(", ")}.`);
  for (const kept of site.kept) lines.push(`Kept ${kept.path} as ${JSON.stringify(kept.current)}; the scaffold now says ${JSON.stringify(kept.stock)}.`);
  if (formats.addedGroups.length) lines.push(`Added format groups: ${formats.addedGroups.join(", ")}.`);
  if (formats.addedFormats.length) {
    const groups = [...new Set(formats.addedFormats.map((id) => id.split(".")[0]))];
    lines.push(`Added formats: ${formats.addedFormats.length} in ${groups.join(", ")}.`);
  }
  if (formats.advanced.length) lines.push(`Advanced unchanged stock format fields: ${formats.advanced.join(", ")}.`);
  for (const kept of formats.kept) lines.push(`Kept format field ${kept.path} as ${JSON.stringify(kept.current)}; the scaffold now says ${JSON.stringify(kept.stock)}.`);
  for (const skipped of formats.skipped) lines.push(`Skipped format ${skipped.id}: ${skipped.reason}.`);
  if (report.check) {
    const warnings = report.check.machine?.warnings ?? [];
    lines.push(`Check passed${warnings.length ? ` with ${warnings.length} warning${warnings.length === 1 ? "" : "s"}` : ""}.`);
    for (const warning of warnings) lines.push(`Warning: ${warning}`);
  }
  return lines;
}

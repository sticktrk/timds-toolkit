// Starter sync: the recurring migration that keeps a starter-based Design
// System on the current scaffold structure and starter level, the way a CMS
// update keeps its core files current without touching a site's own content.
//
// What the toolkit may touch is recorded in .timds/starter.json rather than
// guessed:
//
// - Plumbing: the build, check and dev stubs (which call the renderer in the
//   package, @dtconcepts/timds/viewer), the browser composer script, and the
//   viewer and canvas stylesheets. Who owns a local change to them is the
//   record's `plumbing` mode. A system scaffolded by `init` is `"toolkit"`:
//   every sync brings the plumbing to stock, replacing a local change and
//   saying so. In `"recorded"` mode a file still at a hash the toolkit wrote
//   is refreshed and a changed one is reported as customized and replaced
//   only by `timds starter sync --force <path>`, never by `upgrade`. Either
//   mode is switched by editing `plumbing` in the record.
// - Structure catalogs the client extends: the views and pages in
//   src/site.json and the asset formats in src/formats.json, merged three ways
//   against the stock catalogs the record says the system was last synced
//   against: entries the client lacks are appended (pages as planned),
//   entries still equal to the baseline advance, and anything the client
//   changed is kept, and reported when the stock value is news. Nothing is
//   removed, reordered, or retitled.
// - Authored fragments the ordinary starter ships and manages (the Digital,
//   Social, and Print overviews and the toolkit's own Use pages), written
//   when the sync adds their page and refreshed only while they still match
//   what the toolkit wrote. A fragment that differs is this system's own page
//   and is never replaced, --force included. The brand kit manages no
//   fragment: its pages are seed-only, authored on the published kit parent.
// - The starter level: numbered steps declared as data (`starterSteps`
//   below, applied by src/starter-steps.mjs) change defaults a system never
//   chose. The record keeps the `level` reached and the steps `declined`.
//
// Every other fragment, tokens.json, the system stylesheet and the layout
// shell are the client's; the layout only gains a missing stock stylesheet
// link. The sync refuses to run over uncommitted changes to the files it
// writes, ends with the workspace check, and rolls back everything it wrote
// when that check fails.
//
// The toolkit supports systems at or above the floor only. A starter-based
// system without a record, or whose record has no `level` or one below the
// floor, predates starter levels: every command that writes the starter
// boundary refuses it (`below_floor`), and it is regenerated from the current
// starter rather than carried forward.
// An offshoot carries .timds/parent.json: its catalogs come from `feed`, so
// ordinary starter sync and upgrade refresh only the toolkit plumbing and
// preserve both structural baselines and every parent-record byte.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { readFileSync } from "node:fs";
import { readParentRecord } from "./offshoot-contract.mjs";
import { findSitePage, runStarterSteps, starterStepApplies, validateStarterSteps } from "./starter-steps.mjs";

const templatesRoot = fileURLToPath(new URL("../templates/", import.meta.url));

export const STARTER_RECORD_FILE = ".timds/starter.json";
export const STARTER_SITE_FILE = "src/site.json";
export const STARTER_FORMATS_FILE = "src/formats.json";
export const STARTER_LAYOUT_FILE = "src/layout.html";

/** The record's `plumbing` modes: who a local change to a stock script or stylesheet belongs to. */
export const STARTER_PLUMBING_MODES = Object.freeze(["toolkit", "recorded"]);

export const STARTER_KINDS = Object.freeze(["starter", "brand-kit"]);

/** Select only a shipped scaffold; absent records keep the original starter. */
export function starterKind(value = "starter") {
  if (!STARTER_KINDS.includes(value)) throw new Error(`Unknown starter ${JSON.stringify(value)}; choose ${STARTER_KINDS.join(" or ")}`);
  return value;
}

/**
 * Plumbing the sync replaces by hash: [design-system path, template name].
 * The three scripts are stubs that call the renderer in the package
 * (@dtconcepts/timds/viewer); the renderer itself is never copied.
 */
export const starterPlumbingFiles = Object.freeze([
  ["scripts/build.mjs", "starter/scripts/build.mjs"],
  ["scripts/check.mjs", "starter/scripts/check.mjs"],
  ["scripts/dev.mjs", "starter/scripts/dev.mjs"],
  ["src/scripts/compose.js", "starter/src/scripts/compose.js"],
  ["src/styles/canvas.css", "starter/src/styles/canvas.css"],
  ["src/styles/viewer.css", "starter/src/styles/viewer.css"],
]);

/**
 * Authored fragments the starter ships and manages, and the Use
 * pages the toolkit owns (Start, the front page; Compose, the composer and how
 * a system is consumed: browser, llms.txt, the derived layer, MCP, a product
 * pin, the designs; and Install). Each renders
 * the page its path names (src/pages/<view>/index.html is the view's own
 * page, src/pages/<view>/<slug>.html the page <view>/<slug>). A fragment is
 * written when the sync adds its page and refreshed while it is unmodified.
 */
export const starterManagedFragments = Object.freeze([
  ["src/pages/digital/index.html", "starter/src/pages/digital/index.html"],
  ["src/pages/print/index.html", "starter/src/pages/print/index.html"],
  ["src/pages/social/index.html", "starter/src/pages/social/index.html"],
  ["src/pages/use/index.html", "starter/src/pages/use/index.html"],
  ["src/pages/use/compose.html", "starter/src/pages/use/compose.html"],
  ["src/pages/use/install.html", "starter/src/pages/use/install.html"],
]);

/**
 * The managed fragments of a starter kind. The ordinary starter's overviews
 * and Use pages are managed; the brand kit's pages are seed-only (written once
 * by init, authored on the published kit parent, never refreshed by sync), so
 * the kit has none and its record lists plumbing only.
 */
export function starterFragments(kind = "starter") {
  return starterKind(kind) === "starter" ? starterManagedFragments : [];
}

/**
 * Every file the selected sync may write or remove, for clean-tree guards,
 * rollback and the upgrade write boundary: the plumbing, the kind's managed
 * fragments, the catalogs, the layout, the record, and every path a
 * `remove-file` operation of the starter steps in effect names.
 */
export function starterPaths(kind = "starter") {
  return [...new Set([
    ...starterPlumbingFiles.map(([relative]) => relative),
    ...starterFragments(kind).map(([relative]) => relative),
    STARTER_SITE_FILE, STARTER_FORMATS_FILE, STARTER_LAYOUT_FILE, STARTER_RECORD_FILE,
    ...starterRemovalPaths(),
  ])];
}

/** The files the starter steps in effect may remove (their `remove-file` paths), for any starter kind. */
export function starterRemovalPaths() {
  return [...new Set(starterDefinition().steps.flatMap((step) => step.operations.filter((operation) => operation.op === "remove-file").map((operation) => operation.path)))];
}


/** The stylesheet links the sync adds to a layout that lacks them. */
const starterLayoutStylesheets = Object.freeze(["/styles/canvas.css", "/styles/viewer.css"]);

/**
 * sha256 of every earlier stock version a release at or above the floor
 * shipped for a managed file, plumbing and fragments alike. The record's hash
 * covers a system whose files are what the toolkit last wrote, but a record
 * can move past its files (a reverted page write that kept the newer hash);
 * a file byte-identical to any released version is still the toolkit's and is
 * refreshed. When a template that a release already shipped changes, its
 * previous version belongs here: `node scripts/check-starter-history.mjs`
 * walks the release tags from the first one that carries starter levels,
 * fails on a gap, and `--print` lists the entries. Empty at the floor.
 */
export const legacyStarterFileHashes = new Map();

/**
 * The starter level a fresh scaffold of this release starts at, and the
 * oldest level the toolkit supports. Systems below the floor are regenerated
 * from the current starter, never migrated.
 */
export const STARTER_LEVEL = 1;
export const STARTER_FLOOR = 1;

/**
 * The numbered starter steps above the floor, as data: steps[i].level is
 * STARTER_FLOOR + 1 + i and the last is STARTER_LEVEL. Each is declared once,
 * here, and applied by the one interpreter in src/starter-steps.mjs; the
 * release metadata publishes this same list
 * (`describeToolkitRelease().starterSteps`), so a host verifies a candidate
 * against exactly what the toolkit applies. `code` steps apply to every
 * system, offshoots included; `defaults` steps only to the starters they
 * name, and not to an offshoot, whose structure comes from its parent through
 * `feed`. A visible step changes what visitors see: upgrade and starter sync
 * never apply one that has something to change; only `starter migrate
 * --accept` does. Raising the floor prunes the steps at or below it; a new
 * operation or requirement raises `hostContract` in package.json.
 */
export const starterSteps = Object.freeze(validateStarterSteps([], { floor: STARTER_FLOOR, level: STARTER_LEVEL }));

/**
 * The reason a step's conflicts report, for a step whose every failure means
 * one thing. Kept beside the steps, not in them: the published step JSON has
 * exactly the contract's keys.
 */
export const starterStepConflictReasons = Object.freeze({});

// Tests prove the interpreter and the command path with steps of their own.
// The definition is scoped to one async call through `withStarterDefinition`,
// which only code importing this module can reach: no CLI flag or
// environment variable selects it.
const definitionOverride = new AsyncLocalStorage();

/** The level, floor, steps and conflict reasons in effect. */
function starterDefinition() {
  return definitionOverride.getStore() ?? { level: STARTER_LEVEL, floor: STARTER_FLOOR, steps: starterSteps, reasons: starterStepConflictReasons };
}

/**
 * Run `task` with another starter definition (`{ level, floor, steps }` in
 * the release metadata's JSON form, plus optional `reasons`) in effect for
 * every starter operation it makes. For tests: the package exports no path to
 * this module, and nothing outside a direct import reaches it.
 */
export function withStarterDefinition(definition, task) {
  const steps = validateStarterSteps(structuredClone(definition.steps), { floor: definition.floor, level: definition.level });
  return definitionOverride.run({ level: definition.level, floor: definition.floor, steps, reasons: definition.reasons ?? {} }, task);
}

/** The original starter boundary at this release's steps, retained for existing callers. */
export const starterSyncPaths = Object.freeze(starterPaths());

/** The `starterSteps` block of the release metadata: the level, the floor and every step, as plain JSON. */
export function describeStarterSteps() {
  const { level, floor, steps } = starterDefinition();
  return structuredClone({ level, floor, steps });
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const pageId = (view, slug) => (slug ? `${view}/${slug}` : view);

/** Every hash at which `relative` is still the toolkit's: the legacy table plus what the record says was last written. */
export function knownStarterHashes(relative, record) {
  const recorded = record?.files?.[relative];
  return [...(legacyStarterFileHashes.get(relative) ?? []), ...(typeof recorded === "string" ? [recorded] : [])];
}

export async function template(name) {
  return fs.readFile(path.join(templatesRoot, name), "utf8");
}

/** The absolute path of the stock template behind a plumbing or fragment file, for a diff against it. */
export function stockTemplatePath(relative, kind = "starter") {
  const entry = [...starterPlumbingFiles, ...starterFragments(kind)].find(([candidate]) => candidate === relative);
  if (!entry) throw new Error(`${relative} is not a starter file the toolkit writes`);
  return path.join(templatesRoot, entry[1]);
}

async function readOptional(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (caught) {
    if (caught?.code !== "ENOENT") throw caught;
    return null;
  }
}

function readOptionalSync(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (caught) {
    if (caught?.code !== "ENOENT") throw caught;
    return null;
  }
}

async function readOptionalBytes(file) {
  try {
    return await fs.readFile(file);
  } catch (caught) {
    if (caught?.code !== "ENOENT") throw caught;
    return null;
  }
}

function readOptionalBytesSync(file) {
  try {
    return readFileSync(file);
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
 * Advance `target[field]` to `stock` when it still equals a baseline; keep it
 * otherwise. A kept edit is reported only when the stock value is news, that
 * is, no baseline already had it: an edit the client made against a stock
 * value that has not moved was reported when it first diverged and would
 * otherwise be repeated on every sync. An entry no baseline knows (a view or
 * format the client declared before the scaffold did) is reported in full
 * once; the next record then holds it.
 */
function advanceOrKeep(changes, target, field, stock, candidates, label) {
  if (isDeepStrictEqual(target[field], stock)) return;
  const pick = (candidate) => candidate?.[field];
  if (unchanged(target[field], candidates, pick)) {
    assign(target, field, stock);
    changes.advanced.push(label);
    return;
  }
  if (!unchanged(stock, candidates, pick)) changes.kept.push({ current: target[field], path: label, stock });
}

/**
 * Merge the stock site model into the client's. Views the client lacks are
 * appended with every page planned unless its fragment exists; pages a
 * declared view lacks are inserted after the last of their stock predecessors
 * the view has, planned the same way, so the client's own order never moves.
 * A label, blurb, title, group, summary, layout or promotion still equal to a
 * baseline advances to stock; one the client changed is kept and reported when the
 * stock value moved. `planned` is never changed on a declared page except for
 * the ids in `authoredPages`, whose fragments the caller writes. `home` stays
 * the system's routing choice, including its absence: moving it would break
 * links in authored pages that the merge must preserve.
 */
export function mergeSiteModel(current, next, baselines, { fragmentExists = () => false, authoredPages = new Set() } = {}) {
  const site = isObject(current) ? structuredClone(current) : {};
  if (!Array.isArray(site.views)) site.views = [];
  const changes = { addedPages: [], addedViews: [], advanced: [], kept: [] };
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
    for (const field of ["label", "blurb"]) advanceOrKeep(changes, view, field, nextView[field], baseViews, `${nextView.id}.${field}`);
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
      for (const field of ["title", "group", "summary", "layout", "promote"]) advanceOrKeep(changes, page, field, nextPage[field], basePages, `${id}.${field}`);
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
 * both; a field still equal to a baseline advances, a changed one is kept
 * and reported when the stock value moved.
 */
export function mergeFormatCatalog(current, next, baselines, declaredPages) {
  const catalog = isObject(current) ? structuredClone(current) : {};
  const changes = { addedFormats: [], addedGroups: [], advanced: [], kept: [], skipped: [] };
  const owners = new Map();
  for (const [group, entry] of Object.entries(catalog)) {
    if (group.startsWith("$") || !isObject(entry)) continue;
    for (const id of Object.keys(isObject(entry.formats) ? entry.formats : {})) owners.set(id, group);
  }
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
      else advanceOrKeep(changes, catalog, group, stock, baselines, group);
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
      advanceOrKeep(changes, entry, field, stock[field], baseGroups, `${group}.${field}`);
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
        advanceOrKeep(changes, existing, field, format[field], baseFormats, `${group}.${id}.${field}`);
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
  // A link counts whatever its quoting or cache-busting query, so a layout
  // that links /styles/viewer.css?v=3 is not given a second viewer link.
  const linked = (href) => new RegExp(`href=["']${href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[?#][^"']*)?["']`);
  const has = (lines, href) => lines.findIndex((line) => linked(href).test(line));
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
    throw new Error(`${STARTER_RECORD_FILE} is not a TimDS starter record; restore it from git`);
  }
  if (record.plumbing !== undefined && !STARTER_PLUMBING_MODES.includes(record.plumbing)) {
    throw new Error(`${STARTER_RECORD_FILE} has plumbing ${JSON.stringify(record.plumbing)}; it must be ${STARTER_PLUMBING_MODES.map((mode) => JSON.stringify(mode)).join(" or ")}`);
  }
  starterKind(record.starter);
  if (record.level !== undefined && (!Number.isInteger(record.level) || record.level < 0)) throw new Error(`${STARTER_RECORD_FILE} has level ${JSON.stringify(record.level)}; it must be a whole number`);
  if (record.declined !== undefined && (!Array.isArray(record.declined) || record.declined.some((id) => typeof id !== "string"))) throw new Error(`${STARTER_RECORD_FILE} has declined ${JSON.stringify(record.declined)}; it must be a list of step ids`);
  return record;
}

/** Whether a starter record (or its absence) is below the floor: no record, no level, or a level under it. */
export function starterBelowFloor(record) {
  return !Number.isInteger(record?.level) || record.level < starterDefinition().floor;
}

/** The refusal every command that writes a below-floor system's starter boundary throws. */
export function belowFloorError(what = "This Design System") {
  const { floor } = starterDefinition();
  return Object.assign(new Error(`${what} predates starter levels: its .timds/starter.json records no starter level at or above ${floor}, the oldest this toolkit supports. Nothing was changed. Regenerate it from the current starter (timds init in a new folder, then bring its tokens, pages, media and designs across); it stays on the release it has until then.`), { failureCode: "below_floor" });
}

/**
 * Refuse a starter-based system below the floor; a system that is not
 * starter-based (no src/site.json) passes. Returns the record.
 */
export async function requireStarterFloor(designSystemRoot, { record = undefined, what } = {}) {
  if (!await isStarterSystem(designSystemRoot)) return null;
  if (record === undefined) record = await readStarterRecord(designSystemRoot);
  if (starterBelowFloor(record)) throw belowFloorError(what);
  return record;
}

async function writeStarterRecord(designSystemRoot, record) {
  const file = path.join(designSystemRoot, STARTER_RECORD_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return file;
}

/** The stock catalogs, managed file texts, and their hashes of the installed toolkit's starter, each template read once. */
async function stockStarter(kind = "starter") {
  kind = starterKind(kind);
  const files = {};
  const texts = {};
  for (const [relative, templateName] of [...starterPlumbingFiles, ...starterFragments(kind)]) {
    texts[relative] = await template(templateName);
    files[relative] = sha256(texts[relative]);
  }
  return {
    files,
    formats: parseJson(await template(`${kind}/src/formats.json`), "the starter formats template"),
    site: parseJson(await template(`${kind}/src/site.json`), "the starter site template"),
    texts,
  };
}

/**
 * Record a fresh scaffold: every managed file at its stock hash, the stock
 * catalogs as the baseline, the plumbing the toolkit's outright, and the
 * current starter level.
 */
export async function recordFreshStarter(designSystemRoot, version, kind = "starter") {
  kind = starterKind(kind);
  const stock = await stockStarter(kind);
  return writeStarterRecord(designSystemRoot, {
    baseline: { formats: stock.formats, site: stock.site },
    declined: [],
    files: stock.files,
    level: starterDefinition().level,
    plumbing: "toolkit",
    schemaVersion: 1,
    starter: kind,
    version,
  });
}

/** Whether this Design System is starter-based at all: it has the starter's site model. */
export async function isStarterSystem(designSystemRoot) {
  return (await readOptional(path.join(designSystemRoot, STARTER_SITE_FILE))) !== null;
}

/** The customized files in a sync report that `starter sync --force <path>` would replace: plumbing only, never a fragment. */
export function forceReplaceable(report) {
  const plumbing = new Set(starterPlumbingFiles.map(([relative]) => relative));
  return report.files.filter((file) => file.status === "customized" && plumbing.has(file.path)).map((file) => file.path);
}

/**
 * Bring a starter-based Design System at or above the floor up to the
 * installed toolkit's scaffold and starter level. Plans every change first,
 * writes them together, records what it wrote, and runs `check`; if the check
 * fails, every file is restored (removed ones included) and the error says
 * what failed. `force` lists the customized plumbing files to replace (moot
 * when the record's plumbing mode is "toolkit"); it never reaches a fragment.
 * `decideCustomized`, when given, is asked about each remaining customized
 * plumbing file with `{ path, file, current, desired, templatePath }` and
 * answers "replace" or "keep". A caller that already read the record or the
 * parent record passes them.
 *
 * After the plumbing, catalogs and fragments are planned, the starter steps
 * above the recorded level run on that planned state (see starter-steps.mjs):
 * `accept` names visible steps to apply and `decline` declinable steps to
 * settle by decision; with neither, as in `upgrade`, no visible step with
 * something to change is applied. `dryRun` plans and reports without writing.
 */
export async function syncStarter({ designSystemRoot, version, check = null, decideCustomized = null, force = [], record = undefined, parent = undefined, accept = [], decline = [], dryRun = false }) {
  const resolve = (relative) => path.join(designSystemRoot, ...relative.split("/"));
  const siteText = await readOptional(resolve(STARTER_SITE_FILE));
  if (siteText === null) {
    throw new Error(`${designSystemRoot} has no ${STARTER_SITE_FILE}, so it is not a starter-based Design System; starter sync only applies to systems scaffolded by timds init`);
  }
  if (record === undefined) record = await readStarterRecord(designSystemRoot);
  if (starterBelowFloor(record)) throw belowFloorError();
  const definition = starterDefinition();
  // An offshoot's structural stock comes from its parent, through `feed`.
  // A toolkit upgrade still keeps its engine current, but must not append
  // the seed's catalogs or author its fragments into the child's structure.
  if (parent === undefined) parent = await readParentRecord(designSystemRoot);
  const kind = starterKind(record.starter);
  const stock = await stockStarter(kind);
  const level = record.level;
  const declined = [...(record.declined ?? [])];
  const knownSteps = new Map(definition.steps.map((step) => [step.id, step]));
  for (const id of [...accept, ...decline]) {
    if (!knownSteps.has(id)) throw Object.assign(new Error(`Unknown starter step ${JSON.stringify(id)}; this release declares ${definition.steps.map((step) => step.id).join(", ") || "none"}`), { failureCode: "unknown_step" });
  }
  for (const id of decline) {
    if (!knownSteps.get(id).declinable) throw Object.assign(new Error(`The starter step ${id} cannot be declined; only ${definition.steps.filter((step) => step.declinable).map((step) => step.id).join(", ") || "none"} can`), { failureCode: "not_declinable" });
    if (accept.includes(id)) throw Object.assign(new Error(`The starter step ${id} is both accepted and declined; choose one`), { failureCode: "conflicting_decision" });
    if (knownSteps.get(id).level <= level && !declined.includes(id)) throw Object.assign(new Error(`The starter step ${id} is already settled at level ${level}; there is nothing to decline`), { failureCode: "already_settled" });
    if (!declined.includes(id)) declined.push(id);
  }
  for (const id of accept) {
    if (declined.includes(id) && !decline.includes(id)) throw Object.assign(new Error(`The starter step ${id} was declined; remove it from declined in ${STARTER_RECORD_FILE} to accept it`), { failureCode: "already_declined" });
  }
  const files = [];
  const writes = [];
  // An offshoot keeps the hashes it was recorded with.
  const recordedFiles = parent ? { ...record.files } : {};
  const plan = (relative, status, content, current, note) => {
    files.push(note ? { note, path: relative, status } : { path: relative, status });
    if (content !== null && content !== undefined && content !== current) writes.push({ content, current, file: resolve(relative), relative });
  };
  // A file the toolkit wrote is recorded at the stock hash; a customized one
  // keeps the hash last written for it, so a revert to that version is still
  // recognized as stock instead of staying customized until --force.
  const recordFile = (relative, planned) => {
    if (planned.status !== "customized" && planned.status !== "skipped") recordedFiles[relative] = stock.files[relative];
    else if (typeof record.files?.[relative] === "string") recordedFiles[relative] = record.files[relative];
  };

  // 1. Plumbing, by hash; or outright when the toolkit owns it.
  const plumbingMode = record.plumbing ?? "recorded";
  const plumbingPlans = [];
  for (const [relative] of starterPlumbingFiles) {
    const desired = stock.texts[relative];
    let planned = await planStockFile(resolve(relative), desired, { force: plumbingMode === "toolkit" || force.includes(relative), knownHashes: knownStarterHashes(relative, record) });
    let note = planned.forced ? (plumbingMode === "toolkit" ? "the toolkit's in this system; a local change was replaced" : "replaced with --force") : undefined;
    if (planned.status === "customized" && decideCustomized) {
      const choice = await decideCustomized({ current: planned.current, desired, file: resolve(relative), path: relative, templatePath: stockTemplatePath(relative, kind) });
      if (choice === "replace") {
        planned = { ...planned, forced: true, status: "updated", write: true };
        note = "replaced at the prompt";
      } else {
        note = "kept at the prompt";
      }
    }
    plumbingPlans.push({ relative, desired, planned });
    recordFile(relative, planned);
    plan(relative, planned.status, planned.write ? desired : null, planned.current, note);
  }

  // 2. The catalogs. The site model is merged first because formats and
  //    fragments both refer to its pages; the current stock is never a
  //    baseline, since a field equal to it needs no merge.
  let merged = { changes: { addedPages: [], addedViews: [], advanced: [], kept: [] } };
  let mergedFormats = { changes: { addedFormats: [], addedGroups: [], advanced: [], kept: [], skipped: [] } };
  const currentSite = parseJson(siteText, STARTER_SITE_FILE);
  let siteForSteps = currentSite;
  let planSite = null;
  const fragmentPlans = new Map();
  if (!parent) {
    const fragmentPages = new Map(starterFragments(kind).map(([relative]) => {
      const id = relative.slice("src/pages/".length, -".html".length).replace(/\/index$/, "");
      return [id, { relative }];
    }));
    const declaredBefore = declaredPageIds(currentSite);
    const fragmentsToWrite = new Set();
    const authoredPages = new Set();
    for (const [id, { relative }] of fragmentPages) {
      const desired = stock.texts[relative];
      const planned = await planStockFile(resolve(relative), desired, { knownHashes: knownStarterHashes(relative, record) });
      if (planned.status !== "created") {
        // A fragment that exists is an authored page, whatever the site model
        // still says: the viewer refuses a planned page whose file exists.
        if (findSitePage(currentSite, id)?.planned === true) authoredPages.add(id);
        fragmentPlans.set(relative, { desired, planned });
        continue;
      }
      // An absent fragment is written when the sync adds its page, and when the
      // page is declared but still planned: a planned page has no content to
      // lose, and the stock overview is the primitive the view starts from (the
      // client's own title and summary stay). A page the client declares as
      // authored keeps whatever fragment plans they have.
      const stockPage = findSitePage(stock.site, id);
      const declaredPage = findSitePage(currentSite, id);
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
    merged = mergeSiteModel(currentSite, stock.site, [record.baseline.site], { authoredPages, fragmentExists });
    siteForSteps = merged.site;
    planSite = (site) => {
      const siteChanged = !isDeepStrictEqual(site, currentSite);
      plan(STARTER_SITE_FILE, siteChanged ? "updated" : "current", siteChanged ? formatSiteJson(site) : null, siteText);

      const formatsText = readOptionalSync(resolve(STARTER_FORMATS_FILE));
      const currentFormats = formatsText === null ? null : parseJson(formatsText, STARTER_FORMATS_FILE);
      mergedFormats = mergeFormatCatalog(currentFormats, stock.formats, [record.baseline.formats], declaredPageIds(site));
      const formatsChanged = currentFormats === null || !isDeepStrictEqual(mergedFormats.catalog, currentFormats);
      plan(STARTER_FORMATS_FILE, currentFormats === null ? "created" : formatsChanged ? "updated" : "current", formatsChanged ? formatFormatsJson(mergedFormats.catalog) : null, formatsText);

      // 3. Fragments, now that the site model says which pages exist. A
      //    customized fragment is this system's own page: kept, --force or not.
      for (const [relative, { desired, planned }] of fragmentPlans) {
        if (planned.status !== "skipped") recordFile(relative, planned);
        const note = planned.status === "skipped"
          ? "its page is declared as authored by this system; copy the stock fragment by hand if wanted"
          : planned.status === "customized" ? "this system's own page; never replaced, --force included" : undefined;
        plan(relative, planned.status, planned.write ? desired : null, planned.current, note);
      }
    };
  }

  // 4. The starter steps above the recorded level, on the state the plan
  //    above leaves: the planned plumbing and fragment bytes, the merged site.
  const plannedBytes = new Map();
  for (const { relative, planned, desired } of plumbingPlans) {
    if (planned.write) plannedBytes.set(relative, Buffer.from(desired));
  }
  for (const [relative, { planned, desired }] of fragmentPlans) {
    if (planned.write) plannedBytes.set(relative, Buffer.from(desired));
  }
  const steps = runStarterSteps(definition.steps, {
    site: siteForSteps,
    read: (relative) => plannedBytes.get(relative) ?? readOptionalBytesSync(resolve(relative)),
    stock: (relative) => (Object.hasOwn(stock.texts, relative) ? Buffer.from(stock.texts[relative]) : null),
  }, { level, declined, accept: new Set(accept), starter: kind, offshoot: Boolean(parent), force: new Set(force), reasons: definition.reasons });
  if (planSite) planSite(steps.site);
  else if (!isDeepStrictEqual(steps.site, currentSite)) plan(STARTER_SITE_FILE, "updated", formatSiteJson(steps.site), siteText);
  for (const relative of steps.remove) {
    const bytes = readOptionalBytesSync(resolve(relative));
    files.push({ path: relative, status: "removed", ...(steps.results.some((result) => result.changes?.some((change) => change.path === relative && change.forced)) ? { note: "removed with --force" } : {}) });
    writes.push({ remove: true, current: bytes, file: resolve(relative), relative });
    delete recordedFiles[relative];
  }

  // 5. The layout shell gains the stock stylesheet links it lacks and nothing else.
  const layoutText = await readOptional(resolve(STARTER_LAYOUT_FILE));
  if (layoutText === null) {
    plan(STARTER_LAYOUT_FILE, "skipped", null, null, "absent");
  } else {
    const links = insertStylesheetLinks(layoutText, await template(`${kind}/src/layout.html`));
    const changed = links.inserted.length > 0;
    const status = changed ? "updated" : links.unplaced.length ? "customized" : "current";
    const notes = [];
    if (links.inserted.length) notes.push(`linked ${links.inserted.join(", ")}`);
    if (links.unplaced.length) notes.push(`could not place ${links.unplaced.join(", ")}; link it in <head> by hand`);
    plan(STARTER_LAYOUT_FILE, status, changed ? links.html : null, layoutText, notes.length ? notes.join("; ") : undefined);
  }

  // 6. Write, record, check; roll everything back when the check fails.
  // A decline is recorded unless the step settled otherwise in this run
  // (it had nothing to change); a decision recorded earlier stays.
  const settledOtherwise = new Set(steps.results.filter((result) => result.outcome === "applied" || result.outcome === "skipped").map((result) => result.step));
  const nextDeclined = definition.steps.map((step) => step.id).filter((id) => declined.includes(id) && ((record.declined ?? []).includes(id) || !settledOtherwise.has(id)));
  const nextRecord = { baseline: parent ? record.baseline : { formats: stock.formats, site: stock.site }, declined: nextDeclined, files: recordedFiles, level: steps.level, ...(record.plumbing ? { plumbing: record.plumbing } : {}), schemaVersion: 1, starter: kind, version };
  const recordPath = resolve(STARTER_RECORD_FILE);
  const previousRecordText = await readOptional(recordPath);
  const recordChanged = previousRecordText !== `${JSON.stringify(nextRecord, null, 2)}\n`;
  const report = {
    check: null,
    designSystemRoot,
    files,
    formats: mergedFormats.changes,
    plumbing: plumbingMode,
    starter: kind,
    record: recordPath,
    recordWritten: recordChanged,
    site: merged.changes,
    written: writes.map((write) => write.relative),
    levels: {
      previous: level,
      level: steps.level,
      declined: nextDeclined,
      steps: steps.results,
      stopped: steps.stopped,
      conflicts: steps.conflicts,
    },
  };
  report.status = describeStarterStatus({ starter: kind, plumbing: plumbingMode, level: steps.level, declined: nextDeclined }, { conflicts: steps.conflicts, offshoot: Boolean(parent) });
  if (dryRun || (!writes.length && !recordChanged)) return report;
  for (const write of writes) {
    if (write.remove) {
      await fs.rm(write.file, { force: true });
      continue;
    }
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
        else await fs.writeFile(write.file, write.current, typeof write.current === "string" ? "utf8" : undefined);
      }
      if (previousRecordText === null) await fs.rm(recordPath, { force: true });
      else await fs.writeFile(recordPath, previousRecordText, "utf8");
      const customized = forceReplaceable({ files });
      // `failureCode` lets a machine-readable caller tell a failed check from a refusal.
      throw Object.assign(new Error(`Starter sync was rolled back because the workspace check failed afterwards: ${caught.message}${customized.length
        ? `\nCustomized files were kept (${customized.join(", ")}); the new pages may need their stock versions. Port your changes, or run timds starter sync --force ${customized.join(" ")} to replace them.`
        : ""}`), { failureCode: "check_failed" });
    }
  }
  return report;
}

/**
 * The starter status a person, `doctor --json`, the upgrade report and a host
 * read: the recorded level against this release's, the floor, whether the
 * system is below it, and what is pending, declined and in conflict.
 * `record` is `{ starter, plumbing, level, declined }` (a missing record is
 * below the floor); `conflicts` come from a sync, real or dry. Steps that do
 * not apply to this kind of system are not pending.
 */
export function describeStarterStatus(record, { conflicts = [], offshoot = false } = {}) {
  const { level: current, floor, steps } = starterDefinition();
  const starter = starterKind(record?.starter);
  const belowFloor = starterBelowFloor(record);
  const level = Number.isInteger(record?.level) ? record.level : 0;
  const declined = record?.declined ?? [];
  return {
    starter,
    plumbing: record ? record.plumbing ?? "recorded" : null,
    level,
    current,
    floor,
    belowFloor,
    behind: Math.max(0, current - level),
    pending: belowFloor ? [] : steps
      .filter((step) => step.level > level && !declined.includes(step.id) && starterStepApplies(step, { starter, offshoot }))
      .map((step) => ({ level: step.level, id: step.id, visible: step.visible, declinable: step.declinable })),
    declined: [...declined],
    conflicts: conflicts.map((entry) => ({ ...entry })),
  };
}

/** `timds starter status`: the recorded level and what a sync would meet now, without writing. */
export async function starterStatus(options) {
  return (await starterStatusPlan(options)).status;
}

/**
 * The starter status and the dry-run sync behind it (`plan.levels` says where
 * a sync would stop); `plan` is null below the floor, where no sync runs.
 */
export async function starterStatusPlan({ designSystemRoot, version, record = undefined, parent = undefined }) {
  if (record === undefined) record = await readStarterRecord(designSystemRoot);
  if (parent === undefined) parent = await readParentRecord(designSystemRoot);
  if (starterBelowFloor(record)) return { plan: null, status: describeStarterStatus(record, { offshoot: Boolean(parent) }) };
  const plan = await syncStarter({ designSystemRoot, version, record, parent, dryRun: true });
  return { plan, status: describeStarterStatus(record, { conflicts: plan.levels.conflicts, offshoot: Boolean(parent) }) };
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
  const keptAs = (kept) => (kept.current === undefined ? "undeclared" : `as ${JSON.stringify(kept.current)}`);
  for (const kept of site.kept) lines.push(`Kept ${kept.path} ${keptAs(kept)}; the scaffold now says ${JSON.stringify(kept.stock)}.`);
  if (formats.addedGroups.length) lines.push(`Added format groups: ${formats.addedGroups.join(", ")}.`);
  if (formats.addedFormats.length) {
    const groups = [...new Set(formats.addedFormats.map((id) => id.split(".")[0]))];
    lines.push(`Added formats: ${formats.addedFormats.length} in ${groups.join(", ")}.`);
  }
  if (formats.advanced.length) lines.push(`Advanced unchanged stock format fields: ${formats.advanced.join(", ")}.`);
  for (const kept of formats.kept) lines.push(`Kept format field ${kept.path} ${keptAs(kept)}; the scaffold now says ${JSON.stringify(kept.stock)}.`);
  for (const skipped of formats.skipped) lines.push(`Skipped format ${skipped.id}: ${skipped.reason}.`);
  if (report.check) {
    const warnings = report.check.machine?.warnings ?? [];
    lines.push(`Check passed${warnings.length ? ` with ${warnings.length} warning${warnings.length === 1 ? "" : "s"}` : ""}.`);
    for (const warning of warnings) lines.push(`Warning: ${warning}`);
  }
  return lines;
}

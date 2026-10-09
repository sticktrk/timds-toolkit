// Reports where the starter scaffold has drifted from the golden Design
// System: views, sidebar groups, pages, and asset formats that the golden
// repository declares and templates/starter does not, or declares
// differently. It reads the golden repository's own modules (the navigation
// model and the print and canvas catalogs) through tsx, so it needs no
// build there, and compares them with src/site.json and src/formats.json.
//
// Structure is mirrored, content is not (see AGENTS.md). Everything the
// starter leaves out on purpose is listed in MAPPING below with its reason,
// so the report stays quiet until the golden repository actually changes.
//
//   node scripts/golden-drift.mjs --golden ../path/to/golden-checkout [--json]
//
// Exits 1 when drift is found, so it can gate a release.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "tsx/esm/api";

const MAPPING = {
  // golden view id → starter view id
  views: { marketing: "web" },
  excludedViews: {
    admin: "a product-specific utility theme; a client adds it when it has one",
  },
  // golden page id (after view mapping) → starter page id, or null with a reason
  pages: {
    "web": null,
    "web/tokens-typography": null,
    "web/tokens-color": null,
    "web/tokens-spacing": "web/spacing",
    "web/illustration": null,
    "web/modules": null,
    "web/sections": null,
    "web/overflow": null,
  },
  pageReasons: {
    "web": "the starter lands Web DS on its first authored page",
    "web/tokens-typography": "typography is a Brand page in the starter",
    "web/tokens-color": "color is a Brand page in the starter",
    "web/illustration": "beyond the starter's component set; authored per client",
    "web/modules": "beyond the starter's component set; authored per client",
    "web/sections": "beyond the starter's component set; authored per client",
    "web/overflow": "beyond the starter's component set; authored per client",
  },
  // golden page ids matching these prefixes are excluded wholesale
  excludedPagePrefixes: { "web/archetypes": "superseded by website designs under src/designs/" },
  // golden format id → starter format id, or null with a reason
  formats: {},
  formatReasons: {},
};

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const json = args.includes("--json");
const goldenIndex = args.indexOf("--golden");
const golden = goldenIndex >= 0 ? path.resolve(args[goldenIndex + 1] || "") : "";
if (!golden || !existsSync(golden)) {
  console.error("Usage: node scripts/golden-drift.mjs --golden PATH [--json]\nPATH is a checkout of the golden Design System repository.");
  process.exit(2);
}

register();
const goldenModule = async (relative, required = false) => {
  const file = path.join(golden, relative);
  if (existsSync(file)) return import(pathToFileURL(file).href);
  if (required) throw new Error(`${relative} not found under ${golden}; is this the golden Design System checkout?`);
  return null;
};
const nav = await goldenModule("src/lib/design-system-nav.ts", true);
// The catalogs arrived later than the navigation model; an older checkout simply has none.
const print = (await goldenModule("src/lib/print-templates.ts")) ?? { FORMATS: {}, POSTER_SIZES: [] };
const canvas = (await goldenModule("src/lib/canvas-templates.ts")) ?? { DIGITAL: {}, SOCIAL: {} };

const readJson = (relative) => JSON.parse(readFileSync(path.join(packageRoot, "templates", "starter", "src", relative), "utf8"));
const site = readJson("site.json");
const catalog = readJson("formats.json");

const findings = { views: [], groups: [], pages: [], formats: [] };
const note = (bucket, kind, subject, detail) => findings[bucket].push({ kind, subject, detail });
const groupName = (group) => (group || "").split(" · ").pop().trim().toLowerCase();
// A view's pages in order, each with the sidebar group in effect at it. A group
// named after the view itself is a catch-all heading, the same as none.
const effectiveGroups = (view, pages) => {
  const own = new Set([view.id.toLowerCase(), (view.label || "").toLowerCase()]);
  let current = "";
  return pages.map((page) => {
    if (page.group) current = groupName(page.group);
    return { page, group: own.has(current) ? "" : current };
  });
};
const excludedPage = (id) => Object.keys(MAPPING.excludedPagePrefixes).some((prefix) => id === prefix || id.startsWith(`${prefix}/`))
  || (Object.hasOwn(MAPPING.pages, id) && MAPPING.pages[id] === null);

// ---- views, groups, and pages ----
const starterViews = new Map(site.views.map((view) => [view.id, view]));
const starterPages = new Map();
for (const view of site.views) {
  for (const page of view.pages) starterPages.set(page.slug ? `${view.id}/${page.slug}` : view.id, { ...page, view });
}
const matchedStarterPages = new Set();

for (const goldenView of nav.VIEWS) {
  if (MAPPING.excludedViews[goldenView.id]) continue;
  const viewId = MAPPING.views[goldenView.id] ?? goldenView.id;
  const starterView = starterViews.get(viewId);
  if (!starterView) {
    note("views", "missing", viewId, `golden view ${goldenView.id} ("${goldenView.label}", ${goldenView.pages.length} pages) has no starter view`);
    continue;
  }
  if (starterView.label !== goldenView.label) note("views", "differs", viewId, `label is "${starterView.label}" in the starter, "${goldenView.label}" in golden`);
  if ((starterView.blurb || "") !== goldenView.blurb) note("views", "differs", viewId, `blurb is "${starterView.blurb || ""}" in the starter, "${goldenView.blurb}" in golden`);

  const goldenEntries = effectiveGroups(goldenView, goldenView.pages)
    .map((entry) => ({ ...entry, id: entry.page.slug ? `${viewId}/${entry.page.slug}` : viewId }))
    .filter((entry) => !excludedPage(entry.id));
  const starterEntries = effectiveGroups(starterView, starterView.pages)
    .map((entry) => ({ ...entry, id: entry.page.slug ? `${viewId}/${entry.page.slug}` : viewId }));
  const starterGroupOf = new Map(starterEntries.map((entry) => [entry.id, entry.group]));
  const goldenGroups = new Set(goldenEntries.map((entry) => entry.group).filter(Boolean));
  const starterGroups = new Set(starterEntries.map((entry) => entry.group).filter(Boolean));
  for (const group of goldenGroups) if (!starterGroups.has(group)) note("groups", "missing", `${viewId}: ${group}`, "golden sidebar group has no starter counterpart");
  for (const group of starterGroups) if (!goldenGroups.has(group)) note("groups", "extra", `${viewId}: ${group}`, "starter sidebar group is not in golden");

  for (const { page: goldenPage, group: currentGroup, id: goldenId } of goldenEntries) {
    const mapped = Object.hasOwn(MAPPING.pages, goldenId) ? MAPPING.pages[goldenId] : goldenId;
    const starterPage = starterPages.get(mapped);
    if (!starterPage) {
      note("pages", "missing", mapped, `golden page "${goldenPage.title}"${currentGroup ? ` (${currentGroup})` : ""} is not declared in src/site.json`);
      continue;
    }
    matchedStarterPages.add(mapped);
    if (!starterPage.title.toLowerCase().includes(goldenPage.title.toLowerCase())) {
      note("pages", "differs", mapped, `title is "${starterPage.title}" in the starter, "${goldenPage.title}" in golden`);
    }
    const starterGroup = starterGroupOf.get(mapped) ?? "";
    if (starterGroup !== currentGroup) note("pages", "differs", mapped, `sits under the group "${starterGroup}" in the starter, "${currentGroup}" in golden`);
  }
}
for (const [id, page] of starterPages) {
  if (matchedStarterPages.has(id)) continue;
  note("pages", "extra", id, `starter page "${page.title}" has no golden counterpart`);
}

// ---- asset formats ----
const goldenFormats = new Map();
const addGolden = (group, unit, format) => goldenFormats.set(format.id, { ...format, group, unit });
for (const format of Object.values(print.FORMATS)) addGolden("print", "in", { id: format.id, name: format.name, width: format.trim[0], height: format.trim[1], bleed: format.bleed, safe: format.safe });
for (const format of print.POSTER_SIZES) addGolden("print", "in", { id: format.id, name: `Poster · ${format.name}`, width: format.trim[0], height: format.trim[1], bleed: format.bleed, safe: format.safe });
for (const format of Object.values(canvas.DIGITAL)) addGolden("digital", "px", { id: format.id, name: format.name, width: format.size[0], height: format.size[1], safe: format.safe, maxKB: format.maxKB, ui: format.ui, keepClear: format.keepClear });
for (const format of Object.values(canvas.SOCIAL)) addGolden("social", "px", { id: format.id, name: format.name, width: format.size[0], height: format.size[1], safe: format.safe, maxKB: format.maxKB, ui: format.ui, keepClear: format.keepClear });

const starterFormats = new Map();
for (const [group, entry] of Object.entries(catalog)) {
  if (group.startsWith("$")) continue;
  for (const [id, format] of Object.entries(entry.formats)) starterFormats.set(id, { ...format, id, group, unit: entry.unit });
}
const matchedStarterFormats = new Set();
const same = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
for (const goldenFormat of goldenFormats.values()) {
  const mapped = Object.hasOwn(MAPPING.formats, goldenFormat.id) ? MAPPING.formats[goldenFormat.id] : goldenFormat.id;
  if (mapped === null) continue;
  const starterFormat = starterFormats.get(mapped);
  if (!starterFormat) {
    note("formats", "missing", mapped, `golden ${goldenFormat.group} format "${goldenFormat.name}" (${goldenFormat.width} × ${goldenFormat.height} ${goldenFormat.unit}) is not in src/formats.json`);
    continue;
  }
  matchedStarterFormats.add(mapped);
  if (starterFormat.group !== goldenFormat.group || starterFormat.unit !== goldenFormat.unit) note("formats", "differs", mapped, `is in group ${starterFormat.group} (${starterFormat.unit}) in the starter, ${goldenFormat.group} (${goldenFormat.unit}) in golden`);
  for (const field of ["width", "height", "safe", "bleed", "maxKB", "ui", "keepClear"]) {
    if (goldenFormat[field] === undefined && starterFormat[field] === undefined) continue;
    if (!same(starterFormat[field], goldenFormat[field])) note("formats", "differs", mapped, `${field} is ${JSON.stringify(starterFormat[field] ?? null)} in the starter, ${JSON.stringify(goldenFormat[field] ?? null)} in golden`);
  }
}
for (const [id, format] of starterFormats) {
  if (matchedStarterFormats.has(id)) continue;
  note("formats", "extra", id, `starter ${format.group} format "${format.name}" has no golden counterpart`);
}

// ---- report ----
const total = Object.values(findings).reduce((sum, list) => sum + list.length, 0);
if (json) {
  console.log(JSON.stringify({ golden, drift: total > 0, findings }, null, 2));
} else {
  const marks = { missing: "+", extra: "-", differs: "~" };
  for (const [bucket, list] of Object.entries(findings)) {
    if (!list.length) continue;
    console.log(`${bucket[0].toUpperCase()}${bucket.slice(1)}`);
    for (const finding of list) console.log(`  ${marks[finding.kind]} ${finding.subject}: ${finding.detail}`);
  }
  console.log(total ? `${total} drift finding${total === 1 ? "" : "s"} against ${golden} (+ missing in the starter, - not in golden, ~ differs). Mirror them as AGENTS.md describes, or record a deliberate exclusion in scripts/golden-drift.mjs.` : `The starter mirrors ${golden}: no drift in views, groups, pages, or formats.`);
}
process.exit(total ? 1 : 0);

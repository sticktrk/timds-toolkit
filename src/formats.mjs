// The asset format catalog: every print sheet and screen canvas the system
// produces, as a derived document.
//
// A designer keeps the catalog in `src/formats.json`: groups (`print`,
// `digital`, `social`, …) with a unit, and under each a format with its
// name, size, bleed, safe margin, stock or file note, and the page that
// shows it. The starter's viewer renders those into tables; this module
// validates the same file and writes `formats.json` beside `brand.json`, so
// a person with nothing but the public link can ask for "the business card"
// and get 3.5 × 2 in with 0.125 in bleed, not a page to scrape.
//
// The catalog is optional: a system without `src/formats.json` derives no
// formats document and nothing else changes. A catalog that names a page the
// built artifact lacks is a warning, since the page may be planned.

import fs from "node:fs/promises";
import path from "node:path";

export const FORMATS_SCHEMA_VERSION = 1;
export const FORMATS_SOURCE_FILE = "src/formats.json";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UNITS = new Set(["in", "px"]);
const SIDES = Object.freeze({ ui: ["top", "bottom", "left", "right"], keepClear: ["top", "bottom", "left", "right"] });
const TEXT_FIELDS = ["stock", "file", "note"];

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isNumber = (value, minimum) => typeof value === "number" && Number.isFinite(value) && value >= minimum;

/**
 * Validate a catalog object into ordered groups of formats. Throws with the
 * offending path, so a designer fixes the file rather than guessing.
 */
export function normalizeFormatCatalog(input, { where = FORMATS_SOURCE_FILE } = {}) {
  if (!isObject(input)) throw new Error(`${where} must be an object of format groups`);
  const groups = [];
  const seen = new Map();
  for (const [groupId, entry] of Object.entries(input)) {
    if (groupId.startsWith("$")) continue; // $comment and friends
    if (!SLUG.test(groupId)) throw new Error(`${where} group ${JSON.stringify(groupId)} must be lowercase words joined by hyphens`);
    if (!isObject(entry)) throw new Error(`${where} group ${groupId} must be an object with a unit and formats`);
    if (!UNITS.has(entry.unit)) throw new Error(`${where} group ${groupId} needs a unit of "in" (print) or "px" (screen)`);
    const declared = isObject(entry.formats) ? Object.entries(entry.formats) : [];
    if (!declared.length) throw new Error(`${where} group ${groupId} must declare at least one format`);
    const formats = [];
    for (const [id, format] of declared) {
      const at = `${where} format ${groupId}.${id}`;
      if (!SLUG.test(id)) throw new Error(`${at} must be named with lowercase words joined by hyphens`);
      if (seen.has(id)) throw new Error(`${where} declares the format ${id} twice (${seen.get(id)} and ${groupId}); ids are shared across groups`);
      if (!isObject(format)) throw new Error(`${at} must be an object`);
      if (typeof format.name !== "string" || !format.name.trim()) throw new Error(`${at} needs a name`);
      for (const field of ["width", "height"]) if (!isNumber(format[field], Number.MIN_VALUE)) throw new Error(`${at} needs a positive number for ${field}`);
      if (!isNumber(format.safe, 0)) throw new Error(`${at} needs a non-negative number for safe`);
      for (const field of ["bleed", "maxKB"]) if (format[field] !== undefined && !isNumber(format[field], 0)) throw new Error(`${at} ${field} must be a non-negative number`);
      for (const [field, sides] of Object.entries(SIDES)) {
        const value = format[field];
        if (value === undefined) continue;
        if (!isObject(value)) throw new Error(`${at} ${field} must be an object of ${sides.join(", ")}`);
        for (const [side, amount] of Object.entries(value)) {
          if (!sides.includes(side) || !isNumber(amount, 0)) throw new Error(`${at} ${field}.${side} must be one of ${sides.join(", ")} with a non-negative number`);
        }
      }
      for (const field of TEXT_FIELDS) if (format[field] !== undefined && typeof format[field] !== "string") throw new Error(`${at} ${field} must be a string`);
      if (typeof format.page !== "string" || !format.page.trim()) throw new Error(`${at} must name the page that shows it`);
      seen.set(id, groupId);
      formats.push({
        id,
        name: format.name.trim(),
        width: format.width,
        height: format.height,
        unit: entry.unit,
        ...(format.bleed !== undefined ? { bleed: format.bleed } : {}),
        safe: format.safe,
        ...(format.ui ? { ui: { ...format.ui } } : {}),
        ...(format.keepClear ? { keepClear: { ...format.keepClear } } : {}),
        ...(format.maxKB !== undefined ? { maxKB: format.maxKB } : {}),
        ...Object.fromEntries(TEXT_FIELDS.filter((field) => format[field] !== undefined).map((field) => [field, format[field]])),
        page: format.page.trim(),
      });
    }
    groups.push({ id: groupId, unit: entry.unit, formats });
  }
  return groups;
}

/** The catalog a Design System keeps at `src/formats.json`, validated; null when the system has none. */
export async function readFormatCatalog(designSystemRoot) {
  const filePath = path.join(designSystemRoot, ...FORMATS_SOURCE_FILE.split("/"));
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (caught) {
    if (caught?.code === "ENOENT") return null;
    throw caught;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (caught) {
    throw new Error(`${FORMATS_SOURCE_FILE} is not valid JSON: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
  return normalizeFormatCatalog(parsed);
}

/**
 * The `formats.json` document for a catalog, stamped with the system version.
 * Each format carries the URL of the page that shows it when the extracted
 * index has that page; `warnings` names the formats whose page is not built.
 */
export function formatsDocument(groups, manifest, { pages = [], basePrefix = "" } = {}) {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const warnings = [];
  const resolved = groups.map((group) => ({
    ...group,
    formats: group.formats.map((format) => {
      const page = byId.get(format.page);
      if (!page) warnings.push(`format ${format.id} (${format.name}) names the page ${format.page}, which the built artifact does not contain; it is listed without a page link`);
      return { ...format, ...(page ? { pageUrl: `${page.url}/index.md` } : {}) };
    }),
  }));
  const count = resolved.reduce((sum, group) => sum + group.formats.length, 0);
  return {
    document: {
      schemaVersion: FORMATS_SCHEMA_VERSION,
      system: { id: manifest.systemId, name: manifest.name, version: manifest.version },
      url: `${basePrefix}/formats.json`,
      groupCount: resolved.length,
      count,
      groups: resolved,
    },
    warnings,
  };
}

/** `3.5 × 2 in` or `1080 × 1920 px`, the way a person says a size. */
export function describeFormatSize(format) {
  return `${format.width} × ${format.height} ${format.unit}`;
}

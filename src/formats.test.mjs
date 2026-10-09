import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FORMATS_SOURCE_FILE, describeFormatSize, formatsDocument, normalizeFormatCatalog, readFormatCatalog } from "./formats.mjs";

const CATALOG = {
  $comment: "ignored",
  print: {
    unit: "in",
    formats: {
      "business-card": { name: "Business card · US", width: 3.5, height: 2, bleed: 0.125, safe: 0.125, stock: "16–32 pt cover.", page: "print/business-cards" },
      worksheet: { name: "Worksheet", width: 8.5, height: 11, bleed: 0, safe: 0.5, page: "print/worksheets", note: "No bleed." },
    },
  },
  social: {
    unit: "px",
    formats: {
      "ig-1080x1920": { name: "Instagram story", width: 1080, height: 1920, safe: 64, ui: { top: 250, bottom: 340 }, maxKB: 8192, file: "JPG", page: "social/instagram-posts" },
    },
  },
};

test("normalizes a catalog into ordered groups with each format's unit, skipping $ keys", () => {
  const groups = normalizeFormatCatalog(CATALOG);
  assert.deepEqual(groups.map((group) => [group.id, group.unit, group.formats.map((format) => format.id)]), [
    ["print", "in", ["business-card", "worksheet"]],
    ["social", "px", ["ig-1080x1920"]],
  ]);
  assert.deepEqual(groups[0].formats[0], { id: "business-card", name: "Business card · US", width: 3.5, height: 2, unit: "in", bleed: 0.125, safe: 0.125, stock: "16–32 pt cover.", page: "print/business-cards" });
  assert.deepEqual(groups[1].formats[0].ui, { top: 250, bottom: 340 });
  assert.equal(groups[1].formats[0].maxKB, 8192);
  assert.equal(describeFormatSize(groups[0].formats[0]), "3.5 × 2 in");
  assert.equal(describeFormatSize(groups[1].formats[0]), "1080 × 1920 px");
});

test("refuses a malformed catalog naming the field", () => {
  const withFormat = (format, group = "print", unit = "in") => ({ [group]: { unit, formats: { card: format } } });
  assert.throws(() => normalizeFormatCatalog([]), /must be an object of format groups/);
  assert.throws(() => normalizeFormatCatalog({ Print: { unit: "in", formats: {} } }), /group "Print" must be lowercase words/);
  assert.throws(() => normalizeFormatCatalog({ print: { unit: "cm", formats: {} } }), /needs a unit of "in" \(print\) or "px" \(screen\)/);
  assert.throws(() => normalizeFormatCatalog({ print: { unit: "in", formats: {} } }), /must declare at least one format/);
  assert.throws(() => normalizeFormatCatalog(withFormat({ width: 1, height: 1, safe: 0, page: "p" })), /format print\.card needs a name/);
  assert.throws(() => normalizeFormatCatalog(withFormat({ name: "C", width: 0, height: 1, safe: 0, page: "p" })), /needs a positive number for width/);
  assert.throws(() => normalizeFormatCatalog(withFormat({ name: "C", width: 1, height: 1, page: "p" })), /needs a non-negative number for safe/);
  assert.throws(() => normalizeFormatCatalog(withFormat({ name: "C", width: 1, height: 1, safe: 0, bleed: -1, page: "p" })), /bleed must be a non-negative number/);
  assert.throws(() => normalizeFormatCatalog(withFormat({ name: "C", width: 1, height: 1, safe: 0, ui: { middle: 1 }, page: "p" })), /ui\.middle must be one of top, bottom, left, right/);
  assert.throws(() => normalizeFormatCatalog(withFormat({ name: "C", width: 1, height: 1, safe: 0, stock: 1, page: "p" })), /stock must be a string/);
  assert.throws(() => normalizeFormatCatalog(withFormat({ name: "C", width: 1, height: 1, safe: 0 })), /must name the page that shows it/);
  assert.throws(
    () => normalizeFormatCatalog({ print: { unit: "in", formats: { card: { name: "C", width: 1, height: 1, safe: 0, page: "p" } } }, digital: { unit: "px", formats: { card: { name: "D", width: 1, height: 1, safe: 0, page: "p" } } } }),
    /declares the format card twice \(print and digital\)/,
  );
});

test("reads the catalog from the Design System root, or null when it keeps none", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "timds-formats-"));
  try {
    assert.equal(await readFormatCatalog(root), null);
    const file = path.join(root, ...FORMATS_SOURCE_FILE.split("/"));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(CATALOG));
    const groups = await readFormatCatalog(root);
    assert.equal(groups.length, 2);
    await fs.writeFile(file, "{not json");
    await assert.rejects(readFormatCatalog(root), /src\/formats\.json is not valid JSON/);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("the formats document links each format to its built page and warns about the rest", () => {
  const groups = normalizeFormatCatalog(CATALOG);
  const pages = [{ id: "print/business-cards", url: "/design-system/print/business-cards" }, { id: "social/instagram-posts", url: "/design-system/social/instagram-posts" }];
  const { document, warnings } = formatsDocument(groups, { systemId: "client/system", name: "Client", version: "2.0.0" }, { pages, basePrefix: "/design-system" });
  assert.deepEqual([document.schemaVersion, document.system, document.url, document.groupCount, document.count], [1, { id: "client/system", name: "Client", version: "2.0.0" }, "/design-system/formats.json", 2, 3]);
  assert.equal(document.groups[0].formats[0].pageUrl, "/design-system/print/business-cards/index.md");
  assert.equal(document.groups[0].formats[1].pageUrl, undefined);
  assert.deepEqual(warnings, ["format worksheet (Worksheet) names the page print/worksheets, which the built artifact does not contain; it is listed without a page link"]);
  // The source groups are not mutated by the page join.
  assert.equal(groups[0].formats[0].pageUrl, undefined);
});

test("planned format pages are explicit catalog entries without missing-page warnings", () => {
  const groups = normalizeFormatCatalog(CATALOG);
  const { document, warnings } = formatsDocument(groups, { systemId: "s", name: "S", version: "1.0.0" }, {
    pages: [{ id: "print/business-cards", url: "/print/business-cards" }],
    plannedPages: ["print/worksheets", "print/business-cards"],
  });
  assert.deepEqual(document.groups[0].formats[1].planned, true);
  assert.equal(document.groups[0].formats[1].pageUrl, undefined);
  assert.equal(document.groups[0].formats[0].planned, undefined);
  assert.deepEqual(warnings, ["format ig-1080x1920 (Instagram story) names the page social/instagram-posts, which the built artifact does not contain; it is listed without a page link"]);
});

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { normalizeSections, createSectionSeed, validateSectionSeed } from "../templates/emdash/site/src/lib/articles/sections.mjs";
import { mergeSectionEntries } from "../templates/emdash/site/src/lib/articles/mixed.mjs";
import { renderWorkspaceDesign, virtualModuleSource } from "../templates/emdash/site-workspace/src/integrations/design-system.mjs";

const declaration = { schemaVersion: 1, sections: ["articles", "guides", "recipes"].map((collection) => ({ collection, prefix: `/${collection}/`, label: collection, singularLabel: collection, feed: true })) };
const sections = normalizeSections(declaration);

test("section seed shares one shape, validates every declaration, and preserves existing samples", async () => {
  const seed = JSON.parse(await fs.readFile(new URL("../templates/emdash/site/seed/seed.json", import.meta.url), "utf8"));
  const expanded = createSectionSeed(seed, sections);
  assert.equal(validateSectionSeed(expanded, sections), true);
  assert.deepEqual(expanded.content.articles, seed.content.articles);
  assert.equal(expanded.content.guides[0].slug, "example-article");
  assert.notEqual(expanded.content.guides[0].id, expanded.content.recipes[0].id);
  assert.deepEqual(expanded.collections.map((item) => item.urlPattern), sections.map((item) => item.urlPattern));
  assert.deepEqual(expanded.taxonomies[0].collections, ["articles", "guides", "recipes"]);
  assert.deepEqual(createSectionSeed(expanded, sections), expanded);
  const guidesOnly = sections.slice(1, 2);
  assert.equal(validateSectionSeed(createSectionSeed(seed, guidesOnly), guidesOnly), true);
  assert.throws(() => normalizeSections({ schemaVersion: 1, sections: [] }), /between 1 and 16/);
  for (const prefix of ["/topics/", "/api/", "/site/", "/_emdash/", "/src/", "/docs/", "/seed/", "/public/", "/dist/", "/one/two/", "/guides", "/guides/?a", "/sitemap-timds-pages/"]) assert.throws(() => normalizeSections({ schemaVersion: 1, sections: [{ ...declaration.sections[0], prefix }] }), /prefix/);
  assert.throws(() => normalizeSections({ schemaVersion: 1, sections: [{ ...declaration.sections[0], collection: "with-hyphens" }] }), /slug/);
  for (const collection of ["content", "media", "users", "revisions", "taxonomies", "options", "audit_logs", "reorder", "relations", "sitemap_timds_pages"]) assert.throws(() => normalizeSections({ schemaVersion: 1, sections: [{ ...declaration.sections[0], collection }] }), /slug/);
  assert.throws(() => normalizeSections({ ...declaration, future: true }), /schemaVersion/);
  assert.throws(() => normalizeSections({ schemaVersion: 1, sections: [{ ...declaration.sections[0], future: true }] }), /slug/);
  const drift = structuredClone(expanded);
  drift.collections[1].supports = ["drafts"];
  assert.throws(() => validateSectionSeed(drift, sections), /guides.*supports/);
});

test("mixed topic and latest lists carry an opaque position per collection past twenty entries", async () => {
  const records = Object.fromEntries(sections.map((section, column) => [section.collection, Array.from({ length: 31 }, (_, index) => ({ id: `${section.collection}-${index}`, data: { id: `${section.collection}-${index}`, publishedAt: new Date(Date.UTC(2026, 0, 31 - Math.floor((index * 3 + column) / 4))) }, topic: index % 2 === 0 ? "example-topic" : "elsewhere" }))]));
  const query = async (collection, filter) => {
    assert.equal(filter.limit, 1);
    const source = records[collection].filter((entry) => !filter.where || entry.topic === filter.where.topic);
    const index = filter.cursor ? source.findIndex((entry) => entry.id === filter.cursor) + 1 : 0;
    const entry = source[index];
    return { entries: entry ? [entry] : [], nextCursor: entry && index + 1 < source.length ? entry.id : undefined, cacheHint: { tags: [collection] } };
  };
  for (const topic of [undefined, "example-topic"]) {
    const output = [];
    let cursor;
    do {
      const page = await mergeSectionEntries(sections, query, { cursor, topic });
      assert.ok(page.entries.length <= 20);
      assert.ok(page.cacheHints.every((hint) => hint.tags.length));
      output.push(...page.entries);
      cursor = page.nextCursor;
    } while (cursor);
    const expected = Object.values(records).flat().filter((entry) => !topic || entry.topic === topic);
    assert.equal(output.length, expected.length);
    assert.equal(new Set(output.map(({ entry }) => entry.id)).size, expected.length);
    assert.ok(output.every(({ entry }, index) => !index || output[index - 1].entry.data.publishedAt >= entry.data.publishedAt));
    assert.ok(output.every(({ entry, section }) => entry.id.startsWith(section.collection)));
  }
  const first = await mergeSectionEntries(sections, query);
  await assert.rejects(mergeSectionEntries(sections, query, { cursor: first.nextCursor, topic: "example-topic" }), /Invalid article page cursor/);
  await assert.rejects(mergeSectionEntries(sections, query, { cursor: "broken" }), /Invalid article page cursor/);
  await assert.rejects(mergeSectionEntries(sections, async () => ({ entries: [], error: new Error("Missing collection") })), /Missing collection/);
});

test("declared prefixes exclude design samples and expose exactly the same build inventory", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "timds-section-design-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "src/designs/website");
  await fs.mkdir(path.join(directory, "pages/guides"), { recursive: true });
  await fs.writeFile(path.join(root, "timds.json"), JSON.stringify({ name: "Sample", systemId: "sample/core" }));
  await fs.writeFile(path.join(directory, "design.json"), JSON.stringify({ title: "Website" }));
  for (const file of ["index", "articles", "guides/index", "guides/example-article", "recipes", "topics"]) await fs.writeFile(path.join(directory, "pages", `${file}.html`), `<h1>${file}</h1>`);
  const rendered = renderWorkspaceDesign(root, { design: "website", sections });
  assert.deepEqual(rendered.pages.map((page) => page.route), ["/"]);
  const single = renderWorkspaceDesign(root, { design: "website", sections: sections.slice(1, 2) });
  assert.deepEqual(single.pages.map((page) => page.route), ["/", "/articles", "/recipes"]);
  const module = await import(`data:text/javascript,${encodeURIComponent(virtualModuleSource(rendered, new Map(), root, { sectionsContract: 1, sections, sectionSchema: { fields: [] } }))}`);
  assert.deepEqual(module.sections, sections);
  assert.equal(module.sectionsContract, 1);
});

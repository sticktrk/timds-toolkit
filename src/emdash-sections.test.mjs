import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { normalizeSections, normalizeSectionSchema, sectionSchemaFor, createSectionSeed, validateSectionSeed } from "../templates/emdash/site/src/lib/articles/sections.mjs";
import { mergeSectionEntries } from "../templates/emdash/site/src/lib/articles/mixed.mjs";
import { renderWorkspaceDesign, virtualModuleSource } from "../templates/emdash/site-workspace/src/integrations/design-system.mjs";
import { sectionRouteInventory } from "../templates/emdash/site-workspace/src/integrations/section-routes.mjs";

const declaration = { schemaVersion: 2, sections: ["articles", "guides", "recipes"].map((collection) => ({ collection, prefix: `/${collection}/`, label: collection, singularLabel: collection, feed: true })) };
const sections = normalizeSections(declaration);
const model = JSON.parse(await fs.readFile(new URL("../templates/emdash/site/section-schema.json", import.meta.url), "utf8"));

test("section seed shares one shape, validates every declaration, and preserves existing samples", async () => {
  const seed = JSON.parse(await fs.readFile(new URL("../templates/emdash/site/seed/seed.json", import.meta.url), "utf8"));
  const expanded = createSectionSeed(seed, sections, model);
  assert.equal(validateSectionSeed(expanded, sections, model), true);
  assert.deepEqual(expanded.content.articles, seed.content.articles);
  assert.equal(expanded.content.guides[0].slug, "example-article");
  assert.notEqual(expanded.content.guides[0].id, expanded.content.recipes[0].id);
  assert.deepEqual(expanded.collections.map((item) => item.urlPattern), sections.map((item) => item.urlPattern));
  assert.deepEqual(expanded.taxonomies[0].collections, ["articles", "guides", "recipes"]);
  assert.deepEqual(createSectionSeed(expanded, sections, model), expanded);
  const guidesOnly = sections.slice(1, 2);
  assert.throws(() => createSectionSeed(seed, guidesOnly, model), /Remove undeclared seed collections/);
  const removed = { ...seed, collections: [], content: {} };
  assert.equal(validateSectionSeed(createSectionSeed(removed, guidesOnly, model), guidesOnly, model), true);
  assert.throws(() => normalizeSections({ schemaVersion: 2, sections: [] }), /between 1 and 16/);
  for (const prefix of ["/topics/", "/api/", "/site/", "/_emdash/", "/src/", "/docs/", "/seed/", "/public/", "/dist/", "/guides", "/guides/?a", "/sitemap-timds-pages/", "/cdn-cgi/"]) assert.throws(() => normalizeSections({ schemaVersion: 2, sections: [{ ...declaration.sections[0], prefix }] }), /prefix/);
  assert.throws(() => normalizeSections({ schemaVersion: 2, sections: [{ ...declaration.sections[0], collection: "with-hyphens" }] }), /slug/);
  for (const collection of ["content", "media", "users", "revisions", "taxonomies", "options", "audit_logs", "reorder", "relations", "sitemap_timds_pages"]) assert.throws(() => normalizeSections({ schemaVersion: 2, sections: [{ ...declaration.sections[0], collection }] }), /slug/);
  assert.throws(() => normalizeSections({ ...declaration, future: true }), /schemaVersion/);
  assert.throws(() => normalizeSections({ schemaVersion: 2, sections: [{ ...declaration.sections[0], future: true }] }), /slug/);
  const drift = structuredClone(expanded);
  drift.collections[1].supports = ["drafts"];
  assert.throws(() => validateSectionSeed(drift, sections, model), /guides.*supports/);
  const authored = structuredClone(expanded);
  authored.collections[0].hidden = true;
  authored.taxonomies[0].description = "Authored topic guidance";
  authored.taxonomies[0].label = "Sujets";
  authored.taxonomies[0].labelSingular = "Sujet";
  authored.taxonomies[0].locale = "fr";
  authored.taxonomies[0].translationGroup = "topic-translations";
  authored.taxonomies.push({ name: "category", label: "Categories", labelSingular: "Category", hierarchical: false, collections: ["articles"], terms: [{ slug: "news", label: "News" }] });
  assert.equal(validateSectionSeed(authored, sections, model), true);
  assert.deepEqual(createSectionSeed(authored, sections, model), authored);
  authored.taxonomies.reverse();
  assert.equal(validateSectionSeed(authored, sections, model), true);
  assert.deepEqual(createSectionSeed(authored, sections, model), authored);
});

test("shared section schema accepts bounded field data and rejects definitions the creation API cannot preserve", () => {
  const field = { slug: "reading_time", label: "Reading time", type: "integer", defaultValue: 0, validation: { min: 0, max: 120 }, indexed: true };
  const custom = { ...model, fields: [...model.fields, field] };
  assert.deepEqual(normalizeSectionSchema(custom), custom);
  assert.deepEqual(sectionSchemaFor(sections, custom).fields, custom.fields);
  for (const changed of [
    { slug: "id" }, { slug: "locale" }, { slug: "translation_group" }, { slug: "rowid" }, { slug: "oid" }, { type: "reference" }, { type: "blocks" }, { type: "repeater" },
    { required: "yes" }, { sortOrder: 0 }, { type: "text", indexed: true },
    { validation: { min: "0" } }, { validation: { min: 10, max: 1 } },
    { validation: { pattern: "[" } }, { validation: { unknown: true } },
    { defaultValue: "not a number" }, { options: { constructor: "unsafe" } },
  ]) assert.throws(() => normalizeSectionSchema({ ...custom, fields: [...model.fields, { ...field, ...changed }] }), /section-schema.json/);
  assert.throws(() => normalizeSectionSchema({ ...custom, supports: ["drafts", "drafts"] }), /section-schema.json/);
  assert.throws(() => sectionSchemaFor(Array(16).fill(sections[0]), custom), /at most 64/);
  const multilingual = { ...model, fields: Array.from({ length: 4 }, (_, i) => ({ slug: `field_${i}`, label: "Text", type: "string", options: { labels: Array(4).fill("界".repeat(4000)) } })) };
  assert.ok(JSON.stringify(multilingual).length < 64 * 1024);
  assert.throws(() => normalizeSectionSchema(multilingual), /section-schema.json/);
  const inventoryModel = { ...model, fields: [{ slug: "body", label: "Text", type: "string", options: { label: "界".repeat(4000), other: "界".repeat(4000), last: "界".repeat(4000), fourth: "界".repeat(4000), fifth: "界".repeat(4000) } }] };
  assert.doesNotThrow(() => normalizeSectionSchema(inventoryModel));
  const labeled = Array.from({ length: 16 }, (_, i) => ({ ...sections[0], collection: `section_${i}`, prefix: `/section-${i}/`, label: "界".repeat(120), singularLabel: "界".repeat(120) }));
  assert.throws(() => sectionSchemaFor(labeled, inventoryModel), /section-schema.json/);
});

test("section sync restores routable collections and checks reject a false seed before setup", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "timds-routable-seed-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.cp(new URL("../templates/emdash/site/", import.meta.url), directory, { recursive: true });
  const file = path.join(directory, "seed/seed.json");
  const seed = JSON.parse(await fs.readFile(file, "utf8"));
  const declared = normalizeSections(JSON.parse(await fs.readFile(path.join(directory, "sections.json"), "utf8")));
  delete seed.collections[0].routable;
  assert.equal(validateSectionSeed(seed, declared, model), true, "an absent value uses EmDash's true default");
  seed.collections[0].routable = false;
  assert.throws(() => validateSectionSeed(seed, declared, model), /articles must be routable/);
  await fs.writeFile(file, JSON.stringify(seed));
  execFileSync(process.execPath, ["scripts/sections.mjs"], { cwd: directory });
  const synchronized = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(synchronized.collections[0].routable, true);
  assert.equal(validateSectionSeed(synchronized, declared, model), true);
  assert.deepEqual(synchronized.content, seed.content);
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

test("nested section prefixes require the current contract and reject ambiguous address namespaces", () => {
  const section = { collection: "lease_faq", prefix: "/commercial-division/lease-faq/", label: "Lease FAQs", singularLabel: "Lease FAQ", feed: true };
  const nested = { schemaVersion: 2, sections: [section] };
  assert.equal(normalizeSections(nested)[0].urlPattern, "/commercial-division/lease-faq/{slug}/");
  assert.throws(() => normalizeSections({ ...nested, schemaVersion: 1 }), /schemaVersion 2/);
  for (const prefix of ["/commercial-division//lease-faq/", "/commercial-division/../lease-faq/", "/commercial-division/%6cease-faq/", "/commercial-division/lease-faq%2f/", "/commercial-division/topics/", "/commercial-division/src/", "/Commercial-division/lease-faq/", "/commercial-division/lease-faq/\n", `/${"a".repeat(99)}/`]) assert.throws(() => normalizeSections({ ...nested, sections: [{ ...section, prefix }] }), /prefix/);
  for (const pair of [["/commercial-division/", section.prefix], [section.prefix, "/commercial-division/"], [section.prefix, section.prefix]]) assert.throws(() => normalizeSections({ schemaVersion: 2, sections: pair.map((prefix, index) => ({ ...section, collection: `section_${index}`, prefix })) }), /overlap|distinct/);
  assert.equal(normalizeSections({ schemaVersion: 2, sections: [section, { ...section, collection: "leasing", prefix: "/commercial-division/leasing/" }] }).length, 2);
});

test("one nested route inventory keeps public parent pages and explicit reference samples separate", async (t) => {
  const sections = normalizeSections({ schemaVersion: 2, sections: [{ collection: "lease_faq", prefix: "/commercial-division/lease-faq/", label: "Lease FAQs", singularLabel: "Lease FAQ", feed: true }] });
  const routes = ["/", "/commercial-division", "/commercial-division/about", "/articles", "/articles/example-article", "/commercial-division/lease-faq", "/commercial-division/lease-faq/example-article"];
  const pages = routes.map((route) => ({ route, ...(route.includes("/lease-faq") ? { site: "reference" } : {}) }));
  const inventory = sectionRouteInventory(sections, pages);
  assert.deepEqual(inventory.pages.map((page) => page.route), routes.slice(0, 3));
  assert.equal(inventory.sections[0].entry, "/commercial-division/lease-faq/[slug]");
  assert.equal(inventory.sections[0].feed, "/commercial-division/lease-faq/rss.xml");
  assert.throws(() => sectionRouteInventory(sections, [...pages, { route: "/commercial-division/lease-faq/how-to-lease-building" }]), /conflicts.*namespace/);
  assert.throws(() => sectionRouteInventory(sections, [{ route: "/commercial-division/lease-faq" }]), /conflicts.*namespace/);
  for (const file of ["src/pages/commercial-division/lease-faq/index.astro", "src/pages/commercial-division/lease-faq/[slug].astro", "src/pages/commercial-division/lease-faq/help.markdown", "src/pages/commercial-division/lease-faq/.well-known/example.ts", "src/pages/commercial-division/[slug].astro", "src/pages/[...custom].astro"]) assert.throws(() => sectionRouteInventory(sections, pages, { pageFiles: [file] }), /Site page.*conflicts/);
  assert.doesNotThrow(() => sectionRouteInventory(sections, pages, { pageFiles: ["src/pages/[...page].astro", "src/pages/topics/[slug].astro", "src/pages/commercial-division/about.astro", "src/pages/commercial-division/lease-faq/helper.mjs"] }));
  const resolvedRoutes = [
    { origin: "project", pattern: "/[...page]", entrypoint: "src/pages/[...page].astro" },
    { origin: "project", pattern: "/topics/[slug]", entrypoint: "src/pages/topics/[slug].astro" },
    { origin: "external", pattern: "/commercial-division/lease-faq", entrypoint: "src/routes/articles/index.astro" },
    { origin: "external", pattern: "/commercial-division/lease-faq/[slug]", entrypoint: "src/routes/articles/entry.astro" },
    { origin: "external", pattern: "/commercial-division/lease-faq/rss.xml", entrypoint: "src/routes/articles/rss.xml.ts" },
  ];
  assert.doesNotThrow(() => sectionRouteInventory(sections, pages, { resolvedRoutes }));
  for (const pattern of ["/commercial-division/lease-faq", "/commercial-division/lease-faq/how-to-lease-building", "/topics/[slug]"]) {
    assert.throws(() => sectionRouteInventory(sections, pages, { resolvedRoutes: [...resolvedRoutes, { origin: "external", pattern, entrypoint: "foreign.astro" }] }), /Site route.*conflicts/);
  }
  assert.throws(() => sectionRouteInventory(sections, pages, { resolvedRoutes: [{ origin: "external", pattern: "/topics/override", entrypoint: "src/routes/articles/index.astro" }] }), /Site route.*conflicts/);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "timds-nested-design-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "src/designs/website");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(root, "timds.json"), JSON.stringify({ name: "Sample", systemId: "sample/core" }));
  await fs.writeFile(path.join(directory, "design.json"), JSON.stringify({ title: "Website", pages: { ...Object.fromEntries(pages.filter((page) => page.site).map((page) => [page.route, { title: "Reference", site: page.site }])), a: { title: "Short reference", site: "reference" } } }));
  for (const route of [...routes, "/a"]) {
    const file = path.join(directory, "pages", route === "/" ? "index.html" : `${route.slice(1)}.html`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `<h1>${route}</h1>`);
  }
  const { readDesignCatalog } = await import("./designs.mjs");
  const catalog = await readDesignCatalog(root);
  assert.equal(catalog.designs[0].pages.find((page) => page.route === "/commercial-division/lease-faq").site, "reference");
  const rendered = renderWorkspaceDesign(root, { design: "website", sections, sectionsContract: 2 });
  assert.deepEqual(rendered.pages.map((page) => page.route).sort(), inventory.pages.map((page) => page.route).sort());
});

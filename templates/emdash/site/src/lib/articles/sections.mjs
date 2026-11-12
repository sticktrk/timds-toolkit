/** The section contract is data only, shared by the seed, routes and build inventory. */
const RESERVED = new Set(["topics", "api", "site", "assets", "styles", "scripts", "sitemap-timds-pages"]);
const RESERVED_COLLECTIONS = new Set(["content", "media", "users", "revisions", "taxonomies", "options", "audit_logs", "reorder", "relations", "sitemap_timds_pages"]);
const keys = (value, allowed) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => allowed.includes(key));
const COLLECTION = /^[a-z][a-z0-9_]{0,62}$/;
const PREFIX = /^\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/$/;
export const ARTICLE_FIELDS = [
  { slug: "title", label: "Title", type: "string", required: true, searchable: true },
  { slug: "summary", label: "Summary", type: "text", searchable: true },
  { slug: "body", label: "Body", type: "portableText", searchable: true },
  { slug: "cover", label: "Cover", type: "image" },
];
export const ARTICLE_SUPPORTS = ["drafts", "revisions", "preview", "scheduling", "search", "seo"];

export function normalizeSections(document) {
  if (!keys(document, ["schemaVersion", "sections"]) || document?.schemaVersion !== 1 || !Array.isArray(document.sections) || document.sections.length < 1 || document.sections.length > 16) throw new Error("sections.json must declare schemaVersion 1 and between 1 and 16 sections.");
  const collections = new Set(), prefixes = new Set();
  return document.sections.map((section) => {
    if (!keys(section, ["collection", "prefix", "label", "singularLabel", "feed"]) || typeof section.collection !== "string" || !COLLECTION.test(section.collection) || RESERVED_COLLECTIONS.has(section.collection)) throw new Error("A section collection must be an EmDash slug of at most 63 characters (lowercase letters, digits and underscores).");
    if (typeof section.prefix !== "string" || section.prefix.length > 100 || !PREFIX.test(section.prefix) || RESERVED.has(section.prefix.slice(1, -1))) throw new Error("A section prefix must be a non-reserved single path segment, such as /guides/.");
    if (collections.has(section.collection) || prefixes.has(section.prefix)) throw new Error("Sections must have distinct collection slugs and address prefixes.");
    for (const key of ["label", "singularLabel"]) if (typeof section[key] !== "string" || !section[key].trim() || section[key].length > 120 || /[\u0000-\u001f\u007f]/.test(section[key])) throw new Error("Section labels must be nonempty text of at most 120 characters.");
    if (typeof section.feed !== "boolean") throw new Error("Each section must declare feed as true or false.");
    collections.add(section.collection); prefixes.add(section.prefix);
    return { collection: section.collection, prefix: section.prefix, label: section.label, singularLabel: section.singularLabel, feed: section.feed, urlPattern: `${section.prefix}{slug}/` };
  });
}

export function sectionSchemaFor(sections) {
  return structuredClone({ fields: ARTICLE_FIELDS, supports: ARTICLE_SUPPORTS, taxonomies: [{ name: "topic", label: "Topics", labelSingular: "Topic", hierarchical: false, collections: sections.map((section) => section.collection) }] });
}

export function isSectionRoute(route, sections) {
  return route === "/topics" || route.startsWith("/topics/") || sections.some(({ prefix }) => route === prefix.slice(0, -1) || route.startsWith(prefix));
}

export function createSectionSeed(seed, sections) {
  const schema = sectionSchemaFor(sections);
  const currentTopics = seed.taxonomies?.find((taxonomy) => taxonomy.name === "topic");
  const source = Object.entries(seed.content ?? {}).find(([_collection, entries]) => entries.some((entry) => entry.slug === "example-article"));
  const sample = source?.[1].find((entry) => entry.slug === "example-article");
  const contentFor = (section) => {
    if (Object.hasOwn(seed.content ?? {}, section.collection)) return seed.content[section.collection];
    if (!sample) return [];
    const sourcePrefix = seed.collections?.find((collection) => collection.slug === source[0])?.urlPattern?.replace(/\{slug\}\/$/, "") ?? `/${source[0]}/`;
    const copied = JSON.parse(JSON.stringify(sample).replaceAll(sourcePrefix, section.prefix));
    copied.id = `${section.collection}-sample`;
    return [copied];
  };
  return {
    ...seed,
    collections: sections.map((section) => ({ slug: section.collection, label: section.label, labelSingular: section.singularLabel, description: `Published ${section.label.toLowerCase()}, rendered at ${section.prefix}<slug>/.`, urlPattern: section.urlPattern, supports: structuredClone(schema.supports), fields: structuredClone(schema.fields) })),
    taxonomies: schema.taxonomies.map((taxonomy) => ({ ...taxonomy, ...(currentTopics?.terms ? { terms: currentTopics.terms } : {}) })),
    content: Object.fromEntries(sections.map((section) => [section.collection, contentFor(section)])),
  };
}

const stable = (value) => JSON.stringify(value, function (_key, item) { return item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item; });
export function validateSectionSeed(seed, sections) {
  const expected = createSectionSeed(seed, sections);
  const actual = seed.collections ?? [];
  if (stable(actual.map((collection) => collection.slug).sort()) !== stable(sections.map((section) => section.collection).sort())) throw new Error("sections.json and seed/seed.json declare different collections; run npm run sections:sync.");
  for (const collection of expected.collections) {
    const stored = actual.find((item) => item.slug === collection.slug);
    for (const key of ["urlPattern", "supports", "fields", "label", "labelSingular"]) if (stable(stored?.[key]) !== stable(collection[key])) throw new Error(`Section ${collection.slug} has a different ${key} in seed/seed.json; run npm run sections:sync.`);
  }
  const topic = seed.taxonomies?.find((taxonomy) => taxonomy.name === "topic");
  if (!topic || stable([...(topic.collections ?? [])].sort()) !== stable(sections.map((section) => section.collection).sort())) throw new Error("The seed topic taxonomy must attach to every declared section; run npm run sections:sync.");
  for (const key of ["label", "labelSingular", "hierarchical"]) if (stable(topic[key]) !== stable(expected.taxonomies[0][key])) throw new Error(`The seed topic taxonomy has a different ${key}; run npm run sections:sync.`);
  for (const key of Object.keys(seed.content ?? {})) if (!sections.some((section) => section.collection === key)) throw new Error(`Seed content names undeclared collection ${key}.`);
  return true;
}

export function writerSectionTable(sections) {
  return ["<!-- timds:sections -->", "| Collection | Entry address | Feed |", "| --- | --- | --- |", ...sections.map((section) => `| \`${section.collection}\` | \`${section.urlPattern}\` | ${section.feed ? `\`${section.prefix}rss.xml\`` : "None"} |`), "<!-- /timds:sections -->"].join("\n");
}

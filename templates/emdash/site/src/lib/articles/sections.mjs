/** The section contract is data only, shared by the seed, routes and build inventory. */
const RESERVED = new Set(["topics", "api", "site", "assets", "styles", "scripts", "src", "docs", "seed", "public", "dist", "sitemap-timds-pages", "cdn-cgi"]);
const RESERVED_COLLECTIONS = new Set(["content", "media", "users", "revisions", "taxonomies", "options", "audit_logs", "reorder", "relations", "sitemap_timds_pages"]);
const keys = (value, allowed) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => allowed.includes(key));
const COLLECTION = /^[a-z][a-z0-9_]{0,62}$/;
const NESTED_PREFIX = /^(?:\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+\/$/;
const RESERVED_FIELDS = new Set(["id", "slug", "status", "locale", "translation_group", "rowid", "oid", "author_id", "primary_byline_id", "created_at", "updated_at", "published_at", "scheduled_at", "deleted_at", "version", "live_revision_id", "draft_revision_id", "terms", "bylines", "byline"]);
const FIELD_TYPES = new Set(["string", "text", "url", "number", "integer", "boolean", "datetime", "select", "multiSelect", "portableText", "image", "file", "json", "slug"]);
const INDEXED_TYPES = new Set(["string", "url", "number", "integer", "boolean", "datetime", "select", "slug"]);
const TEXT_TYPES = new Set(["string", "text", "url", "datetime", "select", "slug"]);
const SUPPORTS = new Set(["drafts", "revisions", "preview", "scheduling", "search", "seo"]);
const record = (value) => value && typeof value === "object" && !Array.isArray(value);
const label = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= 120 && !/[\x00-\x1f\x7f]/.test(value);
const strings = (value, max = 100) => Array.isArray(value) && value.length <= max && value.every((item) => typeof item === "string" && item.length <= 4096);
const jsonValue = (value, depth = 0) => depth <= 8 && (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) || typeof value === "string" && value.length <= 4096 || Array.isArray(value) && value.length <= 100 && value.every((item) => jsonValue(item, depth + 1)) || record(value) && Object.keys(value).length <= 100 && Object.entries(value).every(([key, item]) => key.length <= 120 && !["__proto__", "constructor", "prototype"].includes(key) && jsonValue(item, depth + 1)));
const invalidSchema = () => { throw new Error("section-schema.json must declare schemaVersion 1, supported shared fields and features within the section contract limits."); };

/** Data read by checks and site runtime alike; no site code runs during consumer check. */
export function normalizeSectionSchema(document) {
  if (!keys(document, ["schemaVersion", "fields", "supports"]) || document.schemaVersion !== 1 || !Array.isArray(document.fields) || !document.fields.length || document.fields.length > 32 || !Array.isArray(document.supports) || !document.supports.length || document.supports.some((item) => !SUPPORTS.has(item)) || new Set(document.supports).size !== document.supports.length) invalidSchema();
  const names = new Set();
  for (const [index, field] of document.fields.entries()) {
    if (!keys(field, ["slug", "label", "type", "required", "unique", "defaultValue", "validation", "widget", "options", "sortOrder", "searchable", "indexed", "translatable"]) || typeof field.slug !== "string" || !COLLECTION.test(field.slug) || RESERVED_FIELDS.has(field.slug) || names.has(field.slug) || !label(field.label) || !FIELD_TYPES.has(field.type)) invalidSchema();
    for (const key of ["required", "unique", "searchable", "indexed", "translatable"]) if (field[key] !== undefined && typeof field[key] !== "boolean") invalidSchema();
    // EmDash's seed assigns array order even when a field supplies sortOrder.
    if (field.sortOrder !== undefined && field.sortOrder !== index || field.indexed && !INDEXED_TYPES.has(field.type) || field.widget !== undefined && !label(field.widget) || field.options !== undefined && (!record(field.options) || !jsonValue(field.options))) invalidSchema();
    if (field.defaultValue !== undefined) {
      const value = field.defaultValue;
      if (value === null ? field.required === true : TEXT_TYPES.has(field.type) ? typeof value !== "string" || value.length > 4096 : field.type === "number" ? !Number.isFinite(value) : field.type === "integer" ? !Number.isSafeInteger(value) : field.type === "boolean" ? typeof value !== "boolean" : field.type === "multiSelect" ? !strings(value) : true) invalidSchema();
    }
    const validation = field.validation;
    if (validation !== undefined && validation !== null) {
      if (!keys(validation, ["required", "min", "max", "minLength", "maxLength", "pattern", "options", "minItems", "maxItems", "allowedMimeTypes"])) invalidSchema();
      if (validation.required !== undefined && typeof validation.required !== "boolean") invalidSchema();
      for (const key of ["min", "max"]) if (validation[key] !== undefined && !Number.isFinite(validation[key])) invalidSchema();
      for (const key of ["minLength", "maxLength", "minItems", "maxItems"]) if (validation[key] !== undefined && (!Number.isSafeInteger(validation[key]) || validation[key] < (key === "maxItems" ? 1 : 0))) invalidSchema();
      for (const [min, max] of [["min", "max"], ["minLength", "maxLength"], ["minItems", "maxItems"]]) if (validation[min] !== undefined && validation[max] !== undefined && validation[min] > validation[max]) invalidSchema();
      if (validation.pattern !== undefined) { if (typeof validation.pattern !== "string" || validation.pattern.length > 4096) invalidSchema(); try { new RegExp(validation.pattern); } catch { invalidSchema(); } }
      if (validation.options !== undefined && !strings(validation.options)) invalidSchema();
      if (validation.allowedMimeTypes !== undefined && (!strings(validation.allowedMimeTypes, 64) || !validation.allowedMimeTypes.length || validation.allowedMimeTypes.some((value) => !/^[a-z0-9][a-z0-9!#$&^_+\-.]*\/[a-z0-9!#$&^_+\-.]*$/i.test(value)))) invalidSchema();
    }
    names.add(field.slug);
  }
  if (new TextEncoder().encode(JSON.stringify(document)).byteLength > 64 * 1024) invalidSchema();
  return structuredClone(document);
}

export function normalizeSections(document) {
  if (!keys(document, ["schemaVersion", "sections"]) || document?.schemaVersion !== 2 || !Array.isArray(document.sections) || document.sections.length < 1 || document.sections.length > 16) throw new Error("sections.json must declare schemaVersion 2 and between 1 and 16 sections.");
  const collections = new Set(), prefixes = new Set();
  return document.sections.map((section) => {
    if (!keys(section, ["collection", "prefix", "label", "singularLabel", "feed"]) || typeof section.collection !== "string" || !COLLECTION.test(section.collection) || RESERVED_COLLECTIONS.has(section.collection)) throw new Error("A section collection must be an EmDash slug of at most 63 characters (lowercase letters, digits and underscores).");
    if (typeof section.prefix !== "string" || section.prefix.length > 100 || !section.prefix.endsWith("/") || !NESTED_PREFIX.test(section.prefix) || section.prefix.slice(1, -1).split("/").some((segment) => RESERVED.has(segment))) throw new Error("A version 2 section prefix must contain non-reserved literal path segments and at most 100 characters, such as /commercial-division/lease-faq/.");
    if (collections.has(section.collection) || prefixes.has(section.prefix)) throw new Error("Sections must have distinct collection slugs and address prefixes.");
    if ([...prefixes].some((prefix) => prefix.startsWith(section.prefix) || section.prefix.startsWith(prefix))) throw new Error("Section prefixes must not overlap: one collection cannot contain another collection's address prefix.");
    for (const key of ["label", "singularLabel"]) if (typeof section[key] !== "string" || !section[key].trim() || section[key].length > 120 || /[\u0000-\u001f\u007f]/.test(section[key])) throw new Error("Section labels must be nonempty text of at most 120 characters.");
    if (typeof section.feed !== "boolean") throw new Error("Each section must declare feed as true or false.");
    collections.add(section.collection); prefixes.add(section.prefix);
    return { collection: section.collection, prefix: section.prefix, label: section.label, singularLabel: section.singularLabel, feed: section.feed, urlPattern: `${section.prefix}{slug}/` };
  });
}

export function sectionSchemaFor(sections, model) {
  const { fields, supports } = normalizeSectionSchema(model);
  if (sections.length * fields.length > 144) throw new Error("Sections may declare at most 144 collection fields in total.");
  const sectionSchema = { fields, supports, taxonomies: [{ name: "topic", label: "Topics", labelSingular: "Topic", hierarchical: false, collections: sections.map((section) => section.collection) }] };
  if (new TextEncoder().encode(JSON.stringify({ sections, sectionSchema })).byteLength > 64 * 1024) invalidSchema();
  return structuredClone(sectionSchema);
}

export function isSectionRoute(route, sections) {
  return route === "/topics" || route.startsWith("/topics/") || sections.some(({ prefix }) => route === prefix.slice(0, -1) || route.startsWith(prefix));
}

export function createSectionSeed(seed, sections, model) {
  const schema = sectionSchemaFor(sections, model);
  const removed = [...new Set([...(seed.collections ?? []).map((collection) => collection.slug), ...Object.keys(seed.content ?? {})])].filter((slug) => !sections.some((section) => section.collection === slug));
  if (removed.length) throw new Error(`Remove undeclared seed collections and their development content explicitly before syncing: ${removed.join(", ")}. Deployed content is never moved or removed.`);
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
    collections: sections.map((section) => ({ description: `Published ${section.label.toLowerCase()}, rendered at ${section.prefix}<slug>/.`, ...seed.collections?.find((collection) => collection.slug === section.collection), slug: section.collection, label: section.label, labelSingular: section.singularLabel, routable: true, urlPattern: section.urlPattern, supports: structuredClone(schema.supports), fields: structuredClone(schema.fields) })),
    taxonomies: [...(seed.taxonomies ?? []).map((taxonomy) => taxonomy.name === "topic" ? { ...taxonomy, hierarchical: schema.taxonomies[0].hierarchical, collections: [...schema.taxonomies[0].collections] } : taxonomy), ...(!currentTopics ? schema.taxonomies : [])],
    content: Object.fromEntries(sections.map((section) => [section.collection, contentFor(section)])),
  };
}

const stable = (value) => JSON.stringify(value, function (_key, item) { return item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item; });
export function validateSectionSeed(seed, sections, model) {
  const actual = seed.collections ?? [];
  if (stable(actual.map((collection) => collection.slug).sort()) !== stable(sections.map((section) => section.collection).sort())) throw new Error("sections.json and seed/seed.json declare different collections; run npm run sections:sync.");
  const expected = createSectionSeed(seed, sections, model);
  for (const collection of expected.collections) {
    const stored = actual.find((item) => item.slug === collection.slug);
    if (stored.routable !== undefined && stored.routable !== true) throw new Error(`Section ${collection.slug} must be routable in seed/seed.json; run npm run sections:sync.`);
    for (const key of ["urlPattern", "supports", "fields", "label", "labelSingular"]) if (stable(stored?.[key]) !== stable(collection[key])) throw new Error(`Section ${collection.slug} has a different ${key} in seed/seed.json; run npm run sections:sync.`);
  }
  const topic = seed.taxonomies?.find((taxonomy) => taxonomy.name === "topic");
  if (!topic || stable([...(topic.collections ?? [])].sort()) !== stable(sections.map((section) => section.collection).sort())) throw new Error("The seed topic taxonomy must attach to every declared section; run npm run sections:sync.");
  const expectedTopic = expected.taxonomies.find((taxonomy) => taxonomy.name === "topic");
  for (const key of ["hierarchical"]) if (stable(topic[key]) !== stable(expectedTopic[key])) throw new Error(`The seed topic taxonomy has a different ${key}; run npm run sections:sync.`);
  for (const key of Object.keys(seed.content ?? {})) if (!sections.some((section) => section.collection === key)) throw new Error(`Seed content names undeclared collection ${key}.`);
  return true;
}

export function writerSectionTable(sections) {
  return ["<!-- timds:sections -->", "| Collection | Entry address | Feed |", "| --- | --- | --- |", ...sections.map((section) => `| \`${section.collection}\` | \`${section.urlPattern}\` | ${section.feed ? `\`${section.prefix}rss.xml\`` : "None"} |`), "<!-- /timds:sections -->"].join("\n");
}

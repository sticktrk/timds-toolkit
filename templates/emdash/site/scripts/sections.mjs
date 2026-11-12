/** Regenerate the checked-in seed schema and writer inventory from the section declarations. */
import { readFile, writeFile } from "node:fs/promises";
import { normalizeSections, normalizeSectionSchema, createSectionSeed, writerSectionTable } from "../src/lib/articles/sections.mjs";
const root = new URL("../", import.meta.url);
const sections = normalizeSections(JSON.parse(await readFile(new URL("sections.json", root), "utf8")));
const model = normalizeSectionSchema(JSON.parse(await readFile(new URL("section-schema.json", root), "utf8")));
const seedFile = new URL("seed/seed.json", root);
const seed = JSON.parse(await readFile(seedFile, "utf8"));
const nextSeed = createSectionSeed(seed, sections, model);
const document = new URL("docs/content-api.md", root);
const text = await readFile(document, "utf8");
const table = writerSectionTable(sections);
await writeFile(seedFile, `${JSON.stringify(nextSeed, null, 2)}\n`);
await writeFile(document, text.replace(/<!-- timds:sections -->[\s\S]*?<!-- \/timds:sections -->/, table));
console.log("Updated the section seed and writer inventory.");

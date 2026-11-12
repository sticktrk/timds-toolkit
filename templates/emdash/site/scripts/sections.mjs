/** Regenerate the checked-in seed schema and writer inventory after changing sections.json. */
import { readFile, writeFile } from "node:fs/promises";
import { normalizeSections, createSectionSeed, writerSectionTable } from "../src/lib/articles/sections.mjs";
const root = new URL("../", import.meta.url);
const sections = normalizeSections(JSON.parse(await readFile(new URL("sections.json", root), "utf8")));
const seedFile = new URL("seed/seed.json", root);
const seed = JSON.parse(await readFile(seedFile, "utf8"));
const removed = Object.keys(seed.content ?? {}).filter((slug) => !sections.some((section) => section.collection === slug) && seed.content[slug]?.length);
if (removed.length) throw new Error(`Move or remove development seed content for removed collections before syncing: ${removed.join(", ")}. Deployed content is never moved or removed.`);
await writeFile(seedFile, `${JSON.stringify(createSectionSeed(seed, sections), null, 2)}\n`);
const document = new URL("docs/content-api.md", root);
const text = await readFile(document, "utf8");
const table = writerSectionTable(sections);
await writeFile(document, text.replace(/<!-- timds:sections -->[\s\S]*?<!-- \/timds:sections -->/, table));
console.log("Updated the section seed and writer inventory.");

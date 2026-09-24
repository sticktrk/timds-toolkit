import assert from "node:assert/strict";
import test from "node:test";

import { annotationFor, buildBrandKit, eachBrandKitMedia, normalizeBrandGuidance, parseAnnotation, resolveGuidance } from "./brand.mjs";
import { parseHtml, findOne, walk } from "./html.mjs";

const parentsOf = (root) => {
  const parents = new Map();
  for (const node of [root, ...walk(root)]) for (const child of node.children ?? []) parents.set(child, node);
  return parents;
};

test("parses a role annotation with flags and qualifiers, lowercased", () => {
  const node = parseHtml('<img data-timds-role="Logo PRIMARY" data-timds-variant="White" data-timds-lockup="stacked" data-timds-on="dark" data-timds-tags="Print, web ,">').children[0];
  assert.deepEqual(parseAnnotation(node), { role: "logo", primary: true, variant: "white", lockup: "stacked", on: "dark", tags: ["print", "web"] });
  assert.equal(parseAnnotation(parseHtml('<img data-timds-role="">').children[0]), null);
  assert.equal(parseAnnotation(parseHtml('<img data-timds-role="9logo">').children[0]), null);
  assert.deepEqual(parseAnnotation(parseHtml('<img data-timds-role="logo tbd">').children[0]), { role: "logo" }); // unknown flags are ignored
  assert.deepEqual(parseAnnotation(parseHtml('<img data-timds-role="photo">').children[0]), { role: "photo" });
});

test("an asset inherits the nearest annotated wrapper's annotation", () => {
  const root = parseHtml('<section><div data-timds-role="logo" data-timds-on="light"><div class="cell"><img src="/a.svg"></div></div><figure data-timds-role="photo"><img src="/b.jpg" data-timds-role="illustration"></figure><img src="/c.png"></section>');
  const parents = parentsOf(root);
  const [a, b, c] = ["/a.svg", "/b.jpg", "/c.png"].map((src) => findOne(root, (node) => node.tag === "img" && node.attrs.src === src));
  assert.deepEqual(annotationFor(a, parents), { role: "logo", on: "light" });
  assert.deepEqual(annotationFor(b, parents), { role: "illustration" }); // the element's own annotation wins
  assert.equal(annotationFor(c, parents), null);
});

test("builds the kit from annotated assets, deduplicating by role and url, primary first", () => {
  const media = (url) => ({ url });
  const pages = [
    { id: "brand/logo", blocks: [
      { id: "brand/logo#family", assets: [
        { id: "brand/logo#family/white", name: "**White logo**", media: media("/white.svg"), brand: { role: "logo", variant: "white", on: "dark" } },
        { id: "brand/logo#family/colour", name: "Colour logo", media: media("/colour.svg"), lines: ["Default lockup"], brand: { role: "logo", variant: "colour", on: "light" } },
        { id: "brand/logo#family/plain", name: "Unannotated", media: media("/plain.svg") },
      ] },
      { id: "brand/logo#usage", assets: [
        { id: "brand/logo#usage/colour", name: "Colour logo again", media: media("/colour.svg"), brand: { role: "logo", primary: true, variant: "colour" } },
      ] },
    ] },
    { id: "marketing/photography", blocks: [
      { id: "marketing/photography#heroes", assets: [
        { id: "marketing/photography#heroes/porch", name: "Porch gathering", media: { key: "photo-porch", url: "https://cdn/porch.webp" }, brand: { role: "photo", tags: ["hero"] } },
      ] },
    ] },
  ];
  const tokens = { roles: { "color.accent": { token: "--accent", value: "#111", kind: "color", source: "convention" } }, missingRoles: ["font.ui"] };
  const { kit, warnings } = buildBrandKit({ manifest: { systemId: "s", name: "S", version: "1" }, tokens, pages });
  assert.deepEqual(warnings, ["guidance group voice is empty: no brand/voice page; declare it in timds.json brand.guidance.voice"]);
  assert.deepEqual(kit.system, { id: "s", name: "S", version: "1" });
  assert.deepEqual(kit.roles, tokens.roles);
  assert.deepEqual(kit.missingRoles, ["font.ui"]);
  assert.deepEqual(kit.logos.map((logo) => logo.name), ["Colour logo", "White logo"]);
  assert.equal(kit.logos[0].primary, true);
  assert.deepEqual(kit.logos[0].citations, ["brand/logo#family/colour", "brand/logo#usage/colour"]);
  assert.deepEqual(kit.logos[0].notes, ["Default lockup"]);
  assert.equal(kit.logos[0].page, "brand/logo");
  assert.equal(kit.logos[0].block, "brand/logo#family");
  assert.deepEqual(kit.imagery[0], {
    id: "marketing/photography#heroes/porch", name: "Porch gathering", role: "photo", tags: ["hero"],
    media: { key: "photo-porch", url: "https://cdn/porch.webp" }, page: "marketing/photography", block: "marketing/photography#heroes",
    citations: ["marketing/photography#heroes/porch"],
  });
  const urls = [];
  eachBrandKitMedia(kit, (entry) => urls.push(entry.url));
  assert.deepEqual(urls, ["/colour.svg", "/white.svg", "https://cdn/porch.webp"]);

  const empty = buildBrandKit({ manifest: { systemId: "s", name: "S", version: "1" }, tokens: {}, pages: [] });
  assert.deepEqual(empty.warnings, [
    "guidance group voice is empty: no brand/voice page; declare it in timds.json brand.guidance.voice",
    'no asset is annotated data-timds-role="logo"; the brand kit has no logo',
  ]);
  assert.deepEqual(empty.kit.roles, {});
  assert.deepEqual(empty.kit.guidance, {});
});

test("validates guidance groups from the manifest", () => {
  assert.deepEqual(normalizeBrandGuidance(undefined), {});
  assert.deepEqual(normalizeBrandGuidance({ voice: "brand/voice#clear", legal: ["social/compliance", " marketing/claims#rules "] }), {
    voice: ["brand/voice#clear"], legal: ["social/compliance", "marketing/claims#rules"],
  });
  assert.throws(() => normalizeBrandGuidance({ Voice: ["brand/voice"] }), /must be a lowercase name/);
  assert.throws(() => normalizeBrandGuidance({ voice: [] }), /must list at least one/);
  assert.throws(() => normalizeBrandGuidance({ voice: ["brand/voice#a b"] }), /must be page or page#block/);
  assert.throws(() => normalizeBrandGuidance("brand/voice"), /must be an object/);
});

test("fills guidance groups by convention and by manifest reference, with block markdown", () => {
  const pages = [
    { id: "brand/voice", blocks: [{ id: "brand/voice#clear", title: "Clear" }, { id: "brand/voice#warm", title: "Warm" }] },
    { id: "social/compliance", blocks: [{ id: "social/compliance#claims", title: "Claims" }] },
    { id: "compliance", blocks: [{ id: "compliance#general", title: "General" }] },
    { id: "social/shorts", blocks: [{ id: "social/shorts#authoring", title: "Authoring" }] },
  ];
  const render = (block) => `## ${block.title}\n`;
  const conventional = resolveGuidance(pages, {}, render);
  assert.deepEqual(conventional.errors, []);
  assert.deepEqual(conventional.warnings, []);
  assert.deepEqual(conventional.guidance.voice, {
    source: "convention",
    blocks: [
      { id: "brand/voice#clear", page: "brand/voice", title: "Clear", markdown: "## Clear\n" },
      { id: "brand/voice#warm", page: "brand/voice", title: "Warm", markdown: "## Warm\n" },
    ],
  });
  assert.deepEqual(conventional.guidance.compliance.blocks.map((block) => block.id), ["social/compliance#claims", "compliance#general"]);

  // A manifest group replaces the convention for that name; a whole page and a single block both resolve; duplicates collapse.
  const mapped = resolveGuidance(pages, { voice: ["brand/voice#clear", "social/shorts", "brand/voice#clear"], shorts: ["social/shorts#authoring"] });
  assert.equal(mapped.guidance.voice.source, "manifest");
  assert.deepEqual(mapped.guidance.voice.blocks.map((block) => block.id), ["brand/voice#clear", "social/shorts#authoring"]);
  assert.equal(mapped.guidance.voice.blocks[0].markdown, undefined);
  assert.equal(mapped.guidance.shorts.blocks.length, 1);
  assert.equal(mapped.guidance.compliance.source, "convention");

  const broken = resolveGuidance(pages, { voice: ["brand/tone", "brand/voice#loud"] });
  assert.deepEqual(broken.errors, [
    "guidance group voice references brand/tone, but the artifact has no page brand/tone",
    "guidance group voice references brand/voice#loud, but page brand/voice has no block #loud",
  ]);
  assert.throws(
    () => buildBrandKit({ manifest: { systemId: "s", name: "S", version: "1", brand: { guidance: { voice: ["brand/tone"] } } }, tokens: {}, pages }),
    /brand\.guidance does not match the built pages/,
  );
});

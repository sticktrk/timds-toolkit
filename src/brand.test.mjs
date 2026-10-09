import assert from "node:assert/strict";
import test from "node:test";

import { annotationFor, buildBrandKit, eachBrandKitMedia, mediaFormat, normalizeBrandGuidance, parseAnnotation, resolveFontSources, resolveGuidance } from "./brand.mjs";
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
    id: "marketing/photography#heroes/porch", name: "Porch gathering", role: "photo", tags: ["hero"], format: "webp",
    media: { key: "photo-porch", url: "https://cdn/porch.webp" }, page: "marketing/photography", block: "marketing/photography#heroes",
    citations: ["marketing/photography#heroes/porch"],
  });
  // The format says which file a tool that takes no vectors can use.
  assert.deepEqual(kit.logos.map((logo) => logo.format), ["svg", "svg"]);
  assert.equal(mediaFormat("/logo.PNG?v=2"), "png");
  assert.equal(mediaFormat("/logo"), null);
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

test("font roles carry their family and where to obtain it, and a role with no source is a warning", () => {
  const roles = {
    "color.accent": { token: "--accent", value: "#111", kind: "color", source: "convention" },
    "font.display": { token: "--font-display", value: '"Cormorant Garamond", Georgia, serif', kind: "font-family", source: "convention" },
    "font.body": { token: "--font-body", value: "Newsreader, Georgia, serif", kind: "font-family", source: "convention" },
    "font.ui": { token: "--font-ui", value: "'Hanken Grotesk', system-ui, sans-serif", kind: "font-family", source: "manifest" },
    "font.mono": { token: "--font-mono", value: "ui-monospace, monospace", kind: "font-family", source: "manifest" },
    "font.print": { token: "--font-print", value: "Georgia, 'Times New Roman', serif", kind: "font-family", source: "manifest" },
  };
  const fonts = {
    faces: [
      { family: "newsreader", weight: "400", style: "normal", sources: [{ url: "/design-system/fonts/newsreader-400.woff2", format: "woff2" }], source: "/_astro/site.css" },
      { family: "Newsreader", weight: "700", style: "italic", sources: [{ url: "/design-system/fonts/newsreader-700i.woff2", format: "woff2" }, { url: "https://fonts.example.com/newsreader-700i.ttf" }], source: "/_astro/site.css" },
      { family: "Other", weight: "400", style: "normal", sources: [{ url: "/other.woff2" }], source: "/_astro/site.css" },
    ],
    stylesheets: ["https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500..700&family=Newsreader:wght@400&display=swap", "https://use.typekit.net/abc.css"],
  };
  const { resolved, unsourced } = resolveFontSources(roles, fonts);
  assert.deepEqual(resolved["font.display"], {
    family: "Cormorant Garamond",
    stylesheets: ["https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500..700&family=Newsreader:wght@400&display=swap"],
    specimen: "https://fonts.google.com/specimen/Cormorant+Garamond",
  });
  // Files match by family regardless of case; a face that serves a family from outside the artifact keeps its absolute URL.
  assert.deepEqual(resolved["font.body"].files, [
    { url: "/design-system/fonts/newsreader-400.woff2", format: "woff2", weight: "400", style: "normal" },
    { url: "/design-system/fonts/newsreader-700i.woff2", format: "woff2", weight: "700", style: "italic" },
    { url: "https://fonts.example.com/newsreader-700i.ttf", weight: "700", style: "italic" },
  ]);
  assert.equal(resolved["font.body"].specimen, "https://fonts.google.com/specimen/Newsreader");
  assert.deepEqual(resolved["font.ui"], { family: "Hanken Grotesk" });
  assert.deepEqual(resolved["font.mono"], { system: true }, "a generic-only stack needs no published source");
  // Conventional system stacks may use a platform fallback.
  assert.deepEqual(resolved["font.print"], { family: "Georgia", system: true });
  assert.equal(resolved["color.accent"], undefined);
  assert.deepEqual(unsourced, [{ role: "font.ui", family: "Hanken Grotesk" }]);

  const { kit, warnings } = buildBrandKit({ manifest: { systemId: "s", name: "S", version: "1" }, tokens: { roles }, pages: [], fonts });
  assert.equal(kit.roles["font.body"].family, "Newsreader");
  assert.equal(kit.roles["font.body"].token, "--font-body");
  assert.equal(kit.roles["font.display"].specimen, "https://fonts.google.com/specimen/Cormorant+Garamond");
  assert.ok(warnings.includes("font role font.ui (Hanken Grotesk) has no source: no loaded stylesheet declares an @font-face for it and no page links an external stylesheet that serves it, so a consumer cannot obtain the font"));
  // Font files are kit media: they publish and rewrite like logos.
  const urls = [];
  eachBrandKitMedia(kit, (entry) => urls.push(entry.url));
  assert.deepEqual(urls, ["/design-system/fonts/newsreader-400.woff2", "/design-system/fonts/newsreader-700i.woff2", "https://fonts.example.com/newsreader-700i.ttf"]);
});

test("font-service URLs match whole family names across query and path conventions", () => {
  const roles = { "font.body": { token: "--body", value: "Inter, sans-serif", kind: "font-family", source: "convention" } };
  const wrong = resolveFontSources(roles, { stylesheets: [
    "https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400",
    "https://fonts.example.com/inter-tight.css",
  ] });
  assert.deepEqual(wrong.resolved["font.body"], { family: "Inter" });
  assert.deepEqual(wrong.unsourced, [{ role: "font.body", family: "Inter" }]);
  const urls = [
    "//fonts.googleapis.com/css2?family=Inter:wght@400&family=Other:wght@500",
    "https://fonts.googleapis.com/css?family=Other|Inter:400,700",
    "https://fonts.example.com/css/inter.css",
  ];
  assert.deepEqual(resolveFontSources(roles, { stylesheets: urls }).resolved["font.body"].stylesheets, urls);
});

test("named platform-specific fonts still require published sources", () => {
  for (const family of ["Roboto", "Ubuntu", "SF Pro", "Segoe UI", "Noto Sans", "Helvetica Neue", "Consolas"]) {
    const roles = { "font.body": { token: "--body", value: `${family}, sans-serif`, kind: "font-family", source: "convention" } };
    const { resolved, unsourced } = resolveFontSources(roles);
    assert.equal(resolved["font.body"].system, undefined, family);
    assert.deepEqual(unsourced, [{ role: "font.body", family }]);
  }
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

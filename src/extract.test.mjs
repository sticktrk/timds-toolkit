import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readDerivedLayer } from "./derived.mjs";

import {
  blockToMarkdown,
  buildLlmsFullText,
  buildLlmsText,
  deriveTokensFromArtifact,
  extractArtifact,
  extractPage,
  normalizeMachineConfig,
  pageToMarkdown,
  parseSelector,
} from "./extract.mjs";

const PAGE = `<!doctype html><html><body>
  <nav class="sidenav"><a href="/other">Other</a></nav>
  <main class="content">
    <span class="eyebrow">Social · Shorts</span>
    <h1 class="page-title">Short-form video</h1>
    <p class="lede">One 9:16 master, <strong>three</strong> platforms. See the <a href="/spec">spec</a>.</p>
    <section class="block" id="safe-zones">
      <div class="block__head">
        <h2 class="h2">Safe zones</h2>
        <p>Platform UI overlays the video.</p>
      </div>
      <table class="tokens">
        <thead><tr><th>Zone</th><th>Keep clear</th></tr></thead>
        <tbody>
          <tr><td><strong>Top band</strong></td><td>top ~120 px</td></tr>
          <tr><td><strong>Bottom band</strong></td><td>bottom ~330 px</td></tr>
        </tbody>
      </table>
      <div class="note"><b>In code:</b> captions float at <code>bottom: 360</code>.</div>
      <pre class="codeblock">npx remotion still Cover out/cover.png</pre>
    </section>
    <section class="block" id="clips">
      <div class="block__head"><h2>Clips</h2></div>
      <figure>
        <video data-src="https://cdn.example.com/media/abc/widow-window.mp4"></video>
        <figcaption>
          <div class="swatch__name"><code>widow-window.mp4</code></div>
          <div class="swatch__role">Push-in from behind</div>
          <div>Loss and contemplation. Strong hook shot.</div>
        </figcaption>
      </figure>
      <div class="demo__title">An untyped page family</div>
    </section>
  </main>
</body></html>`;

const joinMedia = (source) =>
  source.includes("widow-window")
    ? { key: "b-roll-widow-window", url: source, contentType: "video/mp4", bytes: 42, durationSeconds: 5.042, width: 1920, height: 1080 }
    : { url: source };

const page = extractPage(PAGE, { pageId: "social/shorts", url: "/design-system/social/shorts", joinMedia });

test("reads the page header from semantics alone", () => {
  assert.equal(page.title, "Short-form video");
  assert.equal(page.eyebrow, "Social · Shorts");
  assert.equal(page.lede, "One 9:16 master, **three** platforms. See the [spec](/spec).");
  assert.equal(page.view, "social");
});

test("ignores chrome outside the page root", () => {
  assert.ok(!JSON.stringify(page).includes("/other"));
});

test("gives every spec row a stable citable id and plain fields", () => {
  const block = page.blocks.find((entry) => entry.id.endsWith("#safe-zones"));
  assert.equal(block.title, "Safe zones");
  assert.equal(block.intro, "Platform UI overlays the video.");
  const [table] = block.specs;
  assert.deepEqual(table.columns, ["Zone", "Keep clear"]);
  assert.equal(table.rows[1].id, "social/shorts#safe-zones/bottom-band");
  assert.equal(table.rows[1].fields.Zone, "Bottom band");
  assert.equal(table.rows[1].markdown.Zone, "**Bottom band**");
});

test("captures notes and code blocks", () => {
  const block = page.blocks.find((entry) => entry.id.endsWith("#safe-zones"));
  assert.equal(block.notes[0].text, "**In code:** captions float at `bottom: 360`.");
  assert.equal(block.code[0].text, "npx remotion still Cover out/cover.png");
});

test("joins figure assets to media records and keeps caption lines", () => {
  const block = page.blocks.find((entry) => entry.id.endsWith("#clips"));
  const [asset] = block.assets;
  assert.equal(asset.media.key, "b-roll-widow-window");
  assert.equal(asset.media.durationSeconds, 5.042);
  assert.equal(asset.media.width, 1920);
  assert.equal(asset.name, "`widow-window.mp4`");
  assert.deepEqual(asset.lines, ["Push-in from behind", "Loss and contemplation. Strong hook shot."]);
});

test("captures unrecognized content as untyped prose instead of dropping it", () => {
  const block = page.blocks.find((entry) => entry.id.endsWith("#clips"));
  assert.deepEqual(block.prose.map((entry) => entry.text), ["An untyped page family"]);
});

test("markdown mirror renders tables, notes, code, and assets", () => {
  const markdown = pageToMarkdown(page);
  assert.match(markdown, /^# Short-form video/);
  assert.ok(markdown.includes("| **Bottom band** | bottom ~330 px |"));
  assert.ok(markdown.includes("> **Note.** **In code:**"));
  assert.ok(markdown.includes("`b-roll-widow-window`"));
  assert.ok(markdown.includes("<!-- source: /design-system/social/shorts · id: social/shorts -->"));
});

test("a page mirror is its header plus every block's markdown", () => {
  const rendered = pageToMarkdown(page);
  for (const block of page.blocks) assert.ok(rendered.includes(blockToMarkdown(block).trimEnd()));
});

test("llms.txt groups pages by view and strips links from summaries", () => {
  const text = buildLlmsText(
    { name: "Pierce", description: "Editorial Heritage." },
    [page],
    { indexUrl: "/design-system/index.json" },
  );
  assert.match(text, /^# Pierce/);
  assert.ok(text.includes("> Editorial Heritage."));
  assert.ok(text.includes("This file is the entry point to the Pierce for people and AI tools."));
  assert.ok(text.includes("- [Short-form video](/design-system/social/shorts/index.md)"));
  assert.ok(!text.includes("(/spec)"));
  assert.ok(!text.includes("Design tokens:"));
  assert.ok(!text.includes("## Colors"), "no essentials without a kit");
  const withTokens = buildLlmsText({ name: "Pierce", version: "1.2.3" }, [page], { indexUrl: "/design-system/index.json", tokensUrl: "/design-system/tokens.json", fullUrl: "/design-system/llms-full.txt" });
  assert.ok(withTokens.includes("(version 1.2.3)"));
  assert.ok(withTokens.includes("Machine-readable index: /design-system/index.json"));
  assert.ok(withTokens.includes("Full text: /design-system/llms-full.txt"));
  assert.ok(withTokens.includes("Design tokens: /design-system/tokens.json"));
});

test("llms.txt opens with the brand essentials a person needs with no other access", () => {
  const kit = {
    roles: {
      "color.accent": { token: "--accent", value: "#c2a15a", kind: "color", source: "convention" },
      "color.text": { token: "--text", value: "#10243d", kind: "color", source: "convention" },
      "font.display": { token: "--font-display", value: '"Cormorant Garamond", Georgia, serif', kind: "font-family", source: "convention", family: "Cormorant Garamond", stylesheets: ["https://fonts.googleapis.com/css2?family=Cormorant+Garamond"], specimen: "https://fonts.google.com/specimen/Cormorant+Garamond" },
      "font.body": { token: "--font-body", value: "Newsreader, serif", kind: "font-family", source: "convention", family: "Newsreader", files: [{ url: "/design-system/fonts/newsreader-400.woff2", format: "woff2", weight: "400", style: "normal" }] },
      "font.ui": { token: "--font-ui", value: "'Hanken Grotesk', sans-serif", kind: "font-family", source: "manifest", family: "Hanken Grotesk" },
      "font.print": { token: "--font-print", value: "Georgia, serif", kind: "font-family", source: "manifest", family: "Georgia", system: true },
    },
    logos: [
      { name: "Colour logo", primary: true, variant: "colour", on: "light", format: "svg", media: { url: "/design-system/logo.svg" } },
      { name: "White logo", variant: "white", lockup: "stacked", on: "dark", format: "png", media: { url: "https://cdn.example.com/logo-white.png" } },
    ],
  };
  const formats = {
    groups: [
      { id: "print", unit: "in", formats: [
        { id: "business-card", name: "Business card · US", width: 3.5, height: 2, unit: "in", bleed: 0.125, safe: 0.125, stock: "16–32 pt cover.", page: "print/business-cards", pageUrl: "/design-system/print/business-cards/index.md" },
        { id: "worksheet", name: "Worksheet", width: 8.5, height: 11, unit: "in", bleed: 0, safe: 0.5, page: "print/worksheets" },
      ] },
      { id: "digital", unit: "px", formats: [{ id: "gdn-300x250", name: "Medium rectangle", width: 300, height: 250, unit: "px", safe: 12, maxKB: 150, file: "PNG or JPG", page: "digital/display-ads", pageUrl: "/design-system/digital/display-ads/index.md" }] },
    ],
  };
  const text = buildLlmsText({ name: "Client" }, [page], { indexUrl: "/design-system/index.json", brandUrl: "/design-system/brand.json", formatsUrl: "/design-system/formats.json", kit, formats });
  assert.ok(text.includes("Asset formats: /design-system/formats.json"));
  assert.ok(text.includes("## Colors\n\n- Accent (`color.accent`): `#c2a15a` — CSS `var(--accent)`\n- Text (`color.text`): `#10243d` — CSS `var(--text)`"));
  assert.ok(text.includes("- Display (headlines) (`font.display`): **Cormorant Garamond** — CSS `\"Cormorant Garamond\", Georgia, serif`\n  - download: https://fonts.google.com/specimen/Cormorant+Garamond\n  - stylesheet: https://fonts.googleapis.com/css2?family=Cormorant+Garamond"));
  assert.ok(text.includes("- Body (`font.body`): **Newsreader** — CSS `Newsreader, serif`\n  - 400 normal woff2: /design-system/fonts/newsreader-400.woff2"));
  assert.ok(text.includes("- UI (`font.ui`): **Hanken Grotesk** — CSS `'Hanken Grotesk', sans-serif` — no font file or service is published for this family"));
  assert.ok(text.includes("- print (`font.print`): **Georgia** — CSS `Georgia, serif` — a system font stack; rendering may use a platform fallback"));
  assert.ok(text.includes("## Logos\n\n- Colour logo (primary, colour, on light, svg): /design-system/logo.svg\n- White logo (white, stacked, on dark, png): https://cdn.example.com/logo-white.png"));
  assert.ok(text.includes("### print\n\n- [Business card · US](/design-system/print/business-cards/index.md) (`business-card`): 3.5 × 2 in · bleed 0.125 in · safe 0.125 in · 16–32 pt cover.\n- Worksheet (`worksheet`): 8.5 × 11 in · safe 0.5 in"));
  assert.ok(text.includes("- [Medium rectangle](/design-system/digital/display-ads/index.md) (`gdn-300x250`): 300 × 250 px · safe 12 px · max 150 KB · PNG or JPG"));
  // The page directory still follows the essentials.
  assert.ok(text.indexOf("## Asset formats") < text.indexOf("## social"));

  const full = buildLlmsFullText({ name: "Client", version: "1.2.3" }, [page]);
  assert.match(full, /^# Client\n\nEvery page of the system at version 1\.2\.3, in one file\./);
  assert.ok(full.includes("---\n\n# Short-form video\n"));
  assert.ok(full.includes("<!-- source: /design-system/social/shorts · id: social/shorts -->"));
});

test("extractArtifact derives tokens.json from the stylesheets the pages load", async () => {
  const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "timds-tokens-test-"));
  try {
    const files = {
      // The home page links a font service for the display face; the body face is a @font-face file in the artifact.
      "design-system/index.html": '<html><head><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500..700&display=swap" rel="stylesheet"><link rel="stylesheet" href="/_astro/site.css"></head><body><main><h1>Home</h1></main></body></html>',
      "design-system/fonts/newsreader.woff2": "woff2-bytes",
      "design-system/brand/color/index.html": '<html><head><link rel="stylesheet" href="/_astro/site.css"><link rel="stylesheet" href="../../theme.css"><style>.swatch{--swatch-gap:var(--space-1)}</style></head><body><main><h1>Color</h1></main></body></html>',
      "design-system/theme.css": "[data-theme=dark]{--navy-900:#000}",
      "design-system/brand/logo/index.html": '<html><body><main><h1>Logo</h1><section id="family"><h2>Family</h2><img src="/design-system/logo.svg" alt="Colour logo" data-timds-role="logo" data-timds-on="light"><img src="/design-system/logo-white.svg" alt="White logo" data-timds-role="logo primary" data-timds-on="dark"></section><section id="usage"><h2>Usage</h2><img src="/design-system/logo.svg" alt="Colour logo in use" data-timds-role="logo"><img src="/design-system/hero.webp" alt="Hero" data-timds-role="photo" data-timds-tags="hero"></section></main></body></html>',
      "design-system/brand/voice/index.html": '<html><body><main><h1>Voice</h1><section id="clear"><h2>Clear</h2><p>Lead with the answer.</p><div class="note">Never hedge.</div></section></main></body></html>',
      "design-system/social/compliance/index.html": '<html><body><main><h1>Compliance</h1><section id="claims"><h2>Claims</h2><p>No guarantees.</p></section></main></body></html>',
      "design-system/logo.svg": "<svg/>",
      "design-system/logo-white.svg": "<svg/>",
      "design-system/hero.webp": "webp",
      "design-system/missing-page.html": '<html><head><link rel="stylesheet" href="/nope.css"></head><body><main><h1>Orphan</h1></main></body></html>',
      // A bundled file is a copy of source, never a guidance page, whatever it contains.
      "design-system/bundle/public/email/template.html": "<html><body><main><h1>Email template</h1></main></body></html>",
      "_astro/site.css": '@import "ramps.css";@font-face{font-family:"Newsreader";font-weight:400;src:url(../design-system/fonts/newsreader.woff2) format("woff2")}:root{--navy:var(--navy-900);--space-1:4px;--accent:var(--navy);--font-display:"Cormorant Garamond",Georgia,serif;--font-body:Newsreader,Georgia,serif}',
      "_astro/ramps.css": ":root{--navy-900:#0a1729}",
      "_astro/unused.css": ":root{--never-loaded:1}",
    };
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(artifactRoot, ...relative.split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }
    const manifest = { artifact: { entry: "design-system/index.html" }, name: "Client", systemId: "client/system", version: "2.0.0", machine: {}, brand: { roles: { "color.text": "--navy-900" }, guidance: { shorts: ["brand/voice#clear"] } } };
    // One format shows on a built page, one on a page the artifact lacks (planned, not built).
    const formats = [{ id: "print", unit: "in", formats: [
      { id: "logo-sheet", name: "Logo sheet", width: 8.5, height: 11, unit: "in", bleed: 0.125, safe: 0.5, page: "brand/logo" },
      { id: "business-card", name: "Business card", width: 3.5, height: 2, unit: "in", bleed: 0.125, safe: 0.125, stock: "16 pt cover.", page: "print/business-cards" },
    ] }];

    const bundle = { schemaVersion: 1, fileCount: 1, bytes: 60, files: [{ path: "public/email/template.html" }] };
    const lineage = { systemId: "example/parent", sourceId: "00000000-0000-4000-8000-000000000101", version: "1.0.0", commit: "a".repeat(40), mode: "full" };
    const result = await extractArtifact({ artifactRoot, manifest, formats, bundle, lineage, write: true });
    assert.deepEqual(result.index.lineage, lineage);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(artifactRoot, "design-system/index.json"), "utf8")).lineage, lineage);
    assert.ok(!result.pages.some((entry) => entry.title === "Email template"), "the bundle directory is not walked for pages");
    assert.deepEqual(result.index.bundle, { url: "/design-system/bundle.json", files: 1, bytes: 60 });
    assert.equal(result.counts.tokens, 8);
    assert.equal(result.counts.stylesheets, 4);
    // color.text, color.accent, font.display, font.body, and font.ui (which --font-body fills by convention).
    assert.equal(result.counts.roles, 5);
    assert.equal(result.counts.formats, 2);
    assert.deepEqual(result.index.tokens, { url: "/design-system/tokens.json", count: 8, stylesheets: 4, roles: 5 });
    assert.deepEqual(result.index.formats, { url: "/design-system/formats.json", groups: 1, count: 2 });
    assert.equal(result.warnings.length, 4);
    assert.match(result.warnings[0], /brand role color\.background is not filled/);
    assert.ok(!result.warnings.some((warning) => warning.includes("no logo")));
    assert.ok(!result.warnings.some((warning) => warning.includes("has no source")), "both font roles have a source");
    assert.match(result.warnings.at(-1), /format business-card \(Business card\) names the page print\/business-cards, which the built artifact does not contain/);
    assert.deepEqual(result.index.brand, { url: "/design-system/brand.json", logos: 2, imagery: 1, guidance: 3 });
    assert.equal(result.counts.guidance, 3);
    assert.equal(result.counts.logos, 2);
    assert.equal(result.counts.imagery, 1);

    const kit = JSON.parse(await fs.readFile(path.join(artifactRoot, "design-system", "brand.json"), "utf8"));
    assert.deepEqual(kit.system, { id: "client/system", name: "Client", version: "2.0.0" });
    assert.equal(kit.roles["color.text"].token, "--navy-900");
    // The body face resolves to the artifact file its @font-face names, relative to the stylesheet; the display face to the service the page links.
    assert.deepEqual(kit.roles["font.body"], {
      token: "--font-body", value: "Newsreader,Georgia,serif", kind: "font-family", source: "convention",
      family: "Newsreader", files: [{ url: "/design-system/fonts/newsreader.woff2", format: "woff2", weight: "400", style: "normal" }],
    });
    assert.deepEqual(kit.roles["font.display"].stylesheets, ["https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500..700&display=swap"]);
    assert.equal(kit.roles["font.display"].specimen, "https://fonts.google.com/specimen/Cormorant+Garamond");
    assert.deepEqual(kit.logos.map((logo) => [logo.name, logo.media.url, Boolean(logo.primary), logo.citations.length, logo.format]), [
      ["White logo", "/design-system/logo-white.svg", true, 1, "svg"],
      ["Colour logo", "/design-system/logo.svg", false, 2, "svg"],
    ]);

    // The format catalog is derived beside the kit, each format linked to its built page.
    const formatsDoc = JSON.parse(await fs.readFile(path.join(artifactRoot, "design-system", "formats.json"), "utf8"));
    assert.deepEqual(formatsDoc.system, kit.system);
    assert.equal(formatsDoc.url, "/design-system/formats.json");
    assert.deepEqual(formatsDoc.groups[0].formats.map((format) => [format.id, format.pageUrl ?? null]), [["logo-sheet", "/design-system/brand/logo/index.md"], ["business-card", null]]);
    assert.ok(result.written.includes(path.join(artifactRoot, "design-system", "formats.json")));
    assert.deepEqual(kit.imagery.map((entry) => [entry.role, entry.tags, entry.block]), [["photo", ["hero"], "brand/logo#usage"]]);
    // Voice and compliance fill by convention; the manifest adds a group. Each block carries its Markdown.
    assert.deepEqual(Object.keys(kit.guidance).sort(), ["compliance", "shorts", "voice"]);
    assert.equal(kit.guidance.voice.source, "convention");
    assert.equal(kit.guidance.voice.blocks[0].id, "brand/voice#clear");
    assert.equal(kit.guidance.voice.blocks[0].markdown, "## Clear   `#clear`\n\nLead with the answer.\n\n> **Note.** Never hedge.\n");
    assert.equal(kit.guidance.compliance.blocks[0].page, "social/compliance");
    assert.deepEqual(kit.guidance.shorts, { source: "manifest", blocks: [{ id: "brand/voice#clear", page: "brand/voice", title: "Clear", markdown: kit.guidance.voice.blocks[0].markdown }] });
    assert.ok(result.written.includes(path.join(artifactRoot, "design-system", "tokens.json")));

    const document = JSON.parse(await fs.readFile(path.join(artifactRoot, "design-system", "tokens.json"), "utf8"));
    assert.deepEqual(document.system, { id: "client/system", name: "Client", version: "2.0.0" });
    // Linked files first in path order (a file loaded by two pages is read once), then inline blocks.
    assert.deepEqual(document.stylesheets.map((sheet) => sheet.path), [
      "/_astro/ramps.css",
      "/_astro/site.css",
      "/design-system/theme.css",
      "/design-system/brand/color/index.html#style-1",
    ]);
    assert.ok(document.stylesheets.every((sheet) => /^[a-f0-9]{64}$/.test(sheet.sha256) && sheet.bytes > 0));
    assert.ok(!document.tokens.some((token) => token.name === "--never-loaded"));
    const token = (name, selector = ":root") => document.tokens.find((entry) => entry.name === name && entry.selector === selector);
    assert.equal(token("--navy").resolved, "#0a1729");
    assert.equal(token("--navy").source, "/_astro/site.css");
    assert.equal(token("--navy-900", "[data-theme=dark]").resolved, "#000");
    assert.equal(token("--swatch-gap", ".swatch").resolved, "4px");
    assert.equal(token("--swatch-gap", ".swatch").source, "/design-system/brand/color/index.html#style-1");
    // The manifest mapping fills color.text; convention fills color.accent through the var() chain.
    assert.deepEqual(document.roles["color.text"], { token: "--navy-900", value: "#0a1729", kind: "color", source: "manifest" });
    assert.deepEqual(document.roles["color.accent"], { token: "--accent", value: "#0a1729", kind: "color", source: "convention" });
    assert.deepEqual(document.missingRoles, ["color.background", "color.panel", "color.muted"]);
    // tokens.json keeps the role as the stylesheet states it; the sources live on the kit.
    assert.equal(document.roles["font.body"].files, undefined);

    const llms = await fs.readFile(path.join(artifactRoot, "design-system", "llms.txt"), "utf8");
    assert.ok(llms.includes("Design tokens: /design-system/tokens.json"));
    assert.ok(llms.includes("Brand kit: /design-system/brand.json"));
    assert.ok(llms.includes("Asset formats: /design-system/formats.json"));
    assert.ok(llms.includes("Full text: /design-system/llms-full.txt"));
    assert.ok(llms.includes("Consumer bundle: /design-system/bundle.json"));
    assert.ok(llms.includes("- Body (`font.body`): **Newsreader** — CSS `Newsreader,Georgia,serif`\n  - 400 normal woff2: /design-system/fonts/newsreader.woff2"));
    assert.ok(llms.includes("- White logo (primary, on dark, svg): /design-system/logo-white.svg"));
    assert.ok(llms.includes("- [Logo sheet](/design-system/brand/logo/index.md) (`logo-sheet`): 8.5 × 11 in · bleed 0.125 in · safe 0.5 in"));
    assert.ok(llms.includes("- Business card (`business-card`): 3.5 × 2 in · bleed 0.125 in · safe 0.125 in · 16 pt cover."));
    const llmsFull = await fs.readFile(path.join(artifactRoot, "design-system", "llms-full.txt"), "utf8");
    assert.ok(llmsFull.includes("---\n\n# Color\n"));
    assert.ok(llmsFull.includes("<!-- source: /design-system/brand/voice · id: brand/voice -->"));
    assert.ok(result.written.includes(path.join(artifactRoot, "design-system", "llms-full.txt")));

    // The in-memory derivation reads the same stylesheets and writes nothing.
    const inMemory = await deriveTokensFromArtifact({ artifactRoot, manifest });
    assert.equal(inMemory.count, document.count);
    assert.deepEqual(inMemory.roles, document.roles);
    assert.equal(await deriveTokensFromArtifact({ artifactRoot: path.join(artifactRoot, "nope"), manifest }), null);
  } finally {
    await fs.rm(artifactRoot, { force: true, recursive: true });
  }
});

test("assets carry the brand annotation of their element or nearest wrapper", () => {
  const annotated = extractPage(
    `<main><h1>Logo</h1><section id="family">
      <h2>Family</h2>
      <div data-timds-role="logo primary" data-timds-lockup="horizontal" data-timds-on="light"><div class="cell"><img src="/plg-colour.svg" alt="PLG colour logo"></div></div>
      <figure data-timds-role="logo" data-timds-variant="white" data-timds-on="dark"><img src="/plg-white.svg"><figcaption>PLG white logo</figcaption></figure>
      <img src="/plain.svg" alt="Plain">
    </section></main>`,
    { pageId: "brand/logo", url: "/brand/logo" },
  );
  const byName = (name) => annotated.blocks[0].assets.find((asset) => asset.name === name);
  const [colour, white, plain] = [byName("PLG colour logo"), byName("PLG white logo"), byName("Plain")];
  assert.deepEqual(colour.brand, { role: "logo", primary: true, lockup: "horizontal", on: "light" });
  assert.deepEqual(white.brand, { role: "logo", variant: "white", on: "dark" });
  assert.equal(plain.brand, undefined);
  const markdown = pageToMarkdown(annotated);
  assert.ok(markdown.includes("| PLG colour logo | `—` | **logo primary horizontal on light** |"));
  assert.ok(markdown.includes("| Plain | `—` |  |"));
});

test("works with no section markup by treating the root as one block", () => {
  const flat = extractPage(
    "<main><h1>Tokens</h1><p>Lede.</p><table><thead><tr><th>Name</th></tr></thead><tbody><tr><td>gold-400</td></tr></tbody></table></main>",
    { pageId: "brand/tokens", url: "/brand/tokens" },
  );
  assert.equal(flat.blocks.length, 1);
  assert.equal(flat.blocks[0].specs[0].rows[0].fields.Name, "gold-400");
});

test("nested sections do not double-count their content", () => {
  const nested = extractPage(
    "<main><h1>T</h1><section id='outer'><h2>Outer</h2><section id='inner'><h2>Inner</h2><p>x</p></section></section></main>",
    { pageId: "p", url: "/p" },
  );
  assert.deepEqual(nested.blocks.map((block) => block.id), ["p#outer"]);
});

test("selector hints accept tag, class, and tag.class only", () => {
  assert.deepEqual(parseSelector("section.block"), { tag: "section", className: "block" });
  assert.deepEqual(parseSelector(".note"), { tag: null, className: "note" });
  assert.deepEqual(parseSelector("main"), { tag: "main", className: null });
  assert.throws(() => parseSelector("div > p"), /must be tag, \.class, or tag\.class/);
  assert.throws(() => parseSelector("[data-x]"), /must be tag, \.class, or tag\.class/);
});

test("machine config can be disabled and defaults to enabled", () => {
  assert.equal(normalizeMachineConfig(false).enabled, false);
  assert.equal(normalizeMachineConfig({ enabled: false }).enabled, false);
  assert.equal(normalizeMachineConfig().enabled, true);
  assert.equal(normalizeMachineConfig(undefined).enabled, true);
});

test("hints override the defaults", () => {
  const config = normalizeMachineConfig({ root: "div.page", block: ["article"], note: ".callout" });
  const hinted = extractPage(
    "<div class='page'><h1>H</h1><article id='a'><h2>A</h2><div class='callout'>heads up</div></article></div>",
    { pageId: "p", url: "/p", config },
  );
  assert.equal(hinted.blocks[0].id, "p#a");
  assert.equal(hinted.blocks[0].notes[0].text, "heads up");
});

test("the index carries the video board catalog summary only when the system has one", async (t) => {
  const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "timds-boards-index-"));
  t.after(() => fs.rm(artifactRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(artifactRoot, "index.html"), "<html><body><main><h1>Home</h1><section id=\"a\"><h2>A</h2><p>Text.</p></section></main></body></html>");
  const manifest = { artifact: { entry: "index.html" }, name: "Client", systemId: "client/system", version: "1.0.0", machine: {} };
  const boards = { schemaVersion: 1, formats: { longform: true, short: false }, cadence: {}, kinds: [{ id: "cards", label: "Cards" }] };
  const withBoards = await extractArtifact({ artifactRoot, manifest, video: { boards }, write: true });
  assert.deepEqual(withBoards.index.video, { boards });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(artifactRoot, "index.json"), "utf8")).video, { boards });
  const without = await extractArtifact({ artifactRoot, manifest, write: false });
  assert.equal("video" in without.index, false);
});

test("format and directory links use the actual root, flat, and directory Markdown mirrors", async (t) => {
  const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "timds-format-mirrors-"));
  t.after(() => fs.rm(artifactRoot, { recursive: true, force: true }));
  for (const [file, title] of [["index.html", "Home"], ["print/cards.html", "Cards"], ["print/letters/index.html", "Letters"]]) {
    const target = path.join(artifactRoot, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `<main><h1>${title}</h1></main>`);
  }
  const manifest = { artifact: { entry: "index.html" }, name: "S", systemId: "s", version: "1.0.0" };
  const formats = [{ id: "print", unit: "in", formats: ["index", "print/cards", "print/letters"].map((page, i) => ({ id: `f-${i}`, name: page, width: 1, height: 1, unit: "in", safe: 0, page })) }];
  const result = await extractArtifact({ artifactRoot, manifest, formats });
  assert.deepEqual(result.formats.groups[0].formats.map((format) => format.pageUrl), ["/index.md", "/print/cards.md", "/print/letters/index.md"]);
  assert.ok(!result.warnings.some((warning) => warning.startsWith("format ")));
  const llms = await fs.readFile(path.join(artifactRoot, "llms.txt"), "utf8");
  for (const { pageUrl } of result.formats.groups[0].formats) {
    await fs.access(path.join(artifactRoot, pageUrl.slice(1)));
    assert.ok(llms.includes(`](${pageUrl})`));
  }
  assert.ok(llms.includes("- [Cards](/print/cards.md)"));
  assert.ok(llms.includes("- [Home](/index.md)"));
  const dryRun = await extractArtifact({ artifactRoot, manifest, formats, write: false });
  assert.deepEqual(dryRun.formats, result.formats);
});

test("removing a format catalog removes its derived file on the next extraction", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "timds-format-removal-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const artifactRoot = path.join(root, "dist");
  await fs.mkdir(artifactRoot);
  await fs.writeFile(path.join(artifactRoot, "index.html"), "<main><h1>Home</h1></main>");
  const manifest = { artifact: { entry: "index.html" }, name: "S", systemId: "s", version: "1.0.0" };
  const formats = [{ id: "print", unit: "in", formats: [{ id: "card", name: "Card", width: 3.5, height: 2, unit: "in", safe: 0.125, page: "index" }] }];
  await extractArtifact({ artifactRoot, manifest, formats });
  assert.equal((await readDerivedLayer(root, manifest)).formats.count, 1);
  await extractArtifact({ artifactRoot, manifest, write: false });
  await fs.access(path.join(artifactRoot, "formats.json"));
  const removed = await extractArtifact({ artifactRoot, manifest });
  assert.equal(removed.index.formats, undefined);
  await assert.rejects(fs.access(path.join(artifactRoot, "formats.json")), { code: "ENOENT" });
  const layer = await readDerivedLayer(root, manifest);
  assert.equal(layer.formats, null);
  assert.equal(layer.stale, false);
});

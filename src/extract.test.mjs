import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  blockToMarkdown,
  buildLlmsText,
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
    { name: "Acme", description: "Shared brand standards." },
    [page],
    "/design-system/index.json",
  );
  assert.match(text, /^# Acme/);
  assert.ok(text.includes("> Shared brand standards."));
  assert.ok(text.includes("- [Short-form video](/design-system/social/shorts/index.md)"));
  assert.ok(!text.includes("(/spec)"));
  assert.ok(!text.includes("Design tokens:"));
  const withTokens = buildLlmsText({ name: "Acme" }, [page], "/design-system/index.json", "/design-system/tokens.json");
  assert.ok(withTokens.includes("Machine-readable index: /design-system/index.json"));
  assert.ok(withTokens.includes("Design tokens: /design-system/tokens.json"));
});

test("extractArtifact derives tokens.json from the stylesheets the pages load", async () => {
  const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "timds-tokens-test-"));
  try {
    const files = {
      "design-system/index.html": '<html><head><link rel="stylesheet" href="/_astro/site.css"></head><body><main><h1>Home</h1></main></body></html>',
      "design-system/brand/color/index.html": '<html><head><link rel="stylesheet" href="/_astro/site.css"><link rel="stylesheet" href="../../theme.css"><style>.swatch{--swatch-gap:var(--space-1)}</style></head><body><main><h1>Color</h1></main></body></html>',
      "design-system/theme.css": "[data-theme=dark]{--navy-900:#000}",
      "design-system/brand/logo/index.html": '<html><body><main><h1>Logo</h1><section id="family"><h2>Family</h2><img src="/design-system/logo.svg" alt="Colour logo" data-timds-role="logo" data-timds-on="light"><img src="/design-system/logo-white.svg" alt="White logo" data-timds-role="logo primary" data-timds-on="dark"></section><section id="usage"><h2>Usage</h2><img src="/design-system/logo.svg" alt="Colour logo in use" data-timds-role="logo"><img src="/design-system/hero.webp" alt="Hero" data-timds-role="photo" data-timds-tags="hero"></section></main></body></html>',
      "design-system/brand/voice/index.html": '<html><body><main><h1>Voice</h1><section id="clear"><h2>Clear</h2><p>Lead with the answer.</p><div class="note">Never hedge.</div></section></main></body></html>',
      "design-system/social/compliance/index.html": '<html><body><main><h1>Compliance</h1><section id="claims"><h2>Claims</h2><p>No guarantees.</p></section></main></body></html>',
      "design-system/logo.svg": "<svg/>",
      "design-system/logo-white.svg": "<svg/>",
      "design-system/hero.webp": "webp",
      "design-system/missing-page.html": '<html><head><link rel="stylesheet" href="/nope.css"></head><body><main><h1>Orphan</h1></main></body></html>',
      "_astro/site.css": '@import "ramps.css";:root{--navy:var(--navy-900);--space-1:4px;--accent:var(--navy)}',
      "_astro/ramps.css": ":root{--navy-900:#0a1729}",
      "_astro/unused.css": ":root{--never-loaded:1}",
    };
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(artifactRoot, ...relative.split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }
    const manifest = { artifact: { entry: "design-system/index.html" }, name: "Client", systemId: "client/system", version: "2.0.0", machine: {}, brand: { roles: { "color.text": "--navy-900" }, guidance: { shorts: ["brand/voice#clear"] } } };

    const result = await extractArtifact({ artifactRoot, manifest, write: true });
    assert.equal(result.counts.tokens, 6);
    assert.equal(result.counts.stylesheets, 4);
    assert.equal(result.counts.roles, 2);
    assert.deepEqual(result.index.tokens, { url: "/design-system/tokens.json", count: 6, stylesheets: 4, roles: 2 });
    assert.equal(result.warnings.length, 6);
    assert.match(result.warnings[0], /brand role color\.background is not filled/);
    assert.ok(!result.warnings.some((warning) => warning.includes("no logo")));
    assert.deepEqual(result.index.brand, { url: "/design-system/brand.json", logos: 2, imagery: 1, guidance: 3 });
    assert.equal(result.counts.guidance, 3);
    assert.equal(result.counts.logos, 2);
    assert.equal(result.counts.imagery, 1);

    const kit = JSON.parse(await fs.readFile(path.join(artifactRoot, "design-system", "brand.json"), "utf8"));
    assert.deepEqual(kit.system, { id: "client/system", name: "Client", version: "2.0.0" });
    assert.equal(kit.roles["color.text"].token, "--navy-900");
    assert.deepEqual(kit.logos.map((logo) => [logo.name, logo.media.url, Boolean(logo.primary), logo.citations.length]), [
      ["White logo", "/design-system/logo-white.svg", true, 1],
      ["Colour logo", "/design-system/logo.svg", false, 2],
    ]);
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
    assert.ok(document.missingRoles.includes("font.display"));

    const llms = await fs.readFile(path.join(artifactRoot, "design-system", "llms.txt"), "utf8");
    assert.ok(llms.includes("Design tokens: /design-system/tokens.json"));
    assert.ok(llms.includes("Brand kit: /design-system/brand.json"));
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

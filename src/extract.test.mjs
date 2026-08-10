import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLlmsText,
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
    ? { key: "b-roll-widow-window", url: source, contentType: "video/mp4", bytes: 42 }
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

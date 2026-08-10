import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeEntities,
  findAll,
  findOne,
  hasClass,
  parseHtml,
  rawTextOf,
  slugify,
  textOf,
} from "./html.mjs";

test("parses nested elements and attributes", () => {
  const root = parseHtml('<div class="a b" id="x"><p>Hello <strong>there</strong></p></div>');
  const div = findOne(root, (node) => node.tag === "div");
  assert.equal(div.attrs.id, "x");
  assert.ok(hasClass(div, "a") && hasClass(div, "b"));
  assert.equal(textOf(div), "Hello there");
});

test("keeps inline emphasis, code, and links in markdown mode", () => {
  const root = parseHtml('<p>Use <strong>one</strong> <code>master</code> — see <a href="/spec">the spec</a>.</p>');
  const paragraph = findOne(root, (node) => node.tag === "p");
  assert.equal(textOf(paragraph, { markdown: true }), "Use **one** `master` — see [the spec](/spec).");
  assert.equal(textOf(paragraph), "Use one master — see the spec.");
});

test("tolerates unclosed paragraphs and list items", () => {
  const root = parseHtml("<div><p>first<p>second<ul><li>a<li>b</ul></div>");
  assert.deepEqual(findAll(root, (node) => node.tag === "p").map((node) => textOf(node)), ["first", "second"]);
  assert.deepEqual(findAll(root, (node) => node.tag === "li").map((node) => textOf(node)), ["a", "b"]);
});

test("ignores comments, doctype, and stray close tags", () => {
  const root = parseHtml("<!doctype html><!-- note --><div>kept</div></span>");
  assert.equal(textOf(root), "kept");
});

test("treats script and style as raw text and excludes them from content", () => {
  const root = parseHtml('<div>keep<script>var a = "<div>not markup</div>";</script><style>.a{}</style></div>');
  const div = findOne(root, (node) => node.tag === "div");
  assert.equal(textOf(div), "keep");
  assert.equal(findAll(root, (node) => node.tag === "div").length, 1);
});

test("handles quoted attribute values containing angle brackets", () => {
  const root = parseHtml('<img alt="a > b" src="/x.png"><p>after</p>');
  const image = findOne(root, (node) => node.tag === "img");
  assert.equal(image.attrs.alt, "a > b");
  assert.equal(textOf(findOne(root, (node) => node.tag === "p")), "after");
});

test("does not nest void elements", () => {
  const root = parseHtml("<div><br><img src='a'><p>text</p></div>");
  const paragraph = findOne(root, (node) => node.tag === "p");
  assert.equal(textOf(paragraph), "text");
  const image = findOne(root, (node) => node.tag === "img");
  assert.equal(image.children.length, 0);
});

test("decodes named and numeric entities", () => {
  assert.equal(decodeEntities("a &amp; b &#8212; c &#x2014; d &nbsp;e"), "a & b — c — d  e");
  assert.equal(decodeEntities("&unknownentity;"), "&unknownentity;");
});

test("preserves newlines for preformatted content", () => {
  const root = parseHtml("<pre>line one\nline two\n</pre>");
  assert.equal(rawTextOf(findOne(root, (node) => node.tag === "pre")), "line one\nline two");
});

test("slugify produces stable, bounded anchors", () => {
  assert.equal(slugify("Bottom band"), "bottom-band");
  assert.equal(slugify("1 · Hook frame"), "1-hook-frame");
  // Inline code inside a longer label is dropped as noise...
  assert.equal(slugify("`--color-bg` semantic token"), "semantic-token");
  // ...but a label that is only code still has to slug, or every such row collides.
  assert.equal(slugify("`widow-window.mp4`", "fallback"), "widow-window-mp4");
  assert.equal(slugify("   ", "fallback"), "fallback");
  assert.ok(slugify("x".repeat(200)).length <= 48);
});

// Real-Chrome tests for the capture fidelity work in consumer-browser.mjs:
// source stamps that page code strips, dev overlays, and reveal-on-scroll or
// lazy content. Each skips with the reason when no headless Chrome is
// installed (they never download one).

import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { DEV_OVERLAY_SELECTORS, MAX_CAPTURE_HEIGHT, SETTLE_LIMITS, launchBrowser } from "./consumer-browser.mjs";
import { decodePng, encodePng } from "./consumer-png.mjs";

let browserProbe;
function realBrowserAvailable() {
  browserProbe ||= (async () => {
    try {
      const browser = await launchBrowser({ allowDownload: false });
      await browser.close();
      return null;
    } catch (error) {
      return `headless Chrome is not available without a download (${error.message})`;
    }
  })();
  return browserProbe;
}

const BLUE_PNG = encodePng({ width: 4, height: 4, data: Buffer.from(Array.from({ length: 16 }, () => [0, 0, 255, 255]).flat()) });

// Serves `pages` (path -> HTML) and a solid blue PNG at /blue.png.
async function servePages(pages) {
  const server = http.createServer((request, response) => {
    const { pathname } = new URL(request.url, "http://local");
    if (pathname === "/blue.png") {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(BLUE_PNG);
      return;
    }
    const html = pages[pathname];
    response.writeHead(html ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    response.end(html || "missing");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function withChrome(t, pages, run) {
  const unavailable = await realBrowserAvailable();
  if (unavailable) {
    t.skip(unavailable);
    return;
  }
  const server = await servePages(pages);
  const browser = await launchBrowser({ allowDownload: false });
  try {
    await run(browser, server.origin);
  } finally {
    await browser.close();
    await server.close();
  }
}

function pixel(image, x, y) {
  const offset = (y * image.width + x) * 4;
  return [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
}

test("element maps keep source stamps that page code strips, including on elements inserted after load (real Chrome)", async (t) => {
  // Mirrors Astro's dev toolbar, which moves stamps into a private WeakMap at load.
  const page = `<!doctype html><html><head><style>body{margin:0}</style>
<script>
const strip = () => { for (const el of document.querySelectorAll("[data-astro-source-file]")) { el.removeAttribute("data-astro-source-file"); el.removeAttribute("data-astro-source-loc"); } };
document.addEventListener("DOMContentLoaded", strip);
window.addEventListener("load", () => setTimeout(() => {
  const late = document.createElement("p");
  late.textContent = "Rendered late";
  late.setAttribute("data-astro-source-file", "/repo/web/src/components/Late.astro");
  late.setAttribute("data-astro-source-loc", "3:2");
  document.body.append(late);
  const tagged = document.createElement("p");
  tagged.textContent = "Tagged after insert";
  document.body.append(tagged);
  tagged.setAttribute("data-lov-id", "src/components/Tagged.tsx:8:1");
  setTimeout(() => { strip(); tagged.removeAttribute("data-lov-id"); }, 20);
}, 50));
</script></head><body>
<h1 data-astro-source-file="/repo/web/src/pages/index.astro" data-astro-source-loc="12:4">Stripped at load</h1>
<p data-source-file="src/a.tsx" data-source-line="7">Never stripped</p>
<p>No stamp</p>
</body></html>`;
  await withChrome(t, { "/": page }, async (browser, origin) => {
    const shot = await browser.capture({ elementMap: true, height: 600, scheme: "light", url: `${origin}/`, width: 800 });
    assert.doesNotMatch(shot.html, /<(h1|p)[^>]*data-astro-source-file/, "the page really did strip its stamps");
    const byText = (text) => shot.map.elements.find((element) => element.text === text);
    assert.deepEqual(byText("Stripped at load").source, { file: "/repo/web/src/pages/index.astro", line: 12, column: 4 });
    assert.deepEqual(byText("Never stripped").source, { file: "src/a.tsx", line: 7, column: null });
    assert.deepEqual(byText("Rendered late").source, { file: "/repo/web/src/components/Late.astro", line: 3, column: 2 });
    assert.deepEqual(byText("Tagged after insert").source, { file: "src/components/Tagged.tsx", line: 8, column: 1 });
    assert.equal(byText("No stamp").source, null);
  });
});

test("dev overlays are hidden from the capture and left out of the map and saved HTML (real Chrome)", async (t) => {
  const page = `<!doctype html><html><head><style>
body{margin:0;background:#fff}
astro-dev-toolbar{position:fixed;left:0;top:0;width:400px;height:200px;background:#f00;display:block;z-index:9}
.own-fixed{position:fixed;right:0;top:0;width:100px;height:100px;background:#0f0}
</style></head><body>
<p>Content</p><div class="own-fixed">Site bar</div>
<astro-dev-toolbar><span>Toolbar</span></astro-dev-toolbar>
<vite-error-overlay>Overlay</vite-error-overlay>
</body></html>`;
  await withChrome(t, { "/": page }, async (browser, origin) => {
    const shot = await browser.capture({ elementMap: true, height: 600, scheme: "light", url: `${origin}/`, width: 800 });
    assert.ok(DEV_OVERLAY_SELECTORS.includes("astro-dev-toolbar"));
    assert.doesNotMatch(shot.html, /<astro-dev-toolbar|<vite-error-overlay/);
    assert.match(shot.html, /own-fixed/, "the site's own fixed element stays");
    const tags = shot.map.elements.map((element) => element.tag);
    assert.ok(!tags.includes("astro-dev-toolbar") && !tags.includes("vite-error-overlay"));
    assert.ok(shot.map.elements.some((element) => element.text === "Site bar"));
    const image = decodePng(shot.png);
    assert.deepEqual(pixel(image, 200, 150), [255, 255, 255], "the toolbar is not painted");
    assert.deepEqual(pixel(image, 750, 50), [0, 255, 0], "the site's fixed element is painted");
  });
});

test("reveal-on-scroll sections and lazy images below the fold are captured, and endless pages stay bounded (real Chrome)", async (t) => {
  const reveal = `<!doctype html><html><head><style>
body{margin:0;background:#fff}
.gap{height:2500px}
.reveal{height:300px;background:#f00;opacity:0;transform:translateY(40px);transition:opacity .4s,transform .4s}
.reveal.in{opacity:1;transform:none}
img{display:block;width:400px;height:300px}
</style></head><body>
<div class="gap"></div><section class="reveal" id="one">One</section>
<div class="gap"></div><section class="reveal" id="two">Two</section>
<div class="gap"></div><img id="lazy" loading="lazy" src="/blue.png" alt="">
<div style="height:600px"></div>
<script>
const io = new IntersectionObserver((entries) => { for (const entry of entries) if (entry.isIntersecting) entry.target.classList.add("in"); });
document.querySelectorAll(".reveal").forEach((el) => io.observe(el));
</script></body></html>`;
  const animated = `<!doctype html><html><head><style>
body{margin:0;min-height:3000px}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes slow{to{opacity:.5}}
.spin{width:50px;height:50px;background:#00f;animation:spin 1s linear infinite}
.slow{width:50px;height:50px;background:#0f0;animation:slow 120s linear}
</style></head><body><div class="spin"></div><div class="slow"></div></body></html>`;
  const endless = `<!doctype html><html><head><style>body{margin:0} .chunk{height:2000px;border-top:4px solid #000}</style></head><body>
<div class="chunk"></div>
<script>window.addEventListener("scroll", () => {
  if (window.scrollY + innerHeight * 2 > document.body.scrollHeight) { const d = document.createElement("div"); d.className = "chunk"; document.body.append(d); }
});</script></body></html>`;
  await withChrome(t, { "/": reveal, "/animated": animated, "/endless": endless }, async (browser, origin) => {
    const shot = await browser.capture({ elementMap: true, height: 800, scheme: "light", url: `${origin}/`, width: 800 });
    const image = decodePng(shot.png);
    const byId = (id) => shot.map.elements.find((element) => element.selector === `#${id}`);
    for (const id of ["one", "two"]) {
      const [x, y, w, h] = byId(id).rect;
      assert.deepEqual(pixel(image, x + Math.floor(w / 2), y + Math.floor(h / 2)), [255, 0, 0], `section #${id} was revealed`);
    }
    const [x, y] = byId("lazy").rect;
    assert.ok(y > 7000, "the lazy image is far below the fold");
    assert.deepEqual(pixel(image, x + 200, y + 150), [0, 0, 255], "the lazy image loaded");
    assert.deepEqual(pixel(image, 400, 10), [255, 255, 255], "the capture starts at the top");

    // Each wait is bounded; the slack covers load and the screenshot itself.
    const bound = SETTLE_LIMITS.scrollMs + SETTLE_LIMITS.networkMs + SETTLE_LIMITS.imagesMs + SETTLE_LIMITS.animationsMs + 2 * SETTLE_LIMITS.frameMs + 10_000;
    let started = Date.now();
    const spun = await browser.capture({ height: 800, scheme: "light", url: `${origin}/animated`, width: 800 });
    assert.ok(Date.now() - started < SETTLE_LIMITS.animationsMs + 10_000, "infinite and long animations do not hold the capture");
    assert.equal(spun.contentHeight, 3000);
    started = Date.now();
    const grown = await browser.capture({ height: 800, scheme: "light", url: `${origin}/endless`, width: 800 });
    assert.ok(Date.now() - started < bound, "a page that grows on every scroll still finishes");
    assert.equal(grown.height, MAX_CAPTURE_HEIGHT, "scrolling stops at the capture height");
  });
});

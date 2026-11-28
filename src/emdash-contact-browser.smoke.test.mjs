import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { openBrowser } from "@remotion/renderer";
import { resolveBrowserExecutable } from "./consumer-browser.mjs";

test("marked contact forms preserve consent and share site-owned provider queues", { timeout: 60_000 }, async (t) => {
  let executable;
  try { executable = await resolveBrowserExecutable({ allowDownload: false }); }
  catch (error) {
    if (process.env.TIMDS_BROWSER_EXECUTABLE || !error.message.includes("downloading it was not allowed")) throw error;
    return t.skip("Install headless Chrome or set TIMDS_BROWSER_EXECUTABLE.");
  }
  const script = await readFile(new URL("../templates/emdash/site-workspace/public/timds-contact.js", import.meta.url));
  const submissions = [];
  let failNext = false;
  const server = createServer(async (request, response) => {
    const { pathname, searchParams } = new URL(request.url, "http://localhost");
    if (pathname === "/timds-contact.js") {
      response.writeHead(200, { "Content-Type": "text/javascript" }).end(script);
    } else if (pathname === "/contact" && request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const fields = new URLSearchParams(body);
      submissions.push(fields);
      response.writeHead(failNext ? 503 : 200, { "Content-Type": "application/json" }).end(JSON.stringify({
        receipt: fields.get("submission_id"), analytics: fields.get("analytics_consent") !== "no", marketing: fields.get("marketing_consent") !== "no",
      }));
      failNext = false;
    } else {
      const tags = { analytics: "G-EXAMPLE", ads: "AW-12345", lead: "example", pixel: "12345", consentOwner: searchParams.get("owner") };
      const existing = searchParams.has("existing") ? `<script>
        window.dataLayer = [];
        window.gtag = (...args) => window.dataLayer.push(args);
        window.gtag("consent", "default", {ad_storage: "denied"});
        if (new URLSearchParams(location.search).has("loaded")) window.google_tag_manager = {"G-EXAMPLE": {}};
        window.pixelCalls = [];
        window.originalPixel = window.fbq = (...args) => window.pixelCalls.push(args);
      </script>` : "";
      response.writeHead(200, { "Content-Type": "text/html", "Content-Security-Policy": "script-src 'self' 'unsafe-inline'; connect-src 'self'" }).end(`
        ${existing}
        <div data-timds-tracking='${JSON.stringify(tags)}' data-timds-attribution="true" data-timds-consent-required="${searchParams.has("required")}"></div>
        <form method="post" action="/contact" data-timds-contact>
          <input name="name" value="Example"><input name="email" value="visitor@example.com">
          <input name="analytics_consent" value="yes"><input name="marketing_consent" value="no">
        </form><script type="module" src="/timds-contact.js"></script>`);
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await openBrowser("chrome", { browserExecutable: executable, logLevel: "error" });
  try {
    const page = await browser.newPage({ context: () => null, logLevel: "error", indent: false, pageIndex: 0, onBrowserLog: null, onLog: () => {} });
    const visit = options => page.goto({ url: `http://127.0.0.1:${server.address().port}/?utm_source=fixture&gclid=example&${options}`, timeout: 10_000 });
    const choose = (analytics, marketing) => page.evaluate((analytics, marketing) => {
      window.timdsConsent = { analytics, marketing };
      window.dispatchEvent(new Event("timds:consent"));
    }, analytics, marketing);
    const submit = () => page.evaluate(() => new Promise(resolve => {
      const form = document.querySelector("form");
      form.addEventListener("timds:contact-result", event => resolve(event.detail.ok), { once: true });
      form.requestSubmit();
    }));
    const commands = () => page.evaluate(() => ({
      googleConsent: (window.dataLayer ?? []).filter(command => command[0] === "consent").map(command => command[1]),
      metaConsent: (window.pixelCalls ?? window.fbq?.queue ?? []).filter(command => command[0] === "consent").map(command => command[1]),
    }));

    for (const required of ["", "&required"]) {
      await visit("owner=auto&existing" + required);
      assert.equal(await submit(), true);
      const fields = submissions.at(-1);
      assert.equal(fields.get("analytics_consent"), "yes");
      assert.equal(fields.get("marketing_consent"), "no");
      assert.equal(fields.has("last_touch"), !required);
      if (!required) {
        const touch = new URL(JSON.parse(fields.get("last_touch")).url);
        assert.equal(touch.searchParams.get("utm_source"), "fixture");
        assert.equal(touch.searchParams.has("gclid"), false);
      }
      await choose(true, true);
      await page.evaluate(() => { document.querySelector("[name=marketing_consent]").value = "yes"; });
      assert.equal(await submit(), true);
      assert.equal(await page.evaluate(() => window.fbq === window.originalPixel && window.pixelCalls.some(call =>
        call[0] === "trackSingle" && call[1] === "12345" && call[2] === "Lead")), true);
      assert.equal(await page.evaluate(() => document.querySelectorAll("script[src*='/gtag/js']").length), 1,
        "a site-provided command queue still needs a Google tag loader");
      assert.equal(await page.evaluate(() => window.dataLayer.some(call =>
        call[0] === "event" && call[1] === "conversion" && call[2].send_to === "AW-12345/example")), true);
      await choose(false, false);
      assert.deepEqual(await commands(), { googleConsent: ["default"], metaConsent: [] });
      assert.equal(await page.evaluate(() => document.querySelectorAll("script[src*=fbevents]").length), 0);
      assert.equal(await submit(), true);
      assert.equal(submissions.at(-1).get("analytics_consent"), "no");
      assert.equal(submissions.at(-1).has("last_touch"), false);
    }

    await visit("owner=auto");
    await choose(true, false);
    assert.deepEqual(await commands(), { googleConsent: ["default", "update"], metaConsent: ["grant", "revoke"] });
    await visit("owner=site");
    await choose(true, false);
    assert.deepEqual(await commands(), { googleConsent: [], metaConsent: [] });
    await visit("owner=timds&existing&loaded");
    await choose(true, false);
    assert.deepEqual(await commands(), { googleConsent: ["default", "default", "update"], metaConsent: ["grant", "revoke"] });
    assert.equal(await page.evaluate(() => document.querySelectorAll("script[src*='/gtag/js']").length), 0);

    await choose(true, true);
    failNext = true;
    assert.equal(await submit(), false);
    const first = submissions.at(-1);
    await choose(false, true);
    failNext = true;
    assert.equal(await submit(), false);
    const retry = submissions.at(-1);
    assert.equal(retry.get("submission_id"), first.get("submission_id"));
    assert.equal(retry.get("analytics_consent"), "yes");
    await page.evaluate(() => { document.querySelector("[name=analytics_consent]").value = "no"; });
    assert.equal(await submit(), true);
    assert.notEqual(submissions.at(-1).get("submission_id"), first.get("submission_id"));
    assert.equal(submissions.at(-1).get("analytics_consent"), "no");
  } finally {
    await browser.close({ silent: true });
  }
});

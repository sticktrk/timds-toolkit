import assert from "node:assert/strict";
import test from "node:test";

import {
  BRAND_ROLES,
  buildTokensDocument,
  classifyToken,
  derivedTokensPath,
  importReferences,
  normalizeBrandRoles,
  parseCssTokens,
  resolveBrandRoles,
  resolveTokens,
  stylesheetReferences,
  substituteVars,
} from "./tokens.mjs";

const CSS = `
@charset "utf-8";
@import url("base.css") layer(base);
@import 'ramps.css';
/* :root{--commented-out:#000} */
:root{
  --navy-800:#10243d;--navy-900:#0a1729;
  --gold-300:#d4b876;
  --navy:var(--navy-800);
  --accent:var(--gold, var(--gold-300));
  --font-display:'Cormorant Garamond',Georgia,serif;
  --font-body:"Newsreader",Georgia,serif;
  --step-4:clamp(2.7rem,5vw,4.3rem);
  --space-1:4px;
  --icon:url("data:image/svg+xml;charset=utf8,%3Csvg%3E%3C/svg%3E");
  --ease:cubic-bezier(.2,.8,.2,1);
  --dur:180ms;
  --ratio:1.5;
  --hairline:linear-gradient(90deg,transparent,rgba(194,161,90,.5),transparent);
  --shadow:0 2px 14px var(--navy-900) !important;
}
[data-theme=dark]{--navy-900:#000000;--surface:var(--navy-900);--missing:var(--nope)}
@media (prefers-color-scheme: dark){
  :root{--panel:var(--navy-900)}
}
@layer components{
  .theme-admin{--font-ui:"Hanken Grotesk",system-ui,sans-serif}
}
@font-face{font-family:"Newsreader";src:url(/fonts/newsreader.woff2)}
@property --angle{syntax:"<angle>";initial-value:0deg;inherits:false}
.card{color:var(--navy);--card-pad:var(--space-1)}
`;

const records = parseCssTokens(CSS, { source: "/_astro/site.css" });
const byName = (name, selector = ":root") => records.find((record) => record.name === name && record.selector === selector);

test("harvests custom properties by scope and ignores comments, at-rule declarations, and ordinary properties", () => {
  assert.ok(!records.some((record) => record.name === "--commented-out"));
  assert.ok(!records.some((record) => record.name === "--angle"));
  assert.ok(!records.some((record) => record.name === "color"));
  assert.equal(byName("--navy-900").value, "#0a1729");
  assert.equal(byName("--navy-900").base, true);
  assert.equal(byName("--navy-900").source, "/_astro/site.css");
  assert.equal(byName("--navy-900", "[data-theme=dark]").value, "#000000");
  assert.equal(byName("--navy-900", "[data-theme=dark]").base, false);
});

test("keeps semicolons inside strings and url() data and drops !important", () => {
  assert.equal(byName("--icon").value, 'url("data:image/svg+xml;charset=utf8,%3Csvg%3E%3C/svg%3E")');
  assert.equal(byName("--shadow").value, "0 2px 14px var(--navy-900)");
  assert.equal(byName("--font-display").value, "'Cormorant Garamond',Georgia,serif");
});

test("records conditional at-rules as the scope condition and treats @layer as transparent", () => {
  const panel = byName("--panel");
  assert.deepEqual(panel.condition, ["@media (prefers-color-scheme: dark)"]);
  assert.equal(panel.base, false);
  const adminFont = byName("--font-ui", ".theme-admin");
  assert.deepEqual(adminFont.condition, []);
});

test("resolves var() chains in the record's own scope first, then :root, honouring fallbacks", () => {
  const resolved = resolveTokens(records);
  const pick = (name, selector = ":root") => resolved.find((record) => record.name === name && record.selector === selector);
  assert.equal(pick("--navy").resolved, "#10243d");
  assert.deepEqual(pick("--navy").references, ["--navy-800"]);
  assert.equal(pick("--accent").resolved, "#d4b876");
  assert.deepEqual(pick("--accent").references.sort(), ["--gold", "--gold-300"]);
  assert.equal(pick("--accent").unresolved, undefined);
  // The dark scope overrides --navy-900, so --surface in that scope sees the override.
  assert.equal(pick("--surface", "[data-theme=dark]").resolved, "#000000");
  // The media-scoped :root has no override of its own and inherits the base value.
  assert.equal(pick("--panel").resolved, "#0a1729");
  assert.equal(pick("--shadow").resolved, "0 2px 14px #0a1729");
  assert.deepEqual(pick("--missing", "[data-theme=dark]").unresolved, ["--nope"]);
  assert.equal(pick("--missing", "[data-theme=dark]").resolved, "var(--nope)");
  assert.equal(pick("--card-pad", ".card").resolved, "4px");
});

test("classifies resolved values coarsely", () => {
  const resolved = resolveTokens(records);
  const kind = (name) => resolved.find((record) => record.name === name).kind;
  assert.equal(kind("--navy-900"), "color");
  assert.equal(kind("--navy"), "color");
  assert.equal(kind("--font-display"), "font-family");
  assert.equal(kind("--font-body"), "font-family");
  assert.equal(kind("--step-4"), "length");
  assert.equal(kind("--space-1"), "length");
  assert.equal(kind("--ease"), "easing");
  assert.equal(kind("--dur"), "duration");
  assert.equal(kind("--ratio"), "number");
  assert.equal(kind("--hairline"), "gradient");
  assert.equal(kind("--icon"), "other");
  assert.equal(classifyToken("rgba(10, 23, 41, 0.96)"), "color");
  assert.equal(classifyToken("oklch(60% 0.1 250)"), "color");
  assert.equal(classifyToken("transparent"), "color");
  assert.equal(classifyToken("Inter, system-ui, sans-serif"), "font-family");
  assert.equal(classifyToken("calc(100% - 2rem)"), "length");
  assert.equal(classifyToken(""), "other");
});

test("substituteVars guards against cycles and leaves non-token var() alone", () => {
  const lookup = (name) => ({ "--a": "var(--b)", "--b": "var(--a)" })[name];
  const state = { depth: 0, references: new Set(), unresolved: new Set() };
  assert.match(substituteVars("var(--a)", lookup, state), /var\(--[ab]\)/);
  assert.equal(substituteVars("var(x)", () => undefined), "var(x)");
  assert.equal(substituteVars("var(--a, var(--c, 1px))", (name) => (name === "--c" ? "2px" : undefined)), "2px");
});

test("finds the stylesheets a page loads and a stylesheet's local imports", () => {
  const html = `<!doctype html><html><head>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet">
    <link rel="stylesheet" href="/_astro/site.css">
    <link rel="Stylesheet" href="../local.css?v=2">
    <style>:root{--inline:1}</style>
    <style>   </style>
  </head><body><main><h1>T</h1></main></body></html>`;
  const references = stylesheetReferences(html);
  assert.deepEqual(references.links, ["/_astro/site.css", "../local.css?v=2"]);
  assert.deepEqual(references.inline, [":root{--inline:1}"]);
  assert.deepEqual(importReferences(CSS), ["base.css", "ramps.css"]);
  assert.deepEqual(importReferences('@import url(https://cdn.example.com/x.css);@import "./y.css" screen;'), ["./y.css"]);
});

test("builds a stamped document with scope and kind summaries", () => {
  const document = buildTokensDocument({
    manifest: { systemId: "client/system", name: "Client", version: "1.2.3" },
    stylesheets: [{ path: "/_astro/site.css", bytes: CSS.length, sha256: "0".repeat(64) }],
    records,
  });
  assert.equal(document.schemaVersion, 1);
  assert.deepEqual(document.system, { id: "client/system", name: "Client", version: "1.2.3" });
  assert.equal(document.count, records.length);
  assert.equal(document.kinds.color >= 5, true);
  assert.deepEqual(document.scopes[0], { selector: ":root", condition: [], base: true, count: 15 });
  assert.ok(document.scopes.some((scope) => scope.selector === "[data-theme=dark]" && scope.count === 3));
  assert.ok(document.scopes.some((scope) => scope.condition[0] === "@media (prefers-color-scheme: dark)"));
  assert.equal(document.tokens[0].name, "--navy-800");
  assert.ok(document.tokens.every((token) => typeof token.resolved === "string" && token.kind));
});

test("validates brand role mappings from the manifest", () => {
  assert.deepEqual(normalizeBrandRoles(undefined), {});
  assert.deepEqual(normalizeBrandRoles({ "color.accent": " --gold-300 " }), { "color.accent": "--gold-300" });
  assert.throws(() => normalizeBrandRoles({ accent: "--gold" }), /must be color\.<name> or font\.<name>/);
  assert.throws(() => normalizeBrandRoles({ "color.accent": "gold" }), /must name a CSS custom property/);
  assert.throws(() => normalizeBrandRoles(["--gold"]), /must be an object/);
});

test("fills brand roles by convention from the document scope, honouring kind and cascade order", () => {
  const starter = resolveTokens(parseCssTokens(
    ":root{--color-ink:#17202a;--color-muted:#5d6876;--color-canvas:#f5f7fa;--color-surface:#fff;--color-accent:#2457d6;--font-sans:ui-sans-serif,sans-serif;--font-serif:Georgia,serif}",
  ));
  const { roles, errors, missing } = resolveBrandRoles(starter);
  assert.deepEqual(errors, []);
  assert.deepEqual(missing, []);
  assert.equal(roles["color.background"].token, "--color-canvas");
  assert.equal(roles["color.text"].value, "#17202a");
  assert.equal(roles["font.display"].token, "--font-serif");
  assert.equal(roles["font.body"].token, "--font-sans");
  assert.equal(roles["font.ui"].token, "--font-sans");
  assert.ok(Object.values(roles).every((role) => role.source === "convention"));

  // A candidate of the wrong kind is skipped; a theme-scoped declaration never fills a role;
  // the later of two :root declarations wins.
  const odd = resolveTokens(parseCssTokens(
    ":root{--accent:linear-gradient(red,blue);--brand:#123}[data-theme=dark]{--bg:#000}:root{--text:#111}:root{--text:#222}",
  ));
  const filled = resolveBrandRoles(odd);
  assert.equal(filled.roles["color.accent"].token, "--brand");
  assert.equal(filled.roles["color.text"].value, "#222");
  assert.ok(filled.missing.includes("color.background"));
  assert.ok(Object.keys(BRAND_ROLES).every((role) => filled.roles[role] || filled.missing.includes(role)));
});

test("explicit mappings override conventions and must name a matching :root token", () => {
  const tokens = resolveTokens(parseCssTokens(":root{--accent:#111;--gold-300:#d4b876;--step-1:1rem}[data-theme=dark]{--night:#000}"));
  const mapped = resolveBrandRoles(tokens, { "color.accent": "--gold-300", "color.highlight": "--gold-300" });
  assert.deepEqual(mapped.errors, []);
  assert.deepEqual(mapped.roles["color.accent"], { token: "--gold-300", value: "#d4b876", kind: "color", source: "manifest" });
  assert.equal(mapped.roles["color.highlight"].source, "manifest");

  const broken = resolveBrandRoles(tokens, { "color.accent": "--nope", "color.text": "--step-1", "color.muted": "--night" });
  assert.equal(broken.errors.length, 3);
  assert.match(broken.errors[0], /--nope, which no loaded stylesheet declares on :root/);
  assert.match(broken.errors[1], /--step-1, which resolves to 1rem \(length\), not a color/);
  assert.match(broken.errors[2], /--night, which no loaded stylesheet declares on :root/);
  assert.throws(
    () => buildTokensDocument({ manifest: { systemId: "s", name: "S", version: "1", brand: { roles: { "color.accent": "--nope" } } }, stylesheets: [], records: tokens }),
    /brand\.roles does not match the built stylesheets/,
  );
});

test("the document carries filled roles and reports the unfilled ones", () => {
  const document = buildTokensDocument({
    manifest: { systemId: "s", name: "S", version: "1" },
    stylesheets: [],
    records: parseCssTokens(":root{--accent:#111;--font-body:serif}"),
  });
  assert.equal(document.roles["color.accent"].value, "#111");
  assert.equal(document.roles["font.body"].token, "--font-body");
  assert.equal(document.roles["font.ui"].token, "--font-body");
  assert.deepEqual(document.missingRoles, ["color.background", "color.panel", "color.text", "color.muted", "font.display"]);
  assert.equal(derivedTokensPath("/ds", { artifact: { entry: "design-system/index.html" } }), "/ds/dist/design-system/tokens.json");
  assert.equal(derivedTokensPath("/ds", {}), "/ds/dist/tokens.json");
});

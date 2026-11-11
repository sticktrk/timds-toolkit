import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  WORKSPACE_CHECK_SCHEMA_VERSION,
  checkWorkspaceSite,
  fontStackKey,
  formatWorkspaceFindings,
  normalizeColor,
} from "./consumer-workspace-check.mjs";

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "timds-workspace-check-"));
  t.after(() => fs.rm(directory, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 }));
  return fs.realpath(directory);
}

async function write(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, ...relative.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
}

const read = (root, relative) => fs.readFile(path.join(root, ...relative.split("/")), "utf8");

const SURFACE = ["src/styles/**", "src/components/**", "src/pages/**", "src/layouts/**"];

/** A Design System whose tokens are CSS custom properties in src/styles/system.css, with a site in site/. */
async function cssSystem(t, { systemCss, site = {} } = {}) {
  const root = await temporaryDirectory(t);
  await write(root, {
    "timds.json": { schemaVersion: 2, systemId: "acme/core", name: "Acme", workspace: { build: ["npm", "run", "build"] } },
    "src/styles/system.css": systemCss ?? `:root {
  --color-ink: #1a1a1a;
  --color-surface: #ffffff;
  --color-accent: #0055ff;
  --font-sans: "Inter", Arial, sans-serif;
}
[data-theme="dark"] { --color-night: #101010; }
.button { color: var(--color-ink); }
.card { background: var(--color-surface); }
`,
    "src/styles/viewer.css": ".viewer-only { color: #123123; }\n",
    ...Object.fromEntries(Object.entries(site).map(([relative, content]) => [`site/${relative}`, content])),
  });
  return { root, siteRoot: path.join(root, "site") };
}

/** A starter-build Design System: tokens only in tokens.json, classes in src/styles/system.css. */
async function starterSystem(t, { tokens, site = {} } = {}) {
  const root = await temporaryDirectory(t);
  await write(root, {
    "timds.json": { schemaVersion: 2, systemId: "acme/starter", name: "Starter", workspace: { build: ["node", "scripts/build.mjs"] } },
    "tokens.json": tokens ?? {
      color: {
        ink: { value: "#222222" },
        canvas: { value: "#FAFAFA" },
        accent: { value: "hsl(220, 100%, 50%)" },
      },
      font: { serif: { value: "Georgia, serif" } },
      space: { "4": { value: "1rem" } },
    },
    "src/styles/system.css": "body { color: var(--color-ink); }\n.wrap { margin-inline: auto; }\n.prose { max-width: 40rem; }\n",
    ...Object.fromEntries(Object.entries(site).map(([relative, content]) => [`site/${relative}`, content])),
  });
  return { root, siteRoot: path.join(root, "site") };
}

const run = (fixture, options = {}) => checkWorkspaceSite({
  siteRoot: fixture.siteRoot,
  designSystemRoot: fixture.root,
  designSurface: SURFACE,
  ...options,
});

test("color normalization compares notation and case, not spelling", () => {
  const white = normalizeColor("#ffffff");
  for (const value of ["#FFF", "#fff", "#FFFFFF", "#ffff", "#ffffffff", "rgb(255,255,255)", "rgb(255 255 255)", "RGBA(255, 255, 255, 1)", "rgb(100% 100% 100% / 100%)", "hsl(0, 0%, 100%)", "hsl(0deg 0% 100%)", "white", "White"]) {
    assert.equal(normalizeColor(value), white, value);
  }
  assert.equal(normalizeColor("rgba(0, 0, 0, 0.5)"), normalizeColor("#00000080"));
  assert.equal(normalizeColor("hsl(220, 100%, 50%)"), normalizeColor("#0055ff"));
  assert.notEqual(normalizeColor("#fffffe"), white);
  assert.equal(normalizeColor("transparent"), null);
  assert.equal(normalizeColor("var(--x)"), null);
  assert.equal(fontStackKey('"Inter", Arial, sans-serif'), fontStackKey("inter,arial,SANS-SERIF"));
  assert.equal(fontStackKey("sans-serif"), null);
  assert.equal(fontStackKey("inherit"), null);
});

test("a literal equal to one token is rewritten; an unknown one is a finding until the system adds the token", async (t) => {
  const fixture = await cssSystem(t, {
    site: {
      "src/styles/site.css": "/* site */\r\n.card {\r\n  color: #1A1A1A;\r\n  border: 1px solid #abcdef;\r\n\tbackground: rgb(255 255 255) !important;\r\n}\r\n",
    },
  });
  const first = await run(fixture);
  assert.equal(first.schemaVersion, WORKSPACE_CHECK_SCHEMA_VERSION);
  assert.deepEqual(first.scanned, ["src/styles/site.css"]);
  assert.deepEqual(first.changedFiles, ["src/styles/site.css"]);
  assert.deepEqual(first.rewrites.map(({ line, column, from, to, applied, token }) => ({ line, column, from, to, applied, token })), [
    { line: 3, column: 10, from: "#1A1A1A", to: "var(--color-ink)", applied: true, token: "--color-ink" },
    { line: 5, column: 14, from: "rgb(255 255 255)", to: "var(--color-surface)", applied: true, token: "--color-surface" },
  ]);
  assert.equal(first.findings.length, 1);
  const [finding] = first.findings;
  assert.deepEqual({ kind: finding.kind, file: finding.file, line: finding.line, column: finding.column, property: finding.property, value: finding.value, candidates: finding.candidates }, {
    kind: "literal", file: "src/styles/site.css", line: 4, column: 21, property: "border", value: "#abcdef", candidates: [],
  });
  assert.match(finding.suggestion, /src\/styles\/system\.css/);
  assert.match(finding.suggestion, /border: 1px solid var\(--<name>\)/);
  // Every other byte is kept: CRLF, the tab, the comment, !important.
  assert.equal(await read(fixture.siteRoot, "src/styles/site.css"),
    "/* site */\r\n.card {\r\n  color: var(--color-ink);\r\n  border: 1px solid #abcdef;\r\n\tbackground: var(--color-surface) !important;\r\n}\r\n");
  assert.match(formatWorkspaceFindings(first, { prefix: "site/" }), /site\/src\/styles\/site\.css:4:21 literal border: #abcdef/);

  // The agent adds the token to the system and uses it in the site: a second run is clean.
  const systemCss = await read(fixture.root, "src/styles/system.css");
  await write(fixture.root, { "src/styles/system.css": systemCss.replace("--font-sans", "--color-line: #abcdef;\n  --font-sans") });
  const site = await read(fixture.siteRoot, "src/styles/site.css");
  await write(fixture.siteRoot, { "src/styles/site.css": site.replace("#abcdef", "var(--color-line)") });
  const second = await run(fixture);
  assert.deepEqual(second.rewrites, []);
  assert.deepEqual(second.findings, []);
  assert.deepEqual(second.changedFiles, []);
  assert.match(formatWorkspaceFindings(second), /use only what the Design System declares/);
});

test("a rewrite run twice is a no-op and fix: false reports without writing", async (t) => {
  const css = ".card { color: #FFF; outline-color: White; box-shadow: 0 0 0 1px rgba(26, 26, 26, 1); }\n";
  const fixture = await cssSystem(t, { site: { "src/styles/site.css": css } });
  const dry = await run(fixture, { fix: false });
  assert.equal(dry.rewrites.length, 3);
  assert.ok(dry.rewrites.every((rewrite) => rewrite.applied === false));
  assert.deepEqual(dry.changedFiles, []);
  assert.equal(await read(fixture.siteRoot, "src/styles/site.css"), css);
  assert.match(formatWorkspaceFindings(dry), /3 literals equal exactly one system token/);

  const fixed = await run(fixture);
  assert.equal(fixed.rewrites.length, 3);
  const after = await read(fixture.siteRoot, "src/styles/site.css");
  assert.equal(after, ".card { color: var(--color-surface); outline-color: var(--color-surface); box-shadow: 0 0 0 1px var(--color-ink); }\n");
  const again = await run(fixture);
  assert.deepEqual(again.rewrites, []);
  assert.deepEqual(again.findings, []);
  assert.equal(await read(fixture.siteRoot, "src/styles/site.css"), after);
});

test("a value several tokens hold is ambiguous and never rewritten", async (t) => {
  const fixture = await cssSystem(t, {
    systemCss: ":root { --brand-blue: #0055ff; --color-accent: var(--brand-blue); --color-link: #05f; }\n.button { color: red; }\n",
    site: { "src/styles/site.css": "a { color: #0055FF; }\n" },
  });
  const result = await run(fixture);
  assert.deepEqual(result.rewrites, []);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].kind, "ambiguous-literal");
  assert.deepEqual(result.findings[0].candidates, ["--brand-blue", "--color-accent", "--color-link"]);
  assert.match(result.findings[0].suggestion, /color: var\(<chosen token>\)/);
  assert.equal(await read(fixture.siteRoot, "src/styles/site.css"), "a { color: #0055FF; }\n");
});

test("keywords, lengths, theme-scoped values, dead fallbacks and descriptors are left alone", async (t) => {
  const fixture = await cssSystem(t, {
    site: {
      "src/styles/site.css": `@font-face { font-family: "Site Face"; src: url(/f.woff2); }
.card {
  color: currentColor;
  background: transparent;
  border-color: inherit;
  padding: 12px 1.5rem;
  font-family: inherit;
  font-family: var(--font-sans);
  background-image: url("#ffffff");
  content: "#ffffff";
  color: var(--color-ink, #000000);
  fill: url(#gradient);
}
.night { color: #101010; }
`,
    },
  });
  const result = await run(fixture);
  assert.deepEqual(result.rewrites, []);
  // Only the dark-scope value surfaces: it is no document-scope token's.
  assert.deepEqual(result.findings.map((finding) => [finding.kind, finding.value, finding.line]), [["class", undefined, 14], ["literal", "#101010", 14]]);
});

test("literals inside site variables, var() fallbacks and color-mix are checked; a redefined system token is a finding", async (t) => {
  const fixture = await cssSystem(t, {
    site: {
      "src/styles/site.css": `:root { --site-edge: #ffffff; --color-accent: #ff0000; }
.card { color: var(--site-tone, #1a1a1a); background: color-mix(in srgb, #0055ff 20%, white); }
`,
    },
  });
  const result = await run(fixture);
  assert.deepEqual(result.rewrites.map((rewrite) => `${rewrite.line}:${rewrite.from}->${rewrite.to}`), [
    "1:#ffffff->var(--color-surface)",
    "2:#1a1a1a->var(--color-ink)",
    "2:#0055ff->var(--color-accent)",
    "2:white->var(--color-surface)",
  ]);
  assert.deepEqual(result.findings.map((finding) => [finding.kind, finding.property]), [["token-override", "--color-accent"]]);
  assert.equal(await read(fixture.siteRoot, "src/styles/site.css"), `:root { --site-edge: var(--color-surface); --color-accent: #ff0000; }
.card { color: var(--site-tone, var(--color-ink)); background: color-mix(in srgb, var(--color-accent) 20%, var(--color-surface)); }
`);
});

test("font-family stacks match font tokens", async (t) => {
  const fixture = await cssSystem(t, {
    site: { "src/styles/site.css": "h1 { font-family: 'inter', arial, SANS-SERIF; }\nh2 { font-family: \"Fraunces\", serif; }\npre { font-family: monospace; }\n" },
  });
  const result = await run(fixture);
  assert.deepEqual(result.rewrites.map((rewrite) => [rewrite.from, rewrite.to]), [["'inter', arial, SANS-SERIF", "var(--font-sans)"]]);
  assert.deepEqual(result.findings.map((finding) => [finding.kind, finding.value]), [["literal", '"Fraunces", serif']]);
  assert.equal(await read(fixture.siteRoot, "src/styles/site.css"), "h1 { font-family: var(--font-sans); }\nh2 { font-family: \"Fraunces\", serif; }\npre { font-family: monospace; }\n");
});

test("a class used or declared in the site is a finding until a system stylesheet declares it", async (t) => {
  const fixture = await cssSystem(t, {
    site: {
      "src/components/Card.html": '<div class="card promo">\n  <span class="promo viewer-only">x</span>\n</div>\n',
      "src/styles/site.css": ".promo .card { margin: 0; }\n",
    },
  });
  const first = await run(fixture);
  assert.deepEqual(first.findings.map((finding) => [finding.file, finding.line, finding.column, finding.class]), [
    ["src/components/Card.html", 1, 18, "promo"],
    ["src/components/Card.html", 2, 22, "viewer-only"],
    ["src/styles/site.css", 1, 1, "promo"],
  ]);
  assert.match(first.findings[2].suggestion, /Add a \.promo rule to src\/styles\/system\.css/);

  await write(fixture.root, { "src/styles/system.css": `${await read(fixture.root, "src/styles/system.css")}.promo { border: 0; }\n` });
  const second = await run(fixture);
  assert.deepEqual(second.findings.map((finding) => finding.class), ["viewer-only"]);
});

test(".astro: frontmatter, a <style> block, inline style and class:list", async (t) => {
  const astro = `---
import Layout from "../layouts/Layout.astro";
const tone = "#ffffff";
const a = 1 < 2 ? "x" : "y";
---
<Layout title="Home">
  <section class="card" style="color: #1a1a1a; padding: 2px">
    <p class:list={["button", { promo: tone, "is-open": true }, tone && "skipped", cond ? "also-skipped" : ""]}>Hi</p>
    <p className={"card"} class={dynamic}>{a}</p>
  </section>
</Layout>
<script>
  document.body.innerHTML = '<div class="from-script" style="color: #abcdef"></div>';
</script>
<style>
  .card { border-color: #0055ff; }
</style>
`;
  const fixture = await cssSystem(t, { site: { "src/pages/index.astro": astro } });
  const result = await run(fixture);
  assert.deepEqual(result.rewrites.map((rewrite) => [rewrite.line, rewrite.from, rewrite.to]), [
    [7, "#1a1a1a", "var(--color-ink)"],
    [16, "#0055ff", "var(--color-accent)"],
  ]);
  assert.deepEqual(result.findings.map((finding) => [finding.kind, finding.class]), [["class", "promo"], ["class", "is-open"]]);
  const after = await read(fixture.siteRoot, "src/pages/index.astro");
  assert.equal(after, astro.replace("color: #1a1a1a", "color: var(--color-ink)").replace("border-color: #0055ff", "border-color: var(--color-accent)"));
  const again = await run(fixture);
  assert.deepEqual(again.rewrites, []);
});

test("a starter-build system's tokens come from tokens.json", async (t) => {
  const fixture = await starterSystem(t, {
    site: {
      "src/styles/site.css": ".wrap { color: #222; background: #fafafa; border-color: #0055ff; font-family: georgia, serif; gap: 1rem; }\n.prose a { color: #ff00ff; }\n",
    },
  });
  const result = await run(fixture);
  assert.deepEqual(result.system.stylesheets, ["src/styles/system.css"]);
  assert.equal(result.system.tokensJson, true);
  assert.deepEqual(result.rewrites.map((rewrite) => rewrite.to), ["var(--color-ink)", "var(--color-canvas)", "var(--color-accent)", "var(--font-serif)"]);
  assert.equal(result.findings.length, 1);
  assert.match(result.findings[0].suggestion, /tokens\.json, group "color"/);
  assert.match(result.findings[0].suggestion, /color: var\(--color-<name>\)/);
});

test("tokens.json references resolve like the viewer's compile", async (t) => {
  const fixture = await starterSystem(t, {
    tokens: { color: { blue: { value: "#0000ff" }, accent: { value: "{color.blue}" } } },
    site: { "src/styles/site.css": "a { color: blue; }\n" },
  });
  const result = await run(fixture);
  assert.deepEqual(result.findings.map((finding) => [finding.kind, finding.candidates]), [["ambiguous-literal", ["--color-accent", "--color-blue"]]]);
});

test("stylesheets the site imports from the workspace and bundle.include count as the system's", async (t) => {
  const root = await temporaryDirectory(t);
  await write(root, {
    "timds.json": { systemId: "acme/framework", workspace: { build: ["npm", "run", "build"] }, bundle: { include: ["styles/ds/**"], exclude: ["styles/ds/legacy.css"] } },
    "styles/ds/core.css": "@import \"./parts/tokens.css\";\n.hero { display: block; }\n",
    "styles/ds/parts/tokens.css": ":root { --ink: #333333; }\n",
    "styles/ds/legacy.css": ".legacy { color: red; }\n",
    "theme/extra.css": ".extra { color: var(--ink); }\n",
    "site/src/layouts/Layout.astro": "---\nimport \"../../../theme/extra.css\";\n---\n<main class=\"hero extra legacy\"><slot /></main>\n",
    "site/src/styles/site.css": "p { color: #333; }\n",
  });
  const result = await checkWorkspaceSite({ siteRoot: path.join(root, "site"), designSystemRoot: root, designSurface: SURFACE });
  assert.deepEqual(result.system.stylesheets, ["styles/ds/parts/tokens.css", "styles/ds/core.css", "theme/extra.css"]);
  assert.deepEqual(result.rewrites.map((rewrite) => rewrite.to), ["var(--ink)"]);
  assert.deepEqual(result.findings.map((finding) => finding.class), ["legacy"]);
  assert.match(result.findings[0].suggestion, /styles\/ds\/core\.css/);
});

test("a protected path is reported, never rewritten", async (t) => {
  const fixture = await cssSystem(t, { site: { "src/components/server/Admin.css": ".card { color: #ffffff; }\n" } });
  const result = await run(fixture, { designSurface: ["src/components/**"], protected: ["src/components/server/**"] });
  assert.deepEqual(result.rewrites, []);
  assert.deepEqual(result.changedFiles, []);
  assert.deepEqual(result.findings.map((finding) => [finding.kind, finding.candidates]), [["literal", ["--color-surface"]]]);
  assert.match(result.findings[0].suggestion, /protected/);
  assert.equal(await read(fixture.siteRoot, "src/components/server/Admin.css"), ".card { color: #ffffff; }\n");
});

test("files limits the scan, and nothing outside the surface or ignored is touched", async (t) => {
  const css = ".card { color: #ffffff; }\n";
  const fixture = await cssSystem(t, {
    site: {
      "src/styles/a.css": css,
      "src/styles/b.css": css,
      "src/lib/outside.css": css,
      "node_modules/pkg/x.css": css,
      "dist/out.css": css,
      ".astro/gen.css": css,
      "src/styles/.cache/c.css": css,
    },
  });
  const limited = await run(fixture, { files: ["src/styles/b.css", "./src/lib/outside.css"] });
  assert.deepEqual(limited.scanned, ["src/styles/b.css"]);
  assert.deepEqual(limited.changedFiles, ["src/styles/b.css"]);
  assert.equal(await read(fixture.siteRoot, "src/styles/a.css"), css);

  const all = await run(fixture);
  assert.deepEqual(all.scanned, ["src/styles/a.css", "src/styles/b.css"]);
  for (const untouched of ["src/lib/outside.css", "node_modules/pkg/x.css", "dist/out.css", ".astro/gen.css", "src/styles/.cache/c.css"]) {
    assert.equal(await read(fixture.siteRoot, untouched), css, untouched);
  }
  // The Design System is never written.
  assert.match(await read(fixture.root, "src/styles/system.css"), /--color-surface: #ffffff/);
});

test("a failed write restores the files already written", async (t) => {
  const fixture = await cssSystem(t, { site: { "src/styles/a.css": "a { color: #fff; }\n", "src/styles/b.css": "b { color: #fff; }\n" } });
  let calls = 0;
  await assert.rejects(run(fixture, {
    writeFile: async (file, content) => {
      calls += 1;
      if (calls === 2) throw new Error("disk full");
      await fs.writeFile(file, content);
    },
  }), /disk full/);
  assert.equal(await read(fixture.siteRoot, "src/styles/a.css"), "a { color: #fff; }\n");
  assert.equal(await read(fixture.siteRoot, "src/styles/b.css"), "b { color: #fff; }\n");
});

test("jsx, vue and svelte: only static class names and quoted styles are read", async (t) => {
  const fixture = await cssSystem(t, {
    site: {
      "src/components/A.tsx": 'export const A = ({ on }: { on: boolean }) => <div className="card" data-x={on ? "nope" : "no"}><b className={cn("x", on && "y")} style={{ color: "#abcdef" }} /></div>;\n',
      "src/components/B.vue": '<template><div class="card" :class="{ dyn: on }" style="color: #ffffff"></div></template>\n<style lang="scss">$x: #abcdef; .scss-only { color: $x; }</style>\n',
      "src/components/C.svelte": '<div class="card size-{size} {extra}" class:active={on}></div>\n<style>.card { color: #1a1a1a; }</style>\n',
    },
  });
  const result = await run(fixture);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.rewrites.map((rewrite) => [rewrite.file, rewrite.to]), [
    ["src/components/B.vue", "var(--color-surface)"],
    ["src/components/C.svelte", "var(--color-ink)"],
  ]);
});

test("a git-ignored site file is not scanned", async (t) => {
  const fixture = await cssSystem(t, {
    site: { "src/styles/kept.css": "a { color: #fff; }\n", "src/styles/generated.css": "a { color: #fff; }\n" },
  });
  execFileSync("git", ["init", "-q"], { cwd: fixture.root });
  await write(fixture.root, { ".gitignore": "site/src/styles/generated.css\n" });
  const result = await run(fixture);
  assert.deepEqual(result.scanned, ["src/styles/kept.css"]);
  assert.equal(await read(fixture.siteRoot, "src/styles/generated.css"), "a { color: #fff; }\n");
});

test("a system that keeps tokens/ groups is read from them, and a suggestion names the group file, not the generated tokens.json", async (t) => {
  const fixture = await starterSystem(t, {
    site: { "src/styles/site.css": ".wrap { color: #222; }\n.prose a { color: #ff00ff; }\n" },
  });
  // tokens.json is a stale generated view; the groups are the authored source.
  await write(fixture.root, {
    ".timds/contract-layout.json": { schemaVersion: 1 },
    "tokens.json": { color: { ink: { value: "#999999" } } },
    "tokens/color.json": { ink: { value: "#222222" } },
    "media/brand.json": {},
  });
  let result = await run(fixture);
  assert.deepEqual(result.rewrites.map((rewrite) => [rewrite.from, rewrite.to]), [["#222", "var(--color-ink)"]]);
  assert.equal(result.findings.length, 1);
  assert.match(result.findings[0].suggestion, /tokens\/color\.json/);
  assert.match(result.findings[0].suggestion, /tokens\.json is generated from tokens\//);

  // The agent adds the token to its group; the next run sees it without a system build.
  await write(fixture.root, { "tokens/color.json": { ink: { value: "#222222" }, link: { value: "#ff00ff" } } });
  result = await run(fixture);
  assert.deepEqual(result.rewrites.map((rewrite) => rewrite.to), ["var(--color-link)"]);
  assert.deepEqual(result.findings, []);
});

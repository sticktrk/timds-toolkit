import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildChangelog,
  changelogDocument,
  compareDesignSystemVersions,
  inlineHtml,
  isDesignSystemVersion,
  nextDesignSystemVersion,
  parseChangelog,
  parseDesignSystemVersion,
  readUnreleasedNotes,
  renderChangelog,
} from "./changelog.mjs";
import { validateArtifact } from "./core.mjs";
import { extractArtifact } from "./extract.mjs";

const MANIFEST = { systemId: "client/system", name: "Client & Co", description: "The system.", version: "2026.10.12-2", artifact: { entry: "index.html" } };
const NOW = new Date("2026-10-12T15:00:00Z");

const CHANGELOG = `# Design System Changelog

Every release, newest first.

## Unreleased

- Brand · Logo: add the one-color lockup.

## 2026.10.12-2

- Brand · Color: darken the accent so body links pass contrast on the canvas.
  See the [Color page](/brand/color/).
- Print DS: add **Booklets**, a 6 × 9 trade booklet with cover wraps.
  - interior spreads and a style guide
  - a sample-interior PDF export
- Maintenance: Upgrade TimDS to \`0.1.461\`.

## 2026.10.12-1

Rename the Marketing view to **Web DS** in the selector, page eyebrows, and cross-references. URLs stay under /web/.

## 1.3.142

- Upgrade TimDS to 0.1.458
`;

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "timds-changelog-"));
  t.after(() => fs.rm(directory, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 }));
  return fs.realpath(directory);
}

test("dated versions parse, order above legacy ones, and count up within a UTC day", () => {
  assert.deepEqual(parseDesignSystemVersion("2026.10.12-3"), { kind: "dated", version: "2026.10.12-3", date: "2026-10-12", build: 3 });
  assert.deepEqual(parseDesignSystemVersion("1.3.142"), { kind: "legacy", version: "1.3.142", parts: [1, 3, 142] });
  for (const invalid of ["2026.13.01-1", "2026.02.30-1", "2026.10.12-0", "2026.10.12.1", "v2026.10.12-1", "", null]) {
    assert.equal(parseDesignSystemVersion(invalid), null, String(invalid));
  }
  assert.deepEqual(["2026.10.12-1", "0.1.0"].map(isDesignSystemVersion), [true, true]);
  assert.ok(compareDesignSystemVersions("2026.10.12-2", "2026.10.12-1") > 0);
  assert.ok(compareDesignSystemVersions("2026.10.12-9", "2026.10.13-1") < 0);
  assert.ok(compareDesignSystemVersions("2026.01.01-1", "99.99.99") > 0, "every dated version follows every legacy one");
  assert.ok(compareDesignSystemVersions("1.3.142", "1.3.141") > 0);
  assert.equal(compareDesignSystemVersions("1.3.142", "1.3.142"), 0);
  assert.throws(() => compareDesignSystemVersions("x", "1.0.0"), /Invalid Design System version "x"/);
  assert.equal(nextDesignSystemVersion("2026.10.12-2", NOW), "2026.10.12-3");
  assert.equal(nextDesignSystemVersion("2026.10.11-7", NOW), "2026.10.12-1");
  assert.equal(nextDesignSystemVersion("1.3.142", NOW), "2026.10.12-1", "a legacy system moves onto today's date");
  assert.equal(nextDesignSystemVersion("2026.10.12-2", new Date("2026-10-12T23:59:59Z")), "2026.10.12-3");
  assert.equal(nextDesignSystemVersion("2026.10.12-2", new Date("2026-10-13T00:00:00Z")), "2026.10.13-1");
  assert.equal(nextDesignSystemVersion("2026.10.20-1", NOW), "2026.10.20-2", "a current version dated ahead counts up on its day; the next version never regresses");
});

test("parseChangelog reads sections, entries, areas, continuation lines, nested items, and paragraphs", () => {
  const parsed = parseChangelog(CHANGELOG);
  assert.equal(parsed.title, "Design System Changelog");
  assert.deepEqual(parsed.intro, ["Every release, newest first."]);
  assert.deepEqual(parsed.unreleased.map((entry) => [entry.area, entry.text]), [["Brand · Logo", "add the one-color lockup."]]);
  assert.deepEqual(parsed.releases.map((release) => [release.version, release.date, release.build, release.entries.length]), [
    ["2026.10.12-2", "2026-10-12", 2, 3],
    ["2026.10.12-1", "2026-10-12", 1, 1],
    ["1.3.142", null, null, 1],
  ]);
  const [color, booklets, maintenance] = parsed.releases[0].entries;
  assert.equal(color.area, "Brand · Color");
  assert.equal(color.text, "darken the accent so body links pass contrast on the canvas. See the Color page.");
  assert.equal(color.markdown, "darken the accent so body links pass contrast on the canvas. See the [Color page](/brand/color/).");
  assert.equal(booklets.area, "Print DS");
  assert.deepEqual(booklets.items, ["interior spreads and a style guide", "a sample-interior PDF export"]);
  assert.equal(booklets.markdown, "add **Booklets**, a 6 × 9 trade booklet with cover wraps.\n- interior spreads and a style guide\n- a sample-interior PDF export");
  assert.equal(maintenance.area, "Maintenance");
  assert.equal(maintenance.text, "Upgrade TimDS to 0.1.461.");
  // A paragraph without a bullet is still an entry; a sentence with a colon far in keeps no area.
  const rename = parsed.releases[1].entries[0];
  assert.equal(rename.area, null);
  assert.match(rename.text, /^Rename the Marketing view to Web DS/);
  assert.equal(parsed.releases[2].entries[0].area, null, "no colon, no area");
  assert.deepEqual(parsed.problems, []);
  // Area rules: short, capitalized, no period, at most six words.
  assert.equal(parseChangelog("## 2026.10.12-1\n\n- Add the Print DS principle \"Write on paper, never on ink\": every write-in field takes pen.\n").releases[0].entries[0].area, null);
  assert.equal(parseChangelog("## 2026.10.12-1\n\n- Web DS · Components: buttons gain a quiet variant.\n").releases[0].entries[0].area, "Web DS · Components");
  assert.equal(parseChangelog("## 2026.10.12-1\n\n- Note: the build at 3:00: fine.\n").releases[0].entries[0].text, "the build at 3:00: fine.");
  // Headings that are not versions are listed as written and reported.
  const odd = parseChangelog("## Unreleased\n\n## Spring refresh\n\n- x\n\n## 1.0.0\n\n- y\n\n## 1.0.0\n\n- z\n");
  assert.deepEqual(odd.releases.map((release) => release.version), ["Spring", "1.0.0", "1.0.0"]);
  assert.deepEqual(odd.problems, ['heading "## Spring refresh" is not a Design System version (2026.10.12-1); it is listed as written', "version 1.0.0 has two sections"]);
  assert.deepEqual(parseChangelog("# Title\n\n## Unreleased\n").releases, []);
});

test("inline markdown becomes safe HTML", () => {
  assert.equal(inlineHtml("a **b** `<c>` [d](/e/) *f* <g> & h"), 'a <strong>b</strong> <code>&lt;c&gt;</code> <a href="/e/">d</a> <em>f</em> &lt;g&gt; &amp; h');
  assert.equal(inlineHtml("[x](javascript:alert(1))"), "[x](javascript:alert(1))", "only http(s) and site-absolute links become anchors");
  assert.equal(inlineHtml("6 × 9 and 2 * 3 * 4"), "6 × 9 and 2 * 3 * 4", "stray asterisks stay literal");
});

test("renders the page and document into the artifact, skipped by guidance extraction and summarized in the index", async (t) => {
  const root = await temporaryDirectory(t);
  await fs.writeFile(path.join(root, "CHANGELOG.md"), CHANGELOG);
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  await fs.writeFile(path.join(root, "dist", "tokens.css"), ":root { --color-accent: #123; }\n");
  await fs.writeFile(path.join(root, "dist", "index.html"), '<!doctype html><html><head><title>Client</title></head><body><main><h1>Client &amp; Co</h1><section class="block" id="a"><h2>Rules</h2><p>Lead.</p></section></main></body></html>');

  const rendered = await renderChangelog({ designSystemRoot: root, manifest: MANIFEST });
  assert.deepEqual([rendered.releaseCount, rendered.entryCount, rendered.unreleasedCount, rendered.url, rendered.outputDirectory], [3, 5, 1, "/changelog/", "changelog"]);
  assert.deepEqual([...rendered.files.keys()], ["changelog/index.html", "changelog/_changelog.css"]);
  const html = rendered.files.get("changelog/index.html");
  assert.match(html, /<title>Changelog · Client &amp; Co<\/title>/);
  assert.match(html, /<link rel="stylesheet" href="\/tokens\.css">\n\s*<link rel="stylesheet" href="\/changelog\/_changelog\.css">/, "the system's tokens style the page when built");
  assert.match(html, /3 releases · 5 notes · latest 2026\.10\.12-2/);
  assert.match(html, /<section class="td-changelog-release" id="v2026-10-12-2"[^>]*>\s*<div class="td-changelog-release-head">\s*<h2 id="v2026-10-12-2-heading"><a href="#v2026-10-12-2">2026\.10\.12-2<\/a> <span class="td-changelog-current">Current<\/span><\/h2>\s*<p class="td-changelog-meta">October 12, 2026 · release 2 of the day<\/p>/);
  assert.match(html, /<h2 id="v2026-10-12-1-heading"><a href="#v2026-10-12-1">2026\.10\.12-1<\/a><\/h2>\s*<p class="td-changelog-meta">October 12, 2026 · first release of the day<\/p>/);
  assert.match(html, /<li><span class="td-changelog-area">Brand · Color<\/span> darken the accent so body links pass contrast on the canvas\. See the <a href="\/brand\/color\/">Color page<\/a>\.<\/li>/);
  assert.match(html, /<span class="td-changelog-area">Print DS<\/span> add <strong>Booklets<\/strong>, a 6 × 9 trade booklet with cover wraps\.\n\s*<ul><li>interior spreads and a style guide<\/li><li>a sample-interior PDF export<\/li><\/ul>/);
  assert.match(html, /<span class="td-changelog-area is-maintenance">Maintenance<\/span> Upgrade TimDS to <code>0\.1\.461<\/code>\./);
  assert.doesNotMatch(html, /one-color lockup/, "unreleased notes are not published");
  assert.doesNotMatch(html, /\{\{/);
  // The legacy section has no date line.
  assert.match(html, /<h2 id="v1-3-142-heading"><a href="#v1-3-142">1\.3\.142<\/a><\/h2>\s*<\/div>/);

  const document = rendered.document;
  assert.deepEqual(document.system, { id: "client/system", name: "Client & Co", version: "2026.10.12-2" });
  assert.deepEqual([document.schemaVersion, document.url, document.releaseCount, document.entryCount, document.latest], [1, "/changelog/", 3, 5, "2026.10.12-2"]);
  assert.deepEqual(document.releases.map((release) => [release.version, release.current, release.url]), [
    ["2026.10.12-2", true, "/changelog/#v2026-10-12-2"],
    ["2026.10.12-1", false, "/changelog/#v2026-10-12-1"],
    ["1.3.142", false, "/changelog/#v1-3-142"],
  ]);
  assert.deepEqual(document.releases[0].entries[2], { area: "Maintenance", text: "Upgrade TimDS to 0.1.461.", markdown: "Upgrade TimDS to `0.1.461`." });
  assert.equal(changelogDocument(parseChangelog("# T\n\n## Unreleased\n"), MANIFEST).latest, null);

  const built = await buildChangelog(root, { manifest: MANIFEST });
  assert.deepEqual([built.releaseCount, built.entryCount, built.unreleasedCount, built.problems], [3, 5, 1, []]);
  assert.deepEqual(built.rendered.document, rendered.document, "the render the files came from is returned, so extraction need not render again");
  assert.equal(await fs.readFile(path.join(root, "dist", "changelog", "index.html"), "utf8"), html);
  assert.match(await fs.readFile(path.join(root, "dist", "changelog", "_changelog.css"), "utf8"), /body\.timds-changelog/);
  // A note links to /brand/color/, which this artifact does not hold: history may point at pages a later release removed, so the page's links are not artifact references.
  await validateArtifact(root, MANIFEST);

  // Extraction skips the page as guidance and writes changelog.json beside index.json.
  const machine = await extractArtifact({ artifactRoot: path.join(root, "dist"), manifest: { ...MANIFEST, machine: { enabled: true } }, changelog: rendered });
  assert.deepEqual(machine.pages.map((page) => page.id), ["index"]);
  assert.deepEqual(machine.index.changelog, { url: "/changelog.json", page: "/changelog/", releases: 3, latest: "2026.10.12-2" });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, "dist", "changelog.json"), "utf8")), document);
  assert.match(await fs.readFile(path.join(root, "dist", "llms.txt"), "utf8"), /^Changelog: \/changelog\.json — every release, newest first/m);
  assert.equal(machine.changelog, document);
  // Without a changelog the document is gone and the index carries no summary.
  const without = await extractArtifact({ artifactRoot: path.join(root, "dist"), manifest: { ...MANIFEST, machine: { enabled: true } } });
  assert.equal(without.index.changelog, undefined);
  await assert.rejects(fs.access(path.join(root, "dist", "changelog.json")));

  // An embedded entry puts the page and its stylesheet under the entry directory.
  const embedded = await renderChangelog({ designSystemRoot: root, manifest: { ...MANIFEST, artifact: { entry: "design-system/index.html" } } });
  assert.deepEqual([...embedded.files.keys()], ["design-system/changelog/index.html", "design-system/changelog/_changelog.css"]);
  assert.match(embedded.files.get("design-system/changelog/index.html"), /href="\/design-system\/changelog\/_changelog\.css"/);
  assert.equal(embedded.url, "/design-system/changelog/");
});

test("a system without CHANGELOG.md renders nothing, and an empty one renders an empty page", async (t) => {
  const root = await temporaryDirectory(t);
  assert.equal(await renderChangelog({ designSystemRoot: root, manifest: MANIFEST }), null);
  assert.deepEqual(await buildChangelog(root, { manifest: MANIFEST }), { releaseCount: 0, entryCount: 0, unreleasedCount: 0, problems: [], written: [], rendered: null });
  assert.deepEqual(await buildChangelog(root), { releaseCount: 0, entryCount: 0, unreleasedCount: 0, problems: [], written: [], rendered: null }, "no manifest and no timds.json is still nothing to build");
  assert.equal(await readUnreleasedNotes(root), null);
  // Removing CHANGELOG.md removes the previous page too, in a dist the build did not clear.
  await fs.writeFile(path.join(root, "CHANGELOG.md"), "# Changelog\n\n## Unreleased\n\n## 2026.10.12-1\n\n- Brand: x\n");
  await buildChangelog(root, { manifest: MANIFEST });
  await fs.access(path.join(root, "dist", "changelog", "index.html"));
  await fs.rm(path.join(root, "CHANGELOG.md"));
  assert.equal((await buildChangelog(root, { manifest: MANIFEST })).rendered, null);
  await assert.rejects(fs.access(path.join(root, "dist", "changelog")), "the stale page is gone");
  await fs.writeFile(path.join(root, "CHANGELOG.md"), "# Changelog\n\n## Unreleased\n");
  assert.deepEqual(await readUnreleasedNotes(root), []);
  const rendered = await renderChangelog({ designSystemRoot: root, manifest: MANIFEST });
  assert.match(rendered.files.get("changelog/index.html"), /No releases yet/);
  assert.doesNotMatch(rendered.files.get("changelog/index.html"), /tokens\.css/, "no built tokens, no link");
  // The manifest is read from timds.json when none is supplied.
  await fs.writeFile(path.join(root, "timds.json"), JSON.stringify({ systemId: "a/b", name: "A", version: "2026.10.12-1", artifact: { entry: "index.html" } }));
  await fs.writeFile(path.join(root, "CHANGELOG.md"), "# Changelog\n\n## Unreleased\n\n- Brand: x\n\n## 2026.10.12-1\n\n- Brand: y\n");
  const fromManifest = await renderChangelog({ designSystemRoot: root });
  assert.equal(fromManifest.document.system.id, "a/b");
  assert.deepEqual((await readUnreleasedNotes(root)).map((entry) => entry.text), ["x"]);
});

// The Design System changelog: one Markdown file a designer keeps, rendered
// into the artifact and the derived layer so the history of the system is
// readable without a checkout.
//
// CHANGELOG.md at the design-system root is the single source. Each release is
// a `## <version>` section, newest first, under a `## Unreleased` section the
// release scripts roll into the next version. Entries are bullets written for
// the people who use the system; an entry may lead with the area it touches
// ("Brand · Color: ...", "Print DS: ...", "Maintenance: ..."), which the page
// shows as a label and the document carries as `area`.
//
// TimDS owns this renderer the way it owns the website designs: `check`
// builds <entry-dir>/changelog/index.html after the workspace build, the
// starter build calls the same function so `dev` shows it, and extraction
// writes changelog.json beside index.json and skips the page as guidance.
// The viewer links the page from its version chip; the page is deliberately
// outside the views, a reference and not a destination.
//
// Design System versions are dated: YYYY.MM.DD-N, the UTC date a release was
// prepared and its number that day (2026.10.12-1, then 2026.10.12-2). Systems
// released before the scheme carry MAJOR.MINOR.PATCH sections, which this
// module reads and orders below every dated version; the starter's release
// scripts keep their own copy of the same rules so a client repository
// releases without importing the toolkit.

import fs from "node:fs/promises";
import path from "node:path";

import { readManifestLike } from "./designs.mjs";
import { escapeHtml } from "./html.mjs";

export const CHANGELOG_FILE = "CHANGELOG.md";
export const CHANGELOG_OUTPUT_DIRECTORY = "changelog";
export const CHANGELOG_SCHEMA_VERSION = 1;
export const UNRELEASED_HEADING = "Unreleased";

/** A dated Design System version: the UTC release date and the release number that day. */
export const DATED_VERSION = /^(\d{4})\.(\d{2})\.(\d{2})-([1-9]\d*)$/;
/** The scheme systems released before dated versions: MAJOR.MINOR.PATCH. */
export const LEGACY_VERSION = /^\d+\.\d+\.\d+$/;

const MAX_AREA_LENGTH = 48;
const MAX_AREA_WORDS = 6;

/* ── versions ───────────────────────────────────────────────────────────── */

/**
 * Read a Design System version: `{ kind: "dated", date, build }` for
 * 2026.10.12-1, `{ kind: "legacy", parts }` for 1.3.142, null otherwise.
 */
export function parseDesignSystemVersion(version) {
  const text = String(version ?? "").trim();
  const dated = DATED_VERSION.exec(text);
  if (dated) {
    const [, year, month, day, build] = dated;
    const date = `${year}-${month}-${day}`;
    const parsed = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return null;
    return { kind: "dated", version: text, date, build: Number(build) };
  }
  if (LEGACY_VERSION.test(text)) return { kind: "legacy", version: text, parts: text.split(".").map(Number) };
  return null;
}

export const isDesignSystemVersion = (version) => parseDesignSystemVersion(version) !== null;

/** Order two versions: every dated version follows every legacy one; dated by date then build, legacy numerically. */
export function compareDesignSystemVersions(left, right) {
  const a = parseDesignSystemVersion(left);
  const b = parseDesignSystemVersion(right);
  if (!a) throw new Error(`Invalid Design System version ${JSON.stringify(left)}`);
  if (!b) throw new Error(`Invalid Design System version ${JSON.stringify(right)}`);
  if (a.kind !== b.kind) return a.kind === "dated" ? 1 : -1;
  if (a.kind === "dated") return a.date === b.date ? a.build - b.build : a.date < b.date ? -1 : 1;
  for (let index = 0; index < 3; index += 1) if (a.parts[index] !== b.parts[index]) return a.parts[index] - b.parts[index];
  return 0;
}

/** The UTC calendar date of `now` in the version's form, 2026.10.12. */
export function versionDate(now = new Date()) {
  return now.toISOString().slice(0, 10).replaceAll("-", ".");
}

/**
 * The version the next release takes: the first release of the day is
 * YYYY.MM.DD-1; another the same UTC day counts up. A legacy current version
 * moves onto the dated scheme. The next version always follows the current
 * one: a current version dated after today (a hand release dated ahead)
 * counts up on its own day rather than regressing to today's.
 */
export function nextDesignSystemVersion(current, now = new Date()) {
  const parsed = parseDesignSystemVersion(current);
  if (!parsed) throw new Error(`Invalid Design System version ${JSON.stringify(current)}`);
  const today = versionDate(now);
  const currentDay = parsed.kind === "dated" ? parsed.date.replaceAll("-", ".") : null;
  if (currentDay !== null && currentDay >= today) return `${currentDay}-${parsed.build + 1}`;
  return `${today}-1`;
}

/** "October 12, 2026" for a dated version's date. */
export function formatReleaseDate(date) {
  const parsed = new Date(`${date}T00:00:00Z`);
  return parsed.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

/* ── parsing ────────────────────────────────────────────────────────────── */

/** `**text**`, `*text*`, `` `code` `` and `[text](url)` as HTML, everything else escaped. */
export function inlineHtml(markdown) {
  const codes = [];
  let text = String(markdown).replace(/`([^`\n]+)`/g, (_match, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  text = escapeHtml(text)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>")
    .replace(/\[([^\]\n]+)\]\(((?:https?:\/\/|\/)[^\s)]*)\)/g, '<a href="$2">$1</a>');
  return text.replace(/\u0000(\d+)\u0000/g, (_match, index) => `<code>${escapeHtml(codes[Number(index)])}</code>`);
}

/** The entry as plain text: emphasis and code marks dropped, a link reduced to its text. */
export function plainText(markdown) {
  return String(markdown)
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/\[([^\]\n]+)\]\((?:https?:\/\/|\/)[^\s)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** "Brand · Color: the palette" → { area: "Brand · Color", body: "the palette" }; a sentence with a late colon keeps no area. */
function splitArea(lead) {
  const match = /^(?:\*\*)?([^:*`\n]{1,48}?)(?:\*\*)?:\s+(\S.*)$/s.exec(lead);
  if (!match) return { area: null, body: lead };
  const area = match[1].trim();
  if (area.length > MAX_AREA_LENGTH || area.includes(".") || area.split(/\s+/).length > MAX_AREA_WORDS) return { area: null, body: lead };
  if (!/^[A-Z0-9]/.test(area)) return { area: null, body: lead };
  return { area, body: match[2] };
}

function finishEntry(lines) {
  // The lead runs until the first nested bullet; nested bullets are kept as items.
  const lead = [];
  const items = [];
  let current = null;
  for (const line of lines) {
    const nested = /^\s*[-*]\s+(.*)$/.exec(line);
    if (nested) {
      current = [nested[1]];
      items.push(current);
    } else if (current) {
      current.push(line.trim());
    } else {
      lead.push(line.trim());
    }
  }
  const leadText = lead.join(" ").replace(/\s+/g, " ").trim();
  const { area, body } = splitArea(leadText);
  const markdown = [body, ...items.map((item) => `- ${item.join(" ")}`)].join("\n");
  return {
    area,
    text: plainText(markdown.replaceAll("\n- ", " ")),
    markdown,
    items: items.map((item) => item.join(" ")),
  };
}

/**
 * Read CHANGELOG.md. Sections are `## <heading>`; `## Unreleased` holds the
 * notes not yet released, every other heading is a release, in file order
 * (newest first by convention). Within a section each top-level bullet is one
 * entry; indented lines continue it, indented bullets are its items, and a
 * paragraph without a bullet is an entry too, so a hand-written file still
 * renders.
 */
export function parseChangelog(markdown) {
  const lines = String(markdown).replace(/\r\n?/g, "\n").split("\n");
  const result = { title: null, intro: [], unreleased: [], releases: [], problems: [] };
  let section = null;
  let entry = null;
  let introParagraph = [];

  const flushEntry = () => {
    if (!entry) return;
    const finished = finishEntry(entry);
    if (finished.markdown.trim()) (section ? section.entries : result.unreleased).push(finished);
    entry = null;
  };
  const flushIntro = () => {
    if (introParagraph.length) result.intro.push(introParagraph.join(" ").trim());
    introParagraph = [];
  };

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading && heading[1].length === 1) {
      flushEntry();
      if (result.title === null && !section) result.title = heading[2].trim();
      continue;
    }
    if (heading && heading[1].length === 2) {
      flushEntry();
      flushIntro();
      const label = heading[2].trim();
      if (label.toLowerCase() === UNRELEASED_HEADING.toLowerCase()) {
        section = { unreleased: true, entries: result.unreleased };
        continue;
      }
      const version = label.replace(/^v(?=\d)/, "").split(/\s+/)[0];
      const parsed = parseDesignSystemVersion(version);
      if (!parsed) result.problems.push(`heading "## ${label}" is not a Design System version (2026.10.12-1); it is listed as written`);
      if (result.releases.some((release) => release.version === version)) result.problems.push(`version ${version} has two sections`);
      section = { version, label, date: parsed?.kind === "dated" ? parsed.date : null, build: parsed?.kind === "dated" ? parsed.build : null, entries: [] };
      result.releases.push(section);
      continue;
    }
    if (heading) {
      // A deeper heading inside a release groups nothing the page needs; keep its text as a paragraph entry.
      flushEntry();
      if (section) entry = [heading[2].trim()];
      continue;
    }
    if (!section) {
      if (line.trim()) introParagraph.push(line.trim());
      else flushIntro();
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      flushEntry();
      entry = [line.replace(/^[-*]\s+/, "")];
      continue;
    }
    if (!line.trim()) {
      flushEntry();
      continue;
    }
    if (entry) entry.push(line);
    else entry = [line.trim()];
  }
  flushEntry();
  flushIntro();
  for (const release of result.releases) delete release.label;
  return result;
}

/* ── document ───────────────────────────────────────────────────────────── */

const releaseAnchor = (version) => `v${version.replace(/[^0-9A-Za-z]+/g, "-")}`;

/**
 * changelog.json: the released history for consumers reading the derived
 * layer without a checkout. Unreleased notes are not published; the current
 * version is marked so a product can see what it would move to.
 */
export function changelogDocument(parsed, manifest, { basePrefix = "" } = {}) {
  const url = `${basePrefix}/${CHANGELOG_OUTPUT_DIRECTORY}/`;
  const releases = parsed.releases.map((release) => ({
    version: release.version,
    date: release.date,
    build: release.build,
    current: release.version === manifest.version,
    url: `${url}#${releaseAnchor(release.version)}`,
    entries: release.entries.map((entry) => ({ area: entry.area, text: entry.text, markdown: entry.markdown })),
  }));
  return {
    schemaVersion: CHANGELOG_SCHEMA_VERSION,
    system: { id: manifest.systemId, name: manifest.name, version: manifest.version },
    url,
    releaseCount: releases.length,
    entryCount: releases.reduce((sum, release) => sum + release.entries.length, 0),
    latest: releases[0]?.version ?? null,
    releases,
  };
}

/* ── page ───────────────────────────────────────────────────────────────── */

function renderEntry(entry) {
  const area = entry.area ? `<span class="td-changelog-area${entry.area.toLowerCase() === "maintenance" ? " is-maintenance" : ""}">${escapeHtml(entry.area)}</span> ` : "";
  const lead = entry.markdown.split("\n")[0];
  const items = entry.items.length
    ? `\n          <ul>${entry.items.map((item) => `<li>${inlineHtml(item)}</li>`).join("")}</ul>`
    : "";
  return `        <li>${area}${inlineHtml(lead)}${items}</li>`;
}

function renderRelease(release, manifest) {
  const anchor = releaseAnchor(release.version);
  const meta = [];
  if (release.date) meta.push(formatReleaseDate(release.date));
  if (release.build) meta.push(release.build === 1 ? "first release of the day" : `release ${release.build} of the day`);
  const current = release.version === manifest.version ? ' <span class="td-changelog-current">Current</span>' : "";
  return [
    `    <section class="td-changelog-release" id="${anchor}" aria-labelledby="${anchor}-heading">`,
    '      <div class="td-changelog-release-head">',
    `        <h2 id="${anchor}-heading"><a href="#${anchor}">${escapeHtml(release.version)}</a>${current}</h2>`,
    meta.length ? `        <p class="td-changelog-meta">${escapeHtml(meta.join(" · "))}</p>` : "",
    "      </div>",
    release.entries.length
      ? ["      <ul class=\"td-changelog-entries\">", ...release.entries.map(renderEntry), "      </ul>"].join("\n")
      : '      <p class="td-changelog-empty">No notes were recorded for this release.</p>',
    "    </section>",
  ].filter(Boolean).join("\n");
}

function renderPage({ manifest, parsed, basePrefix, stylesheets }) {
  const name = manifest.name || "Design System";
  const releases = parsed.releases;
  const entryCount = releases.reduce((sum, release) => sum + release.entries.length, 0);
  const eyebrow = releases.length
    ? `${releases.length} release${releases.length === 1 ? "" : "s"} · ${entryCount} note${entryCount === 1 ? "" : "s"} · latest ${escapeHtml(releases[0].version)}`
    : "No releases yet";
  return [
    "<!doctype html>",
    '<html lang="en">',
    "  <head>",
    '    <meta charset="utf-8">',
    '    <meta name="viewport" content="width=device-width, initial-scale=1">',
    `    <meta name="description" content="Every release of ${escapeHtml(name)}, newest first: what changed and where to see it.">`,
    `    <title>Changelog · ${escapeHtml(name)}</title>`,
    ...stylesheets.map((href) => `    <link rel="stylesheet" href="${escapeHtml(href)}">`),
    `    <link rel="stylesheet" href="${basePrefix}/${CHANGELOG_OUTPUT_DIRECTORY}/_changelog.css">`,
    "  </head>",
    '  <body class="timds-changelog">',
    '    <header class="td-changelog-bar">',
    `      <a class="td-changelog-brand" href="${basePrefix}/">${escapeHtml(name)}</a>`,
    `      <a class="td-changelog-back" href="${basePrefix}/">← Back to design system</a>`,
    "    </header>",
    '    <main class="td-changelog-main">',
    '      <div class="td-changelog-intro">',
    `        <p class="td-changelog-eyebrow">${eyebrow}</p>`,
    "        <h1>Changelog</h1>",
    `        <p class="td-changelog-lede">Every release of ${escapeHtml(name)}, newest first: what changed, where to see it, and what to do about it. A version is the day it was released and its number that day.</p>`,
    "      </div>",
    ...(releases.length ? releases.map((release) => renderRelease(release, manifest)) : ['      <p class="td-changelog-empty">No releases yet. Notes under Unreleased in CHANGELOG.md appear here once they ship.</p>']),
    "    </main>",
    "  </body>",
    "</html>",
    "",
  ].join("\n");
}

/** Where the page is written under dist/, from the manifest's entry: "changelog" or "<entry-dir>/changelog". */
function changelogOutputDirectory(manifest) {
  const entryDirectory = path.posix.dirname(String(manifest.artifact?.entry || "index.html"));
  return [entryDirectory === "." ? "" : entryDirectory, CHANGELOG_OUTPUT_DIRECTORY].filter(Boolean).join("/");
}

/**
 * Render the changelog in memory. Null when the system keeps no CHANGELOG.md.
 * `files` maps artifact-relative output paths to the page and its stylesheet.
 */
export async function renderChangelog({ designSystemRoot, manifest = null }) {
  let markdown;
  try {
    markdown = await fs.readFile(path.join(designSystemRoot, CHANGELOG_FILE), "utf8");
  } catch (caught) {
    if (caught?.code === "ENOENT") return null;
    throw caught;
  }
  const resolved = await readManifestLike(designSystemRoot, manifest);
  const entryDirectory = path.posix.dirname(String(resolved.artifact?.entry || "index.html"));
  const prefixDirectory = entryDirectory === "." ? "" : entryDirectory;
  const basePrefix = entryDirectory === "." ? "" : `/${entryDirectory}`;
  const parsed = parseChangelog(markdown);
  // The starter writes tokens.css into the artifact; the page takes the
  // system's custom properties from it when present and falls back otherwise.
  const stylesheets = [];
  const tokensCss = path.join(designSystemRoot, "dist", ...prefixDirectory.split("/").filter(Boolean), "tokens.css");
  if (await fs.access(tokensCss).then(() => true, () => false)) stylesheets.push(`${basePrefix}/tokens.css`);
  const outputDirectory = changelogOutputDirectory(resolved);
  const files = new Map();
  files.set(`${outputDirectory}/index.html`, renderPage({ manifest: resolved, parsed, basePrefix, stylesheets }));
  files.set(`${outputDirectory}/_changelog.css`, await fs.readFile(new URL("../templates/changelog-page.css", import.meta.url), "utf8"));
  const document = changelogDocument(parsed, resolved, { basePrefix });
  return {
    basePrefix,
    document,
    files,
    outputDirectory,
    parsed,
    releaseCount: document.releaseCount,
    entryCount: document.entryCount,
    unreleasedCount: parsed.unreleased.length,
    problems: parsed.problems,
    url: document.url,
  };
}

/**
 * Write the rendered changelog into the built artifact, replacing the previous
 * output. A system without CHANGELOG.md writes nothing and reports zero; its
 * previous output still goes, so removing the file does not leave a stale
 * page in a dist the build did not clear. `rendered` is returned so a caller
 * that extracts next does not render the same source again.
 */
export async function buildChangelog(designSystemRoot, { manifest = null } = {}) {
  const rendered = await renderChangelog({ designSystemRoot, manifest });
  const artifactRoot = path.join(designSystemRoot, "dist");
  const outputDirectory = rendered?.outputDirectory ?? await previousOutputDirectory(designSystemRoot, manifest);
  if (outputDirectory) await fs.rm(path.join(artifactRoot, ...outputDirectory.split("/")), { force: true, recursive: true });
  if (!rendered) return { releaseCount: 0, entryCount: 0, unreleasedCount: 0, problems: [], written: [], rendered: null };
  const written = [];
  for (const [relative, content] of rendered.files) {
    const target = path.join(artifactRoot, ...relative.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
    written.push(target);
  }
  return { releaseCount: rendered.releaseCount, entryCount: rendered.entryCount, unreleasedCount: rendered.unreleasedCount, problems: rendered.problems, written, rendered };
}

/** The output directory a previous build used, or null where no manifest says (a root without timds.json). */
async function previousOutputDirectory(designSystemRoot, manifest) {
  if (!manifest && !(await fs.access(path.join(designSystemRoot, "timds.json")).then(() => true, () => false))) return null;
  return changelogOutputDirectory(await readManifestLike(designSystemRoot, manifest));
}

/** The notes under `## Unreleased`, for the gates that want one before a change is submitted. */
export async function readUnreleasedNotes(designSystemRoot) {
  let markdown;
  try {
    markdown = await fs.readFile(path.join(designSystemRoot, CHANGELOG_FILE), "utf8");
  } catch (caught) {
    if (caught?.code === "ENOENT") return null;
    throw caught;
  }
  return parseChangelog(markdown).unreleased;
}

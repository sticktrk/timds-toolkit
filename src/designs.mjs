// Website designs: whole pages a designer authors in HTML, CSS, and JavaScript on the
// system's own stylesheets, kept in the Design System as the reference a
// production port must match.
//
// A design lives under src/designs/<id>/: a design.json with its title and
// summary (and, when a page's heading is not its name, a title per route),
// an optional layout.html shell with {{content}}, and pages/ holding one HTML
// file per route and state. The file name is the contract:
//
//   pages/index.html           route /          default state
//   pages/about.html           route /about     default state
//   pages/contact/index.html   route /contact   default state
//   pages/contact.sent.html    route /contact   state "sent"
//
// Named reference states are HTML files beside the default so consumers can
// inspect and diff them. JavaScript may also implement interactive states.
//
// Pages a visitor moves through in order (a funnel, a checkout, a form with
// its states) are declared as journeys in design.json: steps, each with the
// screens (a page in a state) a visitor meets and the branches met instead.
// The renderer writes one storyboard per journey at
// /designs/<id>/journeys/<journey>/, the live pages at phone width in that
// order, and designs.json carries the resolved order for consumers.
//
// TimDS owns the renderer and the portability rules; the client owns the
// designs. The renderer is deliberately small: it fills the layout shell,
// rewrites links between a design's own routes so the pages hold together
// under /designs/<id>/ in the artifact, and writes a directory page. It never
// templates content, resolves media keys, or runs anything a designer wrote.
// The starter build calls it so `dev` shows the designs; `timds check` calls
// it the same way, so a system whose build script predates designs still
// builds them.
//
// Portability is enforced by `check`: no inline styles, no class
// the linked stylesheets do not declare, and no relative reference. A design
// that passes uses nothing the system does not define, so an engineer porting
// it to any stack carries the system's stylesheets, markup, and interactions.
//
// The built pages sit at <entry-dir>/designs/<id>/<route>/index.html (states
// as <state>.html beside the default), excluded from guidance extraction, and
// designs.json beside index.json carries every page's HTML for consumers that
// read the derived layer without a checkout.

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { attr, classList, escapeHtml, findAll, findOne, parseHtml, textOf, walk } from "./html.mjs";
import { importReferences, stylesheetReferences } from "./tokens.mjs";

export const DESIGNS_SOURCE_DIRECTORY = "src/designs";
export const DESIGNS_OUTPUT_DIRECTORY = "designs";
export const DESIGNS_SCHEMA_VERSION = 1;
export const DEFAULT_STATE = "default";
/** The directory under a design's output reserved for journey storyboards. */
export const JOURNEYS_OUTPUT_DIRECTORY = "journeys";

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PLACEHOLDER = /\{\{\s*([a-z]+)\s*\}\}/g;
const MAX_REPORTED_PROBLEMS = 30;
// Attributes that carry a reference a consumer must be able to resolve.
const REFERENCE_ATTRIBUTES = ["href", "src", "action", "poster"];
// Attributes the publisher uploads alongside designs.json; anchors are routes, not files.
const FILE_REFERENCE_TAGS = new Set(["link", "img", "source", "video", "audio", "track", "object", "script"]);

const isExternal = (value) => /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//");

const posixRelative = (from, to) => path.relative(from, to).split(path.sep).join("/");

/** A route as design.json may write it (`contact`, `/contact/`) in the catalog's form (`/contact`). */
const normalizeRoute = (value) => {
  const route = String(value ?? "").trim();
  return route.length > 1 ? `/${route.replace(/^\/+|\/+$/g, "")}` : "/";
};

const isJourneysRoute = (route) => route === `/${JOURNEYS_OUTPUT_DIRECTORY}` || route.startsWith(`/${JOURNEYS_OUTPUT_DIRECTORY}/`);

/* ── catalog ────────────────────────────────────────────────────────────── */

async function readJson(filePath, label) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (caught) {
    if (caught?.code === "ENOENT") throw new Error(`${label} is required`);
    throw caught;
  }
  try {
    return JSON.parse(raw);
  } catch (caught) {
    throw new Error(`${label} is invalid JSON: ${caught.message}`);
  }
}

async function htmlFiles(directory, prefix = "") {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (caught) {
    if (caught?.code === "ENOENT") return [];
    throw caught;
  }
  const found = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await htmlFiles(path.join(directory, entry.name), relative));
    else if (entry.isFile() && entry.name.endsWith(".html")) found.push(relative);
  }
  return found;
}

/** The route and state a page file name declares, or an error naming the rule it breaks. */
function parsePageFile(relative, source) {
  const segments = relative.split("/");
  const name = segments.pop().replace(/\.html$/, "");
  const parts = name.split(".");
  if (parts.length > 2) throw new Error(`${source} must be named <route>.html or <route>.<state>.html`);
  const [base, state = DEFAULT_STATE] = parts;
  for (const segment of segments) {
    if (!ID.test(segment)) throw new Error(`${source}: directory ${JSON.stringify(segment)} must be lowercase words joined by hyphens`);
  }
  if (base !== "index" && !ID.test(base)) throw new Error(`${source}: route ${JSON.stringify(base)} must be lowercase words joined by hyphens, or index for the directory's own page`);
  if (!ID.test(state)) throw new Error(`${source}: state ${JSON.stringify(state)} must be lowercase words joined by hyphens`);
  if (state === "index") throw new Error(`${source}: a state may not be named index`);
  const routeSegments = base === "index" ? segments : [...segments, base];
  return { route: `/${routeSegments.join("/")}`, state };
}

/**
 * The journeys a design.json declares, every screen resolved against the
 * design's pages: `page` must be a route the design has and `state` a state
 * that route has (the default when omitted). A journey needs at least one
 * step with at least one screen; branches are the screens a visitor meets
 * instead of the step's own. Returns [] when the manifest declares none.
 */
function readJourneys(manifest, label, pages) {
  if (manifest.journeys === undefined) return [];
  if (!Array.isArray(manifest.journeys)) throw new Error(`${label} journeys must be an array of journeys ({ id, title, steps })`);
  const routes = [...pages.keys()].sort((left, right) => left.localeCompare(right)).join(", ");
  const readScreen = (raw, where) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where} must be an object with a page ({ "page": "/route" })`);
    if (typeof raw.page !== "string" || !raw.page.trim()) throw new Error(`${where} needs a page: one of the design's routes (${routes})`);
    const route = normalizeRoute(raw.page);
    const page = pages.get(route);
    if (!page) throw new Error(`${where} names the route ${route}, which the design has no page for; routes: ${routes}`);
    if (raw.state !== undefined && (typeof raw.state !== "string" || !raw.state.trim())) throw new Error(`${where} state must be the name of a state of ${route}`);
    const state = raw.state === undefined ? DEFAULT_STATE : raw.state.trim();
    if (!page.states.some((candidate) => candidate.name === state)) {
      throw new Error(`${where} names state ${JSON.stringify(state)} of ${route}, which that route does not have; states: ${page.states.map((candidate) => candidate.name).join(", ")}`);
    }
    for (const field of ["label", "note"]) {
      if (raw[field] !== undefined && typeof raw[field] !== "string") throw new Error(`${where} ${field} must be a string`);
    }
    return { page: route, state, label: String(raw.label ?? "").trim() || null, note: String(raw.note ?? "").trim() || null };
  };
  const ids = new Set();
  return manifest.journeys.map((raw, index) => {
    const where = `${label} journeys[${index}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where} must be an object with id, title, and steps`);
    const id = String(raw.id ?? "").trim();
    if (!ID.test(id)) throw new Error(`${where} id ${JSON.stringify(raw.id ?? "")} must be lowercase words joined by hyphens`);
    if (ids.has(id)) throw new Error(`${label} declares the journey ${id} twice; give each journey its own id`);
    ids.add(id);
    const title = String(raw.title ?? "").trim();
    if (!title) throw new Error(`${where} (${id}) needs a title`);
    if (raw.summary !== undefined && typeof raw.summary !== "string") throw new Error(`${where} (${id}) summary must be a string`);
    if (!Array.isArray(raw.steps) || !raw.steps.length) throw new Error(`${where} (${id}) needs steps: at least one step with at least one screen`);
    const steps = raw.steps.map((step, stepIndex) => {
      const at = `${where} (${id}) steps[${stepIndex}]`;
      if (!step || typeof step !== "object" || Array.isArray(step)) throw new Error(`${at} must be an object with a title and screens`);
      const stepTitle = String(step.title ?? "").trim();
      if (!stepTitle) throw new Error(`${at} needs a title`);
      if (step.summary !== undefined && typeof step.summary !== "string") throw new Error(`${at} summary must be a string`);
      if (!Array.isArray(step.screens) || !step.screens.length) throw new Error(`${at} needs screens: at least one { "page": "/route" }, with "state" for a route's other states`);
      const screens = step.screens.map((entry, screenIndex) => readScreen(entry, `${at} screens[${screenIndex}]`));
      let branches = [];
      if (step.branches !== undefined) {
        if (!Array.isArray(step.branches) || !step.branches.length) throw new Error(`${at} branches must list at least one screen a visitor meets instead, or be left out`);
        branches = step.branches.map((entry, branchIndex) => readScreen(entry, `${at} branches[${branchIndex}]`));
      }
      return { title: stepTitle, summary: String(step.summary ?? "").trim(), screens, branches };
    });
    return { id, title, summary: String(raw.summary ?? "").trim(), steps };
  });
}

/**
 * Every design under src/designs with its pages, states, and journeys, in a
 * stable order. `exists` is false when the system has no designs directory, which is
 * not an error: designs are optional.
 */
export async function readDesignCatalog(designSystemRoot) {
  const source = path.join(designSystemRoot, ...DESIGNS_SOURCE_DIRECTORY.split("/"));
  let entries;
  try {
    entries = await fs.readdir(source, { withFileTypes: true });
  } catch (caught) {
    if (caught?.code === "ENOENT") return { exists: false, source, designs: [] };
    throw caught;
  }
  const designs = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    if (!ID.test(entry.name)) throw new Error(`${DESIGNS_SOURCE_DIRECTORY}/${entry.name} must be lowercase words joined by hyphens`);
    const directory = path.join(source, entry.name);
    const label = `${DESIGNS_SOURCE_DIRECTORY}/${entry.name}/design.json`;
    const manifest = await readJson(path.join(directory, "design.json"), label);
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error(`${label} must be an object`);
    const title = String(manifest.title ?? "").trim();
    if (!title) throw new Error(`${label} needs a title`);
    if (manifest.summary !== undefined && typeof manifest.summary !== "string") throw new Error(`${label} summary must be a string`);
    // Optional page titles by route, for a home page whose <h1> is a headline rather than a name.
    const titles = new Map();
    if (manifest.pages !== undefined) {
      if (!manifest.pages || typeof manifest.pages !== "object" || Array.isArray(manifest.pages)) throw new Error(`${label} pages must be an object keyed by route`);
      for (const [route, page] of Object.entries(manifest.pages)) {
        const title = typeof page === "string" ? page : page?.title;
        if (typeof title !== "string" || !title.trim()) throw new Error(`${label} pages[${JSON.stringify(route)}] needs a title`);
        titles.set(normalizeRoute(route), title.trim());
      }
    }
    const layout = path.join(directory, "layout.html");
    const pagesDirectory = path.join(directory, "pages");
    const files = await htmlFiles(pagesDirectory);
    if (!files.length) throw new Error(`${DESIGNS_SOURCE_DIRECTORY}/${entry.name}/pages/ has no pages; a design needs at least pages/index.html`);
    const pages = new Map();
    for (const relative of files) {
      const file = `${DESIGNS_SOURCE_DIRECTORY}/${entry.name}/pages/${relative}`;
      const { route, state } = parsePageFile(relative, file);
      if (isJourneysRoute(route)) throw new Error(`${file}: the route ${route} is reserved for journey storyboards (/designs/${entry.name}/${JOURNEYS_OUTPUT_DIRECTORY}/<journey>/); name the route differently`);
      const page = pages.get(route) ?? { route, title: titles.get(route) ?? null, states: [] };
      const existing = page.states.find((candidate) => candidate.name === state);
      if (existing) throw new Error(`${file} and ${existing.source} both describe route ${route}${state === DEFAULT_STATE ? "" : ` state ${state}`}; keep one`);
      page.states.push({ name: state, path: path.join(pagesDirectory, ...relative.split("/")), source: file });
      pages.set(route, page);
    }
    for (const route of titles.keys()) {
      if (!pages.has(route)) throw new Error(`${label} names the route ${route}, which has no page under pages/`);
    }
    for (const page of pages.values()) {
      if (!page.states.some((state) => state.name === DEFAULT_STATE)) {
        const states = page.states.map((state) => state.source).join(", ");
        throw new Error(`route ${page.route} of design ${entry.name} has states (${states}) but no default page; author ${page.route === "/" ? "pages/index.html" : `pages${page.route}.html`} first`);
      }
      page.states.sort((left, right) => (left.name === DEFAULT_STATE ? -1 : right.name === DEFAULT_STATE ? 1 : left.name.localeCompare(right.name)));
    }
    designs.push({
      id: entry.name,
      directory,
      title,
      summary: String(manifest.summary ?? "").trim(),
      layout: existsSync(layout) ? layout : null,
      pages: [...pages.values()].sort((left, right) => left.route.localeCompare(right.route)),
      journeys: readJourneys(manifest, label, pages),
    });
  }
  return { exists: true, source, designs };
}

/* ── rendering ──────────────────────────────────────────────────────────── */

// Script bodies are JavaScript or data, not TimDS placeholders or HTML links.
function transformMarkup(html, transform) {
  let end = 0;
  let result = "";
  for (const match of html.matchAll(/(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>|$)/gi)) {
    result += transform(html.slice(end, match.index) + match[1]) + match[2] + match[3];
    end = match.index + match[0].length;
  }
  return result + transform(html.slice(end));
}

function fill(template, file, values) {
  return transformMarkup(template, (markup) => markup.replace(PLACEHOLDER, (match, name) => {
    const value = values[name];
    if (value === undefined) throw new Error(`${file} uses the unknown placeholder ${match}`);
    return value;
  }));
}

function pageTitle(html, fallback) {
  const document = parseHtml(html);
  const heading = findOne(document, (node) => node.tag === "h1");
  if (heading && textOf(heading)) return textOf(heading);
  const title = findOne(document, (node) => node.tag === "title");
  if (title && textOf(title)) return textOf(title);
  return fallback;
}

/** Artifact-relative output path of one state: the default is the route's index.html, a state sits beside it. */
function outputPath(prefixDirectory, designId, route, state) {
  const directory = [prefixDirectory, DESIGNS_OUTPUT_DIRECTORY, designId, ...route.split("/").filter(Boolean)].filter(Boolean).join("/");
  return `${directory}/${state === DEFAULT_STATE ? "index.html" : `${state}.html`}`;
}

function pageUrl(basePrefix, designId, route, state) {
  const directory = `${basePrefix}/${DESIGNS_OUTPUT_DIRECTORY}/${designId}${route === "/" ? "" : route}`;
  return state === DEFAULT_STATE ? `${directory}/` : `${directory}/${state}.html`;
}

function journeyUrl(basePrefix, designId, journeyId) {
  return `${basePrefix}/${DESIGNS_OUTPUT_DIRECTORY}/${designId}/${JOURNEYS_OUTPUT_DIRECTORY}/${journeyId}/`;
}

/** The route and state a screen shows, the way a caption and designs.json name it. */
const screenWhere = (screen) => `${screen.route}${screen.state === DEFAULT_STATE ? "" : ` · ${screen.state}`}`;

/**
 * A catalog journey with every screen resolved against the rendered pages:
 * the page state's url and title, and the label a caption shows (the
 * declared one, else the page title plus the state name).
 */
function resolveJourney(journey, pages, basePrefix, designId, prefixDirectory) {
  const resolve = (screen) => {
    const page = pages.find((candidate) => candidate.route === screen.page);
    const state = page.states.find((candidate) => candidate.name === screen.state);
    return {
      route: page.route,
      state: state.name,
      label: screen.label ?? (state.name === DEFAULT_STATE ? page.title : `${page.title} · ${state.name}`),
      note: screen.note,
      title: state.title,
      url: state.url,
    };
  };
  const steps = journey.steps.map((step) => ({ title: step.title, summary: step.summary, screens: step.screens.map(resolve), branches: step.branches.map(resolve) }));
  const screenCount = steps.reduce((count, step) => count + step.screens.length + step.branches.length, 0);
  const output = [prefixDirectory, DESIGNS_OUTPUT_DIRECTORY, designId, JOURNEYS_OUTPUT_DIRECTORY, journey.id, "index.html"].filter(Boolean).join("/");
  return { id: journey.id, title: journey.title, summary: journey.summary, url: journeyUrl(basePrefix, designId, journey.id), output, stepCount: steps.length, screenCount, steps };
}

const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;

function toolkitPage({ title, basePrefix, stylesheets, bodyClass, body }) {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "  <head>",
    '    <meta charset="utf-8">',
    '    <meta name="viewport" content="width=device-width, initial-scale=1">',
    `    <title>${title}</title>`,
    ...stylesheets.map((href) => `    <link rel="stylesheet" href="${escapeHtml(href)}">`),
    `    <link rel="stylesheet" href="${basePrefix}/${DESIGNS_OUTPUT_DIRECTORY}/_directory.css">`,
    "  </head>",
    `  <body class="${bodyClass}">`,
    ...body,
    "  </body>",
    "</html>",
    "",
  ].join("\n");
}

/**
 * One journey's storyboard: each step a section, its screens the live page
 * states in lazy same-origin frames at phone width, numbered through the
 * journey, with the step's branches in a second row marked "or".
 */
function renderJourney({ name, basePrefix, design, journey, stylesheets }) {
  let number = 0;
  const frame = (screen, badge) => {
    const label = escapeHtml(screen.label);
    const branch = badge === "or";
    return [
      `          <li class="td-journey-screen${branch ? " td-journey-screen--branch" : ""}">`,
      `            <span class="td-journey-badge" aria-hidden="true">${badge}</span>`,
      "            <figure>",
      `              <div class="td-journey-frame"><iframe src="${screen.url}" title="${label}" loading="lazy" tabindex="-1"></iframe><a class="td-journey-open" href="${screen.url}" aria-label="Open ${label} at full size"></a></div>`,
      `              <figcaption><b>${branch ? "Or: " : ""}${label}</b>${screen.note ? `<span>${escapeHtml(screen.note)}</span>` : ""}<a href="${screen.url}"><code>${escapeHtml(screenWhere(screen))}</code></a></figcaption>`,
      "            </figure>",
      "          </li>",
    ].join("\n");
  };
  const sections = journey.steps.map((step, index) => {
    const start = number + 1;
    const screens = step.screens.map((screen) => frame(screen, String(++number)));
    const branches = step.branches.map((screen) => frame(screen, "or"));
    return [
      `    <section class="td-journey-step" aria-labelledby="step-${index + 1}">`,
      '      <div class="td-journey-step-head">',
      `        <p class="td-directory-eyebrow">Step ${index + 1} of ${journey.steps.length}</p>`,
      `        <h2 id="step-${index + 1}">${escapeHtml(step.title)}</h2>`,
      step.summary ? `        <p class="td-directory-summary">${escapeHtml(step.summary)}</p>` : "",
      "      </div>",
      `      <ol class="td-journey-screens" start="${start}">`,
      ...screens,
      "      </ol>",
      ...(branches.length ? [
        '      <p class="td-journey-or">Or, instead</p>',
        '      <ul class="td-journey-screens td-journey-screens--branch">',
        ...branches,
        "      </ul>",
      ] : []),
      "    </section>",
    ].filter(Boolean).join("\n");
  });
  return toolkitPage({
    title: `${escapeHtml(journey.title)} · ${escapeHtml(design.title)} · ${escapeHtml(name)}`,
    basePrefix,
    stylesheets,
    bodyClass: "timds-design-directory timds-design-journey",
    body: [
      '    <header class="td-directory-bar">',
      `      <a class="td-directory-brand" href="${basePrefix}/">${escapeHtml(name)}</a>`,
      `      <a class="td-directory-back" href="${basePrefix}/${DESIGNS_OUTPUT_DIRECTORY}/">← All designs</a>`,
      "    </header>",
      '    <main class="td-directory-main">',
      '      <div class="td-directory-intro">',
      `        <p class="td-directory-eyebrow"><a href="${design.url}">${escapeHtml(design.title)}</a> · ${plural(journey.stepCount, "step")} · ${plural(journey.screenCount, "screen")}</p>`,
      `        <h1>${escapeHtml(journey.title)}</h1>`,
      journey.summary ? `        <p class="td-directory-lede">${escapeHtml(journey.summary)}</p>` : "",
      '        <p class="td-directory-lede">The live designs at phone width, in the order a visitor meets them. Open any screen to review it at full size.</p>',
      "      </div>",
      ...sections,
      "    </main>",
    ].filter(Boolean),
  });
}

/**
 * Rewrite references to a design's own routes so the pages hold together at
 * their artifact location. A reference that is not one of the design's routes
 * (a stylesheet, an asset, another design) is left exactly as written.
 */
export function rewriteDesignRoutes(html, routes, basePrefix, designId) {
  const known = new Set(routes);
  return transformMarkup(html, (markup) => markup.replace(/\b(href|src|action)=("|')([^"']*)\2/g, (match, name, quote, value) => {
    if (!value.startsWith("/") || value.startsWith("//")) return match;
    const end = value.search(/[?#]/);
    const target = end === -1 ? value : value.slice(0, end);
    const suffix = end === -1 ? "" : value.slice(end);
    const route = target.length > 1 ? target.replace(/\/+$/, "") : target;
    if (!known.has(route)) return match;
    return `${name}=${quote}${pageUrl(basePrefix, designId, route, DEFAULT_STATE)}${suffix}${quote}`;
  }));
}

/** Site-absolute files a page loads: stylesheets, scripts, and media, never anchors. */
function fileReferences(html) {
  const found = new Set();
  for (const node of findAll(parseHtml(html), (candidate) => FILE_REFERENCE_TAGS.has(candidate.tag))) {
    if (node.tag === "link" && !String(attr(node, "rel") ?? "").toLowerCase().split(/\s+/).includes("stylesheet")) continue;
    for (const name of ["href", "src", "poster"]) {
      const value = String(attr(node, name) ?? "").trim();
      if (value.startsWith("/") && !value.startsWith("//")) found.add(value.split(/[?#]/, 1)[0]);
    }
  }
  return [...found].sort();
}

/** The manifest fields the renderers need, from the workspace when given or from timds.json at the root. */
export async function readManifestLike(designSystemRoot, manifest) {
  if (manifest) return manifest;
  const raw = await readJson(path.join(designSystemRoot, "timds.json"), "timds.json");
  return { systemId: raw.systemId, name: raw.name, description: raw.description, version: raw.version, artifact: { entry: raw.artifact?.entry || "index.html" } };
}

function renderDirectory({ name, basePrefix, designs, stylesheets }) {
  const pageCount = designs.reduce((count, design) => count + design.pages.length, 0);
  const sections = designs.map((design) => {
    const landing = design.pages.find((page) => page.route === "/")?.url || design.pages[0].url;
    const rows = design.pages.map((page) => {
      const [defaultState, ...states] = page.states;
      const extra = states.length
        ? `<div class="td-directory-states">${states.map((state) => `<a href="${state.url}">${escapeHtml(state.name)}</a>`).join("")}</div>`
        : '<span class="td-directory-default">Default</span>';
      return `        <tr><td><code>${escapeHtml(page.route)}</code></td><td><a class="td-directory-page" href="${defaultState.url}">${escapeHtml(page.title)}</a></td><td>${extra}</td></tr>`;
    });
    const journeys = design.journeys.map((journey) => [
      `        <a class="td-directory-journey" href="${journey.url}">`,
      `          <b>${escapeHtml(journey.title)}</b>`,
      journey.summary ? `          <span>${escapeHtml(journey.summary)}</span>` : "",
      `          <span class="td-directory-journey-meta">${plural(journey.stepCount, "step")} · ${plural(journey.screenCount, "screen")} · Open storyboard <span aria-hidden="true">↗</span></span>`,
      "        </a>",
    ].filter(Boolean).join("\n"));
    return [
      `    <section class="td-directory-section" aria-labelledby="design-${escapeHtml(design.id)}">`,
      '      <div class="td-directory-section-head">',
      '        <div>',
      `          <h2 id="design-${escapeHtml(design.id)}"><a href="${landing}">${escapeHtml(design.title)}</a></h2>`,
      design.summary ? `          <p class="td-directory-summary">${escapeHtml(design.summary)}</p>` : "",
      '        </div>',
      `        <a class="td-directory-open" href="${landing}" aria-label="Open ${escapeHtml(design.title)}">Open design <span aria-hidden="true">↗</span></a>`,
      '      </div>',
      ...(journeys.length ? [
        `      <div class="td-directory-journeys" aria-label="Journeys of ${escapeHtml(design.title)}">`,
        '        <p class="td-directory-journeys-label">Journeys: the screens in the order a visitor meets them</p>',
        ...journeys,
        "      </div>",
      ] : []),
      '      <div class="td-directory-table-wrap">',
      `      <table aria-labelledby="design-${escapeHtml(design.id)}">`,
      '        <thead><tr><th scope="col">Route</th><th scope="col">Page</th><th scope="col">States</th></tr></thead>',
      "        <tbody>",
      ...rows,
      "        </tbody>",
      "      </table>",
      '      </div>',
      "    </section>",
    ].filter(Boolean).join("\n");
  });
  return toolkitPage({
    title: `Website designs · ${escapeHtml(name)}`,
    basePrefix,
    stylesheets,
    bodyClass: "timds-design-directory",
    body: [
      '    <header class="td-directory-bar">',
      `      <a class="td-directory-brand" href="${basePrefix}/">${escapeHtml(name)}</a>`,
      `      <a class="td-directory-back" href="${basePrefix}/">← Back to design system</a>`,
      '    </header>',
      '    <main class="td-directory-main">',
      '      <div class="td-directory-intro">',
      `        <p class="td-directory-eyebrow">${plural(designs.length, "design")} · ${plural(pageCount, "page")}</p>`,
      "        <h1>Website designs</h1>",
      '        <p class="td-directory-lede">Browse complete page designs built with this system. Open a page to explore its layout and interactions, or choose an alternate state.</p>',
      '      </div>',
      ...(sections.length ? sections : ['      <p class="td-directory-empty">No website designs yet.</p>']),
      "    </main>",
    ],
  });
}

/**
 * Render every design in memory. Returns null when the system has no designs
 * directory. `files` maps artifact-relative output paths to HTML and CSS, the
 * directory page and its stylesheet included.
 */
export async function renderDesigns({ designSystemRoot, manifest = null }) {
  const catalog = await readDesignCatalog(designSystemRoot);
  if (!catalog.exists) return null;
  const resolved = await readManifestLike(designSystemRoot, manifest);
  const entryDirectory = path.posix.dirname(String(resolved.artifact?.entry || "index.html"));
  const prefixDirectory = entryDirectory === "." ? "" : entryDirectory;
  const basePrefix = entryDirectory === "." ? "" : `/${entryDirectory}`;
  const shared = {
    name: escapeHtml(resolved.name || "Design System"),
    description: escapeHtml(resolved.description || ""),
    version: escapeHtml(resolved.version || ""),
  };
  const files = new Map();
  const designs = [];
  let pageCount = 0;
  let stateCount = 0;
  let journeyCount = 0;
  const stylesheets = new Set();

  for (const design of catalog.designs) {
    const routes = design.pages.map((page) => page.route);
    const layoutFile = design.layout ? `${DESIGNS_SOURCE_DIRECTORY}/${design.id}/layout.html` : null;
    const layout = design.layout ? await fs.readFile(design.layout, "utf8") : null;
    if (layout !== null && !/\{\{\s*content\s*\}\}/.test(layout)) throw new Error(`${layoutFile} must contain {{content}}`);
    const pages = [];
    for (const page of design.pages) {
      const states = [];
      for (const state of page.states) {
        const authored = await fs.readFile(state.path, "utf8");
        // The declared title names the page; a state keeps its own heading.
        const title = state.name === DEFAULT_STATE && page.title ? page.title : pageTitle(authored, page.route);
        const content = fill(authored, state.source, shared);
        const document = layout === null
          ? content
          : fill(layout, layoutFile, { ...shared, title: escapeHtml(title), content: content.trim() });
        const html = rewriteDesignRoutes(document, routes, basePrefix, design.id);
        const output = outputPath(prefixDirectory, design.id, page.route, state.name);
        const references = fileReferences(html);
        for (const reference of stylesheetReferences(html).links) {
          if (reference.startsWith("/")) stylesheets.add(reference);
        }
        files.set(output, html);
        states.push({ name: state.name, title, url: pageUrl(basePrefix, design.id, page.route, state.name), output, source: state.source, html, references });
        stateCount += 1;
      }
      pages.push({ route: page.route, title: states[0].title, url: states[0].url, output: states[0].output, states });
      pageCount += 1;
    }
    const journeys = design.journeys.map((journey) => resolveJourney(journey, pages, basePrefix, design.id, prefixDirectory));
    journeyCount += journeys.length;
    designs.push({ id: design.id, title: design.title, summary: design.summary, url: `${basePrefix}/${DESIGNS_OUTPUT_DIRECTORY}/${design.id}/`, pages, journeys });
  }

  // The storyboards and the directory load what the designs load, so the
  // system's colors and fonts reach the toolkit chrome.
  const name = resolved.name || "Design System";
  for (const design of designs) {
    for (const journey of design.journeys) {
      files.set(journey.output, renderJourney({ name, basePrefix, design, journey, stylesheets: [...stylesheets] }));
    }
  }
  const outputDirectory = [prefixDirectory, DESIGNS_OUTPUT_DIRECTORY].filter(Boolean).join("/");
  files.set(`${outputDirectory}/index.html`, renderDirectory({ name, basePrefix, designs, stylesheets: [...stylesheets] }));
  files.set(`${outputDirectory}/_directory.css`, await fs.readFile(new URL("../templates/designs-directory.css", import.meta.url), "utf8"));
  return {
    basePrefix,
    catalog,
    designs,
    files,
    journeyCount,
    outputDirectory,
    pageCount,
    stateCount,
    url: `${basePrefix}/${DESIGNS_OUTPUT_DIRECTORY}/`,
  };
}

/**
 * Write the rendered designs into the built artifact. The previous designs
 * output is removed first so a renamed route leaves nothing behind. A system
 * without a designs directory writes nothing and reports zero.
 */
export async function buildDesigns(designSystemRoot, { manifest = null } = {}) {
  const rendered = await renderDesigns({ designSystemRoot, manifest });
  if (!rendered) return { designs: [], journeyCount: 0, pageCount: 0, stateCount: 0, written: [] };
  const artifactRoot = path.join(designSystemRoot, "dist");
  await fs.rm(path.join(artifactRoot, ...rendered.outputDirectory.split("/")), { force: true, recursive: true });
  const written = [];
  for (const [relative, html] of rendered.files) {
    const target = path.join(artifactRoot, ...relative.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, html, "utf8");
    written.push(target);
  }
  return { designs: rendered.designs, journeyCount: rendered.journeyCount, pageCount: rendered.pageCount, stateCount: rendered.stateCount, written };
}

/* ── portability check ──────────────────────────────────────────────────── */

/** Class names a stylesheet declares in selectors; strings, comments, and url() are ignored. */
export function declaredClasses(css) {
  const stripped = String(css)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/url\([^)]*\)/g, "url()")
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
  const found = new Set();
  for (const match of stripped.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) found.add(match[1]);
  return found;
}

async function linkedClasses(links, artifactRoot, problems, source) {
  const declared = new Set();
  const queue = links.map((href) => ({ href, from: null }));
  const seen = new Set();
  while (queue.length) {
    const { href, from } = queue.shift();
    const clean = href.split(/[?#]/, 1)[0];
    let relative;
    if (clean.startsWith("/")) relative = path.posix.normalize(clean.replace(/^\/+/, ""));
    else if (from) relative = path.posix.normalize(path.posix.join(path.posix.dirname(from), clean));
    else {
      problems.push(`${source}: links the stylesheet ${href} by a relative path; link it by site-absolute path such as /styles/system.css`);
      continue;
    }
    if (seen.has(relative)) continue;
    seen.add(relative);
    let css;
    try {
      css = await fs.readFile(path.join(artifactRoot, ...relative.split("/")), "utf8");
    } catch {
      problems.push(`${source}: links /${relative}, which the built artifact does not contain`);
      continue;
    }
    for (const name of declaredClasses(css)) declared.add(name);
    for (const reference of importReferences(css)) queue.push({ href: reference, from: relative });
  }
  return declared;
}

/**
 * The nudges toward journeys: a design whose pages a visitor moves through
 * (more than one page, or a route with states) and no journey to show the
 * order, or a route with states that no journey shows. Warnings, never
 * failures, so a system authored before journeys keeps passing.
 */
export function journeyWarnings(designs) {
  const warnings = [];
  for (const design of designs) {
    const manifest = `${DESIGNS_SOURCE_DIRECTORY}/${design.id}/design.json`;
    const withStates = design.pages.filter((page) => page.states.length > 1).map((page) => page.route);
    if (!design.journeys.length) {
      if (design.pages.length < 2 && !withStates.length) continue;
      const what = [design.pages.length > 1 ? plural(design.pages.length, "page") : null, withStates.length ? `states on ${withStates.join(", ")}` : null].filter(Boolean).join(" and ");
      warnings.push(`design ${design.id} has ${what} but ${manifest} declares no journeys; add "journeys" (steps, each with the screens a visitor meets and the branches met instead) so /${DESIGNS_OUTPUT_DIRECTORY}/${design.id}/${JOURNEYS_OUTPUT_DIRECTORY}/<journey>/ shows the pages in order; see the Website designs section of AGENTS.md`);
      continue;
    }
    const shown = new Set();
    for (const journey of design.journeys) {
      for (const step of journey.steps) {
        for (const screen of [...step.screens, ...step.branches]) shown.add(screen.route);
      }
    }
    const missing = withStates.filter((route) => !shown.has(route));
    if (missing.length) {
      warnings.push(`design ${design.id} has states on ${missing.join(", ")} that no journey in ${manifest} shows; add the route as a screen or branch of the step where a visitor meets it`);
    }
  }
  return warnings;
}

/**
 * Enforce that every design uses nothing the system does not define. Throws
 * one error listing every problem with its source file, so a designer fixes
 * them in one pass. Returns the counts for the check summary, with the
 * journey nudges as warnings.
 */
export async function checkDesigns({ designSystemRoot, manifest = null, artifactRoot = path.join(designSystemRoot, "dist") }) {
  const rendered = await renderDesigns({ designSystemRoot, manifest });
  if (!rendered) return { enabled: false, designCount: 0, pageCount: 0, stateCount: 0, journeyCount: 0, warnings: [] };
  const problems = [];
  for (const design of rendered.designs) {
    for (const page of design.pages) {
      for (const state of page.states) {
        const { source, html } = state;
        const document = parseHtml(html);
        const elements = [...walk(document)].filter((node) => node.type === "element");
        const styles = elements.filter((node) => node.tag === "style").length;
        if (styles) problems.push(`${source}: contains ${styles} <style> element${styles === 1 ? "" : "s"}; add the rules to the system's stylesheet instead`);
        const styled = elements.filter((node) => attr(node, "style") !== undefined).length;
        if (styled) problems.push(`${source}: ${styled} element${styled === 1 ? " has a" : "s have a"} style attribute; use classes the system's stylesheet declares`);

        const { links } = stylesheetReferences(html);
        if (!links.length) problems.push(`${source}: links no local stylesheet; link the system's stylesheet by site-absolute path such as /styles/system.css`);
        const declared = await linkedClasses(links, artifactRoot, problems, source);
        const unknown = new Set();
        for (const node of elements) {
          for (const name of classList(node)) if (!declared.has(name)) unknown.add(name);
        }
        if (unknown.size && links.length) {
          problems.push(`${source}: uses classes the linked stylesheets do not declare (${[...unknown].sort().join(", ")}); add them to the system's stylesheet or use what it has`);
        }

        const relative = new Set();
        for (const node of elements) {
          for (const name of REFERENCE_ATTRIBUTES) {
            const value = String(attr(node, name) ?? "").trim();
            if (!value || value.startsWith("#") || value.startsWith("?")) continue;
            if (value.startsWith("/") || isExternal(value)) continue;
            relative.add(value);
          }
        }
        if (relative.size) {
          problems.push(`${source}: uses relative references (${[...relative].sort().join(", ")}) that no consumer can resolve; use a site-absolute path such as /assets/logo.svg or the asset's public URL`);
        }
      }
    }
  }
  if (problems.length) {
    const shown = problems.slice(0, MAX_REPORTED_PROBLEMS).map((problem) => `- ${problem}`);
    if (problems.length > MAX_REPORTED_PROBLEMS) shown.push(`- and ${problems.length - MAX_REPORTED_PROBLEMS} more`);
    throw new Error(`Website designs must use only what the system defines:\n${shown.join("\n")}`);
  }
  return { enabled: true, designCount: rendered.designs.length, pageCount: rendered.pageCount, stateCount: rendered.stateCount, journeyCount: rendered.journeyCount, warnings: journeyWarnings(rendered.designs) };
}

/* ── derived document ───────────────────────────────────────────────────── */

/** A journey's screen as designs.json names it: the page state in the design, its url, and what a caption shows. */
const screenReference = (screen) => ({ route: screen.route, state: screen.state, label: screen.label, note: screen.note, url: screen.url });

const journeyDocument = (journey) => ({
  id: journey.id,
  title: journey.title,
  summary: journey.summary,
  url: journey.url,
  stepCount: journey.stepCount,
  screenCount: journey.screenCount,
  steps: journey.steps.map((step) => ({ title: step.title, summary: step.summary, screens: step.screens.map(screenReference), branches: step.branches.map(screenReference) })),
});

/** designs.json: the design directory with every page state's HTML and every journey's order, for consumers without a checkout. */
export function designsDocument(rendered, manifest) {
  return {
    schemaVersion: DESIGNS_SCHEMA_VERSION,
    system: { id: manifest.systemId, name: manifest.name, version: manifest.version },
    // Set by publication to the CDN prefix every site-absolute reference resolves against.
    base: null,
    url: rendered.url,
    designCount: rendered.designs.length,
    pageCount: rendered.pageCount,
    stateCount: rendered.stateCount,
    journeyCount: rendered.journeyCount,
    designs: rendered.designs.map((design) => ({
      id: design.id,
      title: design.title,
      summary: design.summary,
      url: design.url,
      pages: design.pages.map((page) => ({
        route: page.route,
        title: page.title,
        url: page.url,
        states: page.states.map((state) => ({ name: state.name, title: state.title, url: state.url, html: state.html, references: state.references })),
      })),
      journeys: design.journeys.map(journeyDocument),
    })),
  };
}

/** A journey as a listing carries it: the steps and screens in visitor order, without the pages' HTML. */
function journeyListing(journey) {
  const screen = ({ route, state, label, note, url }) => ({ route, state, label, ...(note ? { note } : {}), url });
  return {
    id: journey.id,
    title: journey.title,
    ...(journey.summary ? { summary: journey.summary } : {}),
    url: journey.url,
    stepCount: journey.stepCount ?? journey.steps?.length ?? 0,
    screenCount: journey.screenCount ?? 0,
    steps: (journey.steps ?? []).map((step) => ({
      title: step.title,
      ...(step.summary ? { summary: step.summary } : {}),
      screens: (step.screens ?? []).map(screen),
      ...(step.branches?.length ? { branches: step.branches.map(screen) } : {}),
    })),
  };
}

/**
 * The directory of a designs document without the HTML, for listings: each
 * design's routes and states, and its journeys with the screens in the order
 * a visitor meets them (a document written before journeys lists none).
 */
export function designsDirectory(document) {
  return (document?.designs ?? []).map((design) => ({
    id: design.id,
    title: design.title,
    ...(design.summary ? { summary: design.summary } : {}),
    url: design.url,
    pageCount: design.pages?.length ?? 0,
    pages: (design.pages ?? []).map((page) => ({
      route: page.route,
      title: page.title,
      url: page.url,
      states: (page.states ?? []).map((state) => state.name),
    })),
    journeys: (design.journeys ?? []).map(journeyListing),
  }));
}

/** One page state of a designs document, by design id, route, and state name. */
export function findDesignPage(document, designId, route, state = DEFAULT_STATE) {
  const design = (document?.designs ?? []).find((candidate) => candidate.id === designId);
  if (!design) return { design: null, page: null, state: null };
  const normalized = String(route ?? "/").trim();
  const wanted = normalized.length > 1 ? `/${normalized.replace(/^\/+|\/+$/g, "")}` : "/";
  const page = design.pages.find((candidate) => candidate.route === wanted) ?? null;
  const found = page?.states.find((candidate) => candidate.name === (state || DEFAULT_STATE)) ?? null;
  return { design, page, state: found };
}

/** Every site-absolute file the designs load, for the publisher. */
export function eachDesignReference(document, visit) {
  for (const design of document?.designs ?? []) {
    for (const page of design.pages ?? []) {
      for (const state of page.states ?? []) {
        for (const reference of state.references ?? []) visit(reference);
      }
    }
  }
}

/** The data-only division declaration and route inventory shared by build, check and preview. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { defaultPageFiles, fileOverlapsNamespace, inNamespace, pageFileRoute } from "./section-routes.mjs";

export const COMPOSITION_CONTRACT = 1;
const MAX_DIVISIONS = 8;
const MAX_DEPENDENCIES = 4;
const MAX_INPUTS = 48;
const MAX_INPUT_BYTES = 12 * 1024 * 1024;
const METADATA = ["bundle.json", "designs.json"];
const SHA256 = /^[a-f0-9]{64}$/;
const SYSTEM_ID = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+$/;
const RELEASE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const INPUT_PATH = /^files\/(?:tokens\.css|styles\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:css|woff2?|ttf|otf|png|jpe?g|webp|gif|avif|ico|svg)|(?:assets|fonts)\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:woff2?|ttf|otf|png|jpe?g|webp|gif|avif|ico|svg))$/i;
export const DEPENDENCY_DIRECTORY = "timds-dependencies";
const MAX_BYTES = 96 * 1024;
const MAX_ROUTES = 2000;
const MAX_STYLES = 64;
const IDENTIFIER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MOUNT = /^(?:\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*){1,4}\/$/;
const SOURCE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const INPUT_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const RESERVED = new Set(["api", "assets", "cdn-cgi", "dist", "docs", "public", "scripts", "seed", "site", "sitemap-timds-pages", "src", "styles", "timds-dependencies", "topics"]);
const canonical = (route) => route.endsWith("/") ? route : `${route}/`;
const withoutSlash = (route) => route === "/" ? route : route.replace(/\/+$/, "");
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const id = (value) => typeof value === "string" && value.length <= 63 && IDENTIFIER.test(value);
const info = (file) => {
  try { return lstatSync(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
};

export function compositionFile(root, relative, { optional = false, directory = false, staged = false } = {}) {
  let file = root;
  const segments = relative.split("/");
  for (let index = 0; index < segments.length; index++) {
    if (!(staged ? INPUT_SEGMENT : SOURCE_SEGMENT).test(segments[index])) throw new Error(`Invalid site composition source path: ${relative}.`);
    file = path.join(file, segments[index]);
    const stat = info(file);
    if (!stat && optional) return null;
    const isDirectory = directory || index < segments.length - 1;
    if (isDirectory ? !stat?.isDirectory() : !stat?.isFile()) throw new Error(`Site composition requires a regular ${directory ? "directory" : "file"} at ${relative}.`);
  }
  return file;
}

function jsonFile(root, relative, { optional = false, limit = MAX_BYTES } = {}) {
  const file = compositionFile(root, relative, { optional });
  if (!file) return null;
  if (info(file).size > limit) throw new Error(`${relative} exceeds the site composition byte limit.`);
  let value;
  try { value = JSON.parse(readFileSync(file, "utf8")); } catch { throw new Error(`${relative} must contain valid JSON.`); }
  if (!object(value)) throw new Error(`${relative} must contain an object.`);
  return value;
}

function sourcePath(value, prefix, suffix = "") {
  return typeof value === "string" && value.length <= 240 && value.startsWith(prefix) && value.endsWith(suffix)
    && value.split("/").every((segment) => SOURCE_SEGMENT.test(segment));
}

const label = (value, limit, pattern) => typeof value === "string" && value.length <= limit && pattern.test(value);

function readSystems(systems) {
  if (!object(systems) || !exactKeys(systems.main, ["workspace"]) || systems.main.workspace !== true) {
    throw new Error('divisions.json requires systems: { "main": { "workspace": true } }.');
  }
  const siblings = Object.entries(systems).filter(([alias]) => alias !== "main");
  if (siblings.length > MAX_DEPENDENCIES || siblings.some(([alias, pin]) => !id(alias) || !exactKeys(pin, ["systemId", "version"])
    || !label(pin.systemId, 160, SYSTEM_ID) || !label(pin.version, 100, RELEASE))) {
    throw new Error("Site divisions accept up to four sibling Design Systems with exact release versions.");
  }
  return systems;
}

export function divisionInputsRoot(siteRoot) {
  const root = process.env.TIMDS_SITE_INPUTS;
  if (!root) return path.join(siteRoot, ".timds-site-inputs");
  if (!path.isAbsolute(root)) throw new Error("TIMDS_SITE_INPUTS must name an absolute staging directory.");
  return root;
}

const inputError = () => { throw new Error("The staged sibling Design System inputs do not match the declared pins and digests."); };

function stagedFiles(root, dependency, budget) {
  const files = new Map(), paths = new Set();
  let previous = "";
  if (!Array.isArray(dependency.files) || dependency.files.length < METADATA.length || dependency.files.length > MAX_INPUTS) inputError();
  for (const file of dependency.files) {
    if (!exactKeys(file, ["path", "size", "sha256"]) || typeof file.path !== "string" || file.path.length > 320 || file.path <= previous
      || !METADATA.includes(file.path) && !INPUT_PATH.test(file.path) || paths.has(file.path.toLowerCase()) || !Number.isSafeInteger(file.size)
      || file.size < 1 || file.size > (METADATA.includes(file.path) ? 2 : 6) * 1024 * 1024 || !label(file.sha256, 64, SHA256)) inputError();
    paths.add(file.path.toLowerCase());
    previous = file.path;
    budget.count++;
    budget.bytes += file.size;
    if (budget.count > MAX_INPUTS || budget.bytes > MAX_INPUT_BYTES) inputError();
    const absolute = compositionFile(root, `${dependency.alias}/${file.path}`, { staged: true });
    if (info(absolute).size !== file.size) inputError();
    const bytes = readFileSync(absolute);
    if (bytes.length !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.sha256) inputError();
    files.set(file.path, bytes);
  }
  if (METADATA.some((file) => !files.has(file))) inputError();
  return files;
}

function siblingInputs(siteRoot, systems, divisions) {
  const aliases = Object.keys(systems).filter((alias) => alias !== "main").sort();
  if (!aliases.length) return { dependencies: [], inputs: new Map() };
  if (aliases.some((alias) => !divisions.some((division) => division.system === alias))) throw new Error("Each declared sibling Design System must be used by a division.");
  const root = divisionInputsRoot(siteRoot);
  if (!info(root)?.isDirectory()) throw new Error("Stage the exact sibling Design System releases before checking, previewing or building this site.");
  const receipt = jsonFile(root, "receipt.json");
  if (!exactKeys(receipt, ["schemaVersion", "dependencies"]) || receipt.schemaVersion !== 1 || !Array.isArray(receipt.dependencies)
    || receipt.dependencies.length !== aliases.length) inputError();
  const budget = { count: 0, bytes: 0 };
  const inputs = new Map();
  for (const [index, dependency] of receipt.dependencies.entries()) {
    const alias = aliases[index], pin = systems[alias];
    if (!exactKeys(dependency, ["alias", "sourceId", "systemId", "version", "commit", "contentDigest", "manifestDigest", "files"])
      || dependency.alias !== alias || dependency.systemId !== pin.systemId || dependency.version !== pin.version
      || !label(dependency.sourceId, 36, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i)
      || !label(dependency.commit, 40, /^[a-f0-9]{40}$/) || !label(dependency.contentDigest, 64, SHA256)
      || !label(dependency.manifestDigest, 64, SHA256)) inputError();
    const files = stagedFiles(root, dependency, budget);
    let designs, bundle;
    try {
      designs = JSON.parse(files.get("designs.json").toString("utf8"));
      bundle = JSON.parse(files.get("bundle.json").toString("utf8"));
    } catch { inputError(); }
    if ([designs, bundle].some((doc) => doc?.schemaVersion !== 1 || doc.system?.id !== pin.systemId || doc.system?.version !== pin.version)
      || !Array.isArray(designs.designs)) inputError();
    const assetPrefix = `/${DEPENDENCY_DIRECTORY}/${alias}/${dependency.contentDigest}`;
    inputs.set(alias, { designs: designs.designs, files, assetPrefix, root: path.join(root, alias, "files") });
  }
  return { dependencies: receipt.dependencies, inputs };
}

/** Resolve owner-authored pages and section contexts from the same declaration. */
export function readDivisionComposition(siteRoot, sections, { previousInputs } = {}) {
  const document = jsonFile(siteRoot, "divisions.json", { optional: true });
  if (document === null) return null;
  if (!exactKeys(document, ["schemaVersion", "systems", "divisions"]) || document.schemaVersion !== COMPOSITION_CONTRACT
    || !Array.isArray(document.divisions) || document.divisions.length < 1 || document.divisions.length > MAX_DIVISIONS) {
    throw new Error(`divisions.json must declare schemaVersion 1 and between 1 and ${MAX_DIVISIONS} divisions.`);
  }
  const systems = readSystems(document.systems);
  const ids = new Set(), mounts = new Set(), pageFolders = new Set(), pages = new Map(), collectionContexts = new Map();
  const byCollection = new Map(sections.map((section) => [section.collection, section]));
  const divisions = document.divisions.map((division) => {
    if (!exactKeys(division, ["id", "prefix", "system", "design", "pages", "layout", "collections"]) || !id(division.id) || !id(division.design)
      || !id(division.system) || !Object.hasOwn(systems, division.system) || typeof division.prefix !== "string" || division.prefix.length > 120
      || !MOUNT.test(division.prefix) || division.prefix.slice(1, -1).split("/").some((segment) => RESERVED.has(segment))
      || !sourcePath(division.pages, "src/divisions/") || !sourcePath(division.layout, "src/layouts/", ".astro")
      || !Array.isArray(division.collections) || division.collections.length > sections.length) {
      throw new Error("Each division must declare an id, literal prefix, known system, design, pages under src/divisions/, Astro layout under src/layouts/ and collections.");
    }
    const { id: divisionId, prefix } = division;
    if (ids.has(divisionId) || [...mounts].some((mount) => prefix.startsWith(mount) || mount.startsWith(prefix))) {
      throw new Error(`Division ${divisionId} has a duplicate id or overlapping mount ${prefix}.`);
    }
    if ([...pageFolders].some((folder) => `${division.pages}/`.startsWith(`${folder}/`) || `${folder}/`.startsWith(`${division.pages}/`))) {
      throw new Error(`Division ${divisionId} shares an overlapping page folder.`);
    }
    ids.add(divisionId);
    mounts.add(prefix);
    pageFolders.add(division.pages);
    for (const collection of division.collections) {
      if (!byCollection.has(collection) || collectionContexts.has(collection)) throw new Error(`Division ${divisionId} names an unknown or already-associated collection: ${collection}.`);
      collectionContexts.set(collection, divisionId);
    }
    const pageDirectory = compositionFile(siteRoot, division.pages, { directory: true });
    compositionFile(siteRoot, division.layout);
    const defaults = defaultPageFiles(pageDirectory, { strict: true });
    if (!defaults.some(([route]) => route === "/")) throw new Error(`Division ${divisionId} needs a landing page at ${division.pages}/index.html.`);
    for (const [local, file] of defaults) {
      const route = local === "/" ? withoutSlash(prefix) : `${withoutSlash(prefix)}${local}`;
      if (route.length > 240) throw new Error(`Division page route exceeds the site composition limit: ${route}.`);
      pages.set(route, { route, local, division: divisionId, source: `${division.pages}/${file}` });
      if (pages.size > MAX_ROUTES) throw new Error("The site composition has too many routes.");
    }
    return { ...division };
  });
  for (const section of sections) {
    if (section.prefix.startsWith(`/${DEPENDENCY_DIRECTORY}/`)) throw new Error(`Section ${section.collection} conflicts with the dependency asset namespace.`);
    for (const { id: division, prefix } of divisions) {
      if (prefix.startsWith(section.prefix) || section.prefix.startsWith(prefix) && collectionContexts.get(section.collection) !== division) {
        throw new Error(`Section ${section.collection} at ${section.prefix} conflicts with division ${division} at ${prefix}. A nested section needs an explicit association to its containing division.`);
      }
    }
  }
  const systemsKey = JSON.stringify(systems);
  const staged = previousInputs?.systemsKey === systemsKey && Object.keys(systems).every((alias) => alias === "main" || divisions.some((division) => division.system === alias))
    ? previousInputs : siblingInputs(siteRoot, systems, divisions);
  return { systems, divisions, pages, collectionContexts, ...staged, systemsKey };
}

/** Resolve mounted routes with the existing section inventory before any site mutation. */
export function compositionRouteInventory(composition, inventory, handlers, { pageFiles = [], publicFiles = [], resolvedRoutes = [] } = {}) {
  if (!composition) return null;
  const { divisions, pages, collectionContexts } = composition;
  const withinMount = (route) => divisions.some(({ prefix }) => inNamespace(route, prefix));
  const conflictsWithMount = (route) => divisions.some(({ prefix }) => fileOverlapsNamespace(route, prefix));
  const dependencyNamespace = `/${DEPENDENCY_DIRECTORY}/`;
  for (const { route } of inventory.pages) {
    if (withinMount(route)) throw new Error(`Main design page ${route} conflicts with a division mount.`);
    if (inNamespace(route, dependencyNamespace)) throw new Error(`Main design page ${route} conflicts with the dependency asset namespace.`);
  }
  for (const route of pages.keys()) {
    if (inventory.sections.some(({ section }) => inNamespace(route, section.prefix))) throw new Error(`Division page ${route} conflicts with a collection namespace.`);
  }
  const ordinaryPages = inventory.pages.map(({ route }) => route).filter((route) => route !== "/404");
  const matchesMain = (pattern) => ordinaryPages.some((route) => fileOverlapsNamespace(pattern, canonical(route), { exact: true }));
  for (const file of pageFiles) {
    const route = pageFileRoute(file);
    if (!route || file === "src/pages/[...page].astro") continue;
    if (conflictsWithMount(route)) throw new Error(`Site page ${file} conflicts with a division mount.`);
    if (fileOverlapsNamespace(route, dependencyNamespace)) throw new Error(`Site page ${file} conflicts with the dependency asset namespace.`);
    if (matchesMain(route)) throw new Error(`Site page ${file} conflicts with a main design page.`);
  }
  for (const file of publicFiles) {
    const route = `/${file.replace(/^public\//, "")}`;
    const aliases = [route, route.replace(/(?:\/index)?\.html?$/i, "") || "/"];
    if (aliases.some((alias) => withinMount(alias))) throw new Error(`Public file ${file} conflicts with a division mount.`);
    if (aliases.some((alias) => ordinaryPages.includes(alias))) throw new Error(`Public file ${file} conflicts with a main design page.`);
    if (aliases.some((alias) => inNamespace(alias, dependencyNamespace))) throw new Error("The dependency asset namespace is reserved in a composed site.");
  }
  for (const route of resolvedRoutes) {
    const pattern = withoutSlash(route.pattern ?? "");
    const owned = route.entrypoint === "src/pages/[...page].astro" && pattern === "/[...page]"
      || inventory.sections.some((item) => route.entrypoint === "src/routes/articles/index.astro" && pattern === item.list
        || route.entrypoint === "src/routes/articles/entry.astro" && pattern === item.entry
        || route.entrypoint === "src/routes/articles/rss.xml.ts" && pattern === item.feed);
    if (owned || !pattern) continue;
    if (conflictsWithMount(pattern)) throw new Error(`Site route ${pattern} conflicts with a division mount.`);
    if (fileOverlapsNamespace(pattern, dependencyNamespace)) throw new Error(`Site route ${pattern} conflicts with the dependency asset namespace.`);
    if (matchesMain(pattern)) throw new Error(`Site route ${pattern} conflicts with a main design page.`);
  }
  const routes = [
    ...inventory.pages.filter(({ route }) => route !== "/404").map(({ route }) => ({ path: canonical(route), division: null, kind: "page" })),
    ...[...pages.values()].map(({ route, division }) => ({ path: canonical(route), division, kind: "page" })),
    ...inventory.sections.flatMap(({ section, feed }) => {
      const division = collectionContexts.get(section.collection) ?? null;
      return [
        { path: section.prefix, division, kind: "list" },
        { path: section.urlPattern, division, kind: "entry" },
        ...(feed ? [{ path: feed, division, kind: "feed" }] : []),
      ];
    }),
    { path: "/topics/{slug}/", division: null, kind: "topic" },
    ...[...handlers].map((route) => {
      if (inNamespace(route, dependencyNamespace)) throw new Error(`Form handler ${route} conflicts with the dependency asset namespace.`);
      return {
        path: canonical(route),
        division: divisions.find(({ prefix }) => inNamespace(route, prefix))?.id
          ?? inventory.sections.map(({ section }) => section).filter(({ prefix }) => inNamespace(route, prefix)).map(({ collection }) => collectionContexts.get(collection))[0]
          ?? null,
        kind: "form",
      };
    }),
  ];
  const owners = new Set();
  for (const { path, kind } of routes) {
    const owner = `${kind}: ${path}`;
    if (owners.has(owner)) throw new Error(`Site composition declares multiple route owners for ${owner}.`);
    owners.add(owner);
  }
  return routes.sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind));
}

export function retainComposition(composition, routes, assets) {
  const retained = { schemaVersion: COMPOSITION_CONTRACT, divisions: composition.divisions, dependencies: composition.dependencies, routes, assets };
  if (routes.length > MAX_ROUTES || assets.length > MAX_STYLES || Buffer.byteLength(JSON.stringify(retained)) > MAX_BYTES) throw new Error("The resolved site composition exceeds its route, style or byte limit.");
  return retained;
}

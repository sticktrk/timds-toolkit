/** One inventory for site routing, consumer checks and preview pairs. */
import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";
const STOCK_REFERENCES = new Set(["/articles", "/articles/example-article", "/topics", "/topics/example-topic"]);
const STOCK_PAGE_FILES = new Set(["src/pages/[...page].astro", "src/pages/404.astro", "src/pages/topics/[slug].astro"]);
const PAGE_EXTENSION = /\.(?:astro|html|markdown|mdown|mkdn|mkd|mdwn|md|mdx|js|ts)$/;
const normalizedRoute = (route) => route === "/" ? route : route.replace(/\/+$/, "");
const inNamespace = (route, prefix) => route === prefix.slice(0, -1) || route.startsWith(prefix);

/** Inspect route sources without following links or executing site code. */
export function readSectionRouteFiles(siteRoot, { pagesDirectory = path.join(siteRoot, "src/pages"), publicDirectory = path.join(siteRoot, "public") } = {}) {
  const result = { pageFiles: [], publicFiles: [], symlinks: [] };
  const info = (file) => { try { return lstatSync(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
  for (const [directory, prefix, key] of [[pagesDirectory, "src/pages", "pageFiles"], [publicDirectory, "public", "publicFiles"]]) {
    const relative = path.relative(siteRoot, directory);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Site route and public directories must stay inside the site.");
    let ancestor = siteRoot, blocked = false;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      ancestor = path.join(ancestor, segment);
      if (info(ancestor)?.isSymbolicLink()) { result.symlinks.push(path.relative(siteRoot, ancestor).split(path.sep).join("/")); blocked = true; break; }
    }
    if (blocked || !info(directory)?.isDirectory()) continue;
    const walk = (folder, label) => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const name = `${label}/${entry.name}`;
        if (entry.isSymbolicLink()) result.symlinks.push(name);
        else if (entry.isDirectory()) walk(path.join(folder, entry.name), name);
        else if (entry.isFile()) result[key].push(name);
      }
    };
    walk(directory, prefix);
  }
  return result;
}

/** An Astro file route, including dynamic segments, without executing its source. */
export function pageFileRoute(file) {
  if (!file.startsWith("src/pages/") || !PAGE_EXTENSION.test(file)) return null;
  const parts = file.slice("src/pages/".length).replace(PAGE_EXTENSION, "").split("/");
  if (parts.some((part) => part.startsWith("_") || part.startsWith(".") && part !== ".well-known")) return null;
  if (parts.at(-1) === "index") parts.pop();
  return `/${parts.join("/")}`;
}

function fileOverlapsNamespace(route, prefix) {
  const pattern = route.slice(1).split("/"), segments = prefix.slice(1, -1).split("/");
  for (let index = 0; index < segments.length; index++) {
    const part = pattern[index];
    if (!part) return false;
    if (/\[\.\.\.[^\]]+\]/.test(part)) return true;
    // Dynamic parts can match a literal prefix segment; static siblings cannot.
    const expression = part.split(/(\[[^\]]+\])/).map((piece) => /^\[/.test(piece) ? "[^/]+" : piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("");
    if (!new RegExp(`^${expression}$`).test(segments[index])) return false;
  }
  return true;
}

export function sectionRouteInventory(sections, designPages = [], { version = 2, pageFiles = [], publicFiles = [], symlinks = [], resolvedRoutes = [] } = {}) {
  if (version !== 2) throw new Error("Unsupported section route contract; expected 2.");
  if (symlinks.length) throw new Error(`Site route and public directories cannot contain symbolic links: ${symlinks[0]}.`);
  const namespaces = [...sections.map((section) => section.prefix), "/topics/"];
  const pages = [], references = [];
  for (const page of designPages) {
    const route = normalizedRoute(page.route);
    if (page.site !== undefined && page.site !== "reference") throw new Error(`Design page ${route} has an invalid site role; use site: "reference" for a nonpublic sample.`);
    const reserved = namespaces.some((prefix) => inNamespace(route, prefix));
    if (page.site === "reference" || STOCK_REFERENCES.has(route)) references.push({ ...page, route });
    else if (reserved) throw new Error(`Design page ${route} conflicts with a collection or topic namespace. Move the public page or mark its design.json page as site: "reference" if it is a template sample.`);
    else pages.push({ ...page, route });
  }
  for (const file of pageFiles) {
    const route = pageFileRoute(file);
    if (route && !STOCK_PAGE_FILES.has(file) && namespaces.some((prefix) => fileOverlapsNamespace(route, prefix))) throw new Error(`Site page ${file} conflicts with a collection or topic namespace. Move the page outside that namespace.`);
  }
  for (const file of publicFiles) {
    const route = `/${file.replace(/^public\//, "")}`;
    const aliases = [route, route.replace(/(?:\/index)?\.html?$/, "") || "/"];
    if (aliases.some((alias) => namespaces.some((prefix) => inNamespace(alias, prefix)))) throw new Error(`Public file ${file} conflicts with a collection or topic namespace. Move the file outside that namespace.`);
  }
  for (const route of resolvedRoutes) {
    if (route.origin !== "project" || STOCK_PAGE_FILES.has(route.entrypoint?.replaceAll("\\", "/"))) continue;
    if (typeof route.pattern === "string" && namespaces.some((prefix) => fileOverlapsNamespace(route.pattern, prefix))) throw new Error(`Site route ${route.pattern} conflicts with a collection or topic namespace. Move the route outside that namespace.`);
  }
  return {
    pages, references,
    sections: sections.map((section) => ({ section, list: section.prefix.slice(0, -1), entry: `${section.prefix}[slug]`, sample: `${section.prefix}example-article`, feed: section.feed ? `${section.prefix}rss.xml` : null })),
    topic: "/topics/[slug]",
  };
}

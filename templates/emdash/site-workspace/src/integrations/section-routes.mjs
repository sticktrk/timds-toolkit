/** One data-only inventory for site routing, consumer checks and preview pairs. */
const STOCK_REFERENCES = new Set(["/articles", "/articles/example-article", "/topics", "/topics/example-topic"]);
const STOCK_PAGE_FILES = new Set(["src/pages/[...page].astro", "src/pages/404.astro", "src/pages/topics/[slug].astro"]);
const PAGE_EXTENSION = /\.(?:astro|html|markdown|mdown|mkdn|mkd|mdwn|md|mdx|js|ts)$/;
const normalizedRoute = (route) => route === "/" ? route : route.replace(/\/+$/, "");
const inNamespace = (route, prefix) => route === prefix.slice(0, -1) || route.startsWith(prefix);

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

export function sectionRouteInventory(sections, designPages = [], { version = 2, pageFiles = [] } = {}) {
  if (![1, 2].includes(version)) throw new Error("Unsupported section route contract.");
  const namespaces = [...sections.map((section) => section.prefix), "/topics/"];
  const pages = [], references = [];
  for (const page of designPages) {
    const route = normalizedRoute(page.route);
    if (page.site !== undefined && page.site !== "reference") throw new Error(`Design page ${route} has an invalid site role; use site: "reference" for a nonpublic sample.`);
    const reserved = namespaces.some((prefix) => inNamespace(route, prefix));
    if (page.site === "reference" || version === 1 && reserved || version === 2 && STOCK_REFERENCES.has(route)) references.push({ ...page, route });
    else if (reserved) throw new Error(`Design page ${route} conflicts with a collection or topic namespace. Move the public page or mark its design.json page as site: "reference" if it is a template sample.`);
    else pages.push({ ...page, route });
  }
  if (version === 2) for (const file of pageFiles) {
    const route = pageFileRoute(file);
    if (route && !STOCK_PAGE_FILES.has(file) && namespaces.some((prefix) => fileOverlapsNamespace(route, prefix))) throw new Error(`Site page ${file} conflicts with a collection or topic namespace. Move the page outside that namespace.`);
  }
  return {
    pages, references,
    sections: sections.map((section) => ({ section, list: section.prefix.slice(0, -1), entry: `${section.prefix}[slug]`, sample: `${section.prefix}example-article`, feed: section.feed ? `${section.prefix}rss.xml` : null })),
    topic: "/topics/[slug]",
  };
}

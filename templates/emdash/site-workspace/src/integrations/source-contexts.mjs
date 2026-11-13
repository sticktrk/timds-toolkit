/** Read the local source graph as data; never import a site's modules. */
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pageFileRoute, readSectionRouteFiles } from "./section-routes.mjs";

const MODULE_EXTENSIONS = [".tsx", ".jsx", ".ts", ".mts", ".cts", ".mjs", ".cjs", ".js"];
const SOURCE_EXTENSIONS = [".astro", ...MODULE_EXTENSIONS, ".vue", ".svelte", ".html", ".css"];
const DATA_EXTENSION = /\.(?:json|svg|png|jpe?g|webp|gif|avif|ico|woff2?|ttf|otf)$/i;
const inside = (root, file) => { const relative = path.relative(root, file); return !relative.startsWith("..") && !path.isAbsolute(relative); };
const stat = (file) => { try { return lstatSync(file); } catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return null; throw error; } };
const attribute = (tag, name) => tag.attributes.find((entry) => entry.name === name)?.value;
const referenceAttribute = (tag, name) => { const value = attribute(tag, name); return value?.startsWith("{") ? null : value; };
const stylesheet = (reference) => /\.(?:css|scss|sass|less|styl)(?:[?#]|$)/i.test(reference);

/** The ESTree parser used by Astro/Vite exposes import syntax without evaluating it. */
export function moduleImportReferences(program) {
  const references = [];
  const literal = (node) => {
    const value = node?.type === "TemplateLiteral" && !node.expressions.length ? node.quasis[0]?.value?.cooked : node?.value;
    if (typeof value !== "string") throw new Error("Composition source imports must use literal paths.");
    references.push(value);
  };
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) && node.source && node.importKind !== "type" && node.exportKind !== "type") literal(node.source);
    if (node.type === "TSImportEqualsDeclaration" && node.importKind !== "type" && node.moduleReference?.type === "TSExternalModuleReference") literal(node.moduleReference.expression);
    if (node.type === "ImportExpression") literal(node.source);
    if (node.type === "CallExpression" && node.callee?.type === "Import") literal(node.arguments[0]);
    if (node.type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === "require") literal(node.arguments[0]);
    if (node.type === "CallExpression" && node.callee?.object?.type === "MetaProperty" && ["glob", "globEager"].includes(node.callee?.property?.name)) throw new Error("Composition sources need explicit local imports instead of import.meta.glob.");
    for (const [key, child] of Object.entries(node)) if (key !== "parent") {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object") visit(child);
    }
  };
  visit(program);
  return references;
}

function sourceReferences(text, file, { parseImports, htmlTags }) {
  const references = [];
  const extension = path.extname(file);
  const cssImports = (css) => {
    const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of source.matchAll(/@import\s+(?:url\(\s*)?(?:"([^"]+)"|'([^']+)'|([^\s;)]+))/gi)) references.push(match[1] ?? match[2] ?? match[3]);
  };
  if (extension === ".css") { cssImports(text); return references; }
  if (MODULE_EXTENSIONS.includes(extension)) return parseImports(text, file);
  if (DATA_EXTENSION.test(file)) return references;
  if (![".astro", ".vue", ".svelte", ".html"].includes(extension)) throw new Error(`Composition source ${file} uses an unsupported source syntax.`);
  let markup = text;
  if (extension === ".astro") {
    const frontmatter = /^(?:\uFEFF)?\s*---[^\n]*\n([\s\S]*?)\n---[^\n]*(?:\n|$)/.exec(text);
    if (frontmatter) { references.push(...parseImports(frontmatter[1], `${file}.ts`)); markup = text.slice(frontmatter[0].length); }
  }
  for (const tag of htmlTags(markup)) {
    if (tag.type !== "start") continue;
    if (tag.name === "link" && attribute(tag, "rel")?.toLowerCase().split(/\s+/).includes("stylesheet") && referenceAttribute(tag, "href")) references.push(referenceAttribute(tag, "href"));
    if (!["script", "style"].includes(tag.name)) continue;
    if (tag.name === "style" && attribute(tag, "lang") && attribute(tag, "lang").toLowerCase() !== "css") throw new Error(`Composition source ${file} must use plain CSS; stylesheet preprocessors are unsupported.`);
    const src = referenceAttribute(tag, "src");
    if (src) { references.push(src); continue; }
    const end = markup.indexOf(`</${tag.name}`, tag.end), body = markup.slice(tag.end, end === -1 ? undefined : end);
    if (tag.name === "style") cssImports(body);
    else if (!attribute(tag, "type") || /^(?:module|(?:text|application)\/(?:java|ecma)script)$/.test(attribute(tag, "type"))) {
      const language = attribute(tag, "lang") || "js";
      if (!["ts", "tsx", "js", "jsx"].includes(language)) throw new Error(`Composition source ${file} uses an unsupported script language.`);
      references.push(...parseImports(body, `${file}.${language}`));
    }
  }
  return references;
}

/**
 * Every renderer of a source file, including shared article components and
 * transitive layout imports. A null context means the main site. Local paths
 * are literal, bounded, and regular files; package imports stay package code.
 */
export function compositionSourceContexts(siteRoot, composition, sections, options) {
  const contexts = new Map(), texts = new Map(), edges = new Map();
  const root = realpathSync(siteRoot);
  const packages = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const dependencies = new Set(Object.keys({ ...packages.dependencies, ...packages.devDependencies }));
  let bytes = 0;
  const read = (file) => {
    if (texts.has(file)) return texts.get(file);
    const absolute = path.join(root, file), info = stat(absolute);
    if (!info?.isFile() || realpathSync(absolute) !== absolute || info.size > 2 * 1024 * 1024) throw new Error(`Composition source must be a regular bounded file: ${file}.`);
    const text = readFileSync(absolute, "utf8");
    bytes += Buffer.byteLength(text);
    if (texts.size >= 2000 || bytes > 12 * 1024 * 1024) throw new Error("Composition source imports exceed their file or byte limit.");
    texts.set(file, text);
    return text;
  };
  const resolve = (from, reference, context) => {
    if (/^(?:node:|cloudflare:|virtual:)/.test(reference)) return null;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(reference)) {
      if (context !== null && stylesheet(reference)) throw new Error(`Composition source ${from} must load Design System styles through its selected context.`);
      return null;
    }
    const target = reference.split(/[?#]/, 1)[0];
    if (/^\/(?:styles\/|tokens\.css$|timds-dependencies\/)/.test(target)) {
      if (context !== null) throw new Error(`Composition source ${from} must load Design System styles through its selected context.`);
      return null;
    }
    if (!target.startsWith(".") && !target.startsWith("/")) {
      const name = target.startsWith("@") ? target.split("/").slice(0, 2).join("/") : target.split("/")[0];
      if (!dependencies.has(name)) throw new Error(`Composition source ${from} has an unresolved import ${reference}; use a relative local path or a declared package.`);
      return null;
    }
    const absolute = target.startsWith("/") ? path.join(root, target) : path.resolve(root, path.dirname(from), target);
    if (!inside(root, absolute)) {
      if (context !== null) throw new Error(`Composition source ${from} imports outside the site. Select the design in divisions.json to load its styles.`);
      return null;
    }
    const candidates = [absolute, ...SOURCE_EXTENSIONS.map((extension) => absolute + extension), ...SOURCE_EXTENSIONS.map((extension) => path.join(absolute, `index${extension}`))];
    const found = candidates.find((candidate) => stat(candidate)?.isFile());
    if (!found) {
      // Public URLs in markup are not module imports and carry no source CSS.
      if (target.startsWith("/") && !stylesheet(target)) return null;
      throw new Error(`Composition source ${from} has an unresolved local import ${reference}.`);
    }
    if (DATA_EXTENSION.test(found)) {
      if (realpathSync(found) !== found) throw new Error(`Composition source ${from} imports a symbolic link.`);
      return null;
    }
    return path.relative(root, found).split(path.sep).join("/");
  };
  const visit = (file, context, depth = 0) => {
    if (depth > 64) throw new Error("Composition source imports exceed their depth limit.");
    const selected = contexts.get(file) ?? new Set();
    if (selected.has(context)) return;
    selected.add(context); contexts.set(file, selected);
    if (/\.(?:scss|sass|less|styl)$/i.test(file)) throw new Error(`Composition source ${file} must use plain CSS; stylesheet preprocessors are unsupported.`);
    const text = read(file);
    if (!edges.has(file)) edges.set(file, sourceReferences(text, file, options));
    for (const reference of edges.get(file)) {
      const child = resolve(file, reference, context);
      if (child) visit(child, context, depth + 1);
    }
  };
  const start = (file, context) => { if (stat(path.join(root, file))) visit(file, context); };
  const routeFiles = options.routeFiles ?? readSectionRouteFiles(root);
  const mainRoutes = new Set(routeFiles.pageFiles.filter((file) => pageFileRoute(file) && SOURCE_EXTENSIONS.includes(path.extname(file))));
  for (const { entrypoint } of routeFiles.resolvedRoutes ?? []) {
    if (typeof entrypoint !== "string" || !entrypoint.startsWith("src/") || /^src\/routes\/articles\/(?:index\.astro|entry\.astro|rss\.xml\.ts)$/.test(entrypoint)) continue;
    if (SOURCE_EXTENSIONS.includes(path.extname(entrypoint))) mainRoutes.add(entrypoint);
  }
  for (const file of [...mainRoutes, "src/layouts/Base.astro", "src/components/DesignPage.astro"]) start(file, null);
  for (const section of sections) for (const file of ["src/routes/articles/index.astro", "src/routes/articles/entry.astro"]) start(file, composition.collectionContexts.get(section.collection) ?? null);
  for (const division of composition.divisions) {
    start("src/pages/[...page].astro", division.id);
    visit(division.layout, division.id);
    for (const page of composition.pages.values()) if (page.division === division.id) visit(page.source, division.id);
  }
  return { contexts, texts };
}

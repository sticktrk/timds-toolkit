// Load TSX visual overrides as ESM even when the client package is CommonJS.
// Remotion's media package and TimDS's shared TSX exports require ESM imports.
// Stage transpiled authored TS/TSX modules in ignored video-local. A relative
// helper must be ESM too; otherwise tsx can classify it as CommonJS and hide its
// named exports. Package imports continue resolving from the installed runtime.
import {createHash} from "node:crypto";
import {promises as fs} from "node:fs";
import path from "node:path";
import {pathToFileURL} from "node:url";

export async function loadVideoComponentModule(componentsPath, localRoot) {
  // The compiler loads only on this path; every other CLI and MCP start stays light.
  const {default: ts} = await import("typescript");
  const directory = path.join(localRoot, "component-check");
  await fs.mkdir(directory, {recursive: true});
  const entries = new Map();
  async function compile(file) {
    if (entries.has(file)) return entries.get(file);
    const source = await fs.readFile(file, "utf8");
    const key = createHash("sha256").update(file).update(source).digest("hex");
    const entry = path.join(directory, `${key}.mjs`);
    entries.set(file, entry);
    const compilerOptions = {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX};
    // Follow only imports that survive compilation. Type-only imports include
    // inline `import {type T}` and ordinary imports used solely as types; their
    // declaration files need not exist at runtime and must never be executed.
    const emitted = ts.transpileModule(source, {fileName: file, compilerOptions}).outputText;
    const parsed = ts.createSourceFile(file, emitted, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const imports = new Set();
    const collect = (node) => {
      const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : null;
      if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith(".")) imports.add(specifier.text);
      ts.forEachChild(node, collect);
    };
    collect(parsed);
    const relocated = new Map();
    for (const specifier of imports) {
      const target = path.resolve(path.dirname(file), specifier);
      const candidates = path.extname(target) ? [target] : [target, ...[".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs"].map(extension => target + extension), ...[".tsx", ".ts", ".jsx", ".js"].map(extension => path.join(target, `index${extension}`))];
      let resolved = target;
      for (const candidate of candidates) if ((await fs.stat(candidate).catch(() => null))?.isFile()) { resolved = candidate; break; }
      const canTranspile = /\.(?:tsx?|jsx)$/u.test(resolved) || resolved.endsWith(".js") && ts.isExternalModule(ts.createSourceFile(resolved, await fs.readFile(resolved, "utf8"), ts.ScriptTarget.Latest, true));
      relocated.set(specifier, pathToFileURL(canTranspile ? await compile(resolved) : resolved).href);
    }
    const relocate = (context) => {
      const specifier = (node) => ts.isStringLiteral(node) && relocated.has(node.text) ? ts.factory.createStringLiteral(relocated.get(node.text)) : node;
      const visit = (node) => {
        if (ts.isPropertyAccessExpression(node) && node.name.text === "url" && ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword) return ts.factory.createStringLiteral(pathToFileURL(file).href);
        if (ts.isImportDeclaration(node)) return ts.factory.updateImportDeclaration(node, node.modifiers, node.importClause, specifier(node.moduleSpecifier), node.attributes);
        if (ts.isExportDeclaration(node) && node.moduleSpecifier) return ts.factory.updateExportDeclaration(node, node.modifiers, node.isTypeOnly, node.exportClause, specifier(node.moduleSpecifier), node.attributes);
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1) return ts.factory.updateCallExpression(node, node.expression, node.typeArguments, [specifier(node.arguments[0])]);
        return ts.visitEachChild(node, visit, context);
      };
      return (sourceFile) => ts.visitNode(sourceFile, visit);
    };
    const compiled = ts.transpileModule(source, {fileName: file, compilerOptions, transformers: {before: [relocate]}}).outputText;
    await fs.writeFile(entry, compiled);
    return entry;
  }
  const entry = await compile(componentsPath);
  const {tsImport} = await import("tsx/esm/api");
  return tsImport(pathToFileURL(entry).href, import.meta.url);
}

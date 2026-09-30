// Load TSX visual overrides as ESM even when the client package is CommonJS.
// Remotion's media package and TimDS's shared TSX exports require ESM imports.
// Stage only a transpiled loader entry in ignored video-local; original relative
// imports continue resolving beside the authored component file.
import {createHash} from "node:crypto";
import {promises as fs} from "node:fs";
import path from "node:path";
import {pathToFileURL} from "node:url";

export async function loadVideoComponentModule(componentsPath, localRoot) {
  // The compiler loads only on this path; every other CLI and MCP start stays light.
  const {default: ts} = await import("typescript");
  const source = await fs.readFile(componentsPath, "utf8");
  const key = createHash("sha256").update(componentsPath).update(source).digest("hex");
  const relocate = (context) => {
    const specifier = (node) => ts.isStringLiteral(node) && node.text.startsWith(".")
      ? ts.factory.createStringLiteral(pathToFileURL(path.resolve(path.dirname(componentsPath), node.text)).href) : node;
    const visit = (node) => {
      if (ts.isImportDeclaration(node)) return ts.factory.updateImportDeclaration(node, node.modifiers, node.importClause, specifier(node.moduleSpecifier), node.attributes);
      if (ts.isExportDeclaration(node) && node.moduleSpecifier) return ts.factory.updateExportDeclaration(node, node.modifiers, node.isTypeOnly, node.exportClause, specifier(node.moduleSpecifier), node.attributes);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1) return ts.factory.updateCallExpression(node, node.expression, node.typeArguments, [specifier(node.arguments[0])]);
      return ts.visitEachChild(node, visit, context);
    };
    return (file) => ts.visitNode(file, visit);
  };
  const compiled = ts.transpileModule(source, {fileName: componentsPath, compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX}, transformers: {before: [relocate]}}).outputText;
  const directory = path.join(localRoot, "component-check");
  await fs.mkdir(directory, {recursive: true});
  const entry = path.join(directory, `${key}.mjs`);
  await fs.writeFile(entry, compiled);
  const {tsImport} = await import("tsx/esm/api");
  return tsImport(pathToFileURL(entry).href, import.meta.url);
}

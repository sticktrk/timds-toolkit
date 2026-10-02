// Explicit, reviewable conversion of recognized visual snapshots to shared
// imports and typed partial overrides. No runtime, brand, media, publishing,
// or production code is inferred from a copied component's appearance.
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { defaultVideoComponentsTemplate } from "./video.mjs";
import { assertRuntimeCompatibility, runtimeIdentity, sharedRuntimeRequirements } from "./runtime.mjs";

// The TypeScript compiler is loaded on first use so that the CLI and the stdio
// MCP servers, which import this module through core, do not pay for it.
let compiler = null;
const typescript = async () => (compiler ??= (await import("typescript")).default);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const slots = {Video: "Video", Scene: "SceneView", Graphic: "GraphicBoard", Intro: "Intro", Outro: "Outro", Cover: "Cover", HorizontalCover: "HorizontalCover", VerticalCover: "VerticalCover"};
const boards = {"chapter-title": "ChapterTitleBoard", statement: "StatementBoard", cards: "CardsBoard", compare: "CompareBoard", flow: "FlowBoard", steps: "StepsBoard", document: "DocumentBoard", subscribe: "SubscribeBoard"};

export async function snapshotInventory(source) {
  const ts = await typescript();
  const printer = ts.createPrinter({removeComments: true});
  const file = ts.createSourceFile("remotion.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  if (file.parseDiagnostics.length) throw new Error("Component snapshot contains invalid TypeScript; review it before migration");
  const declarations = new Map(), imports = [], exports = [], unsupported = [], directExports = [], typeExports = [];
  for (const node of file.statements) {
    const printed = printer.printNode(ts.EmitHint.Unspecified, node, file);
    if (ts.isImportDeclaration(node)) { imports.push(printed); continue; }
    if (ts.isExportDeclaration(node) || ts.isExportAssignment(node)) { exports.push(printed); continue; }
    const names = ts.isVariableStatement(node) ? node.declarationList.declarations.map((entry) => entry.name)
      : node.name ? [node.name] : [];
    if (names.length !== 1 || !ts.isIdentifier(names[0])) { unsupported.push(printed); continue; }
    const name = names[0].text;
    if (node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      directExports.push(name);
      if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) typeExports.push(name);
    }
    const references = new Set();
    const visit = (child) => { if (ts.isIdentifier(child) && child.text !== name) references.add(child.text); ts.forEachChild(child, visit); };
    visit(node);
    if (declarations.has(name)) throw new Error(`Duplicate snapshot declaration ${name}; review it before migration`);
    declarations.set(name, {node, text: printed, hash: hash(printed), references});
  }
  return {declarations, imports, exports, unsupported, directExports, typeExports};
}

export async function snapshotBaseline(source) {
  const inventory = await snapshotInventory(source);
  return {declarations: Object.fromEntries([...inventory.declarations].map(([name, entry]) => [name, entry.hash])), imports: inventory.imports, exports: inventory.exports};
}

export async function planComponentMigration(source) {
  const current = await defaultVideoComponentsTemplate();
  const baselines = [await snapshotBaseline(current), ...Object.values(JSON.parse(await fs.readFile(new URL("../video/component-baselines.json", import.meta.url), "utf8")))];
  const inventory = await snapshotInventory(source);
  // Choose one known release, never a mixture that could hide incompatible copies.
  const score = (baseline) => [...inventory.declarations].filter(([name, entry]) => baseline.declarations[name] === entry.hash).length;
  const baseline = baselines.sort((a, b) => score(b) - score(a))[0];
  const review = [...inventory.unsupported];
  for (const name of ["overrides", "__timdsResolve", "__timdsShared"]) if (inventory.declarations.has(name)) review.push(`migration symbol collision ${name}`);
  if (JSON.stringify(inventory.imports) !== JSON.stringify(baseline.imports)) review.push("custom imports");
  if (JSON.stringify(inventory.exports) !== JSON.stringify(baseline.exports)) review.push("custom export surface");
  for (const name of ["defaultVideoProjectComponents", "defaultBoards"]) {
    if (inventory.declarations.get(name)?.hash !== baseline.declarations[name]) review.push(`custom ${name} registration`);
  }
  if (!score(baseline)) review.push("no recognized snapshot baseline");
  const changed = [...inventory.declarations].filter(([name, entry]) => baseline.declarations[name] !== entry.hash).map(([name]) => name);
  const closure = (name, seen = new Set()) => {
    if (seen.has(name) || !inventory.declarations.has(name)) return seen;
    seen.add(name);
    for (const dependency of inventory.declarations.get(name).references) closure(dependency, seen);
    return seen;
  };
  const custom = (name) => [...closure(name)].some((dependency) => changed.includes(dependency));
  const retainedSlots = Object.entries(slots).filter(([slot, name]) => ["Scene", "Video"].includes(slot) ? changed.includes(name) : custom(name));
  const retainedBoards = Object.entries(boards).filter(([, name]) => custom(name));
  const retained = new Set();
  for (const [, name] of [...retainedSlots, ...retainedBoards]) closure(name, retained);
  for (const name of changed) if (!retained.has(name)) review.push(`unclassified custom declaration ${name}`);
  // Retaining scene or video copies would keep ownership of composition logic.
  // A reviewed partial visual override can be authored manually in that case.
  for (const [slot] of retainedSlots) if (["Scene", "Video"].includes(slot)) review.push(`custom ${slot} needs a reviewed partial override`);
  for (const name of ["SceneView", "Video"]) if (retained.has(name)) review.push(`retained ${name} needs a reviewed partial override`);
  if (review.length) return {status: "review", changed, review: [...new Set(review)], retained: [...retained].sort()};
  if (!changed.length) return {status: "shared", changed, review: [], retained: [], source: 'export {defaultVideoProjectComponents as default} from "@dtconcepts/timds/video/remotion";\nexport * from "@dtconcepts/timds/video/remotion";\n'};
  const declarations = [...inventory.declarations].filter(([name]) => retained.has(name)).map(([, entry]) => entry.text);
  const exportedNames = inventory.exports.filter((text) => text.startsWith("export {")).flatMap((text) => text.slice(text.indexOf("{") + 1, text.indexOf("}")).split(",").map((name) => name.trim()).filter(Boolean));
  const allExports = [...new Set([...exportedNames, ...inventory.directExports])].filter((name) => name !== "defaultVideoProjectComponents");
  const sharedNames = allExports.filter((name) => !retained.has(name) && !inventory.typeExports.includes(name));
  const sharedTypes = allExports.filter((name) => !retained.has(name) && inventory.typeExports.includes(name));
  const customNames = exportedNames.filter((name) => retained.has(name));
  const overrideEntries = retainedSlots.map(([slot, name]) => `${slot}: ${name}`);
  // The snapshot registered HorizontalCover and VerticalCover explicitly, so a
  // custom Cover never reached those slots there. The resolver falls back to
  // Cover for both, so pin the shared ones to keep the snapshot's binding.
  const retainedSlotNames = new Set(retainedSlots.map(([slot]) => slot));
  if (retainedSlotNames.has("Cover")) {
    for (const slot of ["HorizontalCover", "VerticalCover"]) if (!retainedSlotNames.has(slot)) overrideEntries.push(`${slot}: __timdsShared.${slot}`);
  }
  const boardEntries = retainedBoards.map(([kind, name]) => `${JSON.stringify(kind)}: ${name}`);
  if (retainedSlots.some(([slot]) => slot === "Graphic")) boardEntries.unshift("...__timdsShared.Boards");
  if (boardEntries.length) overrideEntries.push(`Boards: {${boardEntries.join(", ")}}`);
  const sourceText = [
    "// Migrated visual overrides. Shared components follow the locked TimDS release.",
    ...inventory.imports,
    'import {resolveVideoProjectComponents as __timdsResolve, defaultVideoProjectComponents as __timdsShared} from "@dtconcepts/timds/video/remotion";',
    `export {${sharedNames.join(", ")}} from "@dtconcepts/timds/video/remotion";`,
    ...(sharedTypes.length ? [`export type {${sharedTypes.join(", ")}} from "@dtconcepts/timds/video/remotion";`] : []),
    ...declarations,
    ...(customNames.length ? [`export {${customNames.join(", ")}};`] : []),
    `const overrides = {${overrideEntries.join(", ")}} satisfies VideoProjectComponentOverrides;`,
    "export const defaultVideoProjectComponents = __timdsResolve(overrides);",
    "export default overrides;",
    "",
  ].join("\n");
  return {status: "overrides", changed, review: [], retained: [...retained].sort(), source: sourceText};
}

export async function migrateVideoComponents(workspace, {apply = false} = {}) {
  const manifest = JSON.parse(await fs.readFile(workspace.manifestPath, "utf8"));
  if (!manifest.video) throw new Error("Enable video before migrating components");
  const video = manifest.video === true ? {} : manifest.video;
  const relative = video.components;
  if (!relative) return {status: "shared", changed: [], review: [], retained: [], applied: false};
  if (path.isAbsolute(relative) || relative.split(/[\\/]/u).includes("..")) throw new Error("video.components must stay inside the Design System");
  const target = path.join(workspace.designSystemRoot, relative);
  const source = await fs.readFile(target, "utf8");
  if (source.startsWith("// Migrated visual overrides.") || source.startsWith('export {defaultVideoProjectComponents as default}')) return {status: "adopted", changed: [], review: [], retained: [], applied: false};
  const plan = await planComponentMigration(source);
  if (plan.status === "overrides" && !workspace.manifest.video.boards) {
    return {...plan, status: "review", review: ["Partial board migration requires an explicitly reviewed board catalog"], applied: false};
  }
  if (!apply || plan.status === "review") return {...plan, applied: false};
  const contractPath = path.join(workspace.designSystemRoot, workspace.manifest.video.contract);
  const contractSource = await fs.readFile(contractPath, "utf8");
  const contract = JSON.parse(contractSource);
  assertRuntimeCompatibility(contract.runtime);
  const backup = path.join(workspace.designSystemRoot, ".timds", "component-migration");
  await fs.mkdir(backup, {recursive: true});
  const originals = [["components.tsx", source], ["contract.json", contractSource], ["timds.json", await fs.readFile(workspace.manifestPath, "utf8")]];
  for (const [name, value] of originals) {
    const saved = await fs.readFile(path.join(backup, name), "utf8").catch((error) => {if (error.code === "ENOENT") return null; throw error;});
    if (saved !== null && saved !== value) throw new Error(`Existing component migration backup ${name} belongs to a different source; review and archive it before another consolidation`);
  }
  // Exclusive writes keep the original rollback bytes across repeated runs.
  for (const [name, value] of originals) {
    await fs.writeFile(path.join(backup, name), value, {flag: "wx"}).catch((error) => { if (error.code !== "EEXIST") throw error; });
  }
  const required = sharedRuntimeRequirements();
  contract.runtime = {...required, ...contract.runtime, features: [...new Set([...required.features, ...(contract.runtime?.features ?? [])])]};
  contract.schemaVersion = 2;
  if (plan.status === "overrides") contract.runtime.testedVersions = [runtimeIdentity.version];
  if (plan.status === "shared") delete contract.runtime.testedVersions;
  await fs.writeFile(target, plan.source);
  await fs.writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
  return {...plan, applied: true, backup, target};
}

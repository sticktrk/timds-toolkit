// End-to-end fixture verification. The registry and two synthetic releases are
// local to this process; nothing is published or installed in real client repos.
import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {createHash} from "node:crypto";
import {promises as fs} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import {bundle} from "@remotion/bundler";
import {openBrowser, renderStill} from "@remotion/renderer";
import {initializeRepository} from "../src/core.mjs";
import {planComponentMigration} from "../src/video-migration.mjs";

const execute = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "timds-shared-upgrades-"));
const artifacts = process.env.TIMDS_VISUAL_OUTPUT ? path.resolve(process.env.TIMDS_VISUAL_OUTPUT) : path.join(scratch, "visuals");
await fs.mkdir(artifacts, {recursive: true});
const command = async (cwd, executable, args) => {
  try { return await execute(executable, args, {cwd, maxBuffer: 20_000_000}); }
  catch (error) { throw new Error(`${executable} ${args.join(" ")} failed:\n${error.stdout}\n${error.stderr}`); }
};
const json = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const writeJson = async (file, value) => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
const digest = (value) => createHash("sha256").update(value).digest("hex");
let browser, registry;
try {
  const packed = JSON.parse((await command(packageRoot, "npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch])).stdout)[0];
  const releases = [];
  for (const [index, version] of ["0.1.900000", "0.1.900001"].entries()) {
    const directory = path.join(scratch, `release-${index}`);
    await fs.mkdir(directory);
    await command(directory, "tar", ["-xzf", path.join(scratch, packed.filename)]);
    const root = path.join(directory, "package"), pkg = await json(path.join(root, "package.json"));
    pkg.version = version;
    await writeJson(path.join(root, "package.json"), pkg);
    if (index === 1) {
      const layouts = path.join(root, "video", "board-layouts.mjs");
      await fs.writeFile(layouts, (await fs.readFile(layouts, "utf8")).replace("compact ? 82 : 74", "compact ? 82 : 78"));
    }
    const info = JSON.parse((await command(root, "npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory])).stdout)[0];
    const bytes = await fs.readFile(path.join(directory, info.filename));
    releases.push({pkg, bytes, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`});
  }
  let available = 1;
  registry = http.createServer((request, response) => {
    if (request.url.startsWith("/tar/")) {
      const selected = releases.find((release) => request.url.includes(release.pkg.version));
      if (!selected) {response.writeHead(404).end(); return;}
      response.writeHead(200, {"Content-Type": "application/octet-stream"}).end(selected.bytes); return;
    }
    const base = `http://127.0.0.1:${registry.address().port}`;
    const versions = Object.fromEntries(releases.slice(0, available).map((release) => [release.pkg.version, {...release.pkg, dist: {tarball: `${base}/tar/${release.pkg.version}.tgz`, integrity: release.integrity}}]));
    response.writeHead(200, {"Content-Type": "application/json"}).end(JSON.stringify({name: "@dtconcepts/timds", versions, "dist-tags": {latest: releases[available - 1].pkg.version}}));
  });
  await new Promise((resolve) => registry.listen(0, "127.0.0.1", resolve));
  browser = await openBrowser("chrome", {logLevel: "error"});
  const systems = [];
  for (const [id, colors, font] of [["north", {background: "#142238", panel: "#142238", accent: "#f4c75b", text: "#ffffff", muted: "#dae1ea"}, "Georgia, serif"], ["lake", {background: "#163e32", panel: "#163e32", accent: "#84e4c3", text: "#ffffff", muted: "#e1f1ec"}, "Arial, sans-serif"]]) {
    const root = path.join(scratch, id);
    await fs.mkdir(root);
    await command(root, "git", ["init", "-b", "main"]);
    await command(root, "git", ["config", "user.name", "TimDS Fixture"]);
    await command(root, "git", ["config", "user.email", "fixture@example.com"]);
    await initializeRepository(root, {standalone: true});
    await fs.writeFile(path.join(root, ".npmrc"), `@dtconcepts:registry=http://127.0.0.1:${registry.address().port}\n`);
    if (id === "lake") {
      const existing = await json(path.join(root, "package.json"));
      Object.assign(existing.devDependencies, {react:"18.3.1", "react-dom":"18.3.1", remotion:releases[0].pkg.dependencies.remotion});
      await writeJson(path.join(root, "package.json"), existing);
    }
    await command(root, "npm", ["install", "--no-audit", "--no-fund"]);
    // The scaffold is committed the way init asks for, since the starter sync
    // inside upgrade refuses to run over uncommitted starter files.
    await command(root, "git", ["add", "--all"]);
    await command(root, "git", ["commit", "-q", "-m", "Scaffold the fixture"]);
    await command(root, "npm", ["run", "timds", "--", "upgrade", "--force"]);
    if (id === "lake") {
      await command(root, "git", ["add", "--all"]);
      await command(root, "git", ["commit", "-m", "Existing runtime declarations"]);
      await command(root, "npm", ["run", "timds", "--", "upgrade", "--version", releases[0].pkg.version, "--own-runtime"]);
      const adopted = await json(path.join(root, "package.json"));
      assert.equal(adopted.devDependencies.react, releases[0].pkg.dependencies.react);
      assert.equal((await json(path.join(root, ".timds", "installation.json"))).runtimeDependencyOwnership, "timds-v1");
    }
    await command(root, "npm", ["run", "timds", "--", "video", "init"]);
    const contractPath = path.join(root, "video", "contract.json"), contract = await json(contractPath);
    contract.name = `${id} fixture`; contract.brand.colors = colors; contract.brand.fonts.display = font;
    contract.structure.longform.graphicScenes = true; contract.structure.short.graphicScenes = true;
    await writeJson(contractPath, contract);
    const catalogPath = path.join(root, "video", "boards.json"), catalog = await json(catalogPath);
    catalog.formats.short = true;
    await writeJson(catalogPath, catalog);
    await fs.writeFile(path.join(root, "producer-check.mjs"), `import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createVideoProducer} from "@dtconcepts/timds/video/producer";
import {validateVideoContract} from "@dtconcepts/timds/video";
const contract = validateVideoContract(JSON.parse(readFileSync("video/contract.json")));
const boards = JSON.parse(readFileSync("video/boards.json"));
const assets = {"cover-subject-concern":{mediaKey:"cover-subject-concern",kind:"image"}};
const media = [{key:"cover-subject-concern",filename:"cover.jpg",contentType:"image/jpeg",publicUrl:"https://example.com/cover.jpg"}];
for (const name of ["one","two","three"]) {
 const key = "footage-"+name, vertical = key+"-vertical";
 assets[key] = {mediaKey:key,durationSeconds:6,text:"left-center",vertical};
 assets[vertical] = {mediaKey:vertical,durationSeconds:6,text:"upper-middle"};
 for (const item of [key,vertical]) media.push({key:item,filename:item+".mp4",contentType:"video/mp4",publicUrl:"https://example.com/"+item+".mp4",durationSeconds:6});
}
const producer = createVideoProducer({contract,boards,assetCatalog:{assets},mediaCatalog:{assets:media}});
for (const outputFormat of ["horizontal","short"]) {
 const input = {schemaVersion:1,slug:"fixture",outputFormat,exactQuestion:"Should I keep these records?",topic:{label:"important records",engagementQuestion:"Are you keeping these records?"},answerBeats:[
 {id:"records",role:"rule",summary:"Keep every record",narration:"Keep every record together.",footage:["footage-one"],visual:{kind:"cards",items:[{label:"Start here"},{label:"Keep moving"},{label:"Finish well"}]}},
 {id:"copies",role:"process",summary:"Preserve every page",narration:"Preserve every page.",visual:{kind:"statement",text:"Preserve every page."}},
 {id:"answer",role:"answer",summary:"Review the result",narration:"Review the result."}]};
 const compiled = producer.compileProduction(input);
 const timings = compiled.scenes.map(scene => ({id:scene.id,durationMs:3000,words:[{text:"Keep",startMs:0,endMs:500}]}));
 const result = producer.finalizeProduction({schemaVersion:1,compiled,timings,audioSrc:null});
 assert.ok(result.plan.scenes.length); assert.equal(result.runtime.version,compiled.runtime.version);
 assert.throws(() => producer.compileProduction({...input,answerBeats:[{...input.answerBeats[0],visual:{kind:"cards",items:Array.from({length:4},()=>({label:"Too many"}))}}]}),/at most 3 items/);
}
console.log("Producer compile/finalize and early layout rejection passed in both formats");
`);
    const clientPackage = await json(path.join(root, "package.json"));
    clientPackage.scripts["check:timds-upgrade"] = "node producer-check.mjs";
    await writeJson(path.join(root, "package.json"), clientPackage);
    // Scripts do not affect the resolved dependency graph.
    await command(root, "npm", ["run", "check:timds-upgrade"]);
    await command(root, "npm", ["run", "timds", "--", "video", "components", "init"]);
    await fs.copyFile(path.join(root, "video", "remotion.tsx"), path.join(root, "video", "before.tsx"));
    const customSource = (await fs.readFile(path.join(root, "video", "before.tsx"), "utf8")).replace("const badge = vertical ? 76 : 72;", "const badge = vertical ? 74 : 70;");
    const customPlan = await planComponentMigration(customSource);
    assert.equal(customPlan.status, "overrides");
    await fs.writeFile(path.join(root, "video", "before-custom.tsx"), customSource);
    await fs.writeFile(path.join(root, "video", "after-custom.tsx"), customPlan.source);
    await command(root, "npm", ["run", "timds", "--", "video", "components", "migrate", "--apply"]);
    await command(root, "npm", ["run", "timds", "--", "video", "components", "migrate", "--apply"]);
    const renderEntry = `import React from "react";
import {AbsoluteFill, Composition, registerRoot} from "remotion";
import before from "./video/before.tsx";
import after from "./video/remotion.tsx";
import beforeCustom from "./video/before-custom.tsx";
import afterCustom from "./video/after-custom.tsx";
import contract from "./video/contract.json";
import boards from "./video/boards.json";
const visual = {kind:"cards", title:"A clear plan", items:[{label:"Start here", note:"Choose one step"},{label:"Keep moving", note:"Review the result"},{label:"Finish well", note:"Record the outcome"}]};
const Board = ({stage, vertical, overFootage}) => {
 const custom = stage.endsWith("Custom");
 const components = {before,after,beforeCustom,afterCustom}[stage];
 const C = components.Boards[custom ? "steps" : "cards"];
 const data = custom ? {kind:"steps",title:visual.title,steps:visual.items} : visual;
 const project = {contract:{...contract, boards}, assets:{}, records:{captions:{lines:[]}, production:{}, publishing:{}, request:{}, script:{}}};
 return <AbsoluteFill style={{background:"linear-gradient(35deg,#8b5541,#83a0ac)"}}><C project={project} scene={{id:"test",eyebrow:"A useful guide"}} visual={data} line={{id:"test",words:[],durationMs:5000}} duration={150} lead={0} vertical={vertical} overFootage={overFootage}/></AbsoluteFill>;
};
registerRoot(() => <>{[false,true].flatMap(vertical => [false,true].flatMap(overFootage => ["before","after","beforeCustom","afterCustom"].map(stage => <Composition key={stage+vertical+overFootage} id={stage+(vertical?"Vertical":"Horizontal")+(overFootage?"Footage":"Full")} component={Board} defaultProps={{stage,vertical,overFootage}} durationInFrames={150} fps={30} width={vertical?1080:1920} height={vertical?1920:1080}/>)))}</>);
`;
    await fs.writeFile(path.join(root, "visual.tsx"), renderEntry);
    const render = async (label) => {
      const serveUrl = await bundle({entryPoint: path.join(root, "visual.tsx"), rootDir: root, publicDir: null, enableCaching: false});
      const results = {};
      for (const vertical of [false, true]) for (const footage of [false, true]) for (const stage of label === "upgrade" ? ["after"] : ["before", "after", "beforeCustom", "afterCustom"]) {
        const name = `${stage}${vertical ? "Vertical" : "Horizontal"}${footage ? "Footage" : "Full"}`;
        const output = path.join(artifacts, `${id}-${label}-${name}.png`);
        await renderStill({serveUrl, composition:{id:name,width:vertical?1080:1920,height:vertical?1920:1080,fps:30,durationInFrames:150,defaultProps:{stage,vertical,overFootage:footage},props:{stage,vertical,overFootage:footage}}, frame:140, output, imageFormat:"png", puppeteerInstance:browser, logLevel:"error"});
        results[name] = digest(await fs.readFile(output));
      }
      return results;
    };
    const migrated = await render("migration");
    for (const format of ["Horizontal", "Vertical"]) for (const context of ["Full", "Footage"]) assert.equal(migrated[`before${format}${context}`], migrated[`after${format}${context}`], `${id} ${format} ${context} migration preserves pixels`);
    for (const format of ["Horizontal", "Vertical"]) for (const context of ["Full", "Footage"]) assert.equal(migrated[`beforeCustom${format}${context}`], migrated[`afterCustom${format}${context}`], `${id} ${format} ${context} custom migration preserves pixels`);
    await command(root, "npm", ["run", "timds", "--", "check"]);
    await command(root, "npm", ["run", "timds", "--", "dependencies", "check"]);
    await command(root, "git", ["add", "--all"]);
    await command(root, "git", ["commit", "-m", "Adopt shared components"]);
    systems.push({id, root, render, migrated, authored: digest(await fs.readFile(path.join(root, "video", "remotion.tsx")))});
    console.log(`${id}: build, producer validation, dependency graph, and eight migration visual comparisons passed`);
  }
  assert.notEqual(systems[0].migrated.afterHorizontalFull, systems[1].migrated.afterHorizontalFull, "the brands produce different visuals with the same shared boards");
  available = 2;
  for (const system of systems) {
    await command(system.root, "npm", ["run", "timds", "--", "upgrade", "--version", releases[1].pkg.version]);
    const upgraded = await system.render("upgrade");
    for (const format of ["Horizontal", "Vertical"]) {
      assert.notEqual(upgraded[`after${format}Footage`], system.migrated[`after${format}Footage`], "the package fix reaches the board over footage");
      assert.equal(upgraded[`after${format}Full`], system.migrated[`after${format}Full`], "the targeted fix preserves full-frame visuals");
    }
    assert.equal(digest(await fs.readFile(path.join(system.root, "video", "remotion.tsx"))), system.authored, "dependency upgrade does not edit authored components");
    console.log(`${system.id}: exact dependency upgrade, graph, build, producer, and render checks passed without component edits`);
  }
  console.log(`Shared upgrade fixtures passed. ${process.env.TIMDS_VISUAL_OUTPUT ? `Visuals: ${artifacts}` : "Set TIMDS_VISUAL_OUTPUT to retain PNGs."}`);
} finally {
  if (browser) await browser.close({silent:true});
  if (registry) await new Promise((resolve) => registry.close(resolve));
  await fs.rm(scratch, {recursive:true, force:true});
}

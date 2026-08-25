import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkVideoWorkspace,
  initializeVideoComponents,
  normalizeVideoManifest,
  prepareVideoWorkspace,
  validateVideoContract,
} from "./video.mjs";
import { createVideoAuthoringContract, createVideoProducer } from "./video-producer.mjs";

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function videoFixture(t, overrides = {}) {
  const designSystemRoot = await fs.mkdtemp(path.join(os.tmpdir(), "timds-video-"));
  t.after(() => fs.rm(designSystemRoot, { force: true, recursive: true }));
  const manifest = {
    schemaVersion: 2,
    systemId: "example/core",
    name: "Example",
    version: "1.2.3",
    video: normalizeVideoManifest(true),
  };
  const workspace = {
    designSystemRoot,
    manifest,
    manifestPath: path.join(designSystemRoot, "timds.json"),
    repoRoot: designSystemRoot,
  };
  const contract = {
    schemaVersion: 1,
    id: "example-video",
    name: "Example video",
    fps: 30,
    formats: {
      longform: { width: 1920, height: 1080 },
      cover: { width: 3840, height: 2160 },
      short: { width: 1080, height: 1920 },
    },
    package: { shortCount: 1, timeZone: "UTC" },
    structure: {
      longform: { requireIntro: true, requireOutro: true },
      short: { requireIntro: false, requireOutro: false },
    },
    copy: { coverMustBeQuestion: true },
    brand: {
      colors: { background: "#000", accent: "#fc0", text: "#fff" },
      fonts: { display: "serif", body: "serif", ui: "sans-serif" },
      fontFiles: [{ family: "Example Serif", path: "public/example.woff2", style: "normal", weight: "700" }],
      logo: "public/logo.svg",
      series: "Answers",
      site: "example.com",
      tagline: "Clear answers.",
    },
  };
  const production = {
    schemaVersion: 1,
    slug: "sample-topic",
    longform: {
      cover: { headline: "What should I know?", asset: "cover" },
      scenes: [
        { id: "intro", intro: true },
        { id: "answer", headline: "A clear answer", asset: "footage" },
        { id: "outro", outro: true },
      ],
    },
    shorts: [{
      id: "sample-short",
      subtopic: "Sample",
      harvest: ["answer"],
      cover: { headline: "What is the answer?", asset: "cover" },
      scenes: [{ id: "answer", headline: "A clear answer", asset: "footage" }],
    }],
  };
  Object.assign(contract, overrides.contract);
  Object.assign(production, overrides.production);
  await writeJson(workspace.manifestPath, manifest);
  await writeJson(path.join(designSystemRoot, "video", "contract.json"), contract);
  await writeJson(path.join(designSystemRoot, "video", "assets.json"), {
    schemaVersion: 1,
    assets: {
      cover: { publicPath: "public/cover.jpg" },
      footage: { publicPath: "public/footage.mp4", durationSeconds: 20 },
    },
  });
  await writeJson(path.join(designSystemRoot, "video", "productions", "sample-topic", "request.json"), { source: "fixture" });
  await writeJson(path.join(designSystemRoot, "video", "productions", "sample-topic", "script.json"), { slug: "sample-topic", lines: [] });
  await writeJson(path.join(designSystemRoot, "video", "productions", "sample-topic", "publishing.json"), {
    topicName: "Sample topic",
    articleUrl: "https://example.com/sample",
    question: "What should I know?",
    answer: "A clear answer.",
    shorts: [{ id: "sample-short", question: "What is the answer?", answer: "A clear answer." }],
  });
  await writeJson(path.join(designSystemRoot, "video", "productions", "sample-topic", "captions.json"), {
    lines: ["intro", "answer", "outro"].map((id) => ({
      id,
      durationMs: 1000,
      words: [{ text: id, startMs: 0, endMs: 650 }],
    })),
  });
  await writeJson(path.join(designSystemRoot, "video", "productions", "sample-topic", "production.json"), production);
  await fs.mkdir(path.join(designSystemRoot, "public"), { recursive: true });
  await fs.writeFile(path.join(designSystemRoot, "public", "logo.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
  await fs.writeFile(path.join(designSystemRoot, "public", "example.woff2"), Buffer.from([0x77, 0x4f, 0x46, 0x32]));
  await fs.writeFile(path.join(designSystemRoot, "public", "cover.jpg"), "cover");
  await fs.writeFile(path.join(designSystemRoot, "public", "footage.mp4"), "footage");
  return workspace;
}

test("normalizes the optional video manifest", () => {
  assert.equal(normalizeVideoManifest(false), null);
  assert.deepEqual(normalizeVideoManifest(true), {
    contract: "video/contract.json",
    assets: "video/assets.json",
    productions: "video/productions",
    local: "video-local",
    components: null,
  });
  assert.equal(normalizeVideoManifest({ components: "video/remotion.tsx" }).components, "video/remotion.tsx");
  assert.throws(() => normalizeVideoManifest({ components: "../outside.tsx" }), /must stay inside the Design System/);
});

test("copies the installed default components into client-owned source exactly once", async (t) => {
  const workspace = await videoFixture(t);
  const result = await initializeVideoComponents(workspace);
  const generated = await fs.readFile(result.components, "utf8");
  const manifest = JSON.parse(await fs.readFile(workspace.manifestPath, "utf8"));
  const defaults = await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "video", "remotion.tsx"), "utf8");
  const start = defaults.indexOf("// TIMDS_DEFAULT_COMPONENTS_START");
  const endMarker = "// TIMDS_DEFAULT_COMPONENTS_END";
  const snapshot = defaults.slice(start, defaults.indexOf(endMarker) + endMarker.length);

  assert.equal(result.relativePath, "video/remotion.tsx");
  assert.equal(manifest.video.components, "video/remotion.tsx");
  assert.match(generated, /This file is now owned by this Design System/u);
  assert.match(generated, /tieOrphan = \(value: string\)/u);
  assert.match(generated, /useVideoConfig/u);
  assert.match(generated, /horizontalCoverScale/u);
  assert.ok(generated.includes(snapshot));
  assert.match(generated, /export default defaultVideoProjectComponents/u);
  await assert.rejects(initializeVideoComponents(workspace), /already exist/u);

  await fs.appendFile(result.components, "\n// client change\n", "utf8");
  await initializeVideoComponents(workspace, { force: true });
  assert.doesNotMatch(await fs.readFile(result.components, "utf8"), /client change/u);
});

test("keeps structure policy in the client video contract", () => {
  const contract = validateVideoContract({
    schemaVersion: 1,
    id: "client-video",
    name: "Client",
    package: { shortCount: 0 },
    structure: { longform: { requireIntro: true } },
    brand: {
      colors: { background: "#000", accent: "#fc0", text: "#fff" },
      fonts: {},
      logo: "public/logo.svg",
      series: "Series",
      site: "example.com",
      tagline: "Tagline",
    },
  });
  assert.equal(contract.structure.longform.requireIntro, true);
  assert.equal(contract.structure.longform.requireOutro, false);
  assert.equal(contract.structure.short.requireIntro, false);
});

test("compiles programmatic productions with client-owned producer copy and assets", () => {
  const contract = validateVideoContract({
    schemaVersion: 1,
    id: "example-video",
    name: "Example video",
    package: { shortCount: 0 },
    copy: {},
    brand: {
      colors: { background: "#000", accent: "#fc0", text: "#fff" },
      fonts: {},
      logo: "public/logo.svg",
      series: "Example Answers",
      site: "example.com",
      tagline: "Clear answers",
    },
    producer: {
      schemaVersion: 1,
      authoring: {
        sharedPromptBlocks: ["brand/voice#plain-language"],
        formatPromptBlocks: { short: ["social/shorts#writing"] },
      },
      roleEyebrows: { hook: "In brief", rule: "The rule", risk: "The risk", process: "Next step", exception: "The exception", answer: "The answer" },
      intro: { enabled: true, id: "intro" },
      engagement: { formats: ["horizontal"], id: "engage", eyebrow: "Your turn", narrationTemplate: "{{question}} Tell us below.", requireYesNoQuestion: true },
      outro: { id: "outro", narrationTemplate: "Learn more about {{topic}} from {{series}} at {{site}}." },
      cover: { assetPrefix: "cover-subject-", defaultEmotion: "concern" },
      footage: { assetPrefix: "footage-" },
    },
  });
  const assetCatalog = { assets: {
    "cover-subject-concern": { mediaKey: "cover-subject-concern" },
    "footage-one": { mediaKey: "footage-one", durationSeconds: 5, subject: "right", flip: false, text: "left-center", vertical: "footage-one-vertical" },
    "footage-one-vertical": { mediaKey: "footage-one-vertical", durationSeconds: 5, text: "lower" },
    "footage-two": { mediaKey: "footage-two", durationSeconds: 5, subject: "right", flip: false, text: "left-center", vertical: "footage-two-vertical" },
    "footage-two-vertical": { mediaKey: "footage-two-vertical", durationSeconds: 5, text: "lower" },
  } };
  const mediaCatalog = { assets: Object.keys(assetCatalog.assets).map((key) => ({
    key,
    filename: `${key}.${key.startsWith("cover-") ? "jpg" : "mp4"}`,
    publicUrl: `https://example.com/${key}`,
    contentType: key.startsWith("cover-") ? "image/jpeg" : "video/mp4",
    durationSeconds: assetCatalog.assets[key].durationSeconds,
  })) };
  const producer = createVideoProducer({ contract, assetCatalog, mediaCatalog });
  const compiled = producer.compileProduction({
    schemaVersion: 1,
    slug: "sample-answer",
    outputFormat: "horizontal",
    exactQuestion: "Should I keep these records?",
    topic: { label: "important records", engagementQuestion: "Are you keeping these records?", coverEmotion: "concern" },
    answerBeats: [{ id: "records", role: "rule", narration: "Keep the records together and preserve every page.", summary: "Keep every record together" }],
  });
  assert.throws(() => producer.compileProduction({
    schemaVersion: 1,
    slug: "sample-answer-too-long",
    outputFormat: "horizontal",
    exactQuestion: "Should I keep these records?",
    topic: { label: "important records", engagementQuestion: "Are you keeping these records?", coverEmotion: "concern" },
    answerBeats: [{ id: "records", role: "rule", narration: "Keep the records together and preserve every page.", summary: "Keep every important estate record together in one protected account" }],
  }), /summary exceeds 8 words/u);
  assert.match(compiled.scenes.at(-1).narration, /Example Answers at example\.com/u);
  const finalized = producer.finalizeProduction({
    schemaVersion: 1,
    compiled,
    timings: compiled.scenes.map((scene) => ({ id: scene.id, durationMs: scene.id === "records" ? 8_000 : 1_000, words: [{ text: scene.id, startMs: 0, endMs: 700 }] })),
    audioSrc: "audio.mp3",
  });
  assert.equal(finalized.coverSubject.key, "cover-subject-concern");
  assert.deepEqual(finalized.plan.scenes.find((scene) => scene.id === "records").assets, ["footage-one", "footage-two"]);

  const authoring = createVideoAuthoringContract({
    contract,
    manifest: { systemId: "example/core", name: "Example Design System", version: "2.3.4" },
    designSystemIndex: {
      schemaVersion: 1,
      system: { id: "example/core", name: "Example Design System", version: "2.3.4" },
      pages: [
        { id: "brand/voice", blocks: [{ id: "brand/voice#plain-language", title: "Plain language", notes: [{ id: "direct", text: "Lead with the answer." }] }] },
        { id: "social/shorts", blocks: [{ id: "social/shorts#writing", title: "Short writing", prose: [{ id: "fast", text: "Make the first beat immediate." }] }] },
      ],
    },
    provenance: { version: "2.3.4", commit: "a".repeat(40), indexUrl: "https://example.com/artifact/design-system/index.json" },
    outputFormat: "short",
  });
  assert.equal(authoring.constraints.headlineWords, contract.copy.shortHeadlineWords);
  assert.equal(authoring.constraints.engagementQuestion.required, false);
  assert.equal(authoring.constraints.engagementQuestion.maximumWords, contract.copy.shortHeadlineWords);
  assert.deepEqual(authoring.prompt.blockIds, ["brand/voice#plain-language", "social/shorts#writing"]);
  assert.match(authoring.prompt.brief, /Lead with the answer/u);
  assert.match(authoring.prompt.brief, /Make the first beat immediate/u);
  assert.equal(authoring.inputSchema.properties.outputFormat.const, "short");
  assert.equal(authoring.inputSchema.properties.topic.properties.label.pattern, "^\\S+(?:\\s+\\S+){1,3}$");
  assert.deepEqual(authoring.inputSchema.properties.exactQuestion.allOf, [
    { pattern: `^\\S+(?:\\s+\\S+){0,${contract.copy.coverHeadlineWords - 1}}$` },
    { pattern: "\\?$" },
  ]);
  const horizontalAuthoring = createVideoAuthoringContract({
    contract,
    manifest: { systemId: "example/core", name: "Example Design System", version: "2.3.4" },
    designSystemIndex: {
      schemaVersion: 1,
      system: { id: "example/core", name: "Example Design System", version: "2.3.4" },
      pages: [
        { id: "brand/voice", blocks: [{ id: "brand/voice#plain-language", title: "Plain language", notes: [{ id: "direct", text: "Lead with the answer." }] }] },
      ],
    },
    provenance: { version: "2.3.4", commit: "a".repeat(40) },
    outputFormat: "horizontal",
  });
  assert.deepEqual(horizontalAuthoring.inputSchema.properties.topic.properties.engagementQuestion.allOf, [
    { pattern: `^\\S+(?:\\s+\\S+){0,${contract.copy.horizontalHeadlineWords - 1}}$` },
    { pattern: "\\?$" },
    { pattern: "^(?:[Aa][Rr][Ee]|[Cc][Aa][Nn]|[Cc][Oo][Uu][Ll][Dd]|[Dd][Ii][Dd]|[Dd][Oo]|[Dd][Oo][Ee][Ss]|[Hh][Aa][Ss]|[Hh][Aa][Vv][Ee]|[Ii][Ss]|[Ss][Hh][Oo][Uu][Ll][Dd]|[Ww][Aa][Ss]|[Ww][Ee][Rr][Ee]|[Ww][Ii][Ll][Ll]|[Ww][Oo][Uu][Ll][Dd])\\b" },
  ]);
  assert.match("Are you keeping these records?", new RegExp(horizontalAuthoring.inputSchema.properties.topic.properties.engagementQuestion.allOf[2].pattern, "u"));
  assert.equal(authoring.designSystem.commit, "a".repeat(40));
});

test("rejects stale or incomplete published authoring context", () => {
  const contract = validateVideoContract({
    schemaVersion: 1,
    id: "example-video",
    name: "Example video",
    package: { shortCount: 0 },
    copy: {},
    brand: {
      colors: { background: "#000", accent: "#fc0", text: "#fff" },
      fonts: {},
      logo: "public/logo.svg",
      series: "Example Answers",
      site: "example.com",
      tagline: "Clear answers",
    },
    producer: {
      schemaVersion: 1,
      authoring: { sharedPromptBlocks: ["brand/voice#plain-language"] },
      roleEyebrows: { hook: "In brief", rule: "The rule", risk: "The risk", process: "Next step", exception: "The exception", answer: "The answer" },
      engagement: { enabled: false, eyebrow: "Your turn", narrationTemplate: "{{question}}" },
      outro: { narrationTemplate: "Learn about {{topic}} at {{site}}." },
    },
  });
  const input = {
    contract,
    manifest: { systemId: "example/core", name: "Example Design System", version: "2.3.4" },
    provenance: { commit: "b".repeat(40) },
    outputFormat: "horizontal",
  };
  assert.throws(
    () => createVideoAuthoringContract({ ...input, designSystemIndex: { system: { id: "example/core", version: "2.3.3" }, pages: [] } }),
    /does not match pinned 2\.3\.4/u,
  );
  assert.throws(
    () => createVideoAuthoringContract({ ...input, designSystemIndex: { system: { id: "example/core", version: "2.3.4" }, pages: [] } }),
    /authoring block brand\/voice#plain-language is missing/u,
  );
});

test("validates and prepares a client-owned production with TimDS provenance", async (t) => {
  const workspace = await videoFixture(t);
  const checked = await checkVideoWorkspace(workspace, { slug: "sample-topic" });
  assert.equal(checked.productionCount, 1);
  assert.deepEqual(checked.video.productions[0].usedAssets.sort(), ["cover", "footage"]);
  const prepared = await prepareVideoWorkspace(workspace, "sample-topic");
  assert.equal(prepared.project.engine.name, "@dtconcepts/timds");
  assert.equal(prepared.project.records.production.slug, "sample-topic");
  assert.equal(prepared.project.contract.brand.fontFiles[0].path, "example.woff2");
  assert.equal(prepared.project.contract.brand.fontFiles[0].format, "woff2");
  assert.equal(prepared.project.contract.brand.fontFiles[0].dataBase64, "d09GMg==");
  assert.equal(path.extname(prepared.entryPath), ".mjs");
  await fs.access(path.join(prepared.publicRoot, "media", "footage.mp4"));
  const entry = await fs.readFile(prepared.entryPath, "utf8");
  assert.match(entry, /@dtconcepts\/timds\/video\/remotion/);
  assert.match(entry, /const videoProjectComponents = \{\}/);
  assert.match(entry, /registerRoot\(createVideoProjectRoot\(project, videoProjectComponents\)\)/);
});

test("imports a Design System Remotion component override into generated entries", async (t) => {
  const workspace = await videoFixture(t);
  workspace.manifest.video = normalizeVideoManifest({ components: "video/remotion.tsx" });
  await fs.writeFile(path.join(workspace.designSystemRoot, "video", "remotion.tsx"), "export default {};\n", "utf8");

  const prepared = await prepareVideoWorkspace(workspace, "sample-topic");
  const entry = await fs.readFile(prepared.entryPath, "utf8");

  assert.equal(prepared.video.componentsPath, path.join(workspace.designSystemRoot, "video", "remotion.tsx"));
  assert.match(entry, /import videoProjectComponents from "\.\.\/\.\.\/video\/remotion\.tsx"/);
  assert.match(entry, /createVideoProjectRoot\(project, videoProjectComponents\)/);
});

test("rejects footage chains that cannot cover narration at natural 1x speed", async (t) => {
  const workspace = await videoFixture(t);
  const assetsPath = path.join(workspace.designSystemRoot, "video", "assets.json");
  const catalog = JSON.parse(await fs.readFile(assetsPath, "utf8"));
  catalog.assets.footage.durationSeconds = 0.5;
  await writeJson(assetsPath, catalog);
  await assert.rejects(checkVideoWorkspace(workspace, { slug: "sample-topic" }), /natural-speed footage chain provides only 0\.50s/);
});

test("enforces the selected client structure and package count", async (t) => {
  const missingIntro = await videoFixture(t, {
    production: {
      longform: {
        cover: { headline: "What should I know?", asset: "cover" },
        scenes: [
          { id: "answer", headline: "A clear answer", asset: "footage" },
          { id: "outro", outro: true },
        ],
      },
    },
  });
  await assert.rejects(checkVideoWorkspace(missingIntro, { slug: "sample-topic" }), /must begin with intro/);
});

test("never chains footage from one family back to back, within or across scenes", () => {
  const contract = validateVideoContract({
    schemaVersion: 1,
    id: "example-video",
    name: "Example video",
    package: { shortCount: 0 },
    copy: {},
    brand: {
      colors: { background: "#000", accent: "#fc0", text: "#fff" },
      fonts: {},
      logo: "public/logo.svg",
      series: "Example Answers",
      site: "example.com",
      tagline: "Clear answers",
    },
    producer: {
      schemaVersion: 1,
      authoring: { sharedPromptBlocks: [], formatPromptBlocks: {} },
      roleEyebrows: { hook: "In brief", rule: "The rule", risk: "The risk", process: "Next step", exception: "The exception", answer: "The answer" },
      intro: { enabled: false },
      engagement: { enabled: false, eyebrow: "Your turn", narrationTemplate: "{{question}} Tell us below." },
      outro: { enabled: false, narrationTemplate: "Learn more about {{topic}} at {{site}}." },
      cover: { assetPrefix: "cover-subject-" },
      footage: { assetPrefix: "footage-" },
    },
  });
  const assetCatalog = { assets: {
    "cover-subject-concern": { mediaKey: "cover-subject-concern" },
    "footage-one": { mediaKey: "footage-one", durationSeconds: 5, subject: "right", flip: false, text: "left-center" },
    "footage-one-mirrored": { mediaKey: "footage-one-mirrored", durationSeconds: 5, subject: "right", flip: false, text: "left-center" },
    "footage-two": { mediaKey: "footage-two", durationSeconds: 5, subject: "right", flip: false, text: "left-center" },
  } };
  const mediaCatalog = { assets: Object.keys(assetCatalog.assets).map((key) => ({
    key,
    filename: `${key}.${key.startsWith("cover-") ? "jpg" : "mp4"}`,
    publicUrl: `https://example.com/${key}`,
    contentType: key.startsWith("cover-") ? "image/jpeg" : "video/mp4",
    durationSeconds: assetCatalog.assets[key].durationSeconds,
  })) };
  const producer = createVideoProducer({ contract, assetCatalog, mediaCatalog });
  const compiled = producer.compileProduction({
    schemaVersion: 1,
    slug: "sample-answer",
    outputFormat: "horizontal",
    exactQuestion: "Should I keep these records?",
    topic: { label: "important records", coverEmotion: "concern" },
    answerBeats: [
      { id: "first", role: "rule", narration: "Keep the records together.", summary: "Keep records together" },
      { id: "second", role: "answer", narration: "Keep the records together.", summary: "Keep records together" },
      { id: "third", role: "process", narration: "Keep the records together.", summary: "Keep records together" },
    ],
  });
  const finalized = producer.finalizeProduction({
    schemaVersion: 1,
    compiled,
    timings: compiled.scenes.map((scene) => ({ id: scene.id, durationMs: scene.id === "first" ? 8_000 : 4_000, words: [{ text: scene.id, startMs: 0, endMs: 700 }] })),
    audioSrc: "audio.mp3",
  });
  // Within the first scene, footage-one-mirrored ranks directly after
  // footage-one but is the same footage; the chain must jump to footage-two.
  assert.deepEqual(finalized.plan.scenes.find((scene) => scene.id === "first").assets, ["footage-one", "footage-two"]);
  // The first scene ended on footage-two, so the second reopens on footage-one.
  assert.equal(finalized.plan.scenes.find((scene) => scene.id === "second").asset, "footage-one");
  // The third scene ranks footage-one and its mirrored sibling first, but the
  // second scene just played that family; the cut must land on footage-two.
  assert.equal(finalized.plan.scenes.find((scene) => scene.id === "third").asset, "footage-two");
});

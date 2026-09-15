import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkVideoWorkspace,
  descriptionFor,
  initializeVideoComponents,
  initializeVideoWorkspace,
  normalizeVideoManifest,
  planVideoLab,
  prepareVideoLab,
  prepareVideoWorkspace,
  runVideoLab,
  silentSceneTimings,
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
    lab: "video/lab",
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
  assert.match(generated, /from "@dtconcepts\/timds\/video\/footage"/u);
  assert.match(generated, /chainClipFrames\(availableFrames, duration/u);
  assert.match(generated, /asset\.kind === "image"/u);
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

test("video init scaffolds the lab beside the contract, with a producer block that validates", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "timds-video-init-"));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  const manifestPath = path.join(root, "timds.json");
  await writeJson(manifestPath, { schemaVersion: 2, systemId: "example/core", name: "Example", version: "1.0.0" });
  const result = await initializeVideoWorkspace({ designSystemRoot: root, repoRoot: root, manifestPath, manifest: {} });

  assert.equal(result.lab, path.join(root, "video", "lab"));
  await fs.access(path.join(root, "video", "lab", "README.md"));
  const sample = JSON.parse(await fs.readFile(path.join(root, "video", "lab", "sample-answer.json"), "utf8"));
  assert.equal(sample.outputFormat, "horizontal");
  const contract = validateVideoContract(JSON.parse(await fs.readFile(result.contract, "utf8")));
  assert.equal(contract.producer.footage.assetPrefix, "footage-");
  assert.equal(contract.producer.cover.assetPrefix, "cover-subject-");
  assert.deepEqual(Object.keys(contract.producer.roleEyebrows).sort(), ["answer", "exception", "hook", "process", "risk", "rule"]);
});

test("rejects back-to-back footage from one family inside a committed production", async (t) => {
  const workspace = await videoFixture(t, {
    production: {
      longform: {
        cover: { headline: "What should I know?", asset: "cover" },
        scenes: [
          { id: "intro", intro: true },
          { id: "answer", headline: "A clear answer", assets: ["footage", "footage-mirrored"] },
          { id: "outro", outro: true },
        ],
      },
    },
  });
  const assetsPath = path.join(workspace.designSystemRoot, "video", "assets.json");
  const catalog = JSON.parse(await fs.readFile(assetsPath, "utf8"));
  catalog.assets["footage-mirrored"] = { publicPath: "public/footage.mp4", durationSeconds: 20 };
  await writeJson(assetsPath, catalog);
  await assert.rejects(checkVideoWorkspace(workspace, { slug: "sample-topic" }), /plays footage \(scene answer\) directly into footage-mirrored \(scene answer\); back-to-back footage from one family/u);
});

test("rejects a committed headline that ends on a dangling word", async (t) => {
  const workspace = await videoFixture(t, {
    production: {
      longform: {
        cover: { headline: "What should I know?", asset: "cover" },
        scenes: [
          { id: "intro", intro: true },
          { id: "answer", headline: "A clear answer for the", asset: "footage" },
          { id: "outro", outro: true },
        ],
      },
    },
  });
  await assert.rejects(checkVideoWorkspace(workspace, { slug: "sample-topic" }), /headline must be a complete thought .* appears truncated/u);
});

test("times a silent narration by word share with the words spread evenly inside each scene", () => {
  const timings = silentSceneTimings([
    { id: "intro", narration: "Should I keep these records?" },
    { id: "records", narration: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen" },
  ], { wordsPerMinute: 150, minimumSceneSeconds: 2 });
  assert.equal(timings[0].durationMs, 2000); // 5 of 20 words at 150 wpm is 2.0s, the minimum
  assert.equal(timings[1].durationMs, 6000);
  assert.equal(timings[1].words.length, 15);
  assert.equal(timings[1].words.at(-1).endMs, 6000);
  assert.ok(timings[1].words.every((word, index, list) => index === 0 || word.startMs === list[index - 1].endMs));
});

const sha = (seed) => seed.repeat(64).slice(0, 64);

async function labFixture(t) {
  const workspace = await videoFixture(t, {
    contract: {
      producer: {
        schemaVersion: 1,
        roleEyebrows: { hook: "In brief", rule: "The rule", risk: "The risk", process: "Next step", exception: "The exception", answer: "The answer" },
        intro: { enabled: true, id: "intro" },
        engagement: { formats: ["horizontal"], id: "engage", eyebrow: "Your turn", narrationTemplate: "{{question}} Tell us below.", requireYesNoQuestion: true },
        outro: { id: "outro", narrationTemplate: "Learn more about {{topic}} at {{site}}." },
        cover: { assetPrefix: "cover-subject-", defaultEmotion: "concern" },
        footage: { assetPrefix: "footage-" },
      },
    },
  });
  const root = workspace.designSystemRoot;
  await writeJson(path.join(root, "video", "assets.json"), {
    schemaVersion: 1,
    assets: {
      cover: { publicPath: "public/cover.jpg" },
      footage: { publicPath: "public/footage.mp4", durationSeconds: 20 },
      "cover-subject-concern": { mediaKey: "cover-subject-concern", kind: "image" },
      "footage-one": { mediaKey: "footage-one", durationSeconds: 6, subject: "center", flip: false, text: "left-center" },
      "footage-two": { mediaKey: "footage-two", durationSeconds: 6, subject: "center", flip: false, text: "left-center" },
      "footage-three": { mediaKey: "footage-three", durationSeconds: 6, subject: "center", flip: false, text: "left-center" },
    },
  });
  await writeJson(path.join(root, "media.json"), {
    schemaVersion: 2,
    assets: [
      { id: "cover-subject-concern-id", key: "cover-subject-concern", kind: "image", title: "Concern", filename: "concern.jpg", contentType: "image/jpeg", publicUrl: "https://media.example.com/concern.jpg", sha256: sha("a"), bytes: 5 },
      ...["one", "two", "three"].map((name) => ({ id: `footage-${name}-id`, key: `footage-${name}`, kind: "video", title: name, filename: `${name}.mp4`, contentType: "video/mp4", publicUrl: `https://media.example.com/${name}.mp4`, sha256: sha("b"), bytes: 5, durationSeconds: 6 })),
    ],
  });
  await writeJson(path.join(root, "video", "lab", "records.json"), {
    schemaVersion: 1,
    slug: "records",
    outputFormat: "horizontal",
    exactQuestion: "Should I keep these records?",
    topic: { label: "important records", engagementQuestion: "Are you keeping these records?", coverEmotion: "concern" },
    answerBeats: [
      { id: "keep", role: "rule", narration: "Keep the records together and preserve every page, even the routine ones.", summary: "Keep every record together" },
      { id: "copies", role: "process", narration: "Ask for copies before anything is filed.", summary: "Ask for copies first" },
    ],
  });
  return workspace;
}

test("plans a lab input through the client producer: compiled structure, silent timings, deterministic footage and cover", async (t) => {
  const workspace = await labFixture(t);
  const planned = await planVideoLab(workspace, "records");
  const { compiled, timings, finalized } = planned.lab;
  assert.deepEqual(compiled.scenes.map((scene) => scene.id), ["intro", "keep", "copies", "engage", "outro"]);
  assert.equal(compiled.scenes[1].eyebrow, "The rule");
  assert.equal(timings.length, compiled.scenes.length);
  assert.equal(finalized.coverSubject.key, "cover-subject-concern");
  for (const scene of finalized.plan.scenes) {
    if (scene.intro || scene.outro) continue;
    for (const key of scene.assets || [scene.asset]) assert.match(key, /^footage-/u);
  }
  const listed = await runVideoLab(workspace, undefined, { list: true });
  assert.match(listed.lines[0], /Lab inputs \(video\/lab\/\): records/u);
  assert.match(listed.lines[1], /Ready productions \(video\/productions\/\): sample-topic/u);
  const plan = await runVideoLab(workspace, "records", { plan: true });
  assert.match(plan.lines[0], /^records · horizontal · Should I keep these records\?/u);
  assert.match(plan.lines[0], /cover +cover-subject-concern/u);
  await assert.rejects(planVideoLab(workspace, "missing"), /video lab input missing was not found/u);
});

test("prepares a lab input as the single-format project an automated Video Lab renders", async (t) => {
  const workspace = await labFixture(t);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(Buffer.from("bytes"), { status: 200 });
  t.after(() => { globalThis.fetch = originalFetch; });
  await fs.writeFile(path.join(workspace.designSystemRoot, "video", "remotion.tsx"), "export default {};\n", "utf8");
  workspace.manifest.video = normalizeVideoManifest({ components: "video/remotion.tsx" });

  const prepared = await prepareVideoLab(workspace, "records");
  const project = prepared.project;
  assert.equal(project.records.production.outputFormat, "horizontal");
  assert.equal(project.records.production.cover.asset, "cover-subject-concern");
  assert.equal(project.assets["cover-subject-concern"].kind, "image");
  assert.equal(project.records.production.audioSrc, null);
  assert.deepEqual(project.records.captions.lines.map((line) => line.id), ["intro", "keep", "copies", "engage", "outro"]);
  for (const scene of project.records.production.scenes) {
    assert.equal("verticalAsset" in scene, false);
    for (const key of scene.assets || (scene.asset ? [scene.asset] : [])) assert.ok(project.assets[key], `${key} staged`);
  }
  assert.equal(project.contract.brand.fontFiles[0].format, "woff2");
  await fs.access(path.join(prepared.publicRoot, "media", "cover-subject-concern.jpg"));
  const entry = await fs.readFile(prepared.entryPath, "utf8");
  assert.match(entry, /import videoProjectComponents from "\.\.\/\.\.\/\.\.\/\.\.\/video\/remotion\.tsx"/u);
  assert.match(entry, /createSingleVideoProjectRoot\(project, videoProjectComponents\)/u);
  assert.ok(prepared.entryPath.startsWith(path.join(workspace.designSystemRoot, "video-local", "lab", "records")));
});

test("video check compiles every lab input and only warns when the catalog cannot finalize one yet", async (t) => {
  const workspace = await labFixture(t);
  const checked = await checkVideoWorkspace(workspace);
  assert.deepEqual(checked.labInputs, [{ name: "records", finalized: true }]);
  assert.deepEqual(checked.warnings, []);

  const assetsPath = path.join(workspace.designSystemRoot, "video", "assets.json");
  const catalog = JSON.parse(await fs.readFile(assetsPath, "utf8"));
  for (const key of Object.keys(catalog.assets)) if (key.startsWith("footage-")) delete catalog.assets[key];
  await writeJson(assetsPath, catalog);
  const starved = await checkVideoWorkspace(workspace);
  assert.deepEqual(starved.labInputs, [{ name: "records", finalized: false }]);
  assert.match(starved.warnings[0], /lab input records compiles but cannot finalize yet/u);

  await writeJson(path.join(workspace.designSystemRoot, "video", "lab", "broken.json"), { schemaVersion: 1, slug: "broken", outputFormat: "horizontal", exactQuestion: "No question mark", topic: { label: "x y" }, answerBeats: [] });
  await assert.rejects(checkVideoWorkspace(workspace), /exactQuestion must end with a question mark/u);
});

const bannerContractBase = {
  schemaVersion: 1,
  id: "banner-video",
  name: "Banner video",
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
};

test("normalizes persistent CTA banners and Short publishing options", () => {
  const contract = validateVideoContract({
    ...bannerContractBase,
    brand: { ...bannerContractBase.brand, banners: { longform: "  Subscribe for more ", short: { kicker: "Learn more", url: "example.com/start" } } },
    publishing: { shortBridge: "Full explainer on our channel.", disclaimer: "General information only.", shortDisclaimer: "Not legal advice.", shortArticleLink: false, articleLabel: "" },
  });
  assert.deepEqual(contract.brand.banners, { longform: "Subscribe for more", short: { kicker: "Learn more", url: "example.com/start" } });
  assert.deepEqual(contract.publishing, {
    shortBridge: "Full explainer on our channel.",
    disclaimer: "General information only.",
    shortDisclaimer: "Not legal advice.",
    shortArticleLink: false,
  });

  const plain = validateVideoContract(bannerContractBase);
  assert.deepEqual(plain.brand.banners, {});
  assert.deepEqual(plain.publishing, { shortArticleLink: true });

  assert.throws(
    () => validateVideoContract({ ...bannerContractBase, brand: { ...bannerContractBase.brand, banners: { short: { kicker: "Learn more" } } } }),
    /brand\.banners\.short\.url is required/u,
  );
  assert.throws(
    () => validateVideoContract({ ...bannerContractBase, brand: { ...bannerContractBase.brand, banners: "Subscribe" } }),
    /brand\.banners must be a JSON object/u,
  );
});

test("keeps a Short's packaged description short when the contract asks", () => {
  const publishing = {
    descriptionHook: "Who gets the house?",
    answer: "The law follows a fixed order of heirs.",
    seriesLine: "Answers — Example Law",
    articleUrl: "https://example.com/article",
    disclaimer: "Long disclaimer for the long-form description.",
    shorts: [{ id: "one", descriptionHook: "A cousin does not inherit first.", description: "example.com/start — everything here is avoidable\n\nA cousin does not inherit first." }],
  };
  const prepared = (contractPublishing) => ({
    production: { publishing },
    video: { contract: { brand: { series: "Answers" }, publishing: contractPublishing } },
  });
  const options = { shortBridge: "Full explainer on our channel.", shortDisclaimer: "Not legal advice.", shortArticleLink: false };

  assert.equal(descriptionFor(prepared(options)), [
    "Who gets the house?\n\nA: The law follows a fixed order of heirs.",
    "Answers — Example Law",
    "Read the full article: https://example.com/article",
    "Long disclaimer for the long-form description.",
  ].join("\n\n") + "\n");

  assert.equal(descriptionFor(prepared(options), publishing.shorts[0]), [
    "example.com/start — everything here is avoidable\n\nA cousin does not inherit first.",
    "Answers — Example Law",
    "Full explainer on our channel.",
    "Not legal advice.",
  ].join("\n\n") + "\n");

  assert.equal(descriptionFor(prepared({ shortBridge: "Full explainer on our channel.", shortArticleLink: true }), { id: "two", descriptionHook: "Hook only.", answer: "Short answer." }), [
    "Hook only.\n\nA: Short answer.",
    "Answers — Example Law",
    "Full explainer on our channel.",
    "Read the full article: https://example.com/article",
    "Long disclaimer for the long-form description.",
  ].join("\n\n") + "\n");
});

test("lets the producer speak a shorter outro in Shorts than in the long-form", () => {
  const contract = validateVideoContract({
    ...bannerContractBase,
    producer: {
      schemaVersion: 1,
      authoring: { sharedPromptBlocks: [], formatPromptBlocks: {} },
      roleEyebrows: { hook: "In brief", rule: "The rule", risk: "The risk", process: "Next step", exception: "The exception", answer: "The answer" },
      intro: { enabled: false },
      engagement: { enabled: false, eyebrow: "Your turn", narrationTemplate: "{{question}} Tell us below." },
      outro: { narrationTemplate: "Learn more about {{topic}} from {{series}} at {{site}}.", narrationTemplates: { short: "Learn more at {{site}}." } },
      cover: { assetPrefix: "cover-subject-" },
      footage: { assetPrefix: "footage-" },
    },
  });
  assert.deepEqual(contract.producer.outro.narrationTemplates, { short: "Learn more at {{site}}." });
  const assetCatalog = { assets: {
    "cover-subject-concern": { mediaKey: "cover-subject-concern" },
    "footage-one": { mediaKey: "footage-one", durationSeconds: 5, subject: "right", flip: false, text: "left-center" },
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
  const request = (outputFormat) => ({
    schemaVersion: 1,
    slug: `outro-${outputFormat}`,
    outputFormat,
    exactQuestion: "Should I keep these records?",
    topic: { label: "important records", coverEmotion: "concern" },
    answerBeats: [{ id: "records", role: "rule", narration: "Keep the records together.", summary: "Keep records together" }],
  });
  assert.equal(producer.compileProduction(request("short")).scenes.at(-1).narration, "Learn more at example.com.");
  assert.equal(producer.compileProduction(request("horizontal")).scenes.at(-1).narration, "Learn more about important records from Example Answers at example.com.");
  const blank = validateVideoContract({ ...bannerContractBase, producer: { ...contract.producer, outro: { narrationTemplate: "Learn more.", narrationTemplates: { short: "" } } } });
  assert.deepEqual(blank.producer.outro.narrationTemplates, {});
});

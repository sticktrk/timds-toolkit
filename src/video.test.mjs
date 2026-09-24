import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  brandDriftWarnings,
  checkVideoWorkspace,
  describeSceneFootage,
  describeVideoLabPlan,
  descriptionFor,
  exportVideoPublishing,
  initializeVideoComponents,
  initializeVideoWorkspace,
  loadVideoWorkspace,
  normalizeVideoManifest,
  planVideoLab,
  prepareVideoLab,
  prepareVideoWorkspace,
  renderVideoWorkspace,
  resolveVideoBrand,
  runVideoLab,
  silentSceneTimings,
  singleFormatScenes,
  stageVideoBrand,
  validateVideoContract,
  voiceoverVideoWorkspace,
} from "./video.mjs";
import { createVideoAuthoringContract, createVideoProducer } from "./video-producer.mjs";
import { adjacentFootageRepeats } from "../video/footage.mjs";
import { labFixture, registerVerticalMetadata, videoFixture, writeJson } from "./video.fixture.mjs";

test("normalizes the optional video manifest", () => {
  assert.equal(normalizeVideoManifest(false), null);
  assert.deepEqual(normalizeVideoManifest(true), {
    contract: "video/contract.json",
    assets: "video/assets.json",
    verticalMetadata: null,
    productions: "video/productions",
    local: "video-local",
    lab: "video/lab",
    components: null,
  });
  assert.equal(normalizeVideoManifest({ components: "video/remotion.tsx" }).components, "video/remotion.tsx");
  assert.throws(() => normalizeVideoManifest({ components: "../outside.tsx" }), /must stay inside the Design System/);
  assert.throws(() => normalizeVideoManifest({ verticalMetadata: "../outside.json" }), /must stay inside the Design System/);
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
  assert.ok(generated.includes(snapshot.replace("} satisfies Required<VideoProjectComponentOverrides>;", "} satisfies VideoProjectComponentOverrides;")));
  // A client copy may leave a slot out; the toolkit fills it at runtime, so a
  // new slot in a later release must not fail the client's typecheck.
  assert.doesNotMatch(generated, /satisfies Required<VideoProjectComponentOverrides>/u);
  assert.match(generated, /\} satisfies VideoProjectComponentOverrides;/u);
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

  // A beat's own picks open its scene in that order; the compiler fills the rest.
  const picked = producer.compileProduction({
    schemaVersion: 1,
    slug: "sample-answer-picked",
    outputFormat: "horizontal",
    exactQuestion: "Should I keep these records?",
    topic: { label: "important records", engagementQuestion: "Are you keeping these records?", coverEmotion: "concern" },
    answerBeats: [{ id: "records", role: "rule", narration: "Keep the records together and preserve every page.", summary: "Keep every record together", footage: ["footage-two", " footage-two "] }],
  });
  assert.deepEqual(picked.scenes.find((scene) => scene.id === "records").footage, ["footage-two"]);
  const pickedFinal = producer.finalizeProduction({
    schemaVersion: 1,
    compiled: picked,
    timings: picked.scenes.map((scene) => ({ id: scene.id, durationMs: scene.id === "records" ? 8_000 : 1_000, words: [{ text: scene.id, startMs: 0, endMs: 700 }] })),
    audioSrc: "audio.mp3",
  });
  assert.deepEqual(pickedFinal.plan.scenes.find((scene) => scene.id === "records").assets, ["footage-two", "footage-one"]);
  for (const [footage, message] of [
    [["footage-nine"], /footage-nine, which is not horizontal footage under footage-/u],
    [["cover-subject-concern"], /not horizontal footage/u],
    [["footage-one-vertical"], /not horizontal footage/u],
    [["footage-one", "footage-two", "footage-one-vertical", "footage-nine"], /names 4 clips; the limit is 3/u],
    ["footage-one", /must be an array of footage keys/u],
  ]) {
    assert.throws(() => producer.compileProduction({
      schemaVersion: 1,
      slug: "sample-answer-bad-pick",
      outputFormat: "horizontal",
      exactQuestion: "Should I keep these records?",
      topic: { label: "important records", engagementQuestion: "Are you keeping these records?", coverEmotion: "concern" },
      answerBeats: [{ id: "records", role: "rule", narration: "Keep the records together.", summary: "Keep every record together", footage }],
    }), message);
  }

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
  // Without the catalogs, footage stays compiler-owned: no catalog, no pick field.
  assert.equal(authoring.footage, undefined);
  assert.equal(authoring.inputSchema.properties.answerBeats.items.properties.footage, undefined);
  assert.ok(authoring.compilerOwns.includes("footage chains"));
  assert.ok(authoring.prompt.instructions.some((line) => /cover subjects, footage, timing/u.test(line)));
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

  // With the catalogs, the contract lists every eligible clip for the format
  // and the schema lets each beat name up to three of them.
  const catalogAuthoring = (outputFormat) => createVideoAuthoringContract({
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
    provenance: { version: "2.3.4", commit: "a".repeat(40) },
    outputFormat,
    assetCatalog,
    mediaCatalog: { assets: mediaCatalog.assets.map((asset) => asset.key === "footage-one" ? { ...asset, title: "Night rear-end in rain", tags: ["b-roll", "night"] } : asset) },
  });
  const withCatalog = catalogAuthoring("horizontal");
  assert.deepEqual(withCatalog.footage, {
    assetPrefix: "footage-",
    maximumPerBeat: 3,
    clips: [
      { key: "footage-one", title: "Night rear-end in rain", tags: ["b-roll", "night"], durationSeconds: 5 },
      { key: "footage-two", tags: [], durationSeconds: 5 },
    ],
  });
  assert.deepEqual(withCatalog.inputSchema.properties.answerBeats.items.properties.footage.items, { type: "string", enum: ["footage-one", "footage-two"] });
  assert.equal(withCatalog.inputSchema.properties.answerBeats.items.properties.footage.maxItems, 3);
  assert.ok(!withCatalog.inputSchema.properties.answerBeats.items.required.includes("footage"));
  assert.ok(withCatalog.compilerOwns.includes("footage timing, fallback clips, and chain rules"));
  assert.ok(!withCatalog.compilerOwns.includes("footage chains"));
  assert.ok(withCatalog.prompt.instructions.some((line) => /set footage to one to 3 ordered clip keys/u.test(line)));
  assert.ok(!withCatalog.prompt.instructions.some((line) => /cover subjects, footage, timing/u.test(line)));
  // Shorts list only clips with a vertical derivative, at the derivative's duration.
  assert.deepEqual(catalogAuthoring("short").footage.clips.map((clip) => clip.key), ["footage-one", "footage-two"]);
});

test("spreads fallback footage across a production and ranks it by published title and tags", () => {
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
      footage: { assetPrefix: "dash-" },
    },
  });
  const clips = {
    "dash-16-red-light": { title: "Day car red-light runner", tags: ["intersection", "red light"] },
    "dash-18-jackknife": { title: "Wet truck jackknife", tags: ["truck", "rain"] },
    "dash-20-rear-end": { title: "Night car rear-end in rain", tags: ["rear-end", "rain", "night"] },
    "dash-30-spinout": { title: "Day car spinout", tags: ["loss of control"] },
  };
  const assetCatalog = { assets: {
    "cover-subject-concern": { mediaKey: "cover-subject-concern" },
    ...Object.fromEntries(Object.keys(clips).map((key) => [key, { mediaKey: key, durationSeconds: 6, subject: "center", flip: false, text: "left-center" }])),
  } };
  const mediaCatalog = { assets: Object.keys(assetCatalog.assets).map((key) => ({
    key,
    filename: `${key}.${key.startsWith("cover-") ? "jpg" : "mp4"}`,
    publicUrl: `https://example.com/${key}`,
    contentType: key.startsWith("cover-") ? "image/jpeg" : "video/mp4",
    durationSeconds: assetCatalog.assets[key].durationSeconds,
    ...(clips[key] || {}),
  })) };
  const producer = createVideoProducer({ contract, assetCatalog, mediaCatalog });
  const compiled = producer.compileProduction({
    schemaVersion: 1,
    slug: "sample-answer",
    outputFormat: "horizontal",
    exactQuestion: "Was the rear-end crash my fault?",
    topic: { label: "rear-end crashes", coverEmotion: "concern" },
    answerBeats: [
      { id: "hook", role: "hook", narration: "Their job is to pay you less.", summary: "They pay less" },
      { id: "rule", role: "rule", narration: "A rear-end crash in the rain is usually the trailing driver's fault.", summary: "Trailing driver is at fault" },
      { id: "process", role: "process", narration: "Save the footage and get checked.", summary: "Save it and get checked" },
      { id: "answer", role: "answer", narration: "Simple crash, complicated claim.", summary: "Simple crash, complicated claim" },
    ],
  });
  const finalized = producer.finalizeProduction({
    schemaVersion: 1,
    compiled,
    timings: compiled.scenes.map((scene) => ({ id: scene.id, durationMs: 8_000, words: [{ text: scene.id, startMs: 0, endMs: 700 }] })),
    audioSrc: "audio.mp3",
  });
  const chains = Object.fromEntries(finalized.plan.scenes.map((scene) => [scene.id, scene.assets]));
  // No words in common with any clip: the first scene takes the catalog in key order.
  assert.deepEqual(chains.hook, ["dash-16-red-light", "dash-18-jackknife"]);
  // Clips the production has not played yet come first, and among those the
  // narration's "rear-end" and "rain" match the published title and tags.
  assert.deepEqual(chains.rule, ["dash-20-rear-end", "dash-30-spinout"]);
  // Everything has played once; the least-played rule restarts the catalog
  // rather than reopening on the same clip every scene.
  assert.deepEqual(chains.process, ["dash-16-red-light", "dash-18-jackknife"]);
  assert.deepEqual(chains.answer, ["dash-20-rear-end", "dash-30-spinout"]);
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

test("refuses a production whose footage or cover is not published, and only warns about unused catalog entries", async (t) => {
  const workspace = await videoFixture(t);
  const assetsPath = path.join(workspace.designSystemRoot, "video/assets.json");
  const assets = JSON.parse(await fs.readFile(assetsPath, "utf8"));
  assets.assets["footage-staged"] = { mediaKey: "footage-staged", durationSeconds: 20, subject: "center", flip: false, text: "left-center" };
  await writeJson(assetsPath, assets);
  const checked = await checkVideoWorkspace(workspace, { slug: "sample-topic" });
  assert.deepEqual(checked.warnings.filter((warning) => warning.includes("footage-staged")), ["footage-staged: mediaKey footage-staged is not registered in media.json"]);

  const productionPath = path.join(workspace.designSystemRoot, "video/productions/sample-topic/production.json");
  const production = JSON.parse(await fs.readFile(productionPath, "utf8"));
  production.longform.scenes[1].asset = "footage-staged";
  await writeJson(productionPath, production);
  await assert.rejects(checkVideoWorkspace(workspace, { slug: "sample-topic" }), (error) => {
    assert.match(error.message, /reference media that no render host can fetch/u);
    assert.match(error.message, /timds assets publish/u);
    assert.match(error.message, /- footage-staged: mediaKey footage-staged is not published in media\.json/u);
    return true;
  });

  await writeJson(path.join(workspace.designSystemRoot, "media.json"), {
    schemaVersion: 2,
    assets: [{ id: "footage-staged-id", key: "footage-staged", kind: "video", title: "Staged", filename: "staged.mp4", contentType: "video/mp4", publicUrl: "https://media.example.com/staged.mp4", sha256: "a".repeat(64), bytes: 5, durationSeconds: 20 }],
  });
  const published = await checkVideoWorkspace(workspace, { slug: "sample-topic" });
  assert.equal(published.warnings.some((warning) => warning.includes("footage-staged")), false);
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
  // The first scene ended on footage-two, and footage-one has already played,
  // so the second reopens on the family's unplayed mirrored cut.
  assert.equal(finalized.plan.scenes.find((scene) => scene.id === "second").asset, "footage-one-mirrored");
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
  const initializedManifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert.equal(initializedManifest.video.verticalMetadata, "video/vertical-meta.json");
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, initializedManifest.video.verticalMetadata), "utf8")), { schemaVersion: 1, assets: {} });
  assert.equal(contract.producer.footage.assetPrefix, "footage-");
  assert.equal(contract.producer.cover.assetPrefix, "cover-subject-");
  assert.deepEqual(Object.keys(contract.publishing.targets), ["youtube_short", "facebook_reel", "instagram_reel"]);
  await fs.access(path.join(root, "video", "publishing.md"));
  assert.deepEqual(Object.keys(contract.producer.roleEyebrows).sort(), ["answer", "exception", "hook", "process", "risk", "rule"]);
  const baseline = JSON.parse(await fs.readFile(path.join(root, ".timds/defaults.json"), "utf8"));
  assert.deepEqual(contract.publishing.targets, baseline.videoPublishing.targets);
  assert.deepEqual(contract.publishing.targetDefaults, baseline.videoPublishing.targetDefaults);
  assert.deepEqual(baseline.overrides, []);
  await initializeVideoWorkspace({ designSystemRoot: root, repoRoot: root, manifestPath, manifest: {} }, { force: true });
  assert.deepEqual(JSON.parse(await fs.readFile(result.contract, "utf8")).publishing.targets, baseline.videoPublishing.targets);
});

test("a contact CTA already used as the series line is included once", () => {
  const cta = "Contact the team at example.com";
  const prepared = { production: { publishing: { seriesLine: cta } }, video: { contract: { brand: { series: "Answers" }, publishing: { shortBridge: cta } } } };
  assert.equal(descriptionFor(prepared, { description: "Clip copy." }), `Clip copy.\n\n${cta}\n`);
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

  const prepared = await prepareVideoLab(workspace, "records", { silent: true });
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

test("Shorts crop published masters only when opted in, prefer derivatives, and keep complete mixed chains", async (t) => {
  const workspace = await labFixture(t);
  const root = workspace.designSystemRoot;
  const inputPath = path.join(root, "video/lab/records.json");
  const input = JSON.parse(await fs.readFile(inputPath, "utf8"));
  input.outputFormat = "short";
  input.answerBeats = [{ id: "keep", role: "rule", summary: "Keep every record together", narration: "Keep the original records together and make a backup copy of every page before sharing any of them with anyone." }];
  await writeJson(inputPath, input);
  await assert.rejects(planVideoLab(workspace, "records"), /no eligible Shorts footage.*allowShortCrop/u);

  const contractPath = path.join(root, "video/contract.json");
  const contract = JSON.parse(await fs.readFile(contractPath, "utf8"));
  contract.producer.footage.allowShortCrop = "true";
  assert.throws(() => validateVideoContract(contract), /allowShortCrop must be a boolean/u);
  contract.producer.footage.allowShortCrop = true;
  await writeJson(contractPath, contract);
  await assert.rejects(planVideoLab(workspace, "records"), /no eligible Shorts footage.*reviewed crops/u);
  const metadata = await registerVerticalMetadata(workspace);
  const cropped = (await planVideoLab(workspace, "records")).lab;
  const scene = cropped.finalized.plan.scenes.find((entry) => entry.id === "keep");
  assert.ok(scene.assets.length > 1, "the eight-second scene needs more than one six-second master");
  assert.deepEqual(scene.verticalAssets, scene.assets);
  assert.deepEqual(singleFormatScenes(cropped.finalized).find((entry) => entry.id === "keep").assets, scene.assets);
  for (const key of scene.assets) {
    const selected = cropped.finalized.footage.find((entry) => entry.key === key);
    assert.equal(selected.objectPosition, "85% 50%");
    assert.equal(selected.text, "lower");
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("video-bytes");
  t.after(() => { globalThis.fetch = originalFetch; });
  const staged = await prepareVideoLab(workspace, "records", { silent: true });
  assert.equal(staged.project.assets[scene.assets[0]].objectPosition, "85% 50%");
  assert.equal(staged.project.assets[scene.assets[0]].text, "lower");
  input.outputFormat = "horizontal";
  await writeJson(inputPath, input);
  const wide = await prepareVideoLab(workspace, "records", { silent: true });
  assert.equal(wide.project.assets[scene.assets[0]].objectPosition, undefined);
  assert.equal(wide.project.assets[scene.assets[0]].text, "left-center");
  input.outputFormat = "short";
  await writeJson(inputPath, input);

  const assetsPath = path.join(root, "video/assets.json");
  const assets = JSON.parse(await fs.readFile(assetsPath, "utf8"));
  const master = scene.assets[0];
  const vertical = `${master}-vertical`;
  assets.assets[master].vertical = vertical;
  assets.assets[vertical] = { mediaKey: vertical, durationSeconds: 4, text: "lower" };
  delete assets.assets["footage-three"];
  delete metadata.assets["footage-three"];
  await writeJson(path.join(root, "video/vertical-meta.json"), metadata);
  await writeJson(assetsPath, assets);
  const mediaPath = path.join(root, "media.json");
  const media = JSON.parse(await fs.readFile(mediaPath, "utf8"));
  media.assets.push({ ...media.assets.find((entry) => entry.key === master), id: `${vertical}-id`, key: vertical, filename: `${vertical}.mp4`, publicUrl: `https://media.example.com/${vertical}.mp4`, durationSeconds: 4 });
  await writeJson(mediaPath, media);
  const mixed = (await planVideoLab(workspace, "records")).lab;
  const mixedScene = mixed.finalized.plan.scenes.find((entry) => entry.id === "keep");
  assert.equal(mixedScene.verticalAssets.length, mixedScene.assets.length);
  assert.equal(mixedScene.verticalAssets[mixedScene.assets.indexOf(master)], vertical);
  assert.ok(mixedScene.verticalAssets.some((key) => key !== vertical), "unlinked masters remain in the chain");
  assert.deepEqual(singleFormatScenes(mixed.finalized).find((entry) => entry.id === "keep").assets, mixedScene.verticalAssets);

  // A crop uses the real duration, never a stretched or frozen clip.
  input.answerBeats[0].narration = Array(100).fill("records").join(" ");
  await writeJson(inputPath, input);
  await assert.rejects(planVideoLab(workspace, "records"), /natural 1x speed/u);
  for (const key of Object.keys(assets.assets)) if (key.startsWith("footage-")) delete assets.assets[key];
  await writeJson(assetsPath, assets);
  await writeJson(path.join(root, "video/vertical-meta.json"), { schemaVersion: 1, assets: {} });
  await assert.rejects(planVideoLab(workspace, "records"), /no eligible Shorts footage/u);
});

for (const derivative of [false, true]) {
  test(`Shorts choose a complete chain in one reviewed text zone${derivative ? " with a linked derivative" : ""}`, async (t) => {
    const workspace = await labFixture(t);
    const root = workspace.designSystemRoot;
    const contractPath = path.join(root, "video/contract.json");
    const contract = JSON.parse(await fs.readFile(contractPath, "utf8"));
    contract.producer.footage.allowShortCrop = true;
    await writeJson(contractPath, contract);
    const inputPath = path.join(root, "video/lab/records.json");
    const input = JSON.parse(await fs.readFile(inputPath, "utf8"));
    input.outputFormat = "short";
    input.answerBeats = [{ id: "keep", role: "rule", summary: "Keep every record together", narration: "Keep the original records together and make a backup copy of every page before sharing any of them with anyone." }];
    await writeJson(inputPath, input);
    const assetsPath = path.join(root, "video/assets.json");
    const assets = JSON.parse(await fs.readFile(assetsPath, "utf8"));
    if (derivative) {
      assets.assets["footage-one"].vertical = "footage-one-vertical";
      assets.assets["footage-one-vertical"] = { mediaKey: "footage-one-vertical", durationSeconds: 6, text: "upper" };
      await writeJson(assetsPath, assets);
      const mediaPath = path.join(root, "media.json");
      const media = JSON.parse(await fs.readFile(mediaPath, "utf8"));
      media.assets.push({ ...media.assets.find((entry) => entry.key === "footage-one"), id: "footage-one-vertical-id", key: "footage-one-vertical", filename: "one-vertical.mp4", publicUrl: "https://media.example.com/one-vertical.mp4" });
      await writeJson(mediaPath, media);
    }
    const metadata = await registerVerticalMetadata(workspace);
    const metadataPath = path.join(root, "video/vertical-meta.json");
    metadata.assets["footage-one"].text = "upper";
    metadata.assets["footage-two"].text = "upper";
    await writeJson(metadataPath, metadata);
    const upper = (await planVideoLab(workspace, "records")).lab.finalized;
    const upperScene = singleFormatScenes(upper).find((scene) => scene.id === "keep");
    assert.deepEqual(upperScene.assets, [derivative ? "footage-one-vertical" : "footage-one", "footage-two"]);
    assert.ok(upperScene.assets.every((key) => upper.footage.find((asset) => asset.key === key).text === "upper"));

    // The highest-ranked clip alone cannot cover eight seconds. Try the other
    // zone rather than rejecting a catalog that has a complete lower chain.
    metadata.assets["footage-two"].text = "lower";
    await writeJson(metadataPath, metadata);
    const lower = (await planVideoLab(workspace, "records")).lab.finalized;
    const lowerScene = singleFormatScenes(lower).find((scene) => scene.id === "keep");
    assert.deepEqual(lowerScene.assets, ["footage-three", "footage-two"]);
    assert.ok(lowerScene.assets.every((key) => lower.footage.find((asset) => asset.key === key).text === "lower"));

    // Total footage is still long enough, but neither zone can cover the scene.
    assets.assets["footage-two"].durationSeconds = 1;
    await writeJson(assetsPath, assets);
    await assert.rejects(planVideoLab(workspace, "records"), /single vertical text zone/u);
  });
}

test("video check gates the full B-roll registry even when no lab input uses a clip", async (t) => {
  const workspace = await labFixture(t);
  const root = workspace.designSystemRoot;
  await fs.rm(path.join(root, "video/lab/records.json"));
  workspace.manifest.video.verticalMetadata = "video/vertical-meta.json";
  await assert.rejects(checkVideoWorkspace(workspace), /video vertical metadata is required/u);
  const metadata = await registerVerticalMetadata(workspace);
  const metadataPath = path.join(root, "video/vertical-meta.json");
  await checkVideoWorkspace(workspace);
  for (const [change, expected] of [
    [(value) => { delete value.assets["footage-one"]; }, /footage-one needs a reviewed crop record/u],
    [(value) => { value.assets["footage-one"].objectPosition = "left center"; }, /objectPosition/u],
    [(value) => { value.assets["footage-one"].objectPosition = "101% 50%"; }, /objectPosition/u],
    [(value) => { value.assets["footage-one"].text = "right-center"; }, /vertical headline zone/u],
    [(value) => { value.assets["footage-one"].sourceSha256 = "a".repeat(64); }, /sourceSha256/u],
    [(value) => { value.assets["footage-one"].reviewedFrames = ["first"]; }, /reviewedFrames/u],
    [(value) => { value.assets["unknown"] = value.assets["footage-one"]; }, /not a registered footage master/u],
  ]) {
    const invalid = structuredClone(metadata);
    change(invalid);
    await writeJson(metadataPath, invalid);
    await assert.rejects(checkVideoWorkspace(workspace), expected);
  }
});

for (const cache of ["absent", "missing-file", "empty-file", "present", "stale-manifest", "changed-file"]) {
  test(`lab staging resolves published media with a ${cache} local cache`, async (t) => {
    const workspace = await labFixture(t);
    const root = workspace.designSystemRoot;
    const contractPath = path.join(root, "video/contract.json");
    const contract = JSON.parse(await fs.readFile(contractPath, "utf8"));
    contract.producer.footage.allowShortCrop = true;
    await writeJson(contractPath, contract);
    const inputPath = path.join(root, "video/lab/records.json");
    const input = JSON.parse(await fs.readFile(inputPath, "utf8"));
    input.outputFormat = "short";
    await writeJson(inputPath, input);
    const digest = (value) => createHash("sha256").update(value).digest("hex");
    const mediaPath = path.join(root, "media.json");
    const media = JSON.parse(await fs.readFile(mediaPath, "utf8"));
    for (const asset of media.assets) {
      asset.sha256 = digest("cloud-video");
      asset.bytes = Buffer.byteLength("cloud-video");
    }
    await writeJson(mediaPath, media);
    await registerVerticalMetadata(workspace);
    const planned = await planVideoLab(workspace, "records");
    const key = planned.lab.finalized.footage[0].key;
    const localPath = "media-local/cached.mp4";
    if (cache !== "absent") {
      await writeJson(path.join(root, ".timds/local-media.json"), { schemaVersion: 1, assets: [{ key, path: localPath, kind: "video", title: "Cached footage", tags: [], contentType: "video/mp4", filename: "cached.mp4", bytes: 11, sha256: digest(cache === "stale-manifest" ? "stale-video" : "cloud-video") }] });
      if (cache !== "missing-file") {
        await fs.mkdir(path.join(root, "media-local"), { recursive: true });
        await fs.writeFile(path.join(root, localPath), cache === "empty-file" ? "" : cache === "present" ? "cloud-video" : "stale-video");
      }
    }
    const urls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => { urls.push(url); return new Response("cloud-video"); };
    t.after(() => { globalThis.fetch = originalFetch; });
    const prepared = await prepareVideoLab(workspace, "records", { silent: true });
    const staged = await fs.readFile(path.join(prepared.publicRoot, prepared.project.assets[key].src), "utf8");
    assert.equal(staged, "cloud-video");
    assert.equal(digest(staged), prepared.project.assets[key].sha256);
    assert.equal(prepared.project.assets[key].objectPosition, "85% 50%");
    const published = planned.lab.finalized.footage.find((entry) => entry.key === key);
    assert.equal(urls.includes(published.publicUrl), cache !== "present");
  });
}

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

test("exports separate platform copy without rendering and preserves legacy records", async (t) => {
  const policy = { brief: "Describe this clip", maxCharacters: 300, maxCopyCharacters: 120, shortArticleLink: false };
  const workspace = await videoFixture(t, { contract: { publishing: {
    disclaimer: "Original disclaimer.",
    targetDefaults: { shortDisclaimer: "Information only." },
    targets: {
      youtube_short: { ...policy, shortBridge: "example.com/watch" },
      facebook_reel: { ...policy, shortBridge: "Learn more: https://example.com/facebook" },
      instagram_reel: { ...policy, shortBridge: "Save for later." },
    },
  } } });
  const recordPath = path.join(workspace.designSystemRoot, "video/productions/sample-topic/publishing.json");
  const publishing = JSON.parse(await fs.readFile(recordPath, "utf8"));
  const legacy = await exportVideoPublishing(workspace, "sample-topic", { date: "2026-01-01" });
  const directory = path.join(legacy.outputRoot, "Short form -Sample");
  const original = await fs.readFile(path.join(directory, "description.md"), "utf8");
  assert.match(original, /A clear answer/);
  assert.match(original, /Original disclaimer/);
  assert.doesNotMatch(original, /Information only/);
  await assert.rejects(fs.access(path.join(directory, "description.facebook_reel.md")), /ENOENT/);
  publishing.shorts[0].descriptions = {
    youtube_short: "One step to start.",
    facebook_reel: "Starting can feel complicated. Here is a useful first step.",
    instagram_reel: "Start with this small step.",
  };
  await writeJson(recordPath, publishing);
  await checkVideoWorkspace(workspace);
  await exportVideoPublishing(workspace, "sample-topic", { date: "2026-01-01" });
  const youtube = await fs.readFile(path.join(directory, "description.youtube_short.md"), "utf8");
  const facebook = await fs.readFile(path.join(directory, "description.facebook_reel.md"), "utf8");
  assert.equal(youtube, "One step to start.\n\nAnswers\n\nexample.com/watch\n\nInformation only.\n");
  assert.match(facebook, /Starting can feel complicated[\s\S]*https:\/\/example.com\/facebook/);
  assert.doesNotMatch(facebook, /example.com\/watch|example.com\/sample/);
  assert.equal(await fs.readFile(path.join(directory, "description.md"), "utf8"), youtube);
  delete publishing.shorts[0].descriptions.instagram_reel;
  await writeJson(recordPath, publishing);
  await assert.rejects(checkVideoWorkspace(workspace), /Missing instagram_reel/);
  publishing.shorts[0].descriptions.instagram_reel = "x".repeat(121);
  await writeJson(recordPath, publishing);
  await assert.rejects(checkVideoWorkspace(workspace), /copy exceeds 120/);
  await fs.writeFile(path.join(directory, "sample-short.mp4"), "existing video");
  await fs.writeFile(path.join(directory, "description.custom.md"), "client notes");
  delete publishing.shorts[0].descriptions;
  publishing.shorts[0].description = "Revised legacy caption.";
  await writeJson(recordPath, publishing);
  await exportVideoPublishing(workspace, "sample-topic", { date: "2026-01-01" });
  for (const target of ["youtube_short", "facebook_reel", "instagram_reel"]) {
    await assert.rejects(fs.access(path.join(directory, `description.${target}.md`)), /ENOENT/);
  }
  assert.match(await fs.readFile(path.join(directory, "description.md"), "utf8"), /Revised legacy caption/);
  assert.equal(await fs.readFile(path.join(directory, "sample-short.mp4"), "utf8"), "existing video");
  assert.equal(await fs.readFile(path.join(directory, "description.custom.md"), "utf8"), "client notes");
});

test("rendering keeps its original copy and output directory across midnight and source edits", async (t) => {
  const policy = { brief: "A short caption", maxCopyCharacters: 100, maxCharacters: 500 };
  const workspace = await videoFixture(t, { contract: { publishing: { targets: { youtube_short: policy } } } });
  const recordPath = path.join(workspace.designSystemRoot, "video/productions/sample-topic/publishing.json");
  const publishing = JSON.parse(await fs.readFile(recordPath, "utf8"));
  publishing.shorts[0].descriptions = { youtube_short: "Copy approved before rendering." };
  await writeJson(recordPath, publishing);
  const narration = path.join(workspace.designSystemRoot, "video-local/public/audio/sample-topic");
  await fs.mkdir(narration, { recursive: true });
  for (const id of ["intro", "answer", "outro"]) await fs.writeFile(path.join(narration, `${id}.mp3`), "voice");
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-15T23:59:59Z") });
  const renderOutputs = [];
  const spawn = t.mock.method(childProcess, "spawn", (_command, args) => {
    const child = new EventEmitter();
    renderOutputs.push(args[4]);
    Promise.resolve().then(async () => {
      t.mock.timers.setTime(Date.parse("2026-09-16T00:00:01Z"));
      publishing.shorts[0].descriptions.youtube_short = "Different copy edited during rendering.";
      await writeJson(recordPath, publishing);
      await fs.writeFile(args[4], "stubbed media renderer");
      child.emit("close", 0);
    }).catch((error) => child.emit("error", error));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { spawn.mock.restore(); syncBuiltinESMExports(); });
  const result = await renderVideoWorkspace(workspace, "sample-topic");
  assert.ok(result.outputRoot.endsWith("Sample topic - 2026-09-15"));
  assert.equal(renderOutputs.length, 4);
  assert.ok(renderOutputs.every((file) => file.startsWith(result.outputRoot)));
  const directory = path.join(result.outputRoot, "Short form -Sample");
  const description = await fs.readFile(path.join(directory, "description.youtube_short.md"), "utf8");
  assert.match(description, /Copy approved before rendering/);
  assert.doesNotMatch(description, /Different copy/);
  const packaged = JSON.parse(await fs.readFile(path.join(directory, "publishing.json"), "utf8"));
  assert.equal(packaged.descriptions.youtube_short, "Copy approved before rendering.");
  await assert.rejects(fs.access(path.join(workspace.designSystemRoot, "video-local/out/Sample topic - 2026-09-16")), /ENOENT/);
});

const writeCaptionLines = async (workspace, ids) => writeJson(path.join(workspace.designSystemRoot, "video", "productions", "sample-topic", "captions.json"), {
  lines: ids.map((id) => ({ id, durationMs: 1000, words: [{ text: id, startMs: 0, endMs: 650 }] })),
});

test("graphic scenes need the client opt-in and then render without footage", async (t) => {
  const graphic = { id: "board", chapter: "the-rule", visual: { kind: "steps", steps: [{ label: "Pull the deed" }, { label: "Read it" }, { label: "Match the will" }] } };
  const production = {
    longform: {
      cover: { headline: "What should I know?", asset: "cover" },
      scenes: [
        { id: "intro", intro: true },
        { id: "answer", chapter: "the-rule", headline: "A clear answer", asset: "footage" },
        { id: "board", ...graphic },
        { id: "outro", outro: true },
      ],
    },
  };
  const closed = await videoFixture(t, { production });
  await writeCaptionLines(closed, ["intro", "answer", "board", "outro"]);
  await assert.rejects(checkVideoWorkspace(closed, { slug: "sample-topic" }), /visual needs structure\.longform\.graphicScenes enabled/u);

  const open = await videoFixture(t, {
    production,
    contract: { structure: { longform: { requireIntro: true, requireOutro: true, graphicScenes: true }, short: {} } },
  });
  await writeCaptionLines(open, ["intro", "answer", "board", "outro"]);
  const checked = await checkVideoWorkspace(open, { slug: "sample-topic" });
  const scenes = checked.video.productions[0].production.longform.scenes;
  assert.equal(scenes[2].visual.kind, "steps");
  assert.equal(scenes[2].chapter, "the-rule");
  assert.equal(scenes[2].asset, undefined, "a graphic scene needs no footage");
  const prepared = await prepareVideoWorkspace(open, "sample-topic");
  assert.equal(prepared.project.contract.structure.longform.graphicScenes, true);
});

test("a graphic scene may sit over footage and a footage-free board breaks the family sequence", async (t) => {
  const workspace = await videoFixture(t, {
    contract: { structure: { longform: { requireIntro: true, requireOutro: true, graphicScenes: true }, short: {} } },
    production: {
      longform: {
        cover: { headline: "What should I know?", asset: "cover" },
        scenes: [
          { id: "intro", intro: true },
          { id: "answer", headline: "A clear answer", asset: "footage" },
          { id: "board", visual: { kind: "statement", text: "One plan." } },
          { id: "again", eyebrow: "Over footage", asset: "footage", visual: { kind: "document", title: "Deed", lines: [] } },
          { id: "outro", outro: true },
        ],
      },
    },
  });
  await writeCaptionLines(workspace, ["intro", "answer", "board", "again", "outro"]);
  const checked = await checkVideoWorkspace(workspace, { slug: "sample-topic" });
  assert.deepEqual(checked.video.productions[0].usedAssets.sort(), ["cover", "footage"]);
  assert.deepEqual(adjacentFootageRepeats(checked.video.productions[0].production.longform.scenes), []);
});

test("stages committed static files for the client components and refuses ignored ones", async (t) => {
  const workspace = await videoFixture(t, {
    contract: { brand: {
      colors: { background: "#000", accent: "#fc0", text: "#fff" },
      fonts: { display: "serif", body: "serif", ui: "sans-serif" },
      fontFiles: [{ family: "Example Serif", path: "public/example.woff2", style: "normal", weight: "700" }],
      logo: "public/logo.svg",
      series: "Answers",
      site: "example.com",
      tagline: "Clear answers.",
      staticFiles: [{ path: "public/illustrations", mount: "illustrations" }],
    } },
  });
  const source = path.join(workspace.designSystemRoot, "public", "illustrations");
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, "key-gold.webp"), "RIFF", "utf8");
  const prepared = await prepareVideoWorkspace(workspace, "sample-topic");
  assert.deepEqual(prepared.project.contract.brand.staticFiles, [{ path: "public/illustrations", mount: "illustrations" }]);
  await fs.access(path.join(prepared.publicRoot, "illustrations", "key-gold.webp"));

  const missing = await videoFixture(t, {
    contract: { brand: {
      colors: { background: "#000", accent: "#fc0", text: "#fff" },
      fonts: { display: "serif", body: "serif", ui: "sans-serif" },
      logo: "public/logo.svg",
      series: "Answers",
      site: "example.com",
      tagline: "Clear answers.",
      staticFiles: [{ path: "public/nowhere" }],
    } },
  });
  await assert.rejects(prepareVideoWorkspace(missing, "sample-topic"), /brand\.staticFiles\[0\]\.path: public\/nowhere does not exist/u);
});

const subscribeContract = () => ({
  schemaVersion: 1,
  id: "example-video",
  name: "Example video",
  package: { shortCount: 0 },
  structure: { longform: { graphicScenes: true } },
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
    intro: { enabled: true, id: "intro" },
    engagement: { enabled: false, eyebrow: "Your turn", narrationTemplate: "{{question}}" },
    subscribe: { enabled: true, afterBeat: 1, narrationTemplate: "Do you want to know more about {{topic}}? Subscribe to learn how to {{solution}}." },
    outro: { id: "outro", narrationTemplate: "Learn more at {{site}}." },
    cover: { assetPrefix: "cover-subject-", defaultEmotion: "concern" },
    footage: { assetPrefix: "footage-" },
  },
});

test("a subscribe board needs the graphic-scene opt-in for each of its formats at contract validation", () => {
  const raw = subscribeContract();
  assert.doesNotThrow(() => validateVideoContract(raw));
  assert.throws(() => validateVideoContract({ ...raw, structure: {} }), /producer\.subscribe needs structure\.longform\.graphicScenes: true to draw the board for horizontal renders/u);
  const shorts = { ...raw, producer: { ...raw.producer, subscribe: { ...raw.producer.subscribe, formats: ["horizontal", "short"] } } };
  assert.throws(() => validateVideoContract(shorts), /structure\.short\.graphicScenes: true to draw the board for short renders/u);
  assert.doesNotThrow(() => validateVideoContract({ ...shorts, structure: { longform: { graphicScenes: true }, short: { graphicScenes: true } } }));
  // A disabled board asks nothing of the structure.
  assert.doesNotThrow(() => validateVideoContract({ ...raw, structure: {}, producer: { ...raw.producer, subscribe: { enabled: false } } }));
});

test("the authoring contract asks the drafting model for the subscribe board's solution and reserves the board's id", () => {
  const authoringFor = (raw, outputFormat = "horizontal") => createVideoAuthoringContract({
    contract: validateVideoContract(raw),
    manifest: { systemId: "example", name: "Example", version: "1.0.0" },
    designSystemIndex: { system: { id: "example", version: "1.0.0" }, pages: [] },
    provenance: { commit: "0".repeat(40) },
    outputFormat,
  });
  const required = authoringFor(subscribeContract());
  assert.ok(required.inputSchema.properties.topic.required.includes("solution"));
  assert.equal(required.inputSchema.properties.topic.properties.solution.type, "string");
  assert.deepEqual(required.constraints.solution, { required: true, offered: true });
  assert.ok(required.constraints.reservedSceneIds.includes("subscribe"));
  assert.match(required.prompt.instructions.join("\n"), /Set topic\.solution to the outcome this answer helps the viewer reach/u);
  assert.equal(required.inputSchema.properties.answerBeats.items.properties.chapter.pattern, "^[a-z0-9][a-z0-9-]*$");
  assert.equal(required.inputSchema.properties.answerBeats.items.properties.visual, undefined, "board kinds belong to the Design System, never to the draft");
  assert.match(required.prompt.instructions.join("\n"), /Never write a visual/u);

  const raw = subscribeContract();
  const optional = authoringFor({ ...raw, producer: { ...raw.producer, subscribe: { ...raw.producer.subscribe, requireSolution: false } } });
  assert.ok(!optional.inputSchema.properties.topic.required.includes("solution"));
  assert.equal(optional.inputSchema.properties.topic.properties.solution.type, "string");
  assert.deepEqual(optional.constraints.solution, { required: false, offered: true });
  assert.match(optional.prompt.instructions.join("\n"), /the board is then skipped/u);

  // A format the board does not play in never hears about the solution.
  const short = authoringFor({ ...raw, structure: { longform: { graphicScenes: true }, short: { graphicScenes: true } } }, "short");
  assert.equal(short.inputSchema.properties.topic.properties.solution, undefined);
  assert.deepEqual(short.constraints.solution, { required: false, offered: false });
  assert.ok(!short.constraints.reservedSceneIds.includes("subscribe"));
});

test("the producer inserts a subscribe board after the topic is established and passes beat visuals through", () => {
  const contract = validateVideoContract({
    schemaVersion: 1,
    id: "example-video",
    name: "Example video",
    package: { shortCount: 0 },
    structure: { longform: { graphicScenes: true } },
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
      authoring: { sharedPromptBlocks: ["brand/voice#plain-language"], formatPromptBlocks: {} },
      roleEyebrows: { hook: "In brief", rule: "The rule", risk: "The risk", process: "Next step", exception: "The exception", answer: "The answer" },
      intro: { enabled: true, id: "intro" },
      engagement: { enabled: false, eyebrow: "Your turn", narrationTemplate: "{{question}}" },
      subscribe: { enabled: true, afterBeat: 1, narrationTemplate: "Do you want to know more about {{topic}}? Subscribe to learn how to {{solution}}." },
      outro: { id: "outro", narrationTemplate: "Learn more at {{site}}." },
      cover: { assetPrefix: "cover-subject-", defaultEmotion: "concern" },
      footage: { assetPrefix: "footage-" },
    },
  });
  const assetCatalog = { assets: {
    "cover-subject-concern": { mediaKey: "cover-subject-concern" },
    "footage-one": { mediaKey: "footage-one", durationSeconds: 5, subject: "right", flip: false, text: "left-center" },
    "footage-two": { mediaKey: "footage-two", durationSeconds: 5, subject: "right", flip: false, text: "left-center" },
  } };
  const mediaCatalog = { assets: [
    { key: "cover-subject-concern", filename: "concern.png", contentType: "image/png", publicUrl: "https://cdn.example/concern.png" },
    { key: "footage-one", filename: "one.mp4", contentType: "video/mp4", publicUrl: "https://cdn.example/one.mp4", durationSeconds: 5, title: "One" },
    { key: "footage-two", filename: "two.mp4", contentType: "video/mp4", publicUrl: "https://cdn.example/two.mp4", durationSeconds: 5, title: "Two" },
  ] };
  const producer = createVideoProducer({ contract, assetCatalog, mediaCatalog });
  const compiled = producer.compileProduction({
    schemaVersion: 1,
    slug: "deed-and-will",
    outputFormat: "horizontal",
    exactQuestion: "Does your deed agree with your will?",
    topic: { label: "house deeds", solution: "keep your house where your will says" },
    answerBeats: [
      { id: "promise", role: "hook", chapter: "question", narration: "The deed decides first.", summary: "The deed decides first" },
      { id: "title", role: "rule", chapter: "two-jobs", narration: "Chapter one.", summary: "Two documents, two jobs", visual: { kind: "chapter-title", number: 1, title: "Two documents, two jobs", motif: "will" } },
      { id: "rule", role: "rule", chapter: "two-jobs", narration: "A will is instructions.", summary: "A will is instructions" },
    ],
  });
  assert.deepEqual(compiled.scenes.map((scene) => scene.id), ["intro", "promise", "subscribe", "title", "rule", "outro"]);
  assert.equal(compiled.scenes[2].narration, "Do you want to know more about house deeds? Subscribe to learn how to keep your house where your will says.");
  assert.deepEqual(compiled.scenes[2].visual, { kind: "subscribe", topic: "house deeds", solution: "keep your house where your will says" });
  assert.equal(compiled.scenes[2].chapter, "question");
  assert.equal(compiled.scenes[3].visual.kind, "chapter-title");
  const finalized = producer.finalizeProduction({
    schemaVersion: 1,
    compiled,
    timings: compiled.scenes.map((scene) => ({ id: scene.id, durationMs: 4000, words: [{ text: scene.id, startMs: 0, endMs: 500 }] })),
    audioSrc: null,
  });
  const byId = Object.fromEntries(finalized.plan.scenes.map((scene) => [scene.id, scene]));
  const printed = describeVideoLabPlan({ compiled, timings: compiled.scenes.map((scene) => ({ id: scene.id, durationMs: 4000 })), finalized });
  assert.match(printed, /^ {2}subscribe .*\n {24}board subscribe$/mu);
  assert.match(printed, /^ {2}title .*\n {24}board chapter-title$/mu);
  assert.match(printed, /^ {2}rule .*\n {24}footage-/mu);
  assert.equal(byId.subscribe.asset, undefined, "the subscribe board carries no footage");
  assert.equal(byId.title.asset, undefined, "a chapter title carries no footage");
  assert.ok(byId.rule.asset, "a plain beat still selects footage");
  assert.equal(byId.rule.chapter, "two-jobs");
  assert.throws(() => producer.compileProduction({
    schemaVersion: 1,
    slug: "deed-and-will",
    outputFormat: "horizontal",
    exactQuestion: "Does your deed agree with your will?",
    topic: { label: "house deeds" },
    answerBeats: [{ id: "promise", role: "hook", narration: "x", summary: "The deed decides first" }],
  }), /producer topic\.solution/u);
  // A contract that does not require a solution skips the board for requests without one.
  const optional = createVideoProducer({ contract: validateVideoContract({ ...JSON.parse(JSON.stringify(contract)), producer: { ...contract.producer, subscribe: { ...contract.producer.subscribe, requireSolution: false } } }), assetCatalog, mediaCatalog });
  const skipped = optional.compileProduction({
    schemaVersion: 1,
    slug: "deed-and-will",
    outputFormat: "horizontal",
    exactQuestion: "Does your deed agree with your will?",
    topic: { label: "house deeds" },
    answerBeats: [{ id: "promise", role: "hook", narration: "x", summary: "The deed decides first" }],
  });
  assert.deepEqual(skipped.scenes.map((scene) => scene.id), ["intro", "promise", "outro"]);
});

test("accepts top copy zones for clips whose action crosses the middle band", async (t) => {
  const workspace = await videoFixture(t);
  const assetsPath = path.join(workspace.designSystemRoot, "video", "assets.json");
  const catalog = JSON.parse(await fs.readFile(assetsPath, "utf8"));
  catalog.assets.footage.text = "left-top";
  await writeJson(assetsPath, catalog);
  const checked = await checkVideoWorkspace(workspace, { slug: "sample-topic" });
  assert.equal(checked.video.assets.assets.footage.text, "left-top");
  catalog.assets.footage.text = "middle";
  await writeJson(assetsPath, catalog);
  await assert.rejects(checkVideoWorkspace(workspace, { slug: "sample-topic" }), /footage\.text is unsupported/u);
});

test("voiceover runs for a new production before its first captions.json exists", async (t) => {
  const workspace = await videoFixture(t);
  const captionsPath = path.join(workspace.designSystemRoot, "video", "productions", "sample-topic", "captions.json");
  await fs.rm(captionsPath);
  const calls = [];
  const run = async (command, args, options) => { calls.push({ command, args, options }); };
  const result = await voiceoverVideoWorkspace(workspace, "sample-topic", { python: "/opt/tts/bin/python", run });
  assert.equal(result.production, "sample-topic");
  assert.equal(result.outputRoot, path.join(workspace.designSystemRoot, workspace.manifest.video.local, "public", "audio", "sample-topic"));
  assert.equal(calls.length, 1, "the generator is spawned once even though captions.json does not exist yet");
  assert.equal(calls[0].command, "/opt/tts/bin/python");
  assert.equal(calls[0].args[calls[0].args.indexOf("--captions") + 1], captionsPath);
  assert.equal(calls[0].args[calls[0].args.indexOf("--script") + 1], path.join(path.dirname(captionsPath), "script.json"));
  assert.equal(calls[0].options.cwd, workspace.designSystemRoot);
  assert.ok(!calls[0].args.includes("--force"));
  await voiceoverVideoWorkspace(workspace, "sample-topic", { run, force: true });
  assert.ok(calls[1].args.includes("--force"));
  // A production that has no script yet fails before anything is spawned.
  await assert.rejects(voiceoverVideoWorkspace(workspace, "missing-topic", { run }), /missing-topic/u);
  assert.equal(calls.length, 2);
});

const staticBrand = (staticFiles) => ({
  colors: { background: "#000", accent: "#fc0", text: "#fff" },
  fonts: { display: "serif", body: "serif", ui: "sans-serif" },
  logo: "public/logo.svg",
  series: "Answers",
  site: "example.com",
  tagline: "Clear answers.",
  staticFiles,
});

test("static mounts cannot shadow staged brand files, prepared media, or each other", async (t) => {
  const contract = (staticFiles) => ({ schemaVersion: 1, id: "x", name: "X", package: { shortCount: 0 }, copy: {}, brand: staticBrand(staticFiles) });
  assert.throws(() => validateVideoContract(contract([{ path: "public/illustrations", mount: "brand/illustrations" }])), /staticFiles\[0\]\.mount brand\/illustrations is reserved/u);
  assert.throws(() => validateVideoContract(contract([{ path: "public/illustrations", mount: "media" }])), /staticFiles\[0\]\.mount media is reserved/u);
  assert.throws(() => validateVideoContract(contract([{ path: "public/illustrations", mount: "audio/beds" }])), /staticFiles\[0\]\.mount audio\/beds is reserved/u);
  assert.throws(() => validateVideoContract(contract([{ path: "public/illustrations" }, { path: "public/more", mount: "illustrations/extra" }])), /staticFiles\[1\]\.mount illustrations\/extra overlaps the earlier mount illustrations/u);
  assert.throws(() => validateVideoContract(contract([{ path: "public/illustrations", mount: "../up" }])), /must be a lowercase relative mount path/u);
  // Mixed case would pass a Mac and 404 on a Linux render host, and "Media" is media/ on a case-insensitive disk.
  assert.throws(() => validateVideoContract(contract([{ path: "public/illustrations", mount: "Media" }])), /staticFiles\[0\]\.mount must be a lowercase relative mount path/u);
  assert.throws(() => validateVideoContract(contract([{ path: "public/Illustrations" }])), /staticFiles\[0\]\.mount must be a lowercase relative mount path/u);
  assert.deepEqual(validateVideoContract(contract([{ path: "public/illustrations" }, { path: "public/icons/key.svg", mount: "icons/key.svg" }])).brand.staticFiles, [
    { path: "public/illustrations", mount: "illustrations" },
    { path: "public/icons/key.svg", mount: "icons/key.svg" },
  ]);

  // The logo stages at its public-relative path; a mount on that path is refused at staging, before anything is overwritten.
  const workspace = await videoFixture(t, { contract: { brand: staticBrand([{ path: "public/illustrations", mount: "logo.svg" }]) } });
  const source = path.join(workspace.designSystemRoot, "public", "illustrations");
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, "key-gold.webp"), "RIFF", "utf8");
  await assert.rejects(prepareVideoWorkspace(workspace, "sample-topic"), /brand\.staticFiles\[0\]\.path: mount logo\.svg would overwrite the staged brand file logo\.svg/u);

  // A silent preview leaves the audio bed out, but a mount on the bed's public path is
  // still refused, and before anything is written: otherwise the collision would pass
  // the lab preview and surface only at the real render.
  const silent = await videoFixture(t, { contract: { brand: { ...staticBrand([{ path: "public/sound", mount: "sound" }]), audio: { bed: "public/sound/bed.mp3" } } } });
  const sound = path.join(silent.designSystemRoot, "public", "sound");
  await fs.mkdir(sound, { recursive: true });
  await fs.writeFile(path.join(sound, "bed.mp3"), "ID3", "utf8");
  const publicRoot = path.join(silent.designSystemRoot, "video-local", "preview-public");
  const loaded = await loadVideoWorkspace(silent);
  await assert.rejects(
    stageVideoBrand({ designSystemRoot: silent.designSystemRoot, contract: loaded.video.contract, publicRoot, mediaCatalog: { assets: [] }, sound: false }),
    /brand\.staticFiles\[0\]\.path: mount sound would overwrite the staged brand file sound\/bed\.mp3/u,
  );
  assert.equal(await fs.stat(publicRoot).catch(() => null), null, "nothing is staged before the collision is refused");
});

test("describes a scene's footage line once for the CLI printout and the lab UI", () => {
  assert.equal(describeSceneFootage({ intro: true, assets: ["ignored"] }), "card");
  assert.equal(describeSceneFootage({ outro: true }), "card");
  assert.equal(describeSceneFootage({ asset: "clip-a" }), "clip-a");
  assert.equal(describeSceneFootage({ assets: ["clip-a", "clip-b"] }), "clip-a → clip-b");
  assert.equal(describeSceneFootage({ visual: { kind: "subscribe" } }), "board subscribe");
  assert.equal(describeSceneFootage({ visual: { kind: "steps" }, assets: ["clip-a", "clip-b"] }), "board steps over clip-a → clip-b");
  // A compiled beat before finalize passes its own picks.
  assert.equal(describeSceneFootage({ visual: { kind: "steps" } }, ["clip-b"]), "board steps over clip-b");
  assert.equal(describeSceneFootage({}, undefined), "");
});

const DERIVED_TOKENS = {
  schemaVersion: 1,
  roles: {
    "color.accent": { token: "--gold-300", value: "#d4b876", kind: "color", source: "convention" },
    "font.display": { token: "--font-display", value: '"Cormorant Garamond",Georgia,serif', kind: "font-family", source: "convention" },
  },
  tokens: [
    { name: "--navy-900", resolved: "#0a1729", kind: "color", base: true },
    { name: "--navy-900", resolved: "#000", kind: "color", base: false },
    { name: "--gold-300", resolved: "#d4b876", kind: "color", base: true },
    { name: "--step-1", resolved: "1rem", kind: "length", base: true },
  ],
};

test("resolves brand role and token references in the video contract from derived tokens", async (t) => {
  const workspace = await videoFixture(t, {
    contract: {
      brand: {
        colors: { background: "{--navy-900}", accent: "{ color.accent }", text: "#fff" },
        fonts: { display: "{font.display}", body: "serif", ui: "sans-serif" },
        fontFiles: [{ family: "Example Serif", path: "public/example.woff2", style: "normal", weight: "700" }],
        logo: "public/logo.svg",
        series: "Answers",
        site: "example.com",
        tagline: "Clear answers.",
      },
    },
  });
  // Without derived tokens the reference is an error that names the fix.
  await assert.rejects(loadVideoWorkspace(workspace, { slug: "sample-topic" }), /brand\.colors\.background references --navy-900, but dist tokens\.json has not been derived; run timds check first/);

  await fs.mkdir(path.join(workspace.designSystemRoot, "dist"), { recursive: true });
  await fs.writeFile(path.join(workspace.designSystemRoot, "dist", "tokens.json"), JSON.stringify(DERIVED_TOKENS));
  const loaded = await loadVideoWorkspace(workspace, { slug: "sample-topic" });
  assert.equal(loaded.video.contract.brand.colors.background, "#0a1729");
  assert.equal(loaded.video.contract.brand.colors.accent, "#d4b876");
  assert.equal(loaded.video.contract.brand.colors.panel, "#0a1729");
  assert.equal(loaded.video.contract.brand.fonts.display, '"Cormorant Garamond",Georgia,serif');
  // panel defaults to the background value, so it inherits and resolves the same reference.
  assert.deepEqual(loaded.video.brandReferences.map((entry) => `${entry.field}=${entry.reference}`), [
    "brand.colors.background=--navy-900",
    "brand.colors.panel=--navy-900",
    "brand.colors.accent=color.accent",
    "brand.fonts.display=font.display",
  ]);

  // The prepared project carries values, never references, so a render host needs no tokens.
  const prepared = await prepareVideoWorkspace(workspace, "sample-topic");
  assert.equal(prepared.project.contract.brand.colors.accent, "#d4b876");
});

test("brand references must resolve to a token of the right kind", () => {
  const contract = validateVideoContract({
    schemaVersion: 1, id: "x", name: "X", fps: 30,
    formats: { longform: { width: 1920, height: 1080 }, cover: { width: 3840, height: 2160 }, short: { width: 1080, height: 1920 } },
    package: { shortCount: 0, timeZone: "UTC" },
    structure: { longform: {}, short: {} },
    brand: { colors: { background: "{--step-1}", accent: "#fc0", text: "#fff" }, fonts: {}, logo: "public/logo.svg", series: "S", site: "s.com", tagline: "T" },
  });
  assert.throws(() => resolveVideoBrand(contract, DERIVED_TOKENS), /references --step-1, which resolves to 1rem \(length\), not a color/);
  const missingRole = { ...contract, brand: { ...contract.brand, colors: { ...contract.brand.colors, background: "{color.background}" } } };
  assert.throws(() => resolveVideoBrand(missingRole, DERIVED_TOKENS), /references color\.background, which the derived tokens do not fill; map it in timds\.json brand\.roles/);
  const missingToken = { ...contract, brand: { ...contract.brand, colors: { ...contract.brand.colors, background: "{--nope}" } } };
  assert.throws(() => resolveVideoBrand(missingToken, DERIVED_TOKENS), /references --nope, which the derived tokens do not fill on :root/);
});

test("check warns when a literal brand value duplicates a derived token", async (t) => {
  const workspace = await videoFixture(t, {
    contract: {
      brand: {
        colors: { background: "#0A1729", accent: "#D4B876", text: "#fff" },
        fonts: { display: "Cormorant Garamond, Georgia, serif", body: "serif", ui: "sans-serif" },
        fontFiles: [{ family: "Example Serif", path: "public/example.woff2", style: "normal", weight: "700" }],
        logo: "public/logo.svg",
        series: "Answers",
        site: "example.com",
        tagline: "Clear answers.",
      },
    },
  });
  await fs.mkdir(path.join(workspace.designSystemRoot, "dist"), { recursive: true });
  await fs.writeFile(path.join(workspace.designSystemRoot, "dist", "tokens.json"), JSON.stringify(DERIVED_TOKENS));
  const checked = await checkVideoWorkspace(workspace, { slug: "sample-topic" });
  const drift = checked.warnings.filter((warning) => warning.includes("duplicates design token"));
  assert.deepEqual(drift, [
    'brand.colors.background "#0A1729" duplicates design token --navy-900; reference it as "{--navy-900}" so it cannot drift',
    'brand.colors.panel "#0A1729" duplicates design token --navy-900; reference it as "{--navy-900}" so it cannot drift',
    'brand.colors.accent "#D4B876" duplicates design token color.accent; reference it as "{color.accent}" so it cannot drift',
    'brand.fonts.display "Cormorant Garamond, Georgia, serif" duplicates design token font.display; reference it as "{font.display}" so it cannot drift',
  ]);
  assert.deepEqual(brandDriftWarnings(checked.video.contract, null), []);
});

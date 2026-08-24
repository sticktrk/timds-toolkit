import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkVideoWorkspace,
  normalizeVideoManifest,
  prepareVideoWorkspace,
  validateVideoContract,
} from "./video.mjs";
import { createVideoProducer } from "./video-producer.mjs";

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
  assert.match(compiled.scenes.at(-1).narration, /Example Answers at example\.com/u);
  const finalized = producer.finalizeProduction({
    schemaVersion: 1,
    compiled,
    timings: compiled.scenes.map((scene) => ({ id: scene.id, durationMs: scene.id === "records" ? 8_000 : 1_000, words: [{ text: scene.id, startMs: 0, endMs: 700 }] })),
    audioSrc: "audio.mp3",
  });
  assert.equal(finalized.coverSubject.key, "cover-subject-concern");
  assert.deepEqual(finalized.plan.scenes.find((scene) => scene.id === "records").assets, ["footage-one", "footage-two"]);
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

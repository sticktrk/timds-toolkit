// Shared test fixtures for the video workspace. Test-only: not part of the published package.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeVideoManifest } from "./video.mjs";

const sha = (seed) => seed.repeat(64).slice(0, 64);

export async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function videoFixture(t, overrides = {}) {
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

export async function labFixture(t) {
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


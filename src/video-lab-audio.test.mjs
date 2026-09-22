import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertVideoProjectStaged, checkVideoWorkspace, prepareVideoLab, runVideoLab, validateVideoContract } from "./video.mjs";
import { labFixture, writeJson } from "./video.fixture.mjs";

async function fixture(t) {
  const workspace = await labFixture(t);
  const python = path.join(workspace.designSystemRoot, "speech-fixture");
  // Exercise the real child-process boundary without a network speech service.
  await fs.writeFile(python, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const at = (flag) => args[args.indexOf(flag) + 1];
const script = JSON.parse(fs.readFileSync(at('--script'), 'utf8'));
fs.appendFileSync(path.join(process.cwd(), 'speech-calls'), script.voice + '\\n');
const lines = script.lines.map(({id, tts}) => {
  fs.writeFileSync(path.join(at('--output'), id + '.mp3'), 'spoken: ' + tts);
  return {id, durationMs: 2500, words: [{text: tts, startMs: 100, endMs: 2100}]};
});
fs.writeFileSync(at('--captions'), JSON.stringify({lines}));
`, { mode: 0o755 });
  t.mock.method(globalThis, "fetch", async () => new Response("media", { status: 200 }));
  const calls = async () => (await fs.readFile(path.join(workspace.designSystemRoot, "speech-calls"), "utf8")).trim().split("\n");
  return { workspace, python, calls };
}

test("lab preparation stages speech by default with measured captions and reuses only a complete matching take", async (t) => {
  const { workspace, python, calls } = await fixture(t);
  const first = await prepareVideoLab(workspace, "records", { python });
  assert.equal(first.project.records.production.audioSrc, undefined);
  assert.equal(first.project.records.script.voice, "en-US-AriaNeural");
  assert.equal(first.lab.timings[0].durationMs, 2500);
  assert.equal(first.project.records.captions.lines[0].words[0].startMs, 100);
  const audio = path.join(first.publicRoot, "audio/records/intro.mp3");
  assert.match(await fs.readFile(audio, "utf8"), /spoken: Should I keep these records\?/u);
  await prepareVideoLab(workspace, "records", { python });
  assert.equal((await calls()).length, 1);
  const caches = path.join(workspace.designSystemRoot, "video-local/lab/records/voiceover");
  const [key] = await fs.readdir(caches);
  await fs.writeFile(path.join(caches, key, "intro.mp3"), "");
  await prepareVideoLab(workspace, "records", { python });
  assert.equal((await calls()).length, 2, "empty speech is regenerated with its timings");
  const inputPath = path.join(workspace.designSystemRoot, "video/lab/records.json");
  const input = JSON.parse(await fs.readFile(inputPath, "utf8"));
  input.exactQuestion = "Should I save these records?";
  await writeJson(inputPath, input);
  await prepareVideoLab(workspace, "records", { python });
  assert.equal((await calls()).length, 3);
  assert.match(await fs.readFile(audio, "utf8"), /spoken: Should I save these records\?/u);
  await prepareVideoLab(workspace, "records", { python, voice: "en-GB-SoniaNeural" });
  assert.equal((await calls()).at(-1), "en-GB-SoniaNeural");
  assert.equal((await calls()).length, 4);
});

test("planning and explicit silent previews never invoke speech synthesis", async (t) => {
  const { workspace } = await fixture(t);
  const unavailablePython = "/not/a/python";
  await runVideoLab(workspace, "records", { plan: true, python: unavailablePython });
  const silent = await runVideoLab(workspace, "records", { prepare: true, silent: true, python: unavailablePython });
  assert.equal(silent.project.records.production.audioSrc, null);
  assert.equal(silent.lab.timings[0].durationMs, 2000);
  await assert.rejects(fs.access(path.join(workspace.designSystemRoot, "speech-calls")));
});

test("speech failures stop preparation instead of producing a silent result", async (t) => {
  const { workspace } = await fixture(t);
  await assert.rejects(prepareVideoLab(workspace, "records", { python: "/not/a/python" }), /Video Lab narration failed.*edge-tts/u);
  await assert.rejects(fs.access(path.join(workspace.designSystemRoot, "video-local/lab/records/generated/records.mjs")));
});

async function withSoundDesign(workspace, audio) {
  const contractPath = path.join(workspace.designSystemRoot, "video/contract.json");
  const contract = JSON.parse(await fs.readFile(contractPath, "utf8"));
  contract.voiceover = { voice: "en-GB-SoniaNeural", rate: "+5%", pitch: "-2Hz" };
  contract.brand.audio = audio;
  await writeJson(contractPath, contract);
  const mediaPath = path.join(workspace.designSystemRoot, "media.json");
  const media = JSON.parse(await fs.readFile(mediaPath, "utf8"));
  if (!media.assets.some((asset) => asset.key === "brand-bed")) media.assets.push({ id: "brand-bed-id", key: "brand-bed", kind: "audio", title: "Bed", filename: "bed.mp3", contentType: "audio/mpeg", publicUrl: "https://media.example.com/bed.mp3", sha256: "c".repeat(64), bytes: 5 });
  await writeJson(mediaPath, media);
  return contract;
}

test("published and committed sound design reach the prepared lab project", async (t) => {
  const { workspace, python } = await fixture(t);
  await fs.writeFile(path.join(workspace.designSystemRoot, "public/whoosh.mp3"), "whoosh");
  await withSoundDesign(workspace, { bed: { mediaKey: "brand-bed" }, transition: "public/whoosh.mp3", voiceGain: 0.8 });
  const result = await prepareVideoLab(workspace, "records", { python });
  const { audio } = result.project.contract.brand;
  assert.equal(result.project.records.script.rate, "+5%");
  assert.equal(result.project.records.script.voice, "en-GB-SoniaNeural");
  assert.equal(audio.voiceGain, 0.8);
  assert.equal(audio.bed, "brand/audio-bed-brand-bed.mp3");
  assert.equal(audio.transition, "whoosh.mp3");
  assert.equal(await fs.readFile(path.join(result.publicRoot, audio.bed), "utf8"), "media");
  assert.equal(await fs.readFile(path.join(result.publicRoot, audio.transition), "utf8"), "whoosh");
});

test("sound design generated under video-local fails check and the lab instead of rendering without it", async (t) => {
  const { workspace, python } = await fixture(t);
  await withSoundDesign(workspace, { bed: "video-local/public/audio/bed/music.mp3" });
  const source = path.join(workspace.designSystemRoot, "video-local/public/audio/bed/music.mp3");
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, "music");
  await assert.rejects(checkVideoWorkspace(workspace), /brand\.audio\.bed: video-local\/public\/audio\/bed\/music\.mp3 is generated under ignored video-local\//u);
  await assert.rejects(prepareVideoLab(workspace, "records", { python }), /brand\.audio\.bed/u);
  await assert.rejects(prepareVideoLab(workspace, "records", { python, silent: true }), /brand\.audio\.bed/u, "a broken contract fails silent previews too");
});

test("missing, unpublished, and git-ignored sound design is refused with the field that names it", async (t) => {
  const { workspace } = await fixture(t);
  await withSoundDesign(workspace, { bed: "audio/bed/acme-bed.mp3", transition: { mediaKey: "never-published" } });
  await assert.rejects(checkVideoWorkspace(workspace), (error) => {
    assert.match(error.message, /brand\.audio\.bed: audio\/bed\/acme-bed\.mp3 is not a committed file/u);
    assert.match(error.message, /brand\.audio\.transition: media key never-published is not registered in media\.json/u);
    return true;
  });
  const root = workspace.designSystemRoot;
  execFileSync("git", ["init", "-q", root]);
  await fs.writeFile(path.join(root, ".gitignore"), "*.mp3\n");
  await fs.mkdir(path.join(root, "audio/bed"), { recursive: true });
  await fs.writeFile(path.join(root, "audio/bed/acme-bed.mp3"), "music");
  await withSoundDesign(workspace, { bed: "audio/bed/acme-bed.mp3" });
  await assert.rejects(checkVideoWorkspace(workspace), /brand\.audio\.bed: audio\/bed\/acme-bed\.mp3 is ignored by git/u);
});

test("silent previews stage no sound design", async (t) => {
  const { workspace } = await fixture(t);
  await withSoundDesign(workspace, { bed: { mediaKey: "brand-bed" }, voiceGain: 0.8 });
  const result = await prepareVideoLab(workspace, "records", { silent: true });
  assert.deepEqual(result.project.contract.brand.audio, { voiceGain: 0.8 });
});

test("a staged project names every requested file that is missing before Remotion starts", async (t) => {
  const publicRoot = await fs.mkdtemp(path.join(os.tmpdir(), "timds-staged-"));
  t.after(() => fs.rm(publicRoot, { force: true, recursive: true }));
  await fs.writeFile(path.join(publicRoot, "logo.svg"), "<svg/>");
  const project = {
    contract: { brand: { logo: "logo.svg", fontFiles: [{ path: "font.woff2", dataBase64: "AA==" }], audio: { bed: "audio/bed/acme-bed.mp3" } } },
    assets: { cover: { src: "media/cover.jpg" } },
    records: { production: { slug: "records" }, captions: { lines: [{ id: "intro" }] } },
  };
  await assert.rejects(assertVideoProjectStaged(project, publicRoot), (error) => {
    assert.match(error.message, /contract\.brand\.audio\.bed -> audio\/bed\/acme-bed\.mp3/u);
    assert.match(error.message, /assets\.cover\.src -> media\/cover\.jpg/u);
    assert.match(error.message, /narration for line intro -> audio\/records\/intro\.mp3/u);
    assert.doesNotMatch(error.message, /logo|font/u);
    return true;
  });
  project.records.production.audioSrc = null;
  delete project.contract.brand.audio;
  delete project.assets.cover;
  await assertVideoProjectStaged(project, publicRoot);
});

test("the contract validates sound-design sources and levels", () => {
  const contract = (audio) => ({ schemaVersion: 1, id: "x", name: "X", brand: { colors: { background: "#000", accent: "#fff", text: "#fff" }, logo: "public/logo.svg", series: "S", site: "s.com", tagline: "T", audio } });
  assert.deepEqual(validateVideoContract(contract({ bed: { mediaKey: "brand-bed" }, duckVolume: "0.3" })).brand.audio, { bed: { mediaKey: "brand-bed" }, duckVolume: 0.3 });
  assert.throws(() => validateVideoContract(contract({ bed: "../outside.mp3" })), /brand\.audio\.bed must stay inside the Design System/u);
  assert.throws(() => validateVideoContract(contract({ bed: { url: "https://x" } })), /brand\.audio\.bed\.mediaKey is required/u);
  assert.throws(() => validateVideoContract(contract({ attackFrames: 1.5 })), /attackFrames must be a non-negative integer/u);
  assert.equal(validateVideoContract(contract(undefined)).brand.audio, undefined);
});

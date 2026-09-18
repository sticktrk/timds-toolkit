import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { prepareVideoLab, runVideoLab } from "./video.mjs";
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

test("contract voice settings and available sound-design files reach the prepared lab project", async (t) => {
  const { workspace, python } = await fixture(t);
  const contractPath = path.join(workspace.designSystemRoot, "video/contract.json");
  const contract = JSON.parse(await fs.readFile(contractPath, "utf8"));
  contract.voiceover = { voice: "en-GB-SoniaNeural", rate: "+5%", pitch: "-2Hz" };
  contract.brand.audio = { bed: "audio/bed/music.mp3", transition: "audio/bed/missing.mp3", voiceGain: 0.8 };
  await writeJson(contractPath, contract);
  const source = path.join(workspace.designSystemRoot, "video-local/public/audio/bed/music.mp3");
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, "music");
  const result = await prepareVideoLab(workspace, "records", { python });
  assert.equal(result.project.records.script.rate, "+5%");
  assert.equal(result.project.records.script.pitch, "-2Hz");
  assert.equal(result.project.records.script.voice, "en-GB-SoniaNeural");
  assert.equal(result.project.contract.brand.audio.voiceGain, 0.8);
  assert.equal(result.project.contract.brand.audio.transition, undefined);
  assert.equal(await fs.readFile(path.join(result.publicRoot, contract.brand.audio.bed), "utf8"), "music");
});

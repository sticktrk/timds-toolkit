import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {z} from "zod/v3";
import {createVideoAuthoringContract, createVideoProducer} from "./video-producer.mjs";
import {VideoAuthoringContractSchema, VideoCompiledProductionSchema, VideoFootageCatalogSchema, safeParseVideoAuthoringContract, safeParseVideoCompiledProduction, safeParseVideoFootageCatalog} from "./video-transport.mjs";

function fixture() {
  const contract = JSON.parse(readFileSync(new URL("../templates/video/contract.json", import.meta.url), "utf8"));
  contract.producer.footage = {assetPrefixes: ["road-", "indoor-"]};
  contract.producer.engagement.enabled = false;
  const assetCatalog = {assets: {
    "road-traffic": {mediaKey: "road-traffic", durationSeconds: 6, vertical: "road-traffic-vertical"},
    "road-traffic-vertical": {mediaKey: "road-traffic-vertical", durationSeconds: 6},
    "indoor-records": {mediaKey: "indoor-records", durationSeconds: 8, vertical: "indoor-records-vertical"},
    "indoor-records-vertical": {mediaKey: "indoor-records-vertical", durationSeconds: 8},
    "cover-subject-concern": {mediaKey: "cover-subject-concern", contentType: "image/png"},
  }};
  const mediaCatalog = {assets: Object.keys(assetCatalog.assets).map((key) => ({
    key, filename: `${key}.${key.startsWith("cover-") ? "png" : "mp4"}`, publicUrl: `https://example.com/${key}`, title: key,
  }))};
  return {contract, assetCatalog, mediaCatalog};
}

const authoringFor = (source, outputFormat) => createVideoAuthoringContract({
  ...source, outputFormat,
  manifest: {systemId: "example/core", name: "Example", version: "1.0.0"},
  designSystemIndex: {system: {id: "example/core", version: "1.0.0"}, pages: []},
  provenance: {version: "1.0.0", commit: "a".repeat(40)},
});

test("shared validators round-trip real authoring, compilation, and finalization in both formats", () => {
  const source = fixture();
  const producer = createVideoProducer(source);
  for (const outputFormat of ["horizontal", "short"]) {
    const authoring = authoringFor(source, outputFormat);
    assert.deepEqual(VideoAuthoringContractSchema.parse(JSON.parse(JSON.stringify(authoring))), authoring);
    assert.deepEqual(authoring.footage.assetPrefixes, ["road-", "indoor-"]);
    assert.equal(authoring.footage.assetPrefix, undefined);
    const compiled = producer.compileProduction({
      schemaVersion: 1, slug: `transport-${outputFormat}`, outputFormat,
      exactQuestion: "What records should you keep?", topic: {label: "important records"},
      answerBeats: [{id: "records", role: "rule", narration: "Keep clear records.", summary: "Keep clear records", footage: [authoring.footage.clips[0].key]}],
    });
    const parsed = VideoCompiledProductionSchema.parse(JSON.parse(JSON.stringify(compiled)));
    assert.deepEqual(parsed, compiled);
    const finalized = producer.finalizeProduction({
      schemaVersion: 1, compiled: parsed, audioSrc: null,
      timings: compiled.scenes.map((scene) => ({id: scene.id, durationMs: 3000, words: []})),
    });
    assert.deepEqual(finalized.runtime, compiled.runtime);
  }
});

test("legacy authoring, single-prefix catalogs, and saved compilations remain readable", () => {
  const source = fixture();
  const current = authoringFor(source, "short");
  const legacyFootage = {assetPrefix: "road-", maximumPerBeat: 3, clips: [current.footage.clips.find((clip) => clip.key.startsWith("road-"))]};
  assert.deepEqual(VideoFootageCatalogSchema.parse(legacyFootage), {...legacyFootage, assetPrefixes: ["road-"]});
  const legacy = {...current, schemaVersion: 1, runtime: undefined, footage: legacyFootage};
  legacy.constraints.exactQuestion = {...legacy.constraints.exactQuestion, maximumWords: null, maximumCharacters: null};
  const parsed = VideoAuthoringContractSchema.parse(legacy);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.runtime, undefined);
  assert.equal(parsed.constraints.exactQuestion.maximumWords, null);
  const producer = createVideoProducer(source);
  const compiled = producer.compileProduction({schemaVersion: 1, slug: "legacy", outputFormat: "short", exactQuestion: "What records matter?", topic: {label: "important records"}, answerBeats: [{id: "records", role: "rule", narration: "Keep records.", summary: "Keep records"}]});
  delete compiled.runtime;
  assert.deepEqual(VideoCompiledProductionSchema.parse(compiled), compiled);
});

test("preserves additive TimDS fields and application metadata without copying response schemas", () => {
  const current = authoringFor(fixture(), "short");
  current.extra = {future: true};
  current.constraints.futureLimit = 10;
  current.runtime.futureFeature = true;
  current.footage.clips[0].futureMetadata = {reviewed: true};
  current.publishing = {brief: "Keep the answer clear."};
  const composed = VideoAuthoringContractSchema.and(z.object({publishing: z.object({brief: z.string().min(1)})}));
  assert.deepEqual(composed.parse(current), current);
  assert.throws(() => composed.parse({...current, publishing: {brief: ""}}));
  const compiled = createVideoProducer(fixture()).compileProduction({schemaVersion: 1, slug: "future", outputFormat: "short", exactQuestion: "What records matter?", topic: {label: "important records"}, answerBeats: [{id: "records", role: "rule", narration: "Keep records.", summary: "Keep records"}]});
  compiled.future = true;
  compiled.topic.future = true;
  compiled.scenes[1].visual = {kind: "custom-board", nested: {items: [{label: "Keep records"}]}};
  compiled.scenes[1].future = true;
  compiled.cover.future = true;
  assert.deepEqual(VideoCompiledProductionSchema.parse(compiled), compiled);
});

test("rejects malformed catalogs, unsupported versions, and invalid runtime identity", () => {
  const current = authoringFor(fixture(), "short");
  for (const footage of [
    {...current.footage, assetPrefixes: undefined}, {...current.footage, assetPrefixes: []},
    {...current.footage, assetPrefixes: [""]}, {...current.footage, assetPrefix: "road-"},
    {...current.footage, clips: []}, {...current.footage, maximumPerBeat: 0},
    {...current.footage, clips: [{...current.footage.clips[0], durationSeconds: 0}]},
  ]) assert.equal(VideoFootageCatalogSchema.safeParse(footage).success, false);
  assert.equal(VideoAuthoringContractSchema.safeParse({...current, schemaVersion: 3}).success, false);
  assert.equal(VideoAuthoringContractSchema.safeParse({...current, runtime: {...current.runtime, features: "unsupported"}}).success, false);
  const compiled = createVideoProducer(fixture()).compileProduction({schemaVersion: 1, slug: "invalid", outputFormat: "short", exactQuestion: "What records matter?", topic: {label: "important records"}, answerBeats: [{id: "records", role: "rule", narration: "Keep records.", summary: "Keep records"}]});
  assert.equal(VideoCompiledProductionSchema.safeParse({...compiled, scenes: []}).success, false);
  assert.equal(VideoCompiledProductionSchema.safeParse({...compiled, runtime: {...compiled.runtime, componentApi: 0}}).success, false);
});

test("plain validation functions use the same schemas and report issue paths", () => {
  const authoring = authoringFor(fixture(), "short");
  assert.deepEqual(safeParseVideoAuthoringContract(authoring), {success: true, data: authoring});
  assert.deepEqual(safeParseVideoFootageCatalog(authoring.footage), {success: true, data: authoring.footage});
  const result = safeParseVideoAuthoringContract({...authoring, footage: {...authoring.footage, assetPrefixes: []}});
  assert.equal(result.success, false);
  assert.deepEqual(result.error.issues[0].path, ["footage", "assetPrefixes"]);
  assert.equal(safeParseVideoCompiledProduction({schemaVersion: 2}).success, false);
});

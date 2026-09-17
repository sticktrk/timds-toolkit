import assert from "node:assert/strict";
import test from "node:test";
import {
  FOOTAGE_DERIVATIVE_SUFFIXES,
  MINIMUM_CHAIN_CLIP_SECONDS,
  adjacentFootageRepeats,
  chainClipFrames,
  footageFamily,
  sceneAssetKeys,
  truncatedHeadline,
  verticalTextZone,
} from "./footage.mjs";

test("treats offset, mirrored, and vertical derivatives as one footage family", () => {
  assert.deepEqual([...FOOTAGE_DERIVATIVE_SUFFIXES], ["-vertical", "-mirrored", "-offset"]);
  assert.equal(footageFamily("footage-bank-teller-mirrored"), "footage-bank-teller");
  assert.equal(footageFamily("footage-bank-teller-vertical"), "footage-bank-teller");
  assert.equal(footageFamily("footage-envelope-offset"), "footage-envelope");
  assert.equal(footageFamily("footage-envelope-offset-vertical"), "footage-envelope");
  assert.equal(footageFamily("footage-family-home"), "footage-family-home");
});

test("reads a scene's chain from assets, then asset, then nothing", () => {
  assert.deepEqual(sceneAssetKeys({ id: "a", assets: ["x", "y"], asset: "z" }), ["x", "y"]);
  assert.deepEqual(sceneAssetKeys({ id: "a", asset: "z" }), ["z"]);
  assert.deepEqual(sceneAssetKeys({ id: "outro", outro: true }), []);
});

test("keeps the minimum cut long enough to read as an intentional edit", () => {
  assert.equal(MINIMUM_CHAIN_CLIP_SECONDS, 2);
});

test("resolves reviewed and legacy headline placements to their vertical zone", () => {
  for (const text of ["lower", "bottom", "left-bottom", "right-bottom"]) assert.equal(verticalTextZone(text), "lower");
  for (const text of [undefined, "upper", "left-center", "right-center"]) assert.equal(verticalTextZone(text), "upper");
});

test("gives the last chain clip its minimum screen time by cutting the previous clip early", () => {
  // 30fps: a 300-frame clip followed by a clip that would only show 35 frames.
  assert.deepEqual(chainClipFrames([300, 240], 335, 60), [275, 60]);
});

test("leaves chains alone when every clip already meets the minimum", () => {
  assert.deepEqual(chainClipFrames([300, 240], 420, 60), [300, 120]);
  assert.deepEqual(chainClipFrames([300], 240, 60), [240]);
});

test("never freezes a clip past its natural length or starves the previous clip", () => {
  assert.deepEqual(chainClipFrames([300, 45], 335, 60), [290, 45]);
  assert.deepEqual(chainClipFrames([70, 240], 100, 60), [60, 40]);
});

test("finds back-to-back footage inside a chain and across a scene boundary", () => {
  const repeats = adjacentFootageRepeats([
    { id: "hook", assets: ["footage-one", "footage-one-mirrored"] },
    { id: "rule", assets: ["footage-two"] },
    { id: "risk", asset: "footage-two-vertical" },
  ]);
  assert.deepEqual(repeats.map((repeat) => [repeat.previous.scene, repeat.current.scene]), [["hook", "hook"], ["rule", "risk"]]);
});

test("lets intro and outro cards break the footage sequence", () => {
  assert.deepEqual(adjacentFootageRepeats([
    { id: "hook", asset: "footage-one" },
    { id: "intro", intro: true },
    { id: "rule", asset: "footage-one" },
    { id: "outro", outro: true },
  ]), []);
});

test("rejects headlines that end on a dangling word", () => {
  assert.equal(truncatedHeadline("What the bank's"), true);
  assert.equal(truncatedHeadline("Keep every record together and"), true);
  assert.equal(truncatedHeadline("Talk to the"), true);
  assert.equal(truncatedHeadline("Keep every record together."), false);
  assert.equal(truncatedHeadline("Who inherits the house?"), false);
  assert.equal(truncatedHeadline(""), false);
});

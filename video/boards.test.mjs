import assert from "node:assert/strict";
import test from "node:test";
import {DEFAULT_BOARD_KINDS, deriveVideoChapters, normalizeCueWord, revealFrame, titleCaseChapterId} from "./boards.mjs";

test("lists the default board kinds in shelf order", () => {
  assert.deepEqual([...DEFAULT_BOARD_KINDS], ["chapter-title", "statement", "cards", "compare", "flow", "steps", "document", "subscribe"]);
  assert.ok(Object.isFrozen(DEFAULT_BOARD_KINDS));
});

test("normalizes cue and caption words to one comparable form", () => {
  assert.equal(normalizeCueWord("Deed,"), "deed");
  assert.equal(normalizeCueWord("  DEED!  "), "deed");
  assert.equal(normalizeCueWord("Café"), "cafe");
  assert.equal(normalizeCueWord("30-day"), "30day");
  assert.equal(normalizeCueWord(undefined), "");
  assert.equal(titleCaseChapterId("two-jobs"), "Two Jobs");
});

test("labels chapters from their first chapter-title board, otherwise from the id", () => {
  const chapters = deriveVideoChapters([
    {id: "intro"},
    {id: "a", chapter: "two-jobs"},
    {id: "b", chapter: "two-jobs", visual: {kind: "chapter-title", number: 1, title: " What each does "}},
    {id: "c", chapter: "two-jobs", visual: {kind: "chapter-title", number: 1, title: "Ignored second title"}},
    {id: "d", chapter: "next-steps", visual: {kind: "cards", title: "Not a chapter title"}},
    {id: "e", chapter: "next-steps"},
  ]);
  assert.deepEqual(chapters, [
    {id: "two-jobs", label: "What each does"},
    {id: "next-steps", label: "Next Steps"},
  ]);
  assert.deepEqual(deriveVideoChapters(undefined), []);
});

test("lands a cued reveal on the spoken word and spreads the rest evenly", () => {
  const words = [{text: "First,", startMs: 0, endMs: 300}, {text: "the", startMs: 300, endMs: 400}, {text: "Deed.", startMs: 1000, endMs: 1400}];
  assert.equal(revealFrame({cue: "deed", words, index: 0, count: 3, duration: 90, lead: 6, fps: 30}), 36);
  // An unspoken cue and a missing cue share the even spread.
  const spread = revealFrame({cue: "will", words, index: 1, count: 3, duration: 90, lead: 6, fps: 30});
  assert.equal(spread, revealFrame({words, index: 1, count: 3, duration: 90, lead: 6, fps: 30}));
  assert.equal(spread, 6 + Math.round(84 * 1.5 / 3.5));
  const first = revealFrame({words, index: 0, count: 3, duration: 90, lead: 6, fps: 30});
  const last = revealFrame({words, index: 2, count: 3, duration: 90, lead: 6, fps: 30});
  assert.ok(first < spread && spread < last && last < 90, "the spread keeps order and ends inside the scene");
});

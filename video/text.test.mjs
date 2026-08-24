import assert from "node:assert/strict";
import test from "node:test";
import {splitGoldHeadline} from "./text.mjs";

test("preserves the separator before a final highlighted cover word", () => {
  const parts = splitGoldHeadline(
    "How do I prove I am authorized to request financial records for an estate?",
  );

  assert.equal(parts.before.slice(-3), "an\u00a0");
  assert.equal(parts.highlighted, "estate?");
  assert.equal(
    `${parts.before}${parts.highlighted}${parts.after}`,
    "How do I prove I am authorized to request financial records for an\u00a0estate?",
  );
});

test("highlights only an explicit phrase and preserves both boundaries", () => {
  const parts = splitGoldHeadline(
    "The estate plan protects the family.",
    "estate plan",
  );

  assert.deepEqual(parts, {
    before: "The ",
    highlighted: "estate plan",
    after: " protects the\u00a0family.",
  });
});

test("keeps the complete headline when an explicit phrase is absent", () => {
  const parts = splitGoldHeadline("Protect the family.", "missing phrase");

  assert.deepEqual(parts, {
    before: "Protect the\u00a0family.",
    highlighted: "",
    after: "",
  });
});

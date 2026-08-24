import assert from "node:assert/strict";
import test from "node:test";
import {fitCoverHeadline, splitGoldHeadline, tieOrphan} from "./text.mjs";

test("preserves the separator before a final highlighted cover word", () => {
  const parts = splitGoldHeadline(
    "How do I prove I am authorized to request financial records for an estate?",
  );

  assert.equal(parts.before.slice(-4), "an \u2060");
  assert.equal(parts.highlighted, "estate?");
  assert.equal(
    `${parts.before}${parts.highlighted}${parts.after}`,
    "How do I prove I am authorized to request financial records for an \u2060estate?",
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
    after: " protects the \u2060family.",
  });
});

test("keeps the complete headline when an explicit phrase is absent", () => {
  const parts = splitGoldHeadline("Protect the family.", "missing phrase");

  assert.deepEqual(parts, {
    before: "Protect the \u2060family.",
    highlighted: "",
    after: "",
  });
});

test("ties the final pair with a visible normal space", () => {
  assert.equal(tieOrphan("move forward?"), "move \u2060forward?");
});

test("fits long vertical-cover questions inside the default text box", () => {
  const short = fitCoverHeadline("Who inherits?");
  const long = fitCoverHeadline("How do I prove I am authorized to request financial records for an estate?");

  assert.equal(short, 120);
  assert.ok(long < short);
  assert.ok(long >= 4);
});

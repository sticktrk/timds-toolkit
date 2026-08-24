import assert from "node:assert/strict";
import test from "node:test";
import {
  Cover,
  defaultVideoProjectComponents,
  resolveVideoProjectComponents,
} from "./remotion.tsx";
import type {VideoProjectCoverProps} from "./remotion.tsx";

const GeneralCover = (_props: VideoProjectCoverProps) => null;
const VerticalCover = (_props: VideoProjectCoverProps) => null;

test("uses TimDS Remotion components as the defaults", () => {
  const resolved = resolveVideoProjectComponents();

  assert.equal(resolved.Cover, Cover);
  assert.equal(resolved.HorizontalCover, Cover);
  assert.equal(resolved.VerticalCover, Cover);
  assert.equal(defaultVideoProjectComponents.Cover, Cover);
});

test("allows a Design System to replace all covers or one format", () => {
  const general = resolveVideoProjectComponents({Cover: GeneralCover});
  assert.equal(general.HorizontalCover, GeneralCover);
  assert.equal(general.VerticalCover, GeneralCover);

  const formatSpecific = resolveVideoProjectComponents({
    Cover: GeneralCover,
    VerticalCover,
  });
  assert.equal(formatSpecific.HorizontalCover, GeneralCover);
  assert.equal(formatSpecific.VerticalCover, VerticalCover);
});

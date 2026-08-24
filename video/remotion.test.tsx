import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {
  Cover,
  defaultVideoProjectComponents,
  GoldHeadline,
  HorizontalCover,
  resolveCoverObjectPosition,
  resolveVideoProjectComponents,
  VerticalCover,
} from "./remotion.tsx";
import type {VideoProjectCoverProps} from "./remotion.tsx";

const GeneralCover = (_props: VideoProjectCoverProps) => null;
const CustomVerticalCover = (_props: VideoProjectCoverProps) => null;

test("uses TimDS Remotion components as the defaults", () => {
  const resolved = resolveVideoProjectComponents();

  assert.equal(resolved.Cover, Cover);
  assert.equal(resolved.HorizontalCover, HorizontalCover);
  assert.equal(resolved.VerticalCover, VerticalCover);
  assert.equal(defaultVideoProjectComponents.Cover, Cover);
});

test("allows a Design System to replace all covers or one format", () => {
  const general = resolveVideoProjectComponents({Cover: GeneralCover});
  assert.equal(general.HorizontalCover, GeneralCover);
  assert.equal(general.VerticalCover, GeneralCover);

  const formatSpecific = resolveVideoProjectComponents({
    Cover: GeneralCover,
    VerticalCover: CustomVerticalCover,
  });
  assert.equal(formatSpecific.HorizontalCover, GeneralCover);
  assert.equal(formatSpecific.VerticalCover, CustomVerticalCover);
});

test("uses cover and asset positions before the default aspect-ratio crop", () => {
  const asset = {key: "cover", src: "cover.jpg", objectPosition: "72% 40%"};

  assert.equal(resolveCoverObjectPosition({asset: "cover"}, asset, true), "72% 40%");
  assert.equal(resolveCoverObjectPosition({asset: "cover", objectPosition: "25% 60%"}, asset, true), "25% 60%");
  assert.equal(resolveCoverObjectPosition({asset: "cover"}, {key: "cover", src: "cover.jpg"}, true), "67% 50%");
  assert.equal(resolveCoverObjectPosition({asset: "cover"}, {key: "cover", src: "cover.jpg"}), "50% 50%");
});

test("renders a visible space before a tied highlighted final word", () => {
  const markup = renderToStaticMarkup(<GoldHeadline
    headline="What can I do before probate can move forward?"
    goldPhrase="forward?"
    color="#d4b876"
  />);

  assert.match(markup, /move \u2060<span/u);
});

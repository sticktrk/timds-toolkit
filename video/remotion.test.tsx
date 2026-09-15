import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {
  BrandWatermark,
  Cover,
  defaultVideoProjectComponents,
  GoldHeadline,
  HORIZONTAL_COVER_DESIGN_HEIGHT,
  HORIZONTAL_COVER_DESIGN_WIDTH,
  HorizontalCover,
  horizontalCoverScale,
  resolveCoverObjectPosition,
  resolveVideoProjectComponents,
  videoFontDeclaration,
  videoFontLoadWeight,
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

test("loads a valid representative weight for a variable font range", () => {
  assert.equal(videoFontLoadWeight("400 700"), "700");
  assert.equal(videoFontDeclaration({family: "Instrument Sans", path: "instrument.ttf", weight: "400 700"}), 'normal 700 16px "Instrument Sans"');
});

test("scales the horizontal design grid to a high-resolution cover", () => {
  assert.equal(HORIZONTAL_COVER_DESIGN_WIDTH, 1280);
  assert.equal(HORIZONTAL_COVER_DESIGN_HEIGHT, 720);
  assert.equal(horizontalCoverScale(3840), 3);
});

const bannerProject = (banners: unknown) => ({
  schemaVersion: 1 as const,
  engine: {name: "@dtconcepts/timds", version: "0.0.0"},
  contract: {
    brand: {
      colors: {background: "#000", panel: "#111", accent: "#fc0", text: "#fff", muted: "#eee"},
      fonts: {display: "serif", body: "serif", ui: "sans-serif"},
      logo: "logo.svg",
      watermark: {left: "Example series", right: "example.com/a-long-path"},
      banners,
    },
  },
  assets: {},
  records: {captions: {lines: []}, production: {}, publishing: {}, request: {}, script: {}},
});

test("keeps the persistent CTA banners on every frame and off the Shorts UI edge", () => {
  const banners = {longform: "Subscribe for more", short: {kicker: "Learn more", url: "example.com/start"}};

  const horizontal = renderToStaticMarkup(<BrandWatermark project={bannerProject(banners)} sceneHasLogo />);
  assert.match(horizontal, /data-banner="longform"/u);
  assert.match(horizontal, /Subscribe for more/u);
  assert.doesNotMatch(horizontal, /data-banner="short"/u);
  assert.match(horizontal, /example\.com\/a-long-path/u);

  const vertical = renderToStaticMarkup(<BrandWatermark project={bannerProject(banners)} vertical sceneHasLogo />);
  assert.match(vertical, /data-banner="short"/u);
  assert.match(vertical, /Learn more/u);
  assert.match(vertical, /example\.com\/start/u);
  assert.doesNotMatch(vertical, /data-banner="longform"/u);
  // (sceneHasLogo skips Remotion's <Img>, which needs a composition context)
  // the banner replaces the bottom-right label, so nothing shares the baseline with watermark.left
  assert.doesNotMatch(vertical, /example\.com\/a-long-path/u);
  assert.match(vertical, /Example series/u);
});

test("stacks the vertical watermark labels when no Short banner is configured", () => {
  const vertical = renderToStaticMarkup(<BrandWatermark project={bannerProject(undefined)} vertical sceneHasLogo />);
  assert.match(vertical, /example\.com\/a-long-path/u);
  assert.match(vertical, /Example series/u);
  assert.doesNotMatch(vertical, /right:150px/u);
  assert.doesNotMatch(vertical, /data-banner=/u);

  const horizontal = renderToStaticMarkup(<BrandWatermark project={bannerProject(undefined)} sceneHasLogo />);
  assert.match(horizontal, /right:48px/u);
  assert.doesNotMatch(horizontal, /data-banner=/u);
});

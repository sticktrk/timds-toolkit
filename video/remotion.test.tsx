import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {Internals, staticFile} from "remotion";
import {DEFAULT_BOARD_KINDS, revealFrame} from "./boards.mjs";
import {
  BrandWatermark,
  CardsBoard,
  ChapterTitleBoard,
  CompareBoard,
  Cover,
  defaultVideoBoardKinds,
  defaultVideoProjectComponents,
  deriveVideoChapters,
  DocumentBoard,
  FlowBoard,
  StatementBoard,
  StepsBoard,
  SubscribeBoard,
  resolveVideoBoardComponent,
  videoBoardMotifSrc,
  GoldHeadline,
  GraphicBoard,
  HORIZONTAL_COVER_DESIGN_HEIGHT,
  HORIZONTAL_COVER_DESIGN_WIDTH,
  HorizontalCover,
  horizontalCoverScale,
  resolveCoverObjectPosition,
  resolveVideoProjectComponents,
  SceneView,
  videoFontDeclaration,
  videoFontLoadWeight,
  VerticalCover,
} from "./remotion.tsx";
import type {VideoProjectBoardProps, VideoProjectCoverProps, VideoProjectGraphicProps} from "./remotion.tsx";

const GeneralCover = (_props: VideoProjectCoverProps) => null;
const ClientBoard = (_props: VideoProjectGraphicProps) => null;
const CustomVerticalCover = (_props: VideoProjectCoverProps) => null;

test("uses TimDS Remotion components as the defaults", () => {
  const resolved = resolveVideoProjectComponents();

  assert.equal(resolved.Cover, Cover);
  assert.equal(resolved.HorizontalCover, HorizontalCover);
  assert.equal(resolved.VerticalCover, VerticalCover);
  assert.equal(resolved.Graphic, GraphicBoard);
  assert.equal(defaultVideoProjectComponents.Cover, Cover);
  assert.equal(defaultVideoProjectComponents.Graphic, GraphicBoard);
});

test("lets a Design System own graphic boards without replacing the whole scene", () => {
  const resolved = resolveVideoProjectComponents({Graphic: ClientBoard});
  assert.equal(resolved.Graphic, ClientBoard);
  assert.equal(resolved.Scene, defaultVideoProjectComponents.Scene, "the TimDS scene still mounts footage, watermark, and captions around the client board");
});

test("the default board shows the scene copy and leaves the board data to the Design System", () => {
  const project = {
    schemaVersion: 1 as const,
    engine: {name: "timds", version: "0"},
    contract: {fps: 30, copy: {captionPageWords: 5}, brand: {colors: {background: "#101820", panel: "#101820", accent: "#d5b66f", text: "#fff", muted: "#eee"}, fonts: {display: "serif", body: "serif", ui: "sans-serif"}}},
    assets: {},
    records: {captions: {lines: []}, production: {}, publishing: {}, request: {}, script: {}},
  };
  const scene = {id: "board", eyebrow: "The rule", headline: "Two documents, two jobs", visual: {kind: "steps", steps: [{label: "Pull the deed"}]}};
  const line = {id: "board", durationMs: 1000, words: []};
  const markup = renderToStaticMarkup(<GraphicBoard project={project} scene={scene} visual={scene.visual} line={line} duration={30} lead={0} overFootage={false} />);
  assert.match(markup, /background-color:#101820/u);
  assert.match(markup, /The rule/u);
  assert.match(markup, /Two documents, two .*<span[^>]*>jobs<\/span>/u, "the headline keeps the default gold final word");
  assert.doesNotMatch(markup, /Pull the deed/u, "board data is the client's to draw");
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

const boardProject = (extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1 as const,
  engine: {name: "@dtconcepts/timds", version: "0.0.0"},
  contract: {
    fps: 30,
    copy: {captionPageWords: 5},
    brand: {colors: {background: "#101820", panel: "#1b2733", accent: "#d5b66f", text: "#ffffff", muted: "#c8ccd0"}, fonts: {display: "serif", body: "serif", ui: "sans-serif"}},
    ...extra,
  },
  assets: {},
  records: {captions: {lines: []}, production: {}, publishing: {}, request: {}, script: {}},
});

// Board components read the current frame. Outside a composition Remotion
// reports frame 0 once hooks and a timeline are provided; a sequence offset
// shifts that to the frame under test, so the markup is deterministic.
const atFrame = (frame: number, node: React.ReactNode) => renderToStaticMarkup(
  <Internals.CanUseRemotionHooksProvider>
    <Internals.TimelineContext.Provider value={{frame: {"board-test": 0}, playing: false, rootId: "board-test", imperativePlaying: {current: false}, audioAndVideoTags: {current: []}}}>
    <Internals.SequenceContext.Provider value={{absoluteFrom: -frame, cumulatedFrom: -frame, cumulatedNegativeFrom: 0, relativeFrom: 0, parentFrom: 0, durationInFrames: 100000, id: "board-test", width: null, height: null, premounting: false, postmounting: false, premountDisplay: null, postmountDisplay: null}}>
      {node}
    </Internals.SequenceContext.Provider>
    </Internals.TimelineContext.Provider>
  </Internals.CanUseRemotionHooksProvider>,
);

const boardSamples: Record<string, {visual: {kind: string; [key: string]: unknown}; copy: string[]}> = {
  "chapter-title": {visual: {kind: "chapter-title", number: 2, title: "What each document does"}, copy: ["02", "What each document does"]},
  statement: {visual: {kind: "statement", text: "Every step needs a signed record", goldPhrase: "signed record", subline: "Keep the copy you signed"}, copy: ["Every step needs a", "signed record", "Keep the copy you signed"]},
  cards: {visual: {kind: "cards", title: "Three things to gather", items: [{label: "The notice", note: "Dated and signed"}, {label: "The receipt"}, {label: "The contact list", cue: "contacts"}]}, copy: ["Three things to gather", "The notice", "Dated and signed", "The receipt", "The contact list"]},
  compare: {visual: {kind: "compare", left: {title: "Before", items: [{label: "Paper forms"}]}, right: {title: "After", items: [{label: "One online form", note: "Saved as you go"}]}}, copy: ["Before", "Paper forms", "After", "One online form", "Saved as you go"]},
  flow: {visual: {kind: "flow", nodes: [{label: "Request"}, {label: "Review"}, {label: "Decision"}], outcome: "A written answer"}, copy: ["Request", "Review", "Decision", "A written answer"]},
  steps: {visual: {kind: "steps", title: "How to start", steps: [{label: "Find the form"}, {label: "Fill it in", note: "Print clearly"}, {label: "File it"}]}, copy: ["How to start", "Find the form", "Fill it in", "Print clearly", "File it"]},
  document: {visual: {kind: "document", title: "Filing receipt", lines: [{label: "Filed", value: "March 3"}, {label: "Status", value: "Accepted", highlight: true}]}, copy: ["Filing receipt", "Filed", "March 3", "Status", "Accepted"]},
  subscribe: {visual: {kind: "subscribe", topic: "filing deadlines", solution: "file on time"}, copy: ["Do you want to know more about filing deadlines?", "Subscribe to learn how to file on time."]},
};

test("scene dispatch preserves legacy copy without a catalog and still honors explicit board overrides", () => {
  const project = boardProject();
  Object.assign(project.contract.brand, {logo: "logo.svg", watermark: {left: "", right: ""}});
  const scene = {id: "legacy", headline: "Existing board headline", visual: {kind: "statement"}};
  const props = {project, scene, line: {id: "legacy", durationMs: 3000, words: []}, duration: 90, lead: 0};
  const visibleText = (node: React.ReactNode) => atFrame(89,
    <Internals.CompositionManager.Provider value={{
      compositions: [{id: "board-test", component: () => null, width: 1920, height: 1080, fps: 30, durationInFrames: 100000, defaultProps: {}}],
      folders: [], currentCompositionMetadata: null, canvasContent: {type: "composition", compositionId: "board-test"},
    }}>{node}</Internals.CompositionManager.Provider>,
  ).replace(/<[^>]*>/gu, "").replaceAll("\u2060", "");
  for (const vertical of [false, true]) {
    assert.ok(visibleText(<SceneView {...props} vertical={vertical} />).includes(scene.headline));
    const ClientStatement = () => <div>Client statement</div>;
    assert.ok(visibleText(<SceneView {...props} vertical={vertical} components={{Boards: {statement: ClientStatement}}} />).includes("Client statement"));
    const ClientGraphic = () => <div>Client graphic</div>;
    assert.ok(visibleText(<SceneView {...props} vertical={vertical} components={{Graphic: ClientGraphic}} />).includes("Client graphic"));
    const catalogProject = {...project, contract: {...project.contract, boards: {kinds: {statement: {}}}}};
    const boardScene = {...scene, visual: {...scene.visual, text: "Catalog board text"}};
    const withCatalog = visibleText(<SceneView {...props} project={catalogProject} scene={boardScene} vertical={vertical} />);
    assert.ok(withCatalog.includes("Catalog board text"));
    assert.ok(!withCatalog.includes(scene.headline));
  }
});

test("the default Boards map covers exactly the default board kinds", () => {
  assert.deepEqual(Object.keys(defaultVideoProjectComponents.Boards), [...DEFAULT_BOARD_KINDS]);
  assert.deepEqual(defaultVideoBoardKinds, [...DEFAULT_BOARD_KINDS]);
  assert.deepEqual(Object.keys(boardSamples), [...DEFAULT_BOARD_KINDS]);
  assert.equal(defaultVideoProjectComponents.Boards.cards, CardsBoard);
  assert.equal(defaultVideoProjectComponents.Boards["chapter-title"], ChapterTitleBoard);
  assert.equal(defaultVideoProjectComponents.Boards.statement, StatementBoard);
  assert.equal(defaultVideoProjectComponents.Boards.compare, CompareBoard);
  assert.equal(defaultVideoProjectComponents.Boards.flow, FlowBoard);
  assert.equal(defaultVideoProjectComponents.Boards.steps, StepsBoard);
  assert.equal(defaultVideoProjectComponents.Boards.document, DocumentBoard);
  assert.equal(defaultVideoProjectComponents.Boards.subscribe, SubscribeBoard);
  assert.equal(deriveVideoChapters([{id: "a", chapter: "two-jobs"}])[0].label, "Two Jobs");
});

for (const vertical of [false, true]) {
  test(`every default board draws its data from brand tokens (${vertical ? "vertical" : "horizontal"})`, () => {
    const project = boardProject();
    for (const [kind, sample] of Object.entries(boardSamples)) {
      const Board = defaultVideoProjectComponents.Boards[kind];
      const scene = {id: kind, eyebrow: "In short", visual: sample.visual};
      const line = {id: kind, durationMs: 3000, words: []};
      const markup = atFrame(89, <Board project={project} scene={scene} visual={sample.visual} line={line} duration={90} lead={0} overFootage={false} vertical={vertical} />);
      // tieOrphan joins the last two words with U+2060; compare the visible text.
      const text = markup.replaceAll("\u2060", "");
      for (const copy of sample.copy) assert.ok(text.includes(copy), `${kind} shows "${copy}"`);
      assert.match(markup, /background-color:#101820/u, `${kind} sits on the brand background`);
      assert.match(markup, /#d5b66f/u, `${kind} uses the brand accent`);
      assert.doesNotMatch(markup, /opacity:0(?![.\d])/u, `${kind} has revealed everything by the end of the scene`);
      // Clear of the logo and banner above and the captions and labels below.
      assert.match(markup, vertical ? /padding:330px 130px 440px 90px/u : /padding:150px 150px 210px/u, `${kind} keeps the safe area`);
    }
  });
}

test("a board over footage draws a scrim instead of the solid background", () => {
  const sample = boardSamples.cards;
  const markup = atFrame(89, <CardsBoard project={boardProject()} scene={{id: "cards"}} visual={sample.visual} line={{id: "cards", durationMs: 3000, words: []}} duration={90} lead={0} overFootage />);
  assert.match(markup, /color-mix\(in srgb, #101820 74%, transparent\)/u);
});

test("a motif draws the staged file for its stem and skips an unstaged one", () => {
  const motifs = {mount: "illustrations", files: {scales: "scales.png", gavel: "tools/gavel.svg"}};
  assert.equal(videoBoardMotifSrc(boardProject({boards: {motifs}}), "scales"), staticFile("illustrations/scales.png"), "a png-only motif keeps its extension");
  assert.equal(videoBoardMotifSrc(boardProject({boards: {motifs}}), "gavel"), staticFile("illustrations/tools/gavel.svg"));
  assert.equal(videoBoardMotifSrc(boardProject({boards: {motifs}}), "compass"), null, "an unmapped stem is skipped");
  assert.equal(videoBoardMotifSrc(boardProject({boards: {motifs}}), "toString"), null, "only own entries count");
  assert.equal(videoBoardMotifSrc(boardProject({boards: {motifs: {mount: "illustrations"}}}), "scales"), null, "no staged files, no motif");
  assert.equal(videoBoardMotifSrc(boardProject(), "scales"), null, "no catalog mount, no motif");

  const visual = {kind: "chapter-title", number: 1, title: "Start here", motif: "compass"};
  const line = {id: "chapter", durationMs: 1000, words: []};
  const markup = atFrame(29, <ChapterTitleBoard project={boardProject({boards: {motifs}})} scene={{id: "chapter"}} visual={visual} line={line} duration={30} lead={0} overFootage={false} />);
  assert.doesNotMatch(markup, /<img/u, "an unmapped motif draws nothing");
});

test("the subscribe board prefers authored copy over the generic default", () => {
  const visual = {kind: "subscribe", topic: "t", solution: "s", question: "Still unsure?", line: "Subscribe for the next answer."};
  const markup = atFrame(59, <SubscribeBoard project={boardProject()} scene={{id: "subscribe"}} visual={visual} line={{id: "subscribe", durationMs: 2000, words: []}} duration={60} lead={0} overFootage={false} />);
  assert.match(markup, /Still \u2060?unsure\?/u);
  assert.match(markup, /Subscribe for the next/u);
  assert.doesNotMatch(markup, /know more about/u);
  assert.doesNotMatch(markup, /<img/u, "the watermark already carries the logo");
});

test("a cued item reveals when the take speaks its cue word", () => {
  const visual = {kind: "cards", items: [{label: "First item"}, {label: "Cued item", cue: "receipt"}]};
  const words = [{text: "Keep", startMs: 0, endMs: 200}, {text: "the", startMs: 200, endMs: 300}, {text: "Receipt,", startMs: 2000, endMs: 2400}];
  const line = {id: "cards", durationMs: 3000, words};
  const lead = 6;
  const cueFrame = revealFrame({cue: "receipt", words, index: 1, count: 2, duration: 96, lead, fps: 30});
  assert.equal(cueFrame, lead + 60, "the reveal lands on the spoken word's start");
  const cuedOpacity = (frame: number) => {
    const markup = atFrame(frame, <CardsBoard project={boardProject()} scene={{id: "cards"}} visual={visual} line={line} duration={96} lead={lead} overFootage={false} />);
    const card = markup.split("Cued item")[0].split("<div").filter((chunk) => chunk.includes("border-top:4px")).at(-1) || "";
    return Number(/opacity:([\d.]+)/u.exec(card)?.[1]);
  };
  assert.equal(cuedOpacity(cueFrame - 1), 0, "hidden before the word");
  assert.equal(cuedOpacity(cueFrame + 20), 1, "shown once the word is spoken");
});

test("lets a Design System replace one board kind and keep the other defaults", () => {
  const ClientCards = (_props: VideoProjectBoardProps) => null;
  const ClientFallback = (_props: VideoProjectBoardProps) => null;
  const resolved = resolveVideoProjectComponents({Boards: {cards: ClientCards}});
  assert.equal(resolved.Boards.cards, ClientCards);
  assert.equal(resolved.Boards.steps, StepsBoard);
  assert.deepEqual(Object.keys(resolved.Boards), [...DEFAULT_BOARD_KINDS]);
  assert.equal(resolved.Graphic, GraphicBoard);

  assert.equal(resolveVideoBoardComponent({Boards: {cards: ClientCards}}, "cards"), ClientCards);
  assert.equal(resolveVideoBoardComponent({Boards: {cards: ClientCards}}, "flow"), FlowBoard);
  assert.equal(resolveVideoBoardComponent(undefined, "timeline"), GraphicBoard, "an unregistered kind falls back to the Graphic copy board");
  assert.equal(resolveVideoBoardComponent({Graphic: ClientFallback}, "timeline"), ClientFallback);
  assert.equal(resolveVideoBoardComponent({Graphic: ClientFallback}, "toString"), ClientFallback, "only own keys count as registered boards");
});

test("a client Graphic keeps every kind its Boards do not register", () => {
  const ClientCards = (_props: VideoProjectBoardProps) => null;
  const ClientGraphic = (_props: VideoProjectBoardProps) => null;
  assert.equal(resolveVideoBoardComponent({Graphic: ClientGraphic}, "subscribe"), ClientGraphic, "a pre-catalog Graphic still draws the compiler's subscribe board");
  assert.equal(resolveVideoBoardComponent({Graphic: ClientGraphic}, "cards"), ClientGraphic);
  assert.equal(resolveVideoBoardComponent({Graphic: ClientGraphic, Boards: {cards: ClientCards}}, "cards"), ClientCards);
  assert.equal(resolveVideoBoardComponent({Graphic: ClientGraphic, Boards: {cards: ClientCards}}, "steps"), ClientGraphic);

  const graphicOnly = resolveVideoProjectComponents({Graphic: ClientGraphic});
  assert.deepEqual(graphicOnly.Boards, {}, "the resolved map does not claim the defaults over a client Graphic");
  assert.equal(graphicOnly.Graphic, ClientGraphic);
  assert.deepEqual(resolveVideoProjectComponents({Graphic: ClientGraphic, Boards: {cards: ClientCards}}).Boards, {cards: ClientCards});
});

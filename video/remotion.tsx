import React, { useEffect, useMemo, useState } from "react";
import { Audio } from "@remotion/media";
import {
  AbsoluteFill,
  cancelRender,
  Composition,
  continueRender,
  delayRender,
  Easing,
  Img,
  OffthreadVideo,
  Sequence,
  interpolate,
  registerRoot,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {fitCoverHeadline, splitGoldHeadline, tieOrphan} from "./text.mjs";
import {assertSharedBoardLayout, resolveBoardLayout} from "./board-layouts.mjs";
import {assertRuntimeCompatibility, VIDEO_RUNTIME_CAPABILITIES} from "./runtime-compat.mjs";
import toolkitPackage from "../package.json" with {type: "json"};

const componentRuntime = {...VIDEO_RUNTIME_CAPABILITIES, name: toolkitPackage.name, version: toolkitPackage.version};
import {MINIMUM_CHAIN_CLIP_SECONDS, adjacentFootageRepeats, chainClipFrames, sceneAssetKeys, verticalTextZone} from "./footage.mjs";
import {DEFAULT_BOARD_KINDS, deriveVideoChapters, revealFrame} from "./boards.mjs";

export type VideoProjectWordTiming = {text: string; startMs: number; endMs: number};
export type VideoProjectCaptionLine = {id: string; words: VideoProjectWordTiming[]; durationMs: number};
export type VideoProjectScene = {
  id: string;
  eyebrow?: string;
  headline?: string;
  goldPhrase?: string;
  subline?: string;
  asset?: string;
  assets?: string[];
  intro?: boolean;
  outro?: boolean;
  /** Client-rendered graphic board (structure.<format>.graphicScenes). TimDS validates only `kind`. */
  visual?: {kind: string; [key: string]: unknown};
  /** Chapter id for client rails and published chapter lists. */
  chapter?: string;
  /** Why no declared board kind fit this beat; the scene keeps its footage. */
  boardGap?: string;
};
export type VideoProjectAsset = {
  key: string;
  src: string;
  kind?: "image" | "video";
  durationSeconds?: number;
  text?: string;
  subject?: string;
  flip?: boolean;
  objectPosition?: string;
};
export type VideoProjectBrandBanners = {
  /** Horizontal renders: pill top-right on every frame, e.g. "Subscribe for more". */
  longform?: string;
  /** Vertical renders: kicker + URL banner under the logo on every frame. */
  short?: {kicker?: string; url: string};
};

export type VideoProject = {
  schemaVersion: 1;
  engine: {name: string; version: string};
  contract: any;
  assets: Record<string, VideoProjectAsset>;
  records: {
    captions: {lines: VideoProjectCaptionLine[]};
    production: any;
    publishing: any;
    request: any;
    script: any;
  };
};

export type VideoProjectCover = {
  asset: string;
  atSeconds?: number;
  eyebrow?: string;
  headline?: string;
  goldPhrase?: string;
  objectPosition?: string;
  [key: string]: unknown;
};

export type VideoProjectIntroProps = {
  project: VideoProject;
  question: string;
  vertical?: boolean;
};

export type VideoProjectOutroProps = {
  project: VideoProject;
  vertical?: boolean;
};

export type VideoProjectSceneProps = {
  project: VideoProject;
  scene: VideoProjectScene;
  line: VideoProjectCaptionLine;
  duration: number;
  lead: number;
  vertical?: boolean;
  components?: VideoProjectComponentOverrides;
};

export type VideoProjectVideoProps = {
  project: VideoProject;
  scenes: VideoProjectScene[];
  ids: string[];
  pads?: Record<string, {lead?: number; tail?: number}>;
  audioSrc?: string | null;
  vertical?: boolean;
  components?: VideoProjectComponentOverrides;
};

export type VideoProjectCoverProps = {
  project: VideoProject;
  cover: VideoProjectCover;
  vertical?: boolean;
};

/**
 * A graphic scene's board. `components.Boards[visual.kind]` draws it; a kind
 * with no registered board falls back to `components.Graphic`, which draws the
 * scene copy. The Design System's video/boards.json declares each kind's data.
 */
export type VideoProjectBoardProps = {
  project: VideoProject;
  scene: VideoProjectScene;
  /** The scene's authored `visual` block: `kind` plus whatever the board needs. */
  visual: {kind: string; [key: string]: unknown};
  line: VideoProjectCaptionLine;
  duration: number;
  lead: number;
  /** True when the scene's footage chain plays beneath the board. */
  overFootage: boolean;
  vertical?: boolean;
};
/** The pre-catalog name for {@link VideoProjectBoardProps}; kept for existing client components. */
export type VideoProjectGraphicProps = VideoProjectBoardProps;

/** A client Design System may replace any subset of the TimDS defaults. */
export type VideoProjectComponentOverrides = {
  Video?: React.ComponentType<VideoProjectVideoProps>;
  Scene?: React.ComponentType<VideoProjectSceneProps>;
  /** Draws `scene.visual` boards; the default Scene mounts it over the footage chain or the brand background. */
  Graphic?: React.ComponentType<VideoProjectGraphicProps>;
  /**
   * One board per `visual.kind`, merged over the TimDS defaults so a client
   * overrides or adds kinds one at a time. `timds video check` requires these
   * keys to match the kinds the Design System's video/boards.json declares.
   */
  Boards?: Record<string, React.ComponentType<VideoProjectBoardProps>>;
  Intro?: React.ComponentType<VideoProjectIntroProps>;
  Outro?: React.ComponentType<VideoProjectOutroProps>;
  Cover?: React.ComponentType<VideoProjectCoverProps>;
  HorizontalCover?: React.ComponentType<VideoProjectCoverProps>;
  VerticalCover?: React.ComponentType<VideoProjectCoverProps>;
};

type VideoFont = {
  family: string;
  path: string;
  style?: string;
  weight?: string;
  dataBase64?: string;
  format?: "woff2" | "woff" | "opentype" | "truetype";
};

const videoFonts = (project: VideoProject) => (project.contract.brand.fontFiles || []) as VideoFont[];
export const videoFontLoadWeight = (weight = "400") => weight.trim().split(/\s+/u).at(-1) || "400";
export const videoFontDeclaration = (font: VideoFont) =>
  `${font.style || "normal"} ${videoFontLoadWeight(font.weight)} 16px ${JSON.stringify(font.family)}`;

const videoFontStyles = (project: VideoProject) => videoFonts(project).map((font) => {
  const url = font.dataBase64
    ? `data:font/${font.format || "woff2"};base64,${font.dataBase64}`
    : staticFile(font.path);
  const format = font.format ? ` format(${JSON.stringify(font.format)})` : "";
  return `@font-face {
  font-family: ${JSON.stringify(font.family)};
  src: url(${JSON.stringify(url)})${format};
  font-style: ${font.style || "normal"};
  font-weight: ${font.weight || "400"};
  font-display: block;
}`;
}).join("\n");

const useVideoProjectFonts = (project: VideoProject) => {
  const fonts = videoFonts(project);
  // Remotion renderer tabs must own this handle from a mounted component. A
  // module-level font promise can stay pending even when Chromium has the font.
  const [handle] = useState(() => fonts.length > 0
    ? delayRender("Loading TimDS project fonts after mount")
    : null);

  useEffect(() => {
    if (handle === null) return;
    loadVideoProjectFonts(project);
    const declarations = fonts.map(videoFontDeclaration);
    let active = true;
    Promise.all(declarations.map((declaration) => document.fonts.load(declaration)))
      .then(() => {
        if (!declarations.every((declaration) => document.fonts.check(declaration))) {
          throw new Error("TimDS video: project font verification failed");
        }
        if (active) continueRender(handle);
      })
      .catch((error: unknown) => {
        if (!active) return;
        cancelRender(error instanceof Error ? error : new Error(String(error)));
      });
    return () => {
      active = false;
    };
  }, [fonts, handle, project]);
};

// TIMDS_DEFAULT_COMPONENTS_START
export const HORIZONTAL_COVER_DESIGN_WIDTH = 1280;
export const HORIZONTAL_COVER_DESIGN_HEIGHT = 720;
export const horizontalCoverScale = (exportWidth: number) => exportWidth / HORIZONTAL_COVER_DESIGN_WIDTH;

const frames = (milliseconds: number, fps: number) => Math.max(1, Math.round(milliseconds / 1000 * fps));
const lineById = (project: VideoProject, id: string) => {
  const line = project.records.captions.lines.find((candidate) => candidate.id === id);
  if (!line) throw new Error(`TimDS video: missing caption line ${id}`);
  return line;
};

const sceneFrames = (project: VideoProject, id: string, pads: Record<string, {lead?: number; tail?: number}> = {}) => {
  const pad = pads[id] || {};
  return Number(pad.lead || 0) + frames(lineById(project, id).durationMs, project.contract.fps) + Number(pad.tail || 0);
};

const totalFrames = (project: VideoProject, ids: string[], pads: Record<string, {lead?: number; tail?: number}> = {}) =>
  ids.reduce((sum, id) => sum + sceneFrames(project, id, pads), 0);

const GoldHeadline: React.FC<{headline?: string; goldPhrase?: string; color: string}> = ({headline = "", goldPhrase, color}) => {
  const parts = splitGoldHeadline(headline, goldPhrase);
  if (!parts.highlighted) return <>{parts.before}</>;
  return <>{parts.before}<span style={{color}}>{parts.highlighted}</span>{parts.after}</>;
};

/**
 * Persistent brand chrome on every frame — content scenes, intro and outro cards alike.
 * Outros are rarely watched (least of all in Shorts), so the contract's optional
 * `brand.banners` keep a call to action on screen the whole time: a pill top-right in
 * horizontal renders and a kicker + URL banner under the logo in vertical renders.
 * Vertical renders keep the right edge clear for the Shorts UI (like / comment / share)
 * and never share the bottom baseline between two labels — a long `watermark.right`
 * (a URL with a path) would collide with `watermark.left` there.
 */
const BrandWatermark: React.FC<{project: VideoProject; vertical?: boolean; sceneHasLogo?: boolean}> = ({project, vertical, sceneHasLogo}) => {
  const brand = project.contract.brand;
  const banners: VideoProjectBrandBanners = brand.banners || {};
  const shadow = `0 2px 14px ${brand.colors.background}`;
  const label = {color: brand.colors.text, fontFamily: brand.fonts.ui, fontSize: vertical ? 24 : 20, fontWeight: 700, letterSpacing: 1.5, textShadow: shadow} as const;
  const shortBanner = vertical ? banners.short : undefined;
  return <>
    {!sceneHasLogo ? <Img src={staticFile(brand.logo)} style={{position: "absolute", top: vertical ? 116 : 38, left: 48, width: vertical ? 190 : 210, opacity: 0.82}} /> : null}
    {!vertical && banners.longform ? (
      <div data-banner="longform" style={{...label, position: "absolute", top: 38, right: 48, display: "flex", alignItems: "center", gap: 12, padding: "10px 22px 10px 18px", border: `2px solid ${brand.colors.accent}`, borderRadius: 999, backgroundColor: brand.colors.panel, fontSize: 21, letterSpacing: 1.2}}>
        <span style={{width: 0, height: 0, borderTop: "8px solid transparent", borderBottom: "8px solid transparent", borderLeft: `13px solid ${brand.colors.accent}`}} />
        <span>{banners.longform}</span>
      </div>
    ) : null}
    {shortBanner ? (
      <div data-banner="short" style={{position: "absolute", top: 196, left: 48, display: "flex", flexDirection: "column", gap: 6}}>
        {shortBanner.kicker ? <div style={{...label, fontSize: 24, letterSpacing: 3, textTransform: "uppercase", opacity: 0.92}}>{shortBanner.kicker}</div> : null}
        <div style={{...label, color: brand.colors.accent, fontSize: 36, letterSpacing: 1.2}}>{shortBanner.url}</div>
      </div>
    ) : null}
    <div style={{...label, position: "absolute", left: 48, bottom: vertical ? 112 : 34}}>{brand.watermark.left}</div>
    {shortBanner ? null : vertical
      ? <div style={{...label, position: "absolute", left: 48, bottom: 152, color: brand.colors.accent}}>{brand.watermark.right}</div>
      : <div style={{...label, position: "absolute", right: 48, bottom: 34}}>{brand.watermark.right}</div>}
  </>;
};

const Intro: React.FC<VideoProjectIntroProps> = ({project, question, vertical}) => {
  const brand = project.contract.brand;
  return <AbsoluteFill style={{backgroundColor: brand.colors.background, alignItems: "center", justifyContent: "center", padding: vertical ? "180px 90px" : "100px 220px", textAlign: "center"}}>
    <Img src={staticFile(brand.logo)} style={{width: vertical ? 390 : 420, marginBottom: vertical ? 74 : 46}} />
    <div style={{width: vertical ? 160 : 120, height: 4, backgroundColor: brand.colors.accent, marginBottom: vertical ? 66 : 44}} />
    <div style={{color: brand.colors.text, fontFamily: brand.fonts.display, fontWeight: 700, fontSize: vertical ? 92 : 78, lineHeight: 1.02, textWrap: "pretty"}}>{tieOrphan(question)}</div>
  </AbsoluteFill>;
};

const Outro: React.FC<VideoProjectOutroProps> = ({project, vertical}) => {
  const brand = project.contract.brand;
  return <AbsoluteFill style={{backgroundColor: brand.colors.background, alignItems: "center", justifyContent: "center", textAlign: "center"}}>
    <Img src={staticFile(brand.logo)} style={{width: vertical ? 520 : 470}} />
    <div style={{color: brand.colors.accent, fontFamily: brand.fonts.ui, fontSize: vertical ? 34 : 28, fontWeight: 700, letterSpacing: 3, marginTop: 28}}>{brand.site}</div>
    <div style={{width: vertical ? 150 : 120, height: 3, backgroundColor: brand.colors.accent, margin: "38px 0"}} />
    <div style={{color: brand.colors.text, fontFamily: brand.fonts.display, fontSize: vertical ? 62 : 48}}>{brand.tagline}</div>
  </AbsoluteFill>;
};

// A scene's footage: one registered asset or an ordered chain, each playing at
// natural speed in turn. A video clip is an OffthreadVideo; a still (kind
// "image") is an Img held for its share of the scene. Both take the same slow
// push-in so a held still never reads as a freeze-frame. The chain rules come
// from footage.mjs, shared with the producer and `timds video check`.
const Media: React.FC<{project: VideoProject; scene: VideoProjectScene; duration: number; vertical?: boolean}> = ({project, scene, duration, vertical}) => {
  const frame = useCurrentFrame();
  const keys = sceneAssetKeys(scene);
  const fps = project.contract.fps;
  const availableFrames = keys.map((key) => {
    const asset = project.assets[key];
    if (!asset) throw new Error(`TimDS video: missing prepared asset ${key}`);
    if (!asset.durationSeconds) return duration;
    return Math.max(1, Math.floor(asset.durationSeconds * fps));
  });
  if (availableFrames.reduce((sum, value) => sum + value, 0) < duration) {
    throw new Error(`TimDS video: scene ${scene.id} exceeds its natural-speed footage chain; add another asset or shorten the scene`);
  }
  for (const repeat of adjacentFootageRepeats([scene])) {
    throw new Error(`TimDS video: scene ${scene.id} chains ${repeat.previous.key} directly into ${repeat.current.key}; back-to-back footage from one family is not allowed`);
  }
  const clipFramesByIndex = chainClipFrames(availableFrames, duration, Math.max(1, Math.round(MINIMUM_CHAIN_CLIP_SECONDS * fps)));
  let cursor = 0;
  return <AbsoluteFill>
    {keys.map((key, index) => {
      const asset = project.assets[key];
      const clipFrames = clipFramesByIndex[index];
      const from = cursor;
      cursor += clipFrames;
      if (clipFrames <= 0) return null;
      const zoom = interpolate(frame, [0, Math.max(1, duration - 1)], [1.01, 1.065], {extrapolateLeft: "clamp", extrapolateRight: "clamp"});
      const style = {width: "100%", height: "100%", objectFit: "cover" as const, objectPosition: asset.objectPosition || "50% 50%", transform: `${asset.flip ? "scaleX(-1) " : ""}scale(${zoom})`};
      return <Sequence key={key} from={from} durationInFrames={clipFrames}>
        {asset.kind === "image"
          ? <Img src={staticFile(asset.src)} style={style} />
          : <OffthreadVideo muted src={staticFile(asset.src)} style={style} />}
      </Sequence>;
    })}
    <AbsoluteFill style={{backgroundColor: project.contract.brand.colors.background, opacity: vertical ? 0.64 : 0.12}} />
  </AbsoluteFill>;
};

const CaptionPages: React.FC<{project: VideoProject; line: VideoProjectCaptionLine; lead: number; vertical?: boolean}> = ({project, line, lead, vertical}) => {
  const frame = useCurrentFrame();
  const size = project.contract.copy.captionPageWords;
  const pages = useMemo(() => Array.from({length: Math.ceil(line.words.length / size)}, (_value, index) => line.words.slice(index * size, index * size + size)), [line.words, size]);
  const now = Math.max(0, (frame - lead) / project.contract.fps * 1000);
  const page = pages.find((candidate) => now >= (candidate[0]?.startMs ?? Infinity) && now <= (candidate.at(-1)?.endMs ?? -Infinity) + 180) || [];
  return <div style={{position: "absolute", left: vertical ? 70 : 150, right: vertical ? 150 : 150, bottom: vertical ? 240 : 76, textAlign: "center", color: project.contract.brand.colors.text, fontFamily: project.contract.brand.fonts.body, fontSize: vertical ? 58 : 42, fontWeight: 700, lineHeight: 1.08, textShadow: `0 3px 22px ${project.contract.brand.colors.background}`}}>
    {page.map((word, index) => <React.Fragment key={`${word.startMs}-${index}`}><span style={{color: now >= word.startMs && now <= word.endMs ? project.contract.brand.colors.accent : project.contract.brand.colors.text}}>{word.text}</span>{index === page.length - 1 ? "" : " "}</React.Fragment>)}
  </div>;
};

// The eyebrow and headline pair every copy block draws. The panel over
// footage and the full-frame board share this one brand treatment and differ
// only in headline size, so a styling change reaches both.
const SceneHeadline: React.FC<{project: VideoProject; scene: VideoProjectScene; headlineSize: number; vertical?: boolean}> = ({project, scene, headlineSize, vertical}) => {
  const brand = project.contract.brand;
  return <>
    {scene.eyebrow ? <div style={{color: brand.colors.accent, fontFamily: brand.fonts.ui, fontSize: vertical ? 26 : 22, fontWeight: 700, letterSpacing: 5, textTransform: "uppercase", marginBottom: 18}}>{scene.eyebrow}</div> : null}
    {scene.headline ? <div style={{color: brand.colors.text, fontFamily: brand.fonts.display, fontSize: headlineSize, fontWeight: 700, lineHeight: 0.98, textWrap: "pretty"}}><GoldHeadline headline={scene.headline} goldPhrase={scene.goldPhrase} color={brand.colors.accent} /></div> : null}
  </>;
};

// The copy box a footage scene shows: eyebrow, headline, optional subline,
// placed by the first clip's declared text zone (left/right, top/center/lower).
const SceneCopy: React.FC<{project: VideoProject; scene: VideoProjectScene; vertical?: boolean}> = ({project, scene, vertical}) => {
  const brand = project.contract.brand;
  const firstAsset = project.assets[sceneAssetKeys(scene)[0] || ""];
  const right = firstAsset?.text?.startsWith("right");
  const lower = verticalTextZone(firstAsset?.text) === "lower";
  const top = Boolean(firstAsset?.text?.endsWith("top"));
  return <AbsoluteFill style={{alignItems: vertical ? "center" : right ? "flex-end" : "flex-start", justifyContent: vertical ? lower ? "flex-end" : "flex-start" : lower ? "flex-end" : top ? "flex-start" : "center", padding: vertical ? lower ? "0 150px 430px 70px" : "240px 150px 0 70px" : top ? "110px 120px 150px" : "0 120px 150px"}}>
    <div style={{width: vertical ? "100%" : 830, padding: vertical ? 0 : "42px 50px 46px", textAlign: vertical ? "center" : "left", backgroundColor: vertical ? "transparent" : brand.colors.panel, borderLeft: vertical ? undefined : `9px solid ${brand.colors.accent}`, textShadow: vertical ? `0 3px 26px ${brand.colors.background}` : undefined}}>
      <SceneHeadline project={project} scene={scene} headlineSize={vertical ? 110 : 72} vertical={vertical} />
      {scene.subline ? <div style={{color: brand.colors.muted, fontFamily: brand.fonts.body, fontSize: 32, marginTop: 20}}>{tieOrphan(scene.subline)}</div> : null}
    </div>
  </AbsoluteFill>;
};

// The default board for every `visual.kind`: the scene copy on the brand
// background, or the ordinary copy box when footage plays beneath, so a
// production renders before the Design System implements the kind. A client
// replaces this through `components.Graphic` and reads `visual` for its data.
const GraphicBoard: React.FC<VideoProjectGraphicProps> = ({project, scene, overFootage, vertical}) => {
  if (overFootage) return <SceneCopy project={project} scene={scene} vertical={vertical} />;
  return <AbsoluteFill style={{backgroundColor: project.contract.brand.colors.background, justifyContent: "center", padding: vertical ? "0 96px 430px" : "0 150px 190px"}}>
    <SceneHeadline project={project} scene={scene} headlineSize={vertical ? 110 : 84} vertical={vertical} />
  </AbsoluteFill>;
};

// Default boards, one per kind in the default video/boards.json. Each reads
// only the fields that catalog declares and styles itself from brand tokens,
// so a fresh Design System renders every default kind before it writes any
// React. Reveals land on the item's `cue` word when the take speaks it and on
// an even spread otherwise (revealFrame, shared with the producer's checks).
// Every board keeps clear of the caption zone at the bottom and the
// watermark corners, which SceneView draws above it.
type BoardItem = {label: string; note?: string; cue?: string};
type BoardRow = BoardItem & {value: string; highlight: boolean};

const BOARD_EASE = Easing.bezier(0.16, 1, 0.3, 1);
const boardClamp = {extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: BOARD_EASE} as const;
const boardFade = (frame: number, at: number, length = 12) => interpolate(frame, [at, at + length], [0, 1], boardClamp);
const boardEnter = (frame: number, at: number, distance = 22) => ({
  opacity: boardFade(frame, at),
  transform: `translateY(${interpolate(frame, [at, at + 18], [distance, 0], boardClamp)}px)`,
});
const boardString = (value: unknown) => typeof value === "string" ? value.trim() : "";
const boardRecords = (value: unknown) => (Array.isArray(value) ? value : [])
  .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
const boardItems = (value: unknown): BoardItem[] => boardRecords(value).map((item) => ({
  label: boardString(item.label),
  note: boardString(item.note) || undefined,
  cue: boardString(item.cue) || undefined,
}));
const boardRows = (value: unknown): BoardRow[] => boardRecords(value).map((item) => ({
  ...boardItems([item])[0],
  value: boardString(item.value),
  highlight: item.highlight === true,
}));

// The toolkit cannot know a motif's file from the visual alone. The catalog
// names a brand.staticFiles mount (`motifs.mount`) and staging records each
// motif stem's file under it (`motifs.files`, extension included), carried on
// the project as `contract.boards.motifs`. A stem with no staged file is
// skipped rather than requested and failed.
const boardMotifSrc = (project: VideoProject, motif: unknown) => {
  const motifs = project.contract.boards?.motifs;
  const mount = boardString(motifs?.mount);
  const name = boardString(motif);
  const file = name && motifs?.files && Object.hasOwn(motifs.files, name) ? boardString(motifs.files[name]) : "";
  return mount && file ? staticFile(`${mount}/${file}`) : null;
};

const useBoardTiming = ({project, line, duration, lead, visual, vertical, overFootage}: VideoProjectBoardProps) => {
  const preset = project.contract.boards?.kinds?.[visual.kind]?.layoutPreset ?? project.contract.boards?.layoutPreset;
  if (preset) assertSharedBoardLayout(visual, preset, {vertical, overFootage});
  const frame = useCurrentFrame();
  const fps = project.contract.fps;
  const at = (cue: string | undefined, index: number, count: number) =>
    revealFrame({cue, words: line.words, index, count, duration, lead, fps});
  return {frame, at};
};

// Full-frame brand background, or a scrim when footage plays beneath. The
// padding is the safe area: logo and banner above, captions and watermark
// labels below, and the Shorts UI along the right edge of vertical renders.
const BoardStage: React.FC<{project: VideoProject; kind?: string; overFootage: boolean; vertical?: boolean; center?: boolean; children: React.ReactNode}> = ({project, kind, overFootage, vertical, center, children}) => {
  const background = project.contract.brand.colors.background;
  const layout = resolveBoardLayout(project.contract.boards?.kinds?.[kind ?? ""]?.layoutPreset ?? project.contract.boards?.layoutPreset, {vertical, overFootage});
  return <AbsoluteFill style={{
    backgroundColor: overFootage ? `color-mix(in srgb, ${background} ${layout.scrim}%, transparent)` : background,
    justifyContent: "center",
    alignItems: center ? "center" : "stretch",
    textAlign: center ? "center" : "left",
    padding: layout.padding,
  }}>{layout.scale === 1 ? children : <div style={{transform: `scale(${layout.scale})`, transformOrigin: "center"}}>{children}</div>}</AbsoluteFill>;
};

const BoardKicker: React.FC<{project: VideoProject; text?: string; vertical?: boolean; style?: React.CSSProperties}> = ({project, text, vertical, style}) => {
  const brand = project.contract.brand;
  if (!text) return null;
  return <div style={{color: brand.colors.accent, fontFamily: brand.fonts.ui, fontSize: vertical ? 26 : 22, fontWeight: 700, letterSpacing: 5, textTransform: "uppercase", marginBottom: 18, ...style}}>{text}</div>;
};

const BoardTitle: React.FC<{project: VideoProject; text: string; size: number; style?: React.CSSProperties}> = ({project, text, size, style}) => {
  const brand = project.contract.brand;
  if (!text) return null;
  return <div style={{color: brand.colors.text, fontFamily: brand.fonts.display, fontSize: size, fontWeight: 700, lineHeight: 1.02, textWrap: "pretty", ...style}}>{tieOrphan(text)}</div>;
};

const BoardNote: React.FC<{project: VideoProject; text?: string; size: number; style?: React.CSSProperties}> = ({project, text, size, style}) => {
  const brand = project.contract.brand;
  if (!text) return null;
  return <div style={{color: brand.colors.muted, fontFamily: brand.fonts.body, fontSize: size, lineHeight: 1.2, marginTop: 10, textWrap: "pretty", ...style}}>{tieOrphan(text)}</div>;
};

const ChapterTitleBoard: React.FC<VideoProjectBoardProps> = (props) => {
  const {project, visual, lead, overFootage, vertical} = props;
  const brand = project.contract.brand;
  const {frame} = useBoardTiming(props);
  const number = Number(visual.number);
  const motif = boardMotifSrc(project, visual.motif);
  return <BoardStage project={project} kind={visual.kind} overFootage={overFootage} vertical={vertical}>
    <div style={{display: "flex", flexDirection: vertical ? "column-reverse" : "row", alignItems: vertical ? "flex-start" : "center", gap: vertical ? 60 : 96}}>
      <div style={{flex: 1}}>
        {Number.isInteger(number) && number > 0
          ? <div data-board-number style={{color: brand.colors.accent, fontFamily: brand.fonts.display, fontSize: vertical ? 150 : 132, fontWeight: 700, lineHeight: 1, fontVariantNumeric: "lining-nums tabular-nums", ...boardEnter(frame, lead)}}>{String(number).padStart(2, "0")}</div>
          : null}
        <div style={{width: vertical ? 180 : 150, height: 5, margin: vertical ? "34px 0 38px" : "28px 0 32px", backgroundColor: brand.colors.accent, transformOrigin: "0 50%", transform: `scaleX(${interpolate(frame, [lead + 6, lead + 26], [0, 1], boardClamp)})`}} />
        <BoardTitle project={project} text={boardString(visual.title)} size={vertical ? 104 : 96} style={boardEnter(frame, lead + 10, 28)} />
      </div>
      {motif ? <Img src={motif} style={{width: vertical ? 420 : 520, height: vertical ? 420 : 520, objectFit: "contain", opacity: boardFade(frame, lead + 14, 20)}} /> : null}
    </div>
  </BoardStage>;
};

const StatementBoard: React.FC<VideoProjectBoardProps> = (props) => {
  const {project, scene, visual, lead, overFootage, vertical} = props;
  const brand = project.contract.brand;
  const {frame} = useBoardTiming(props);
  const motif = boardMotifSrc(project, visual.motif);
  const goldPhrase = boardString(visual.goldPhrase) || undefined;
  return <BoardStage project={project} kind={visual.kind} overFootage={overFootage} vertical={vertical}>
    <div style={{display: "flex", flexDirection: vertical ? "column-reverse" : "row", alignItems: vertical ? "flex-start" : "center", gap: vertical ? 56 : 90}}>
      <div style={{flex: 1, borderLeft: `8px solid ${brand.colors.accent}`, paddingLeft: vertical ? 40 : 54}}>
        <BoardKicker project={project} text={scene.eyebrow} vertical={vertical} style={boardEnter(frame, lead, 12)} />
        <div style={{color: brand.colors.text, fontFamily: brand.fonts.display, fontSize: vertical ? 96 : 88, fontWeight: 700, lineHeight: 1.02, textWrap: "pretty", ...boardEnter(frame, lead + 4, 26)}}>
          <GoldHeadline headline={boardString(visual.text)} goldPhrase={goldPhrase} color={brand.colors.accent} />
        </div>
        <BoardNote project={project} text={boardString(visual.subline)} size={vertical ? 40 : 36} style={{marginTop: 26, ...boardEnter(frame, lead + 18, 16)}} />
      </div>
      {motif ? <Img src={motif} style={{width: vertical ? 380 : 440, height: vertical ? 380 : 440, objectFit: "contain", opacity: boardFade(frame, lead + 12, 20)}} /> : null}
    </div>
  </BoardStage>;
};

const CardsBoard: React.FC<VideoProjectBoardProps> = (props) => {
  const {project, scene, visual, lead, overFootage, vertical} = props;
  const brand = project.contract.brand;
  const {frame, at} = useBoardTiming(props);
  const items = boardItems(visual.items);
  const motif = boardMotifSrc(project, visual.motif);
  const dense = items.length >= 4;
  return <BoardStage project={project} kind={visual.kind} overFootage={overFootage} vertical={vertical}>
    <BoardKicker project={project} text={scene.eyebrow} vertical={vertical} style={boardEnter(frame, lead, 12)} />
    <div style={{display: "flex", alignItems: "center", gap: 40, marginBottom: vertical ? 48 : 44}}>
      <BoardTitle project={project} text={boardString(visual.title)} size={vertical ? 76 : 68} style={{flex: 1, ...boardEnter(frame, lead + 4, 18)}} />
      {motif ? <Img src={motif} style={{width: vertical ? 180 : 160, height: vertical ? 180 : 160, objectFit: "contain", opacity: boardFade(frame, lead + 10, 20)}} /> : null}
    </div>
    <div style={{display: "flex", flexDirection: vertical ? "column" : "row", gap: vertical ? 22 : 26, alignItems: "stretch"}}>
      {items.map((item, index) => <div key={`${item.label}-${index}`} style={{flex: 1, minWidth: 0, padding: vertical ? "26px 34px" : dense ? "26px 24px 28px" : "30px 32px 32px", backgroundColor: brand.colors.panel, borderTop: vertical ? undefined : `4px solid ${brand.colors.accent}`, borderLeft: vertical ? `6px solid ${brand.colors.accent}` : undefined, ...boardEnter(frame, at(item.cue, index, items.length))}}>
        <div style={{color: brand.colors.text, fontFamily: brand.fonts.display, fontSize: vertical ? 54 : dense ? 40 : 46, fontWeight: 700, lineHeight: 1.05, textWrap: "pretty"}}>{tieOrphan(item.label)}</div>
        <BoardNote project={project} text={item.note} size={vertical ? 34 : dense ? 26 : 30} />
      </div>)}
    </div>
  </BoardStage>;
};

const CompareBoard: React.FC<VideoProjectBoardProps> = (props) => {
  const {project, scene, visual, lead, overFootage, vertical} = props;
  const brand = project.contract.brand;
  const {frame, at} = useBoardTiming(props);
  const sides = [visual.left, visual.right].map((side) => {
    const record = side && typeof side === "object" ? side as Record<string, unknown> : {};
    return {title: boardString(record.title), items: boardItems(record.items)};
  });
  // One reveal order across both sides: every left item, then every right item.
  const count = sides[0].items.length + sides[1].items.length;
  let index = 0;
  const columns = sides.map((side, sideIndex) => {
    const reveals = side.items.map((item) => at(item.cue, index++, count));
    const titleAt = sideIndex === 0 ? lead : Math.max(lead, (reveals[0] ?? lead) - 10);
    return <div key={sideIndex} style={{flex: 1, minWidth: 0}}>
      <div style={{color: brand.colors.accent, fontFamily: brand.fonts.ui, fontSize: vertical ? 40 : 36, fontWeight: 700, letterSpacing: 3, textTransform: "uppercase", marginBottom: vertical ? 22 : 28, ...boardEnter(frame, titleAt, 14)}}>{side.title}</div>
      {side.items.map((item, itemIndex) => <div key={`${item.label}-${itemIndex}`} style={{marginBottom: vertical ? 20 : 26, ...boardEnter(frame, reveals[itemIndex], 14)}}>
        <div style={{color: brand.colors.text, fontFamily: brand.fonts.display, fontSize: vertical ? 56 : 52, fontWeight: 700, lineHeight: 1.05}}>{tieOrphan(item.label)}</div>
        <BoardNote project={project} text={item.note} size={vertical ? 32 : 30} style={{marginTop: 6}} />
      </div>)}
    </div>;
  });
  const divider = interpolate(frame, [lead + 4, lead + 28], [0, 1], boardClamp);
  return <BoardStage project={project} kind={visual.kind} overFootage={overFootage} vertical={vertical}>
    <BoardKicker project={project} text={scene.eyebrow} vertical={vertical} style={{marginBottom: vertical ? 40 : 36, ...boardEnter(frame, lead, 12)}} />
    <div style={{display: "flex", flexDirection: vertical ? "column" : "row", gap: vertical ? 40 : 80, alignItems: "stretch"}}>
      {columns[0]}
      <div style={{flex: "none", backgroundColor: brand.colors.accent, opacity: 0.7, ...(vertical ? {height: 3, width: "100%", transformOrigin: "0 50%", transform: `scaleX(${divider})`} : {width: 3, transformOrigin: "50% 0", transform: `scaleY(${divider})`})}} />
      {columns[1]}
    </div>
  </BoardStage>;
};

const FlowBoard: React.FC<VideoProjectBoardProps> = (props) => {
  const {project, scene, visual, lead, overFootage, vertical} = props;
  const brand = project.contract.brand;
  const {frame, at} = useBoardTiming(props);
  const nodes = boardItems(visual.nodes);
  const reveals = nodes.map((node, index) => at(node.cue, index, nodes.length));
  const outcome = boardString(visual.outcome);
  const outcomeAt = (reveals.at(-1) ?? lead) + 16;
  return <BoardStage project={project} kind={visual.kind} overFootage={overFootage} vertical={vertical}>
    <BoardKicker project={project} text={scene.eyebrow} vertical={vertical} style={{marginBottom: vertical ? 40 : 40, ...boardEnter(frame, lead, 12)}} />
    <div style={{display: "flex", flexDirection: vertical ? "column" : "row", alignItems: vertical ? "stretch" : "center"}}>
      {nodes.map((node, index) => <React.Fragment key={`${node.label}-${index}`}>
        {index > 0 ? <div style={{flex: "none", backgroundColor: brand.colors.accent, ...(vertical
          ? {width: 4, height: 44, marginLeft: 44, transformOrigin: "50% 0", transform: `scaleY(${interpolate(frame, [reveals[index] - 10, reveals[index]], [0, 1], boardClamp)})`}
          : {height: 4, width: 56, transformOrigin: "0 50%", transform: `scaleX(${interpolate(frame, [reveals[index] - 10, reveals[index]], [0, 1], boardClamp)})`})}} /> : null}
        <div style={{flex: vertical ? "none" : 1, minWidth: 0, padding: vertical ? "22px 30px" : "26px 26px 28px", border: `3px solid ${brand.colors.accent}`, backgroundColor: brand.colors.panel, ...boardEnter(frame, reveals[index], 16)}}>
          <div style={{color: brand.colors.text, fontFamily: brand.fonts.display, fontSize: vertical ? 50 : 40, fontWeight: 700, lineHeight: 1.05}}>{tieOrphan(node.label)}</div>
          <BoardNote project={project} text={node.note} size={vertical ? 30 : 26} style={{marginTop: 6}} />
        </div>
      </React.Fragment>)}
    </div>
    {outcome ? <div style={{marginTop: vertical ? 44 : 48, display: "flex", alignItems: "center", gap: 22, ...boardEnter(frame, outcomeAt, 16)}}>
      <span style={{width: 0, height: 0, borderTop: "14px solid transparent", borderBottom: "14px solid transparent", borderLeft: `22px solid ${brand.colors.accent}`}} />
      <span style={{color: brand.colors.accent, fontFamily: brand.fonts.display, fontSize: vertical ? 60 : 54, fontWeight: 700, lineHeight: 1.05}}>{tieOrphan(outcome)}</span>
    </div> : null}
  </BoardStage>;
};

const StepsBoard: React.FC<VideoProjectBoardProps> = (props) => {
  const {project, scene, visual, lead, overFootage, vertical} = props;
  const brand = project.contract.brand;
  const {frame, at} = useBoardTiming(props);
  const steps = boardItems(visual.steps);
  const reveals = steps.map((step, index) => at(step.cue, index, steps.length));
  const badge = vertical ? 76 : 72;
  return <BoardStage project={project} kind={visual.kind} overFootage={overFootage} vertical={vertical}>
    <BoardKicker project={project} text={scene.eyebrow} vertical={vertical} style={boardEnter(frame, lead, 12)} />
    <BoardTitle project={project} text={boardString(visual.title)} size={vertical ? 76 : 68} style={{marginBottom: vertical ? 48 : 56, ...boardEnter(frame, lead + 4, 18)}} />
    <div style={{display: "flex", flexDirection: vertical ? "column" : "row", gap: vertical ? 30 : 28}}>
      {steps.map((step, index) => <div key={`${step.label}-${index}`} style={{flex: 1, minWidth: 0, position: "relative", display: "flex", flexDirection: vertical ? "row" : "column", alignItems: "flex-start", gap: vertical ? 30 : 22}}>
        {!vertical && index < steps.length - 1 ? <div style={{position: "absolute", top: badge / 2 - 2, left: badge + 14, right: -14, height: 4, backgroundColor: brand.colors.accent, opacity: 0.55, transformOrigin: "0 50%", transform: `scaleX(${interpolate(frame, [reveals[index] + 6, Math.max(reveals[index] + 7, reveals[index + 1])], [0, 1], boardClamp)})`}} /> : null}
        <div style={{flex: "none", width: badge, height: badge, borderRadius: badge, display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: brand.colors.accent, color: brand.colors.background, fontFamily: brand.fonts.ui, fontSize: badge * 0.46, fontWeight: 700, fontVariantNumeric: "lining-nums", opacity: boardFade(frame, reveals[index], 10)}}>{index + 1}</div>
        <div style={{minWidth: 0, ...boardEnter(frame, reveals[index], 16)}}>
          <div style={{color: brand.colors.text, fontFamily: brand.fonts.display, fontSize: vertical ? 52 : 42, fontWeight: 700, lineHeight: 1.05, textWrap: "pretty"}}>{tieOrphan(step.label)}</div>
          <BoardNote project={project} text={step.note} size={vertical ? 32 : 28} style={{marginTop: 8}} />
        </div>
      </div>)}
    </div>
  </BoardStage>;
};

const DocumentBoard: React.FC<VideoProjectBoardProps> = (props) => {
  const {project, scene, visual, lead, overFootage, vertical} = props;
  const brand = project.contract.brand;
  const {frame, at} = useBoardTiming(props);
  const rows = boardRows(visual.lines);
  return <BoardStage project={project} kind={visual.kind} overFootage={overFootage} vertical={vertical} center>
    <div style={{width: vertical ? "100%" : 1140, textAlign: "left", padding: vertical ? "48px 46px 52px" : "54px 64px 60px", backgroundColor: brand.colors.panel, borderTop: `8px solid ${brand.colors.accent}`, boxShadow: `0 30px 80px color-mix(in srgb, ${brand.colors.background} 60%, transparent)`, ...boardEnter(frame, lead, 30)}}>
      <BoardKicker project={project} text={scene.eyebrow} vertical={vertical} style={{marginBottom: 14}} />
      <BoardTitle project={project} text={boardString(visual.title)} size={vertical ? 70 : 62} />
      <div style={{height: 2, backgroundColor: brand.colors.muted, opacity: 0.35, margin: vertical ? "30px 0 16px" : "32px 0 18px"}} />
      {rows.map((row, index) => {
        const reveal = at(row.cue, index, rows.length);
        return <div key={`${row.label}-${index}`} data-highlight={row.highlight ? "" : undefined} style={{display: "flex", flexDirection: vertical ? "column" : "row", alignItems: vertical ? "flex-start" : "baseline", gap: vertical ? 4 : 32, padding: "16px 0", ...boardEnter(frame, reveal, 12)}}>
          <div style={{flex: "none", width: vertical ? undefined : 340, color: brand.colors.muted, fontFamily: brand.fonts.ui, fontSize: vertical ? 28 : 26, fontWeight: 700, letterSpacing: 2, textTransform: "uppercase"}}>{row.label}</div>
          <div style={{position: "relative", color: row.highlight ? brand.colors.accent : brand.colors.text, fontFamily: brand.fonts.body, fontSize: vertical ? 48 : 44, fontWeight: 700, lineHeight: 1.1}}>
            {tieOrphan(row.value)}
            {row.highlight ? <div style={{position: "absolute", left: 0, right: 0, bottom: -6, height: 4, backgroundColor: brand.colors.accent, transformOrigin: "0 50%", transform: `scaleX(${interpolate(frame, [reveal + 10, reveal + 26], [0, 1], boardClamp)})`}} /> : null}
          </div>
        </div>;
      })}
    </div>
  </BoardStage>;
};

// The compiler inserts this board from producer.subscribe with `topic` and
// `solution`; `question` and `line` are optional authored overrides. The
// default copy is generic on purpose: a Design System replaces it by authoring the
// fields or registering its own `Boards.subscribe`. SceneView draws the
// brand watermark above every board, so the logo is already on screen.
const SubscribeBoard: React.FC<VideoProjectBoardProps> = (props) => {
  const {project, visual, lead, overFootage, vertical} = props;
  const brand = project.contract.brand;
  const {frame, at} = useBoardTiming(props);
  const question = boardString(visual.question) || `Do you want to know more about ${boardString(visual.topic)}?`;
  const cta = boardString(visual.line) || `Subscribe to learn how to ${boardString(visual.solution)}.`;
  const ctaAt = Math.max(lead + 16, at("subscribe", 1, 2));
  return <BoardStage project={project} kind={visual.kind} overFootage={overFootage} vertical={vertical} center>
    <BoardTitle project={project} text={question} size={vertical ? 88 : 80} style={{maxWidth: vertical ? undefined : 1400, ...boardEnter(frame, lead + 4, 24)}} />
    <div style={{width: vertical ? 160 : 130, height: 4, backgroundColor: brand.colors.accent, margin: vertical ? "54px 0" : "42px 0", transform: `scaleX(${interpolate(frame, [ctaAt - 8, ctaAt + 10], [0, 1], boardClamp)})`}} />
    <div style={{color: brand.colors.accent, fontFamily: brand.fonts.body, fontSize: vertical ? 54 : 48, fontWeight: 700, lineHeight: 1.12, maxWidth: vertical ? undefined : 1300, textWrap: "pretty", ...boardEnter(frame, ctaAt, 18)}}>{tieOrphan(cta)}</div>
  </BoardStage>;
};

const defaultBoards = {
  "chapter-title": ChapterTitleBoard,
  statement: StatementBoard,
  cards: CardsBoard,
  compare: CompareBoard,
  flow: FlowBoard,
  steps: StepsBoard,
  document: DocumentBoard,
  subscribe: SubscribeBoard,
} satisfies Record<(typeof DEFAULT_BOARD_KINDS)[number], React.ComponentType<VideoProjectBoardProps>>;

/**
 * The boards a scene may mount by kind. A client that supplies its own
 * `Graphic` owns every kind it does not register in `Boards`, so the TimDS
 * defaults apply only when it supplies no `Graphic` and has adopted a board
 * catalog; any kind missing from this map draws through `Graphic`.
 */
const resolveVideoBoards = (components: VideoProjectComponentOverrides | undefined, useDefaults = true): Record<string, React.ComponentType<VideoProjectBoardProps>> =>
  components?.Graphic || !useDefaults ? {...components?.Boards} : {...defaultBoards, ...components?.Boards};

/**
 * The component that draws `kind`: the client's `Boards[kind]`, then the
 * client's `Graphic`, then (with a catalog) the TimDS default board, then the
 * copy fallback. Explicit client Boards work with or without a catalog.
 */
const resolveVideoBoardComponent = (components: VideoProjectComponentOverrides | undefined, kind: string, useDefaults = true): React.ComponentType<VideoProjectBoardProps> => {
  const boards = resolveVideoBoards(components, useDefaults);
  return Object.hasOwn(boards, kind) ? boards[kind] : components?.Graphic ?? GraphicBoard;
};

const SceneView: React.FC<VideoProjectSceneProps> = ({project, scene, line, duration, lead, vertical, components}) => {
  const IntroComponent = components?.Intro ?? Intro;
  const OutroComponent = components?.Outro ?? Outro;
  if (scene.intro) return <><IntroComponent project={project} question={scene.headline || line.words.map((word) => word.text).join(" ")} vertical={vertical} /><BrandWatermark project={project} vertical={vertical} sceneHasLogo /></>;
  if (scene.outro) return <><OutroComponent project={project} vertical={vertical} /><BrandWatermark project={project} vertical={vertical} sceneHasLogo /></>;
  const assetKeys = sceneAssetKeys(scene);
  if (scene.visual) {
    // A graphic scene: the board plays over the footage chain when the scene
    // names clips, otherwise on the brand background. Watermark and captions
    // stay TimDS-owned so every board keeps the brand frame. A kind with no
    // registered board falls back to Graphic, which draws the scene copy.
    const BoardComponent = resolveVideoBoardComponent(components, scene.visual.kind, Boolean(project.contract.boards));
    return <AbsoluteFill>
      {assetKeys.length ? <Media project={project} scene={scene} duration={duration} vertical={vertical} /> : null}
      <BoardComponent project={project} scene={scene} visual={scene.visual} line={line} duration={duration} lead={lead} overFootage={assetKeys.length > 0} vertical={vertical} />
      <BrandWatermark project={project} vertical={vertical} />
      <CaptionPages project={project} line={line} lead={lead} vertical={vertical} />
    </AbsoluteFill>;
  }
  return <AbsoluteFill>
    <Media project={project} scene={scene} duration={duration} vertical={vertical} />
    <SceneCopy project={project} scene={scene} vertical={vertical} />
    <BrandWatermark project={project} vertical={vertical} />
    <CaptionPages project={project} line={line} lead={lead} vertical={vertical} />
  </AbsoluteFill>;
};

const Video: React.FC<VideoProjectVideoProps> = ({project, scenes, ids, pads = {}, audioSrc, vertical, components}) => {
  let cursor = 0;
  const SceneComponent = components?.Scene ?? SceneView;
  return <AbsoluteFill style={{backgroundColor: project.contract.brand.colors.background, fontVariantNumeric: "lining-nums"}}>
    {typeof audioSrc === "string" ? <Audio src={staticFile(audioSrc)} /> : null}
    {ids.map((id) => {
      const scene = scenes.find((candidate) => candidate.id === id);
      if (!scene) throw new Error(`TimDS video: no scene definition for ${id}`);
      const line = lineById(project, id);
      const duration = sceneFrames(project, id, pads);
      const from = cursor;
      cursor += duration;
      const lead = Number(pads[id]?.lead || 0);
      return <Sequence key={id} from={from} durationInFrames={duration}>
        <SceneComponent project={project} scene={scene} line={line} duration={duration} lead={lead} vertical={vertical} components={components} />
        {audioSrc === undefined ? <Sequence from={lead} durationInFrames={frames(line.durationMs, project.contract.fps)}><Audio src={staticFile(`audio/${project.records.production.slug}/${id}.mp3`)} /></Sequence> : null}
      </Sequence>;
    })}
  </AbsoluteFill>;
};

export const resolveCoverObjectPosition = (
  cover: VideoProjectCover,
  asset: VideoProjectAsset,
  vertical = false,
) => cover.objectPosition || asset.objectPosition || (vertical ? "67% 50%" : "50% 50%");

const CoverVisual: React.FC<VideoProjectCoverProps> = ({project, cover, vertical}) => {
  const asset = project.assets[cover.asset];
  if (!asset) throw new Error(`TimDS video: missing cover asset ${cover.asset}`);
  const style = {
    width: "100%",
    height: "100%",
    objectFit: "cover" as const,
    objectPosition: resolveCoverObjectPosition(cover, asset, vertical),
    transform: vertical ? "scale(1.04)" : undefined,
  };
  return asset.kind === "video"
    ? <OffthreadVideo muted src={staticFile(asset.src)} startFrom={frames(Number(cover.atSeconds || 0) * 1000, project.contract.fps)} style={style} />
    : <Img src={staticFile(asset.src)} style={style} />;
};

const HorizontalCover: React.FC<VideoProjectCoverProps> = ({project, cover}) => {
  const brand = project.contract.brand;
  const {width} = useVideoConfig();
  const headline = cover.headline || "";
  const scale = horizontalCoverScale(width);
  return <AbsoluteFill style={{backgroundColor: brand.colors.background, fontVariantNumeric: "lining-nums", overflow: "hidden"}}>
    <div style={{position: "relative", width: HORIZONTAL_COVER_DESIGN_WIDTH, height: HORIZONTAL_COVER_DESIGN_HEIGHT, transform: `scale(${scale})`, transformOrigin: "0 0"}}>
      <CoverVisual project={project} cover={cover} />
      <AbsoluteFill style={{background: `linear-gradient(90deg, ${brand.colors.background} 0%, ${brand.colors.background}ee 46%, transparent 82%)`}} />
      <AbsoluteFill style={{justifyContent: "center", alignItems: "flex-start", padding: "0 120px", width: "68%"}}>
        <div style={{color: brand.colors.accent, fontFamily: brand.fonts.ui, fontSize: 28, fontWeight: 700, letterSpacing: 6, textTransform: "uppercase", marginBottom: 26}}>{cover.eyebrow || brand.series}</div>
        <div style={{color: brand.colors.text, fontFamily: brand.fonts.display, fontSize: fitCoverHeadline(headline), fontWeight: 700, lineHeight: 0.96, textWrap: "pretty"}}><GoldHeadline headline={headline} goldPhrase={cover.goldPhrase} color={brand.colors.accent} /></div>
        <Img src={staticFile(brand.logo)} style={{width: 360, marginTop: 58}} />
      </AbsoluteFill>
    </div>
  </AbsoluteFill>;
};

const VerticalCover: React.FC<VideoProjectCoverProps> = ({project, cover}) => {
  const brand = project.contract.brand;
  const headline = cover.headline || "";
  return <AbsoluteFill style={{backgroundColor: brand.colors.background, fontVariantNumeric: "lining-nums"}}>
    <div style={{position: "absolute", inset: "0 0 auto", height: 1280, overflow: "hidden"}}>
      <CoverVisual project={project} cover={cover} vertical />
    </div>
    <AbsoluteFill style={{background: `linear-gradient(180deg, color-mix(in srgb, ${brand.colors.background} 42%, transparent) 0%, color-mix(in srgb, ${brand.colors.background} 12%, transparent) 43%, color-mix(in srgb, ${brand.colors.background} 94%, transparent) 66%, ${brand.colors.background} 100%)`}} />
    <div style={{position: "absolute", top: 168, left: 104, display: "flex", alignItems: "center", gap: 17}}>
      <div style={{width: 14, height: 14, backgroundColor: brand.colors.accent, rotate: "45deg"}} />
      <div style={{color: brand.colors.accent, fontFamily: brand.fonts.ui, fontSize: 26, fontWeight: 700, letterSpacing: 6, textTransform: "uppercase"}}>{cover.eyebrow || brand.series}</div>
    </div>
    <div style={{position: "absolute", left: 92, right: 92, bottom: 300, color: brand.colors.text, fontFamily: brand.fonts.display, fontSize: fitCoverHeadline(headline), fontWeight: 700, lineHeight: 1.01, textWrap: "pretty", textShadow: `0 4px 30px ${brand.colors.background}`}}>
      <GoldHeadline headline={headline} goldPhrase={cover.goldPhrase} color={brand.colors.accent} />
    </div>
    <Img src={staticFile(brand.logo)} style={{position: "absolute", right: 76, top: 94, width: 300, opacity: 0.94}} />
  </AbsoluteFill>;
};

const Cover: React.FC<VideoProjectCoverProps> = (props) => props.vertical
  ? <VerticalCover {...props} />
  : <HorizontalCover {...props} />;

export const defaultVideoProjectComponents = {
  Video,
  Scene: SceneView,
  Graphic: GraphicBoard,
  Boards: defaultBoards,
  Intro,
  Outro,
  Cover,
  HorizontalCover,
  VerticalCover,
} satisfies Required<VideoProjectComponentOverrides>;
// TIMDS_DEFAULT_COMPONENTS_END

export function resolveVideoProjectComponents(components: VideoProjectComponentOverrides = {}) {
  return {
    Video: components.Video ?? Video,
    Scene: components.Scene ?? SceneView,
    Graphic: components.Graphic ?? GraphicBoard,
    // Only the kinds a scene mounts directly; any other kind draws through
    // Graphic. A client-supplied Graphic keeps every kind it does not register.
    Boards: resolveVideoBoards(components),
    Intro: components.Intro ?? Intro,
    Outro: components.Outro ?? Outro,
    Cover: components.Cover ?? Cover,
    HorizontalCover: components.HorizontalCover ?? components.Cover ?? HorizontalCover,
    VerticalCover: components.VerticalCover ?? components.Cover ?? VerticalCover,
  } satisfies Required<VideoProjectComponentOverrides>;
}

export function createVideoProjectRoot(project: VideoProject, components: VideoProjectComponentOverrides = {}) {
  assertRuntimeCompatibility(project.contract.runtime, componentRuntime);
  loadVideoProjectFonts(project);
  const resolved = resolveVideoProjectComponents(components);
  const prefix = project.records.production.slug.split("-").map((part: string) => `${part[0].toUpperCase()}${part.slice(1)}`).join("");
  const longform = project.records.production.longform;
  const longIds = longform.scenes.map((scene: VideoProjectScene) => scene.id);
  const VideoComponent = resolved.Video;
  const HorizontalCoverComponent = resolved.HorizontalCover;
  const VerticalCoverComponent = resolved.VerticalCover;
  const Long = () => <VideoComponent project={project} scenes={longform.scenes} ids={longIds} pads={longform.pads} audioSrc={longform.audioSrc} components={components} />;
  const LongCover = () => <HorizontalCoverComponent project={project} cover={longform.cover} />;
  return () => {
    useVideoProjectFonts(project);
    return <>
      <Composition id={`${prefix}Long`} component={Long} durationInFrames={totalFrames(project, longIds, longform.pads)} fps={project.contract.fps} width={project.contract.formats.longform.width} height={project.contract.formats.longform.height} />
      <Composition id={`${prefix}Cover`} component={LongCover} durationInFrames={1} fps={project.contract.fps} width={project.contract.formats.cover.width} height={project.contract.formats.cover.height} />
      {project.records.production.shorts.map((short: any, index: number) => {
        const Short = () => <VideoComponent project={project} scenes={short.scenes} ids={short.harvest} pads={short.pads} audioSrc={short.audioSrc} vertical components={components} />;
        const ShortCover = () => <VerticalCoverComponent project={project} cover={short.cover} vertical />;
        return <React.Fragment key={short.id}>
          <Composition id={`${prefix}Short${index + 1}`} component={Short} durationInFrames={totalFrames(project, short.harvest, short.pads)} fps={project.contract.fps} width={project.contract.formats.short.width} height={project.contract.formats.short.height} />
          <Composition id={`${prefix}Short${index + 1}Cover`} component={ShortCover} durationInFrames={1} fps={project.contract.fps} width={project.contract.formats.short.width} height={project.contract.formats.short.height} />
        </React.Fragment>;
      })}
    </>;
  };
}

export function createSingleVideoProjectRoot(project: VideoProject, components: VideoProjectComponentOverrides = {}) {
  assertRuntimeCompatibility(project.contract.runtime, componentRuntime);
  loadVideoProjectFonts(project);
  const resolved = resolveVideoProjectComponents(components);
  const production = project.records.production;
  const vertical = production.outputFormat === "short";
  if (!vertical && production.outputFormat !== "horizontal") throw new Error(`TimDS video: unsupported single production format ${String(production.outputFormat)}`);
  const ids = production.scenes.map((scene: VideoProjectScene) => scene.id);
  const ProjectVideoComponent = resolved.Video;
  const ProjectCoverComponent = vertical ? resolved.VerticalCover : resolved.HorizontalCover;
  const VideoComponent = () => <ProjectVideoComponent project={project} scenes={production.scenes} ids={ids} pads={production.pads} audioSrc={production.audioSrc} vertical={vertical} components={components} />;
  const CoverComponent = () => <ProjectCoverComponent project={project} cover={production.cover} vertical={vertical} />;
  const format = vertical ? project.contract.formats.short : project.contract.formats.longform;
  const coverFormat = vertical ? project.contract.formats.short : project.contract.formats.cover;
  return () => {
    useVideoProjectFonts(project);
    return <>
      <Composition id="TimDSVideo" component={VideoComponent} durationInFrames={totalFrames(project, ids, production.pads)} fps={project.contract.fps} width={format.width} height={format.height} />
      <Composition id="TimDSCover" component={CoverComponent} durationInFrames={1} fps={project.contract.fps} width={coverFormat.width} height={coverFormat.height} />
    </>;
  };
}

export function loadVideoProjectFonts(project: VideoProject) {
  if (project.schemaVersion !== 1) throw new Error(`TimDS video: unsupported project schema ${String(project.schemaVersion)}`);
  if (typeof document === "undefined") return;
  // Style injection is synchronous; the project root waits for document.fonts
  // after it mounts so every renderer tab clears its own delayRender handle.
  const css = videoFontStyles(project);
  if (!css || Array.from(document.querySelectorAll("style[data-timds-video-fonts]"))
    .some((element) => element.textContent === css)) return;
  const style = document.createElement("style");
  style.dataset.timdsVideoFonts = "true";
  style.textContent = css;
  document.head.appendChild(style);
}

export function registerVideoProject(project: VideoProject, components: VideoProjectComponentOverrides = {}) {
  loadVideoProjectFonts(project);
  registerRoot(createVideoProjectRoot(project, components));
}

/** The kinds `defaultVideoProjectComponents.Boards` draws; the same list as `DEFAULT_BOARD_KINDS` in `@dtconcepts/timds/video/boards`. */
export const defaultVideoBoardKinds: string[] = [...DEFAULT_BOARD_KINDS];

export { deriveVideoChapters };
/** Where a board's `motif` stem draws from, or null when the project stages no file for it. */
export { boardMotifSrc as videoBoardMotifSrc };
export {
  BrandWatermark,
  CaptionPages,
  CardsBoard,
  ChapterTitleBoard,
  CompareBoard,
  Cover,
  CoverVisual,
  DocumentBoard,
  FlowBoard,
  GoldHeadline,
  GraphicBoard,
  HorizontalCover,
  Intro,
  Media,
  Outro,
  resolveVideoBoardComponent,
  SceneView,
  StatementBoard,
  StepsBoard,
  SubscribeBoard,
  VerticalCover,
  Video,
};
export {fitCoverHeadline, splitGoldHeadline, tieOrphan};
export type {CoverHeadlineFitOptions} from "./text.mjs";

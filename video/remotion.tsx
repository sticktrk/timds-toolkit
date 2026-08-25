import React, { useEffect, useMemo, useState } from "react";
import { Audio } from "@remotion/media";
import {
  AbsoluteFill,
  cancelRender,
  Composition,
  continueRender,
  delayRender,
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

/** A client Design System may replace any subset of the TimDS defaults. */
export type VideoProjectComponentOverrides = {
  Video?: React.ComponentType<VideoProjectVideoProps>;
  Scene?: React.ComponentType<VideoProjectSceneProps>;
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

const BrandWatermark: React.FC<{project: VideoProject; vertical?: boolean; sceneHasLogo?: boolean}> = ({project, vertical, sceneHasLogo}) => {
  const brand = project.contract.brand;
  return <>
    {!sceneHasLogo ? <Img src={staticFile(brand.logo)} style={{position: "absolute", top: vertical ? 116 : 38, left: vertical ? 48 : 48, width: vertical ? 190 : 210, opacity: 0.82}} /> : null}
    <div style={{position: "absolute", left: vertical ? 48 : 48, bottom: vertical ? 112 : 34, color: brand.colors.text, fontFamily: brand.fonts.ui, fontSize: vertical ? 24 : 20, fontWeight: 700, letterSpacing: 1.5, textShadow: `0 2px 14px ${brand.colors.background}`}}>{brand.watermark.left}</div>
    <div style={{position: "absolute", right: vertical ? 150 : 48, bottom: vertical ? 112 : 34, color: brand.colors.text, fontFamily: brand.fonts.ui, fontSize: vertical ? 24 : 20, fontWeight: 700, letterSpacing: 1.5, textShadow: `0 2px 14px ${brand.colors.background}`}}>{brand.watermark.right}</div>
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

const Media: React.FC<{project: VideoProject; scene: VideoProjectScene; duration: number; vertical?: boolean}> = ({project, scene, duration, vertical}) => {
  const frame = useCurrentFrame();
  const keys = scene.assets || (scene.asset ? [scene.asset] : []);
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
  let cursor = 0;
  return <AbsoluteFill>
    {keys.map((key, index) => {
      const asset = project.assets[key];
      const remaining = duration - cursor;
      const clipFrames = Math.min(availableFrames[index], remaining);
      const from = cursor;
      cursor += clipFrames;
      if (clipFrames <= 0) return null;
      const zoom = interpolate(frame, [0, Math.max(1, duration - 1)], [1.01, 1.065], {extrapolateLeft: "clamp", extrapolateRight: "clamp"});
      return <Sequence key={key} from={from} durationInFrames={clipFrames}>
        <OffthreadVideo muted src={staticFile(asset.src)} style={{width: "100%", height: "100%", objectFit: "cover", objectPosition: asset.objectPosition || "50% 50%", transform: `${asset.flip ? "scaleX(-1) " : ""}scale(${zoom})`}} />
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

const SceneView: React.FC<VideoProjectSceneProps> = ({project, scene, line, duration, lead, vertical, components}) => {
  const brand = project.contract.brand;
  const IntroComponent = components?.Intro ?? Intro;
  const OutroComponent = components?.Outro ?? Outro;
  if (scene.intro) return <><IntroComponent project={project} question={scene.headline || line.words.map((word) => word.text).join(" ")} vertical={vertical} /><BrandWatermark project={project} vertical={vertical} sceneHasLogo /></>;
  if (scene.outro) return <><OutroComponent project={project} vertical={vertical} /><BrandWatermark project={project} vertical={vertical} sceneHasLogo /></>;
  const firstAsset = project.assets[(scene.assets || [scene.asset])[0] || ""];
  const right = firstAsset?.text?.startsWith("right");
  const lower = firstAsset?.text === "lower" || firstAsset?.text?.endsWith("bottom");
  return <AbsoluteFill>
    <Media project={project} scene={scene} duration={duration} vertical={vertical} />
    <AbsoluteFill style={{alignItems: vertical ? "center" : right ? "flex-end" : "flex-start", justifyContent: vertical ? lower ? "flex-end" : "flex-start" : lower ? "flex-end" : "center", padding: vertical ? lower ? "0 150px 430px 70px" : "240px 150px 0 70px" : "0 120px 150px"}}>
      <div style={{width: vertical ? "100%" : 830, padding: vertical ? 0 : "42px 50px 46px", textAlign: vertical ? "center" : "left", backgroundColor: vertical ? "transparent" : brand.colors.panel, borderLeft: vertical ? undefined : `9px solid ${brand.colors.accent}`, textShadow: vertical ? `0 3px 26px ${brand.colors.background}` : undefined}}>
        {scene.eyebrow ? <div style={{color: brand.colors.accent, fontFamily: brand.fonts.ui, fontSize: vertical ? 26 : 22, fontWeight: 700, letterSpacing: 5, textTransform: "uppercase", marginBottom: 18}}>{scene.eyebrow}</div> : null}
        <div style={{color: brand.colors.text, fontFamily: brand.fonts.display, fontSize: vertical ? 110 : 72, fontWeight: 700, lineHeight: 0.98, textWrap: "pretty"}}><GoldHeadline headline={scene.headline} goldPhrase={scene.goldPhrase} color={brand.colors.accent} /></div>
        {scene.subline ? <div style={{color: brand.colors.muted, fontFamily: brand.fonts.body, fontSize: 32, marginTop: 20}}>{tieOrphan(scene.subline)}</div> : null}
      </div>
    </AbsoluteFill>
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
    Intro: components.Intro ?? Intro,
    Outro: components.Outro ?? Outro,
    Cover: components.Cover ?? Cover,
    HorizontalCover: components.HorizontalCover ?? components.Cover ?? HorizontalCover,
    VerticalCover: components.VerticalCover ?? components.Cover ?? VerticalCover,
  } satisfies Required<VideoProjectComponentOverrides>;
}

export function createVideoProjectRoot(project: VideoProject, components: VideoProjectComponentOverrides = {}) {
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

export { Cover, GoldHeadline, HorizontalCover, Intro, Outro, SceneView, VerticalCover, Video };

import type {RuntimeIdentity, RuntimeRequirements} from "./runtime.mjs";
export type ProducerOutputFormat = "horizontal" | "short";
export type ProducerBeatRole = "hook" | "rule" | "risk" | "process" | "exception" | "answer";
export type ProducerCompileInput = {
  schemaVersion: 1;
  slug: string;
  outputFormat: ProducerOutputFormat;
  exactQuestion: string;
  topic: {label: string; engagementQuestion?: string; coverEmotion?: string; solution?: string};
  /**
   * `footage`: one to FOOTAGE_PICKS_PER_BEAT ordered clip keys from the authoring contract's footage.clips, best match first.
   * `visual`: a board of a kind the Design System's board catalog declares. `boardGap`: no declared kind fits this beat.
   */
  answerBeats: Array<{id: string; role: ProducerBeatRole; narration: string; summary: string; footage?: string[]; chapter?: string; visual?: ProducerBoardVisual; boardGap?: string}>;
};
export type ProducerBoardVisual = {kind: string; [field: string]: unknown};
export type ProducerCompiledScene = {id: string; role: string; narration: string; eyebrow?: string; headline?: string; intro?: boolean; outro?: boolean; footage?: string[]; chapter?: string; visual?: ProducerBoardVisual; boardGap?: string};
export type ProducerCompiledProduction = {
  schemaVersion: 1;
  producerContractVersion: number;
  runtime: RuntimeIdentity;
  slug: string;
  outputFormat: ProducerOutputFormat;
  exactQuestion: string;
  topic: ProducerCompileInput["topic"];
  scenes: ProducerCompiledScene[];
  cover: {eyebrow: string; headline: string};
};
export type ProducerMedia = {key: string; filename: string; publicUrl: string; durationSeconds?: number; bytes?: number; sha256?: string; [key: string]: unknown};
export type ProducerFinalized = {
  schemaVersion: 1;
  producerContractVersion: number;
  runtime: RuntimeIdentity;
  plan: {
    schemaVersion: 1;
    slug: string;
    outputFormat: ProducerOutputFormat;
    lines: Array<{id: string; durationMs: number; words: Array<{text: string; startMs: number; endMs: number}>}>;
    scenes: Array<{id: string; asset?: string; verticalAsset?: string; assets?: string[]; verticalAssets?: string[]; intro?: boolean; outro?: boolean; [key: string]: unknown}>;
    /** Present when any scene has a chapter: each chapter's label and where its first scene starts in the take. */
    chapters?: Array<{id: string; label: string; startMs: number}>;
    pads: Record<string, {lead?: number; tail?: number}>;
    audioSrc?: string | null;
    cover: {image?: string; eyebrow: string; headline: string};
  };
  coverSubject: ProducerMedia;
  footage: ProducerMedia[];
};
export type BoardSchemaNode = {
  type: "object" | "array" | "string" | "integer" | "number" | "boolean";
  description?: string;
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, BoardSchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
  items?: BoardSchemaNode;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  minLength?: number;
  maxLength?: number;
  "x-timds-maxWords"?: number;
  "x-timds-motif"?: true;
  "x-timds-cue"?: true;
  "x-timds-substringOf"?: string;
};
export type BoardConstraint = {
  when: {format?: "longform" | "short"; overFootage?: boolean};
  maxWords?: number;
  /** Dot-separated object-property paths in the kind's schema. Limits only tighten the base schema. */
  fields?: Record<string, Pick<BoardSchemaNode, "minItems" | "maxItems" | "minLength" | "maxLength" | "x-timds-maxWords">>;
};
/** A Design System's video/boards.json (raw or normalized). */
export type VideoBoardCatalog = {
  schemaVersion: 1;
  layoutPreset?: "standard" | "compact";
  formats?: {longform?: boolean; short?: boolean};
  cadence?: {maxConsecutiveFootageFree?: number | null; chapterReturnsToFootage?: boolean; minimumChapters?: number | null; maxBoardWords?: number | null};
  motifs?: {mount: string};
  kinds: Record<string, {label: string; use: string; avoid: string; overFootage?: "never" | "optional" | "always"; once?: boolean; schema: BoardSchemaNode; formats?: Array<"longform" | "short">; maxWords?: number; constraints?: BoardConstraint[]; layoutPreset?: "standard" | "compact"}>;
};
export type VideoBoardCatalogSummary = {
  schemaVersion: 1;
  layoutPreset?: "standard" | "compact";
  formats: {longform: boolean; short: boolean};
  cadence: {maxConsecutiveFootageFree: number | null; chapterReturnsToFootage: boolean; minimumChapters: number | null; maxBoardWords: number | null};
  motifs?: {mount: string};
  kinds: Array<{
    id: string;
    label: string;
    use: string;
    avoid: string;
    overFootage: "never" | "optional" | "always";
    once: boolean;
    layoutPreset?: "standard" | "compact";
    formats?: Array<"longform" | "short">;
    constraints?: BoardConstraint[];
    compilerOwned: boolean;
    required: string[];
    budgets: {maxWords?: number; fields: Record<string, number>};
    cues?: string[];
    motifs?: string[];
  }>;
};
export declare function resolveBoardKind(catalog: VideoBoardCatalog, kind: string, context: {format: ProducerOutputFormat | "longform"; overFootage: boolean}): VideoBoardCatalog["kinds"][string];
export type ProducerAuthoringContract = {
  schemaVersion: 2;
  producerContractVersion: number;
  runtime: RuntimeIdentity;
  designSystem: {id: string; name: string; version: string; commit: string; indexUrl?: string};
  outputFormat: ProducerOutputFormat;
  prompt: {instructions: string[]; blockIds: string[]; brief: string};
  /** Present when the contract was built with the asset and media catalogs: the clips a beat may name. */
  footage?: ProducerFootageCatalog;
  constraints: {
    headlineWords: number;
    topicLabelWords: {minimum: number; maximum: number};
    exactQuestion: {maximumWords: number; maximumCharacters: number; mustEndWithQuestionMark: true};
    engagementQuestion: {required: boolean; requireYesNoQuestion: boolean; maximumWords: number};
    answerBeatRoles: ProducerBeatRole[];
    reservedSceneIds: string[];
  };
  compilerOwns: string[];
  /** Present when the Design System has a board catalog; `active` says whether this format offers boards. */
  boards?: VideoBoardCatalogSummary & {active: boolean};
  inputSchema: Record<string, unknown>;
};
export type ProducerFootageClip = {key: string; title?: string; tags: string[]; durationSeconds: number};
export type ProducerFootageCatalog = {assetPrefix: string; maximumPerBeat: number; clips: ProducerFootageClip[]};
export declare const FOOTAGE_PICKS_PER_BEAT: 3;
export declare function validateVideoProducerConfig(input: unknown, contract: any): any | null;
export declare function createVideoAuthoringContract(input: {
  contract: any;
  manifest: any;
  designSystemIndex: any;
  provenance: {version?: string; commit: string; indexUrl?: string};
  outputFormat: ProducerOutputFormat;
  /** With `mediaCatalog`, the contract lists the eligible footage and the input schema accepts per-beat picks. */
  assetCatalog?: any;
  mediaCatalog?: any;
  verticalMetadata?: VideoVerticalMetadata | null;
  /** The Design System's board catalog. Without it the contract offers no boards, as before. */
  boards?: VideoBoardCatalog | null;
  /** Motif names resolved from the catalog's mount; motif fields become an enum when known. */
  motifs?: string[] | null;
}): ProducerAuthoringContract;
export type VideoVerticalMetadata = {
  schemaVersion: 1;
  assets: Record<string, {
    sourceSha256: string;
    objectPosition: string;
    text: "upper" | "lower";
    reviewedFrames: Array<"first" | "middle" | "last">;
  }>;
};
export declare function createVideoProducer(input: {contract: any; assetCatalog: any; mediaCatalog: any; verticalMetadata?: VideoVerticalMetadata | null; boards?: VideoBoardCatalog | null; motifs?: string[] | null}): {
  PRODUCER_CONTRACT_VERSION: number;
  compileProduction(input: ProducerCompileInput): ProducerCompiledProduction;
  finalizeProduction(input: {schemaVersion: 1; compiled: ProducerCompiledProduction; timings: ProducerFinalized["plan"]["lines"]; coverImage?: string; audioSrc?: string | null}): ProducerFinalized;
};
export declare const VIDEO_PRODUCER_CONTRACT_VERSION: 1;

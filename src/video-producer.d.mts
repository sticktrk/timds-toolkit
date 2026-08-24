export type ProducerOutputFormat = "horizontal" | "short";
export type ProducerBeatRole = "hook" | "rule" | "risk" | "process" | "exception" | "answer";
export type ProducerCompileInput = {
  schemaVersion: 1;
  slug: string;
  outputFormat: ProducerOutputFormat;
  exactQuestion: string;
  topic: {label: string; engagementQuestion?: string; coverEmotion?: string};
  answerBeats: Array<{id: string; role: ProducerBeatRole; narration: string; summary: string}>;
};
export type ProducerCompiledScene = {id: string; role: string; narration: string; eyebrow?: string; headline?: string; intro?: boolean; outro?: boolean};
export type ProducerCompiledProduction = {
  schemaVersion: 1;
  producerContractVersion: number;
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
  plan: {
    schemaVersion: 1;
    slug: string;
    outputFormat: ProducerOutputFormat;
    lines: Array<{id: string; durationMs: number; words: Array<{text: string; startMs: number; endMs: number}>}>;
    scenes: Array<{id: string; asset?: string; verticalAsset?: string; assets?: string[]; verticalAssets?: string[]; intro?: boolean; outro?: boolean; [key: string]: unknown}>;
    pads: Record<string, {lead?: number; tail?: number}>;
    audioSrc?: string | null;
    cover: {image?: string; eyebrow: string; headline: string};
  };
  coverSubject: ProducerMedia;
  footage: ProducerMedia[];
};
export type ProducerAuthoringContract = {
  schemaVersion: 1;
  producerContractVersion: number;
  designSystem: {id: string; name: string; version: string; commit: string; indexUrl?: string};
  outputFormat: ProducerOutputFormat;
  prompt: {instructions: string[]; blockIds: string[]; brief: string};
  constraints: {
    headlineWords: number;
    topicLabelWords: {minimum: number; maximum: number};
    exactQuestion: {maximumWords: number; maximumCharacters: number; mustEndWithQuestionMark: true};
    engagementQuestion: {required: boolean; requireYesNoQuestion: boolean; maximumWords: number};
    answerBeatRoles: ProducerBeatRole[];
    reservedSceneIds: string[];
  };
  compilerOwns: string[];
  inputSchema: Record<string, unknown>;
};
export declare function validateVideoProducerConfig(input: unknown, contract: any): any | null;
export declare function createVideoAuthoringContract(input: {
  contract: any;
  manifest: any;
  designSystemIndex: any;
  provenance: {version?: string; commit: string; indexUrl?: string};
  outputFormat: ProducerOutputFormat;
}): ProducerAuthoringContract;
export declare function createVideoProducer(input: {contract: any; assetCatalog: any; mediaCatalog: any}): {
  PRODUCER_CONTRACT_VERSION: number;
  compileProduction(input: ProducerCompileInput): ProducerCompiledProduction;
  finalizeProduction(input: {schemaVersion: 1; compiled: ProducerCompiledProduction; timings: ProducerFinalized["plan"]["lines"]; coverImage?: string; audioSrc?: string | null}): ProducerFinalized;
};
export declare const VIDEO_PRODUCER_CONTRACT_VERSION: 1;

import type { z } from "zod/v3";
import type { RuntimeIdentity } from "./runtime.mjs";
import type { ProducerAuthoringContract, ProducerCompiledProduction, ProducerFootageCatalog } from "./video-producer.mjs";

/** Compatibility reader for authoring responses from supported producer releases. */
export type VideoAuthoringResponse = Omit<ProducerAuthoringContract, "schemaVersion" | "runtime" | "constraints" | "boards"> & {
  schemaVersion: 1 | 2;
  runtime?: RuntimeIdentity;
  constraints: Omit<ProducerAuthoringContract["constraints"], "exactQuestion"> & {
    exactQuestion: {maximumWords: number | null; maximumCharacters: number | null; mustEndWithQuestionMark: true};
  };
  boards?: {
    active: boolean;
    kinds: Array<{
      id: string; label: string; use: string; avoid: string;
      overFootage: "never" | "optional" | "always"; compilerOwned: boolean;
      [field: string]: unknown;
    }>;
    [field: string]: unknown;
  };
  [field: string]: unknown;
};

/** Saved productions may predate runtime identity; current producers always emit it. */
export type VideoCompiledResponse = Omit<ProducerCompiledProduction, "runtime"> & {
  runtime?: RuntimeIdentity;
  [field: string]: unknown;
};

export declare const VideoRuntimeIdentitySchema: z.ZodType<RuntimeIdentity, z.ZodTypeDef, unknown>;
/** Normalizes the legacy singular prefix to assetPrefixes and preserves additional fields. */
export declare const VideoFootageCatalogSchema: z.ZodType<ProducerFootageCatalog, z.ZodTypeDef, unknown>;
/** Client-owned metadata can be composed with .and(); additional TimDS fields are preserved. */
export declare const VideoAuthoringContractSchema: z.ZodType<VideoAuthoringResponse, z.ZodTypeDef, unknown>;
export declare const VideoCompiledProductionSchema: z.ZodType<VideoCompiledResponse, z.ZodTypeDef, unknown>;

/** A Zod-independent result for consumers composing validation with their own library. */
export type VideoTransportResult<T> = {success: true; data: T} | {
  success: false;
  error: {issues: Array<{code: string; path: Array<string | number>; message: string}>};
};
export declare function safeParseVideoAuthoringContract(value: unknown): VideoTransportResult<VideoAuthoringResponse>;
export declare function safeParseVideoFootageCatalog(value: unknown): VideoTransportResult<ProducerFootageCatalog>;
export declare function safeParseVideoCompiledProduction(value: unknown): VideoTransportResult<VideoCompiledResponse>;

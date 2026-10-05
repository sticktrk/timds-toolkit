// Shared wire contracts for producer hosts and remote authoring clients.
// The v3-compatible API lets consumers compose these schemas with Zod 3 or
// zod/v3 without coupling transport validation to their renderer's release.
import { z } from "zod/v3";

export const VideoRuntimeIdentitySchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  releaseLine: z.string().min(1),
  videoSchema: z.number().int().positive(),
  componentApi: z.number().int().positive(),
  features: z.array(z.string().min(1)),
}).passthrough();

export const VideoFootageCatalogSchema = z.object({
  assetPrefixes: z.array(z.string().min(1)).min(1).optional(),
  assetPrefix: z.string().min(1).optional(),
  maximumPerBeat: z.number().int().positive(),
  clips: z.array(z.object({
    key: z.string().min(1),
    title: z.string().optional(),
    tags: z.array(z.string()),
    durationSeconds: z.number().positive(),
  }).passthrough()).min(1),
}).passthrough().superRefine((catalog, context) => {
  if (!catalog.assetPrefixes && !catalog.assetPrefix) {
    context.addIssue({code: z.ZodIssueCode.custom, path: ["assetPrefixes"], message: "Footage catalog must declare assetPrefixes or assetPrefix"});
  }
  if (catalog.assetPrefixes && catalog.assetPrefix
    && !(catalog.assetPrefixes.length === 1 && catalog.assetPrefixes[0] === catalog.assetPrefix)) {
    context.addIssue({code: z.ZodIssueCode.custom, path: ["assetPrefix"], message: "assetPrefix must be the sole entry in assetPrefixes"});
  }
}).transform((catalog) => ({
  ...catalog,
  assetPrefixes: catalog.assetPrefixes ?? (catalog.assetPrefix ? [catalog.assetPrefix] : []),
}));

export const VideoAuthoringContractSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  producerContractVersion: z.number().int().positive(),
  // Older authoring responses and saved compilations predate runtime identity.
  runtime: VideoRuntimeIdentitySchema.optional(),
  designSystem: z.object({
    id: z.string().min(1), name: z.string().min(1), version: z.string().min(1),
    commit: z.string().regex(/^[0-9a-f]{40}$/u), indexUrl: z.string().url().optional(),
  }).passthrough(),
  outputFormat: z.enum(["horizontal", "short"]),
  prompt: z.object({
    instructions: z.array(z.string().min(1)), blockIds: z.array(z.string().min(1)), brief: z.string(),
  }).passthrough(),
  constraints: z.object({
    headlineWords: z.number().int().positive(),
    topicLabelWords: z.object({minimum: z.number().int().positive(), maximum: z.number().int().positive()}).passthrough(),
    exactQuestion: z.object({
      maximumWords: z.number().int().positive().nullable(),
      maximumCharacters: z.number().int().positive().nullable(), mustEndWithQuestionMark: z.literal(true),
    }).passthrough(),
    engagementQuestion: z.object({
      required: z.boolean(), requireYesNoQuestion: z.boolean(), maximumWords: z.number().int().positive(),
    }).passthrough(),
    solution: z.object({offered: z.boolean(), required: z.boolean()}).passthrough().optional(),
    answerBeatRoles: z.array(z.enum(["hook", "rule", "risk", "process", "exception", "answer"])),
    reservedSceneIds: z.array(z.string().min(1)),
  }).passthrough(),
  footage: VideoFootageCatalogSchema.optional(),
  boards: z.object({
    active: z.boolean(),
    kinds: z.array(z.object({
      id: z.string().min(1), label: z.string(), use: z.string(), avoid: z.string(),
      overFootage: z.enum(["never", "optional", "always"]), compilerOwned: z.boolean(),
    }).passthrough()),
  }).passthrough().optional(),
  compilerOwns: z.array(z.string().min(1)),
  inputSchema: z.record(z.string(), z.unknown()),
}).passthrough();

export const VideoCompiledProductionSchema = z.object({
  schemaVersion: z.literal(1),
  producerContractVersion: z.number().int().positive(),
  runtime: VideoRuntimeIdentitySchema.optional(),
  slug: z.string().min(1), outputFormat: z.enum(["horizontal", "short"]), exactQuestion: z.string().min(1),
  topic: z.object({
    label: z.string().min(1), engagementQuestion: z.string().optional(), coverEmotion: z.string().optional(),
    solution: z.string().optional(),
  }).passthrough(),
  scenes: z.array(z.object({
    id: z.string().min(1), role: z.string().min(1), narration: z.string().min(1),
    eyebrow: z.string().optional(), headline: z.string().optional(),
    intro: z.boolean().optional(), outro: z.boolean().optional(),
    footage: z.array(z.string().min(1)).optional(),
    visual: z.object({kind: z.string().min(1)}).passthrough().optional(),
    chapter: z.string().optional(), boardGap: z.string().optional(),
  }).passthrough()).min(1),
  cover: z.object({eyebrow: z.string().min(1), headline: z.string().min(1)}).passthrough(),
}).passthrough();

// These functions expose plain result types so hosts using another Zod version
// can adapt issues without composing two recursive Zod type hierarchies.
export const safeParseVideoAuthoringContract = (value) => VideoAuthoringContractSchema.safeParse(value);
export const safeParseVideoFootageCatalog = (value) => VideoFootageCatalogSchema.safeParse(value);
export const safeParseVideoCompiledProduction = (value) => VideoCompiledProductionSchema.safeParse(value);

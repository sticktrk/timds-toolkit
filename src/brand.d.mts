import type { BrandAnnotation, BrandAsset, BrandKit, GuidanceBlock, GuidanceGroup, IndexBlock, IndexPage, MediaRecord, TokensDocument } from "./derived.d.mts";

export type { BrandAnnotation, BrandAsset, BrandKit, GuidanceBlock, GuidanceGroup, MediaRecord };

export const BRAND_KIT_SCHEMA_VERSION: 1;
/** Group name → predicate over extracted pages that fills it when the manifest does not. */
export const GUIDANCE_CONVENTIONS: Readonly<Record<string, (page: IndexPage) => boolean>>;

export function parseAnnotation(node: unknown): BrandAnnotation | null;
export function annotationFor(node: unknown, parents: Map<unknown, unknown>): BrandAnnotation | null;
export function normalizeBrandGuidance(input: unknown): Record<string, string[]>;
export function resolveGuidance(pages: IndexPage[], mapping?: Record<string, string[]>, renderBlock?: (block: IndexBlock) => string | undefined): { guidance: Record<string, GuidanceGroup>; errors: string[]; warnings: string[] };
export function buildBrandKit(input: { manifest: { systemId: string; name: string; version: string; brand?: { guidance?: Record<string, string[]> } }; tokens: Pick<TokensDocument, "roles" | "missingRoles"> | Record<string, never>; pages: IndexPage[]; renderBlock?: (block: IndexBlock) => string | undefined }): { kit: BrandKit; warnings: string[] };
export function eachBrandKitMedia(kit: BrandKit, visit: (media: MediaRecord) => void): void;

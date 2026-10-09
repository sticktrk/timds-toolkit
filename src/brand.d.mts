import type { BrandAnnotation, BrandAsset, BrandFontRole, BrandKit, BrandRole, FontFile, GuidanceBlock, GuidanceGroup, IndexBlock, IndexPage, MediaRecord, TokensDocument } from "./derived.d.mts";
import type { FontFace } from "./tokens.d.mts";

export type { BrandAnnotation, BrandAsset, BrandFontRole, BrandKit, FontFile, GuidanceBlock, GuidanceGroup, MediaRecord };

/** What the stylesheet harvest found about fonts: the faces declared and the external stylesheets the pages link. */
export type FontSources = { faces?: FontFace[]; stylesheets?: string[] };

export const BRAND_KIT_SCHEMA_VERSION: 1;
/** Group name → predicate over extracted pages that fills it when the manifest does not. */
export const GUIDANCE_CONVENTIONS: Readonly<Record<string, (page: IndexPage) => boolean>>;

export function parseAnnotation(node: unknown): BrandAnnotation | null;
export function annotationFor(node: unknown, parents: Map<unknown, unknown>): BrandAnnotation | null;
export function normalizeBrandGuidance(input: unknown): Record<string, string[]>;
export function resolveGuidance(pages: IndexPage[], mapping?: Record<string, string[]>, renderBlock?: (block: IndexBlock) => string | undefined): { guidance: Record<string, GuidanceGroup>; errors: string[]; warnings: string[] };
/** The file format a media URL implies (`svg`, `png`, …), or null. */
export function mediaFormat(url: string | null | undefined): string | null;
/** Where each font role's family comes from, and the roles with no source at all. */
export function resolveFontSources(roles: Record<string, BrandRole>, fonts?: FontSources): { resolved: Record<string, Omit<BrandFontRole, keyof BrandRole>>; unsourced: Array<{ role: string; family: string }> };
export function buildBrandKit(input: { manifest: { systemId: string; name: string; version: string; brand?: { guidance?: Record<string, string[]> } }; tokens: Pick<TokensDocument, "roles" | "missingRoles"> | Record<string, never>; pages: IndexPage[]; renderBlock?: (block: IndexBlock) => string | undefined; fonts?: FontSources }): { kit: BrandKit; warnings: string[] };
export function eachBrandKitMedia(kit: BrandKit, visit: (media: MediaRecord) => void): void;

import type { AssetFormat, AssetFormatGroup, FormatsDocument, IndexPage } from "./derived.d.mts";

export type { AssetFormat, AssetFormatGroup, FormatsDocument };

export const FORMATS_SCHEMA_VERSION: 1;
/** Where a Design System keeps its catalog, relative to the Design System root. */
export const FORMATS_SOURCE_FILE: "src/formats.json";

/** Validate a catalog object (the `src/formats.json` shape) into ordered groups; throws naming the offending field. */
export function normalizeFormatCatalog(input: unknown, options?: { where?: string }): AssetFormatGroup[];
/** The validated catalog of a Design System, or null when it keeps none. */
export function readFormatCatalog(designSystemRoot: string): Promise<AssetFormatGroup[] | null>;
/** The `formats.json` document, each format linked to its page's mirror when the extracted pages include it. */
export function formatsDocument(groups: AssetFormatGroup[], manifest: { systemId: string; name: string; version: string }, options?: { pages?: Pick<IndexPage, "id" | "url" | "markdownUrl">[]; plannedPages?: string[]; basePrefix?: string }): { document: FormatsDocument; warnings: string[] };
/** `3.5 × 2 in`, the way a person says a size. */
export function describeFormatSize(format: Pick<AssetFormat, "width" | "height" | "unit">): string;

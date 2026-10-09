/** Website designs: whole pages authored in HTML with JavaScript on the system's stylesheets, the reference a product port must match. */
import type { Design, DesignPage, DesignPageState, DesignsDocument, SystemStamp } from "./derived.mjs";

export type { Design, DesignPage, DesignPageState, DesignsDocument };

export const DESIGNS_SOURCE_DIRECTORY: "src/designs";
export const DESIGNS_OUTPUT_DIRECTORY: "designs";
export const DESIGNS_SCHEMA_VERSION: 1;
export const DEFAULT_STATE: "default";

export type CatalogState = { name: string; path: string; source: string };
export type CatalogPage = { route: string; title: string | null; states: CatalogState[] };
export type CatalogDesign = { id: string; directory: string; title: string; summary: string; layout: string | null; pages: CatalogPage[] };
export type DesignCatalog = { exists: boolean; source: string; designs: CatalogDesign[] };

export type RenderedState = DesignPageState & { output: string; source: string };
export type RenderedPage = { route: string; title: string; url: string; output: string; states: RenderedState[] };
export type RenderedDesign = { id: string; title: string; summary: string; url: string; pages: RenderedPage[] };
export type RenderedDesigns = {
  basePrefix: string;
  catalog: DesignCatalog;
  designs: RenderedDesign[];
  /** Artifact-relative output path → HTML or CSS, including the /designs/ directory and its stylesheet. */
  files: Map<string, string>;
  outputDirectory: string;
  pageCount: number;
  stateCount: number;
  url: string;
};

export type ManifestLike = { name?: string; description?: string; version?: string; systemId?: string; artifact?: { entry?: string } };

export function readDesignCatalog(designSystemRoot: string): Promise<DesignCatalog>;
export function renderDesigns(options: { designSystemRoot: string; manifest?: ManifestLike | null }): Promise<RenderedDesigns | null>;
export function buildDesigns(designSystemRoot: string, options?: { manifest?: ManifestLike | null }): Promise<{ designs: RenderedDesign[]; pageCount: number; stateCount: number; written: string[] }>;
export function checkDesigns(options: { designSystemRoot: string; manifest?: ManifestLike | null; artifactRoot?: string }): Promise<{ enabled: boolean; designCount: number; pageCount: number; stateCount: number }>;
export function rewriteDesignRoutes(html: string, routes: string[], basePrefix: string, designId: string): string;
export function declaredClasses(css: string): Set<string>;
export function designsDocument(rendered: RenderedDesigns, manifest: { systemId: string; name: string; version: string }): DesignsDocument;
export function designsDirectory(document: DesignsDocument | null | undefined): Array<{ id: string; title: string; summary?: string; url: string; pageCount: number; pages: Array<{ route: string; title: string; url: string; states: string[] }> }>;
export function findDesignPage(document: DesignsDocument | null | undefined, designId: string, route: string, state?: string): { design: Design | null; page: DesignPage | null; state: DesignPageState | null };
export function eachDesignReference(document: DesignsDocument | null | undefined, visit: (reference: string) => void): void;

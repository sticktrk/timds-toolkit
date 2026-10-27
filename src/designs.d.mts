/** Website designs: whole pages authored in HTML with JavaScript on the system's stylesheets, the reference a product port must match. */
import type { Design, DesignJourney, DesignJourneyScreen, DesignJourneyStep, DesignPage, DesignPageState, DesignsDocument, SystemStamp } from "./derived.mjs";

export type { Design, DesignJourney, DesignJourneyScreen, DesignJourneyStep, DesignPage, DesignPageState, DesignsDocument };

export const DESIGNS_SOURCE_DIRECTORY: "src/designs";
export const DESIGNS_OUTPUT_DIRECTORY: "designs";
export const DESIGNS_SCHEMA_VERSION: 1;
export const DEFAULT_STATE: "default";
/** The directory under a design's output reserved for journey storyboards. */
export const JOURNEYS_OUTPUT_DIRECTORY: "journeys";

export type CatalogState = { name: string; path: string; source: string };
export type CatalogPage = { route: string; title: string | null; states: CatalogState[] };
/** A journey screen as design.json declares it, with the route normalized and the state resolved (`default` when omitted). */
export type CatalogScreen = { page: string; state: string; label: string | null; note: string | null };
export type CatalogStep = { title: string; summary: string; screens: CatalogScreen[]; branches: CatalogScreen[] };
export type CatalogJourney = { id: string; title: string; summary: string; steps: CatalogStep[] };
export type CatalogDesign = { id: string; directory: string; title: string; summary: string; layout: string | null; pages: CatalogPage[]; journeys: CatalogJourney[] };
export type DesignCatalog = { exists: boolean; source: string; designs: CatalogDesign[] };

export type RenderedState = DesignPageState & { output: string; source: string };
export type RenderedPage = { route: string; title: string; url: string; output: string; states: RenderedState[] };
export type RenderedScreen = DesignJourneyScreen & { title: string };
export type RenderedStep = { title: string; summary: string; screens: RenderedScreen[]; branches: RenderedScreen[] };
export type RenderedJourney = Omit<DesignJourney, "steps"> & { output: string; steps: RenderedStep[] };
export type RenderedDesign = { id: string; title: string; summary: string; url: string; pages: RenderedPage[]; journeys: RenderedJourney[] };
export type RenderedDesigns = {
  basePrefix: string;
  catalog: DesignCatalog;
  designs: RenderedDesign[];
  /** Artifact-relative output path → HTML or CSS, including the /designs/ directory, the journey storyboards, and the stylesheet. */
  files: Map<string, string>;
  journeyCount: number;
  outputDirectory: string;
  pageCount: number;
  stateCount: number;
  url: string;
};

export type ManifestLike = { name?: string; description?: string; version?: string; systemId?: string; artifact?: { entry?: string } };

export function readDesignCatalog(designSystemRoot: string): Promise<DesignCatalog>;
/** The manifest fields the renderers need: `manifest` when given, otherwise timds.json at the root. */
export function readManifestLike(designSystemRoot: string, manifest?: ManifestLike | null): Promise<ManifestLike>;
export function renderDesigns(options: { designSystemRoot: string; manifest?: ManifestLike | null }): Promise<RenderedDesigns | null>;
export function buildDesigns(designSystemRoot: string, options?: { manifest?: ManifestLike | null }): Promise<{ designs: RenderedDesign[]; journeyCount: number; pageCount: number; stateCount: number; written: string[] }>;
/** The check's result; `warnings` are the journey nudges (pages a visitor moves through that no journey shows), never failures. */
export function checkDesigns(options: { designSystemRoot: string; manifest?: ManifestLike | null; artifactRoot?: string }): Promise<{ enabled: boolean; designCount: number; pageCount: number; stateCount: number; journeyCount: number; warnings: string[] }>;
export function journeyWarnings(designs: RenderedDesign[]): string[];
export function rewriteDesignRoutes(html: string, routes: string[], basePrefix: string, designId: string): string;
export function declaredClasses(css: string): Set<string>;
export function designsDocument(rendered: RenderedDesigns, manifest: { systemId: string; name: string; version: string }): DesignsDocument;
export type DesignListingScreen = { route: string; state: string; label: string; note?: string; url: string };
export type DesignListingJourney = {
  id: string;
  title: string;
  summary?: string;
  url: string;
  stepCount: number;
  screenCount: number;
  /** The steps in visitor order; a step's `branches` are the screens met instead. */
  steps: Array<{ title: string; summary?: string; screens: DesignListingScreen[]; branches?: DesignListingScreen[] }>;
};
export type DesignListing = {
  id: string;
  title: string;
  summary?: string;
  url: string;
  pageCount: number;
  pages: Array<{ route: string; title: string; url: string; states: string[] }>;
  /** Empty for a document written before journeys. */
  journeys: DesignListingJourney[];
};
export function designsDirectory(document: DesignsDocument | null | undefined): DesignListing[];
export function findDesignPage(document: DesignsDocument | null | undefined, designId: string, route: string, state?: string): { design: Design | null; page: DesignPage | null; state: DesignPageState | null };
export function eachDesignReference(document: DesignsDocument | null | undefined, visit: (reference: string) => void): void;

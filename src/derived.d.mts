/** The derived layer: generated, contract-shaped documents a consumer reads without TimDS internals. */
import type {RuntimeIdentity, RuntimeRequirements} from "./runtime.mjs";
import type {VideoBoardCatalogSummary} from "./video-producer.mjs";

export type SystemStamp = { id: string; name: string; version: string };

/* ── tokens.json ─────────────────────────────────────────────────────────── */

export type TokenKind = "color" | "font-family" | "length" | "gradient" | "duration" | "easing" | "number" | "other";

export type TokenRecord = {
  /** The custom property name, e.g. `--gold-300`. */
  name: string;
  /** The declared value, `var()` chains intact. */
  value: string;
  /** The value with `var()` resolved in the record's scope, then `:root`. */
  resolved: string;
  kind: TokenKind;
  /** The selector the declaration sits under, e.g. `:root` or `[data-theme=dark]`. */
  selector: string;
  /** Conditional at-rules above the declaration, e.g. `@media (prefers-color-scheme: dark)`. */
  condition: string[];
  /** True for an unconditional `:root`/`html` declaration: the document scope every role is filled from. */
  base: boolean;
  /** Artifact-relative stylesheet path, or `/<page>#style-N` for an inline block. */
  source: string;
  /** Custom properties this value referenced. */
  references: string[];
  /** Referenced properties nothing declares. */
  unresolved?: string[];
};

export type BrandRoleName =
  | "color.background" | "color.panel" | "color.accent" | "color.text" | "color.muted"
  | "font.display" | "font.body" | "font.ui"
  | `color.${string}` | `font.${string}`;

export type BrandRole = {
  token: string;
  value: string;
  kind: TokenKind;
  /** `manifest` when `timds.json brand.roles` named the token, else `convention`. */
  source: "manifest" | "convention";
};

/** One `@font-face` source file for a font role's family. */
export type FontFile = MediaRecord & {
  /** `woff2`, `woff`, `truetype`, `opentype`, … from the `format()` hint or the file extension. */
  format?: string;
  /** The `font-weight` descriptor, e.g. `400` or `300 700`. */
  weight: string;
  /** The `font-style` descriptor, e.g. `normal` or `italic`. */
  style: string;
};

/** A font role in the brand kit: the role plus where a consumer obtains the family. */
export type BrandFontRole = BrandRole & {
  /** The first family of the stack, unquoted; absent when the stack opens with a generic family. */
  family?: string;
  /** The `@font-face` files the loaded stylesheets declare for the family, artifact-local or absolute. */
  files?: FontFile[];
  /** External stylesheets the pages link that serve the family (a font service). */
  stylesheets?: string[];
  /** The page to download the family by hand, when a known service serves it. */
  specimen?: string;
  /** True for a family every device ships with (Georgia, Arial, the OS UI stacks): nothing to obtain. */
  system?: true;
};

export type TokensDocument = {
  schemaVersion: 1;
  system: SystemStamp;
  count: number;
  kinds: Partial<Record<TokenKind, number>>;
  roles: Partial<Record<BrandRoleName, BrandRole>>;
  missingRoles?: BrandRoleName[];
  stylesheets: Array<{ path: string; bytes: number; sha256: string; inline?: true }>;
  scopes: Array<{ selector: string; condition: string[]; base: boolean; count: number }>;
  tokens: TokenRecord[];
};

/* ── brand.json ──────────────────────────────────────────────────────────── */

export type MediaRecord = {
  url: string;
  key?: string;
  contentType?: string;
  bytes?: number;
  sha256?: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
  frameRate?: number;
  codec?: string;
};

export type BrandAnnotation = {
  /** `logo`, or any imagery role such as `photo`, `illustration`, `graphic`, `icon`, `pattern`. */
  role: string;
  primary?: true;
  variant?: string;
  lockup?: string;
  /** The background the variant is meant for, e.g. `light` or `dark`. */
  on?: string;
  tags?: string[];
};

export type BrandAsset = BrandAnnotation & {
  /** The extracted asset id, e.g. `brand/logo#plg/plg-white-logo-on-dark`. */
  id: string;
  name: string;
  notes?: string[];
  /** The file format the media URL implies (`svg`, `png`, `webp`, …), when the extension says. */
  format?: string;
  media: MediaRecord;
  page: string;
  block: string;
  /** Every asset id that presents this media under this role. */
  citations: string[];
};

export type GuidanceBlock = { id: string; page: string; title: string; markdown?: string };

export type GuidanceGroup = { source: "manifest" | "convention"; blocks: GuidanceBlock[] };

export type BrandKit = {
  schemaVersion: 1;
  system: SystemStamp;
  /** Font roles carry their family and sources; see `BrandFontRole`. */
  roles: Partial<Record<BrandRoleName, BrandRole | BrandFontRole>>;
  missingRoles?: BrandRoleName[];
  logos: BrandAsset[];
  imagery: BrandAsset[];
  /** `voice` and `compliance` by convention; any name from `timds.json brand.guidance`. */
  guidance: Record<string, GuidanceGroup>;
};

/* ── index.json (the parts the derived layer promises) ───────────────────── */

export type IndexBlock = {
  id: string;
  title: string;
  intro?: string;
  specs?: Array<{ columns: string[]; rows: Array<{ id: string; fields: Record<string, string> }> }>;
  notes?: Array<{ id: string; text: string }>;
  code?: Array<{ id: string; text: string }>;
  assets?: Array<{ id: string; name: string; lines?: string[]; media: MediaRecord; brand?: BrandAnnotation }>;
  prose?: Array<{ id: string; text: string }>;
};

export type IndexPage = { id: string; url: string; view: string; eyebrow: string; title: string; lede: string; blocks: IndexBlock[] };

export type IndexDocument = {
  schemaVersion: 1;
  system: SystemStamp;
  pageCount: number;
  tokens: { url: string; count: number; stylesheets: number; roles: number };
  brand: { url: string; logos: number; imagery: number; guidance: number };
  /** Present when the system keeps an asset format catalog: where formats.json sits and how much it holds. */
  formats?: { url: string; groups: number; count: number };
  /** Present when the system holds website designs: where designs.json sits and how much it holds. */
  designs?: { url: string; count: number; pages: number; states: number };
  /** Present when the manifest declares a consumer bundle: where bundle.json sits and how much it holds. */
  bundle?: { url: string; files: number; bytes: number };
  video?: {runtime?: RuntimeRequirements | null; engine?: RuntimeIdentity; boards?: VideoBoardCatalogSummary};
  pages: IndexPage[];
};

/* ── formats.json ────────────────────────────────────────────────────────── */

export type AssetFormat = {
  id: string;
  name: string;
  width: number;
  height: number;
  /** `in` for print sheets, `px` for screen canvases. */
  unit: "in" | "px";
  bleed?: number;
  safe: number;
  /** Platform chrome that covers the edges, per side. */
  ui?: Partial<Record<"top" | "bottom" | "left" | "right", number>>;
  /** The region to keep clear, per side. */
  keepClear?: Partial<Record<"top" | "bottom" | "left" | "right", number>>;
  maxKB?: number;
  stock?: string;
  file?: string;
  note?: string;
  /** The page id that shows the format. */
  page: string;
  /** The page's Markdown mirror URL, when the built artifact has the page. */
  pageUrl?: string;
};

export type AssetFormatGroup = { id: string; unit: "in" | "px"; formats: AssetFormat[] };

export type FormatsDocument = {
  schemaVersion: 1;
  system: SystemStamp;
  url: string;
  groupCount: number;
  count: number;
  groups: AssetFormatGroup[];
};

/* ── designs.json ────────────────────────────────────────────────────────── */

export type DesignPageState = {
  /** `default`, or the state's name from the file (`contact.sent.html` → `sent`). */
  name: string;
  title: string;
  /** Artifact-relative URL of the built page. */
  url: string;
  /** The page as built: the designer's HTML on the system's stylesheets. */
  html: string;
  /** Site-absolute stylesheets and media the page loads, resolvable under `base`. */
  references: string[];
};

export type DesignPage = { route: string; title: string; url: string; states: DesignPageState[] };

export type Design = { id: string; title: string; summary: string; url: string; pages: DesignPage[] };

export type DesignsDocument = {
  schemaVersion: 1;
  system: SystemStamp;
  /** The published prefix site-absolute references resolve against; null locally. */
  base: string | null;
  url: string;
  designCount: number;
  pageCount: number;
  stateCount: number;
  designs: Design[];
};

/* ── bundle.json ─────────────────────────────────────────────────────────── */

export type BundleFile = {
  /** The file's path relative to the Design System root, e.g. `src/styles/ds/brand.css`. */
  path: string;
  /** Where the file is served: under `directory`, site-absolute locally and absolute once published. */
  url: string;
  bytes: number;
  sha256: string;
};

export type BundleDocument = {
  schemaVersion: 1;
  system: SystemStamp;
  url: string;
  /** The directory the files sit under; a website resolves `path` beneath it. */
  directory: string;
  /** The published prefix; null locally. */
  base: string | null;
  /** The immutable copy of this version's bundle; null locally. A website pins this. */
  versioned: string | null;
  fileCount: number;
  bytes: number;
  files: BundleFile[];
};

/* ── the layer ───────────────────────────────────────────────────────────── */

export type Provenance = {
  schemaVersion: 1;
  sourceCommit: string;
  version: string;
  systemId?: string;
  entry?: string;
  files?: Partial<Record<DerivedFileName, string>>;
};

export type DerivedLayer = {
  source: { kind: "local"; root: string; artifactRoot: string } | { kind: "published"; base: string };
  system: { id: string | null; name: string | null; version: string | null };
  /** False when nothing has been derived or published yet. */
  derived: boolean;
  /** Local only: the layer was derived for a version other than the manifest's. */
  stale: boolean;
  provenance: Provenance | null;
  index: IndexDocument | null;
  tokens: TokensDocument | null;
  brand: BrandKit | null;
  llms: string | null;
  /** Null for a system without an asset format catalog. */
  formats: FormatsDocument | null;
  /** Null for a system that designs no pages. */
  designs: DesignsDocument | null;
  /** Null for a system whose manifest declares no `bundle`. */
  bundle: BundleDocument | null;
};

export type DerivedFileName = "index" | "tokens" | "brand" | "llms" | "llmsFull" | "formats" | "designs" | "bundle";

export type BrandKitSummary = {
  version: string | null;
  roles: { filled: number; missing: BrandRoleName[]; total: number };
  logos: number;
  primaryLogo: string | null;
  imagery: number;
  guidance: string[];
};

export const DERIVED_LAYER_FILES: Readonly<Record<DerivedFileName, string>>;
export const PROVENANCE_FILE: ".timds-artifact.json";
export function derivedLayerPaths(entry?: string): Record<DerivedFileName, string>;
export function derivedFilePath(designSystemRoot: string, manifest: { artifact?: { entry?: string } }, name: DerivedFileName): string;
export function readDerivedLayer(designSystemRoot: string, manifest: { systemId?: string; name?: string; version?: string; artifact?: { entry?: string } }): Promise<DerivedLayer>;
export function fetchDerivedLayer(publicBase: string, options?: { fetchImpl?: typeof fetch }): Promise<DerivedLayer>;
export function summarizeBrandKit(kit: BrandKit | null | undefined): BrandKitSummary | null;
export function describeBrandKit(summary: BrandKitSummary | null): string;

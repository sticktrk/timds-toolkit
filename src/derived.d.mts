/** The derived layer: generated, contract-shaped documents a consumer reads without TimDS internals. */

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
  roles: Partial<Record<BrandRoleName, BrandRole>>;
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
  pages: IndexPage[];
};

/* ── the layer ───────────────────────────────────────────────────────────── */

export type Provenance = {
  schemaVersion: 1;
  sourceCommit: string;
  version: string;
  systemId?: string;
  entry?: string;
  files?: Record<"index" | "tokens" | "brand" | "llms", string>;
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
};

export type BrandKitSummary = {
  version: string | null;
  roles: { filled: number; missing: BrandRoleName[]; total: number };
  logos: number;
  primaryLogo: string | null;
  imagery: number;
  guidance: string[];
};

export const DERIVED_LAYER_FILES: Readonly<Record<"index" | "tokens" | "brand" | "llms", string>>;
export const PROVENANCE_FILE: ".timds-artifact.json";
export function derivedLayerPaths(entry?: string): Record<"index" | "tokens" | "brand" | "llms", string>;
export function derivedFilePath(designSystemRoot: string, manifest: { artifact?: { entry?: string } }, name: "index" | "tokens" | "brand" | "llms"): string;
export function readDerivedLayer(designSystemRoot: string, manifest: { systemId?: string; name?: string; version?: string; artifact?: { entry?: string } }): Promise<DerivedLayer>;
export function fetchDerivedLayer(publicBase: string, options?: { fetchImpl?: typeof fetch }): Promise<DerivedLayer>;
export function summarizeBrandKit(kit: BrandKit | null | undefined): BrandKitSummary | null;
export function describeBrandKit(summary: BrandKitSummary | null): string;

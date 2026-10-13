/** The Design System changelog: CHANGELOG.md rendered into the artifact and the derived layer. */
import type { ChangelogDocument, ChangelogEntry, ChangelogRelease } from "./derived.mjs";

export type { ChangelogDocument, ChangelogEntry, ChangelogRelease };

export const CHANGELOG_FILE: "CHANGELOG.md";
export const CHANGELOG_OUTPUT_DIRECTORY: "changelog";
export const CHANGELOG_SCHEMA_VERSION: 1;
export const UNRELEASED_HEADING: "Unreleased";
/** A dated Design System version: YYYY.MM.DD-N, the UTC release date and the release number that day. */
export const DATED_VERSION: RegExp;
/** The scheme systems released before dated versions: MAJOR.MINOR.PATCH. */
export const LEGACY_VERSION: RegExp;

export type ParsedVersion =
  | { kind: "dated"; version: string; date: string; build: number }
  | { kind: "legacy"; version: string; parts: [number, number, number] };

export function parseDesignSystemVersion(version: unknown): ParsedVersion | null;
export function isDesignSystemVersion(version: unknown): boolean;
/** Negative when left precedes right. Every dated version follows every legacy one. Throws on an invalid version. */
export function compareDesignSystemVersions(left: string, right: string): number;
export function versionDate(now?: Date): string;
export function nextDesignSystemVersion(current: string, now?: Date): string;
export function formatReleaseDate(date: string): string;

export type ParsedEntry = { area: string | null; text: string; markdown: string; items: string[] };
export type ParsedRelease = { version: string; date: string | null; build: number | null; entries: ParsedEntry[] };
export type ParsedChangelog = { title: string | null; intro: string[]; unreleased: ParsedEntry[]; releases: ParsedRelease[]; problems: string[] };

export function inlineHtml(markdown: string): string;
export function plainText(markdown: string): string;
export function parseChangelog(markdown: string): ParsedChangelog;

export type ManifestLike = { systemId?: string; name?: string; description?: string; version?: string; artifact?: { entry?: string } };

export function changelogDocument(parsed: ParsedChangelog, manifest: ManifestLike, options?: { basePrefix?: string }): ChangelogDocument;

export type RenderedChangelog = {
  basePrefix: string;
  document: ChangelogDocument;
  /** Artifact-relative output path → HTML or CSS: the page and its stylesheet. */
  files: Map<string, string>;
  outputDirectory: string;
  parsed: ParsedChangelog;
  releaseCount: number;
  entryCount: number;
  unreleasedCount: number;
  problems: string[];
  url: string;
};

export function renderChangelog(options: { designSystemRoot: string; manifest?: ManifestLike | null }): Promise<RenderedChangelog | null>;
/** `rendered` is the in-memory render the files came from, null for a system without CHANGELOG.md. */
export function buildChangelog(designSystemRoot: string, options?: { manifest?: ManifestLike | null }): Promise<{ releaseCount: number; entryCount: number; unreleasedCount: number; problems: string[]; written: string[]; rendered: RenderedChangelog | null }>;
/** The notes under `## Unreleased`, or null when the system keeps no CHANGELOG.md. */
export function readUnreleasedNotes(designSystemRoot: string): Promise<ParsedEntry[] | null>;

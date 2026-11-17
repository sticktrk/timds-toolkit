import type { BundleDocument, BundleFile } from "./derived.d.mts";

export type { BundleDocument, BundleFile };

export const BUNDLE_SCHEMA_VERSION: 1;
export const BUNDLE_OUTPUT_DIRECTORY: "bundle";
export const BUNDLE_MANIFEST_FILE: "bundle.json";
export const BUNDLE_VERSION_PREFIX: "v";

/** `timds.json bundle`, validated: include and exclude globs relative to the Design System root. */
export type BundleConfig = { include: string[]; exclude: string[] };

export function normalizeBundleConfig(input: unknown): BundleConfig | null;
export function globToRegExp(pattern: string): RegExp;
export function matchesPattern(filePath: string, pattern: string): boolean;
export function collectBundleFiles(designSystemRoot: string, config: BundleConfig, options?: { outputDirectory?: string | null }): Promise<{ files: Array<{ path: string; absolutePath: string; bytes: number; sha256: string }>; skipped: string[]; empty: string[] }>;
export function bundleOutputDirectory(entry?: string): string;
export function bundleDocument(files: Array<{ path: string; bytes: number; sha256: string }>, manifest: { systemId: string; name: string; version?: string }, options?: { basePrefix?: string }): BundleDocument;
export function buildBundle(designSystemRoot: string, options: { manifest: { systemId: string; name: string; version?: string; artifact?: { entry?: string }; bundle?: BundleConfig | null } }): Promise<{ enabled: boolean; document: BundleDocument | null; outputDirectory: string; skipped: string[]; empty: string[]; written: string[] }>;
/** Without a version the document's `versioned` is null, and asking for the versioned copy throws. */
export function rewriteBundleForPublish(document: BundleDocument, options: { publicBase: string; entryDirectory: string; version?: string | null; versioned?: boolean }): BundleDocument;
/** `versioned` is null without a version: an unversioned system publishes only the current copy. */
export function bundlePublishPaths(filePath: string, options: { entryDirectory: string; version?: string | null }): { current: string; versioned: string | null };
export function bundleManifestPublishPaths(options: { entryDirectory: string; version?: string | null }): { current: string; versioned: string | null };
export function describeBundle(document: BundleDocument | null | undefined): string;

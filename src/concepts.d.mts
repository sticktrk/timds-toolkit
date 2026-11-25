import type { ManifestLike } from "./designs.mjs";
import type { SystemStamp } from "./derived.mjs";

export const CONCEPT_KINDS: readonly ["website", "logo", "card", "social", "photo", "merch", "pattern", "other"];
export const CONCEPT_STATUSES: readonly ["proposed", "approved", "archived"];
export const CONCEPT_USAGE: string;
export type ConceptKind = typeof CONCEPT_KINDS[number];
export type ConceptStatus = typeof CONCEPT_STATUSES[number];
export type ConceptPiece = {
  kind: ConceptKind; file: string; alt?: string; caption?: string;
  ground?: string; side?: string; label?: string; height?: number;
};
export type ConceptFont = { family: string; weight: number };
export type Concept = {
  schemaVersion: 1; title: string; summary: string; status: ConceptStatus; decided?: string;
  colors?: { roles?: Record<string, string>; palette?: Array<{ name: string; hex: string }> };
  fonts?: { display: ConceptFont; body: ConceptFont; label?: ConceptFont };
  voice?: string[]; pieces: ConceptPiece[];
};
export type CatalogConcept = Concept & { id: string };
export type DerivedConceptPiece = ConceptPiece & { url: string; bytes: number; sha256: string; html?: string };
export type DerivedConcept = Omit<CatalogConcept, "pieces"> & { url: string; markdownUrl: string; pieces: DerivedConceptPiece[] };
export type ConceptsDocument = {
  schemaVersion: 1; system: SystemStamp; base: string | null; url: string;
  usage: string; count: number; approved: string | null; concepts: DerivedConcept[];
};
export type ConceptSection = { document: ConceptsDocument | null; warnings: string[] };

export function normalizeConcept(raw: unknown, options: {id: string; warnings?: string[]}): CatalogConcept;
export function normalizeConcept(raw: unknown, options?: {warnings?: string[]}): Concept;
export function readConcept(directory: string, options?: { id?: string }): Promise<{concept: CatalogConcept; warnings: string[]; files: Map<string, Buffer>}>;
export function readConceptCatalog(root: string): Promise<{ exists: boolean; concepts: CatalogConcept[]; warnings: string[]; files: Map<string, Map<string, Buffer>> }>;
export function conceptCard(concept: CatalogConcept, basePrefix?: string): string;
export function buildConcepts(root: string, options?: { manifest?: ManifestLike | null }): Promise<ConceptSection>;
export function readConceptsDocument(root: string, manifest?: ManifestLike | null): Promise<ConceptSection>;

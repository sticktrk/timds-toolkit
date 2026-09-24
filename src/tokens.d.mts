import type { BrandRole, BrandRoleName, TokenKind, TokenRecord, TokensDocument } from "./derived.d.mts";

export type { BrandRole, BrandRoleName, TokenKind, TokenRecord, TokensDocument };

export const TOKENS_SCHEMA_VERSION: 1;
/** Role → conventional token names, tried in order against the document scope. */
export const BRAND_ROLES: Readonly<Record<string, readonly string[]>>;

export type ParsedToken = Pick<TokenRecord, "name" | "value" | "selector" | "condition" | "base" | "source">;

export function stylesheetReferences(html: string): { links: string[]; inline: string[] };
export function importReferences(css: string): string[];
export function parseCssTokens(css: string, options?: { source?: string }): ParsedToken[];
export function substituteVars(value: string, lookup: (name: string) => string | undefined): string;
export function resolveTokens(records: ParsedToken[]): TokenRecord[];
export function classifyToken(value: string): TokenKind;
export function normalizeBrandRoles(input: unknown): Record<string, string>;
export function roleKind(role: string): "color" | "font-family" | undefined;
export function resolveBrandRoles(tokens: TokenRecord[], mapping?: Record<string, string>): { roles: Record<string, BrandRole>; errors: string[]; missing: string[] };
export function buildTokensDocument(input: { manifest: { systemId: string; name: string; version: string; brand?: { roles?: Record<string, string> } }; stylesheets: TokensDocument["stylesheets"]; records: ParsedToken[]; roles?: Record<string, string> }): TokensDocument;
export function derivedTokensPath(designSystemRoot: string, manifest: { artifact?: { entry?: string } }): string;
export function readDerivedTokens(designSystemRoot: string, manifest: { artifact?: { entry?: string } }): Promise<TokensDocument | null>;

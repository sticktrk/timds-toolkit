/** Public ancestry omits the structural baseline and host authority. */
export type SystemLineage = {
  systemId: string;
  sourceId: string;
  version: string;
  commit: string;
  mode: "full" | "structure";
};

/** Passive source catalogs may carry fields understood by a custom renderer. */
export type ParentSiteCatalog = {
  views: Array<{
    id: string;
    label?: string;
    pages: Array<{
      slug?: string;
      title?: string;
      planned?: boolean;
      [field: string]: unknown;
    }>;
    [field: string]: unknown;
  }>;
  [field: string]: unknown;
};

/** Validated repository ancestry, including the private structural feed baseline. */
export type ParentRecord = SystemLineage & {
  schemaVersion: 1;
  baseline: {
    site: ParentSiteCatalog;
    formats: Record<string, unknown> | null;
  };
};

export type StockRecord = { schemaVersion: 1; paths: string[] };

export const PARENT_RECORD_FILE: ".timds/parent.json";
export const STOCK_RECORD_FILE: ".timds/stock.json";
/** Portable case aliases classify the same repository record. */
export function isLineagePath(value: unknown): boolean;
export function isDesignerRecordPath(value: unknown): boolean;
export function isPlumbingPath(value: unknown): boolean;
export function regularPath(root: string, relative: string, options?: { optional?: false }): Promise<string>;
export function regularPath(root: string, relative: string, options: { optional: true }): Promise<string | null>;
export function validateParentRecord(value: unknown): ParentRecord;
export function parentLineage(record: SystemLineage | null | undefined): SystemLineage | null;
export function readParentRecord(root: string): Promise<ParentRecord | null>;
export function validateStockRecord(value: unknown, root?: string): Promise<StockRecord>;
export function readStockRecord(root: string): Promise<StockRecord | null>;
export function unresolvedTokenWarnings(tokens: unknown): string[];
export function validateOffshootRecords(root: string, options?: { parentRecord?: ParentRecord | null }): Promise<{ parent: ParentRecord | null; stock: StockRecord | null; warnings: string[] }>;

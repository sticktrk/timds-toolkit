export declare const POSTING_SCHEMA_VERSION: 1;
export declare const POSTING_TEMPLATE_KIND: "blog";
export declare const POSTING_SOURCE_FILE: "src/posting/blog.json";
export declare const POSTING_BODY_CLASS: "prose";

export type PostingBlock = {
  id: string;
  element: "section" | "aside" | "div";
  /** Fixed heading text, or "" when the writer chooses it. */
  heading: string;
  /** true: in every article. false: written only when its description fits. */
  required: boolean;
  /** true: one paragraph of plain text, so a site can show it in a card of its own. */
  plain: boolean;
  /** What a writer puts in the block, or "". */
  write: string;
};

export type PostingTemplate = {
  schemaVersion: 1;
  template: "blog";
  name: string;
  /** What the page shows by itself, so a writer leaves it out. */
  supplies: string[];
  /** Classes the system approves in an article body. */
  classes: { name: string; use: string }[];
  /** The article's named blocks, in page order. */
  blocks: PostingBlock[];
};

export type ReadPostingTemplate = { template: PostingTemplate; unknown: string[] };

export declare function normalizePostingTemplate(input: unknown, options?: { where?: string }): ReadPostingTemplate;
export declare function readPostingTemplate(designSystemRoot: string): Promise<ReadPostingTemplate | null>;
export declare function unstyledPostingBlocks(template: PostingTemplate, stylesheets: string[]): string[];
export declare function renderPostingPreview(template: PostingTemplate | null): string;
export declare function renderPostingTable(template: PostingTemplate | null): string;
export declare function postingTemplateWarnings(
  read: ReadPostingTemplate,
  options?: { stylesheets?: string[]; bundlePaths?: string[] | null },
): string[];

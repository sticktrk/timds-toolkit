export declare const DEFAULT_BOARD_KINDS: readonly ["chapter-title", "statement", "cards", "compare", "flow", "steps", "document", "subscribe"];
export declare const normalizeCueWord: (value: unknown) => string;
export declare const titleCaseChapterId: (id: unknown) => string;

export type BoardChapterScene = {
  id?: string;
  chapter?: string;
  visual?: {kind: string; [key: string]: unknown};
  [key: string]: unknown;
};
export type VideoChapter = {id: string; label: string};

export declare const deriveVideoChapters: (scenes: BoardChapterScene[]) => VideoChapter[];

export type RevealFrameInput = {
  cue?: string | null;
  words: Array<{text: string; startMs: number; endMs?: number}>;
  index: number;
  count: number;
  duration: number;
  lead?: number;
  fps: number;
};
export declare const revealFrame: (input: RevealFrameInput) => number;

export type BoardLayoutPreset = "standard" | "compact";
export declare const BOARD_LAYOUT_PRESETS: readonly BoardLayoutPreset[];
export declare function assertSharedBoardLayout(visual: {kind: string; [key: string]: unknown}, preset?: BoardLayoutPreset, context?: {vertical?: boolean; overFootage?: boolean}): ReturnType<typeof resolveBoardLayout>;
export declare function resolveBoardLayout(preset?: BoardLayoutPreset, context?: {vertical?: boolean; overFootage?: boolean}): {padding: string; scale: number; scrim: number; fields: Record<string, Record<string, {maxItems: number}>>};

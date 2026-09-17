export declare const FOOTAGE_DERIVATIVE_SUFFIXES: readonly string[];
export declare const footageFamily: (key: string) => string;
export declare const MINIMUM_CHAIN_CLIP_SECONDS: number;
export declare const verticalTextZone: (text?: string) => "upper" | "lower";
export declare const chainClipFrames: (availableFrames: number[], duration: number, minimumFrames: number) => number[];

export type FootageScene = {
  id: string;
  asset?: string;
  assets?: string[];
  intro?: boolean;
  outro?: boolean;
  [key: string]: unknown;
};
export type FootagePick = {scene: string; key: string; family: string};
export type FootageRepeat = {previous: FootagePick; current: FootagePick};

export declare const sceneAssetKeys: (scene: FootageScene) => string[];
export declare function adjacentFootageRepeats(scenes: FootageScene[]): FootageRepeat[];
export declare const DANGLING_HEADLINE_ENDING: RegExp;
export declare const truncatedHeadline: (headline: unknown) => boolean;

export declare const tieOrphan: (value: string) => string;

export declare function splitGoldHeadline(value: string, requestedPhrase?: string): {
  before: string;
  highlighted: string;
  after: string;
};

export declare function fitCoverHeadline(value: string, options?: {
  width?: number;
  height?: number;
  maximum?: number;
  step?: number;
  lineHeight?: number;
  emPerCharacter?: number;
}): number;

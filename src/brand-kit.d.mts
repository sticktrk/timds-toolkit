/** The starter's data vocabulary; this module performs no I/O or inference. */
export type BrandKitLabel = 'confirmed' | 'observed' | 'assumed' | 'unresolved';
export type BrandKitSlotKind = 'token' | 'copy' | 'media' | 'element';
export interface BrandKitSlot {
  readonly key: string;
  readonly group: string;
  readonly kind: BrandKitSlotKind;
  readonly source: string;
  readonly assumption: string;
  readonly guidance: string;
  readonly sample: string;
  readonly page: string;
  readonly label: BrandKitLabel;
}
export interface BrandKitPage {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly planned?: true;
  readonly layout?: 'landing';
  readonly promote?: string;
}
export interface BrandKitView {
  readonly id: string;
  readonly label: string;
  readonly blurb: string;
  readonly pages: readonly BrandKitPage[];
}
export interface BrandKitTreatment {
  readonly id: 'minimal' | 'accent' | 'bold' | 'photo';
  readonly label: string;
  readonly ground: string;
  readonly ink: string;
  readonly mark: string;
  readonly accent: string;
  readonly photo?: string;
}
export const brandKitStarter: 'brand-kit';
export const brandKitLabels: readonly BrandKitLabel[];
export const brandKitSlots: readonly BrandKitSlot[];
export const brandKitFoundationTokens: Readonly<Record<string, Readonly<Record<string, Readonly<{value: string; label: BrandKitLabel; description: string}>>>>>;
export const brandKitCopySamples: Readonly<Record<string, string>>;
export const brandKitMediaSamples: Readonly<Record<string, string>>;
export const brandKitViews: readonly BrandKitView[];
export const brandKitPages: Readonly<{authored: readonly string[]; planned: readonly string[]; builderOwned: readonly string[]}>;
export const brandKitStockPaths: readonly string[];
export const brandKitTreatments: readonly BrandKitTreatment[];

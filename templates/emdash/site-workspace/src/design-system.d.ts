// Types of the module the design system integration
// (src/integrations/design-system.mjs) builds from the Design System.
declare module "virtual:timds/design-system" {
	import type { AstroComponentFactory } from "astro/runtime/server/index.js";
	type Attributes = Record<string, string>;
	interface DesignDocument {
		htmlAttributes: Attributes;
		head: string;
		bodyAttributes: Attributes;
	}
	export const system: { id: string; name: string; description: string; version: string };
	export const design: { id: string; title: string; layout: boolean };
	export const pages: Array<DesignDocument & { route: string; title: string; body: string; division?: string }>;
	export const shell: DesignDocument & { before: string; after: string; describes: boolean };
	export const sectionsContract: 2;
	export const routeError: string | null;
	export const sections: Array<{ collection: string; prefix: string; label: string; singularLabel: string; feed: boolean; urlPattern: string }>;
	export const sectionSchema: { fields: Array<Record<string, unknown>>; supports: string[]; taxonomies: Array<Record<string, unknown>> };
	export const divisionContexts: Record<string, { prefix: string; system: string; design: string; assetPrefix: string; styles: Array<{ href: string; media: string | null }> }>;
	export const divisionLayouts: Record<string, () => Promise<{ default: AstroComponentFactory }>>;
	export const mainLayout: () => Promise<{ default: AstroComponentFactory }>;
	export const mainPage: () => Promise<{ default: AstroComponentFactory }>;
	export const collectionContexts: Partial<Record<string, string>>;
	export const titleMarker: string;
	/** The site's form handlers by the address they handle: the modules under src/forms/ that export POST, by file (relative to the site) and loader. */
	export const forms: Record<string, { file: string; load: () => Promise<{ POST?: unknown }> }>;
}

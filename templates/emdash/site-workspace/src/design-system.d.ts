// Types of the module the design system integration
// (src/integrations/design-system.mjs) builds from the Design System.
declare module "virtual:timds/design-system" {
	type Attributes = Record<string, string>;
	interface DesignDocument {
		htmlAttributes: Attributes;
		head: string;
		bodyAttributes: Attributes;
	}
	export const system: { id: string; name: string; description: string; version: string };
	export const design: { id: string; title: string; layout: boolean };
	export const pages: Array<DesignDocument & { route: string; title: string; body: string }>;
	export const shell: DesignDocument & { before: string; after: string; describes: boolean };
	export const titleMarker: string;
	/** The site's form handlers by the address they handle: the modules under src/forms/ that export POST. */
	export const forms: Record<string, () => Promise<{ POST: (context: import("astro").APIContext) => Response | Promise<Response> }>>;
}

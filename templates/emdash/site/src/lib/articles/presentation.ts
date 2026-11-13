import type { ContentEntry } from "emdash";

import type { ArticleData, Section } from "./index";

interface Organization {
	name: string;
	url?: string;
	logo?: string;
}

interface ArticlePresentation {
	/** Approved additional design classes and public image origins for HTML policy 1. */
	html?: { classes?: string[]; mediaOrigins?: string[] };
	/** Site-owned identity. The default uses EmDash's Person bylines. */
	organization?: Organization;
	author?: "bylines" | "organization";
	/** Interior insertion point expressed as a fraction of the body. */
	withinBody?: number;
}

/** Edit with the site's Design System. Division-aware components can read context.presentation.division. */
export const articlePresentation: ArticlePresentation = {};

export interface ArticleRegionProps {
	context: {
		entry: ContentEntry<ArticleData>;
		section: Section;
		canonical: string;
		isPreview: boolean;
		presentation: {
			division: string | null;
			origin: string;
			sectionUrl: string;
			bodyFormat: "html" | "portable-text";
			hasBodyAnswerBox: boolean;
			bodyLinks: readonly string[];
		};
	};
}

export function organizationSchema(organization: Organization | undefined, origin: string) {
	if (!organization?.name.trim()) return undefined;
	return {
		"@type": "Organization",
		name: organization.name,
		url: organization.url || origin,
		...(organization.logo ? { logo: new URL(organization.logo, origin).href } : {}),
	};
}

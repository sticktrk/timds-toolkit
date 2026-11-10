/**
 * Article and topic URLs for the site's own sitemap. Import this from the
 * sitemap route the site already has; this package writes no sitemap route.
 *
 *   import { getArticleSitemapEntries } from "../lib/articles/sitemap";
 *   const entries = await getArticleSitemapEntries(Astro.url.origin);
 */
import { getEmDashCollection, getTaxonomyTerms } from "emdash";

import { ARTICLES, TOPIC, absoluteUrl, articlePath, topicPath, type ArticleData } from "./index";

export interface SitemapEntry {
	url: string;
	lastmod?: string;
}

const PAGE_SIZE = 100;

/** Every published article, then every topic that has at least one published article. */
export async function getArticleSitemapEntries(origin: string): Promise<SitemapEntry[]> {
	const entries: SitemapEntry[] = [{ url: absoluteUrl("/articles/", origin) }];

	let cursor: string | undefined;
	do {
		const page = await getEmDashCollection<typeof ARTICLES, ArticleData>(ARTICLES, {
			orderBy: { published_at: "desc" },
			limit: PAGE_SIZE,
			cursor,
		});
		if (page.error) throw page.error;
		for (const entry of page.entries) {
			entries.push({ url: absoluteUrl(articlePath(entry.id), origin), lastmod: entry.data.updatedAt.toISOString() });
		}
		cursor = page.nextCursor;
	} while (cursor);

	const topics = await getTaxonomyTerms(TOPIC, { includeCounts: true });
	for (const topic of topics) {
		if ((topic.count ?? 0) > 0) entries.push({ url: absoluteUrl(topicPath(topic.slug), origin) });
	}
	return entries;
}

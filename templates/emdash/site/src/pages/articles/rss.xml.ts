/**
 * /articles/rss.xml: the 20 newest published articles. It lives under
 * /articles/ so it never collides with a feed the site already serves at its root.
 */
import type { APIRoute } from "astro";
import { getEmDashCollection, getSiteSettingsWithCacheHint } from "emdash";

import { ARTICLES, absoluteUrl, articlePath, cacheControl, siteOrigin, sitePath, type ArticleData } from "../../lib/articles/index";

export const prerender = false;

const XML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const XML_SPECIAL = /[&<>"']/g;

function escapeXml(value: string): string {
	return value.replace(XML_SPECIAL, (character) => XML_ESCAPES[character] ?? character);
}

export const GET: APIRoute = async ({ url, site, locals, cache }) => {
	const origin = siteOrigin(url, site);
	const settings = await getSiteSettingsWithCacheHint();
	const { entries, cacheHint, error } = await getEmDashCollection<typeof ARTICLES, ArticleData>(ARTICLES, {
		orderBy: { published_at: "desc" },
		limit: 20,
	});
	if (error) throw error;

	if (cache?.enabled) {
		cache.set(settings.cacheHint);
		cache.set(cacheHint);
	}

	const title = settings.data.title || "__SITE_NAME__";
	const feedUrl = absoluteUrl(sitePath("/articles/rss.xml"), origin);
	const items = entries
		.filter((entry) => entry.data.publishedAt)
		.map((entry) => {
			const link = absoluteUrl(articlePath(entry.id), origin);
			return [
				"    <item>",
				`      <title>${escapeXml(entry.data.title)}</title>`,
				`      <link>${escapeXml(link)}</link>`,
				`      <guid isPermaLink="true">${escapeXml(link)}</guid>`,
				`      <pubDate>${entry.data.publishedAt?.toUTCString() ?? ""}</pubDate>`,
				`      <description>${escapeXml(entry.data.summary ?? "")}</description>`,
				"    </item>",
			].join("\n");
		});

	const body = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
		"  <channel>",
		`    <title>${escapeXml(`${title}: articles`)}</title>`,
		`    <link>${escapeXml(absoluteUrl(sitePath("/articles/"), origin))}</link>`,
		`    <description>${escapeXml(settings.data.tagline || `Articles from ${title}`)}</description>`,
		`    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml"/>`,
		...items,
		"  </channel>",
		"</rss>",
		"",
	].join("\n");

	const cacheHeader = cacheControl(locals, url);
	return new Response(body, {
		headers: {
			"Content-Type": "application/rss+xml; charset=utf-8",
			"Cache-Control": cacheHeader === "private, no-store" ? cacheHeader : "public, max-age=3600",
		},
	});
};

/**
 * /articles/rss.xml: the 20 newest published articles. It lives under
 * /articles/ so it never collides with a feed the site already serves at its root.
 */
import type { APIRoute } from "astro";
import { getEmDashCollection, getSiteSettingsWithCacheHint } from "emdash";

import { sectionForPath, absoluteUrl, articlePath, cacheControl, siteOrigin, sitePath, type ArticleData } from "../../lib/articles/index";

import { sectionAvailable, sectionUnavailable } from "../../lib/articles/availability";

export const prerender = false;

const XML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const XML_SPECIAL = /[&<>"']/g;

function escapeXml(value: string): string {
	return value.replace(XML_SPECIAL, (character) => XML_ESCAPES[character] ?? character);
}

export const GET: APIRoute = async ({ url, site, locals, cache }) => {
	const section = sectionForPath(url.pathname);
	if (!section?.feed) return new Response("Not found", { status: 404 });
	if (!await sectionAvailable(section)) return sectionUnavailable();
	const origin = siteOrigin(url, site);
	const settings = await getSiteSettingsWithCacheHint();
	const { entries, cacheHint, error } = await getEmDashCollection<string, ArticleData>(section.collection, {
		orderBy: { published_at: "desc" },
		limit: 20,
	});
	if (error) throw error;

	if (cache?.enabled) {
		cache.set(settings.cacheHint);
		cache.set(cacheHint);
	}

	const title = settings.data.title || "__SITE_NAME__";
	const feedUrl = absoluteUrl(sitePath(`${section.prefix}rss.xml`), origin);
	const items = entries
		.filter((entry) => entry.data.publishedAt)
		.map((entry) => {
			const link = absoluteUrl(articlePath(entry.id, section), origin);
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
		`    <title>${escapeXml(`${title}: ${section.label.toLowerCase()}`)}</title>`,
		`    <link>${escapeXml(absoluteUrl(sitePath(section.prefix), origin))}</link>`,
		`    <description>${escapeXml(settings.data.tagline || `${section.label} from ${title}`)}</description>`,
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

export const HEAD: APIRoute = async (context) => {
	const response = await GET(context);
	return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
};

export const ALL: APIRoute = ({ url }) => sectionForPath(url.pathname)?.feed
	? new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD", "Cache-Control": "no-store" } })
	: new Response("Not found", { status: 404 });

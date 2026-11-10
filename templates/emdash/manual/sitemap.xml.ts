// An existing sitemap route (for example src/pages/sitemap.xml.ts) gains the
// article and topic URLs from the helper the scaffold installed. Lines marked
// NEW are the change; the rest stands for what the site already has. A
// sitemap built at build time (such as @astrojs/sitemap) cannot list
// articles published later: serve the sitemap on request, as here, or link
// EmDash's own /sitemap-articles.xml from the site's sitemap index instead.
import type { APIRoute } from "astro";

import { cacheControl } from "../lib/articles/index"; // NEW
import { getArticleSitemapEntries } from "../lib/articles/sitemap"; // NEW

export const prerender = false; // NEW: articles appear without a rebuild

export const GET: APIRoute = async ({ url, site, locals }) => {
	const origin = site?.origin ?? url.origin;
	const pages: Array<{ url: string; lastmod?: string }> = [
		{ url: `${origin}/` }, // ...the site's existing pages
	];
	pages.push(...(await getArticleSitemapEntries(origin))); // NEW

	const body = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
		...pages.map((page) => `  <url><loc>${page.url}</loc>${page.lastmod ? `<lastmod>${page.lastmod}</lastmod>` : ""}</url>`),
		"</urlset>",
		"",
	].join("\n");
	// NEW: an editor's request can list a draft revision's unpublished slug,
	// so a signed-in or preview response is never stored by a shared cache.
	const cacheHeader = cacheControl(locals, url);
	return new Response(body, {
		headers: {
			"Content-Type": "application/xml; charset=utf-8",
			"Cache-Control": cacheHeader === "private, no-store" ? cacheHeader : "public, max-age=3600",
		},
	});
};

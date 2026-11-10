/**
 * Shared pieces of the article routes: the entry shape the seed defines, the
 * URLs writers and readers rely on, media URLs, dates and cache headers.
 *
 * The collection, taxonomy and field names below are the contract external
 * writers target (see docs/content-api.md). Renaming any of them breaks them.
 */
import type { ContentBylineCredit, PortableTextBlock, TaxonomyTerm } from "emdash";

export const ARTICLES = "articles";
export const TOPIC = "topic";

/** An image field value, as EmDash stores it. */
export interface ArticleImage {
	id: string;
	src?: string;
	alt?: string;
	width?: number;
	height?: number;
	provider?: string;
	meta?: Record<string, unknown>;
}

/** System fields EmDash adds to every entry, plus the fields the seed defines. */
export interface ArticleData {
	id: string;
	slug: string | null;
	status: string;
	title: string;
	summary?: string | null;
	body?: PortableTextBlock[] | null;
	cover?: ArticleImage | null;
	createdAt: Date;
	updatedAt: Date;
	publishedAt: Date | null;
	bylines?: ContentBylineCredit[];
	terms?: Record<string, TaxonomyTerm[]>;
}

/** What EmDash sets on `Astro.locals` for public routes. */
interface EmDashLocals {
	user?: unknown;
	emdash?: { getPublicMediaUrl?: (storageKey: string) => string };
}

/**
 * The helpers below take `Astro.locals` as a plain object and read EmDash's
 * keys through this, so they type-check whatever the site's own `App.Locals`
 * declares (the Cloudflare adapter's runtime, for one, shares no key with them).
 */
type SiteLocals = object;
const emdashLocals = (locals: SiteLocals): EmDashLocals => locals;

// Typed as string so the comparison below stays valid whatever the scaffold writes here.
const CONFIGURED_SITE_URL: string = "__SITE_URL__";
const UNKNOWN_SITE_URL: string = "https://example.com";
const INTERNAL_MEDIA_PREFIX = "/_emdash/api/media/file/";
const SAFE_STORAGE_KEY = /^[A-Za-z0-9._-]+$/;
const TRAILING_SLASHES = /\/+$/;

export function articlePath(slug: string): string {
	return `/articles/${encodeURIComponent(slug)}/`;
}

export function topicPath(slug: string): string {
	return `/topics/${encodeURIComponent(slug)}/`;
}

/**
 * The production origin. Astro's `site` wins, then the origin the scaffold
 * recorded, then the request's own origin (local development, previews).
 */
export function siteOrigin(url: URL, site?: URL): string {
	if (site) return site.origin;
	if (CONFIGURED_SITE_URL !== UNKNOWN_SITE_URL) return CONFIGURED_SITE_URL.replace(TRAILING_SLASHES, "");
	return url.origin;
}

export function absoluteUrl(pathOrUrl: string, origin: string): string {
	return new URL(pathOrUrl, `${origin}/`).href;
}

function storageKeyUrl(key: string, locals: SiteLocals): string {
	const resolve = emdashLocals(locals).emdash?.getPublicMediaUrl;
	return resolve ? resolve(key) : `${INTERNAL_MEDIA_PREFIX}${key}`;
}

/** URL of an image field value (the cover). Mirrors EmDash's own Image component for local and external media. */
export function imageFieldUrl(image: ArticleImage | null | undefined, locals: SiteLocals): string | undefined {
	if (!image) return undefined;
	if (typeof image.src === "string" && image.src !== "") return image.src;
	const storageKey = image.meta?.storageKey;
	if (typeof storageKey === "string" && storageKey !== "") return storageKeyUrl(storageKey, locals);
	return image.id ? `${INTERNAL_MEDIA_PREFIX}${image.id}` : undefined;
}

/** URL of a Portable Text image block's asset. Mirrors EmDash's render-time resolution. */
export function imageBlockUrl(
	asset: { _ref?: string; url?: string; src?: string; meta?: Record<string, unknown> } | undefined,
	locals: SiteLocals,
): string | undefined {
	if (!asset) return undefined;
	const storageKey = asset.meta?.storageKey;
	if (typeof storageKey === "string" && storageKey !== "") return storageKeyUrl(storageKey, locals);
	const url = asset.url || asset.src;
	if (url) {
		const key = url.startsWith(INTERNAL_MEDIA_PREFIX) ? url.slice(INTERNAL_MEDIA_PREFIX.length) : "";
		return key && SAFE_STORAGE_KEY.test(key) ? storageKeyUrl(key, locals) : url;
	}
	return asset._ref ? `${INTERNAL_MEDIA_PREFIX}${asset._ref}` : undefined;
}

export function topicsOf(data: ArticleData): TaxonomyTerm[] {
	return data.terms?.[TOPIC] ?? [];
}

export function bylineNames(data: ArticleData): string[] {
	return (data.bylines ?? []).map((credit) => credit.byline.displayName).filter((name) => name !== "");
}

const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
	day: "numeric",
	month: "long",
	year: "numeric",
	timeZone: "UTC",
});

/** The `datetime` attribute and the visible text for a date, both in UTC so they agree. */
export function formatDate(date: Date): { datetime: string; text: string } {
	return { datetime: date.toISOString().slice(0, 10), text: DATE_FORMAT.format(date) };
}

/**
 * Browser and downstream-cache policy for an article response. A response
 * rendered for a signed-in user or a preview link is never stored by a
 * shared cache; EmDash keeps both out of Astro's route cache on its own.
 */
export function cacheControl(locals: SiteLocals, url: URL, isPreview = false): string {
	if (isPreview || isSignedIn(locals) || url.searchParams.has("_preview")) return "private, no-store";
	return "public, max-age=60";
}

/** EmDash sets `locals.user` on public routes when the visitor has an admin session. */
export function isSignedIn(locals: SiteLocals): boolean {
	return Boolean(emdashLocals(locals).user);
}

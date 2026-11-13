import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";

type Node = DefaultTreeAdapterTypes.ChildNode;

export const HTML_POLICY_VERSION = 1;
export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const VIDEO_ORIGIN = "https://www.youtube-nocookie.com";
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const ALLOWED_ELEMENTS = new Set([
	"a", "abbr", "b", "blockquote", "br", "caption", "cite", "code", "dd", "div", "dl", "dt",
	"em", "figcaption", "figure", "h2", "h3", "h4", "h5", "h6", "hr", "i", "iframe", "img",
	"kbd", "li", "mark", "ol", "p", "pre", "q", "s", "section", "small", "span", "strong", "sub",
	"sup", "table", "tbody", "td", "th", "thead", "tfoot", "time", "tr", "ul",
]);
const VOID_ELEMENTS = new Set(["br", "hr", "img"]);
const GLOBAL_ATTRIBUTES = new Set(["id", "class", "title", "lang", "dir", "aria-label", "aria-labelledby", "aria-describedby"]);
const DIMENSIONS = ["width", "height"];
const ELEMENT_ATTRIBUTES: Partial<Record<string, string[]>> = {
	a: ["href", "rel", "target"], blockquote: ["cite"], q: ["cite"],
	iframe: ["src", ...DIMENSIONS, "loading", "allowfullscreen", "allow", "referrerpolicy"],
	img: ["src", "alt", ...DIMENSIONS, "loading", "decoding"],
	ol: ["start", "reversed"], li: ["value"], td: ["colspan", "rowspan"], th: ["colspan", "rowspan", "scope"],
	time: ["datetime"],
};
const STOCK_CLASSES = ["table-scroll", "article-lede", "article-steps", "article-risks", "article-scenario"];
const EMBED_ALLOW = new Set(["accelerometer", "autoplay", "clipboard-write", "encrypted-media", "gyroscope", "picture-in-picture", "web-share", "fullscreen"]);
const UNSAFE_URL = /[\x00-\x20\x7f\\]|%(?:0[0-9a-f]|1[0-9a-f]|7f|2f|5c)/i;
const MEDIA_PATH = /^\/_emdash\/api\/media\/file\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_DEPTH = 64;

export interface HtmlPolicy {
	origin: string;
	mediaOrigins?: readonly string[];
	classes?: readonly string[];
}

export class ArticleHtmlError extends Error {
	constructor() {
		super(`Article HTML does not conform to policy ${HTML_POLICY_VERSION}.`);
	}
}

const invalid = (): never => { throw new ArticleHtmlError(); };

export function videoEmbedUrl(value: unknown): string | undefined {
	return typeof value === "string" && VIDEO_ID.test(value) ? `${VIDEO_ORIGIN}/embed/${value}` : undefined;
}

function webUrl(value: string, origin: string): URL | undefined {
	if (!value || UNSAFE_URL.test(value) || !/^(?:\/(?!\/)|https?:\/\/)/i.test(value)) return undefined;
	try {
		const url = new URL(value, origin);
		return url.username || url.password ? undefined : url;
	} catch {
		return undefined;
	}
}

export function sameSitePath(value: unknown): value is string {
	if (typeof value !== "string" || !/^\/(?!\/)/.test(value) || /[?#]/.test(value)) return false;
	const url = webUrl(value, "https://example.com");
	return url?.pathname === value;
}

export function linksToSitePath(links: readonly string[], path: string, origin: string): boolean {
	const target = path.replace(/\/$/, "");
	return links.some((link) => {
		const url = webUrl(link, origin);
		return url?.origin === origin && url.pathname.replace(/\/$/, "") === target;
	});
}

function linkAllowed(value: string, origin: string): boolean {
	return !UNSAFE_URL.test(value) && (/^(?:#|mailto:|tel:)/i.test(value) || Boolean(webUrl(value, origin)));
}

function imageAllowed(value: string, policy: HtmlPolicy): boolean {
	const url = webUrl(value, policy.origin);
	if (!url || url.hash) return false;
	if (url.origin === policy.origin && MEDIA_PATH.test(url.pathname) && !url.search) return true;
	return url.protocol === "https:" && Boolean(policy.mediaOrigins?.includes(url.origin));
}

function iframeAllowed(value: string): boolean {
	const id = value.slice(`${VIDEO_ORIGIN}/embed/`.length);
	return videoEmbedUrl(id) === value;
}

function validateElement(node: DefaultTreeAdapterTypes.Element, policy: HtmlPolicy, classes: Set<string>, ids: Set<string>) {
	const { tagName, namespaceURI, attrs } = node;
	if (namespaceURI !== HTML_NAMESPACE || !ALLOWED_ELEMENTS.has(tagName)) invalid();
	const values = new Map(attrs.map(({ name, value }) => [name, value]));
	for (const { name, value, namespace } of attrs) {
		if (namespace || !GLOBAL_ATTRIBUTES.has(name) && !ELEMENT_ATTRIBUTES[tagName]?.includes(name)) invalid();
		if (name === "class" && value.split(/[\t\n\f\r ]+/).some((item) => item && !classes.has(item))) invalid();
		if (name === "id") {
			if (!/^[\p{L}\p{N}_][\p{L}\p{M}\p{N}_.:-]*$/u.test(value) || ids.has(value)) invalid();
			ids.add(value);
		}
		if ((name === "href" || name === "cite") && !linkAllowed(value, policy.origin)) invalid();
		if (name === "target" && value !== "_blank" && value !== "_self") invalid();
		if (name === "allow" && value.split(";").some((token) => token.trim() && !EMBED_ALLOW.has(token.trim()))) invalid();
	}
	if (tagName === "a" && values.get("target") === "_blank" && /(?:^|\s)opener(?:\s|$)/i.test(values.get("rel") ?? "")) invalid();
	if (tagName === "img" && (!values.has("alt") || !imageAllowed(values.get("src") ?? "", policy))) invalid();
	if (tagName === "iframe" && (!values.get("title")?.trim() || !iframeAllowed(values.get("src") ?? "") || node.childNodes.length)) invalid();
	return values;
}

/** Validate the parsed fragment, then use source offsets to retain its exact bytes. */
export function articleHtml(source: string, policy: HtmlPolicy) {
	if (source.length > MAX_SOURCE_BYTES || new TextEncoder().encode(source).length > MAX_SOURCE_BYTES || source.includes("\0")) invalid();
	const fragment = parseFragment(source, { sourceCodeLocationInfo: true, onParseError: invalid });
	const classes = new Set([...STOCK_CLASSES, ...(policy.classes ?? [])]);
	const ids = new Set<string>();
	const links: string[] = [];
	let hasAnswerBox = false;
	const whitespace = (start: number, end: number) => /^[\t\n\f\r ]*$/.test(source.slice(start, end));

	const visit = (node: Node, start: number, end: number, depth: number): number => {
		if (depth > MAX_DEPTH) return invalid();
		const loc = node.sourceCodeLocation;
		// Browsers may insert an implicit tbody around explicit rows.
		if (!loc && "tagName" in node && node.tagName === "tbody" && !node.attrs.length) {
			return visitChildren(node.childNodes, start, end, depth + 1).at(-1) ?? start;
		}
		if (!loc || loc.startOffset < start || loc.endOffset > end || !whitespace(start, loc.startOffset)) return invalid();
		if ("tagName" in node) {
			const attrs = validateElement(node, policy, classes, ids);
			if (node.tagName === "section" && attrs.get("id") === "answer-box") hasAnswerBox = true;
			const href = attrs.get("href");
			if (node.tagName === "a" && href) links.push(href);
			const startTag = node.sourceCodeLocation?.startTag;
			const endTag = node.sourceCodeLocation?.endTag;
			if (!startTag || (!VOID_ELEMENTS.has(node.tagName) && !endTag)) return invalid();
			if (endTag) {
				const childEnd = visitChildren(node.childNodes, startTag.endOffset, endTag.startOffset, depth + 1).at(-1) ?? startTag.endOffset;
				if (!whitespace(childEnd, endTag.startOffset)) invalid();
			}
		} else if (node.nodeName === "#text") {
			// An ignored tag can be inside a coalesced text span in the fragment parser
			// but alter the surrounding document when the original source is rendered.
			if (source.slice(loc.startOffset, loc.endOffset).includes("<")) invalid();
		} else if (node.nodeName !== "#comment") invalid();
		return loc.endOffset;
	};
	function visitChildren(nodes: Node[], start: number, end: number, depth: number): number[] {
		let cursor = start;
		return nodes.map((node) => (cursor = visit(node, cursor, end, depth)));
	}
	const ends = visitChildren(fragment.childNodes, 0, source.length, 0);
	if (!whitespace(ends.at(-1) ?? 0, source.length)) invalid();
	const contentEnds = ends.filter((end, index) => {
		const node = fragment.childNodes[index];
		return node.nodeName !== "#comment" && !(node.nodeName === "#text" && "value" in node && !node.value.trim());
	});
	if (contentEnds.length) contentEnds[contentEnds.length - 1] = source.length;
	return { source, boundaries: contentEnds, links, hasAnswerBox };
}

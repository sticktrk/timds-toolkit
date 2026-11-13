// Exercise fresh CLI scaffolds and the native EmDash API on a local Worker.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/timds.mjs", import.meta.url));
const root = await realpath(await mkdtemp(path.join(tmpdir(), "timds-article-publishing-")));
const env = { ...process.env, ASTRO_TELEMETRY_DISABLED: "1", WRANGLER_SEND_METRICS: "false" };
const command = (cwd, file, ...args) => execFileSync(file, args, { cwd, env, timeout: 180_000, stdio: "pipe" });
const timds = (cwd, ...args) => command(cwd, process.execPath, cli, ...args);
const load = async (file) => JSON.parse(await readFile(file, "utf8"));
const save = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
const PORTABLE_FIELDS = ["title", "summary", "body", "cover"];
const HTML_FIELDS = [...PORTABLE_FIELDS, "body_html", "short_answer", "state", "video_id", "related_guide"];
const PUBLIC_ORIGIN = "https://example.org";

async function scaffold(name, kind, profile) {
	const workspace = path.join(root, name);
	await mkdir(workspace);
	command(workspace, "git", "init", "-q", "-b", "main");
	timds(workspace, "init", "--standalone", "--starter", kind, "--system-id", `example/${name}`, "--name", "Example Studio", "--provider", "local");
	const scaffoldArgs = ["consumer", "scaffold", "emdash", "--workspace", "--skip-install"];
	if (profile === "html") {
		assert.throws(() => timds(workspace, ...scaffoldArgs, "--content-profile", "unsupported"), /content-profile must be portable-text or html/);
		scaffoldArgs.push("--content-profile", profile);
	}
	timds(workspace, ...scaffoldArgs);
	const site = path.join(workspace, "site");
	const record = await load(path.join(site, ".timds/emdash.json"));
	const model = await load(path.join(site, "section-schema.json"));
	assert.equal(record.contentProfile, profile);
	assert.deepEqual(model.fields.map(({ slug }) => slug), profile === "html" ? HTML_FIELDS : PORTABLE_FIELDS);
	const seed = await load(path.join(site, "seed/seed.json"));
	assert.deepEqual(seed.collections[0].fields, model.fields);
	timds(workspace, "consumer", "check", "--root", "site", "--no-fix");
	return site;
}

async function freePort() {
	const server = createServer();
	await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	await new Promise((resolve) => server.close(resolve));
	return port;
}

let child;
let output = "";
async function stop() {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise((resolve) => child.once("exit", resolve));
	child.kill("SIGTERM");
	const deadline = setTimeout(() => child.kill("SIGKILL"), 5_000);
	try { await exited; } finally { clearTimeout(deadline); }
}

async function serve(site) {
	const port = await freePort();
	const origin = `http://127.0.0.1:${port}`;
	output = "";
	child = spawn(process.execPath, [path.join(site, "node_modules/astro/bin/astro.mjs"), "dev", "--host", "127.0.0.1", "--port", String(port), "--ignore-lock"], {
		cwd: site, env: { ...env, TIMDS_DESIGNED_GONE: "1" }, stdio: ["ignore", "pipe", "pipe"],
	});
	for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output = (output + chunk).slice(-16_000); });
	const request = (address, init = {}) => fetch(new URL(address, origin), { redirect: "manual", signal: AbortSignal.timeout(10_000), ...init });
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
		let setup;
		try { setup = await request("/_emdash/api/setup/dev-bypass"); } catch { /* Astro is starting. */ }
		if (setup?.ok) {
			const cookie = setup.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
			await setup.body?.cancel();
			const api = async (address, { method = "GET", data, status = 200 } = {}) => {
				const headers = { Cookie: cookie, Origin: origin, "X-EmDash-Request": "1" };
				if (data !== undefined && !(data instanceof FormData)) headers["Content-Type"] = "application/json";
				const body = data === undefined || data instanceof FormData ? data : JSON.stringify(data);
				const response = await request(`/_emdash/api${address}`, { method, headers, body });
				const text = await response.text();
				assert.equal(response.status, status, `${method} ${address}: ${text}`);
				return text ? JSON.parse(text).data : undefined;
			};
			return { api, request };
		}
		await setup?.body?.cancel();
		await delay(300);
	}
	throw new Error("EmDash did not start and seed its local database.");
}

const text = (key, value, attributes = {}) => ({
	_type: "block", style: "normal", _key: key, markDefs: [], children: [{ _type: "span", _key: `${key}-span`, text: value }], ...attributes,
});
const body = [text("body", "Portable body")];
const create = (api, collection, slug, data) => api(`/content/${collection}`, { method: "POST", data: { slug, data: { title: `Example ${collection}`, body, ...data } }, status: 201 });
const publish = (api, address, _rev) => api(`${address}/publish`, { method: "POST", data: { _rev } });

try {
	const plain = await scaffold("portable", "brand-kit", "portable-text");
	const site = await scaffold("html", "starter", "html");
	const sectionsFile = path.join(site, "sections.json");
	const sections = await load(sectionsFile);
	sections.sections.push({ collection: "manuals", prefix: "/guides/", label: "Guides", singularLabel: "Guide", feed: true });
	await save(sectionsFile, sections);
	await save(path.join(site, "divisions.json"), {
		schemaVersion: 1, systems: { main: { workspace: true } }, divisions: [{
			id: "studio", prefix: "/studio/", system: "main", design: "website", pages: "src/divisions/studio/pages",
			layout: "src/layouts/Studio.astro", collections: ["manuals"],
		}],
	});
	await mkdir(path.join(site, "src/divisions/studio/pages"), { recursive: true });
	await writeFile(path.join(site, "src/divisions/studio/pages/index.html"), "<h1>Studio</h1>\n");
	await writeFile(path.join(site, "src/layouts/Studio.astro"), '<html lang="en"><head><title>{Astro.props.title}</title><slot name="head" /></head><body><header>Division layout</header><main><slot /></main></body></html>\n');
	const presentation = path.join(site, "src/lib/articles/presentation.ts");
	await writeFile(presentation, (await readFile(presentation, "utf8")).replace("ArticlePresentation = {};", 'ArticlePresentation = { withinBody: 0.25, organization: { name: "Example Studio" } };'));
	await writeFile(path.join(site, "src/components/articles/regions/WithinBody.astro"), '<aside class="article-note"><a href="/contact/">Site call to action</a></aside>\n');
	for (const fixture of [plain, site]) {
		const seedFile = path.join(fixture, "seed/seed.json");
		const seed = await load(seedFile);
		seed.content = { articles: [] };
		await save(seedFile, seed);
		command(fixture, process.execPath, "scripts/sections.mjs");
		command(fixture, "npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund");
	}

	await writeFile(path.join(site, ".dev.vars"), `EMDASH_SITE_URL=${PUBLIC_ORIGIN}\n`);
	const { api, request } = await serve(site);
	const schema = await api("/schema");
	assert.deepEqual(schema.collections.find(({ slug }) => slug === "manuals").fields.map(({ slug }) => slug), HTML_FIELDS);
	const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2NkYAAAAASUVORK5CYII=", "base64");
	const media = new FormData();
	media.set("file", new Blob([image], { type: "image/png" }), "example.png");
	const upload = await api("/media", { method: "POST", data: media, status: 201 });
	assert.match(upload.item.url, /^\/_emdash\/api\/media\/file\//);
	const publicImage = await request(upload.item.url);
	assert.equal(publicImage.status, 200);
	assert.deepEqual(Buffer.from(await publicImage.arrayBuffer()), image);
	const firstNode = "\n <H2 id='evidence'>HTML source &amp; anchor</H2>";
	const rest = `\r\n <p class="article-lede">The original lead. <a href="https://example.com/guides/shared/">External guide</a></p>\n <figure><img src="${upload.item.url}" alt="Body image"><figcaption>Image note</figcaption></figure>\n <iframe title="Example embed" src="https://www.youtube-nocookie.com/embed/abcdefghijk" allowfullscreen></iframe>\n`;
	const source = firstNode + rest;
	const created = await create(api, "articles", "shared", { body_html: source, short_answer: "<b>Plain answer</b>", video_id: "ABCDEFGHIJK", related_guide: { url: "/guides/shared/", title: "Guide title" } });
	const guide = await create(api, "manuals", "shared", { body_html: '<p class="article-lede">Guide source</p>' });
	const entryPath = `/content/articles/${created.item.id}`;
	assert.equal((await request("/articles/shared/")).status, 404);
	const previewLink = await api(`${entryPath}/preview-url`, { method: "POST", data: {} });
	const preview = new URL(previewLink.url, PUBLIC_ORIGIN);
	const draft = await request(preview.pathname + preview.search);
	assert.equal(draft.status, 200);
	assert.match(draft.headers.get("cache-control"), /private, no-store/);
	assert.ok((await draft.text()).includes(firstNode));
	await publish(api, entryPath, created._rev);
	await publish(api, `/content/manuals/${guide.item.id}`, guide._rev);
	const read = await api(entryPath);
	assert.equal(read.item.data.body_html, source);
	const entry = await request("/articles/shared/");
	assert.equal(entry.status, 200);
	const page = await entry.text();
	const beforeCta = page.indexOf(firstNode);
	const cta = page.indexOf("Site call to action", beforeCta);
	const afterCta = page.indexOf(rest, cta);
	assert.ok(beforeCta >= 0 && cta > beforeCta && afterCta > cta, "the CTA sits between intact source fragments");
	assert.ok(!page.includes("Portable body"));
	assert.ok(page.includes("&lt;b&gt;Plain answer&lt;/b&gt;"));
	assert.ok(page.includes('/embed/ABCDEFGHIJK'));
	assert.ok(page.includes('href="/guides/shared/">Guide title'));
	assert.ok(page.includes(`rel="canonical" href="${PUBLIC_ORIGIN}/articles/shared/"`));
	assert.ok(page.includes('"articleSection":"Articles"'));
	assert.ok(page.includes('"publisher":{"@type":"Organization","name":"Example Studio"'));
	assert.ok(page.includes('"@type":"BreadcrumbList"'));
	const guidePage = await request("/guides/shared/");
	assert.equal(guidePage.status, 200);
	const guideHtml = await guidePage.text();
	assert.ok(guideHtml.includes(`rel="canonical" href="${PUBLIC_ORIGIN}/guides/shared/"`));
	assert.ok(guideHtml.includes("Division layout") && guideHtml.includes("Guide source") && !guideHtml.includes("Site call to action"));

	const changed = await api(entryPath, { method: "PUT", data: { _rev: read._rev, data: { video_id: null, related_guide: null } } });
	await api(entryPath, { method: "PUT", data: { _rev: read._rev, data: { body_html: "stale write" } }, status: 409 });
	await publish(api, entryPath, changed._rev);
	const cleared = await api(entryPath);
	assert.equal(cleared.item.data.body_html, source);
	assert.deepEqual(cleared.item.data.body, read.item.data.body);
	const clearedPage = await (await request("/articles/shared/")).text();
	assert.ok(clearedPage.includes(firstNode) && clearedPage.includes(rest) && !clearedPage.includes("Guide title") && !clearedPage.includes("/embed/ABCDEFGHIJK"));

	const relatedGuide = { url: "/guides/shared/", title: "Guide card title" };
	const answerBox = "<section id='answer-box'><h2>Short answer</h2><p>Answer from the original body</p></section>";
	const bodyGuideLink = `<p><a href="${PUBLIC_ORIGIN}/guides/shared?ref=article#details">Guide in the body</a></p>`;
	const duplicates = await create(api, "articles", "body-regions", {
		body_html: answerBox + bodyGuideLink, short_answer: "Answer from the field", related_guide: relatedGuide,
	});
	await publish(api, `/content/articles/${duplicates.item.id}`, duplicates._rev);
	const deduplicated = await request("/articles/body-regions/");
	assert.equal(deduplicated.status, 200);
	const deduplicatedPage = await deduplicated.text();
	assert.ok(deduplicatedPage.includes(answerBox) && deduplicatedPage.includes(bodyGuideLink));
	assert.ok(!deduplicatedPage.includes("Answer from the field") && !deduplicatedPage.includes("Guide card title"));

	const rejectedHtml = answerBox + bodyGuideLink + "<iframe srcdoc='<script>0</script>'></iframe>";
	const unsafe = await create(api, "articles", "unsafe", {
		body_html: rejectedHtml, short_answer: "Fallback answer", related_guide: relatedGuide,
	});
	await publish(api, `/content/articles/${unsafe.item.id}`, unsafe._rev);
	assert.equal((await api(`/content/articles/${unsafe.item.id}`)).item.data.body_html, rejectedHtml);
	const invalid = await request("/articles/unsafe/");
	assert.equal(invalid.status, 200);
	assert.match(invalid.headers.get("content-type"), /^text\/html/);
	const fallback = await invalid.text();
	assert.match(fallback, /<p>Portable body<\/p>/);
	assert.ok(fallback.includes("Fallback answer") && fallback.includes("Guide card title"));
	assert.ok(!fallback.includes("Answer from the original body") && !fallback.includes("Guide in the body") && !fallback.includes("srcdoc="));

	await api("/redirects", { method: "POST", data: { source: "/articles/shared/", type: 410 }, status: 201 });
	const gone = await request("/articles/shared/");
	assert.equal(gone.status, 410);
	assert.match(gone.headers.get("content-type"), /^text\/html/);
	const gonePage = await gone.text();
	assert.match(gonePage, /^<!doctype html>\s*<html\b/i);
	assert.match(gonePage, /This page has been removed/);
	const goneHead = await request("/articles/shared/", { method: "HEAD" });
	assert.equal(goneHead.status, 410);
	assert.equal(await goneHead.text(), "");
	await stop();

	const portable = await serve(plain);
	const portableSchema = await portable.api("/schema");
	assert.deepEqual(portableSchema.collections.find(({ slug }) => slug === "articles").fields.map(({ slug }) => slug), PORTABLE_FIELDS);
	const original = await create(portable.api, "articles", "plain", {});
	await publish(portable.api, `/content/articles/${original.item.id}`, original._rev);
	const portablePage = await portable.request("/articles/plain/");
	assert.equal(portablePage.status, 200);
	assert.match(await portablePage.text(), /<p>Portable body<\/p>/);
	console.log("Fresh article publishing passed for both profiles, including exact HTML, Portable Text fallback, region deduplication, revisions, canonical identity, drafts and native 410s.");
} catch (error) {
	console.error(output);
	throw error;
} finally {
	await stop();
	await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

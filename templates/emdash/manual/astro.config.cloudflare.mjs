// astro.config.mjs on Cloudflare Workers, with EmDash's article section.
// Keep the site's own settings and integrations; lines marked NEW are what
// EmDash needs. Requires Astro 7 (7.3.2 or later) and Node.js 22.16 or later
// (22.23.4 or later once the site uses Astro 7.4 or later).
import cloudflare from "@astrojs/cloudflare"; // NEW
import react from "@astrojs/react"; // NEW
import { d1, r2 } from "@emdash-cms/cloudflare"; // NEW
// import { access } from "@emdash-cms/cloudflare"; // NEW, with Cloudflare Access (below)
import { defineConfig } from "astro/config";
import emdash from "emdash/astro"; // NEW

export default defineConfig({
	// NEW if the site has no `site` yet: the production origin. Canonical, RSS
	// and sitemap URLs use it. Leave it out rather than set a placeholder.
	// site: "__SITE_URL__",
	// NEW: pages render on request so a published article appears without a
	// rebuild. Pages that should stay static declare `export const prerender = true`.
	output: "server",
	// NEW: the Workers adapter. "passthrough" serves images as stored, with no
	// Cloudflare Images binding or transform billing, until the site chooses transforms.
	adapter: cloudflare({ imageService: "passthrough" }),
	integrations: [
		// ...the site's existing integrations stay here.
		react(), // NEW: the EmDash admin is a React app.
		emdash({
			// NEW: D1 and R2 bindings, named as in wrangler.jsonc.
			database: d1({ binding: "DB", session: "auto", coalesce: true }),
			storage: r2({ binding: "MEDIA" }),
			// NEW: a deploy with pending core migrations answers 503 instead of
			// migrating on a visitor's request. Run `npx emdash migrate` before
			// `wrangler deploy`. Development keeps migrating on its own.
			migrations: { runtime: "check", dev: "auto" },
			// NEW: the MCP server at /_emdash/api/mcp. On by default; stated so it
			// is not turned off by accident, since writers may use it.
			mcp: true,
			// NEW: no plugin registry. With no `sandboxRunner` and no `sandboxed`
			// plugins, wrangler.jsonc needs no LOADER binding.
			registry: false,
			// NEW: the production origin for setup, passkeys and absolute URLs is
			// read from the EMDASH_SITE_URL variable in wrangler.jsonc. Do not set
			// `siteUrl` here: it is built into every preview deployment too.
			// NEW, only with Cloudflare Access in front of /_emdash: Access
			// replaces passkeys, and only people Access lets in reach the admin.
			// Uploaded media is served under /_emdash/api/media/file/ and must
			// stay public: give that path its own Access bypass. Keep the bucket
			// private; a public origin for it (publicUrl) would also serve the
			// backup archives EmDash stores there.
			// Set the audience with `npx wrangler secret put CF_ACCESS_AUDIENCE`.
			// auth: access({
			// 	teamDomain: "<team>.cloudflareaccess.com",
			// 	audienceEnvVar: "CF_ACCESS_AUDIENCE",
			// 	roleMapping: { Admins: 50, Editors: 40 },
			// }),
		}),
	],
});

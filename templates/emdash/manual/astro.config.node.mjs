// astro.config.mjs on Node.js, with EmDash's article section.
// Keep the site's own settings and integrations; lines marked NEW are what
// EmDash needs. Requires Astro 7 (7.3.2 or later) and Node.js 22.16 or later
// (22.23.4 or later once the site uses Astro 7.4 or later). If the site
// already uses another server adapter, keep it instead of adding this one.
import node from "@astrojs/node"; // NEW
import react from "@astrojs/react"; // NEW
import { defineConfig } from "astro/config";
import emdash, { local } from "emdash/astro"; // NEW
import { sqlite } from "emdash/db"; // NEW

export default defineConfig({
	// NEW if the site has no `site` yet: the production origin. Canonical, RSS
	// and sitemap URLs use it. Leave it out rather than set a placeholder.
	// site: "__SITE_URL__",
	// NEW: pages render on request so a published article appears without a
	// rebuild. Pages that should stay static declare `export const prerender = true`.
	output: "server",
	adapter: node({ mode: "standalone" }), // NEW
	integrations: [
		// ...the site's existing integrations stay here.
		react(), // NEW: the EmDash admin is a React app.
		emdash({
			// NEW: SQLite in data.db and media in uploads/, both git-ignored.
			database: sqlite({ url: "file:./data.db" }),
			storage: local({ directory: "./uploads", baseUrl: "/_emdash/api/media/file" }),
			// NEW: the MCP server at /_emdash/api/mcp, on by default.
			mcp: true,
			// NEW: no plugin registry and no sandbox runner.
			registry: false,
			// The production origin comes from EMDASH_SITE_URL in the server's
			// environment, set where `npm run build` runs and where the server runs.
		}),
	],
});

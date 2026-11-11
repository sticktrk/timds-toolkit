// The site's Astro configuration: EmDash on Cloudflare Workers, with its
// pages, layout and styles read from the Design System this site sits in.
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";

import designSystem from "./src/integrations/design-system.mjs";

export default defineConfig({
	// The Design System's dev server serves this site under /site and passes
	// that prefix here; a build for deployment runs without it, at /.
	base: process.env.TIMDS_SITE_BASE || "/",
	// The development port. The Design System's dev server passes a free one
	// when 4380 is taken; without it, as for `timds consumer preview`, the
	// site listens on 4380, preview.port in timds.consumer.json. strictPort
	// makes a taken port an error instead of a silent move to another one.
	server: { port: Number(process.env.TIMDS_SITE_PORT) || 4380 },
	vite: { server: { strictPort: true } },
	// Pages render on request so a published article appears without a
	// rebuild. The design's own pages do too, from HTML baked in at build
	// time: EmDash's middleware also runs while a page is prerendered, and a
	// build machine has no migrated database to answer it.
	output: "server",
	// "passthrough" serves images as stored, with no Cloudflare Images binding
	// or transform billing, until the site chooses transforms.
	adapter: cloudflare({ imageService: "passthrough" }),
	integrations: [
		// The EmDash admin is a React app.
		react(),
		emdash({
			// The bindings are named here and in wrangler.jsonc; whoever deploys
			// the Worker attaches the database and the bucket to them.
			database: d1({ binding: "DB", session: "auto", coalesce: true }),
			storage: r2({ binding: "MEDIA" }),
			// A deploy with pending core migrations answers 503 instead of
			// migrating on a visitor's request: run `npx emdash migrate` before
			// the Worker goes live. Development keeps migrating on its own.
			migrations: { runtime: "check", dev: "auto" },
			// The MCP server at /_emdash/api/mcp, for writers.
			mcp: true,
			// No plugin registry and no sandboxed plugins, so no LOADER binding.
			registry: false,
			// The production origin comes from the EMDASH_SITE_URL variable at
			// run time; it is never written into this file.
		}),
		// The website design the pages and the article shell come from, under
		// the Design System's src/designs/.
		designSystem({ design: "__DESIGN_ID__" }),
	],
	devToolbar: { enabled: false },
});

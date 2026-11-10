/**
 * Worker entry (`main` in wrangler.jsonc). It wraps Astro's handler with
 * EmDash's scheduled handler, which the cron trigger calls to publish
 * scheduled articles and run maintenance. PluginBridge is only used by
 * sandboxed plugins; EmDash documents it as harmless without them, and keeping
 * it lets `emdash doctor` recognize this entry.
 */
import handler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";

export { PluginBridge };

export default {
	...handler,
	scheduled: createScheduledHandler(),
} satisfies ExportedHandler;

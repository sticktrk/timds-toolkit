/**
 * Worker entry (`main` in wrangler.jsonc). It wraps Astro's handler with
 * EmDash's scheduled handler, which the cron trigger calls to publish
 * scheduled articles and run maintenance. PluginBridge is only used by
 * sandboxed plugins; EmDash documents it as harmless without them, and keeping
 * it lets `emdash doctor` recognize this entry.
 *
 * A platform that uploads the Worker may give it no Cron Trigger, so the same
 * work also runs on `POST /_scheduled` (under the site's base path), for a
 * caller that sends `Authorization: Bearer <SCHEDULED_TASKS_SECRET>`. The path
 * answers 404 to anything else, including every request while that secret is
 * unset, so it cannot be told apart from a missing page.
 */
import handler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";

import { drainContact, redriveContact } from "./lib/contact/delivery";
import { migrateContact, type ContactEnv } from "./lib/contact/runtime";

export { PluginBridge };

const runScheduled = createScheduledHandler();
const migrated = new WeakMap<D1Database, Promise<unknown>>();
function ensureContactSchema(env: ContactEnv) {
	const existing = migrated.get(env.DB);
	if (existing) return existing;
	const pending = migrateContact(env).catch((error) => { migrated.delete(env.DB); throw error; });
	migrated.set(env.DB, pending);
	return pending;
}

const SCHEDULED_PATH = `${import.meta.env.BASE_URL.replace(/\/+$/, "")}/_scheduled`;

const REDRIVE_PATH = `${SCHEDULED_PATH}/contact/redrive`;
type ScheduledEnv = ContactEnv & { SCHEDULED_TASKS_SECRET?: string };

async function digest(value: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/** Compares the two secrets through their SHA-256 digests, in time that does not depend on where they differ. */
async function sameSecret(given: string, expected: string): Promise<boolean> {
	const [left, right] = await Promise.all([digest(given), digest(expected)]);
	let difference = 0;
	for (let index = 0; index < left.length; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
	return difference === 0;
}

async function runScheduledRequest(request: Request, env: ScheduledEnv): Promise<Response> {
	const expected = env.SCHEDULED_TASKS_SECRET ?? "";
	const given = (request.headers.get("Authorization") ?? "").match(/^Bearer (.+)$/i)?.[1] ?? "";
	if (request.method !== "POST" || !expected || !(await sameSecret(given, expected))) {
		return new Response("Not found", { status: 404 });
	}
	if (new URL(request.url).pathname === REDRIVE_PATH) return redriveContact(env, request);
	const { runScheduledTasks } = await import("emdash/middleware");
	const [{ published }, jobs] = await Promise.all([
		runScheduledTasks(),
		drainContact(env, new URL(request.url).origin),
	]);
	return Response.json({ published: published.length, jobs }, { headers: { "Cache-Control": "no-store" } });
}

export default {
	...handler,
	async fetch(request, env, context) {
		const runtime = env as ScheduledEnv;
		if (import.meta.env.DEV || runtime.TIMDS_SITE_STAGING === "1" && runtime.EMDASH_MIGRATIONS_MODE === "auto") {
			await ensureContactSchema(runtime);
		}
		const path = new URL(request.url).pathname;
		if (path === SCHEDULED_PATH || path === REDRIVE_PATH) return runScheduledRequest(request, runtime);
		return handler.fetch!(request, env, context);
	},
	async scheduled(controller, env, context) {
		const runtime = env as ScheduledEnv;
		await Promise.all([
			runScheduled(controller, env, context),
			drainContact(runtime, new URL(runtime.EMDASH_SITE_URL || "http://localhost").origin),
		]);
	},
} satisfies ExportedHandler;

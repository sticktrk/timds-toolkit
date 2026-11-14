import { env } from "cloudflare:workers";

export function runtimeSiteUrl(): string | undefined {
	return (env as { EMDASH_SITE_URL?: string }).EMDASH_SITE_URL;
}

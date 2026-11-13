export function runtimeSiteUrl(): string | undefined {
	return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.EMDASH_SITE_URL;
}

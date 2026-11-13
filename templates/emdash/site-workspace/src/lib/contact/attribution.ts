export const TOUCH_MAX_AGE = 90 * 24 * 60 * 60 * 1000;
const CLICK_IDS = new Set(["gclid", "fbclid"]);
const CAMPAIGN_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
  "utm_source_platform", "utm_creative_format", "utm_marketing_tactic", "gclid", "fbclid",
]);

export type Touch = { url: string; referrer: string | null; at: string };

export function contactUrl(input: string | null, origin?: string, campaign = false, marketing = false) {
  if (!input || input.length > 2048 || /[\x00-\x20\x7f\\]/.test(input)) return null;
  try {
    const url = new URL(input);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || (origin && url.origin !== origin)) return null;
    const result = new URL(url.origin + url.pathname);
    if (campaign) {
      for (const [key, value] of url.searchParams) {
        if (CAMPAIGN_PARAMS.has(key) && (marketing || !CLICK_IDS.has(key)) && !result.searchParams.has(key) && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value)) {
          result.searchParams.set(key, value);
        }
      }
    }
    return result.href.length <= 2048 ? result.href : null;
  } catch {
    return null;
  }
}

export function readTouch(input: string | null, origin: string, now: number, marketing: boolean): Touch | null {
  if (!input || input.length > 5000) return null;
  try {
    const { url, referrer, at } = JSON.parse(input);
    if (typeof url !== "string" || typeof at !== "string") return null;
    const address = contactUrl(url, origin, true, marketing);
    const timestamp = Date.parse(at);
    if (!address || !Number.isFinite(timestamp) || timestamp > now + 60_000 || timestamp < now - TOUCH_MAX_AGE) return null;
    return { url: address, referrer: typeof referrer === "string" ? contactUrl(referrer) : null, at: new Date(timestamp).toISOString() };
  } catch {
    return null;
  }
}

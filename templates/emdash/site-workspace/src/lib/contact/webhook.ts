import type { ContactEnv } from "./runtime";

// This marker cannot match a destination revision, which is a SHA-256 hex digest.
export const UNBOUND_WEBHOOK_DESTINATION = "unbound";

const RESERVED_HEADERS = /^(?:accept-encoding|connection|content-(?:encoding|length|type)|cookie2?|expect|host|keep-alive|origin|referer|te|trailer|transfer-encoding|upgrade|via|(?:cf|proxy|sec)-.*)$/;

export async function webhookDestination(env: ContactEnv) {
  const address = env.TIMDS_CONTACT_WEBHOOK_URL;
  const header = env.TIMDS_CONTACT_WEBHOOK_HEADER?.toLowerCase();
  if (!address || address.length > 2048 || /[\x00-\x20\x7f\\#]/.test(address)
    || !header || !/^[a-z][a-z0-9-]{0,63}$/.test(header) || RESERVED_HEADERS.test(header)) return null;
  let url: URL;
  try { url = new URL(address); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.href.length > 2048) return null;
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([url.href, header])));
  const revision = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { endpoint: url.href, header, revision };
}

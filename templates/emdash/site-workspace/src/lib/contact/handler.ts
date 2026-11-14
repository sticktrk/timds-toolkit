import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { contactUrl, readTouch } from "./attribution";
import { browserTags, consentAllows, contact } from "./config";
import { contactDelivery, migrateContact, providerDelivery, publicContactOrigin, type ContactEnv } from "./runtime";
import { UNBOUND_WEBHOOK_DESTINATION, webhookDestination } from "./webhook";

const MAX_BODY = 24 * 1024;
const BUCKET_MS = 10 * 60_000;
const keyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = async (value: string) => new Uint8Array(
  await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
).reduce((hex, byte) => hex + byte.toString(16).padStart(2, "0"), "");

const response = (status: number, body: object, headers = {}) => Response.json(body, {
  status, headers: { "Cache-Control": "no-store", ...headers },
});

async function readFields(request: Request) {
  if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(request.headers.get("Content-Type") ?? "")) return null;
  if (!request.body || Number(request.headers.get("Content-Length")) > MAX_BODY) return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let data = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return new URLSearchParams(data + decoder.decode());
      size += value.byteLength;
      if (size > MAX_BODY) return null;
      data += decoder.decode(value, { stream: true });
    }
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function verifyTurnstile(runtime: ContactEnv, token: string, request: Request, ip: string, key: string) {
  if (!providerDelivery(runtime, new URL(request.url).origin)) return true;
  if (!runtime.TURNSTILE_SECRET_KEY) return !contact.turnstile.required;
  if (!token || token.length > 2048) return false;
  const result = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: new URLSearchParams({ secret: runtime.TURNSTILE_SECRET_KEY, response: token, idempotency_key: key, ...(ip ? { remoteip: ip } : {}) }),
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
  });
  if (!result.ok) throw new Error("Verification unavailable");
  const proof = await result.json<{ success: boolean; hostname: string; action: string }>();
  return proof.success === true && proof.hostname === new URL(request.url).hostname && proof.action === "contact";
}

type Receipt = { id: string; fingerprint: string; analytics: number; marketing: number };
function saved(receipt: Receipt, fingerprint: string) {
  return receipt.fingerprint === fingerprint
    ? response(200, { receipt: receipt.id, analytics: Boolean(receipt.analytics), marketing: Boolean(receipt.marketing) })
    : response(409, { error: "submission_conflict" });
}

// The hosted live proxy replaces the request URL with a loopback URL and
// supplies its public origin. Trust that origin only for same-origin browser
// requests in the mounted development preview.
function submissionOrigin(request: Request, url: URL) {
  if (import.meta.env.DEV && import.meta.env.BASE_URL.replace(/\/+$/, "") === "/site"
    && request.headers.get("Sec-Fetch-Site") === "same-origin") {
    const forwarded = request.headers.get("X-TimDS-Preview-Origin");
    if (forwarded) {
      try {
        const preview = new URL(forwarded);
        if (preview.protocol === "https:" && preview.origin === forwarded) return preview.origin;
      } catch {}
    }
  }
  return url.origin;
}

export const contactPost: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const runtime = env as unknown as ContactEnv;
  const requestOrigin = submissionOrigin(request, url);
  const publicOrigin = !import.meta.env.DEV && runtime.TIMDS_SITE_STAGING !== "1"
    ? publicContactOrigin(runtime) : null;
  if (request.headers.get("Origin") !== requestOrigin || request.headers.get("Sec-Fetch-Site") === "cross-site"
    || (publicOrigin && requestOrigin !== publicOrigin)) {
    return response(403, { error: "origin" });
  }
  const origin = publicOrigin ?? requestOrigin;
  const fields = await readFields(request);
  if (!fields || [...new Set(fields.keys())].some((key) => fields.getAll(key).length !== 1)) {
    return response(400, { error: "invalid_fields" });
  }
  const key = fields.get("submission_id")?.toLowerCase() ?? "";
  const name = fields.get("name")?.trim() ?? "";
  const email = fields.get("email")?.trim() || null;
  const phone = fields.get("phone")?.trim() || null;
  const message = fields.get("message")?.trim() ?? "";
  const analyticsChoice = fields.get("analytics_consent");
  const marketingChoice = fields.get("marketing_consent");
  const consent = (choice: string | null) => Number(consentAllows(choice === null ? undefined : choice === "yes", contact.requireConsent));
  const analytics = consent(analyticsChoice);
  const marketing = consent(marketingChoice);
  if ([analyticsChoice, marketingChoice].some((choice) => choice !== null && choice !== "yes" && choice !== "no")
    || !keyPattern.test(key) || !name || name.length > 160 || /[\x00-\x1f\x7f]/.test(name)
    || (!email && !phone) || (email && (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)))
    || (phone && (phone.length > 64 || !/^[+0-9(). #*;x-]+$/i.test(phone) || !/\d{3}/.test(phone.replace(/\D/g, ""))))
    || message.length > 4000 || message.includes("\0")) {
    return response(400, { error: "invalid_fields" });
  }

  const db = runtime.DB;
  try {
    if (import.meta.env.DEV) await migrateContact(runtime);
    const now = Date.now();
    const submittedForm = fields.get("form_id");
    const formId = submittedForm && /^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(submittedForm) ? submittedForm : url.pathname;
    const fingerprint = await digest(JSON.stringify([name, email, phone, message, analytics, marketing, formId]));
    const receipt = db.prepare("SELECT id, fingerprint, analytics, marketing FROM timds_contact_leads WHERE request_key = ?").bind(key);
    const existing = await receipt.first<Receipt>();
    if (existing) return saved(existing, fingerprint);

    const ip = request.headers.get("CF-Connecting-IP") ?? "";
    const bucket = Math.floor(now / BUCKET_MS);
    const client = await digest(JSON.stringify([bucket, ip]));
    const rate = await db.prepare(`INSERT INTO timds_contact_attempts (client, bucket, attempts) VALUES (?, ?, 1)
      ON CONFLICT(client, bucket) DO UPDATE SET attempts = attempts + 1 WHERE attempts < 12 RETURNING attempts`)
      .bind(client, bucket).first();
    if (!rate) return response(429, { error: "rate_limit" }, { "Retry-After": String(Math.ceil(((bucket + 1) * BUCKET_MS - now) / 1000)) });
    if (!await verifyTurnstile(runtime, fields.get("cf-turnstile-response") ?? "", request, ip, key)) {
      const replay = await receipt.first<Receipt>();
      return replay ? saved(replay, fingerprint) : response(400, { error: "verification" });
    }

    const id = crypto.randomUUID();
    const mode = contactDelivery(runtime, requestOrigin);
    const pageUrl = contactUrl(fields.get("page_url"), origin)
      ?? contactUrl(request.headers.get("Referer"), origin) ?? contactUrl(origin + url.pathname, origin);
    if (!pageUrl) return response(400, { error: "invalid_fields" });
    const attribution = mode === "production" && analytics && contact.attribution;
    const referrer = attribution ? contactUrl(fields.get("referrer")) : null;
    const touch = (field: string) => attribution ? readTouch(fields.get(field), origin, now, Boolean(marketing)) : null;
    const firstTouch = touch("first_touch");
    const lastTouch = touch("last_touch");
    const { from, to, subject } = contact.notification;
    const pixel = browserTags().pixel;
    const notification = mode === "production" && from && to
      ? { from, to: [to], subject, ...(email ? { reply_to: email } : {}), text: [name, email, phone, message].filter(Boolean).join("\n\n") }
      : null;
    const enqueue = (provider: string, payload: object, destination: string | null = null) => {
      const unbound = destination === UNBOUND_WEBHOOK_DESTINATION;
      return db.prepare(`INSERT INTO timds_contact_jobs
        (id, lead_id, provider, payload, due_at, destination_revision, status, failure)
        SELECT ?, id, ?, ?, ?, ?, ?, ? FROM timds_contact_leads WHERE id = ?`)
        .bind(`${provider}/${id}`, provider, JSON.stringify(payload), now, destination,
          unbound ? "failed" : "pending", unbound ? "destination_unconfigured" : null, id);
    };
    const statements = [db.prepare(`INSERT INTO timds_contact_leads
      (id, request_key, fingerprint, name, email, phone, message, analytics, marketing, created_at, page_url, form_id, referrer, first_touch, last_touch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(request_key) DO NOTHING`)
      .bind(id, key, fingerprint, name, email, phone, message, analytics, marketing, now, pageUrl, formId, referrer,
        firstTouch && JSON.stringify(firstTouch), lastTouch && JSON.stringify(lastTouch))];
    if (mode === "production") {
      const destination = await webhookDestination(runtime);
      const webhookConfigured = runtime.TIMDS_CONTACT_WEBHOOK_URL || runtime.TIMDS_CONTACT_WEBHOOK_HEADER
        || runtime.TIMDS_CONTACT_WEBHOOK_SECRET;
      if (webhookConfigured) statements.push(enqueue("webhook", {
        submission_id: key,
        pageUrl,
        submittedAt: new Date(now).toISOString(),
        formId,
        referrer,
        fields: { fullName: name, email, phone, message },
        meta: { first_touch: firstTouch, last_touch: lastTouch },
      }, destination?.revision ?? UNBOUND_WEBHOOK_DESTINATION));
    }
    if (mode === "test" || notification) statements.push(enqueue(notification ? "resend" : "test-resend", notification ?? {}));
    if (marketing && (mode === "test" || (pixel && /^v\d+\.\d+$/.test(contact.meta.graphVersion)))) {
      const em = email ? [await digest(email.toLowerCase())] : undefined;
      const ph = phone ? [await digest(phone.replace(/\D/g, ""))] : undefined;
      const userAgent = request.headers.get("User-Agent")?.slice(0, 512) || "";
      statements.push(enqueue(mode === "test" ? "test-meta" : "meta", mode === "test" ? {} : {
        pixel, version: contact.meta.graphVersion,
        body: {
          data: [{
            event_name: "Lead", event_id: id, event_time: Math.floor(now / 1000), action_source: "website",
            event_source_url: pageUrl, user_data: { em, ph, client_user_agent: userAgent },
          }],
          ...(contact.meta.testEventCode ? { test_event_code: contact.meta.testEventCode } : {}),
        },
      }));
    }
    const results = await db.batch<Receipt>([...statements, receipt]);
    return saved(results.at(-1)!.results[0]!, fingerprint);
  } catch {
    return response(503, { error: "contact_unavailable" });
  }
};

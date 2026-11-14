import { contact } from "./config";
import { providerDelivery, type ContactEnv } from "./runtime";
import { UNBOUND_WEBHOOK_DESTINATION, webhookDestination } from "./webhook";

const MAX_ATTEMPTS = 8;
const WEBHOOK_ATTEMPTS = 16;
const WEBHOOK_TIMEOUT = 8_000;
const WEBHOOK_ACK_BYTES = 8192;
const WEBHOOK_BACKOFF = 5 * 60_000;
const WEBHOOK_BACKOFF_CAP = 6 * 60 * 60_000;
const webhookFailures = new Set([
  "destination_changed", "destination_unconfigured", "missing_credential", "provider_unavailable", "provider_rejected",
  "invalid_acknowledgment", "redirect", "retry_limit",
]);
type DeliveryResult = { status: "sent" | "pending" | "failed"; failure?: string; deferred?: boolean };
const EMAIL_WINDOW = 23 * 60 * 60_000;
const META_WINDOW = 47 * 60 * 60_000;
const windowFor = (provider: string) => provider === "resend" ? EMAIL_WINDOW : META_WINDOW;

type Job = {
  id: string;
  provider: string;
  payload: string;
  attempts: number;
  first_attempt: number;
  created_at: number;
  destination_revision: string | null;
};

async function acknowledged(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return false;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let body = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return JSON.parse(body + decoder.decode())?.accepted === true;
      bytes += value.byteLength;
      if (bytes > WEBHOOK_ACK_BYTES) return false;
      body += decoder.decode(value, { stream: true });
    }
  } catch {
    return false;
  } finally {
    void reader.cancel().catch(() => {});
  }
}

async function deliverWebhook(env: ContactEnv, job: Job): Promise<DeliveryResult> {
  const destination = await webhookDestination(env);
  if (!destination) return { status: "pending", failure: "destination_unconfigured", deferred: true };
  if (destination.revision !== job.destination_revision) {
    return { status: "failed", failure: "destination_changed" };
  }
  const secret = env.TIMDS_CONTACT_WEBHOOK_SECRET;
  if (!secret) return { status: "pending", failure: "missing_credential", deferred: true };
  try {
    const response = await fetch(destination.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", [destination.header]: secret },
      body: job.payload,
      redirect: "manual",
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT),
    });
    if (response.ok) {
      return await acknowledged(response) ? { status: "sent" } : { status: "pending", failure: "invalid_acknowledgment" };
    }
    void response.body?.cancel().catch(() => {});
    const failure = response.status >= 300 && response.status < 400 ? "redirect"
      : response.status >= 500 || response.status === 429 ? "provider_unavailable" : "provider_rejected";
    return { status: "pending", failure };
  } catch {
    return { status: "pending", failure: "provider_unavailable" };
  }
}

async function deliver(env: ContactEnv, job: Job): Promise<DeliveryResult> {
  if (job.provider === "webhook") return deliverWebhook(env, job);
  if (job.provider.startsWith("test-")) return { status: "sent" };
  const resend = job.provider === "resend";
  const token = resend ? env.RESEND_API_KEY : env.META_CAPI_ACCESS_TOKEN;
  if (!token) return { status: "failed", failure: "missing_credential" };

  const meta = resend ? null : JSON.parse(job.payload);
  const endpoint = resend ? "https://api.resend.com/emails" : `https://graph.facebook.com/${meta.version}/${meta.pixel}/events`;
  try {
    const result = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(resend ? { "Idempotency-Key": job.id } : {}),
      },
      body: resend ? job.payload : JSON.stringify(meta.body),
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    });
    if (result.ok && !resend) {
      const receipt = await result.json<{ events_received?: number }>();
      return receipt.events_received === 1 ? { status: "sent" } : { status: "failed", failure: "provider_rejected" };
    }
    const retry = result.status === 429 || result.status >= 500 || resend && result.status === 409;
    await result.body?.cancel().catch(() => {});
    if (result.ok) return { status: "sent" };
    return { status: retry ? "pending" : "failed", failure: retry ? "provider_unavailable" : "provider_rejected" };
  } catch {
    return { status: "pending", failure: "provider_unavailable" };
  }
}

export async function drainContact(env: ContactEnv, origin: string) {
  const db = env.DB;
  const now = Date.now();
  const enabled = providerDelivery(env, origin) && contact.delivery === "production";
  await db.prepare("DELETE FROM timds_contact_attempts WHERE bucket < ?").bind(Math.floor(now / 600_000) - 1).run();
  // Claim with a lease in one statement. An interrupted tick leaves the job eligible
  // again, with the same provider id and payload.
  const lease = crypto.randomUUID();
  const { results: jobs } = await db.prepare(`UPDATE timds_contact_jobs SET status = 'sending',
    lease = ?, due_at = ?, attempts = attempts + 1, first_attempt = COALESCE(first_attempt, ?)
    WHERE id IN (SELECT id FROM timds_contact_jobs WHERE status IN ('pending', 'sending') AND due_at <= ?
      AND (? = 1 OR provider IN ('test-resend', 'test-meta')) ORDER BY due_at LIMIT 8)
    RETURNING id, provider, payload, attempts, first_attempt, destination_revision, (SELECT created_at FROM timds_contact_leads WHERE id = lead_id) AS created_at`).bind(lease, now + 120_000, now, now, Number(enabled)).all<Job>();
  await Promise.all(jobs.map(async (job) => {
    const webhook = job.provider === "webhook";
    const expires = webhook ? Infinity : (job.provider === "meta" ? job.created_at : job.first_attempt) + windowFor(job.provider);
    const limit = webhook ? WEBHOOK_ATTEMPTS : MAX_ATTEMPTS;
    const expired = Date.now() + 8000 >= expires;
    const result: DeliveryResult = expired || job.attempts > limit
      ? { status: "failed", failure: expired ? "retry_window_expired" : "retry_limit" }
      : await deliver(env, job);
    const completedAt = Date.now();
    const due = completedAt + (webhook
      ? Math.min(WEBHOOK_BACKOFF * 2 ** (job.attempts - 1), WEBHOOK_BACKOFF_CAP)
      : Math.min(60_000 * 2 ** (job.attempts - 1), 60 * 60_000));
    const exhausted = result.status === "pending" && !result.deferred && (job.attempts >= limit || due + 8000 >= expires);
    const failure = exhausted && !webhook ? (job.attempts >= limit ? "retry_limit" : "retry_window_expired") : result.failure;
    await db.prepare(`UPDATE timds_contact_jobs SET status = ?, failure = ?, due_at = ?, lease = NULL, delivered_at = ?, attempts = attempts - ?
      WHERE id = ? AND lease = ?`).bind(exhausted ? "failed" : result.status, failure ?? null, due,
      result.status === "sent" ? completedAt : null, Number(result.deferred ?? false), job.id, lease).run();
  }));
  return jobs.length;
}

export async function redriveContact(env: ContactEnv, request: Request) {
  const id = new URL(request.url).searchParams.get("job") ?? "";
  if (!/^(?:resend|meta|test-resend|test-meta|webhook)\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) return new Response(null, { status: 400 });
  const now = Date.now();
  if (id.startsWith("webhook/")) {
    const destination = await webhookDestination(env);
    if (!providerDelivery(env, new URL(request.url).origin) || contact.delivery !== "production"
      || !destination || !env.TIMDS_CONTACT_WEBHOOK_SECRET) return new Response(null, { status: 409 });
    const job = await env.DB.prepare(`UPDATE timds_contact_jobs SET status = 'pending', attempts = 0,
      due_at = ?, failure = NULL, destination_revision = ? WHERE id = ? AND provider = 'webhook' AND status = 'failed'
      AND (destination_revision = ? OR (destination_revision = ? AND failure = 'destination_unconfigured')) RETURNING id`)
      .bind(now, destination.revision, id, destination.revision, UNBOUND_WEBHOOK_DESTINATION).first();
    return new Response(null, { status: job ? 202 : 409, headers: { "Cache-Control": "no-store" } });
  }
  // Keep the original idempotency clock, even after an explicit redrive.
  const job = await env.DB.prepare(`UPDATE timds_contact_jobs SET status = 'pending', attempts = 0,
    due_at = ?, failure = NULL WHERE id = ? AND status = 'failed'
    AND (CASE WHEN provider = 'meta' THEN (SELECT created_at FROM timds_contact_leads WHERE id = lead_id) ELSE first_attempt END) > ? RETURNING id`).bind(now, id, now + 8000 - windowFor(id.split("/")[0])).first();
  return new Response(null, { status: job ? 202 : 409, headers: { "Cache-Control": "no-store" } });
}


export async function contactStatus(env: ContactEnv) {
  type Summary = { pending: number; failed: number; oldest: number | null; lastSuccessAt: number | null };
  type FailedJob = { id: string; failure: string | null };
  const db = env.DB;
  const [summary, failedJobs] = await Promise.all([
    db.prepare(`SELECT
      (SELECT COUNT(*) FROM timds_contact_jobs WHERE provider = 'webhook' AND status IN ('pending', 'sending')) AS pending,
      (SELECT COUNT(*) FROM timds_contact_jobs WHERE provider = 'webhook' AND status = 'failed') AS failed,
      (SELECT MIN(l.created_at) FROM timds_contact_jobs j JOIN timds_contact_leads l ON j.lead_id = l.id
        WHERE j.provider = 'webhook' AND j.status IN ('pending', 'sending')) AS oldest,
      (SELECT MAX(delivered_at) FROM timds_contact_jobs WHERE provider = 'webhook') AS lastSuccessAt`).first<Summary>(),
    db.prepare(`SELECT id, failure FROM timds_contact_jobs WHERE provider = 'webhook' AND status = 'failed'
      ORDER BY due_at DESC, id LIMIT 20`).all<FailedJob>(),
  ]);
  return Response.json({
    pending: summary?.pending ?? 0,
    failed: summary?.failed ?? 0,
    oldestPendingAgeMs: summary?.oldest == null ? null : Math.max(0, Date.now() - summary.oldest),
    lastSuccessAt: summary?.lastSuccessAt == null ? null : new Date(summary.lastSuccessAt).toISOString(),
    failedJobs: failedJobs.results.map(({ id, failure }) => ({ id, failure: failure && webhookFailures.has(failure) ? failure : "unknown" })),
  }, { headers: { "Cache-Control": "no-store" } });
}

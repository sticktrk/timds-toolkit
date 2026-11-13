import { contact } from "./config";
import { providerDelivery, type ContactEnv } from "./runtime";

const MAX_ATTEMPTS = 8;
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
};

async function deliver(env: ContactEnv, job: Job) {
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
    RETURNING id, provider, payload, attempts, first_attempt, (SELECT created_at FROM timds_contact_leads WHERE id = lead_id) AS created_at`).bind(lease, now + 120_000, now, now, Number(enabled)).all<Job>();
  await Promise.all(jobs.map(async (job) => {
    const expires = (job.provider === "meta" ? job.created_at : job.first_attempt) + windowFor(job.provider);
    const expired = Date.now() + 8000 >= expires;
    const result = expired || job.attempts > MAX_ATTEMPTS
      ? { status: "failed", failure: expired ? "retry_window_expired" : "retry_limit" }
      : await deliver(env, job);
    const due = Date.now() + Math.min(60_000 * 2 ** (job.attempts - 1), 60 * 60_000);
    const exhausted = result.status === "pending" && (job.attempts >= MAX_ATTEMPTS || due + 8000 >= expires);
    await db.prepare(`UPDATE timds_contact_jobs SET status = ?, failure = ?, due_at = ?, lease = NULL
      WHERE id = ? AND lease = ?`).bind(exhausted ? "failed" : result.status,
      exhausted ? (job.attempts >= MAX_ATTEMPTS ? "retry_limit" : "retry_window_expired") : result.failure ?? null,
      due, job.id, lease).run();
  }));
  return jobs.length;
}

export async function redriveContact(env: ContactEnv, request: Request) {
  const id = new URL(request.url).searchParams.get("job") ?? "";
  if (!/^(?:resend|meta|test-resend|test-meta)\/[a-f0-9-]{36}$/.test(id)) return new Response(null, { status: 400 });
  const now = Date.now();
  // Keep the original idempotency clock, even after an explicit redrive.
  const job = await env.DB.prepare(`UPDATE timds_contact_jobs SET status = 'pending', attempts = 0,
    due_at = ?, failure = NULL WHERE id = ? AND status = 'failed'
    AND (CASE WHEN provider = 'meta' THEN (SELECT created_at FROM timds_contact_leads WHERE id = lead_id) ELSE first_attempt END) > ? RETURNING id`).bind(now, id, now + 8000 - windowFor(id.split("/")[0])).first();
  return new Response(null, { status: job ? 202 : 409, headers: { "Cache-Control": "no-store" } });
}

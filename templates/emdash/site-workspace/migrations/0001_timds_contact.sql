CREATE TABLE IF NOT EXISTS timds_contact_leads (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  message TEXT NOT NULL,
  analytics INTEGER NOT NULL,
  marketing INTEGER NOT NULL,
  page_url TEXT NOT NULL,
  form_id TEXT NOT NULL,
  referrer TEXT,
  first_touch TEXT,
  last_touch TEXT,
  created_at INTEGER NOT NULL,
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS timds_contact_attempts (
  client TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  PRIMARY KEY (client, bucket)
);

CREATE TABLE IF NOT EXISTS timds_contact_jobs (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES timds_contact_leads(id),
  provider TEXT NOT NULL CHECK (provider IN ('resend', 'meta', 'test-resend', 'test-meta', 'webhook')),
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  due_at INTEGER NOT NULL,
  first_attempt INTEGER,
  lease TEXT,
  failure TEXT,
  destination_revision TEXT,
  delivered_at INTEGER,
  CHECK ((provider = 'webhook') = (destination_revision IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS timds_contact_jobs_due ON timds_contact_jobs (status, due_at);

CREATE INDEX IF NOT EXISTS timds_contact_jobs_provider_status ON timds_contact_jobs (provider, status, due_at);
CREATE INDEX IF NOT EXISTS timds_contact_jobs_provider_delivered ON timds_contact_jobs (provider, delivered_at);

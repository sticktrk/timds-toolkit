CREATE TABLE IF NOT EXISTS timds_contact_leads (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  message TEXT NOT NULL,
  analytics INTEGER NOT NULL,
  marketing INTEGER NOT NULL,
  created_at INTEGER NOT NULL
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
  provider TEXT NOT NULL CHECK (provider IN ('resend', 'meta', 'test-resend', 'test-meta')),
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  due_at INTEGER NOT NULL,
  first_attempt INTEGER,
  lease TEXT,
  failure TEXT
);

CREATE INDEX IF NOT EXISTS timds_contact_jobs_due ON timds_contact_jobs (status, due_at);

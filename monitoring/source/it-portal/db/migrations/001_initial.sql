CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TABLE documents (
 kind text NOT NULL, id text NOT NULL, revision bigint NOT NULL DEFAULT 1,
 body jsonb NOT NULL, search_text text NOT NULL DEFAULT '',
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(kind,id),
 CHECK (jsonb_typeof(body)='object')
);
CREATE INDEX documents_search_trgm ON documents USING gin(search_text gin_trgm_ops) WHERE kind='resource';
CREATE INDEX documents_search_fts ON documents USING gin(to_tsvector('russian',search_text)) WHERE kind='resource';
CREATE TABLE sessions (
 token_hash text PRIMARY KEY, user_id text NOT NULL, user_name text NOT NULL,
 admin boolean NOT NULL, csrf text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE oidc_states (
 state_hash text PRIMARY KEY, verifier text NOT NULL, nonce text NOT NULL,
 browser_hash text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE jobs (
 id text PRIMARY KEY, idempotency_key text NOT NULL, actor text NOT NULL,
 fingerprint text NOT NULL, kind text NOT NULL, target text NOT NULL,
 status text NOT NULL CHECK(status IN('queued','running','succeeded','failed','unknown')),
 body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 started_at timestamptz, finished_at timestamptz,
 UNIQUE(actor,idempotency_key)
);
CREATE UNIQUE INDEX jobs_active_target ON jobs(target) WHERE status IN('queued','running') AND kind='restart';
CREATE TABLE import_plans (
 token text PRIMARY KEY, actor text NOT NULL, body jsonb NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE audit_events (
 id text PRIMARY KEY, body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE events (
 id text PRIMARY KEY, body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);

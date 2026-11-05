-- Separate from JSON documents, jobs and audit payloads; values are AEAD envelopes.
CREATE TABLE integration_credentials (
    integration_id text PRIMARY KEY CHECK (length(integration_id) BETWEEN 1 AND 256),
    origin text NOT NULL CHECK (length(origin) BETWEEN 1 AND 2048),
    approved_ips text[] NOT NULL CHECK (cardinality(approved_ips) BETWEEN 1 AND 32 AND array_position(approved_ips, NULL) IS NULL),
    envelope bytea NOT NULL CHECK (octet_length(envelope) BETWEEN 1 AND 8192),
    created_at timestamptz NOT NULL DEFAULT now()
);

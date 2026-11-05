-- Native Portal candidate only. No external receiver accounts or secrets.
CREATE TABLE sftp_collections (
 id uuid PRIMARY KEY, branch text NOT NULL, label text NOT NULL,
 folder text NOT NULL UNIQUE, quota_bytes bigint NOT NULL CHECK(quota_bytes>0),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sftp_collection_readers (
 collection_id uuid NOT NULL REFERENCES sftp_collections(id), user_id text NOT NULL, PRIMARY KEY(collection_id,user_id)
);
CREATE TABLE sftp_accounts (
 id uuid PRIMARY KEY, username text NOT NULL UNIQUE, label text NOT NULL,
 quota_bytes bigint NOT NULL CHECK(quota_bytes>0), enabled boolean NOT NULL
);
CREATE TABLE sftp_account_collections (
 account_id uuid NOT NULL REFERENCES sftp_accounts(id) ON DELETE CASCADE,
 collection_id uuid NOT NULL REFERENCES sftp_collections(id), PRIMARY KEY(account_id,collection_id)
);
CREATE TABLE sftp_versions (
 id uuid PRIMARY KEY, collection_id uuid NOT NULL REFERENCES sftp_collections(id),
 filename text NOT NULL, size_bytes bigint NOT NULL CHECK(size_bytes>0),
 sha256 text NOT NULL CHECK(length(sha256)=64), received_at timestamptz NOT NULL DEFAULT now(),
 received_by text NOT NULL, received_by_name text NOT NULL, source text NOT NULL CHECK(source='test'),
 content bytea NOT NULL CHECK(octet_length(content)<=8388608),
 UNIQUE(collection_id,sha256)
);
CREATE INDEX sftp_versions_received ON sftp_versions(received_at DESC);
CREATE TABLE sftp_version_seen (
 version_id uuid NOT NULL REFERENCES sftp_versions(id), user_id text NOT NULL,
 seen_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(version_id,user_id)
);
CREATE TABLE sftp_access_audit (
 id bigserial PRIMARY KEY, action text NOT NULL, actor text NOT NULL, actor_name text NOT NULL, details jsonb NOT NULL DEFAULT '{}'::jsonb,
 occurred_at timestamptz NOT NULL DEFAULT now(), collection_id text NOT NULL DEFAULT '', version_id text NOT NULL DEFAULT ''
);
CREATE INDEX sftp_audit_time ON sftp_access_audit(occurred_at DESC);
-- Received versions and module audit are append-only at application and DB level.
CREATE FUNCTION sftp_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'append-only SFTP record'; END;
$$;
CREATE TRIGGER sftp_versions_immutable BEFORE UPDATE OR DELETE ON sftp_versions FOR EACH ROW EXECUTE FUNCTION sftp_reject_mutation();
CREATE TRIGGER sftp_audit_immutable BEFORE UPDATE OR DELETE ON sftp_access_audit FOR EACH ROW EXECUTE FUNCTION sftp_reject_mutation();

ALTER TABLE sftp_collections ADD COLUMN revision bigint NOT NULL DEFAULT 1,
 ADD COLUMN applied_revision bigint NOT NULL DEFAULT 0,
 ADD COLUMN provisioning_error text NOT NULL DEFAULT '',
 ADD COLUMN last_applied_at timestamptz;
ALTER TABLE sftp_accounts ADD COLUMN public_keys text[] NOT NULL DEFAULT '{}',
 ADD COLUMN revision bigint NOT NULL DEFAULT 1,
 ADD COLUMN applied_revision bigint NOT NULL DEFAULT 0,
 ADD COLUMN provisioning_error text NOT NULL DEFAULT '',
 ADD COLUMN last_applied_at timestamptz;
ALTER TABLE sftp_versions ALTER COLUMN content DROP NOT NULL;
ALTER TABLE sftp_versions DROP CONSTRAINT sftp_versions_source_check;
ALTER TABLE sftp_versions ADD CONSTRAINT sftp_versions_source_check CHECK(source IN ('test','sftpgo'));
ALTER TABLE sftp_versions DROP CONSTRAINT sftp_versions_collection_id_sha256_key;
CREATE UNIQUE INDEX sftp_test_content_identity ON sftp_versions(collection_id,sha256) WHERE source='test';
ALTER TABLE sftp_versions ADD COLUMN provider_path text, ADD COLUMN provider_event_key text UNIQUE;
CREATE UNIQUE INDEX sftp_receiver_path_identity ON sftp_versions(provider_path) WHERE source='sftpgo';
ALTER TABLE sftp_versions ADD CONSTRAINT sftp_payload_storage CHECK((source='test' AND content IS NOT NULL) OR (source='sftpgo' AND content IS NULL AND provider_path IS NOT NULL AND provider_event_key IS NOT NULL));
CREATE TABLE sftp_provider_state (
 id boolean PRIMARY KEY DEFAULT true CHECK(id), last_attempt_at timestamptz,
 last_success_at timestamptz, error text NOT NULL DEFAULT '', cursor_timestamp bigint NOT NULL DEFAULT 0
);
INSERT INTO sftp_provider_state(id) VALUES(true);

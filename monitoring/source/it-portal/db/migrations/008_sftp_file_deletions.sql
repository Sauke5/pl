-- File lifecycle is separate from immutable received-upload facts and audit.
CREATE TABLE sftp_version_deletions (
 version_id uuid PRIMARY KEY REFERENCES sftp_versions(id),
 state text NOT NULL CHECK(state IN ('pending','deleted','failed','uncertain')),
 actor text NOT NULL,
 requested_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 deleted_at timestamptz,
 error text NOT NULL DEFAULT '',
 CHECK((state='deleted') = (deleted_at IS NOT NULL))
);
-- Historical paths are not generations. Only an active claim owns a live file.
CREATE TABLE sftp_active_files (
 provider_path text PRIMARY KEY,
 version_id uuid NOT NULL UNIQUE REFERENCES sftp_versions(id)
);
INSERT INTO sftp_active_files(provider_path,version_id)
 SELECT provider_path,id FROM sftp_versions WHERE source='sftpgo';
DROP INDEX sftp_receiver_path_identity;
CREATE INDEX sftp_receiver_path_history ON sftp_versions(provider_path) WHERE source='sftpgo';

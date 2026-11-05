-- Preserve all existing upload-only accounts; reader accounts carry no write budget.
ALTER TABLE sftp_accounts ADD COLUMN kind text NOT NULL DEFAULT 'sender'
 CHECK(kind IN ('sender','receiver'));
ALTER TABLE sftp_accounts DROP CONSTRAINT sftp_accounts_quota_bytes_check;
ALTER TABLE sftp_accounts ADD CONSTRAINT sftp_accounts_quota_mode
 CHECK((kind='sender' AND quota_bytes>0) OR (kind='receiver' AND quota_bytes=0));

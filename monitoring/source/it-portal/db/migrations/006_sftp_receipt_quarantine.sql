-- Untrusted filenames or contradictory immutable receipt identities must not
-- block unrelated branches. Keep dead letters without storing file payloads.
CREATE TABLE sftp_receipt_rejections (
 event_key text PRIMARY KEY, reason text NOT NULL,
 source_timestamp bigint NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER sftp_rejections_immutable BEFORE UPDATE OR DELETE ON sftp_receipt_rejections FOR EACH ROW EXECUTE FUNCTION sftp_reject_mutation();

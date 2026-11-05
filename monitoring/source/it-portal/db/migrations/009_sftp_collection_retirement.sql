-- Internal retirement preserves immutable upload facts and audit history.
-- No public mutation route exposes this field.
ALTER TABLE sftp_collections ADD COLUMN retired_at timestamptz;

-- Preserve the legacy event bodies and consumers. Arrival transaction identity
-- lets a frozen journal snapshot distinguish late commits from already loaded rows.
ALTER TABLE events ADD COLUMN arrival_tx xid8 NOT NULL DEFAULT '0'::xid8;
ALTER TABLE audit_events ADD COLUMN arrival_tx xid8 NOT NULL DEFAULT '0'::xid8;
ALTER TABLE events ALTER COLUMN arrival_tx SET DEFAULT pg_current_xact_id();
ALTER TABLE audit_events ALTER COLUMN arrival_tx SET DEFAULT pg_current_xact_id();
-- Legacy marker 0 is visible in all snapshots. The constant default avoids a
-- volatile-default table rewrite; occurrence backfill/indexes still require locks.
ALTER TABLE events ADD COLUMN occurred_at timestamptz;
ALTER TABLE audit_events ADD COLUMN occurred_at timestamptz;

CREATE FUNCTION event_journal_time(payload jsonb, fallback_time timestamptz)
RETURNS timestamptz LANGUAGE plpgsql STABLE AS $$
DECLARE value timestamptz;
BEGIN
  IF payload #>> '{details,time_basis}' = 'source' THEN
    BEGIN
      value := (payload #>> '{details,occurred_at}')::timestamptz;
      IF value IS NOT NULL AND isfinite(value) THEN RETURN value; END IF;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
      NULL;
    END;
  END IF;
  BEGIN
    value := (payload ->> 'created_at')::timestamptz;
    IF value IS NOT NULL AND isfinite(value) THEN RETURN value; END IF;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    NULL;
  END;
  RETURN fallback_time;
END $$;

UPDATE events SET occurred_at=event_journal_time(body,created_at);
UPDATE audit_events SET occurred_at=event_journal_time(body,created_at);
ALTER TABLE events ALTER COLUMN occurred_at SET NOT NULL;
ALTER TABLE audit_events ALTER COLUMN occurred_at SET NOT NULL;
CREATE FUNCTION event_journal_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.occurred_at := event_journal_time(NEW.body,NEW.created_at);
  RETURN NEW;
END $$;
CREATE TRIGGER event_journal_insert BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION event_journal_insert();
CREATE TRIGGER audit_journal_insert BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION event_journal_insert();
CREATE INDEX events_journal_order ON events(occurred_at DESC,id DESC);
CREATE INDEX audit_journal_order ON audit_events(occurred_at DESC,id DESC);
CREATE INDEX events_journal_resource ON events((body->>'resource_id'),occurred_at DESC);
CREATE INDEX audit_journal_resource ON audit_events((body->>'resource_id'),occurred_at DESC);

CREATE TABLE event_journal_readers (
  user_id text PRIMARY KEY,
  baseline pg_snapshot NOT NULL DEFAULT pg_current_snapshot(),
  initialized_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE event_journal_seen (
  user_id text NOT NULL REFERENCES event_journal_readers(user_id),
  channel text NOT NULL CHECK(channel IN ('events','audit')),
  event_id text NOT NULL,
  seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,channel,event_id)
);

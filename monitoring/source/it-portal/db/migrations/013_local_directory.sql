-- Local Pl identities have their own provider namespace. They never enter the
-- AD organization tables or acquire AD object GUIDs or department-head rights.
CREATE TABLE pl_local_directory_accounts (
 subject text PRIMARY KEY CHECK(subject='local-admin' OR subject ~ '^local:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
 provider text NOT NULL DEFAULT 'local' CHECK(provider='local'),
 provider_namespace text NOT NULL DEFAULT 'pl-local' CHECK(provider_namespace='pl-local'),
 revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991), source_revision bigint NOT NULL CHECK(source_revision>=0),
 name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 128), admin boolean NOT NULL,
 state text NOT NULL CHECK(state IN('active','disabled','missing')), updated_at timestamptz NOT NULL
);
CREATE TABLE pl_local_directory_events (
 sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 event_id uuid NOT NULL UNIQUE, body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'),
 created_at timestamptz NOT NULL
);
CREATE TABLE pl_local_directory_snapshots (
 id uuid PRIMARY KEY, watermark bigint NOT NULL CHECK(watermark>=0), expires_at timestamptz NOT NULL
);
CREATE TABLE pl_local_directory_snapshot_items (
 snapshot_id uuid NOT NULL REFERENCES pl_local_directory_snapshots(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN('employees','departments')), item_key text NOT NULL,
 body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'),
 PRIMARY KEY(snapshot_id,kind,item_key)
);
CREATE INDEX pl_local_directory_snapshots_expiry ON pl_local_directory_snapshots(expires_at);

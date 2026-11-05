-- Organization facts are independent of project content and login sessions.
CREATE TABLE org_employees (
 subject text PRIMARY KEY CHECK(length(subject) BETWEEN 1 AND 256),
 provider text NOT NULL CHECK(provider='ad'),
 provider_namespace text NOT NULL CHECK(length(provider_namespace)=16),
 object_guid bytea NOT NULL CHECK(octet_length(object_guid)=16),
 revision bigint NOT NULL CHECK(revision>0),
 body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'),
 UNIQUE(provider,provider_namespace,object_guid)
);
CREATE TABLE org_departments (
 id text PRIMARY KEY, name text NOT NULL, active boolean NOT NULL,
 revision bigint NOT NULL CHECK(revision>0)
);
CREATE TABLE org_department_groups (
 department_id text NOT NULL REFERENCES org_departments(id),
 provider_namespace text NOT NULL CHECK(length(provider_namespace)=16),
 object_guid bytea NOT NULL CHECK(octet_length(object_guid)=16), dn text NOT NULL,
 PRIMARY KEY(department_id,provider_namespace,object_guid)
);
CREATE TABLE org_employee_candidates (
 subject text NOT NULL REFERENCES org_employees(subject),
 department_id text NOT NULL REFERENCES org_departments(id),
 PRIMARY KEY(subject,department_id)
);
CREATE TABLE org_primary_selections (
 subject text PRIMARY KEY REFERENCES org_employees(subject),
 department_id text NOT NULL REFERENCES org_departments(id), selected_by text NOT NULL,
 FOREIGN KEY(subject,department_id) REFERENCES org_employee_candidates(subject,department_id)
);
CREATE TABLE org_department_heads (
 department_id text NOT NULL REFERENCES org_departments(id),
 subject text NOT NULL REFERENCES org_employees(subject),
 PRIMARY KEY(department_id,subject)
);
CREATE TABLE org_outbox (
 sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 event_id text NOT NULL UNIQUE, body jsonb NOT NULL,
 created_at timestamptz NOT NULL
);
CREATE TABLE org_audit (
 event_id text PRIMARY KEY REFERENCES org_outbox(event_id),
 actor text NOT NULL, body jsonb NOT NULL, created_at timestamptz NOT NULL
);
CREATE TABLE org_cursor_state (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 retained_after bigint NOT NULL DEFAULT 0 CHECK(retained_after>=0)
);
INSERT INTO org_cursor_state(singleton) VALUES(true);
CREATE TABLE org_snapshots (
 id uuid PRIMARY KEY, kind text NOT NULL CHECK(kind IN('employees','departments')),
 watermark bigint NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE org_snapshot_items (
 snapshot_id uuid NOT NULL REFERENCES org_snapshots(id) ON DELETE CASCADE,
 item_key text NOT NULL, body jsonb NOT NULL,
 PRIMARY KEY(snapshot_id,item_key)
);
CREATE INDEX org_snapshots_expiry ON org_snapshots(expires_at);

CREATE TABLE local_users (
    id text PRIMARY KEY CHECK (id ~ '^local:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    username text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 128),
    admin boolean NOT NULL DEFAULT false,
    disabled boolean NOT NULL DEFAULT false,
    password_hash text NOT NULL,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_id ON sessions(user_id);

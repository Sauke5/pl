-- Login configuration is separate from the Doska directory projection.
CREATE TABLE ad_login_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  revision bigint NOT NULL CHECK (revision > 0),
  configuration jsonb NOT NULL,
  password_envelope bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  tested_at timestamptz NOT NULL,
  updated_by text NOT NULL
);

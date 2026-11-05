CREATE TABLE local_login_attempts (
    bucket text PRIMARY KEY,
    window_start timestamptz NOT NULL DEFAULT now(),
    attempts integer NOT NULL CHECK (attempts > 0)
);
CREATE INDEX local_login_attempts_window ON local_login_attempts(window_start);

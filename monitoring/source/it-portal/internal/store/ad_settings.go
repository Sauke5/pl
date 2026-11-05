package store

import (
	"context"
	"encoding/json"
	"time"
)

// ADLoginSettings never belongs to the generic document API. Its secret
// envelope is decrypted only by the login/configuration service.
type ADLoginSettings struct {
	Revision            int64
	Configuration       json.RawMessage
	PasswordEnvelope    []byte
	UpdatedAt, TestedAt time.Time
}

func (s *Store) ADLoginSettings(ctx context.Context) (ADLoginSettings, error) {
	var v ADLoginSettings
	err := s.Pool.QueryRow(ctx, `SELECT revision,configuration,password_envelope,updated_at,tested_at FROM ad_login_settings WHERE singleton`).Scan(&v.Revision, &v.Configuration, &v.PasswordEnvelope, &v.UpdatedAt, &v.TestedAt)
	return v, translate(err)
}

// SaveADLoginSettings uses optimistic concurrency and revokes existing AD
// sessions in the same transaction. The recovery/local sessions are untouched.
func (s *Store) SaveADLoginSettings(ctx context.Context, v ADLoginSettings, revision int64, actor string) error {
	if revision < 0 || len(v.Configuration) == 0 || len(v.Configuration) > 131072 || len(v.PasswordEnvelope) == 0 || len(v.PasswordEnvelope) > 8192 || actor == "" || v.TestedAt.IsZero() {
		return ErrInvalid
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// Serialize first writes and updates across API processes as well.
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(7398217)`); err != nil {
		return err
	}
	var actual int64
	err = tx.QueryRow(ctx, `SELECT revision FROM ad_login_settings WHERE singleton`).Scan(&actual)
	if err != nil && translate(err) != ErrNotFound {
		return err
	}
	if actual != revision {
		return ErrConflict
	}
	_, err = tx.Exec(ctx, `INSERT INTO ad_login_settings(singleton,revision,configuration,password_envelope,tested_at,updated_by) VALUES(true,$1,$2,$3,$4,$5)
 ON CONFLICT(singleton) DO UPDATE SET revision=EXCLUDED.revision,configuration=EXCLUDED.configuration,password_envelope=EXCLUDED.password_envelope,tested_at=EXCLUDED.tested_at,updated_at=now(),updated_by=EXCLUDED.updated_by`, revision+1, v.Configuration, v.PasswordEnvelope, v.TestedAt, actor)
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM sessions WHERE user_id LIKE 'ad:%'`); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

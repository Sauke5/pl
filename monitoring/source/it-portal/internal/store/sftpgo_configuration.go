package store

import (
	"context"
	"encoding/hex"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"pl/portal/internal/model"
)

// Replaying the browser's operation must reuse its durable job before asking
// the controller to generate another private plan.
func (s *Store) SFTPGoConfigurationJob(ctx context.Context, id, actor, key, requestHash string) (model.ModuleInstance, model.Job, bool, error) {
	var instance model.ModuleInstance
	var job model.Job
	var body []byte
	err := s.Pool.QueryRow(ctx, "SELECT body FROM jobs WHERE actor=$1 AND idempotency_key=$2", actor, key).Scan(&body)
	if errors.Is(err, pgx.ErrNoRows) {
		return instance, job, false, nil
	}
	if err != nil {
		return instance, job, false, err
	}
	job, err = Decode[model.Job](body)
	if err != nil {
		return instance, job, false, err
	}
	if job.Kind != "module" || job.Parameters["instance_id"] != id || job.Parameters["action"] != "configure" || job.Parameters["configuration_request_hash"] != requestHash {
		return instance, job, false, ErrConflict
	}
	instance, err = Get[model.ModuleInstance](ctx, s, "module_instance", id)
	return instance, job, true, err
}

func (s *Store) SaveSFTPGoDraft(ctx context.Context, id, actor string, c model.SFTPGoConfiguration) (model.ModuleInstance, error) {
	var instance model.ModuleInstance
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return instance, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(7398218)"); err != nil {
		return instance, err
	}
	var body []byte
	if err = tx.QueryRow(ctx, "SELECT body || jsonb_build_object('id',id,'revision',revision) FROM documents WHERE kind='module_instance' AND id=$1 FOR UPDATE", id).Scan(&body); err != nil {
		return instance, translate(err)
	}
	instance, err = Decode[model.ModuleInstance](body)
	if err != nil {
		return instance, err
	}
	if instance.ModuleID != "sftpgo" || instance.Mode != "local" || instance.DesiredState != "enabled" {
		return instance, ErrInvalid
	}
	if instance.ConfigurationError != "" && !instance.ConfigurationRolledBack && instance.ConfigurationLastJobID != "" {
		return instance, ErrConflict
	}
	var busy bool
	if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM jobs WHERE kind='module' AND target=$1 AND status IN ('queued','running'))", id).Scan(&busy); err != nil {
		return instance, err
	}
	if busy {
		return instance, ErrConflict
	}
	revision := int64(0)
	if instance.SFTPGoApplied != nil {
		revision = instance.SFTPGoApplied.Revision
	}
	parsed, parseErr := uuid.Parse(c.Ref)
	digest, hashErr := hex.DecodeString(c.Hash)
	if c.Revision != revision+1 || c.Revision >= (1<<53)-1 || parseErr != nil || parsed.String() != c.Ref || hashErr != nil || len(digest) != 32 || c.ListenIP == "" || c.Port < 1024 || c.Port > 65535 {
		return instance, ErrInvalid
	}
	instance.SFTPGoDraft = &c
	saved, err := save(ctx, tx, "module_instance", id, instance.Revision, instance)
	if err != nil {
		return instance, err
	}
	instance, err = Decode[model.ModuleInstance](saved)
	if err != nil {
		return instance, err
	}
	if err = record(ctx, tx, "module.configuration.saved", "Сохранены настройки файлового сервера", id, actor, map[string]any{"configuration_revision": c.Revision}, true); err != nil {
		return instance, err
	}
	return instance, tx.Commit(ctx)
}

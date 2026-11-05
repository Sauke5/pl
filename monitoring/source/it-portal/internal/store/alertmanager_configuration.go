package store

import (
	"context"
	"github.com/google/uuid"
	"pl/portal/internal/model"
)

// SaveAlertmanagerDraft shares the module queue's lock. A configuration cannot be
// edited under an in-flight lifecycle/apply operation.
func (s *Store) SaveAlertmanagerDraft(ctx context.Context, id, actor string, c model.AlertmanagerConfiguration) (model.ModuleInstance, error) {
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
	if instance.ModuleID != "alertmanager" || instance.Mode != "local" || instance.DesiredState == "removed" {
		return instance, ErrInvalid
	}
	if instance.ConfigurationError != "" && !instance.ConfigurationRolledBack && instance.ConfigurationLastJobID != "" {
		return instance, ErrConflict
	}
	revision := int64(0)
	if instance.AlertmanagerDraft != nil {
		revision = instance.AlertmanagerDraft.Revision
	}
	if c.Revision != revision+1 || c.Revision >= (1<<53)-1 {
		return instance, ErrConflict
	}
	var busy bool
	if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM jobs WHERE kind='module' AND target=$1 AND status IN ('queued','running'))", id).Scan(&busy); err != nil {
		return instance, err
	}
	if busy {
		return instance, ErrConflict
	}
	parsedRef, refErr := uuid.Parse(c.Ref)
	if refErr != nil || parsedRef.String() != c.Ref {
		return instance, ErrInvalid
	}
	instance.AlertmanagerDraft = &c
	saved, err := save(ctx, tx, "module_instance", id, instance.Revision, instance)
	if err != nil {
		return instance, err
	}
	instance, err = Decode[model.ModuleInstance](saved)
	if err != nil {
		return instance, err
	}
	if err = record(ctx, tx, "module.configuration.saved", "Сохранён черновик конфигурации Alertmanager", id, actor, map[string]any{"configuration_revision": c.Revision}, true); err != nil {
		return instance, err
	}
	return instance, tx.Commit(ctx)
}

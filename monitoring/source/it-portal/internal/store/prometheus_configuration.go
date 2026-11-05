package store

import (
	"context"
	"pl/portal/internal/model"
)

// SavePrometheusDraft shares the module queue's lock. A configuration cannot be
// edited under an in-flight lifecycle/apply operation.
func (s *Store) SavePrometheusDraft(ctx context.Context, id, actor string, c model.PrometheusConfiguration) (model.ModuleInstance, error) {
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
	if instance.ModuleID != "prometheus" || instance.Mode != "local" || instance.DesiredState == "removed" {
		return instance, ErrInvalid
	}
	revision := int64(0)
	if instance.PrometheusDraft != nil {
		revision = instance.PrometheusDraft.Revision
	}
	if c.Revision != revision || c.Revision >= (1<<53)-1 {
		return instance, ErrConflict
	}
	var busy bool
	if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM jobs WHERE kind='module' AND target=$1 AND status IN ('queued','running'))", id).Scan(&busy); err != nil {
		return instance, err
	}
	if busy {
		return instance, ErrConflict
	}
	c.Revision++
	instance.PrometheusDraft = &c
	saved, err := save(ctx, tx, "module_instance", id, instance.Revision, instance)
	if err != nil {
		return instance, err
	}
	instance, err = Decode[model.ModuleInstance](saved)
	if err != nil {
		return instance, err
	}
	if err = record(ctx, tx, "module.configuration.saved", "Сохранён черновик конфигурации Prometheus", id, actor, map[string]any{"configuration_revision": c.Revision}, true); err != nil {
		return instance, err
	}
	return instance, tx.Commit(ctx)
}

// RetryPrometheusConfiguration preserves the host operation ID and frozen input.
// This is needed when a transport/reload failure left an unconfirmed host journal.
func (s *Store) RetryPrometheusConfiguration(ctx context.Context, id, actor, jobID string) (model.ModuleInstance, model.Job, error) {
	return s.retryModuleConfiguration(ctx, id, actor, jobID, "prometheus")
}

func (s *Store) RetryXrayConfiguration(ctx context.Context, id, actor, jobID string) (model.ModuleInstance, model.Job, error) {
	return s.retryModuleConfiguration(ctx, id, actor, jobID, "xray")
}

func (s *Store) RetryAlertmanagerConfiguration(ctx context.Context, id, actor, jobID string) (model.ModuleInstance, model.Job, error) {
	return s.retryModuleConfiguration(ctx, id, actor, jobID, "alertmanager")
}

func (s *Store) retryModuleConfiguration(ctx context.Context, id, actor, jobID, moduleID string) (model.ModuleInstance, model.Job, error) {
	var instance model.ModuleInstance
	var job model.Job
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return instance, job, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(7398218)"); err != nil {
		return instance, job, err
	}
	var body []byte
	if err = tx.QueryRow(ctx, "SELECT body || jsonb_build_object('id',id,'revision',revision) FROM documents WHERE kind='module_instance' AND id=$1 FOR UPDATE", id).Scan(&body); err != nil {
		return instance, job, translate(err)
	}
	instance, err = Decode[model.ModuleInstance](body)
	if err != nil {
		return instance, job, err
	}
	if instance.Mode != "local" || instance.ModuleID != moduleID || instance.DesiredState != "enabled" || instance.ConfigurationLastJobID != jobID || instance.ConfigurationRolledBack {
		return instance, job, ErrConflict
	}
	if err = tx.QueryRow(ctx, "SELECT body FROM jobs WHERE id=$1 FOR UPDATE", jobID).Scan(&body); err != nil {
		return instance, job, translate(err)
	}
	job, err = Decode[model.Job](body)
	if err != nil {
		return instance, job, err
	}
	if job.Kind != "module" || job.Parameters["action"] != "configure" || job.Parameters["instance_id"] != id || job.Actor != actor {
		return instance, job, ErrConflict
	}
	if job.Status == "queued" || job.Status == "running" {
		return instance, job, nil
	}
	if job.Status != "failed" && job.Status != "canceled" {
		return instance, job, ErrConflict
	}
	var busy bool
	if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM jobs WHERE kind='module' AND target=$1 AND status IN ('queued','running'))", id).Scan(&busy); err != nil {
		return instance, job, err
	}
	if busy {
		return instance, job, ErrConflict
	}
	if err = record(ctx, tx, "module.configuration.retry", "Повторено применение конфигурации модуля", id, actor, map[string]any{"job_id": job.ID, "previous_error": job.Error}, true); err != nil {
		return instance, job, err
	}
	job.Status = "queued"
	job.Error = ""
	job.StartedAt = nil
	job.FinishedAt = nil
	job.Result = map[string]any{}
	if _, err = tx.Exec(ctx, "UPDATE jobs SET status='queued',started_at=NULL,finished_at=NULL,body=$2 WHERE id=$1", job.ID, encode(job)); err != nil {
		return instance, job, err
	}
	instance.LastJobID = job.ID
	instance.ObservedState = "pending"
	instance.Error = ""
	instance.ConfigurationError = ""
	instance.ConfigurationRolledBack = false
	if err = syncModuleLinks(ctx, tx, &instance); err != nil {
		return instance, job, err
	}
	saved, err := save(ctx, tx, "module_instance", id, instance.Revision, instance)
	if err != nil {
		return instance, job, err
	}
	instance, err = Decode[model.ModuleInstance](saved)
	if err != nil {
		return instance, job, err
	}
	return instance, job, tx.Commit(ctx)
}

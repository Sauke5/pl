package store

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"pl/portal/internal/model"
)

func mailcowSource(ctx context.Context, tx pgx.Tx, id string) (model.ModuleInstance, model.Integration, error) {
	var instance model.ModuleInstance
	var integration model.Integration
	var raw []byte
	err := tx.QueryRow(ctx, "SELECT body || jsonb_build_object('id',id,'revision',revision) FROM documents WHERE kind='module_instance' AND id=$1", id).Scan(&raw)
	if err != nil {
		return instance, integration, translate(err)
	}
	if instance, err = Decode[model.ModuleInstance](raw); err != nil {
		return instance, integration, err
	}
	if instance.ModuleID != "mailcow" || instance.Mode != "external" || instance.IntegrationID == "" {
		return instance, integration, ErrInvalid
	}
	err = tx.QueryRow(ctx, "SELECT body || jsonb_build_object('id',id,'revision',revision) FROM documents WHERE kind='integration' AND id=$1", instance.IntegrationID).Scan(&raw)
	if err != nil {
		return instance, integration, translate(err)
	}
	if integration, err = Decode[model.Integration](raw); err != nil {
		return instance, integration, err
	}
	if integration.Kind != "mailcow" || integration.ManagedModuleID != instance.ID || integration.Config["module_mode"] != "external" {
		return instance, integration, ErrConflict
	}
	return instance, integration, nil
}

func mailcowCached(ctx context.Context, tx pgx.Tx, id string) (model.MailcowSnapshot, int64, error) {
	var snapshot model.MailcowSnapshot
	var raw []byte
	var revision int64
	err := tx.QueryRow(ctx, "SELECT body, revision FROM documents WHERE kind='mailcow_snapshot' AND id=$1", id).Scan(&raw, &revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return snapshot, 0, nil
	}
	if err != nil {
		return snapshot, 0, err
	}
	err = json.Unmarshal(raw, &snapshot)
	return snapshot, revision, err
}

// MailcowSnapshot reads only persisted data; opening the page never polls Mailcow.
func (s *Store) MailcowSnapshot(ctx context.Context, id string) (model.MailcowSnapshot, error) {
	var snapshot model.MailcowSnapshot
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return snapshot, err
	}
	defer tx.Rollback(ctx)
	instance, integration, err := mailcowSource(ctx, tx, id)
	if err != nil {
		return snapshot, err
	}
	snapshot, _, err = mailcowCached(ctx, tx, integration.ID)
	if err == nil {
		snapshot.ApplySource(instance, integration, time.Now().UTC())
	}
	return snapshot, err
}

func (s *Store) SaveMailcowSettings(ctx context.Context, id, actor string, settings model.MailcowSettings) error {
	if settings.Validate() != nil {
		return ErrInvalid
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// Same order as module lifecycle projections: a short write transaction only.
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(7398218)"); err != nil {
		return err
	}
	instance, integration, err := mailcowSource(ctx, tx, id)
	if err != nil {
		return err
	}
	if integration.Revision != settings.Revision || instance.DesiredState != "enabled" {
		return ErrConflict
	}
	if integration.Config == nil {
		integration.Config = map[string]string{}
	}
	for group, value := range settings.Groups {
		integration.Config["mailcow_"+group+"_enabled"] = strconv.FormatBool(value.Enabled)
		integration.Config["mailcow_"+group+"_interval"] = strconv.Itoa(value.IntervalSeconds)
	}
	if _, err = save(ctx, tx, "integration", integration.ID, integration.Revision, integration); err != nil {
		return err
	}
	if err = record(ctx, tx, "mailcow.settings", "Изменены настройки сбора Mailcow", instance.ResourceID, actor, map[string]any{"instance_id": id}, true); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ApplyMailcowGroup rejects results from disabled/removed or reconfigured sources.
// Neither the native API key nor upstream error text enters the stored snapshot.
func (s *Store) ApplyMailcowGroup(ctx context.Context, source model.Integration, group string, data json.RawMessage, code string, started time.Time) error {
	known := false
	for _, candidate := range model.MailcowGroups() {
		if candidate == group {
			known = true
		}
	}
	if !known || len(data) > 2<<20 || code == "" && !json.Valid(data) {
		return ErrInvalid
	}
	switch code {
	case "", "auth", "unsupported", "network", "timeout", "schema", "body_limit", "record_limit", "secret", "policy", "http", "upstream", "dependency":
	default:
		return ErrInvalid
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(7398218)"); err != nil {
		return err
	}
	instance, integration, err := mailcowSource(ctx, tx, source.ManagedModuleID)
	if err != nil {
		return err
	}
	config := model.MailcowGroupConfig(integration.Config)[group]
	if integration.ID != source.ID || integration.Revision != source.Revision || !integration.Enabled || !config.Enabled || instance.DesiredState != "enabled" || instance.ObservedState != "running" {
		return ErrConflict
	}
	snapshot, revision, err := mailcowCached(ctx, tx, integration.ID)
	if err != nil {
		return err
	}
	snapshot.ApplySource(instance, integration, time.Now().UTC())
	value := snapshot.Groups[group]
	if value.LastAttempt != nil && !started.After(*value.LastAttempt) {
		return ErrConflict
	}
	value.LastAttempt, value.ErrorCode = &started, code
	value.LastAttemptStatus = "error"
	if code == "" {
		now := time.Now().UTC()
		value.Data, value.LastSuccess, value.LastAttemptStatus = data, &now, "success"
	}
	snapshot.Groups[group] = value
	snapshot.ApplySource(instance, integration, time.Now().UTC())
	if _, err = save(ctx, tx, "mailcow_snapshot", integration.ID, revision, snapshot); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

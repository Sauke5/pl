package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"reflect"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"pl/portal/internal/model"
)

// DeliveryRequest records intent before the host RPC can stop this API. These
// jobs are observations of an external worker, never ordinary worker commands.
type DeliveryRequest struct{ ID, Actor, Action, ModuleID, Target, Version, ArtifactSHA256 string }
type DeliveryObservation struct {
	ID, Kind, ModuleID, Phase, Error, CurrentVersion, RecoveryMode string
	RestoredSnapshot                                               bool
}

func (s *Store) BeginDelivery(ctx context.Context, request DeliveryRequest) (model.Job, error) {
	id, err := uuid.Parse(request.ID)
	if err != nil || id.String() != request.ID || request.Actor == "" || request.Target == "" || request.Version == "" ||
		(request.Action != "upgrade" && request.Action != "module-upgrade") || (request.Action == "upgrade" && request.ModuleID != "") || (request.Action == "module-upgrade" && request.ModuleID == "") {
		return model.Job{}, ErrInvalid
	}
	parameters := map[string]any{"operation_id": request.ID, "action": request.Action, "target": request.Target, "version": request.Version}
	if request.ModuleID != "" {
		parameters["module_id"] = request.ModuleID
		parameters["artifact_sha256"] = request.ArtifactSHA256
	}
	fingerprint := sha256.Sum256(encode(parameters))
	fp := hex.EncodeToString(fingerprint[:])
	now := time.Now().UTC()
	job := model.Job{ID: request.ID, Kind: "delivery", Actor: request.Actor, IdempotencyKey: "delivery:" + request.ID, Confirmed: true, Status: "running", Parameters: parameters, CreatedAt: now, StartedAt: &now, Result: map[string]any{"phase": "requesting", "target_version": request.Version, "summary": "Запрос обновления передаётся host controller."}}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return job, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", "delivery:"+request.ID); err != nil {
		return job, err
	}
	var raw []byte
	var previousFP string
	err = tx.QueryRow(ctx, "SELECT body,fingerprint FROM jobs WHERE id=$1", request.ID).Scan(&raw, &previousFP)
	if err == nil {
		old, e := Decode[model.Job](raw)
		if e != nil {
			return job, e
		}
		if old.Kind != "delivery" || old.Actor != request.Actor || previousFP != fp {
			return job, ErrConflict
		}
		return old, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return job, err
	}
	if _, err = tx.Exec(ctx, "INSERT INTO jobs(id,idempotency_key,actor,fingerprint,kind,target,status,body,started_at) VALUES($1,$2,$3,$4,'delivery',$5,'running',$6,$7)", job.ID, job.IdempotencyKey, job.Actor, fp, request.Target, encode(job), now); err != nil {
		return job, translate(err)
	}
	if err = deliveryEvent(ctx, tx, job); err != nil {
		return job, err
	}
	return job, tx.Commit(ctx)
}

func deliveryEvent(ctx context.Context, db DB, job model.Job) error {
	details, err := jobEventContext(ctx, db, job)
	if err != nil {
		return err
	}
	for _, audit := range []bool{true, false} {
		if err = record(ctx, db, "job."+job.Status, jobEventTitle(job, details), "", job.Actor, details, audit); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) HasPendingDelivery(ctx context.Context) (bool, error) {
	var found bool
	err := s.Pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM jobs WHERE kind='delivery' AND status IN ('running','unknown'))").Scan(&found)
	return found, err
}

// ObserveDelivery cannot create a job or replace its actor. A legacy operation
// first seen on a GET consequently never acquires the reader's identity.
func (s *Store) ObserveDelivery(ctx context.Context, observation DeliveryObservation) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var raw []byte
	err = tx.QueryRow(ctx, "SELECT body FROM jobs WHERE id=$1 AND kind='delivery' FOR UPDATE", observation.ID).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	job, err := Decode[model.Job](raw)
	if err != nil {
		return err
	}
	action, _ := job.Parameters["action"].(string)
	module, _ := job.Parameters["module_id"].(string)
	if observation.Phase != "unconfirmed" && (module != observation.ModuleID || action == "module-upgrade" && observation.Kind != "module_upgrade" || action == "upgrade" && observation.Kind != "" && observation.Kind != "upgrade") {
		return ErrConflict
	}
	// A delayed failed RPC/status response cannot overwrite an observed terminal
	// result. Unknown can become running again after authenticated host recovery.
	if job.Status == "succeeded" || job.Status == "failed" {
		return nil
	}
	status, summary := "running", "Обновление выполняется."
	switch observation.Phase {
	case "complete":
		status, summary = "succeeded", "Обновление завершено."
	case "failed":
		status, summary = "failed", "Обновление завершилось ошибкой."
	case "rolled_back":
		status, summary = "failed", "Предыдущая версия и данные восстановлены."
	case "recovery_required":
		status, summary = "unknown", "Требуется восстановление обновления."
	case "unconfirmed":
		if job.Result["phase"] != "requesting" {
			return nil
		}
		status, summary = "unknown", "Host controller не подтвердил запрос. Обновите состояние операции."
	case "queued", "queued_recovery", "downloading", "preparing_host", "verifying_host", "quiescing", "snapshot", "applying", "verifying", "resuming", "reconciling", "restoring":
	default:
		return ErrInvalid
	}
	result := map[string]any{"phase": observation.Phase, "target_version": job.Parameters["version"], "summary": summary}
	if observation.CurrentVersion != "" {
		result["current_version"] = observation.CurrentVersion
	}
	if observation.RecoveryMode == "resume" || observation.RecoveryMode == "rollback" {
		result["recovery_mode"] = observation.RecoveryMode
	}
	if observation.RestoredSnapshot {
		result["restored_snapshot"] = true
	}
	failure := observation.Error
	if len(failure) > 4096 {
		failure = failure[:4096]
	}
	if job.Status == status && job.Error == failure && reflect.DeepEqual(job.Result, result) {
		return nil
	}
	previousStatus := job.Status
	job.Status, job.Result, job.Error = status, result, failure
	if status == "succeeded" || status == "failed" {
		now := time.Now().UTC()
		job.FinishedAt = &now
	}
	if _, err = tx.Exec(ctx, "UPDATE jobs SET status=$2,finished_at=$3,body=$4 WHERE id=$1", job.ID, job.Status, job.FinishedAt, encode(job)); err != nil {
		return err
	}
	// Phase progress is visible on the job; audit only meaningful status changes.
	if previousStatus != status {
		if err = deliveryEvent(ctx, tx, job); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *Store) RecordDeliveryRecovery(ctx context.Context, id, actor string) error {
	// Recovery is a separate human action; the original job actor is immutable.
	// Serialize and deduplicate each operation/actor request across retries.
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	key := "delivery-recovery:" + id + ":" + actor
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", key); err != nil {
		return err
	}
	var exists bool
	if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM audit_events WHERE body->>'kind'='delivery.recovery_requested' AND body->>'actor'=$1 AND body #>> '{details,operation_id}'=$2)", actor, id).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		if err = record(ctx, tx, "delivery.recovery_requested", "Запрошено восстановление обновления", "", actor, map[string]any{"operation_id": id, "action": "recover"}, true); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

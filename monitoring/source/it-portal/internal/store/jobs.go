package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"pl/portal/internal/model"
)

func (s *Store) Enqueue(ctx context.Context, j model.Job) (model.Job, error) {
	j.ResourceName, j.IntegrationName = "", ""
	j.Status = "queued"
	j.CreatedAt = time.Now().UTC()
	j.ID = uuid.NewString()
	j.Result = map[string]any{}
	fingerprint := sha256.Sum256(encode(struct {
		Kind, ResourceID, IntegrationID string
		Parameters                      map[string]any
		Confirmed                       bool
	}{j.Kind, j.ResourceID, j.IntegrationID, j.Parameters, j.Confirmed}))
	fp := hex.EncodeToString(fingerprint[:])
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return j, e
	}
	defer tx.Rollback(ctx)
	// Serialize identical keys, including absent rows, before checking the persistent result.
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", j.Actor+":"+j.IdempotencyKey); e != nil {
		return j, e
	}
	var body []byte
	var oldFP string
	e = tx.QueryRow(ctx, "SELECT body,fingerprint FROM jobs WHERE actor=$1 AND idempotency_key=$2", j.Actor, j.IdempotencyKey).Scan(&body, &oldFP)
	if e == nil {
		if oldFP != fp {
			return j, ErrConflict
		}
		old, e := Decode[model.Job](body)
		if old.Kind == "check" && old.Parameters["kind"] == "icmp" {
			delete(old.Result, "raw_output")
		}
		return old, e
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return j, e
	}
	target := j.ResourceID
	if t, ok := j.Parameters["executor_target"].(string); ok {
		target = t
	}
	if target == "" {
		target = j.IntegrationID
	}
	_, e = tx.Exec(ctx, "INSERT INTO jobs(id,idempotency_key,actor,fingerprint,kind,target,status,body) VALUES($1,$2,$3,$4,$5,$6,'queued',$7)", j.ID, j.IdempotencyKey, j.Actor, fp, j.Kind, target, encode(j))
	if e != nil {
		return j, translate(e)
	}
	details, e := jobEventContext(ctx, tx, j)
	if e != nil {
		return j, e
	}
	details["target"] = target
	if e = record(ctx, tx, "job.queued", jobEventTitle(j, details), j.ResourceID, j.Actor, details, true); e != nil {
		return j, e
	}
	return j, tx.Commit(ctx)
}

const jobReadSQL = `SELECT CASE WHEN j.kind='check' AND j.body #>> '{parameters,kind}'='icmp' THEN j.body #- '{result,raw_output}' ELSE j.body END,
COALESCE(r.body->>'name',''),COALESCE(i.body->>'name','') FROM jobs j
LEFT JOIN documents r ON r.kind='resource' AND r.id=j.body->>'resource_id'
LEFT JOIN documents i ON i.kind='integration' AND i.id=j.body->>'integration_id'`

func (s *Store) Jobs(ctx context.Context) ([]model.Job, error) {
	rows, e := s.Pool.Query(ctx, jobReadSQL+" ORDER BY j.created_at DESC LIMIT 200")
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []model.Job{}
	for rows.Next() {
		var b []byte
		var resourceName, integrationName string
		if e = rows.Scan(&b, &resourceName, &integrationName); e != nil {
			return nil, e
		}
		j, e := Decode[model.Job](b)
		if e != nil {
			return nil, e
		}
		j.ResourceName, j.IntegrationName = resourceName, integrationName
		out = append(out, j)
	}
	return out, rows.Err()
}
func (s *Store) Job(ctx context.Context, id string) (model.Job, error) {
	var b []byte
	var resourceName, integrationName string
	e := s.Pool.QueryRow(ctx, jobReadSQL+" WHERE j.id=$1", id).Scan(&b, &resourceName, &integrationName)
	if e != nil {
		return model.Job{}, translate(e)
	}
	j, err := Decode[model.Job](b)
	j.ResourceName, j.IntegrationName = resourceName, integrationName
	return j, err
}

// JobOutput retrieves only a completed ICMP job's bounded raw output. It is
// intentionally separate from both the timeline and ordinary polling payloads.
func (s *Store) JobOutput(ctx context.Context, id string) (string, error) {
	var raw string
	err := s.Pool.QueryRow(ctx, `SELECT body #>> '{result,raw_output}' FROM jobs
WHERE id=$1 AND kind='check' AND body #>> '{parameters,kind}'='icmp'
AND jsonb_typeof(body #> '{result,raw_output}')='string'`, id).Scan(&raw)
	if err != nil {
		return "", translate(err)
	}
	if len(raw) > 1<<20 {
		return "", ErrInvalid
	}
	return raw, nil
}
func (s *Store) Claim(ctx context.Context) (model.Job, error) {
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return model.Job{}, e
	}
	defer tx.Rollback(ctx)
	var b []byte
	e = tx.QueryRow(ctx, "SELECT body FROM jobs WHERE status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1").Scan(&b)
	if e != nil {
		return model.Job{}, translate(e)
	}
	j, e := Decode[model.Job](b)
	if e != nil {
		return j, e
	}
	now := time.Now().UTC()
	j.Status = "running"
	j.StartedAt = &now
	if _, e = tx.Exec(ctx, "UPDATE jobs SET status='running',started_at=$2,body=$3 WHERE id=$1", j.ID, now, encode(j)); e != nil {
		return j, e
	}
	return j, tx.Commit(ctx)
}
func (s *Store) Finish(ctx context.Context, j model.Job) error {
	now := time.Now().UTC()
	j.FinishedAt = &now
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	// Module retry/queue paths lock the module domain before their job row.
	// Keep that order while finishing to avoid a retry/finish lock cycle.
	if j.Kind == "module" {
		if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(7398218)"); e != nil {
			return e
		}
	}
	if _, e = tx.Exec(ctx, "UPDATE jobs SET status=$2,finished_at=$3,body=$4 WHERE id=$1", j.ID, j.Status, now, encode(j)); e != nil {
		return e
	}
	details, e := jobEventContext(ctx, tx, j)
	if e != nil {
		return e
	}
	if e = record(ctx, tx, "job."+j.Status, jobEventTitle(j, details), j.ResourceID, j.Actor, details, true); e != nil {
		return e
	}
	if e = record(ctx, tx, "job."+j.Status, jobEventTitle(j, details), j.ResourceID, j.Actor, details, false); e != nil {
		return e
	}
	if j.Kind == "module" {
		if e = finishModule(ctx, tx, j); e != nil {
			return e
		}
	}
	if j.Kind == "report" {
		url, _ := j.Result["url"].(string)
		period, _ := j.Parameters["target_date"].(string)
		if period == "" {
			period, _ = j.Result["period"].(string)
		}
		report := model.Report{ID: j.ID, JobID: j.ID, Title: "Отчёт инфраструктуры", Period: period, Status: j.Status, CreatedAt: j.CreatedAt, URL: url, Error: j.Error}
		report.ReportType, _ = j.Result["report_type"].(string)
		switch run := j.Result["run"].(type) {
		case int:
			report.Run = run
		case float64:
			report.Run = int(run)
		}
		if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(7398219)"); e != nil {
			return e
		}
		if e = upsertReport(ctx, tx, report, false); e != nil {
			return e
		}
	}
	return tx.Commit(ctx)
}
func (s *Store) Recover(ctx context.Context) error {
	rows, e := s.Pool.Query(ctx, "SELECT body FROM jobs WHERE status='running'")
	if e != nil {
		return e
	}
	jobs := []model.Job{}
	for rows.Next() {
		var b []byte
		if e = rows.Scan(&b); e != nil {
			rows.Close()
			return e
		}
		j, e := Decode[model.Job](b)
		if e != nil {
			rows.Close()
			return e
		}
		jobs = append(jobs, j)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	for _, j := range jobs {
		if j.Kind == "module" {
			// Controller operation IDs are durable. Recovery resumes observation
			// of this same operation rather than creating another installation.
			j.Status = "queued"
			j.Parameters["recovered"] = true
			if _, e = s.Pool.Exec(ctx, "UPDATE jobs SET status='queued',body=$2 WHERE id=$1", j.ID, encode(j)); e != nil {
				return e
			}
			continue
		}
		j.Status = "failed"
		j.Error = "Worker был остановлен. Повторите проверку вручную."
		if j.Kind == "restart" || j.Kind == "report" {
			j.Status = "unknown"
			j.Error = "Worker был остановлен после начала операции. Результат неизвестен; автоматический повтор запрещён."
		}
		if e = s.Finish(ctx, j); e != nil {
			return e
		}
	}
	return nil
}

package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
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
	if target != "" {
		details["target"] = target
	}
	if e = record(ctx, tx, "job.queued", jobEventTitle(j, details), j.ResourceID, j.Actor, details, true); e != nil {
		return j, e
	}
	return j, tx.Commit(ctx)
}

const jobReadSQL = `SELECT CASE WHEN j.kind='check' AND j.body #>> '{parameters,kind}'='icmp' THEN j.body #- '{result,raw_output}' ELSE j.body END,
COALESCE(r.body->>'name',''),COALESCE(i.body->>'name',''),COALESCE(m.body,'{}'::jsonb) FROM jobs j
LEFT JOIN documents r ON r.kind='resource' AND r.id=j.body->>'resource_id'
LEFT JOIN documents i ON i.kind='integration' AND i.id=j.body->>'integration_id'
LEFT JOIN documents m ON m.kind='module_instance' AND m.id=j.body #>> '{parameters,instance_id}'`

func (s *Store) Jobs(ctx context.Context) ([]model.Job, error) {
	return s.JobsForTimeline(ctx, false)
}

func (s *Store) JobsForTimeline(ctx context.Context, excludeServiceRefresh bool) ([]model.Job, error) {
	where := ""
	if excludeServiceRefresh {
		where = ` WHERE NOT (j.status='succeeded' AND (j.actor='system' OR j.actor LIKE 'system:%') AND (j.kind='refresh' OR (j.kind='module' AND COALESCE(j.body #>> '{parameters,action}','')='refresh')))`
	}
	rows, e := s.Pool.Query(ctx, jobReadSQL+where+" ORDER BY j.created_at DESC LIMIT 200")
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []model.Job{}
	for rows.Next() {
		var b, module []byte
		var resourceName, integrationName string
		if e = rows.Scan(&b, &resourceName, &integrationName, &module); e != nil {
			return nil, e
		}
		j, e := Decode[model.Job](b)
		if e != nil {
			return nil, e
		}
		j.ResourceName, j.IntegrationName = resourceName, integrationName
		jobModuleDisplay(&j, module)
		out = append(out, j)
	}
	return out, rows.Err()
}
func (s *Store) Job(ctx context.Context, id string) (model.Job, error) {
	var b, module []byte
	var resourceName, integrationName string
	e := s.Pool.QueryRow(ctx, jobReadSQL+" WHERE j.id=$1", id).Scan(&b, &resourceName, &integrationName, &module)
	if e != nil {
		return model.Job{}, translate(e)
	}
	j, err := Decode[model.Job](b)
	j.ResourceName, j.IntegrationName = resourceName, integrationName
	if err == nil {
		jobModuleDisplay(&j, module)
	}
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
	return s.claim(ctx, "true")
}

// ClaimLane reserves module health progress independently of long lifecycle work.
// The predicates are selected here, never supplied by an API/client.
func (s *Store) ClaimLane(ctx context.Context, moduleHealth bool) (model.Job, error) {
	const health = "(kind='module' AND COALESCE(body #>> '{parameters,action}','')='refresh')"
	if moduleHealth {
		return s.claim(ctx, health)
	}
	return s.claim(ctx, "NOT "+health)
}

func (s *Store) claim(ctx context.Context, predicate string) (model.Job, error) {
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return model.Job{}, e
	}
	defer tx.Rollback(ctx)
	var b []byte
	e = tx.QueryRow(ctx, "SELECT body FROM jobs WHERE status='queued' AND "+predicate+" ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1").Scan(&b)
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
	if j.Status != "succeeded" && j.Status != "failed" && j.Status != "unknown" {
		return ErrInvalid
	}
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
	// A commit acknowledgement can be lost. Serialize with the first completion
	// and acknowledge its exact result without repeating any transactional effects.
	// Job() adds these two display fields at read time; they are not job identity.
	parameters := make(map[string]any, len(j.Parameters))
	for key, value := range j.Parameters {
		if key != "module_id" && key != "module_name" {
			parameters[key] = value
		}
	}
	var previousBody []byte
	var status string
	var sameResult, sameParameters bool
	e = tx.QueryRow(ctx, `SELECT status,body,
(body->'result') IS NOT DISTINCT FROM $2::jsonb,
(COALESCE(NULLIF(body->'parameters','null'::jsonb),'{}'::jsonb)-'module_id'-'module_name')=$3::jsonb
FROM jobs WHERE id=$1 FOR UPDATE`, j.ID, encode(j.Result), encode(parameters)).Scan(&status, &previousBody, &sameResult, &sameParameters)
	if e != nil {
		return translate(e)
	}
	previous, e := Decode[model.Job](previousBody)
	if e != nil {
		return e
	}
	if previous.Kind != j.Kind || previous.ResourceID != j.ResourceID || previous.IntegrationID != j.IntegrationID ||
		previous.Actor != j.Actor || previous.IdempotencyKey != j.IdempotencyKey || previous.Confirmed != j.Confirmed || !sameParameters {
		return ErrConflict
	}
	if status != "queued" && status != "running" {
		if status == j.Status && previous.Error == j.Error && sameResult {
			return nil
		}
		return ErrConflict
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

// Read-only metadata for module jobs; result.instance preserves removed modules.
func jobModuleDisplay(j *model.Job, raw []byte) {
	if j.Kind != "module" {
		return
	}
	var instance model.ModuleInstance
	_ = json.Unmarshal(raw, &instance)
	if saved, ok := j.Result["instance"]; ok {
		b, _ := json.Marshal(saved)
		_ = json.Unmarshal(b, &instance)
	}
	if j.Parameters == nil {
		j.Parameters = map[string]any{}
	}
	if instance.ModuleID != "" {
		j.Parameters["module_id"] = instance.ModuleID
	}
	name := instance.Name
	if name == "" {
		if def, found := model.ModuleDefinition(instance.ModuleID); found {
			name = def.Name
		}
	}
	if name != "" {
		j.Parameters["module_name"] = name
	}
}

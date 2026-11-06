package store

import (
	"bytes"
	"context"
	"errors"
	"sync"
	"testing"

	"pl/portal/internal/model"
)

func finishRawJob(t *testing.T, s *Store, id string) []byte {
	t.Helper()
	var body []byte
	if err := s.Pool.QueryRow(context.Background(), "SELECT body FROM jobs WHERE id=$1", id).Scan(&body); err != nil {
		t.Fatal(err)
	}
	return body
}

func finishTerminalEvents(t *testing.T, s *Store, id string) (audit, events int) {
	t.Helper()
	for _, item := range []struct {
		table string
		count *int
	}{{"audit_events", &audit}, {"events", &events}} {
		if err := s.Pool.QueryRow(context.Background(), "SELECT COUNT(*) FROM "+item.table+" WHERE body->>'kind'='job.succeeded' AND body #>> '{details,job_id}'=$1", id).Scan(item.count); err != nil {
			t.Fatal(err)
		}
	}
	return
}

func TestFinishMatchingTerminalResultIsIdempotentForQueuedFixturesAndProjections(t *testing.T) {
	for _, kind := range []string{"check", "report", "module"} {
		t.Run(kind, func(t *testing.T) {
			s := testStore(t)
			ctx := context.Background()
			var job model.Job
			var err error
			var projectionKind, projectionID string
			if kind == "module" {
				var instance model.ModuleInstance
				instance, job, err = s.QueueModule(ctx, "local-admin", "finish-module", "", "install", model.ModuleRequest{ModuleID: "forms", Name: "Finish fixture", Mode: "local", AdditionalInstance: true})
				if err != nil {
					t.Fatal(err)
				}
				instance.ObservedState = "running"
				job.Result = map[string]any{"instance": instance}
				projectionKind, projectionID = "module_instance", instance.ID
			} else {
				job, err = s.Enqueue(ctx, model.Job{Kind: kind, Actor: "finish-fixture", IdempotencyKey: "finish-once", Parameters: map[string]any{}})
				if err != nil {
					t.Fatal(err)
				}
				job.Result = map[string]any{"value": 1}
				if kind == "report" {
					job.Result = map[string]any{"url": "https://report.test/one", "period": "2026-11-06", "run": 1}
					projectionKind, projectionID = "report", job.ID
				}
			}
			// Existing setup/recovery callers may finish a queued row directly.
			job.Status = "succeeded"
			if err = s.Finish(ctx, job); err != nil {
				t.Fatal(err)
			}
			raw := finishRawJob(t, s, job.ID)
			var beforeProjection []byte
			var beforeRevision int64
			if projectionKind != "" {
				if err = s.Pool.QueryRow(ctx, "SELECT body,revision FROM documents WHERE kind=$1 AND id=$2", projectionKind, projectionID).Scan(&beforeProjection, &beforeRevision); err != nil {
					t.Fatal(err)
				}
			}
			// A lost commit acknowledgement can replay the exact result concurrently.
			var wg sync.WaitGroup
			for n := 0; n < 4; n++ {
				wg.Add(1)
				go func() {
					defer wg.Done()
					if err := s.Finish(ctx, job); err != nil {
						t.Error(err)
					}
				}()
			}
			wg.Wait()
			if !bytes.Equal(raw, finishRawJob(t, s, job.ID)) {
				t.Fatal("repeat completion rewrote the first durable result/timestamp")
			}
			audit, events := finishTerminalEvents(t, s, job.ID)
			if audit != 1 || events != 1 {
				t.Fatalf("terminal side effects duplicated: audit=%d events=%d", audit, events)
			}
			if projectionKind != "" {
				var after []byte
				var revision int64
				if err = s.Pool.QueryRow(ctx, "SELECT body,revision FROM documents WHERE kind=$1 AND id=$2", projectionKind, projectionID).Scan(&after, &revision); err != nil {
					t.Fatal(err)
				}
				if revision != beforeRevision || !bytes.Equal(after, beforeProjection) {
					t.Fatal("repeat completion mutated projection/report")
				}
			}
		})
	}
}

func TestFinishConflictingTerminalResultCannotOverwriteTheFirst(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	job, err := s.Enqueue(ctx, model.Job{Kind: "check", Actor: "finish-fixture", IdempotencyKey: "immutable-result"})
	if err != nil {
		t.Fatal(err)
	}
	job.Status = "succeeded"
	job.Result = map[string]any{"value": 1}
	if err = s.Finish(ctx, job); err != nil {
		t.Fatal(err)
	}
	raw := finishRawJob(t, s, job.ID)
	for _, change := range []func(*model.Job){func(j *model.Job) { j.Status = "failed" }, func(j *model.Job) { j.Error = "different outcome" }, func(j *model.Job) { j.Result = map[string]any{"value": 2} }} {
		other := job
		change(&other)
		if err = s.Finish(ctx, other); !errors.Is(err, ErrConflict) {
			t.Fatalf("conflicting completion accepted: %v", err)
		}
		if !bytes.Equal(raw, finishRawJob(t, s, job.ID)) {
			t.Fatal("conflict overwrote first result")
		}
	}
	for _, change := range []func(*model.Job){
		func(j *model.Job) { j.Kind = "report" },
		func(j *model.Job) { j.ResourceID = "other-resource" },
		func(j *model.Job) { j.IntegrationID = "other-source" },
		func(j *model.Job) { j.Actor = "other-actor" },
		func(j *model.Job) { j.IdempotencyKey = "other-key" },
		func(j *model.Job) { j.Confirmed = true },
		func(j *model.Job) { j.Parameters = map[string]any{"target": "other-target"} },
	} {
		other := job
		change(&other)
		if err = s.Finish(ctx, other); !errors.Is(err, ErrConflict) {
			t.Fatalf("wrong immutable job identity acknowledged: %v", err)
		}
		if !bytes.Equal(raw, finishRawJob(t, s, job.ID)) {
			t.Fatal("identity conflict overwrote first result")
		}
	}
	// JSONB semantic equality treats numeric decode differences as the same result.
	job.Result = map[string]any{"value": float64(1)}
	if err = s.Finish(ctx, job); err != nil {
		t.Fatal("equivalent JSON result rejected", err)
	}
}

func TestFinishRejectsMissingNonterminalAndWrongInitialIdentity(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	job, err := s.Enqueue(ctx, model.Job{Kind: "check", Actor: "fixture", IdempotencyKey: "unchanged-identity", Parameters: map[string]any{"target": "original"}})
	if err != nil {
		t.Fatal(err)
	}
	raw := finishRawJob(t, s, job.ID)
	if err = s.Finish(ctx, job); !errors.Is(err, ErrInvalid) {
		t.Fatal("nonterminal finish accepted", err)
	}
	job.Status = "succeeded"
	other := job
	other.Parameters = map[string]any{"target": "different"}
	if err = s.Finish(ctx, other); !errors.Is(err, ErrConflict) {
		t.Fatal("initial target identity changed", err)
	}
	if !bytes.Equal(raw, finishRawJob(t, s, job.ID)) {
		t.Fatal("refused initial completion mutated job")
	}
	other.ID = "missing-finish-fixture"
	if err = s.Finish(ctx, other); !errors.Is(err, ErrNotFound) {
		t.Fatal("missing job completion acknowledged", err)
	}
}

func TestFinishOldModuleResultDoesNotTouchNewOperationOrRemovedProjection(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	instance, install, err := s.QueueModule(ctx, "local-admin", "finish-old", "", "install", model.ModuleRequest{ModuleID: "forms", Name: "Projection identity", Mode: "local", AdditionalInstance: true})
	if err != nil {
		t.Fatal(err)
	}
	instance.ObservedState = "running"
	install.Status = "succeeded"
	install.Result = map[string]any{"instance": instance}
	if err = s.Finish(ctx, install); err != nil {
		t.Fatal(err)
	}
	removing, removal, err := s.QueueModule(ctx, "local-admin", "finish-new", instance.ID, "remove", model.ModuleRequest{ConfirmName: instance.Name})
	if err != nil {
		t.Fatal(err)
	}
	before, err := Get[model.ModuleInstance](ctx, s, "module_instance", instance.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Finish(ctx, install); err != nil {
		t.Fatal("old commit acknowledgement conflicted with later operation", err)
	}
	after, err := Get[model.ModuleInstance](ctx, s, "module_instance", instance.ID)
	if err != nil || after.Revision != before.Revision || after.LastJobID != removal.ID {
		t.Fatal("old result replaced new projection", err)
	}
	removing.ObservedState = "absent"
	removal.Status = "succeeded"
	removal.Result = map[string]any{"instance": removing}
	if err = s.Finish(ctx, removal); err != nil {
		t.Fatal(err)
	}
	if err = s.Finish(ctx, removal); err != nil {
		t.Fatal("durable removed job retried its deleted module projection", err)
	}
}

func TestFinishConcurrentDifferentResultsKeepExactlyOneAuthoritativeWinner(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	job, err := s.Enqueue(ctx, model.Job{Kind: "check", Actor: "fixture", IdempotencyKey: "two-ready-results"})
	if err != nil {
		t.Fatal(err)
	}
	job.Status = "succeeded"
	start := make(chan struct{})
	type completed struct {
		value int
		err   error
	}
	done := make(chan completed, 2)
	for _, value := range []int{1, 2} {
		go func(value int) {
			candidate := job
			candidate.Result = map[string]any{"value": value}
			<-start
			done <- completed{value, s.Finish(ctx, candidate)}
		}(value)
	}
	close(start)
	winner := 0
	for n := 0; n < 2; n++ {
		got := <-done
		if got.err == nil {
			if winner != 0 {
				t.Fatal("both conflicting results committed")
			}
			winner = got.value
		} else if !errors.Is(got.err, ErrConflict) {
			t.Fatal(got.err)
		}
	}
	actual, err := s.Job(ctx, job.ID)
	if err != nil || actual.Result["value"] != float64(winner) || winner == 0 {
		t.Fatal("authoritative result lost", actual.Result, err)
	}
	audit, events := finishTerminalEvents(t, s, job.ID)
	if audit != 1 || events != 1 {
		t.Fatal("conflicting completion duplicated side effects", audit, events)
	}
}

func TestFinishFailedAndUnknownResultsAreAlsoIdempotent(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	for _, status := range []string{"failed", "unknown"} {
		job, err := s.Enqueue(ctx, model.Job{Kind: "check", Actor: "fixture", IdempotencyKey: status})
		if err != nil {
			t.Fatal(err)
		}
		job.Status = status
		job.Error = "Original outcome"
		job.Result = map[string]any{}
		if err = s.Finish(ctx, job); err != nil {
			t.Fatal(err)
		}
		raw := finishRawJob(t, s, job.ID)
		if err = s.Finish(ctx, job); err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(raw, finishRawJob(t, s, job.ID)) {
			t.Fatal("terminal outcome rewritten", status)
		}
	}
}

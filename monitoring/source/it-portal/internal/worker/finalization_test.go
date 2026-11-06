package worker

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"pl/portal/internal/model"
	"pl/portal/internal/store"
)

func TestWorkerCompletedHandlerSurvivesFinishLockBeyondThirtySeconds(t *testing.T) {
	entered := make(chan struct{}, 1)
	var calls atomic.Int32
	w, s := testWorker(t, func(response http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		response.WriteHeader(http.StatusOK)
		entered <- struct{}{}
	})
	ctx := context.Background()
	job, err := s.Enqueue(ctx, model.Job{Kind: "check", Actor: "finish-fixture", IdempotencyKey: "ready-result", Parameters: map[string]any{"kind": "http", "target": "http://test-source"}})
	if err != nil {
		t.Fatal(err)
	}
	job, err = s.Claim(ctx)
	if err != nil {
		t.Fatal(err)
	}
	blocker, err := s.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(ctx)
	// Only this schema's own row is held: no global module advisory lock.
	if _, err = blocker.Exec(ctx, "SELECT id FROM jobs WHERE id=$1 FOR UPDATE", job.ID); err != nil {
		t.Fatal(err)
	}
	parent, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); w.execute(parent, job) }()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("handler did not execute")
	}
	release := time.NewTimer(31 * time.Second)
	defer release.Stop()
	select {
	case <-done:
		saved, readErr := s.Job(ctx, job.ID)
		t.Fatalf("worker abandoned a ready result while database lock remains: status=%s calls=%d err=%v", saved.Status, calls.Load(), readErr)
	case <-release.C:
	}
	if err = blocker.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(8 * time.Second):
		t.Fatal("ready result did not finalize after own row unlocked")
	}
	saved, err := s.Job(ctx, job.ID)
	if err != nil || saved.Status != "succeeded" || saved.FinishedAt == nil || saved.Result["http_status"] != float64(200) || calls.Load() != 1 {
		t.Fatalf("handler replay or missing durable result: status=%s result=%v calls=%d err=%v", saved.Status, saved.Result, calls.Load(), err)
	}
}

func TestWorkerFinalizationShutdownStopsBackoffAndKeepsInitialFlush(t *testing.T) {
	for _, tc := range []struct {
		name                string
		canceledBeforeFirst bool
		cancelAfter         time.Duration
	}{
		{"backoff", false, 5250 * time.Millisecond},
		{"retry SQL", false, 7250 * time.Millisecond},
		{"initial shutdown flush", true, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := workerStore(t)
			w := New(s, nil, func(string) {})
			ctx := context.Background()
			job, err := s.Enqueue(ctx, model.Job{Kind: "check", Actor: "fixture", IdempotencyKey: "shutdown-flush"})
			if err != nil {
				t.Fatal(err)
			}
			job, err = s.Claim(ctx)
			if err != nil {
				t.Fatal(err)
			}
			job.Status = "succeeded"
			job.Result = map[string]any{"already_computed": true}
			blocker, err := s.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer blocker.Rollback(ctx)
			if _, err = blocker.Exec(ctx, "SELECT id FROM jobs WHERE id=$1 FOR UPDATE", job.ID); err != nil {
				t.Fatal(err)
			}
			parent, cancel := context.WithCancel(ctx)
			defer cancel()
			if tc.canceledBeforeFirst {
				cancel()
			}
			done := make(chan error, 1)
			go func() { done <- w.finishJob(parent, job) }()
			if tc.canceledBeforeFirst {
				// The existing detached shutdown flush still gets its independent chance.
				if err = blocker.Rollback(ctx); err != nil {
					t.Fatal(err)
				}
				select {
				case err = <-done:
					if err != nil {
						t.Fatal(err)
					}
				case <-time.After(2 * time.Second):
					t.Fatal("initial shutdown flush did not complete")
				}
				actual, readErr := s.Job(ctx, job.ID)
				if readErr != nil || actual.Status != "succeeded" {
					t.Fatal("initial flush was canceled with service", actual.Status, readErr)
				}
			} else {
				// First SQL attempt is capped at five seconds; cancellation stops the
				// following two-second backoff, without waiting its full duration.
				select {
				case err = <-done:
					t.Fatal("finalization returned before cancellation", err)
				case <-time.After(tc.cancelAfter):
				}
				cancel()
				select {
				case err = <-done:
					if !errors.Is(err, context.Canceled) {
						t.Fatal("wrong cancellation", err)
					}
				case <-time.After(time.Second):
					t.Fatal("shutdown did not interrupt finalization wait")
				}
			}
		})
	}
}

func TestWorkerFinalizationIdentityConflictStopsWithoutRetry(t *testing.T) {
	s := workerStore(t)
	w := New(s, nil, func(string) {})
	ctx := context.Background()
	job, err := s.Enqueue(ctx, model.Job{Kind: "check", Actor: "fixture", IdempotencyKey: "terminal-conflict"})
	if err != nil {
		t.Fatal(err)
	}
	job.Status = "succeeded"
	job.Result = map[string]any{"value": 1}
	if err = s.Finish(ctx, job); err != nil {
		t.Fatal(err)
	}
	job.Result = map[string]any{"value": 2}
	started := time.Now()
	if err = w.finishJob(ctx, job); !errors.Is(err, store.ErrConflict) {
		t.Fatal(err)
	}
	if time.Since(started) > time.Second {
		t.Fatal("permanent result conflict entered retry backoff")
	}
}

func TestWorkerFinalizationErrorInfoNeverIncludesDatabaseMessage(t *testing.T) {
	for _, code := range []string{"40001", "57P01", "secret-value", "x2345"} {
		err := fmt.Errorf("private-wrapper: %w", &pgconn.PgError{Code: code, Message: "secret-password", Detail: "private SQL and parameters"})
		state, errorType := finishErrorInfo(err)
		if errorType != "*fmt.wrapError" {
			t.Fatal("unexpected type metadata", errorType)
		}
		if code == "40001" || code == "57P01" {
			if state != code {
				t.Fatal("SQLSTATE absent", state)
			}
		} else if state != "" {
			t.Fatal("invalid SQLSTATE leaked", state)
		}
	}
}

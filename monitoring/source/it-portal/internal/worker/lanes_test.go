package worker

import (
	"context"
	"fmt"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/store"
)

type blockedLifecycleModules struct {
	store       *store.Store
	started     chan string
	permits     chan struct{}
	active      atomic.Int32
	maxInstalls atomic.Int32
}

func (m *blockedLifecycleModules) Execute(ctx context.Context, j model.Job) (map[string]any, error) {
	action, _ := j.Parameters["action"].(string)
	if action != "refresh" {
		active := m.active.Add(1)
		defer m.active.Add(-1)
		for old := m.maxInstalls.Load(); active > old; old = m.maxInstalls.Load() {
			if m.maxInstalls.CompareAndSwap(old, active) {
				break
			}
		}
		m.started <- j.ID
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-m.permits:
		}
	}
	id, _ := j.Parameters["instance_id"].(string)
	instance, err := store.Get[model.ModuleInstance](ctx, m.store, "module_instance", id)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	instance.LastAttempt = &now
	instance.LastSuccess = &now
	instance.ObservedState = "running"
	return map[string]any{"instance": instance}, nil
}

func waitLaneJob(t *testing.T, s *store.Store, id, status string) {
	t.Helper()
	deadline := time.NewTimer(8 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		j, err := s.Job(context.Background(), id)
		if err != nil {
			t.Fatal(err)
		}
		if j.Status == status {
			return
		}
		select {
		case <-deadline.C:
			t.Fatalf("job %s status %s, want %s", id, j.Status, status)
		case <-tick.C:
		}
	}
}

func TestWorkerReservedHealthLaneProgressAndCancellation(t *testing.T) {
	w, s := testWorker(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	modules := &blockedLifecycleModules{store: s, started: make(chan string, 8), permits: make(chan struct{}, 8)}
	w.Modules = modules
	// Establish the health module without running a worker or a provider request.
	healthy, seed, err := s.QueueModule(ctx, "test", "health-seed", "", "install", model.ModuleRequest{ModuleID: "forms", Name: "Health", Mode: "local", AdditionalInstance: true})
	if err != nil {
		t.Fatal(err)
	}
	healthy.ObservedState = "running"
	seed.Status = "succeeded"
	seed.Result = map[string]any{"instance": healthy}
	if err = s.Finish(ctx, seed); err != nil {
		t.Fatal(err)
	}
	queueInstall := func(n int) model.Job {
		_, j, err := s.QueueModule(ctx, "test", fmt.Sprintf("blocked-%d", n), "", "install", model.ModuleRequest{ModuleID: "forms", Name: fmt.Sprintf("Install %d", n), Mode: "local", AdditionalInstance: true})
		if err != nil {
			t.Fatal(err)
		}
		return j
	}
	installs := make([]model.Job, 4)
	for n := range installs {
		installs[n] = queueInstall(n)
	}
	// The younger health job must pass four older lifecycle jobs.
	_, health, err := s.QueueModule(ctx, "system:modules", "health-refresh", healthy.ID, "refresh", model.ModuleRequest{})
	if err != nil {
		t.Fatal(err)
	}
	ordinary, err := s.Enqueue(ctx, model.Job{Kind: "check", Actor: "test", IdempotencyKey: "ordinary", Parameters: map[string]any{"kind": "http", "target": "http://check.test"}})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { defer close(done); w.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(8 * time.Second):
			t.Error("worker leaked after cancellation")
		}
	})
	for n := 0; n < 2; n++ {
		select {
		case <-modules.started:
		case <-time.After(5 * time.Second):
			t.Fatal("lifecycle lane did not start")
		}
	}
	waitLaneJob(t, s, health.ID, "succeeded")
	// Only two lifecycle jobs may run; the remainder and ordinary work stay queued.
	if got := modules.active.Load(); got != 2 {
		t.Fatalf("running installs=%d, want 2", got)
	}
	queued := 0
	for _, j := range installs {
		current, err := s.Job(ctx, j.ID)
		if err != nil {
			t.Fatal(err)
		}
		if current.Status == "queued" {
			queued++
		}
	}
	if queued != 2 {
		t.Fatalf("queued installs=%d, want 2", queued)
	}
	current, err := s.Job(ctx, ordinary.ID)
	if err != nil || current.Status != "queued" {
		t.Fatalf("ordinary work escaped occupied lane: %+v %v", current, err)
	}
	// Release the queue in order; ordinary types still make progress afterwards.
	for n := 0; n < 4; n++ {
		modules.permits <- struct{}{}
	}
	waitLaneJob(t, s, ordinary.ID, "succeeded")
	// Drain the start notifications for installs 3 and 4 before the cancellation phase.
	for n := 0; n < 2; n++ {
		select {
		case <-modules.started:
		case <-time.After(5 * time.Second):
			t.Fatal("remaining lifecycle jobs lost")
		}
	}
	for _, j := range installs {
		waitLaneJob(t, s, j.ID, "succeeded")
	}
	canceled := []model.Job{queueInstall(4), queueInstall(5)}
	for range canceled {
		select {
		case <-modules.started:
		case <-time.After(5 * time.Second):
			t.Fatal("cancellation phase did not start")
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(8 * time.Second):
		t.Fatal("Run did not await canceled executions")
	}
	if modules.active.Load() != 0 || modules.maxInstalls.Load() > 2 {
		t.Fatalf("leaked/excess lifecycle executions: active=%d max=%d", modules.active.Load(), modules.maxInstalls.Load())
	}
	for _, j := range canceled {
		waitLaneJob(t, s, j.ID, "unknown")
	}
	// Shutdown must release the dedicated leader lease as well as execution slots.
	conn, err := s.Pool.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	var owner bool
	if err = conn.QueryRow(context.Background(), "SELECT pg_try_advisory_lock(7398216)").Scan(&owner); err != nil || !owner {
		t.Fatalf("leader lease leaked: %v %v", owner, err)
	}
	if _, err = conn.Exec(context.Background(), "SELECT pg_advisory_unlock(7398216)"); err != nil {
		t.Fatal(err)
	}
}

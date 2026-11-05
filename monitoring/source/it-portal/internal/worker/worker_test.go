package worker

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"pl/portal/internal/model"
	"pl/portal/internal/netguard"
	"pl/portal/internal/providers"
	"pl/portal/internal/store"
)

func workerStore(t *testing.T) *store.Store {
	t.Helper()
	dsn := os.Getenv("PORTAL_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("PORTAL_TEST_DATABASE_URL required for worker integration tests")
	}
	ctx := context.Background()
	conn, e := pgx.Connect(ctx, dsn)
	if e != nil {
		t.Fatal(e)
	}
	schema := "portal_worker_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, e = conn.Exec(ctx, "CREATE SCHEMA "+quoted); e != nil {
		conn.Close(ctx)
		t.Fatal(e)
	}
	t.Cleanup(func() {
		_, _ = conn.Exec(context.Background(), "DROP SCHEMA "+quoted+" CASCADE")
		conn.Close(context.Background())
	})
	// Serialize first-install DDL with other package helpers and Store.Migrate.
	// Release this transaction before Open acquires the migration lock itself.
	if e = func() error {
		tx, err := conn.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(7398215)"); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, "CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public"); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}(); e != nil {
		t.Fatal(e)
	}
	u, e := url.Parse(dsn)
	if e != nil {
		t.Fatal(e)
	}
	q := u.Query()
	q.Set("search_path", schema+",public")
	u.RawQuery = q.Encode()
	s, e := store.Open(ctx, u.String())
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(s.Pool.Close)
	if e = s.Defaults(ctx); e != nil {
		t.Fatal(e)
	}
	return s
}

type testResolver struct{}

func (testResolver) LookupIPAddr(context.Context, string) ([]net.IPAddr, error) {
	return []net.IPAddr{{IP: net.ParseIP("10.1.1.1")}}, nil
}
func testWorker(t *testing.T, h http.HandlerFunc, executorURL ...string) (*Worker, *store.Store) {
	t.Helper()
	s := workerStore(t)
	server := httptest.NewServer(h)
	t.Cleanup(server.Close)
	guard, e := netguard.NewWithDependencies([]string{"10.0.0.0/8"}, []int{80}, "", testResolver{}, func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(server.URL, "http://"))
	})
	if e != nil {
		t.Fatal(e)
	}
	executor := ""
	if len(executorURL) > 0 {
		executor = executorURL[0]
	}
	return New(s, providers.New(guard, executor), func(string) {}), s
}
func workerIntegration(t *testing.T, s *store.Store, kind string) model.Integration {
	t.Helper()
	i := model.Integration{ID: uuid.NewString(), Name: kind, Kind: kind, URL: "http://test-source", Enabled: true, PollSeconds: 30, TimeoutSeconds: 1, Concurrency: 1}
	b, e := s.Save(context.Background(), "integration", i.ID, 0, i, "test")
	if e != nil {
		t.Fatal(e)
	}
	i, e = store.Decode[model.Integration](b)
	if e != nil {
		t.Fatal(e)
	}
	return i
}
func initialProblem(t *testing.T, s *store.Store, i model.Integration) {
	t.Helper()
	if e := s.ApplySnapshot(context.Background(), i, model.Snapshot{Problems: []model.Problem{{ExternalID: "a", Title: "Alert remains active", StartedAt: time.Now().Add(-time.Minute)}}}, nil); e != nil {
		t.Fatal(e)
	}
}
func activeResponse(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode([]map[string]any{{"fingerprint": "a", "labels": map[string]string{"alertname": "Down"}, "startsAt": "2026-09-25T00:00:00Z", "status": map[string]any{"state": "active", "silencedBy": []string{}, "inhibitedBy": []string{}}}})
}
func awaitSignal(t *testing.T, c <-chan struct{}) {
	t.Helper()
	select {
	case <-c:
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for controlled fixture")
	}
}
func TestWorkerSourceDeadlinePersistsFailureWithoutFalseRecovery(t *testing.T) {
	w, s := testWorker(t, func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() })
	i := workerIntegration(t, s, "alertmanager")
	initialProblem(t, s, i)
	started := time.Now()
	if e := w.poll(context.Background(), i); e == nil {
		t.Fatal("timed out source reported success")
	}
	actual, e := store.Get[model.Integration](context.Background(), s, "integration", i.ID)
	if e != nil || actual.Status != "error" || actual.LastAttempt == nil || actual.LastAttempt.Before(started) {
		t.Fatal("timeout state not persisted", actual, e)
	}
	problems, e := s.Problems(context.Background())
	if e != nil || len(problems) != 1 || problems[0].Status != "firing" || !problems[0].Stale {
		t.Fatal("deadline lost previous snapshot", problems, e)
	}
}
func TestWorkerPeriodicAndManualPollSerialize(t *testing.T) {
	firstEntered := make(chan struct{})
	secondEntered := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int32
	w, s := testWorker(t, func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			close(firstEntered)
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
			_, _ = w.Write([]byte(`[]`))
			return
		}
		close(secondEntered)
		activeResponse(w)
	})
	i := workerIntegration(t, s, "alertmanager")
	initialProblem(t, s, i)
	done := make(chan error, 1)
	go func() { done <- w.poll(context.Background(), i) }()
	awaitSignal(t, firstEntered)
	j, e := s.Enqueue(context.Background(), model.Job{Kind: "refresh", IntegrationID: i.ID, Actor: "operator", IdempotencyKey: "manual-refresh"})
	if e != nil {
		t.Fatal(e)
	}
	j, e = s.Claim(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	manualDone := make(chan struct{})
	go func() { w.execute(context.Background(), j); close(manualDone) }()
	select {
	case <-secondEntered:
		t.Fatal("manual poll bypassed per-source serialization")
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	if e = <-done; e != nil {
		t.Fatal(e)
	}
	awaitSignal(t, secondEntered)
	awaitSignal(t, manualDone)
	problems, e := s.Problems(context.Background())
	if e != nil || len(problems) != 1 || problems[0].Status != "firing" {
		t.Fatal("older snapshot overwrote later manual result", problems, e)
	}
}
func TestWorkerDisabledDuringPollCannotResolve(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	w, s := testWorker(t, func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		_, _ = w.Write([]byte(`[]`))
	})
	i := workerIntegration(t, s, "alertmanager")
	initialProblem(t, s, i)
	done := make(chan error, 1)
	go func() { done <- w.poll(context.Background(), i) }()
	awaitSignal(t, entered)
	disabled := i
	disabled.Enabled = false
	if _, e := s.Save(context.Background(), "integration", i.ID, i.Revision, disabled, "operator"); e != nil {
		t.Fatal(e)
	}
	close(release)
	if e := <-done; !errors.Is(e, store.ErrConflict) {
		t.Fatal("obsolete configuration not rejected", e)
	}
	problems, e := s.Problems(context.Background())
	if e != nil || problems[0].Status != "firing" || !problems[0].Stale {
		t.Fatal("disabled source resolved alert", problems, e)
	}
}
func TestWorkerBoundsAutomaticPollsAndPollsHealthSources(t *testing.T) {
	entered := make(chan struct{}, 12)
	release := make(chan struct{})
	var active, maxActive atomic.Int32
	w, s := testWorker(t, func(w http.ResponseWriter, r *http.Request) {
		n := active.Add(1)
		defer active.Add(-1)
		for old := maxActive.Load(); n > old; old = maxActive.Load() {
			if maxActive.CompareAndSwap(old, n) {
				break
			}
		}
		entered <- struct{}{}
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		switch r.URL.Path {
		case "/api/health":
			_, _ = w.Write([]byte(`{"database":"ok"}`))
		case "/health":
			_, _ = w.Write([]byte(`{"ok":true}`))
		default:
			_, _ = w.Write([]byte(`[]`))
		}
	})
	for n := 0; n < 8; n++ {
		kind := "alertmanager"
		if n == 6 {
			kind = "grafana"
		}
		if n == 7 {
			kind = "reports"
		}
		workerIntegration(t, s, kind)
	}
	w.schedule(context.Background())
	for n := 0; n < 4; n++ {
		awaitSignal(t, entered)
	}
	select {
	case <-entered:
		t.Fatal("automatic polling exceeded global limit4")
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	w.pollWG.Wait()
	if maxActive.Load() != 4 {
		t.Fatal(maxActive.Load())
	}
	w.schedule(context.Background())
	w.pollWG.Wait()
	integrations, e := store.List[model.Integration](context.Background(), s, "integration")
	if e != nil {
		t.Fatal(e)
	}
	for _, i := range integrations {
		if i.Status != "connected" {
			t.Error("enabled source was not polled", i.Kind, i.Status)
		}
	}
}
func TestWorkerSourceLockHonorsWaitingCancellation(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	w, s := testWorker(t, func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		_, _ = w.Write([]byte(`[]`))
	})
	i := workerIntegration(t, s, "alertmanager")
	done := make(chan error, 1)
	go func() { done <- w.poll(context.Background(), i) }()
	awaitSignal(t, entered)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	if e := w.poll(ctx, i); !errors.Is(e, context.DeadlineExceeded) {
		t.Fatal(e)
	}
	if time.Since(start) > 300*time.Millisecond {
		t.Fatal("source lock ignored waiting context")
	}
	close(release)
	if e := <-done; e != nil {
		t.Fatal(e)
	}
}
func TestWorkerConcurrentSchedulerDoesNotDuplicateDueChecks(t *testing.T) {
	w, s := testWorker(t, func(http.ResponseWriter, *http.Request) {})
	id := uuid.NewString()
	resource := model.Resource{ID: id, Name: "Endpoint", URL: "http://service", Lifecycle: "active", Check: model.Check{Kind: "http", IntervalSeconds: 30}}
	if _, e := s.Save(context.Background(), "resource", id, 0, resource, "operator"); e != nil {
		t.Fatal(e)
	}
	var wg sync.WaitGroup
	for n := 0; n < 8; n++ {
		wg.Add(1)
		go func() { defer wg.Done(); w.schedule(context.Background()) }()
	}
	wg.Wait()
	jobs, e := s.Jobs(context.Background())
	if e != nil || len(jobs) != 1 || jobs[0].Kind != "check" {
		t.Fatal("duplicate scheduled check", jobs, e)
	}
}

func TestWorkerSuccessfulPollHonorsLongIntervalAndErrorsBackOff(t *testing.T) {
	var fail atomic.Bool
	w, s := testWorker(t, func(w http.ResponseWriter, r *http.Request) {
		if fail.Load() {
			w.WriteHeader(503)
			return
		}
		_, _ = w.Write([]byte(`[]`))
	})
	i := workerIntegration(t, s, "alertmanager")
	i.PollSeconds = 7200
	b, e := s.Save(context.Background(), "integration", i.ID, i.Revision, i, "test")
	if e != nil {
		t.Fatal(e)
	}
	i, e = store.Decode[model.Integration](b)
	if e != nil {
		t.Fatal(e)
	}
	for _, tc := range []struct {
		failure bool
		want    time.Duration
	}{{false, 2 * time.Hour}, {true, 4 * time.Hour}, {false, 2 * time.Hour}} {
		fail.Store(tc.failure)
		e = w.poll(context.Background(), i)
		if (e != nil) != tc.failure {
			t.Fatal(e)
		}
		w.mu.Lock()
		remaining := time.Until(w.next[i.ID])
		w.mu.Unlock()
		if remaining < tc.want-time.Second || remaining > tc.want+time.Second {
			t.Fatalf("poll failure=%v interval=%v want=%v", tc.failure, remaining, tc.want)
		}
	}
}

func TestWorkerRestartCreatesSeparateConfiguredCheck(t *testing.T) {
	for _, tc := range []struct {
		name        string
		check       model.Check
		rejectCheck bool
	}{
		{name: "HTTP result remains distinct", check: model.Check{Kind: "http"}},
		{name: "Failed verification preserves restart", check: model.Check{Kind: "dns", Target: "127.0.0.1"}},
		{name: "No configured check"},
		{name: "Queue failure preserves restart", check: model.Check{Kind: "http"}, rejectCheck: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir, e := os.MkdirTemp("/tmp", "portal-wexec-")
			if e != nil {
				t.Fatal(e)
			}
			t.Cleanup(func() { os.RemoveAll(dir) })
			socket := filepath.Join(dir, "executor.sock")
			listener, e := net.Listen("unix", socket)
			if e != nil {
				t.Fatal(e)
			}
			var calls atomic.Int32
			executor := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "POST" || r.URL.Path != "/v1/restart" {
					t.Error("unexpected executor request", r.Method, r.URL.Path)
				}
				var request map[string]string
				if e := json.NewDecoder(r.Body).Decode(&request); e != nil || request["target"] != "allowed-app" || request["request_id"] == "" {
					t.Error("invalid executor payload", e)
				}
				calls.Add(1)
				_, _ = w.Write([]byte(`{"status":"succeeded","container_id":"mock-container"}`))
			})}
			go executor.Serve(listener)
			t.Cleanup(func() { executor.Close() })
			worker, s := testWorker(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }, "unix://"+socket)
			resource := model.Resource{ID: uuid.NewString(), Name: "Allowed service", URL: "http://service.test", Lifecycle: "active", Operations: []string{"restart"}, ExecutorTarget: "allowed-app", Check: tc.check}
			if _, e = s.Save(context.Background(), "resource", resource.ID, 0, resource, "operator"); e != nil {
				t.Fatal(e)
			}
			if tc.rejectCheck {
				if _, e = s.Pool.Exec(context.Background(), "ALTER TABLE jobs ADD CONSTRAINT fixture_reject_checks CHECK(kind <> 'check')"); e != nil {
					t.Fatal(e)
				}
			}
			restart, e := s.Enqueue(context.Background(), model.Job{Kind: "restart", ResourceID: resource.ID, Actor: "operator", Confirmed: true, IdempotencyKey: "confirmed-once", Parameters: map[string]any{"executor_target": "allowed-app"}})
			if e != nil {
				t.Fatal(e)
			}
			claimed, e := s.Claim(context.Background())
			if e != nil {
				t.Fatal(e)
			}
			worker.execute(context.Background(), claimed)
			saved, e := s.Job(context.Background(), restart.ID)
			if e != nil || saved.Status != "succeeded" || calls.Load() != 1 {
				t.Fatal("restart result changed", saved.Status, calls.Load(), e)
			}
			checkID, _ := saved.Result["post_check_job_id"].(string)
			if tc.check.Kind == "" || tc.rejectCheck {
				if checkID != "" {
					t.Fatal("unexpected follow-up", saved.Result)
				}
				if tc.rejectCheck && saved.Result["post_check_warning"] == nil {
					t.Fatal("enqueue failure was hidden")
				}
				if _, e = s.Claim(context.Background()); !errors.Is(e, store.ErrNotFound) {
					t.Fatal("unexpected job", e)
				}
				return
			}
			if checkID == "" {
				t.Fatal("configured verification not linked", saved.Result)
			}
			followup, e := s.Claim(context.Background())
			if e != nil || followup.ID != checkID || followup.Kind != "check" || followup.Actor != "operator" || followup.ResourceID != resource.ID {
				t.Fatal("invalid follow-up", followup, e)
			}
			worker.execute(context.Background(), followup)
			checked, e := s.Job(context.Background(), checkID)
			if e != nil {
				t.Fatal(e)
			}
			if tc.check.Kind == "dns" && checked.Status != "failed" {
				t.Fatal("fixture must fail verification", checked)
			}
			if tc.check.Kind == "http" && (checked.Result["http_success"] != false || checked.Result["http_status"] != float64(503)) {
				t.Fatal("HTTP observation missing", checked.Result)
			}
			saved, e = s.Job(context.Background(), restart.ID)
			if e != nil || saved.Status != "succeeded" {
				t.Fatal("verification overwrote restart", saved, e)
			}
		})
	}
}

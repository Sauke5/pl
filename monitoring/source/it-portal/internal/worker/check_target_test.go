package worker

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"pl/portal/internal/model"
)

func TestSchedulerSkipsLegacyInvalidTargetsWithoutPersistingJobs(t *testing.T) {
	w, s := testWorker(t, func(http.ResponseWriter, *http.Request) {
		t.Error("scheduling must not execute a network check")
	})
	ctx := context.Background()
	for _, target := range []string{"", "host-without-port", "host:invalid", "[::1]"} {
		id := uuid.NewString()
		resource := model.Resource{ID: id, Name: "Legacy host", Type: "Сервер", Hostname: "legacy-host", Lifecycle: "active", Check: model.Check{Kind: "tcp", Target: target, IntervalSeconds: 50}}
		// Save bypasses API validation to reproduce already persisted configuration.
		if _, err := s.Save(ctx, "resource", id, 0, resource, "fixture"); err != nil {
			t.Fatal(err)
		}
	}
	// Persisted data can bypass API validation; ICMP must remain manual-only.
	icmpID := uuid.NewString()
	if _, err := s.Save(ctx, "resource", icmpID, 0, model.Resource{ID: icmpID, Name: "Manual ICMP", Lifecycle: "active", Check: model.Check{Kind: "icmp", Target: "192.0.2.10", IntervalSeconds: 50}}, "fixture"); err != nil {
		t.Fatal(err)
	}
	for n := 0; n < 2; n++ {
		w.schedule(ctx)
		jobs, err := s.Jobs(ctx)
		if err != nil || len(jobs) != 0 {
			t.Fatalf("scheduler persisted invalid check jobs on pass %d: %+v, %v", n, jobs, err)
		}
		// Make the second pass due without a 50-second sleep.
		w.mu.Lock()
		for key := range w.next {
			w.next[key] = time.Time{}
		}
		w.mu.Unlock()
	}
}

func TestSchedulerPreservesHTTPResourceURLFallback(t *testing.T) {
	w, s := testWorker(t, func(http.ResponseWriter, *http.Request) {
		t.Error("scheduling must not execute a network check")
	})
	ctx := context.Background()
	id := uuid.NewString()
	resource := model.Resource{ID: id, Name: "Web service", URL: "https://service.example.test/status", Lifecycle: "active", Check: model.Check{Kind: "http", IntervalSeconds: 50}}
	if _, err := s.Save(ctx, "resource", id, 0, resource, "fixture"); err != nil {
		t.Fatal(err)
	}
	w.schedule(ctx)
	w.schedule(ctx)
	jobs, err := s.Jobs(ctx)
	if err != nil || len(jobs) != 1 {
		t.Fatalf("expected one scheduled check, got %+v, %v", jobs, err)
	}
	j := jobs[0]
	if j.Kind != "check" || j.ResourceID != id || j.Actor != "system" || j.Parameters["kind"] != "http" || j.Parameters["target"] != resource.URL {
		t.Fatalf("incorrect scheduled URL fallback: %+v", j)
	}
}

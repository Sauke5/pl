package providers

import (
	"context"
	"encoding/json"
	"net/http"
	"pl/portal/internal/model"
	"strings"
	"testing"
	"time"
)

func TestWaylineSnapshotAuthAndFreshness(t *testing.T) {
	t.Setenv("PORTAL_SECRET_REFS", "env:PORTAL_SECRET_WAYLINE")
	t.Setenv("PORTAL_SECRET_WAYLINE", "test-password")
	now := time.Now().UTC()
	r := registry(t, func(w http.ResponseWriter, q *http.Request) {
		u, p, ok := q.BasicAuth()
		if !ok || u != "portal" || p != "test-password" {
			t.Error("missing Basic auth")
		}
		if q.URL.Path == "/wayline/api/v1/targets" {
			_, _ = w.Write([]byte(`{"targets":[{"id":1,"name":"Router","host":"router","enabled":true,"interval_seconds":60,"iperf_enabled":true},{"id":2,"name":"Empty","host":"empty","enabled":true,"interval_seconds":60}]}`))
			return
		}
		if q.URL.Path != "/wayline/api/v1/checks/latest" {
			t.Error(q.URL.Path)
		}
		kind := q.URL.Query().Get("kind")
		finished := now
		if kind == "iperf" {
			finished = now.Add(-48 * time.Hour)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"checks": []map[string]any{{"id": 5, "target_id": 1, "kind": kind, "status": "success", "started_at": finished.Add(-time.Second), "finished_at": finished, "loss_percent": 0, "avg_latency_ms": 2.4, "throughput_bps": 125000}}})
	})
	targets, err := r.Wayline(context.Background(), model.Integration{URL: "http://test/wayline", SecretRef: "env:PORTAL_SECRET_WAYLINE", Config: map[string]string{"basic_username": "portal"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(targets) != 2 || targets[0].Path == nil || targets[0].Path.Status != "success" || targets[0].Path.Stale || targets[0].Iperf == nil || !targets[0].Iperf.Stale || targets[1].Path != nil {
		t.Fatalf("invalid snapshot: %+v", targets)
	}
}

func TestWaylineRejectsMalformedAndHTTPFailures(t *testing.T) {
	for _, body := range []string{`null`, `{}`, `{"targets":null}`, `{"targets":[{"id":1}]}`, `<html>secret</html>`} {
		t.Run(body, func(t *testing.T) {
			r := registry(t, func(w http.ResponseWriter, q *http.Request) { _, _ = w.Write([]byte(body)) })
			if _, err := r.Wayline(context.Background(), model.Integration{URL: "http://test"}); err == nil {
				t.Fatal("accepted invalid source")
			}
		})
	}
	for _, status := range []int{301, 401, 403, 500} {
		r := registry(t, func(w http.ResponseWriter, q *http.Request) {
			w.Header().Set("Location", "http://test/leak")
			w.WriteHeader(status)
			_, _ = w.Write([]byte("private-password"))
		})
		_, err := r.Wayline(context.Background(), model.Integration{URL: "http://test"})
		if err == nil || strings.Contains(err.Error(), "private-password") {
			t.Fatalf("unsafe error %v", err)
		}
	}
}

func TestWaylineTimeoutAndPartialSnapshot(t *testing.T) {
	r := registry(t, func(w http.ResponseWriter, q *http.Request) { <-q.Context().Done() })
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if _, err := r.Wayline(ctx, model.Integration{URL: "http://test"}); err == nil {
		t.Fatal("timeout accepted")
	}
	r = registry(t, func(w http.ResponseWriter, q *http.Request) {
		if q.URL.Path == "/api/v1/targets" {
			_, _ = w.Write([]byte(`{"targets":[]}`))
			return
		}
		_, _ = w.Write([]byte(`{"checks":null}`))
	})
	if _, err := r.Wayline(context.Background(), model.Integration{URL: "http://test"}); err == nil {
		t.Fatal("partial snapshot accepted")
	}
}

func TestWaylineUnknownMeasurementsNeverHealthy(t *testing.T) {
	r := registry(t, func(w http.ResponseWriter, q *http.Request) {
		if q.URL.Path == "/api/v1/targets" {
			_, _ = w.Write([]byte(`{"targets":[{"id":1,"name":"Router","host":"router","interval_seconds":60}]}`))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"checks": []map[string]any{{"id": 1, "target_id": 1, "kind": q.URL.Query().Get("kind"), "status": "success", "started_at": time.Now().Add(-time.Second), "finished_at": time.Now()}}})
	})
	targets, err := r.Wayline(context.Background(), model.Integration{URL: "http://test"})
	if err != nil {
		t.Fatal(err)
	}
	if targets[0].Path.Status != "unknown" || targets[0].Iperf.Status != "unknown" {
		t.Fatal("missing values marked healthy")
	}
}

func TestWaylinePolicyAndSecretsBlockBeforeRequest(t *testing.T) {
	r := registry(t, func(w http.ResponseWriter, q *http.Request) { t.Error("forbidden request reached upstream") })
	for _, source := range []model.Integration{
		{URL: "http://test:8585"}, // Test guard allows only 80/443.
		{URL: "http://user:password@test"},
		{URL: "http://test", SecretRef: "env:PORTAL_SECRET_NOT_ALLOWED", Config: map[string]string{"basic_username": "portal"}},
	} {
		if _, err := r.Wayline(context.Background(), source); err == nil {
			t.Fatal("forbidden source accepted")
		}
	}
}

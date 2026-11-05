package providers

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"pl/portal/internal/model"
)

func TestManagedPrometheusFeedsDiscoveryAndOptionsThroughOneTransport(t *testing.T) {
	// A nil generic guard is deliberate: managed reads must not use the ordinary
	// source URL, secrets or broader network allowlist.
	r := New(nil, "")
	i := model.Integration{ID: "integration", ManagedModuleID: "module", Kind: "prometheus", Enabled: true, URL: "http://127.0.0.1:65535/ignored", SecretRef: "not-an-allowed-secret"}
	calls := 0
	r.ManagedRead = func(ctx context.Context, got model.Integration, path, query string) (*http.Response, error) {
		calls++
		if got.ID != i.ID || path != "/api/v1/targets" || query != "" {
			t.Fatalf("wrong managed transport contract %+v %s %s", got, path, query)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"status":"success","data":{"activeTargets":[{"scrapePool":"node","labels":{"job":"node","instance":"host:9100"},"scrapeUrl":"http://host:9100/metrics","health":"up","lastScrape":"2026-10-17T12:00:00Z"}]}}`))}, nil
	}
	snapshot, err := r.Poll(context.Background(), i)
	if err != nil || len(snapshot.Candidates) != 1 || snapshot.Candidates[0].Labels["job"] != "node" {
		t.Fatalf("managed discovery %+v %v", snapshot, err)
	}
	options, err := r.PrometheusOptions(context.Background(), i, "node", "instance")
	if err != nil || options.TargetCount != 1 || len(options.Jobs) != 1 || len(options.Values) != 1 || calls != 2 {
		t.Fatalf("managed options %+v %v calls=%d", options, err, calls)
	}
	if _, err := r.request(context.Background(), i, "POST", "/api/v1/query", map[string]string{"query": "up"}); err == nil {
		t.Fatal("managed write accepted")
	}
	if calls != 2 {
		t.Fatal("write reached managed reader")
	}
	r.ManagedRead = func(context.Context, model.Integration, string, string) (*http.Response, error) {
		return nil, errors.New("unavailable")
	}
	if _, err := r.Poll(context.Background(), i); err == nil {
		t.Fatal("managed read failure hidden")
	}
	r.ManagedRead = nil
	if _, err := r.Poll(context.Background(), i); err == nil {
		t.Fatal("missing managed reader fell back to ordinary guard")
	}
}

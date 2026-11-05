package providers

import (
	"context"
	"net/http"
	"testing"

	"pl/portal/internal/model"
)

func TestMonitoringTargetsIndependentOfDiscovery(t *testing.T) {
	r := registry(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"success","data":{"activeTargets":[{"scrapePool":"node","health":"down","labels":{"job":"node","instance":"host:9100","token":"private"},"scrapeUrl":"http://host:9100/metrics","lastScrape":"2026-10-23T10:00:00Z"}]}}`))
	})
	for _, config := range []map[string]string{{"discovery_enabled": "false"}, {"include_job": "windows"}} {
		snapshot, err := r.Poll(context.Background(), model.Integration{ID: "source", Kind: "prometheus", URL: "http://test", Config: config})
		if err != nil || len(snapshot.Targets) != 1 || len(snapshot.Candidates) != 0 {
			t.Fatalf("snapshot=%+v err=%v", snapshot, err)
		}
		target := snapshot.Targets[0]
		if target.Health != "down" || target.Labels["token"] != "" || target.LastScrape.IsZero() || target.ExternalID == "" {
			t.Fatalf("unsafe or incomplete observation: %+v", target)
		}
	}
}

func TestMalformedTargetRejectedWithDiscoveryDisabled(t *testing.T) {
	for _, body := range []string{
		`{"status":"success","data":{"activeTargets":[{"scrapePool":"node","health":"up","labels":{"job":"node"},"scrapeUrl":"http://user:pass@host/metrics"}]}}`,
		`{"status":"success","data":{"activeTargets":[{"scrapePool":"node","health":"broken","labels":{"job":"node"},"scrapeUrl":"http://host/metrics"}]}}`,
	} {
		r := registry(t, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(body)) })
		if _, err := r.Poll(context.Background(), model.Integration{Kind: "prometheus", URL: "http://test", Config: map[string]string{"discovery_enabled": "false"}}); err == nil {
			t.Fatal("accepted malformed monitoring target")
		}
	}
}

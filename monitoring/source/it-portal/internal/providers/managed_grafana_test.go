package providers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"pl/portal/internal/model"
)

func TestManagedGrafanaSavedPanelUsesReadOnlyModuleQueryTransport(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	r := New(nil, "")
	source := model.Integration{ID: "grafana", ManagedModuleID: "owned-grafana", Kind: "grafana", Enabled: true, URL: "not-authoritative", SecretRef: "not-allowlisted"}
	r.ManagedRead = func(_ context.Context, got model.Integration, path, query string) (*http.Response, error) {
		if got.ID != source.ID || got.ManagedModuleID != source.ManagedModuleID {
			t.Fatal("module identity changed")
		}
		var raw string
		switch path {
		case "/api/dashboards/uid/board":
			body, _ := json.Marshal(fixtureDashboard())
			raw = string(body)
		case "/api/datasources":
			raw = `[{"uid":"prom","name":"Prometheus","type":"prometheus","isDefault":true}]`
		default:
			t.Fatal("unexpected managed Grafana read", path)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(raw))}, nil
	}
	queries := 0
	r.ManagedRequest = func(_ context.Context, got model.Integration, method, path, query, contentType string, body []byte) (*http.Response, error) {
		queries++
		if got.ID != source.ID || method != http.MethodPost || path != "/api/ds/query" || query != "" || contentType != "application/json" {
			t.Fatal("unexpected managed query contract")
		}
		var payload struct {
			Queries []map[string]any `json:"queries"`
		}
		if json.Unmarshal(body, &payload) != nil || len(payload.Queries) != 1 || payload.Queries[0]["datasource"].(map[string]any)["uid"] != "prom" {
			t.Fatal("saved panel datasource query lost")
		}
		raw := fmt.Sprintf(`{"results":{"A":{"status":200,"frames":[{"schema":{"fields":[{"name":"Time","type":"time"},{"name":"Value","type":"number","labels":{"instance":"host","token":"private-source-label"}}]},"data":{"values":[[%d],[12.5]]}}]}}}`, now.UnixMilli())
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(raw))}, nil
	}
	out, err := r.GrafanaQuery(context.Background(), source, GrafanaQuery{DashboardUID: "board", PanelID: 1, From: now.Add(-time.Hour), To: now})
	if err != nil || len(out.Series) != 1 || len(out.Series[0].Points) != 1 || queries != 1 {
		t.Fatalf("managed saved panel: %+v %v queries=%d", out, err, queries)
	}
	body, _ := json.Marshal(out)
	if strings.Contains(string(body), "private-source-label") {
		t.Fatal("source label leaked")
	}
	for _, tc := range []struct {
		method, path string
		query        url.Values
	}{
		{http.MethodPost, "/api/datasources", nil},
		{http.MethodDelete, "/api/dashboards/uid/board", nil},
		{http.MethodPost, "/api/ds/query", url.Values{"url": {"http://foreign"}}},
	} {
		var ignored any
		if err := r.browseJSON(context.Background(), source, tc.method, tc.path, tc.query, map[string]any{}, &ignored); !errors.Is(err, ErrBrowseInvalid) {
			t.Fatal("unexpected managed write accepted", tc.method, tc.path, err)
		}
	}
	if queries != 1 {
		t.Fatal("rejected write reached module controller")
	}
	r.ManagedRequest = nil
	if _, err = r.GrafanaQuery(context.Background(), source, GrafanaQuery{DashboardUID: "board", PanelID: 1, From: now.Add(-time.Hour), To: now}); !errors.Is(err, ErrBrowseInvalid) {
		t.Fatal("missing managed request fell back to external transport", err)
	}
}

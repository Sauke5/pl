package providers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"pl/portal/internal/model"
)

func TestPrometheusOptionsLiveTargetFilteringAndSecretLabels(t *testing.T) {
	r := registry(t, func(w http.ResponseWriter, q *http.Request) {
		if q.URL.Path != "/api/v1/targets" {
			t.Error(q.URL.Path)
		}
		_, _ = w.Write([]byte(`{"status":"success","data":{"activeTargets":[{"labels":{"job":"windows","instance":"dc1:9182","site":"msk","api_token":"never-expose"}},{"labels":{"job":"windows","instance":"dc2:9182","site":"spb"}},{"labels":{"job":"node","instance":"linux:9100","role":"proxy"}}]}}`))
	})
	out, e := r.PrometheusOptions(context.Background(), model.Integration{Kind: "prometheus", Enabled: true, URL: "http://source", Config: map[string]string{"discovery_enabled": "false"}}, "windows", "instance")
	if e != nil || len(out.Jobs) != 2 || len(out.Values) != 2 || out.Values[0] != "dc1:9182" || len(out.Labels) != 3 || out.TargetCount != 3 || out.ObservedAt.IsZero() {
		t.Fatal(out, e)
	}
	b, _ := json.Marshal(out)
	if strings.Contains(string(b), "api_token") || strings.Contains(string(b), "never-expose") {
		t.Fatal("secret label exposed")
	}
}
func fixtureDashboard() map[string]any {
	return map[string]any{"dashboard": map[string]any{"uid": "board", "title": "Fixture board", "templating": map[string]any{"list": []any{map[string]any{"name": "host", "type": "query", "multi": true, "current": map[string]any{"value": []string{"dc1.example", "dc2.example"}}}}}, "panels": []any{map[string]any{"id": 10, "type": "row", "panels": []any{map[string]any{"id": 1, "title": "CPU", "type": "timeseries", "datasource": "Prometheus", "fieldConfig": map[string]any{"defaults": map[string]any{"unit": "percent"}}, "targets": []any{map[string]any{"refId": "A", "expr": `rate(cpu{instance=~"$host"}[$__rate_interval])`}}}, map[string]any{"id": 2, "title": "Text", "type": "text"}}}}}}
}
func TestGrafanaSelectedPanelQueryAuthAndSanitizedTimeseries(t *testing.T) {
	t.Setenv("PORTAL_SECRET_REFS", "env:PORTAL_SECRET_BROWSE")
	t.Setenv("PORTAL_SECRET_BROWSE", "fixture-bearer")
	now := time.Now().UTC().Truncate(time.Second)
	calls := 0
	r := registry(t, func(w http.ResponseWriter, q *http.Request) {
		if q.Header.Get("Authorization") != "Bearer fixture-bearer" {
			t.Error("missing configured token")
		}
		switch q.URL.Path {
		case "/api/search":
			if q.URL.Query().Get("limit") != "201" || q.URL.Query().Get("type") != "dash-db" {
				t.Error(q.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`[{"uid":"board","title":"Fixture board","type":"dash-db"}]`))
		case "/api/dashboards/uid/board":
			_ = json.NewEncoder(w).Encode(fixtureDashboard())
		case "/api/datasources":
			_, _ = w.Write([]byte(`[{"uid":"prom","name":"Prometheus","type":"prometheus","isDefault":true,"url":"http://private","secureJsonFields":{"token":true}}]`))
		case "/api/ds/query":
			calls++
			if q.Method != "POST" {
				t.Fatal(q.Method)
			}
			var body struct {
				Queries []map[string]any `json:"queries"`
				From    string           `json:"from"`
				To      string           `json:"to"`
			}
			if e := json.NewDecoder(q.Body).Decode(&body); e != nil {
				t.Fatal(e)
			}
			if len(body.Queries) != 1 {
				t.Fatal(body)
			}
			query := body.Queries[0]
			expr := query["expr"].(string)
			if strings.Contains(expr, "$host") || !strings.Contains(expr, `dc1\\.example|dc2\\.example`) || !strings.Contains(expr, "60s") || query["maxDataPoints"] != float64(1000) || query["datasource"].(map[string]any)["uid"] != "prom" {
				t.Fatal(query)
			}
			_, _ = fmt.Fprintf(w, `{"results":{"A":{"status":200,"frames":[{"schema":{"fields":[{"name":"Time","type":"time"},{"name":"Value","type":"number","labels":{"instance":"dc1","token":"never-expose"},"config":{"displayNameFromDS":"never-expose","unit":"percent"}}]},"data":{"values":[[%d,%d],[12.5,null]]}}]}}}`, now.Add(-time.Minute).UnixMilli(), now.UnixMilli())
		default:
			t.Error("unexpected destination", q.URL.Path)
			w.WriteHeader(404)
		}
	})
	source := model.Integration{Kind: "grafana", Enabled: true, URL: "http://source", SecretRef: "env:PORTAL_SECRET_BROWSE"}
	boards, e := r.GrafanaDashboards(context.Background(), source)
	if e != nil || len(boards.Dashboards) != 1 {
		t.Fatal(boards, e)
	}
	panels, e := r.GrafanaPanels(context.Background(), source, "board")
	if e != nil || len(panels.Panels) != 2 || !panels.Panels[0].Supported || panels.Panels[1].Supported || panels.Panels[1].Reason == "" {
		t.Fatal(panels, e)
	}
	out, e := r.GrafanaQuery(context.Background(), source, GrafanaQuery{DashboardUID: "board", PanelID: 1, From: now.Add(-time.Hour), To: now})
	if e != nil || len(out.Series) != 1 || len(out.Series[0].Points) != 2 || out.Series[0].Points[1][1] != nil || out.Unit != "percent" || calls != 1 {
		t.Fatal(out, e)
	}
	b, _ := json.Marshal(out)
	if strings.Contains(string(b), "never-expose") || strings.Contains(string(b), "fixture-bearer") || strings.Contains(string(b), "private") {
		t.Fatal("source internals leaked")
	}
	if _, e = r.GrafanaQuery(context.Background(), source, GrafanaQuery{DashboardUID: "board", PanelID: 2, From: now.Add(-time.Hour), To: now}); !errors.Is(e, ErrPanelUnsupported) || calls != 1 {
		t.Fatal("unsupported panel executed", e, calls)
	}
}
func TestGrafanaVariablesAndUnsupportedSemantics(t *testing.T) {
	ds := []grafanaDatasource{{UID: "prom", Name: "Prometheus", Type: "prometheus", Default: true}}
	now := time.Now()
	q := GrafanaQuery{From: now.Add(-time.Hour), To: now}
	var envelope struct {
		Dashboard grafanaDashboard `json:"dashboard"`
	}
	b, _ := json.Marshal(fixtureDashboard())
	_ = json.Unmarshal(b, &envelope)
	board := envelope.Dashboard
	p := board.Panels[0].Panels[0]
	tests := []struct {
		name   string
		change func(*grafanaDashboard, *grafanaPanel)
	}{
		{"missing current", func(b *grafanaDashboard, p *grafanaPanel) { b.Templating.List = nil }},
		{"transform", func(b *grafanaDashboard, p *grafanaPanel) {
			p.Transformations = []json.RawMessage{json.RawMessage(`{"id":"calculateField"}`)}
		}},
		{"arbitrary datasource", func(b *grafanaDashboard, p *grafanaPanel) {
			p.Datasource = json.RawMessage(`{"type":"mysql","uid":"sql"}`)
		}},
		{"instant only", func(b *grafanaDashboard, p *grafanaPanel) {
			p.Targets = append([]grafanaTarget{}, p.Targets...)
			p.Targets[0].Instant = true
		}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			b, p := board, p
			tc.change(&b, &p)
			if _, reason := panelQueries(b, p, ds, q); reason == "" {
				t.Fatal("unsupported semantics accepted")
			}
		})
	}
	variable := grafanaVariable{Name: "job", Type: "query", Multi: true, IncludeAll: true, AllValue: ".*"}
	variable.Current.Value = "$__all"
	out, ok := expandGrafana(`up{job=~"${job:regex}"}`, map[string]grafanaVariable{"job": variable}, nil)
	if !ok || out != `up{job=~".*"}` {
		t.Fatal(out, ok)
	}
	variable.AllValue = ""
	if _, ok = expandGrafana("$job", map[string]grafanaVariable{"job": variable}, nil); ok {
		t.Fatal("invented all values")
	}
}
func TestBrowseBoundsFailuresAndNoRedirectOrUnexpectedQuery(t *testing.T) {
	for _, tc := range []struct {
		body   string
		status int
		want   error
	}{{`{"message":"token=secret"}`, 401, ErrBrowseAuth}, {`{"status":"success","data":{}}`, 200, ErrBrowseUnavailable}, {strings.Repeat("x", (4<<20)+1), 200, ErrBrowseLimit}} {
		r := registry(t, func(w http.ResponseWriter, q *http.Request) {
			w.WriteHeader(tc.status)
			_, _ = w.Write([]byte(tc.body))
		})
		_, e := r.PrometheusOptions(context.Background(), model.Integration{Kind: "prometheus", Enabled: true, URL: "http://source"}, "", "")
		if !errors.Is(e, tc.want) {
			t.Fatal(e, tc.want)
		}
	}
	calls := 0
	r := registry(t, func(w http.ResponseWriter, q *http.Request) {
		calls++
		http.Redirect(w, q, "http://elsewhere/private", 302)
	})
	_, e := r.GrafanaDashboards(context.Background(), model.Integration{Kind: "grafana", Enabled: true, URL: "http://source"})
	if e == nil || calls != 1 {
		t.Fatal("redirect followed", e, calls)
	}
	now := time.Now()
	_, e = r.GrafanaQuery(context.Background(), model.Integration{Kind: "grafana", Enabled: true, URL: "http://source"}, GrafanaQuery{DashboardUID: "../escape", PanelID: 1, From: now.Add(-time.Hour), To: now})
	if !errors.Is(e, ErrBrowseInvalid) || calls != 1 {
		t.Fatal(e, calls)
	}
	for n := 0; n < cap(browseWaiters); n++ {
		browseWaiters <- struct{}{}
	}
	defer func() {
		for n := 0; n < cap(browseWaiters); n++ {
			<-browseWaiters
		}
	}()
	_, e = r.GrafanaDashboards(context.Background(), model.Integration{Kind: "grafana", Enabled: true, URL: "http://source"})
	if !errors.Is(e, ErrBrowseBusy) {
		t.Fatal(e)
	}
}

func TestChartFrameLimitsAndPluginFailure(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	q := GrafanaQuery{From: now.Add(-time.Hour), To: now}
	for _, tc := range []struct{ series, points int }{{61, 1}, {1, 1001}} {
		times := make([]int64, tc.points)
		values := make([]float64, tc.points)
		for n := range times {
			times[n] = now.Add(-time.Minute).UnixMilli() + int64(n)
			values[n] = 1
		}
		frames := []any{}
		for n := 0; n < tc.series; n++ {
			frames = append(frames, map[string]any{"schema": map[string]any{"fields": []any{map[string]string{"name": "Time", "type": "time"}, map[string]string{"name": "Value", "type": "number"}}}, "data": map[string]any{"values": []any{times, values}}})
		}
		b, _ := json.Marshal(map[string]any{"results": map[string]any{"A": map[string]any{"frames": frames}}})
		var response grafanaFrames
		if e := json.Unmarshal(b, &response); e != nil {
			t.Fatal(e)
		}
		if _, e := chartFrames(response, []string{"A"}, q); !errors.Is(e, ErrBrowseLimit) {
			t.Fatal(tc, e)
		}
	}
	for _, raw := range []string{`{"results":{"A":{"status":500,"error":"password=do-not-expose"}}}`, `{"results":{}}`, `{"results":{"A":{"frames":[{"schema":{"fields":[{"type":"time"},{"type":"number"}]},"data":{"values":[[1],[]]}}]}}}`} {
		var response grafanaFrames
		_ = json.Unmarshal([]byte(raw), &response)
		if _, e := chartFrames(response, []string{"A"}, q); !errors.Is(e, ErrBrowseUnavailable) || strings.Contains(e.Error(), "do-not-expose") {
			t.Fatal(e)
		}
	}
}

func TestBrowseContextTimeoutAndPolicyGuard(t *testing.T) {
	r := registry(t, func(w http.ResponseWriter, q *http.Request) { <-q.Context().Done() })
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, e := r.GrafanaDashboards(ctx, model.Integration{Kind: "grafana", Enabled: true, URL: "http://source"})
	if !errors.Is(e, ErrBrowseUnavailable) {
		t.Fatal(e)
	}
	r = registry(t, func(http.ResponseWriter, *http.Request) { t.Fatal("blocked IP reached dial destination") })
	_, e = r.GrafanaDashboards(context.Background(), model.Integration{Kind: "grafana", Enabled: true, URL: "http://127.0.0.1"})
	if !errors.Is(e, ErrBrowseUnavailable) {
		t.Fatal(e)
	}
}

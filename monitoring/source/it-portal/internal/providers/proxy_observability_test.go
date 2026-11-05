package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"pl/portal/internal/model"
	"strings"
	"testing"
	"time"
)

func proxySeries(name, inbound, detail string, scrapes []float64, values []float64) proxyMetric {
	m := proxyMetric{Metric: map[string]string{"__name__": name, "source": "external185", "inbound": inbound}}
	if name == "pl_proxy_probe_control_success" {
		m.Metric["control"] = detail
	} else if name == "pl_proxy_stage_success" {
		m.Metric["stage"] = detail
	}
	for i, at := range scrapes {
		b, _ := json.Marshal(at)
		v, _ := json.Marshal(fmt.Sprint(values[i]))
		m.Values = append(m.Values, []json.RawMessage{b, v})
	}
	return m
}
func validProxySeries(now time.Time) []proxyMetric {
	n := float64(now.Unix())
	scrapes := []float64{n - 90, n - 60, n - 30, n}
	// Two independent cycles, each scraped twice: one success and one failure.
	return []proxyMetric{
		proxySeries("up", "", "", scrapes, []float64{1, 1, 1, 1}),
		proxySeries("pl_proxy_probe_healthy", "", "", scrapes, []float64{1, 1, 1, 1}),
		proxySeries("pl_proxy_probe_cycle_timestamp_seconds", "", "", scrapes, []float64{n - 100, n - 100, n - 40, n - 40}),
		proxySeries("pl_proxy_probe_timestamp_seconds", "443", "", scrapes, []float64{n - 100, n - 100, n - 40, n - 40}),
		proxySeries("pl_proxy_probe_success", "443", "", scrapes, []float64{1, 1, 0, 0}),
		proxySeries("pl_proxy_probe_control_success", "443", "debian", scrapes, []float64{1, 1, 0, 0}),
		proxySeries("pl_proxy_probe_control_success", "443", "cloudflare", scrapes, []float64{0, 0, 0, 0}),
		proxySeries("pl_proxy_stage_success", "443", "tunnel", scrapes, []float64{1, 1, 0, 0}),
	}
}
func TestProxyExternalCountsCyclesAndSeparatesLastSuccess(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	out := parseProxyMetrics(validProxySeries(now), now)
	p := out.Probes[0]
	if len(out.Probes) != 12 || p.State != "unhealthy" || p.ObservedCycles != 2 || p.SuccessfulCycles != 1 || p.SuccessRatio == nil || *p.SuccessRatio != 0.5 || p.LastSuccess == nil || p.LastSuccess.Unix() != now.Add(-100*time.Second).Unix() || p.ObservedAt.Unix() != now.Add(-40*time.Second).Unix() || len(p.FailedStages) != 1 {
		t.Fatalf("%+v", p)
	}
	if out.Probes[1].State != "unknown" {
		t.Fatal("missing inbound looks known")
	}
}
func TestProxyExternalTelemetryLossAndStalenessAreNotFailures(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	for _, test := range []struct {
		name  string
		alter func([]proxyMetric) []proxyMetric
		state string
	}{
		{"stale", func(m []proxyMetric) []proxyMetric { return m }, "stale"},
		{"missing control", func(m []proxyMetric) []proxyMetric { return append(m[:6], m[7:]...) }, "unknown"},
		{"exporter down", func(m []proxyMetric) []proxyMetric {
			m[0] = proxySeries("up", "", "", []float64{float64(now.Unix())}, []float64{0})
			return m
		}, "unknown"},
		{"duplicate identity", func(m []proxyMetric) []proxyMetric { return append(m, m[3]) }, "unknown"},
		{"worker broken", func(m []proxyMetric) []proxyMetric {
			m[1] = proxySeries("pl_proxy_probe_healthy", "", "", []float64{float64(now.Unix())}, []float64{0})
			return m
		}, "unknown"},
	} {
		t.Run(test.name, func(t *testing.T) {
			at := now
			if test.name == "stale" {
				at = at.Add(181 * time.Second)
			}
			p := parseProxyMetrics(test.alter(validProxySeries(now)), at).Probes[0]
			if p.State != test.state {
				t.Fatalf("%+v", p)
			}
		})
	}
}
func TestProxyExternalFixedPrometheusContract(t *testing.T) {
	r := registry(t, func(w http.ResponseWriter, q *http.Request) {
		if q.Method != "GET" || q.URL.Path != "/api/v1/query" || q.URL.Query().Get("query") != proxyMetricsQuery {
			t.Fatal(q.URL)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "success", "data": map[string]any{"resultType": "matrix", "result": validProxySeries(time.Now())}})
	})
	out, err := r.ProxyExternal(context.Background(), model.Integration{Kind: "prometheus", Enabled: true, URL: "http://source"})
	if err != nil || out.Probes[0].ObservedCycles != 2 {
		t.Fatal(out, err)
	}
	b, _ := json.Marshal(out)
	if strings.Contains(string(b), "instance") || strings.Contains(string(b), "Metric") {
		t.Fatal("raw labels exposed")
	}
}

func TestProxyExternalWindowAndOneControlSuccess(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	rows := validProxySeries(now)
	// A success outside five minutes is still the last success within 30 minutes.
	for index := range rows {
		for sample := 0; sample < 2; sample++ {
			if rows[index].Metric["__name__"] == "pl_proxy_probe_timestamp_seconds" || rows[index].Metric["__name__"] == "pl_proxy_probe_cycle_timestamp_seconds" {
				value, _ := json.Marshal(fmt.Sprint(now.Add(-400 * time.Second).Unix()))
				rows[index].Values[sample][1] = value
			}
			at, _ := json.Marshal(float64(now.Add(time.Duration(-390+sample*30) * time.Second).Unix()))
			rows[index].Values[sample][0] = at
		}
	}
	p := parseProxyMetrics(rows, now).Probes[0]
	if p.SuccessRatio == nil || *p.SuccessRatio != 0 || p.ObservedCycles != 1 || p.LastSuccess == nil || p.LastSuccess.Unix() != now.Add(-400*time.Second).Unix() {
		t.Fatalf("%+v", p)
	}
	rows = validProxySeries(now)
	for _, index := range []int{4, 5} {
		for sample := 2; sample < 4; sample++ {
			rows[index].Values[sample][1] = json.RawMessage(`"1"`)
		}
	}
	p = parseProxyMetrics(rows, now).Probes[0]
	if p.State != "healthy" || p.SuccessRatio == nil || *p.SuccessRatio != 1 {
		t.Fatalf("single HTTPS control must be enough: %+v", p)
	}
}

// Opt-in read-only verification from the monitoring Docker network. It never
// starts probes or touches controller routes; normal test runs remain isolated.

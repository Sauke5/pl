package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"pl/portal/internal/model"
)

func TestSystemMetricEscapesSelectorsAndUsesRawFreshness(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	for _, tc := range []struct {
		name, state string
		age         time.Duration
	}{{"fresh", "fresh", time.Second}, {"stale", "stale", 10 * time.Minute}, {"future", "no_data", -time.Hour}} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			r := registry(t, func(w http.ResponseWriter, q *http.Request) {
				calls++
				query := q.URL.Query().Get("query")
				if !strings.Contains(query, `instance="host\"or up"`) {
					t.Errorf("unescaped query: %s", query)
				}
				value := "23"
				if strings.HasPrefix(query, "min(timestamp(") {
					value = fmt.Sprint(now.Add(-tc.age).Unix())
				}
				_, _ = fmt.Fprintf(w, `{"status":"success","data":{"resultType":"vector","result":[{"metric":{"instance":"host","api_token":"do-not-expose"},"value":[%d,%q]}]}}`, now.Unix(), value)
			})
			out := r.SystemMetric(context.Background(), model.Integration{Kind: "prometheus", Enabled: true, URL: "http://source", Name: "Monitoring"}, model.SystemMetricBinding{ID: "metric", Metric: "rds.memory", Labels: map[string]string{"instance": `host"or up`}}, now)
			if out.State != tc.state || calls != 2 {
				t.Fatalf("state %s calls %d", out.State, calls)
			}
			if tc.state != "no_data" && (len(out.Samples) != 1 || !out.Samples[0].ObservedAt.Equal(now.Add(-tc.age))) {
				t.Fatal(out)
			}
			b, _ := json.Marshal(out)
			if strings.Contains(string(b), "do-not-expose") {
				t.Fatal("secret label exposed")
			}
		})
	}
}

func TestSystemMetricMissingAndInvalidAreNotZero(t *testing.T) {
	r := registry(t, func(w http.ResponseWriter, q *http.Request) {
		_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[]}}`))
	})
	i := model.Integration{Kind: "prometheus", Enabled: true, URL: "http://source"}
	b := model.SystemMetricBinding{ID: "metric", Metric: "rds.memory", Labels: map[string]string{"instance": "host"}}
	out := r.SystemMetric(context.Background(), i, b, time.Now())
	if out.State != "no_data" || len(out.Samples) != 0 {
		t.Fatal(out)
	}
	b.Metric = "arbitrary(query)"
	out = r.SystemMetric(context.Background(), i, b, time.Now())
	if out.State != "unsupported" {
		t.Fatal(out)
	}
	b.Metric = "target.up"
	b.Labels = map[string]string{}
	if ValidateSystemMetric(b) == nil {
		t.Fatal("unscoped generic query accepted")
	}
	b.Metric = "sftp.service"
	b.Labels = map[string]string{"name": "other.service"}
	if ValidateSystemMetric(b) == nil {
		t.Fatal("fixed profile selector overridden")
	}
	b.Labels = map[string]string{"__name__": "arbitrary"}
	if ValidateSystemMetric(b) == nil {
		t.Fatal("metric selector overridden")
	}
}

func TestPortableSystemMetricsRequireExplicitScopeAndExcludeSiteProfiles(t *testing.T) {
	for _, metric := range []string{"dsvpn.reachability", "dsvpn.tcp", "network.latency"} {
		if ValidateSystemMetric(model.SystemMetricBinding{Metric: metric}) == nil {
			t.Fatal("implicit site-wide query accepted", metric)
		}
		if err := ValidateSystemMetric(model.SystemMetricBinding{Metric: metric, Labels: map[string]string{"job": "my-network-checks"}}); err != nil {
			t.Fatal("explicit deployment selector rejected", err)
		}
	}
	for _, profile := range SystemProfiles() {
		if profile.Key == "backup" || profile.Key == "proxy" {
			t.Fatal("excluded site profile shipped", profile.Key)
		}
	}
	for _, key := range []string{"backup.result", "backup.status", "backup.success", "backup.repository", "proxy.path", "proxy.stage", "proxy.observed"} {
		if SystemMetricKnown(key) {
			t.Fatal("excluded site metric shipped", key)
		}
	}
}

func TestSystemMetricIncompleteDraftDoesNotQuery(t *testing.T) {
	calls := 0
	r := registry(t, func(w http.ResponseWriter, q *http.Request) {
		calls++
		t.Error("unconfigured binding reached Prometheus")
	})
	source := model.Integration{Kind: "prometheus", Enabled: true, URL: "http://source"}
	for _, labels := range []map[string]string{nil, {}, {"instance": ""}, {"job": "linux", "instance": " "}} {
		binding := model.SystemMetricBinding{ID: "metric", Metric: "linux.cpu", IntegrationID: "source", Labels: labels}
		if err := ValidateSystemMetricDraft(binding); err != nil {
			t.Fatal("incomplete draft rejected", labels, err)
		}
		if ValidateSystemMetric(binding) == nil {
			t.Fatal("incomplete draft executable", labels)
		}
		out := r.SystemMetric(context.Background(), source, binding, time.Now())
		if out.State != "unconfigured" || len(out.Samples) != 0 || out.Error != "" {
			t.Fatal("incomplete draft reported as error or data", out)
		}
	}
	if calls != 0 {
		t.Fatal("unconfigured query sent", calls)
	}
	for _, labels := range []map[string]string{{"__name__": "up"}, {"mode": "user"}, {"instance": "host\nother"}} {
		binding := model.SystemMetricBinding{Metric: "linux.cpu", Labels: labels}
		if ValidateSystemMetricDraft(binding) == nil {
			t.Fatal("invalid draft selector accepted", labels)
		}
		if out := r.SystemMetric(context.Background(), source, binding, time.Now()); out.State != "error" {
			t.Fatal("invalid selector was presented as an incomplete binding", out)
		}
	}
}

func TestSystemProfilesUseAvailableLibraryWithoutRequiringAProfile(t *testing.T) {
	profiles := map[string]bool{}
	for _, profile := range SystemProfiles() {
		profiles[profile.Key] = true
		for _, key := range profile.Metrics {
			if !SystemMetricKnown(key) {
				t.Fatal("profile references unavailable metric", profile.Key, key)
			}
		}
	}
	for _, key := range []string{"custom", "linux", "windows", "network", "application"} {
		if !profiles[key] {
			t.Fatal("generic system profile missing", key)
		}
	}
	for _, key := range []string{"linux.cpu", "linux.memory", "linux.uptime", "linux.network_receive", "windows.cpu", "windows.memory"} {
		if err := ValidateSystemMetric(model.SystemMetricBinding{Metric: key, Labels: map[string]string{"instance": "my-host:9100"}}); err != nil {
			t.Fatal("generic metric cannot use deployment-specific target", key, err)
		}
	}
}

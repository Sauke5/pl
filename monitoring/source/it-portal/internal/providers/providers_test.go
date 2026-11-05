package providers

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"pl/portal/internal/model"
	"pl/portal/internal/netguard"
	"strings"
	"testing"
)

type fakeDNS struct{}

func (fakeDNS) LookupIPAddr(context.Context, string) ([]net.IPAddr, error) {
	return []net.IPAddr{{IP: net.ParseIP("10.0.0.5")}}, nil
}
func registry(t *testing.T, h http.HandlerFunc) *Registry {
	t.Helper()
	s := httptest.NewServer(h)
	t.Cleanup(s.Close)
	addr := strings.TrimPrefix(s.URL, "http://")
	g, e := netguard.NewWithDependencies([]string{"10.0.0.0/8"}, []int{80, 443}, "", fakeDNS{}, func(c context.Context, n, a string) (net.Conn, error) { return (&net.Dialer{}).DialContext(c, n, addr) })
	if e != nil {
		t.Fatal(e)
	}
	return New(g, "")
}
func TestPrometheusContractStableTargets(t *testing.T) {
	r := registry(t, func(w http.ResponseWriter, q *http.Request) {
		if q.URL.Path != "/prometheus/api/v1/targets" {
			t.Error(q.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"success","data":{"activeTargets":[{"scrapePool":"node","labels":{"job":"node","instance":"host:9100"},"scrapeUrl":"http://host:9100/metrics"}]}}`))
	})
	i := model.Integration{ID: "source", Kind: "prometheus", URL: "http://test/prometheus"}
	a, e := r.Poll(context.Background(), i)
	if e != nil {
		t.Fatal(e)
	}
	b, e := r.Poll(context.Background(), i)
	if e != nil || len(a.Candidates) != 1 || a.Candidates[0].ExternalID != b.Candidates[0].ExternalID {
		t.Fatalf("unstable %v %v", a, e)
	}
	if a.Candidates[0].State != "pending" || a.Candidates[0].IntegrationID != "source" {
		t.Fatal(a)
	}
}
func TestMalformedSnapshotsNeverResolve(t *testing.T) {
	for _, tc := range []struct{ kind, body string }{{"prometheus", `{"status":"success","data":{}}`}, {"prometheus", `{"status":"error"}`}, {"alertmanager", `null`}, {"alertmanager", `[{"fingerprint":"a"}]`}, {"alertmanager", `{"error":"unavailable"}`}} {
		t.Run(tc.kind+tc.body, func(t *testing.T) {
			r := registry(t, func(w http.ResponseWriter, q *http.Request) { _, _ = w.Write([]byte(tc.body)) })
			if _, e := r.Poll(context.Background(), model.Integration{Kind: tc.kind, URL: "http://test"}); e == nil {
				t.Fatal("accepted incomplete snapshot")
			}
		})
	}
}

func TestPrometheusDiscoveryCanBeDisabledWithoutMaskingSourceFailure(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		wantError  bool
	}{
		{"healthy", `{"status":"success","data":{"activeTargets":[{"scrapePool":"node","labels":{"job":"node","instance":"host:9100"},"scrapeUrl":"http://host:9100/metrics"}]}}`, false},
		{"incomplete", `{"status":"success","data":{}}`, true},
		{"failed", `{"status":"error"}`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			r := registry(t, func(w http.ResponseWriter, q *http.Request) {
				calls++
				_, _ = w.Write([]byte(tc.body))
			})
			snapshot, err := r.Poll(context.Background(), model.Integration{Kind: "prometheus", URL: "http://source", Config: map[string]string{"discovery_enabled": "false"}})
			if (err != nil) != tc.wantError || calls != 1 || len(snapshot.Candidates) != 0 {
				t.Fatalf("calls=%d candidates=%d err=%v", calls, len(snapshot.Candidates), err)
			}
		})
	}
}
func TestSuppressedAlertsStayFiring(t *testing.T) {
	r := registry(t, func(w http.ResponseWriter, q *http.Request) {
		if q.URL.Path != "/api/v2/alerts" {
			t.Error(q.URL.Path)
		}
		_, _ = w.Write([]byte(`[{"fingerprint":"abc","labels":{"alertname":"Down","severity":"critical"},"annotations":{"summary":"Endpoint down"},"startsAt":"2026-09-24T10:00:00Z","status":{"state":"suppressed","silencedBy":["silence-1"],"inhibitedBy":[]}}]`))
	})
	s, e := r.Poll(context.Background(), model.Integration{Kind: "alertmanager", URL: "http://test"})
	if e != nil {
		t.Fatal(e)
	}
	if len(s.Problems) != 1 || s.Problems[0].Status != "firing" || s.Problems[0].Labels["portal_silenced"] != "true" {
		t.Fatal(s)
	}
}
func TestHTTPAndEnrichmentAreEndpointObservations(t *testing.T) {
	r := registry(t, func(w http.ResponseWriter, q *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(`<title>Login &amp; sign in</title>`))
	})
	v, e := r.Execute(context.Background(), model.Job{Kind: "enrich", Parameters: map[string]any{"target": "http://test"}}, nil, nil)
	if e != nil {
		t.Fatal(e)
	}
	if v["suggestions"].(map[string]any)["name"] != "Login & sign in" || v["observations"].(map[string]any)["application_health"] != "not_assessed" {
		t.Fatal(v)
	}
	v, e = r.Execute(context.Background(), model.Job{Kind: "check", Parameters: map[string]any{"kind": "http", "target": "http://test"}}, nil, nil)
	if e != nil || v["application_health"] != "not_assessed" {
		t.Fatalf("%v %v", v, e)
	}
}
func TestReportAdapterContract(t *testing.T) {
	r := registry(t, func(w http.ResponseWriter, q *http.Request) {
		if q.Method != "POST" || q.URL.Path != "/api/reports/run" {
			t.Error(q.Method, q.URL.Path)
		}
		var v map[string]string
		_ = json.NewDecoder(q.Body).Decode(&v)
		if v["target_date"] != "2026-09-24" {
			t.Error(v)
		}
		_, _ = w.Write([]byte(`{"ok":true,"created":true,"telegram_sent":false,"report":{"url":"/reports/report.pdf","file":"report.pdf","date":"2026-09-24","run":1}}`))
	})
	v, e := r.Execute(context.Background(), model.Job{Kind: "report", Parameters: map[string]any{"target_date": "2026-09-24"}}, nil, &model.Integration{Kind: "reports", Enabled: true, URL: "http://reports", Config: map[string]string{"reports_base_url": "https://portal.test"}})
	if e != nil || v["url"] != "https://portal.test/reports/report.pdf" {
		t.Fatalf("%v %v", v, e)
	}
}
func TestSecretAllowlistAndPath(t *testing.T) {
	t.Setenv("PORTAL_SECRET_X", "value")
	if _, e := secret("env:PORTAL_SECRET_X"); e == nil {
		t.Fatal("unallowlisted secret allowed")
	}
	t.Setenv("PORTAL_SECRET_REFS", "env:PORTAL_SECRET_X,file:token,file:../escape")
	if s, e := secret("env:PORTAL_SECRET_X"); e != nil || s != "value" {
		t.Fatal(e)
	}
	dir := t.TempDir()
	t.Setenv("PORTAL_SECRETS_DIR", dir)
	if e := os.WriteFile(filepath.Join(dir, "token"), []byte("file-value\n"), 0600); e != nil {
		t.Fatal(e)
	}
	if s, e := secret("file:token"); e != nil || s != "file-value" {
		t.Fatal(e)
	}
	if _, e := secret("file:../escape"); e == nil {
		t.Fatal("path escape allowed")
	}
}
func TestDiscoveryFilters(t *testing.T) {
	labels := map[string]string{"job": "node", "site": "msk"}
	for _, config := range []map[string]string{{"include_job": "blackbox"}, {"exclude_job": "node"}, {"match_label": "site", "match_value": "spb"}, {"match_label": "missing", "match_value": ""}} {
		if matchesDiscovery(config, labels) {
			t.Error(config)
		}
	}
	if !matchesDiscovery(map[string]string{"include_job": "node, blackbox", "match_label": "site", "match_value": "msk"}, labels) {
		t.Fatal("matching candidate dropped")
	}
}

func TestDiscoveryRejectsUnsafeSourceAddresses(t *testing.T) {
	for _, address := range []string{"javascript:alert(1)", "http://user:password@target.test/metrics", "http://target.test/metrics?token=secret", "http://target.test/metrics?X-Api-Key=secret"} {
		t.Run(address, func(t *testing.T) {
			r := registry(t, func(w http.ResponseWriter, q *http.Request) {
				_ = json.NewEncoder(w).Encode(map[string]any{"status": "success", "data": map[string]any{"activeTargets": []map[string]any{{"scrapePool": "node", "labels": map[string]string{"job": "node"}, "scrapeUrl": address}}}})
			})
			if _, e := r.Poll(context.Background(), model.Integration{Kind: "prometheus", URL: "http://source"}); e == nil {
				t.Fatal("unsafe source address accepted")
			}
		})
	}
}
func TestSourceSecretLabelsAreNotExposed(t *testing.T) {
	labels := safeLabels(map[string]string{"instance": "server", "token": "very-secret", "api-key": "very-secret", "db_password": "very-secret", "severity": "warning"})
	if len(labels) != 2 || labels["instance"] != "server" {
		t.Fatal("source labels not sanitized", labels)
	}
}

func TestHostDiscoveryDoesNotAdvertiseExporterPage(t *testing.T) {
	for _, job := range []string{"windows", "linux"} {
		t.Run(job, func(t *testing.T) {
			r := registry(t, func(w http.ResponseWriter, q *http.Request) {
				json.NewEncoder(w).Encode(map[string]any{"status": "success", "data": map[string]any{"activeTargets": []any{map[string]any{"scrapePool": job, "labels": map[string]string{"job": job, "instance": "server.example:9100"}, "scrapeUrl": "http://server.example:9100/metrics", "health": "up"}}}})
			})
			snapshot, err := r.Poll(context.Background(), model.Integration{ID: "s", Kind: "prometheus", URL: "http://source"})
			if err != nil || len(snapshot.Candidates) != 1 {
				t.Fatalf("poll: %v", err)
			}
			c := snapshot.Candidates[0]
			if c.Name != "server.example" || c.URL != "" || c.Observation == nil || c.Observation.ScrapeURL != "http://server.example:9100/metrics" || c.ExternalID != hash(job+"\x00http://server.example:9100/metrics") {
				t.Fatalf("host semantics or source identity lost: %+v", c)
			}
		})
	}
}

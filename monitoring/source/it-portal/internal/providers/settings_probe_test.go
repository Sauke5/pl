package providers

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/netguard"
)

func TestSettingsProbeProviderContracts(t *testing.T) {
	for _, tc := range []struct {
		kind, path, body string
	}{
		{"prometheus", "/base/api/v1/targets", `{"status":"success","data":{"activeTargets":[]}}`},
		{"alertmanager", "/base/api/v2/alerts", `[]`},
		{"grafana", "/base/api/search", `[{"uid":"dashboard-1","title":"Infrastructure","type":"dash-db"}]`},
		{"reports", "/internal/reports/manifest", `[{"report_type":"daily","date":"2026-10-26","run":1,"file":"infrastructure-2026-10-26-run-1.html"}]`},
		{"wayline", "/base/api/v1/targets", `{"targets":[{"id":1,"name":"Branch","host":"host.example.test","interval_seconds":60}]}`},
		{"netbox", "/base/api/dcim/devices/", `{"count":10,"results":[{"id":42,"name":"Switch"}]}`},
	} {
		t.Run(tc.kind, func(t *testing.T) {
			var calls atomic.Int32
			r := registry(t, func(w http.ResponseWriter, q *http.Request) {
				calls.Add(1)
				if q.Method != http.MethodGet || q.URL.Path != tc.path || q.Header.Get("Cookie") != "" || q.Header.Get("X-CSRF-Token") != "" {
					t.Errorf("unexpected provider request: %s %s", q.Method, q.URL.Path)
				}
				if tc.kind == "netbox" && (q.URL.Query().Get("limit") != "1" || q.URL.Query().Get("offset") != "0") {
					t.Error("probe requested an unbounded NetBox collection")
				}
				if tc.kind == "grafana" && (q.URL.Query().Get("limit") != "1" || q.URL.Query().Get("type") != "dash-db") {
					t.Error("probe requested an unbounded Grafana collection")
				}
				_, _ = w.Write([]byte(tc.body))
			})
			draft := model.Integration{Kind: tc.kind, URL: "http://source/base", Config: map[string]string{}, Enabled: false, TimeoutSeconds: 3}
			before, _ := json.Marshal(draft)
			out := r.ProbeIntegration(context.Background(), draft)
			after, _ := json.Marshal(draft)
			if out.Status != "connected" || out.CheckedAt.IsZero() || calls.Load() != 1 || string(before) != string(after) {
				t.Fatalf("probe=%+v calls=%d draft_changed=%v", out, calls.Load(), string(before) != string(after))
			}
		})
	}
}

func TestSettingsProbeRejectsInvalidProviderShape(t *testing.T) {
	for _, tc := range []struct{ kind, body string }{
		{"prometheus", `{"status":"success","data":{}}`},
		{"prometheus", `{"status":"success","data":{"activeTargets":null}}`},
		{"prometheus", `{"status":"success","data":{"activeTargets":[null]}}`},
		{"prometheus", `{"status":"success","data":{"activeTargets":[{"labels":{"job":"node"},"scrapeUrl":"not-an-http-url"}]}}`},
		{"alertmanager", `null`},
		{"alertmanager", `[{"fingerprint":"a","labels":{"alertname":"Down"},"startsAt":"2026-01-01T00:00:00Z"}]`},
		{"grafana", `{"database":"failed"}`},
		{"grafana", `{"database":"ok"}`},
		{"grafana", `null`},
		{"grafana", `[{}]`},
		{"grafana", `[{"uid":"dash","title":"Wrong type","type":"dash-folder"}]`},
		{"reports", `{"ok":false}`},
		{"reports", `{"ok":true}`},
		{"reports", `null`},
		{"reports", `[{}]`},
		{"reports", `[{"report_type":"daily","date":"2026-10-26","run":1,"file":"../../private"}]`},
		{"reports", `[{"report_type":"weekly","iso_year":2026,"iso_week":44,"period_start":"2026-10-26","period_end":"2026-11-02","run":1,"file":"infrastructure-weekly-2026-W44-run-1.html"}]`},
		{"wayline", `{"targets":[{"id":1,"name":"a","host":"b","interval_seconds":0}]}`},
		{"netbox", `{"count":1,"results":[]}`},
		{"netbox", `{"count":0,"results":null}`},
		{"netbox", `{"count":0,"results":[{"id":1,"name":"wrong"}]}`},
		{"grafana", `<html>Log in with TOP-SECRET</html>`},
	} {
		t.Run(tc.kind+tc.body, func(t *testing.T) {
			r := registry(t, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(tc.body)) })
			out := r.ProbeIntegration(context.Background(), model.Integration{Kind: tc.kind, URL: "http://source"})
			if out.Status != "invalid_response" || strings.Contains(out.Message, "TOP-SECRET") {
				t.Fatalf("accepted or exposed invalid response: %+v", out)
			}
		})
	}
}

func TestSettingsProbeDistinguishesSourceFailuresAndCanRecover(t *testing.T) {
	var response atomic.Int32
	response.Store(401)
	r := registry(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(int(response.Load()))
		_, _ = w.Write([]byte(`[{"uid":"dash","title":"TOP-SECRET","type":"dash-db"}]`))
	})
	for _, tc := range []struct {
		status int
		want   string
	}{{401, "auth"}, {403, "auth"}, {404, "invalid_response"}, {429, "unreachable"}, {503, "unreachable"}, {200, "connected"}} {
		response.Store(int32(tc.status))
		out := r.ProbeIntegration(context.Background(), model.Integration{Kind: "grafana", URL: "http://source"})
		if out.Status != tc.want || strings.Contains(out.Message, "TOP-SECRET") {
			t.Fatalf("HTTP%d: %+v", tc.status, out)
		}
	}
}

func TestSettingsProbeUsesProviderCredentialsAndNetBoxHost(t *testing.T) {
	t.Setenv("PORTAL_SECRET_REFS", "env:PORTAL_SECRET_PROBE_TEST")
	t.Setenv("PORTAL_SECRET_PROBE_TEST", "probe-fixture-token")
	for _, kind := range []string{"prometheus", "netbox", "wayline", "grafana", "reports"} {
		t.Run(kind, func(t *testing.T) {
			r := registry(t, func(w http.ResponseWriter, q *http.Request) {
				switch kind {
				case "grafana":
					if q.Header.Get("Authorization") != "Bearer probe-fixture-token" || q.URL.Path != "/api/search" {
						t.Error("Grafana did not verify the configured credential on the read API")
					}
					_, _ = w.Write([]byte(`[]`))
				case "reports":
					if q.Header.Get("Authorization") != "" || q.URL.Path != "/internal/reports/manifest" {
						t.Error("manifest request differs from saved report adapter")
					}
					_, _ = w.Write([]byte(`[]`))
				case "netbox":
					if q.Header.Get("Authorization") != "Token probe-fixture-token" || q.Host != "netbox.example.test" {
						t.Error("NetBox auth/Host differs from saved provider")
					}
					_, _ = w.Write([]byte(`{"count":0,"results":[]}`))
				case "wayline":
					name, password, ok := q.BasicAuth()
					if !ok || name != "probe-user" || password != "probe-fixture-token" {
						t.Error("Wayline did not use Basic credentials")
					}
					_, _ = w.Write([]byte(`{"targets":[]}`))
				default:
					if q.Header.Get("Authorization") != "Bearer probe-fixture-token" {
						t.Error("Prometheus did not use Bearer credentials")
					}
					_, _ = w.Write([]byte(`{"status":"success","data":{"activeTargets":[]}}`))
				}
			})
			out := r.ProbeIntegration(context.Background(), model.Integration{Kind: kind, URL: "http://source", SecretRef: "env:PORTAL_SECRET_PROBE_TEST", Config: map[string]string{"basic_username": "probe-user", "http_host": "netbox.example.test"}})
			if out.Status != "connected" || strings.Contains(out.Message, "probe-fixture-token") {
				t.Fatal(out)
			}
		})
	}
}

func TestSettingsProbeChecksFunctionalAPIInsteadOfHealthyPublicEndpoint(t *testing.T) {
	for _, tc := range []struct {
		name, kind, path, body, want string
		status                       int
	}{
		{"grafana-invalid-token", "grafana", "/grafana/api/search", `{"message":"token rejected"}`, "auth", 401},
		{"grafana-insufficient-rights", "grafana", "/grafana/api/search", `{"message":"forbidden"}`, "auth", 403},
		{"grafana-wrong-api", "grafana", "/grafana/api/search", `{"database":"ok"}`, "invalid_response", 200},
		{"reports-no-manifest", "reports", "/internal/reports/manifest", `{"message":"not found"}`, "invalid_response", 404},
		{"reports-wrong-manifest", "reports", "/internal/reports/manifest", `{"ok":true}`, "invalid_response", 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls, healthCalls atomic.Int32
			r := registry(t, func(w http.ResponseWriter, q *http.Request) {
				calls.Add(1)
				if strings.HasSuffix(q.URL.Path, "/health") {
					healthCalls.Add(1)
					_, _ = w.Write([]byte(`{"database":"ok","ok":true}`))
					return
				}
				if q.URL.Path != tc.path {
					t.Errorf("functional API path=%s want=%s", q.URL.Path, tc.path)
				}
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			})
			out := r.ProbeIntegration(context.Background(), model.Integration{Kind: tc.kind, URL: "http://source/grafana"})
			if out.Status != tc.want || calls.Load() != 1 || healthCalls.Load() != 0 {
				t.Fatalf("healthy endpoint hid broken API: %+v calls=%d health=%d", out, calls.Load(), healthCalls.Load())
			}
		})
	}
}

func TestSettingsProbeAcceptsEmptyFunctionalCollectionsAndValidWeeklyManifest(t *testing.T) {
	for _, tc := range []struct{ kind, body string }{
		{"grafana", `[]`},
		{"reports", `[]`},
		{"reports", `[{"report_type":"weekly","iso_year":2026,"iso_week":44,"period_start":"2026-10-26","period_end":"2026-11-01","run":2,"file":"infrastructure-weekly-2026-W44-run-2.html"}]`},
	} {
		if !settingsProbeResponse(tc.kind, []byte(tc.body)) {
			t.Fatalf("valid %s collection rejected: %s", tc.kind, tc.body)
		}
	}
}

func TestSettingsProbeMissingSecretAndUnsupportedNeverConnect(t *testing.T) {
	var calls atomic.Int32
	r := registry(t, func(w http.ResponseWriter, _ *http.Request) { calls.Add(1) })
	for _, tc := range []struct {
		draft model.Integration
		want  string
	}{
		{model.Integration{Kind: "docker", URL: "http://source"}, "unsupported"},
		{model.Integration{Kind: "other", URL: "http://source"}, "unsupported"},
		{model.Integration{Kind: "grafana", URL: "http://source", SecretRef: "env:PORTAL_SECRET_NOT_ALLOWLISTED"}, "secret_unavailable"},
		{model.Integration{Kind: "wayline", URL: "http://source", Config: map[string]string{"basic_username": "name"}}, "secret_unavailable"},
		{model.Integration{Kind: "grafana", URL: "http://user:password@source"}, "invalid_response"},
	} {
		out := r.ProbeIntegration(context.Background(), tc.draft)
		if out.Status != tc.want || strings.Contains(out.Message, "password") {
			t.Fatalf("wanted %s got%+v", tc.want, out)
		}
	}
	if calls.Load() != 0 {
		t.Fatal("invalid/unsupported probe reached the source")
	}
}

func TestSettingsProbeDoesNotFollowRedirectOrExpandPolicy(t *testing.T) {
	var calls atomic.Int32
	r := registry(t, func(w http.ResponseWriter, q *http.Request) {
		calls.Add(1)
		http.Redirect(w, q, "http://169.254.169.254/metadata?token=TOP-SECRET", http.StatusFound)
	})
	for _, raw := range []string{"http://127.0.0.1", "http://169.254.169.254", "http://100.100.100.200", "http://10.0.0.5:12345", "http://203.0.113.5"} {
		out := r.ProbeIntegration(context.Background(), model.Integration{Kind: "grafana", URL: raw})
		if out.Status != "policy_denied" {
			t.Fatalf("blocked destination %s: %+v", raw, out)
		}
	}
	if calls.Load() != 0 {
		t.Fatal("blocked destination reached dialer")
	}
	out := r.ProbeIntegration(context.Background(), model.Integration{Kind: "grafana", URL: "http://source"})
	if out.Status != "invalid_response" || calls.Load() != 1 || strings.Contains(out.Message, "TOP-SECRET") {
		t.Fatalf("redirect followed or disclosed: %+v calls=%d", out, calls.Load())
	}
}

func TestSettingsProbeTLSAndTimeoutClassification(t *testing.T) {
	for _, tc := range []struct {
		name, want string
		err        error
	}{{"tls", "tls", x509.UnknownAuthorityError{}}, {"timeout", "unreachable", context.DeadlineExceeded}, {"refused", "unreachable", errors.New("source URL http://secret.example.test/private?token=TOP-SECRET")}} {
		t.Run(tc.name, func(t *testing.T) {
			g, err := netguard.NewWithDependencies([]string{"10.0.0.0/8"}, []int{80}, "", fakeDNS{}, func(context.Context, string, string) (net.Conn, error) { return nil, tc.err })
			if err != nil {
				t.Fatal(err)
			}
			out := New(g, "").ProbeIntegration(context.Background(), model.Integration{Kind: "grafana", URL: "http://source"})
			if out.Status != tc.want || strings.Contains(out.Message, "TOP-SECRET") || strings.Contains(out.Message, "secret.example.test") {
				t.Fatal(out)
			}
		})
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	r := registry(t, func(_ http.ResponseWriter, q *http.Request) { <-q.Context().Done() })
	out := r.ProbeIntegration(ctx, model.Integration{Kind: "grafana", URL: "http://source"})
	if out.Status != "unreachable" || !errors.Is(ctx.Err(), context.DeadlineExceeded) {
		t.Fatal(out)
	}
}

func TestSettingsProbeBoundsResponseAndConcurrentRequests(t *testing.T) {
	r := registry(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat(" ", (4<<20)+1)))
	})
	if out := r.ProbeIntegration(context.Background(), model.Integration{Kind: "grafana", URL: "http://source"}); out.Status != "invalid_response" {
		t.Fatal(out)
	}
	for range cap(settingsProbeSlots) {
		settingsProbeSlots <- struct{}{}
	}
	defer func() {
		for range cap(settingsProbeSlots) {
			<-settingsProbeSlots
		}
	}()
	if out := r.ProbeIntegration(context.Background(), model.Integration{Kind: "grafana", URL: "http://source"}); out.Status != "busy" {
		t.Fatal(out)
	}
}

func TestSettingsProbeActualTLSValidation(t *testing.T) {
	source := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{"database":"ok"}`)) }))
	t.Cleanup(source.Close)
	address := strings.TrimPrefix(source.URL, "https://")
	g, err := netguard.NewWithDependencies([]string{"10.0.0.0/8"}, []int{443}, "", fakeDNS{}, func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, address)
	})
	if err != nil {
		t.Fatal(err)
	}
	if out := New(g, "").ProbeIntegration(context.Background(), model.Integration{Kind: "grafana", URL: "https://source"}); out.Status != "tls" {
		t.Fatal(out)
	}
}

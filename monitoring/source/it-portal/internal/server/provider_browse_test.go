package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/modules"
	"pl/portal/internal/netguard"
	"pl/portal/internal/providers"
)

type browseResolver struct{}

func (browseResolver) LookupIPAddr(context.Context, string) ([]net.IPAddr, error) {
	return []net.IPAddr{{IP: net.ParseIP("10.1.1.1")}}, nil
}
func TestAPIProviderBrowseAdminCSRFAndBoundedContract(t *testing.T) {
	s := apiFixture(t)
	admin := apiUser(t, s, "browse-admin", true)
	viewer := apiUser(t, s, "browse-viewer", false)
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		switch r.URL.Path {
		case "/api/v1/targets":
			_, _ = w.Write([]byte(`{"status":"success","data":{"activeTargets":[{"labels":{"job":"windows","instance":"dc1"}}]}}`))
		case "/api/search":
			w.WriteHeader(401)
			_, _ = w.Write([]byte(`{"message":"secret-upstream-diagnostic"}`))
		default:
			t.Error("unexpected source request", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer upstream.Close()
	guard, e := netguard.NewWithDependencies([]string{"10.0.0.0/8"}, []int{80}, "", browseResolver{}, func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(upstream.URL, "http://"))
	})
	if e != nil {
		t.Fatal(e)
	}
	s.Providers = providers.New(guard, "")
	for _, kind := range []string{"prometheus", "grafana"} {
		if _, e = s.Store.Save(context.Background(), "integration", kind, 0, model.Integration{ID: kind, Kind: kind, Enabled: true, URL: "http://source"}, "test"); e != nil {
			t.Fatal(e)
		}
	}
	paths := []struct{ method, path string }{{"GET", "/api/v1/integrations/prometheus/prometheus/options"}, {"GET", "/api/v1/integrations/grafana/grafana/dashboards"}, {"GET", "/api/v1/integrations/grafana/grafana/dashboards/board/panels"}, {"POST", "/api/v1/integrations/grafana/grafana/query"}}
	for _, path := range paths {
		for _, who := range []apiIdentity{viewer, {}} {
			want := 403
			if who.cookie == nil {
				want = 401
			}
			w := apiCall(s, who, path.method, path.path, nil, nil)
			if w.Code != want {
				t.Fatal(path, w.Code)
			}
		}
	}
	if calls.Load() != 0 {
		t.Fatal("unauthorized requests reached source")
	}
	now := time.Now().UTC()
	payload := map[string]any{"dashboard_uid": "board", "panel_id": 1, "from": now.Add(-time.Hour), "to": now}
	path := "/api/v1/integrations/grafana/grafana/query"
	if w := apiCall(s, admin, "POST", path, payload, map[string]string{"X-CSRF-Token": ""}); w.Code != 403 {
		t.Fatal(w.Code)
	}
	payload["expr"] = "arbitrary_query"
	if w := apiCall(s, admin, "POST", path, payload, nil); w.Code != 400 {
		t.Fatal("accepted arbitrary query", w.Code)
	}
	delete(payload, "expr")
	payload["from"] = now.Add(-8 * 24 * time.Hour)
	if w := apiCall(s, admin, "POST", path, payload, nil); w.Code != 400 {
		t.Fatal("unbounded range", w.Code)
	}
	payload["from"] = now.Add(-time.Hour)
	payload["dashboard_uid"] = "../escape"
	if w := apiCall(s, admin, "POST", path, payload, nil); w.Code != 400 {
		t.Fatal("unsafe UID", w.Code)
	}
	if calls.Load() != 0 {
		t.Fatal("rejected request reached source")
	}
	result := apiDecode[providers.PrometheusOptions](t, apiCall(s, admin, "GET", "/api/v1/integrations/prometheus/prometheus/options?job=windows&label=instance", nil, nil), 200)
	if len(result.Values) != 1 || result.Values[0] != "dc1" {
		t.Fatal(result)
	}
	response := apiCall(s, admin, "GET", "/api/v1/integrations/grafana/grafana/dashboards", nil, nil)
	if response.Code != 502 || !strings.Contains(response.Body.String(), "source_auth_required") || strings.Contains(response.Body.String(), "secret-upstream-diagnostic") {
		t.Fatal(response.Code, response.Body.String())
	}
	before := calls.Load()
	if _, e = s.Store.Save(context.Background(), "integration", "disabled", 0, model.Integration{ID: "disabled", Kind: "prometheus", Enabled: false, URL: "http://source"}, "test"); e != nil {
		t.Fatal(e)
	}
	if w := apiCall(s, admin, "GET", "/api/v1/integrations/disabled/prometheus/options", nil, nil); w.Code != 400 || calls.Load() != before {
		t.Fatal("disabled source fetched", w.Code)
	}
}

func TestPortableGrafanaChartsUseNativeBrowserSession(t *testing.T) {
	s, admin, _, instance, integration := grafanaServerFixture(t)
	s.Config.PortableRelease = true
	folder, err := os.MkdirTemp("", "pl-chart-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(folder) })
	socket, key := filepath.Join(folder, "sock"), filepath.Join(folder, "key")
	if err := os.WriteFile(key, make([]byte, 32), 0600); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	now := time.Now().UTC().Truncate(time.Second)
	host := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			InstanceID string `json:"instance_id"`
			Path       string `json:"path"`
			Method     string `json:"method"`
			Session    string `json:"browser_session"`
			Body       string `json:"body"`
			Admin      bool   `json:"admin"`
		}
		if r.URL.Path != "/v1/grafana/request" || json.NewDecoder(r.Body).Decode(&input) != nil ||
			input.InstanceID != instance.ID || input.Admin || r.Header.Get("Cookie") != "" {
			t.Error("unexpected controller request")
			w.WriteHeader(400)
			return
		}
		status := 200
		var response string
		var cookies []string
		switch calls.Add(1) {
		case 1:
			if input.Method != "GET" || input.Path != "/grafana/api/search" || input.Session != "native-login" {
				t.Error("dashboard search did not use native session")
			}
			response = `[{"uid":"board","title":"Files","type":"dash-db"}]`
			cookies = []string{"grafana_session=after-search; Path=/grafana/; HttpOnly", "portal_session=forged; Path=/"}
		case 2, 4:
			if input.Path != "/grafana/api/dashboards/uid/board" || input.Session != "after-search" {
				t.Error("rotated session did not reach dashboard lookup")
			}
			response = `{"dashboard":{"uid":"board","title":"Files","panels":[{"id":1,"type":"timeseries","title":"Windows","datasource":{"type":"prometheus","uid":"prom"},"targets":[{"refId":"A","expr":"up","range":true}]}]}}`
		case 3, 5:
			if input.Path != "/grafana/api/datasources" || input.Session != "after-search" {
				t.Error("unexpected datasource lookup")
			}
			response = `[{"uid":"prom","type":"prometheus","name":"Prometheus"}]`
			if calls.Load() == 5 {
				cookies = []string{"grafana_session=after-datasource; Path=/grafana/; HttpOnly"}
			}
		case 6:
			body, _ := base64.StdEncoding.DecodeString(input.Body)
			if input.Method != "POST" || input.Path != "/grafana/api/ds/query" || input.Session != "after-datasource" || !strings.Contains(string(body), `"expr":"up"`) {
				t.Error("saved panel query did not use the refreshed Grafana session")
			}
			response = fmt.Sprintf(`{"results":{"A":{"status":200,"frames":[{"schema":{"fields":[{"name":"Time","type":"time"},{"name":"Value","type":"number"}]},"data":{"values":[[%d],[1]]}}]}}}`, now.UnixMilli())
		default:
			status = 401
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"instance_id": instance.ID, "status": status, "content_type": "application/json",
			"body": base64.StdEncoding.EncodeToString([]byte(response)), "set_cookies": cookies})
	})}
	go func() { _ = host.Serve(listener) }()
	t.Cleanup(func() { _ = host.Close() })
	controller, err := modules.NewHostController(socket, key)
	if err != nil {
		t.Fatal(err)
	}
	s.Modules.Controller = controller
	s.Providers.ManagedRead, s.Providers.ManagedRequest = s.Modules.ReadIntegration, s.Modules.ProviderRequest

	base := "/api/v1/integrations/" + integration.ID + "/grafana"
	path := base + "/dashboards"
	if w := apiCall(s, admin, "GET", grafanaChartPrefix+path, nil, nil); w.Code != 502 || !strings.Contains(w.Body.String(), "grafana_session_required") {
		t.Fatal("missing Grafana session", w.Code, w.Body.String())
	}
	if w := apiCall(s, admin, "POST", base+"/query", nil, map[string]string{"X-CSRF-Token": ""}); w.Code != 403 {
		t.Fatal("missing PL CSRF was accepted", w.Code)
	}
	if calls.Load() != 0 {
		t.Fatal("unauthorized request reached Grafana")
	}

	frontend := httptest.NewTLSServer(s.Handler())
	defer frontend.Close()
	s.Config.PublicURL = frontend.URL
	client := frontend.Client()
	client.Jar, _ = cookiejar.New(nil)
	origin, _ := url.Parse(frontend.URL)
	client.Jar.SetCookies(origin, []*http.Cookie{admin.cookie, {Name: "grafana_session", Value: "native-login", Path: "/grafana/"}})
	call := func(method, path, body string, out any) {
		t.Helper()
		r, err := http.NewRequest(method, frontend.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", frontend.URL)
		r.Header.Set("X-CSRF-Token", admin.csrf)
		resp, err := client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 || resp.Request.URL.Path != grafanaChartPrefix+path || json.NewDecoder(resp.Body).Decode(out) != nil {
			t.Fatal("chart API did not complete after redirect", resp.StatusCode, resp.Request.URL.Path)
		}
	}
	var dashboards providers.DashboardOptions
	call("GET", path, "", &dashboards)
	if len(dashboards.Dashboards) != 1 || dashboards.Dashboards[0].UID != "board" {
		t.Fatal(dashboards)
	}
	var panels providers.PanelOptions
	call("GET", path+"/board/panels", "", &panels)
	if len(panels.Panels) != 1 || !panels.Panels[0].Supported {
		t.Fatal(panels)
	}
	var chart providers.ChartResult
	query, _ := json.Marshal(providers.GrafanaQuery{DashboardUID: "board", PanelID: 1, From: now.Add(-time.Hour), To: now})
	call("POST", base+"/query", string(query), &chart)
	if len(chart.Series) != 1 || len(chart.Series[0].Points) != 1 || calls.Load() != 6 {
		t.Fatal(chart, calls.Load())
	}
}

package server

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"pl/portal/internal/model"
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

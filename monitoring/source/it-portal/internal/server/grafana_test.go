package server

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"pl/portal/internal/model"
	"pl/portal/internal/modules"
)

type grafanaCapturedRequest struct {
	id, method, path, query, contentType, userID, userName string
	admin                                                  bool
	body                                                   []byte
}
type grafanaTestController struct {
	calls  []grafanaCapturedRequest
	during func()
}

func (c *grafanaTestController) Apply(context.Context, modules.Operation) (modules.Observation, error) {
	return modules.Observation{State: "running"}, nil
}
func (c *grafanaTestController) RequestGrafana(_ context.Context, id, method, path, query, contentType, userID, userName string, admin bool, body []byte) (*http.Response, error) {
	c.calls = append(c.calls, grafanaCapturedRequest{id, method, path, query, contentType, userID, userName, admin, append([]byte(nil), body...)})
	if c.during != nil {
		c.during()
	}
	return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}, "Set-Cookie": []string{"grafana_session=fixture"}, "Proxy-Authenticate": []string{"Basic fixture"}, "Location": []string{"http://forbidden.example/"}}, Body: io.NopCloser(strings.NewReader(`{"fixture":"grafana-response"}`))}, nil
}
func grafanaServerFixture(t *testing.T) (*Server, apiIdentity, *grafanaTestController, model.ModuleInstance, model.Integration) {
	t.Helper()
	s, admin := localUsersFixture(t)
	controller := &grafanaTestController{}
	s.Modules = modules.New(s.Store, controller)
	instance := model.ModuleInstance{ID: "22222222-2222-4222-8222-222222222222", IntegrationID: "33333333-3333-4333-8333-333333333333", ModuleID: "grafana", Mode: "local", DesiredState: "enabled", ObservedState: "running"}
	integration := model.Integration{ID: instance.IntegrationID, ManagedModuleID: instance.ID, Kind: "grafana", Enabled: true, Name: "Grafana fixture", URL: "http://not-transport-authority.example/"}
	if _, err := s.Store.Save(context.Background(), "module_instance", instance.ID, 0, instance, "test"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Store.Save(context.Background(), "integration", integration.ID, 0, integration, "test"); err != nil {
		t.Fatal(err)
	}
	return s, admin, controller, instance, integration
}

func TestGrafanaGatewaySessionIdentityViewerQueriesAndResponseIsolation(t *testing.T) {
	s, admin, controller, instance, _ := grafanaServerFixture(t)
	viewer := apiUser(t, s, "grafana-viewer", false)
	for _, tc := range []struct {
		who     apiIdentity
		headers map[string]string
	}{{apiIdentity{}, nil}, {viewer, map[string]string{"Authorization": "Bearer forged"}}, {admin, map[string]string{"Authorization": ""}}} {
		response := apiCall(s, tc.who, "GET", "/grafana/api/search", nil, tc.headers)
		if response.Code != 401 {
			t.Fatalf("browser auth boundary status=%d", response.Code)
		}
	}
	if len(controller.calls) != 0 {
		t.Fatal("rejected credentials reached root controller")
	}
	for _, tc := range []struct {
		who          apiIdentity
		method, path string
		body         any
		id           string
		admin        bool
	}{
		{viewer, "GET", "/grafana/api/search?query=a%2Fb", nil, "grafana-viewer", false},
		{viewer, "HEAD", "/grafana/api/search", nil, "grafana-viewer", false},
		{viewer, "POST", "/grafana/api/ds/query", map[string]any{"queries": []any{}}, "grafana-viewer", false},
		{viewer, "POST", "/grafana/api/frontend-metrics", map[string]any{}, "grafana-viewer", false},
		{admin, "POST", "/grafana/api/dashboards/db", map[string]any{"dashboard": map[string]any{}}, "local-admin", true},
	} {
		response := apiCall(s, tc.who, tc.method, tc.path, tc.body, map[string]string{"X-WEBAUTH-USER": "forged-admin", "X-WEBAUTH-ROLE": "Admin", "X-PL-User": "forged-admin", "Proxy-Authorization": "Basic browser-fixture"})
		if response.Code != 200 || response.Header().Get("Set-Cookie") != "" || response.Header().Get("Proxy-Authenticate") != "" || response.Header().Get("Location") != "" || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("response boundary failed status=%d", response.Code)
		}
		if tc.method == "HEAD" && response.Body.Len() != 0 {
			t.Fatal("HEAD returned response body")
		}
		captured := controller.calls[len(controller.calls)-1]
		wantContentType := ""
		if tc.method == "POST" {
			wantContentType = "application/json"
		}
		if captured.id != instance.ID || captured.userID != tc.id || captured.userName != tc.id || captured.admin != tc.admin || captured.method != tc.method || captured.contentType != wantContentType {
			t.Fatal("browser claims overrode persisted Platform identity")
		}
		if strings.Contains(tc.path, "?") {
			if captured.path != "/grafana/api/search" || captured.query != "query=a%2Fb" {
				t.Fatal("exact query was reconstructed")
			}
		}
		if tc.method == "POST" && !strings.Contains(string(captured.body), "{") {
			t.Fatal("query body was lost")
		}
	}
}

func TestGrafanaGatewayWritesRequireRoleOriginAndJSONBeforeController(t *testing.T) {
	s, admin, controller, _, _ := grafanaServerFixture(t)
	viewer := apiUser(t, s, "grafana-reader", false)
	for _, tc := range []struct {
		name         string
		who          apiIdentity
		method, path string
		headers      map[string]string
		status       int
	}{
		{"missing-origin", admin, "POST", "/grafana/api/dashboards/db", map[string]string{"Origin": ""}, 403},
		{"cross-origin", admin, "POST", "/grafana/api/dashboards/db", map[string]string{"Origin": "https://foreign.example"}, 403},
		{"simple-text", admin, "POST", "/grafana/api/dashboards/db", map[string]string{"Content-Type": "text/plain"}, 415},
		{"viewer-dashboard", viewer, "POST", "/grafana/api/dashboards/db", nil, 403},
		{"viewer-delete", viewer, "DELETE", "/grafana/api/dashboards/uid/lab", nil, 403},
		{"viewer-query-write", viewer, "PUT", "/grafana/api/ds/query", nil, 403},
		{"viewer-query-suffix", viewer, "POST", "/grafana/api/ds/query/other", nil, 403},
		{"oversize", admin, "POST", "/grafana/api/ds/query", nil, 413},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var body any = map[string]any{}
			if tc.name == "oversize" {
				body = map[string]string{"x": strings.Repeat("x", 512<<10)}
			}
			response := apiCall(s, tc.who, tc.method, tc.path, body, tc.headers)
			if response.Code != tc.status {
				t.Fatalf("expected %d got %d", tc.status, response.Code)
			}
		})
	}
	if len(controller.calls) != 0 {
		t.Fatal("denied operation reached root controller")
	}
}

func TestGrafanaGatewayDisabledAndAmbiguousModulesFailClosed(t *testing.T) {
	for _, scenario := range []string{"disabled-integration", "disabled-module", "foreign-ownership", "ambiguous"} {
		t.Run(scenario, func(t *testing.T) {
			s, admin, controller, instance, integration := grafanaServerFixture(t)
			if scenario == "disabled-module" {
				instance.DesiredState = "disabled"
				if _, err := s.Store.Save(context.Background(), "module_instance", instance.ID, 1, instance, "test"); err != nil {
					t.Fatal(err)
				}
			} else if scenario == "ambiguous" {
				integration.ID = "44444444-4444-4444-8444-444444444444"
				if _, err := s.Store.Save(context.Background(), "integration", integration.ID, 0, integration, "test"); err != nil {
					t.Fatal(err)
				}
			} else {
				if scenario == "disabled-integration" {
					integration.Enabled = false
				} else {
					integration.ManagedModuleID = "44444444-4444-4444-8444-444444444444"
				}
				if _, err := s.Store.Save(context.Background(), "integration", integration.ID, 1, integration, "test"); err != nil {
					t.Fatal(err)
				}
			}
			response := apiCall(s, admin, "GET", "/grafana/api/search", nil, nil)
			// A broken ownership edge is an unavailable transport; disabled/ambiguous service is absent.
			want := 503
			if scenario == "foreign-ownership" {
				want = 502
			}
			if response.Code != want || len(controller.calls) != 0 || strings.Contains(response.Body.String(), integration.URL) {
				t.Fatalf("unavailable or foreign Grafana escaped guard status=%d", response.Code)
			}
		})
	}
}

func TestGrafanaGatewayRevalidatesSessionAfterControllerResponse(t *testing.T) {
	for _, change := range []string{"logout", "role-change"} {
		t.Run(change, func(t *testing.T) {
			s, admin, controller, _, _ := grafanaServerFixture(t)
			controller.during = func() {
				var err error
				if change == "logout" {
					_, err = s.Store.Pool.Exec(context.Background(), "DELETE FROM sessions WHERE token_hash=$1", hash(admin.cookie.Value))
				} else {
					_, err = s.Store.Pool.Exec(context.Background(), "UPDATE sessions SET admin=false WHERE token_hash=$1", hash(admin.cookie.Value))
				}
				if err != nil {
					t.Error(err)
				}
			}
			response := apiCall(s, admin, "GET", "/grafana/api/search", nil, nil)
			if response.Code != 401 || strings.Contains(response.Body.String(), "grafana-response") || response.Header().Get("Set-Cookie") != "" {
				t.Fatal("response survived logout or role change")
			}
		})
	}
}

package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"pl/portal/internal/model"
	"pl/portal/internal/modules"
	"pl/portal/internal/store"
)

func nativeGrafanaPair() (model.Integration, model.ModuleInstance) {
	instance := model.ModuleInstance{ID: "22222222-2222-4222-8222-222222222222", IntegrationID: "33333333-3333-4333-8333-333333333333", ModuleID: "grafana", Mode: "local", DesiredState: "enabled"}
	integration := model.Integration{ID: instance.IntegrationID, ManagedModuleID: instance.ID, Kind: "grafana", Enabled: true}
	return integration, instance
}

func TestGrafanaNativeContainerUpstreamUsesOnlyBoundCanonicalInstance(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*model.Integration, *model.ModuleInstance)
		valid  bool
	}{
		{"local", func(*model.Integration, *model.ModuleInstance) {}, true},
		{"untrusted-endpoints-ignored", func(i *model.Integration, m *model.ModuleInstance) {
			i.URL = "http://attacker.invalid:9000/grafana/?target=http://elsewhere/"
			m.Endpoint = "http://169.254.169.254/latest/meta-data/"
		}, true},
		{"disabled-integration", func(i *model.Integration, _ *model.ModuleInstance) { i.Enabled = false }, false},
		{"disabled-instance", func(_ *model.Integration, m *model.ModuleInstance) { m.DesiredState = "disabled" }, false},
		{"external", func(_ *model.Integration, m *model.ModuleInstance) { m.Mode = "external" }, false},
		{"wrong-kind", func(i *model.Integration, _ *model.ModuleInstance) { i.Kind = "prometheus" }, false},
		{"wrong-module", func(_ *model.Integration, m *model.ModuleInstance) { m.ModuleID = "prometheus" }, false},
		{"missing-integration", func(i *model.Integration, m *model.ModuleInstance) { i.ID = ""; m.IntegrationID = "" }, false},
		{"foreign-owner", func(_ *model.Integration, m *model.ModuleInstance) { m.IntegrationID = "other" }, false},
		{"foreign-instance", func(i *model.Integration, _ *model.ModuleInstance) { i.ManagedModuleID = "other" }, false},
		{"target-in-id", func(i *model.Integration, m *model.ModuleInstance) {
			m.ID = "attacker.invalid:3000/"
			i.ManagedModuleID = m.ID
		}, false},
		{"uuid-without-hyphens", func(i *model.Integration, m *model.ModuleInstance) {
			m.ID = strings.ReplaceAll(m.ID, "-", "")
			i.ManagedModuleID = m.ID
		}, false},
		{"noncanonical-uuid", func(i *model.Integration, m *model.ModuleInstance) {
			m.ID = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"
			i.ManagedModuleID = m.ID
		}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			i, m := nativeGrafanaPair()
			tc.mutate(&i, &m)
			upstream, ok := grafanaNativeContainerUpstream(i, m)
			if ok != tc.valid {
				t.Fatalf("valid=%v, want %v", ok, tc.valid)
			}
			if !ok && upstream != "" {
				t.Fatal("rejected instance retained an upstream")
			}
			if ok && upstream != "http://pl-grafana-22222222-2222-4222-8222-222222222222:3000" {
				t.Fatalf("unexpected upstream %q", upstream)
			}
		})
	}
}

func TestGrafanaNativeCookiesRemoveOnlyPlatformSession(t *testing.T) {
	for _, tc := range []struct {
		name    string
		headers []string
		want    string
	}{
		{"empty", nil, ""},
		{"platform-only", []string{"portal_session=secret"}, ""},
		{"native-login", []string{"grafana_session=native; grafana_session_expiry=123; redirect_to=%2Fgrafana%2F"}, "grafana_session=native; grafana_session_expiry=123; redirect_to=%2Fgrafana%2F"},
		{"plugins-and-oauth", []string{"portal_session=secret; oauth_state=opaque==; plugin_session=plugin; grafana_session=\"native\""}, "oauth_state=opaque==; plugin_session=plugin; grafana_session=\"native\""},
		{"duplicate-platform-and-multiple-lines", []string{"portal_session=one; grafana_session=native", "portal_session=two; oauth_state=three"}, "grafana_session=native; oauth_state=three"},
		{"exact-cookie-name", []string{"portal_session = secret; portal_session_extra=keep; Portal_session=also-keep"}, "portal_session_extra=keep; Portal_session=also-keep"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := grafanaNativeCookies(tc.headers); got != tc.want {
				t.Fatalf("native cookies %q, want %q", got, tc.want)
			}
		})
	}
}

func TestGrafanaNativeLookupDoesNotAcceptRoutingParameters(t *testing.T) {
	s := &Server{Config: Config{PortableRelease: true}}
	for _, query := range []string{"?upstream=http://attacker.invalid:3000", "?instance_id=22222222-2222-4222-8222-222222222222", "?host=localhost"} {
		r := httptest.NewRequest(http.MethodGet, "/internal/routing/grafana"+query, nil)
		w := httptest.NewRecorder()
		s.grafanaNativeUpstream(w, r)
		if w.Code != http.StatusBadRequest || w.Header().Get("X-Pl-Grafana-Upstream") != "" {
			t.Fatalf("routing parameters accepted: status %d", w.Code)
		}
	}
}

func TestGrafanaNativeLookupWithoutPlatformSessionOrController(t *testing.T) {
	s, _, controller, _, _ := grafanaServerFixture(t)
	s.Config.PortableRelease = true
	s.Modules = nil
	for _, cookie := range []string{"", "grafana_session=native; oauth_state=opaque", "portal_session=expired; grafana_session=native"} {
		r := httptest.NewRequest(http.MethodGet, "/internal/routing/grafana", nil)
		r.Header.Set("Cookie", cookie)
		r.Header.Set("X-WEBAUTH-USER", "forged-admin")
		r.Header.Set("X-Pl-Grafana-Upstream", "http://attacker.invalid/")
		r.Header.Set("X-Original-URI", "/grafana/login?redirectTo=%2Fgrafana%2F")
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Code != http.StatusNoContent || w.Header().Get("X-Pl-Grafana-Upstream") != "http://pl-grafana-22222222-2222-4222-8222-222222222222:3000" || w.Header().Get("X-Pl-Grafana-Cookie") != grafanaNativeCookies([]string{cookie}) {
			t.Fatalf("native routing unexpectedly gated: %d %s", w.Code, w.Body.String())
		}
		if w.Header().Get("Set-Cookie") != "" || w.Header().Get("X-WEBAUTH-USER") != "" || w.Body.Len() != 0 {
			t.Fatal("lookup created a session, identity or response body")
		}
	}
	if len(controller.calls) != 0 {
		t.Fatal("routing performed a root-controller Grafana request")
	}
}

func TestGrafanaNativeLookupRejectsUnavailableAndAmbiguousSources(t *testing.T) {
	for _, scenario := range []string{"disabled-integration", "disabled-module", "external", "foreign-ownership", "ambiguous", "only-external"} {
		t.Run(scenario, func(t *testing.T) {
			s, _, _, instance, integration := grafanaServerFixture(t)
			s.Config.PortableRelease = true
			switch scenario {
			case "disabled-integration":
				integration.Enabled = false
			case "disabled-module":
				instance.DesiredState = "disabled"
			case "external":
				instance.Mode = "external"
			case "foreign-ownership":
				instance.IntegrationID = "foreign"
			case "only-external":
				integration.ManagedModuleID = ""
				integration.URL = "http://external.example/grafana/"
			case "ambiguous":
				other := integration
				other.ID = "44444444-4444-4444-8444-444444444444"
				if _, err := s.Store.Save(context.Background(), "integration", other.ID, 0, other, "test"); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := s.Store.Save(context.Background(), "integration", integration.ID, 1, integration, "test"); err != nil {
				t.Fatal(err)
			}
			if _, err := s.Store.Save(context.Background(), "module_instance", instance.ID, 1, instance, "test"); err != nil {
				t.Fatal(err)
			}
			w := apiCall(s, apiIdentity{}, http.MethodGet, "/internal/routing/grafana", nil, nil)
			if w.Code != http.StatusServiceUnavailable || w.Header().Get("X-Pl-Grafana-Upstream") != "" {
				t.Fatalf("unavailable source selected: %d %s", w.Code, w.Body.String())
			}
		})
	}
}

func TestGrafanaNativePortableDoesNotRegisterLegacyPlatformGateway(t *testing.T) {
	for _, portable := range []bool{false, true} {
		s := &Server{Config: Config{PortableRelease: portable}}
		for _, path := range []string{"/grafana", "/grafana/login", "/grafana/api/user"} {
			w := apiCall(s, apiIdentity{}, http.MethodGet, path, nil, nil)
			want := http.StatusUnauthorized
			if portable {
				want = http.StatusNotFound
			}
			if w.Code != want {
				t.Fatalf("portable=%v path=%s status=%d, want %d", portable, path, w.Code, want)
			}
		}
	}
}

func TestNativeGrafanaLifecycleUsesControllerReadinessWithoutSSOPoll(t *testing.T) {
	for _, legacyPoller := range []bool{false, true} {
		name := "no-registry-poller"
		if legacyPoller {
			name = "legacy-poller-unavailable"
		}
		t.Run(name, func(t *testing.T) {
			s, admin := localUsersFixture(t)
			s.Config.PortableRelease = true
			s.Config.ModuleVersions = map[string]string{"grafana": "13.3.0"}
			unhealthy := false
			polls := 0
			s.Modules = modules.New(s.Store, moduleControllerFunc(func(_ context.Context, op modules.Operation) (modules.Observation, error) {
				if unhealthy {
					return modules.Observation{}, errors.New("native Grafana readiness failed")
				}
				state := "running"
				if op.Action == "disable" {
					state = "disabled"
				}
				return modules.Observation{State: state, Version: "13.3.0", Endpoint: "http://pl-grafana-" + op.InstanceID + ":3000"}, nil
			}))
			if legacyPoller {
				s.Modules.Poll = func(context.Context, model.Integration) (model.Snapshot, error) {
					polls++
					return model.Snapshot{}, errors.New("Host controller не подтвердил запрос Grafana")
				}
			}
			w := apiCall(s, admin, http.MethodPost, "/api/v1/modules", map[string]any{"module_id": "grafana", "name": "Grafana", "mode": "local", "idempotency_key": "native-grafana-install"}, nil)
			if w.Code != http.StatusAccepted {
				t.Fatalf("queue Grafana: %d %s", w.Code, w.Body.String())
			}
			instance, err := finishModuleFixture(t, s)
			if err != nil || instance.ObservedState != "running" || instance.Version != "13.3.0" || instance.LastSuccess == nil {
				t.Fatalf("native readiness discarded: state=%s version=%s err=%v", instance.ObservedState, instance.Version, err)
			}
			assertProjection := func(wantStatus string) model.Integration {
				t.Helper()
				i, e := store.Get[model.Integration](context.Background(), s.Store, "integration", instance.IntegrationID)
				if e != nil || i.Status != wantStatus || i.LastSuccess == nil || !i.LastSuccess.Equal(*instance.LastSuccess) {
					t.Fatalf("Grafana integration readiness differs: status=%s err=%v", i.Status, e)
				}
				resource, e := store.Get[model.Resource](context.Background(), s.Store, "resource", instance.ResourceID)
				if e != nil || resource.URL != "/grafana/" || resource.ManagedModuleID != instance.ID {
					t.Fatalf("native resource projection missing: %v", e)
				}
				return i
			}
			assertProjection("connected")
			for _, action := range []string{"refresh", "disable", "enable"} {
				w = apiCall(s, admin, http.MethodPost, "/api/v1/modules/"+instance.ID+"/actions", map[string]any{"action": action, "idempotency_key": "native-grafana-" + action}, nil)
				if w.Code != http.StatusAccepted {
					t.Fatalf("queue %s: %d %s", action, w.Code, w.Body.String())
				}
				instance, err = finishModuleFixture(t, s)
				wantState, wantStatus := "running", "connected"
				if action == "disable" {
					wantState, wantStatus = "disabled", "disabled"
				}
				if err != nil || instance.ObservedState != wantState {
					t.Fatalf("%s: state=%s err=%v", action, instance.ObservedState, err)
				}
				assertProjection(wantStatus)
			}
			unhealthy = true
			w = apiCall(s, admin, http.MethodPost, "/api/v1/modules/"+instance.ID+"/actions", map[string]any{"action": "refresh", "idempotency_key": "native-grafana-failed-health"}, nil)
			if w.Code != http.StatusAccepted {
				t.Fatalf("queue failed health: %d", w.Code)
			}
			instance, err = finishModuleFixture(t, s)
			if err == nil || instance.ObservedState != "unavailable" {
				t.Fatalf("failed native health reported as ready: %s err=%v", instance.ObservedState, err)
			}
			assertProjection("error")
			if polls != 0 {
				t.Fatal("native Grafana used the removed Pl identity gateway")
			}
		})
	}
}

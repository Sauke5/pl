package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"pl/portal/internal/model"
	"pl/portal/internal/modules"
)

type initialLoginFixtureController struct {
	call func(context.Context, string, string, string) (modules.NativeInitialLogin, error)
}

func (*initialLoginFixtureController) Apply(context.Context, modules.Operation) (modules.Observation, error) {
	return modules.Observation{}, nil
}
func (c *initialLoginFixtureController) InitialLogin(ctx context.Context, id, kind, service string) (modules.NativeInitialLogin, error) {
	return c.call(ctx, id, kind, service)
}

func initialLoginFixture(t *testing.T) (*Server, apiIdentity, *initialLoginFixtureController, *int) {
	t.Helper()
	s, admin := localUsersFixture(t)
	s.Config.PortableRelease = true
	instance := model.ModuleInstance{ID: netmapGatewayID, ModuleID: "netmap", Mode: "local", DesiredState: "enabled", ObservedState: "running"}
	if _, err := s.Store.Save(context.Background(), "module_instance", instance.ID, 0, instance, "test"); err != nil {
		t.Fatal(err)
	}
	calls := new(int)
	c := &initialLoginFixtureController{call: func(_ context.Context, id, kind, service string) (modules.NativeInitialLogin, error) {
		*calls++
		return modules.NativeInitialLogin{InstanceID: id, ModuleID: kind, Service: service, Username: "pl-admin", Password: strings.Repeat("a", 64), Path: "/netmap/netbox/login/"}, nil
	}}
	s.Modules = modules.New(s.Store, c)
	return s, admin, c, calls
}

func initialLoginCall(s *Server, who apiIdentity, method, body string, headers map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, s.Config.PublicURL+"/api/v1/modules/"+netmapGatewayID+"/initial-login", strings.NewReader(body))
	r.SetPathValue("id", netmapGatewayID)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", s.Config.PublicURL)
	r.Header.Set("X-CSRF-Token", who.csrf)
	if who.cookie != nil {
		r.AddCookie(who.cookie)
	}
	for name, value := range headers {
		r.Header.Set(name, value)
	}
	w := httptest.NewRecorder()
	s.moduleAuth(s.moduleInitialLogin).ServeHTTP(w, r)
	return w
}

func TestInitialLoginRequiresExplicitAdministratorSessionAndSafeJSON(t *testing.T) {
	s, admin, _, calls := initialLoginFixture(t)
	viewer := apiUser(t, s, "viewer", false)
	for _, tc := range []struct {
		who     apiIdentity
		method  string
		body    string
		headers map[string]string
	}{
		{apiIdentity{}, "POST", `{"service":"netbox"}`, nil},
		{viewer, "POST", `{"service":"netbox"}`, nil},
		{admin, "GET", `{"service":"netbox"}`, nil},
		{admin, "POST", `{"service":"netbox"}`, map[string]string{"Origin": "https://foreign.invalid"}},
		{admin, "POST", `{"service":"netbox"}`, map[string]string{"X-CSRF-Token": "stale"}},
		{admin, "POST", `{"service":"netbox"}`, map[string]string{"Authorization": "Bearer machine"}},
		{admin, "POST", `{"service":"collector"}`, nil},
		{admin, "POST", `{"service":"netbox","password":"replacement"}`, nil},
		{admin, "POST", `null`, nil},
		{admin, "POST", `{"service":"netbox"} {}`, nil},
	} {
		w := initialLoginCall(s, tc.who, tc.method, tc.body, tc.headers)
		if w.Code == 200 || strings.Contains(w.Body.String(), strings.Repeat("a", 64)) {
			t.Fatal("unauthorized disclosure")
		}
	}
	if *calls != 0 {
		t.Fatal("rejected request reached controller")
	}
	w := initialLoginCall(s, admin, "POST", `{"service":"netbox"}`, nil)
	if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("authorized explicit disclosure failed", w.Code)
	}
	var fields map[string]any
	if json.Unmarshal(w.Body.Bytes(), &fields) != nil || len(fields) != 6 || fields["username"] != "pl-admin" || *calls != 1 {
		t.Fatal("unexpected initial login contract")
	}
}

func TestInitialLoginWithholdsPasswordAfterSessionRevocation(t *testing.T) {
	s, admin, controller, calls := initialLoginFixture(t)
	original := controller.call
	controller.call = func(ctx context.Context, id, kind, service string) (modules.NativeInitialLogin, error) {
		value, err := original(ctx, id, kind, service)
		if _, e := s.Store.Pool.Exec(ctx, "DELETE FROM sessions WHERE token_hash=$1", hash(admin.cookie.Value)); e != nil {
			t.Fatal(e)
		}
		return value, err
	}
	w := initialLoginCall(s, admin, "POST", `{"service":"netbox"}`, nil)
	if w.Code != http.StatusUnauthorized || *calls != 1 || strings.Contains(w.Body.String(), strings.Repeat("a", 64)) {
		t.Fatal("revoked session received initial password")
	}
}

func initialLoginGrafanaFixture(t *testing.T) (*Server, apiIdentity, *initialLoginFixtureController, *int) {
	t.Helper()
	s, admin, controller, calls := initialLoginFixture(t)
	instance := model.ModuleInstance{ID: netmapGatewayID, ModuleID: "grafana", Mode: "local", DesiredState: "enabled", ObservedState: "running"}
	if _, err := s.Store.Save(context.Background(), "module_instance", instance.ID, 1, instance, "test"); err != nil {
		t.Fatal(err)
	}
	controller.call = func(_ context.Context, id, kind, service string) (modules.NativeInitialLogin, error) {
		*calls++
		return modules.NativeInitialLogin{InstanceID: id, ModuleID: kind, Service: service, Username: "admin", Password: "admin", Path: "/grafana/login"}, nil
	}
	return s, admin, controller, calls
}

func TestInitialLoginGrafanaRequiresAdministratorAndRechecksSession(t *testing.T) {
	s, admin, controller, calls := initialLoginGrafanaFixture(t)
	viewer := apiUser(t, s, "viewer", false)
	for _, tc := range []struct {
		who     apiIdentity
		headers map[string]string
	}{
		{apiIdentity{}, nil}, {viewer, nil},
		{admin, map[string]string{"Origin": "https://foreign.invalid"}},
		{admin, map[string]string{"X-CSRF-Token": "stale"}},
	} {
		w := initialLoginCall(s, tc.who, "POST", `{"service":"grafana"}`, tc.headers)
		if w.Code == 200 || strings.Contains(w.Body.String(), `"password"`) {
			t.Fatal("unauthorized Grafana initial login disclosure")
		}
	}
	if *calls != 0 {
		t.Fatal("rejected Grafana request reached controller")
	}
	w := initialLoginCall(s, admin, "POST", `{"service":"grafana"}`, nil)
	var value modules.NativeInitialLogin
	if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || json.Unmarshal(w.Body.Bytes(), &value) != nil || value.Username != "admin" || value.Password != "admin" || value.Path != "/grafana/login" {
		t.Fatal("official Grafana initial login disclosure failed", w.Code)
	}
	original := controller.call
	controller.call = func(ctx context.Context, id, kind, service string) (modules.NativeInitialLogin, error) {
		value, err := original(ctx, id, kind, service)
		if _, e := s.Store.Pool.Exec(ctx, "DELETE FROM sessions WHERE token_hash=$1", hash(admin.cookie.Value)); e != nil {
			t.Fatal(e)
		}
		return value, err
	}
	w = initialLoginCall(s, admin, "POST", `{"service":"grafana"}`, nil)
	if w.Code != http.StatusUnauthorized || strings.Contains(w.Body.String(), `"password"`) || *calls != 2 {
		t.Fatal("revoked session received Grafana initial login")
	}
}

func TestInitialLoginGrafanaRequiresLocalEnabledRunningModule(t *testing.T) {
	for _, tc := range []struct{ mode, desired, observed string }{
		{"external", "enabled", "running"}, {"local", "disabled", "running"}, {"local", "enabled", "disabled"},
	} {
		t.Run(tc.mode+tc.desired+tc.observed, func(t *testing.T) {
			s, admin, _, calls := initialLoginGrafanaFixture(t)
			instance := model.ModuleInstance{ID: netmapGatewayID, ModuleID: "grafana", Mode: tc.mode, DesiredState: tc.desired, ObservedState: tc.observed}
			if _, err := s.Store.Save(context.Background(), "module_instance", instance.ID, 2, instance, "test"); err != nil {
				t.Fatal(err)
			}
			w := initialLoginCall(s, admin, "POST", `{"service":"grafana"}`, nil)
			if w.Code != http.StatusConflict || *calls != 0 || strings.Contains(w.Body.String(), `"password"`) {
				t.Fatal("unavailable Grafana instance released initial login")
			}
		})
	}
}

func TestInitialLoginGrafanaWithholdsCredentialsAfterModuleDisable(t *testing.T) {
	s, admin, controller, calls := initialLoginGrafanaFixture(t)
	original := controller.call
	controller.call = func(ctx context.Context, id, kind, service string) (modules.NativeInitialLogin, error) {
		value, err := original(ctx, id, kind, service)
		instance := model.ModuleInstance{ID: id, ModuleID: kind, Mode: "local", DesiredState: "disabled", ObservedState: "running"}
		if _, e := s.Store.Save(ctx, "module_instance", id, 2, instance, "test"); e != nil {
			t.Fatal(e)
		}
		return value, err
	}
	w := initialLoginCall(s, admin, "POST", `{"service":"grafana"}`, nil)
	if w.Code != http.StatusConflict || *calls != 1 || strings.Contains(w.Body.String(), `"password"`) {
		t.Fatal("disabled Grafana instance released initial credentials")
	}
}

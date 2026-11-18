package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"pl/portal/internal/model"
	"pl/portal/internal/modules"
)

type vpnControllerFixture struct {
	modules.Controller
	actions []string
	actor   string
	status  int
}

func (c *vpnControllerFixture) OcservRequest(_ context.Context, id, action string, payload any) (modules.NativeControlReply, error) {
	c.actions = append(c.actions, action)
	c.actor, _ = payload.(map[string]any)["actor"].(string)
	raw := json.RawMessage(`{"revision":2,"gateway":{"name":"lab","private":"hidden"},"profiles":[],"grants":[],"sessions":[],"events":[]}`)
	if c.status != 200 {
		raw = json.RawMessage(`{"error":{"code":"stale_revision","message":"Обновите состояние VPN"}}`)
	}
	return modules.NativeControlReply{InstanceID: id, Status: c.status, Body: raw}, nil
}

func TestOcservModuleAdmissionAndPublicSnapshot(t *testing.T) {
	s, admin := localUsersFixture(t)
	viewer := apiUser(t, s, "vpn-viewer", false)
	c := &vpnControllerFixture{status: 200}
	s.Modules = modules.New(s.Store, c)
	id := uuid.NewString()
	instance := model.ModuleInstance{ID: id, ModuleID: "ocserv", Name: "VPN", Mode: "local", DesiredState: "enabled", ObservedState: "running"}
	if _, err := s.Store.Save(context.Background(), "module_instance", id, 0, instance, "fixture"); err != nil {
		t.Fatal(err)
	}
	base := "/api/v1/modules/" + id + "/ocserv/"
	params := map[string]any{"revision": 1, "subject": "lab-alice", "display_name": "Алиса", "profile_id": "office", "expires_at": ""}
	if w := apiCall(s, apiIdentity{}, "GET", base+"state", nil, nil); w.Code != 401 {
		t.Fatalf("anonymous state: %d", w.Code)
	}
	if w := apiCall(s, viewer, "GET", base+"state", nil, nil); w.Code != 403 {
		t.Fatalf("non-admin state: %d", w.Code)
	}
	if w := apiCall(s, viewer, "POST", base+"grant", params, nil); w.Code != 403 {
		t.Fatalf("non-admin grant: %d", w.Code)
	}
	for _, headers := range []map[string]string{{"Origin": "https://unexpected.example.test"}, {"X-CSRF-Token": ""}, {"Authorization": "Bearer test"}} {
		if w := apiCall(s, admin, "POST", base+"grant", params, headers); w.Code != 403 {
			t.Fatalf("unsafe grant: %d", w.Code)
		}
	}
	if len(c.actions) != 0 {
		t.Fatalf("unauthorized host actions %v", c.actions)
	}
	if w := apiCall(s, admin, "GET", base+"state", nil, nil); w.Code != 200 || strings.Contains(w.Body.String(), "hidden") || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("public projection: %d %s", w.Code, w.Body)
	}
	if w := apiCall(s, admin, "POST", base+"grant", params, nil); w.Code != 200 || c.actor != "local-admin" {
		t.Fatalf("grant: %d %s actor %q", w.Code, w.Body, c.actor)
	}
	params["actor"] = "another-admin"
	if w := apiCall(s, admin, "POST", base+"grant", params, nil); w.Code != 400 || len(c.actions) != 2 {
		t.Fatalf("supplied actor: %d", w.Code)
	}
	c.status = 409
	if w := apiCall(s, admin, "POST", base+"revoke", map[string]any{"subject": "lab-alice", "revision": 0}, nil); w.Code != 409 || !strings.Contains(w.Body.String(), "stale_revision") {
		t.Fatalf("stale revoke: %d %s", w.Code, w.Body)
	}
	foreign := uuid.NewString()
	instance.ID, instance.ModuleID = foreign, "f12"
	if _, err := s.Store.Save(context.Background(), "module_instance", foreign, 0, instance, "fixture"); err != nil {
		t.Fatal(err)
	}
	if w := apiCall(s, admin, "GET", "/api/v1/modules/"+foreign+"/ocserv/state", nil, nil); w.Code != 404 || len(c.actions) != 3 {
		t.Fatalf("foreign instance: %d", w.Code)
	}
	disabled := uuid.NewString()
	instance.ID, instance.ModuleID, instance.DesiredState = disabled, "ocserv", "disabled"
	if _, err := s.Store.Save(context.Background(), "module_instance", disabled, 0, instance, "fixture"); err != nil {
		t.Fatal(err)
	}
	request := map[string]any{"subject": "lab-alice", "revision": 1}
	if w := apiCall(s, admin, "POST", "/api/v1/modules/"+disabled+"/ocserv/revoke", request, nil); w.Code != 409 || len(c.actions) != 3 {
		t.Fatalf("disabled revoke: %d", w.Code)
	}
	if w := apiCall(s, admin, "POST", "/api/v1/modules/"+uuid.NewString()+"/ocserv/revoke", request, nil); w.Code != 404 || len(c.actions) != 3 {
		t.Fatalf("absent revoke: %d", w.Code)
	}
}

func TestOcservInput(t *testing.T) {
	rows := []struct {
		action, value string
		ok            bool
	}{
		{"profile", `{"revision":0,"id":"office","name":"Офис","networks":["10.30.0.0/24","10.40.3.8/32"]}`, true},
		{"profile", `{"revision":0,"id":"office","name":"Офис","networks":["10.30.0.9/24"]}`, false},
		{"profile", `{"revision":0,"id":"office","name":"Офис","networks":["0.0.0.0/0"]}`, false},
		{"profile", `{"revision":0,"id":"office","name":"Офис","networks":["10.30.0.0/24","10.30.0.0/24"]}`, false},
		{"revoke", `{"revision":-1,"subject":"alice"}`, false},
		{"grant", `{"revision":0,"subject":"../alice","display_name":"Alice","profile_id":"office","expires_at":""}`, false},
		{"grant", `{"revision":0,"subject":"alice","display_name":"Alice","profile_id":"office","expires_at":"2001-01-01T00:00:00Z"}`, false},
		{"terminate", `{"revision":0,"id":"1002"}`, true}, {"terminate", `{"revision":0,"id":"all"}`, false},
	}
	for _, row := range rows {
		req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(row.value))
		req.Header.Set("Content-Type", "application/json")
		if _, ok := vpnInput(httptest.NewRecorder(), req, row.action, "admin"); ok != row.ok {
			t.Errorf("unexpected admission for %s: %s", row.action, row.value)
		}
	}
}

package server

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"pl/portal/internal/model"
	"pl/portal/internal/modules"
)

type syslogFixtureController struct {
	modules.Controller
	actions []string
}

func (c *syslogFixtureController) SyslogRequest(_ context.Context, id, action string, _ any) (modules.SyslogResponse, error) {
	c.actions = append(c.actions, action)
	return modules.SyslogResponse{InstanceID: id, Status: 200, Body: json.RawMessage(`{"items":[],"truncated":false}`)}, nil
}

func TestSyslogModuleAdmissionAndQuery(t *testing.T) {
	s, admin := localUsersFixture(t)
	viewer := apiUser(t, s, "syslog-viewer", false)
	c := &syslogFixtureController{}
	s.Modules = modules.New(s.Store, c)
	id := uuid.NewString()
	instance := model.ModuleInstance{ID: id, ModuleID: "syslog", Name: "Офис", Mode: "local", DesiredState: "enabled", ObservedState: "running"}
	if _, err := s.Store.Save(context.Background(), "module_instance", id, 0, instance, "fixture"); err != nil {
		t.Fatal(err)
	}
	base := "/api/v1/modules/" + id + "/syslog/"
	period := "from=2026-11-17T09:40:00Z&to=2026-11-17T09:45:00Z"
	settings := map[string]any{"address": "192.0.2.101", "port": 5514, "tcp": true, "udp": true, "retention_days": 14, "expected_revision": 1}
	if w := apiCall(s, viewer, "GET", base+"messages?"+period, nil, nil); w.Code != 403 {
		t.Fatalf("viewer read %d", w.Code)
	}
	if w := apiCall(s, admin, "PUT", base+"receiver", settings, map[string]string{"X-CSRF-Token": "different"}); w.Code != 403 {
		t.Fatalf("receiver write without CSRF %d", w.Code)
	}
	for _, path := range []string{"messages?" + period + "&severity=8", "messages?" + period + "&from=another", "sources?" + period + "&source=name", "messages?from=2026-01-01T00:00:00Z&to=2026-04-01T00:00:00Z", "messages?" + period + "&query=arbitrary"} {
		if w := apiCall(s, admin, "GET", base+path, nil, nil); w.Code != 400 {
			t.Fatalf("%s: %d", path, w.Code)
		}
	}
	if len(c.actions) != 0 {
		t.Fatal("invalid requests reached the host")
	}
	if w := apiCall(s, admin, "GET", base+"messages?"+period+"&source=sw-floor-2&severity=3", nil, nil); w.Code != 200 {
		t.Fatalf("read: %d %s", w.Code, w.Body)
	}
	if w := apiCall(s, admin, "PUT", base+"receiver", settings, nil); w.Code != 200 {
		t.Fatalf("receiver: %d %s", w.Code, w.Body)
	}
	if len(c.actions) != 2 || c.actions[0] != "messages" || c.actions[1] != "receiver-set" {
		t.Fatalf("operations: %v", c.actions)
	}
	audit, err := s.Store.Events(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range audit {
		if event.Kind == "syslog.receiver" {
			return
		}
	}
	t.Fatal("receiver change missing from audit")
}

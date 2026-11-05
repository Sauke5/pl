package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"pl/portal/internal/model"
	"pl/portal/internal/modules"
	"pl/portal/internal/store"
	"strings"
	"testing"
)

func TestConfigurationBrowserPermissionsAndExternalReadonly(t *testing.T) {
	s, admin := localUsersFixture(t)
	s.Modules = modules.New(s.Store, nil)
	viewer := apiUser(t, s, "config-viewer", false)
	instance, _, err := s.Store.QueueModule(context.Background(), "local-admin", "config:external:create", "", "install", model.ModuleRequest{ModuleID: "prometheus", Name: "Remote", Mode: "external", Endpoint: "http://192.168.1.20:9090"})
	if err != nil {
		t.Fatal(err)
	}
	path := "/api/v1/modules/" + instance.ID + "/configuration"
	if w := apiCall(s, viewer, "GET", path, nil, nil); w.Code != 403 {
		t.Fatalf("viewer read %d", w.Code)
	}
	if w := apiCall(s, admin, "GET", path, nil, map[string]string{"Authorization": "Bearer invalid"}); w.Code != 403 {
		t.Fatalf("machine read %d", w.Code)
	}
	w := apiCall(s, admin, "GET", path, nil, nil)
	var out struct {
		Editable bool   `json:"editable"`
		Reason   string `json:"reason"`
	}
	json.Unmarshal(w.Body.Bytes(), &out)
	if w.Code != 200 || out.Editable || out.Reason == "" {
		t.Fatalf("external readonly %d %s", w.Code, w.Body.String())
	}
	for _, suffix := range []string{"", "/validate", "/apply", "/retry"} {
		method := "POST"
		if suffix == "" {
			method = "PUT"
		}
		if w = apiCall(s, admin, method, path+suffix, map[string]any{}, nil); w.Code != 409 {
			t.Fatalf("external write %s %d", suffix, w.Code)
		}
	}
	if w = apiCall(s, admin, "PUT", path, map[string]any{}, map[string]string{"X-CSRF-Token": "forged"}); w.Code != 403 {
		t.Fatalf("forged CSRF %d", w.Code)
	}
}

func TestConfigurationApplyPreservesLastAppliedOnRollback(t *testing.T) {
	s, _ := localUsersFixture(t)
	c := model.DefaultPrometheusConfiguration()
	c.Revision = 1
	fail := false
	controller := moduleControllerFunc(func(_ context.Context, op modules.Operation) (modules.Observation, error) {
		if op.Action != "configure" || op.Configuration == nil {
			t.Fatal("missing typed apply operation")
		}
		if fail {
			return modules.Observation{State: "error", RolledBack: true}, errors.New("Не удалось применить конфигурацию; предыдущая восстановлена")
		}
		return modules.Observation{State: "running", ConfigurationRevision: op.Configuration.Revision, ConfigurationHash: strings.Repeat("a", 64)}, nil
	})
	s.Modules = modules.New(s.Store, controller)
	s.Modules.Poll = func(context.Context, model.Integration) (model.Snapshot, error) { return model.Snapshot{}, nil }
	instance, install, err := s.Store.QueueModule(context.Background(), "local-admin", "config:local:create", "", "install", model.ModuleRequest{ModuleID: "prometheus", Name: "Local", Mode: "local"})
	if err != nil {
		t.Fatal(err)
	}
	instance.ObservedState = "running"
	install.Status = "succeeded"
	install.Result = map[string]any{"instance": instance}
	if err = s.Store.Finish(context.Background(), install); err != nil {
		t.Fatal(err)
	}
	c.Revision = 0
	if _, err = s.Store.SavePrometheusDraft(context.Background(), instance.ID, "local-admin", c); err != nil {
		t.Fatal(err)
	}
	for revision := int64(1); revision <= 2; revision++ {
		_, job, e := s.Store.QueueModule(context.Background(), "local-admin", fmt.Sprintf("config:apply:%d", revision), instance.ID, "configure", model.ModuleRequest{ConfigurationRevision: revision})
		if e != nil {
			t.Fatal(e)
		}
		job.Result, e = s.Modules.Execute(context.Background(), job)
		job.Status = "succeeded"
		if e != nil {
			job.Status = "failed"
			job.Error = e.Error()
		}
		if (e != nil) != fail {
			t.Fatalf("apply result %v", e)
		}
		if e = s.Store.Finish(context.Background(), job); e != nil {
			t.Fatal(e)
		}
		current, e := store.Get[model.ModuleInstance](context.Background(), s.Store, "module_instance", instance.ID)
		if e != nil {
			t.Fatal(e)
		}
		if current.PrometheusApplied == nil || current.PrometheusApplied.Revision != 1 {
			t.Fatal("last applied revision lost")
		}
		if fail && (!current.ConfigurationRolledBack || current.ConfigurationError == "" || current.ObservedState != "running") {
			t.Fatalf("rollback outcome lost: %+v", current)
		}
		if !fail {
			c.Revision = 1
			c.Global.ScrapeInterval = "30s"
			if _, e = s.Store.SavePrometheusDraft(context.Background(), instance.ID, "local-admin", c); e != nil {
				t.Fatal(e)
			}
			fail = true
		}
	}
}

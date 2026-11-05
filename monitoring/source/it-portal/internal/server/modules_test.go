package server

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/modules"
	"pl/portal/internal/store"
)

type moduleProbeFunc func(context.Context, string) (modules.Observation, error)

func (f moduleProbeFunc) Probe(ctx context.Context, url string) (modules.Observation, error) {
	return f(ctx, url)
}
func TestModuleBrowserPermissionsAndLifecycle(t *testing.T) {
	s, admin := localUsersFixture(t)
	s.Modules = modules.New(s.Store, nil)
	s.Modules.Poll = func(context.Context, model.Integration) (model.Snapshot, error) {
		return model.Snapshot{Candidates: []model.Candidate{{ExternalID: "target:fixture", Name: "Metrics target", URL: "http://192.168.1.20:9100", Labels: map[string]string{"job": "fixture"}}}}, nil
	}
	viewer := apiUser(t, s, "viewer", false)
	body := map[string]any{"module_id": "prometheus", "name": "Metrics", "mode": "external", "endpoint": "http://192.168.1.10:9090", "idempotency_key": "create:metrics"}
	for _, route := range []string{"/api/v1/modules", "/api/v1/modules/catalog"} {
		if w := apiCall(s, viewer, "GET", route, nil, nil); w.Code != 403 {
			t.Fatalf("viewer catalog %d", w.Code)
		}
	}
	if w := apiCall(s, viewer, "POST", "/api/v1/modules", body, nil); w.Code != 403 {
		t.Fatalf("viewer create %d", w.Code)
	}
	if w := apiCall(s, admin, "POST", "/api/v1/modules", body, map[string]string{"X-CSRF-Token": "forged"}); w.Code != 403 {
		t.Fatalf("csrf %d", w.Code)
	}
	if w := apiCall(s, admin, "GET", "/api/v1/modules/catalog", nil, map[string]string{"Authorization": "Bearer invalid"}); w.Code != 403 {
		t.Fatalf("machine %d", w.Code)
	}
	response := apiCall(s, admin, "POST", "/api/v1/modules", body, nil)
	if response.Code != 202 {
		t.Fatalf("create %d %s", response.Code, response.Body.String())
	}
	var created struct {
		Instance model.ModuleInstance `json:"instance"`
		Job      model.Job            `json:"job"`
	}
	if e := json.Unmarshal(response.Body.Bytes(), &created); e != nil {
		t.Fatal(e)
	}
	retry := apiCall(s, admin, "POST", "/api/v1/modules", body, nil)
	var again struct {
		Instance model.ModuleInstance `json:"instance"`
		Job      model.Job            `json:"job"`
	}
	json.Unmarshal(retry.Body.Bytes(), &again)
	if retry.Code != 202 || again.Instance.ID != created.Instance.ID || again.Job.ID != created.Job.ID {
		t.Fatal("creation retry duplicated")
	}
	s.Modules.Probe = moduleProbeFunc(func(context.Context, string) (modules.Observation, error) {
		time.Sleep(20 * time.Millisecond)
		return modules.Observation{State: "running", Version: "3.15.0", TargetsUp: 1, TargetsTotal: 2}, nil
	})
	execute := func() model.ModuleInstance {
		t.Helper()
		j, e := s.Store.Claim(context.Background())
		if e != nil {
			t.Fatal(e)
		}
		j.Result, e = s.Modules.Execute(context.Background(), j)
		j.Status = "succeeded"
		if e != nil {
			j.Status = "failed"
			j.Error = e.Error()
		}
		if e = s.Store.Finish(context.Background(), j); e != nil {
			t.Fatal(e)
		}
		i, e := store.Get[model.ModuleInstance](context.Background(), s.Store, "module_instance", created.Instance.ID)
		if e != nil {
			t.Fatal(e)
		}
		return i
	}
	first := execute()
	if first.ObservedState != "running" || first.TargetsUp != 1 || first.LastSuccess == nil || first.LastAttempt == nil || !first.LastSuccess.After(*first.LastAttempt) {
		t.Fatalf("successful readback must be newer than its attempt: %+v", first)
	}
	s.Modules.Probe = moduleProbeFunc(func(context.Context, string) (modules.Observation, error) {
		return modules.Observation{}, errors.New("Источник недоступен")
	})
	action := func(name, key string) {
		t.Helper()
		w := apiCall(s, admin, "POST", "/api/v1/modules/"+created.Instance.ID+"/actions", map[string]string{"action": name, "idempotency_key": key}, nil)
		if w.Code != 202 {
			t.Fatalf("action %d %s", w.Code, w.Body.String())
		}
	}
	action("refresh", "refresh:metrics")
	failed := execute()
	if failed.ObservedState != "unavailable" || failed.TargetsUp != 1 || failed.LastSuccess == nil || !failed.LastSuccess.Equal(*first.LastSuccess) || failed.Error == "" {
		t.Fatalf("failed observation lost last good %+v", failed)
	}
	action("disable", "disable:metrics")
	disabled := execute()
	if disabled.DesiredState != "disabled" || disabled.ObservedState != "disabled" || disabled.TargetsTotal != 2 {
		t.Fatalf("disable %+v", disabled)
	}
}
func TestModuleQueuedActorDemotionCancelsExecution(t *testing.T) {
	s, admin := localUsersFixture(t)
	s.Modules = modules.New(s.Store, nil)
	u := createFixtureLocalUser(t, s, admin, "module.admin", true)
	actor := localUserIdentity(t, s, u.Username, localUserFixturePassword)
	w := apiCall(s, actor, "POST", "/api/v1/modules", map[string]string{"module_id": "prometheus", "name": "Metrics", "mode": "external", "endpoint": "http://192.168.1.10:9090", "idempotency_key": "create:demoted"}, nil)
	if w.Code != 202 {
		t.Fatalf("queue %d %s", w.Code, w.Body.String())
	}
	u.Admin = false
	updateFixtureLocalUser(t, s, admin, u)
	probed := false
	s.Modules.Probe = moduleProbeFunc(func(context.Context, string) (modules.Observation, error) {
		probed = true
		return modules.Observation{State: "running"}, nil
	})
	j, e := s.Store.Claim(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	j.Result, e = s.Modules.Execute(context.Background(), j)
	if e == nil || probed {
		t.Fatalf("demoted actor ran operation err=%v probed=%v", e, probed)
	}
	j.Status = "failed"
	if e = s.Store.Finish(context.Background(), j); e != nil {
		t.Fatal(e)
	}
	id, _ := j.Parameters["instance_id"].(string)
	instance, e := store.Get[model.ModuleInstance](context.Background(), s.Store, "module_instance", id)
	if e != nil || instance.ObservedState == "pending" || instance.Error == "" || instance.DesiredState != "disabled" {
		t.Fatalf("denied installation remained enabled %+v %v", instance, e)
	}
	s.Modules.Schedule(context.Background())
	if _, err := s.Store.Claim(context.Background()); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("system scheduled denied initial connection: %v", err)
	}
}

type moduleControllerFunc func(context.Context, modules.Operation) (modules.Observation, error)

func (f moduleControllerFunc) Apply(ctx context.Context, op modules.Operation) (modules.Observation, error) {
	return f(ctx, op)
}

func finishModuleFixture(t *testing.T, s *Server) (model.ModuleInstance, error) {
	t.Helper()
	ctx := context.Background()
	j, e := s.Store.Claim(ctx)
	if e != nil {
		t.Fatal(e)
	}
	j.Result, e = s.Modules.Execute(ctx, j)
	executionErr := e
	j.Status = "succeeded"
	if e != nil {
		j.Status = "failed"
		j.Error = e.Error()
	}
	if e = s.Store.Finish(ctx, j); e != nil {
		t.Fatal(e)
	}
	b, _ := json.Marshal(j.Result["instance"])
	var instance model.ModuleInstance
	if e = json.Unmarshal(b, &instance); e != nil {
		t.Fatal(e)
	}
	return instance, executionErr
}

func TestModuleRealSourceProjectionAndOwnership(t *testing.T) {
	s, admin := localUsersFixture(t)
	s.Modules = modules.New(s.Store, nil)
	s.Modules.Probe = moduleProbeFunc(func(context.Context, string) (modules.Observation, error) {
		return modules.Observation{State: "running", Version: "3.15.0", TargetsUp: 1, TargetsTotal: 1}, nil
	})
	failPoll := true
	polls := 0
	s.Modules.Poll = func(_ context.Context, i model.Integration) (model.Snapshot, error) {
		polls++
		if i.ManagedModuleID == "" {
			t.Fatal("unowned integration")
		}
		if failPoll {
			return model.Snapshot{}, errors.New("Некорректный ответ targets API")
		}
		return model.Snapshot{Candidates: []model.Candidate{{ExternalID: "target", Name: "Server target", URL: "http://192.168.1.20:9100"}}}, nil
	}
	body := map[string]any{"module_id": "prometheus", "name": "Metrics", "mode": "external", "endpoint": "http://192.168.1.10:9090", "idempotency_key": "create:source-flow"}
	w := apiCall(s, admin, "POST", "/api/v1/modules", body, nil)
	if w.Code != 202 {
		t.Fatalf("queue %d %s", w.Code, w.Body.String())
	}
	instance, e := finishModuleFixture(t, s)
	if e == nil || instance.ObservedState != "unavailable" || instance.LastSuccess != nil {
		t.Fatalf("health probe marked source ready %+v %v", instance, e)
	}
	integration, e := store.Get[model.Integration](context.Background(), s.Store, "integration", instance.IntegrationID)
	if e != nil || integration.Status != "error" {
		t.Fatalf("failed source %+v %v", integration, e)
	}
	if w = apiCall(s, admin, "GET", "/api/v1/integrations", nil, nil); w.Code != 200 || !strings.Contains(w.Body.String(), instance.IntegrationID) {
		t.Fatalf("integration absent %d %s", w.Code, w.Body.String())
	}
	if w = apiCall(s, admin, "GET", "/api/v1/resources", nil, nil); w.Code != 200 || !strings.Contains(w.Body.String(), instance.ResourceID) {
		t.Fatalf("resource absent %d %s", w.Code, w.Body.String())
	}
	failPoll = false
	w = apiCall(s, admin, "POST", "/api/v1/integrations/"+instance.IntegrationID+"/refresh", nil, nil)
	if w.Code != 202 {
		t.Fatalf("owned refresh %d %s", w.Code, w.Body.String())
	}
	var refresh model.Job
	json.Unmarshal(w.Body.Bytes(), &refresh)
	if refresh.Kind != "module" {
		t.Fatalf("second poll owner %+v", refresh)
	}
	instance, e = finishModuleFixture(t, s)
	if e != nil || instance.ObservedState != "running" || instance.LastSuccess == nil || polls != 2 {
		t.Fatalf("source flow %+v polls=%d %v", instance, polls, e)
	}
	candidates, e := store.List[model.Candidate](context.Background(), s.Store, "candidate")
	if e != nil || len(candidates) != 1 || candidates[0].IntegrationID != instance.IntegrationID {
		t.Fatalf("discovery absent %+v %v", candidates, e)
	}
	integration, e = store.Get[model.Integration](context.Background(), s.Store, "integration", instance.IntegrationID)
	if e != nil || integration.Status != "connected" || integration.LastSuccess == nil {
		t.Fatalf("integration %+v %v", integration, e)
	}
	resource, e := store.Get[model.Resource](context.Background(), s.Store, "resource", instance.ResourceID)
	if e != nil {
		t.Fatal(e)
	}
	for _, call := range []struct {
		method, path string
		body         any
		headers      map[string]string
	}{
		{"POST", "/api/v1/integrations", model.Integration{ManagedModuleID: instance.ID}, nil},
		{"PUT", "/api/v1/integrations/" + integration.ID, integration, nil},
		{"DELETE", "/api/v1/integrations/" + integration.ID, nil, map[string]string{"If-Match": strconv.FormatInt(integration.Revision, 10)}},
		{"POST", "/api/v1/resources", model.Resource{ManagedModuleID: instance.ID}, nil},
		{"PUT", "/api/v1/resources/" + resource.ID, resource, nil},
		{"DELETE", "/api/v1/resources/" + resource.ID, nil, map[string]string{"If-Match": strconv.FormatInt(resource.Revision, 10)}},
	} {
		if w = apiCall(s, admin, call.method, call.path, call.body, call.headers); w.Code != 409 {
			t.Fatalf("ownership %s %s: %d %s", call.method, call.path, w.Code, w.Body.String())
		}
	}
	// Omitting the managed field must not bypass ownership checks.
	integration.ManagedModuleID = ""
	if w = apiCall(s, admin, "PUT", "/api/v1/integrations/"+integration.ID, integration, nil); w.Code != 409 {
		t.Fatalf("owner omission %d %s", w.Code, w.Body.String())
	}
	body["idempotency_key"] = "create:duplicate-source"
	w = apiCall(s, admin, "POST", "/api/v1/modules", body, nil)
	if w.Code != 409 || !strings.Contains(w.Body.String(), `"existing_instance_id":"`+instance.ID+`"`) {
		t.Fatalf("duplicate guard %d %s", w.Code, w.Body.String())
	}
	action := map[string]string{"action": "remove", "idempotency_key": "remove:source-flow"}
	if w = apiCall(s, admin, "POST", "/api/v1/modules/"+instance.ID+"/actions", action, nil); w.Code != 400 {
		t.Fatalf("remove confirmation %d %s", w.Code, w.Body.String())
	}
	action["confirm_name"] = instance.Name
	if w = apiCall(s, admin, "POST", "/api/v1/modules/"+instance.ID+"/actions", action, nil); w.Code != 202 {
		t.Fatalf("remove %d %s", w.Code, w.Body.String())
	}
	removed, e := finishModuleFixture(t, s)
	if e != nil || removed.ObservedState != "absent" || polls != 2 {
		t.Fatalf("external removal performed source work %+v %v polls=%d", removed, e, polls)
	}
	for kind, id := range map[string]string{"module_instance": instance.ID, "integration": integration.ID, "resource": resource.ID} {
		if _, e = s.Store.Get(context.Background(), kind, id); !errors.Is(e, store.ErrNotFound) {
			t.Fatalf("removed %s %v", kind, e)
		}
	}
	if w = apiCall(s, admin, "POST", "/api/v1/modules/"+instance.ID+"/actions", action, nil); w.Code != 202 {
		t.Fatalf("remove retry %d %s", w.Code, w.Body.String())
	}
}

func TestLocalModuleRemovalRequiresAbsentConfirmation(t *testing.T) {
	s, admin := localUsersFixture(t)
	absent := false
	removes := 0
	s.Modules = modules.New(s.Store, moduleControllerFunc(func(_ context.Context, op modules.Operation) (modules.Observation, error) {
		if op.Action == "remove" {
			removes++
			if absent {
				return modules.Observation{State: "absent"}, nil
			}
			return modules.Observation{State: "running"}, nil
		}
		return modules.Observation{State: "running", Endpoint: "http://127.0.0.1:32770", Version: "3.15.0"}, nil
	}))
	s.Modules.Poll = func(context.Context, model.Integration) (model.Snapshot, error) { return model.Snapshot{}, nil }
	w := apiCall(s, admin, "POST", "/api/v1/modules", map[string]string{"module_id": "prometheus", "name": "Local metrics", "mode": "local", "idempotency_key": "create:local-remove"}, nil)
	if w.Code != 202 {
		t.Fatalf("create %d %s", w.Code, w.Body.String())
	}
	instance, e := finishModuleFixture(t, s)
	if e != nil {
		t.Fatal(e)
	}
	action := map[string]string{"action": "remove", "idempotency_key": "remove:local-first", "confirm_name": instance.Name}
	if w = apiCall(s, admin, "POST", "/api/v1/modules/"+instance.ID+"/actions", action, nil); w.Code != 202 {
		t.Fatalf("remove %d", w.Code)
	}
	failed, e := finishModuleFixture(t, s)
	if e == nil || failed.DesiredState != "removed" || failed.ObservedState != "unavailable" {
		t.Fatalf("false absent %+v %v", failed, e)
	}
	if _, e = s.Store.Get(context.Background(), "integration", instance.IntegrationID); e != nil {
		t.Fatalf("partial removal lost records %v", e)
	}
	absent = true
	action["idempotency_key"] = "remove:local-second"
	if w = apiCall(s, admin, "POST", "/api/v1/modules/"+instance.ID+"/actions", action, nil); w.Code != 202 {
		t.Fatalf("retry %d", w.Code)
	}
	removed, e := finishModuleFixture(t, s)
	if e != nil || removed.ObservedState != "absent" || removes != 2 {
		t.Fatalf("remove retry %+v %v", removed, e)
	}
}

func TestModuleCatalogExportRoundtripAndRemovalReferences(t *testing.T) {
	s, admin := localUsersFixture(t)
	s.Modules = modules.New(s.Store, nil)
	s.Modules.Probe = moduleProbeFunc(func(context.Context, string) (modules.Observation, error) {
		return modules.Observation{State: "running", Version: "3.15.0"}, nil
	})
	s.Modules.Poll = func(context.Context, model.Integration) (model.Snapshot, error) { return model.Snapshot{}, nil }
	w := apiCall(s, admin, "POST", "/api/v1/modules", map[string]string{"module_id": "prometheus", "name": "Metrics", "mode": "external", "endpoint": "http://192.168.1.10:9090", "idempotency_key": "create:export-roundtrip"}, nil)
	if w.Code != 202 {
		t.Fatalf("create %d %s", w.Code, w.Body.String())
	}
	instance, e := finishModuleFixture(t, s)
	if e != nil {
		t.Fatal(e)
	}
	ordinary := apiResource(t, s, admin, "Ordinary")
	ordinary.Relations = []model.Relation{{ResourceID: instance.ResourceID, Label: "uses metrics"}}
	ordinary = apiDecode[model.Resource](t, apiCall(s, admin, "PUT", "/api/v1/resources/"+ordinary.ID, ordinary, nil), 200)
	collection := apiDecode[model.Collection](t, apiCall(s, admin, "POST", "/api/v1/collections", model.Collection{Name: "Services", Mode: "manual", ResourceIDs: []string{instance.ResourceID, ordinary.ID}}, nil), 201)
	exported := apiDecode[exportDocument](t, apiCall(s, admin, "GET", "/api/v1/export", nil, nil), 200)
	if len(exported.Resources) != 1 || exported.Resources[0].ID != ordinary.ID || len(exported.Resources[0].Relations) != 0 || len(exported.Collections) != 1 || len(exported.Collections[0].ResourceIDs) != 1 || exported.Collections[0].ResourceIDs[0] != ordinary.ID {
		t.Fatalf("nonportable export %+v", exported)
	}
	preview := apiDecode[apiPreview](t, apiCall(s, admin, "POST", "/api/v1/import/preview", exported, nil), 200)
	if preview.Token == "" || len(preview.Conflicts) != 0 {
		t.Fatalf("own export rejected %+v", preview)
	}
	apiDecode[map[string]bool](t, apiCall(s, admin, "POST", "/api/v1/import/apply", map[string]string{"token": preview.Token}, nil), 200)
	// Recreate mixed references after the roundtrip, then delete only the module.
	ordinary = apiDecode[model.Resource](t, apiCall(s, admin, "GET", "/api/v1/resources/"+ordinary.ID, nil, nil), 200)
	ordinary.Relations = []model.Relation{{ResourceID: instance.ResourceID, Label: "uses metrics"}}
	apiDecode[model.Resource](t, apiCall(s, admin, "PUT", "/api/v1/resources/"+ordinary.ID, ordinary, nil), 200)
	collections := apiDecode[[]model.Collection](t, apiCall(s, admin, "GET", "/api/v1/collections", nil, nil), 200)
	collection = collections[0]
	collection.ResourceIDs = []string{instance.ResourceID, ordinary.ID}
	collection = apiDecode[model.Collection](t, apiCall(s, admin, "PUT", "/api/v1/collections/"+collection.ID, collection, nil), 200)
	if _, e = s.Store.Save(context.Background(), "preferences", "local-admin", 0, model.Preferences{Favorites: []string{instance.ResourceID, ordinary.ID}}, "local-admin"); e != nil {
		t.Fatal(e)
	}
	settings, e := store.Get[model.Settings](context.Background(), s.Store, "settings", "global")
	if e != nil {
		t.Fatal(e)
	}
	settings.BoardResourceIDs = []string{instance.ResourceID, ordinary.ID}
	if _, e = s.Store.Save(context.Background(), "settings", "global", settings.Revision, settings, "local-admin"); e != nil {
		t.Fatal(e)
	}
	w = apiCall(s, admin, "POST", "/api/v1/modules/"+instance.ID+"/actions", map[string]string{"action": "remove", "idempotency_key": "remove:export-roundtrip", "confirm_name": instance.Name}, nil)
	if w.Code != 202 {
		t.Fatalf("remove %d %s", w.Code, w.Body.String())
	}
	if _, e = finishModuleFixture(t, s); e != nil {
		t.Fatal(e)
	}
	collections = apiDecode[[]model.Collection](t, apiCall(s, admin, "GET", "/api/v1/collections", nil, nil), 200)
	collection = collections[0]
	if len(collection.ResourceIDs) != 1 || collection.ResourceIDs[0] != ordinary.ID {
		t.Fatalf("collection ghost %+v", collection)
	}
	collection.Name = "Renamed after removal"
	apiDecode[model.Collection](t, apiCall(s, admin, "PUT", "/api/v1/collections/"+collection.ID, collection, nil), 200)
	after := apiDecode[model.Resource](t, apiCall(s, admin, "GET", "/api/v1/resources/"+ordinary.ID, nil, nil), 200)
	if after.Name != ordinary.Name || after.URL != ordinary.URL || len(after.Relations) != 0 {
		t.Fatalf("ordinary changed beyond invalid relation %+v", after)
	}
	prefs, e := store.Get[model.Preferences](context.Background(), s.Store, "preferences", "local-admin")
	if e != nil || len(prefs.Favorites) != 1 || prefs.Favorites[0] != ordinary.ID {
		t.Fatalf("favorite ghost %+v %v", prefs, e)
	}
	settings, e = store.Get[model.Settings](context.Background(), s.Store, "settings", "global")
	if e != nil || len(settings.BoardResourceIDs) != 1 || settings.BoardResourceIDs[0] != ordinary.ID {
		t.Fatalf("board ghost %+v %v", settings, e)
	}
}

func TestLocalModuleRemovalRechecksAdminRole(t *testing.T) {
	s, admin := localUsersFixture(t)
	u := createFixtureLocalUser(t, s, admin, "remove.admin", true)
	actor := localUserIdentity(t, s, u.Username, localUserFixturePassword)
	removes := 0
	s.Modules = modules.New(s.Store, moduleControllerFunc(func(_ context.Context, op modules.Operation) (modules.Observation, error) {
		if op.Action == "remove" {
			removes++
			return modules.Observation{State: "absent"}, nil
		}
		return modules.Observation{State: "running", Version: "3.15.0", Endpoint: "http://127.0.0.1:32770"}, nil
	}))
	s.Modules.Poll = func(context.Context, model.Integration) (model.Snapshot, error) { return model.Snapshot{}, nil }
	w := apiCall(s, actor, "POST", "/api/v1/modules", map[string]string{"module_id": "prometheus", "name": "Role check", "mode": "local", "idempotency_key": "create:remove-role"}, nil)
	if w.Code != 202 {
		t.Fatalf("queue %d %s", w.Code, w.Body.String())
	}
	instance, e := finishModuleFixture(t, s)
	if e != nil {
		t.Fatal(e)
	}
	action := map[string]string{"action": "remove", "idempotency_key": "remove:role-check", "confirm_name": instance.Name}
	viewer := apiUser(t, s, "remove.viewer", false)
	if w = apiCall(s, viewer, "POST", "/api/v1/modules/"+instance.ID+"/actions", action, nil); w.Code != 403 {
		t.Fatalf("viewer remove %d", w.Code)
	}
	if w = apiCall(s, actor, "POST", "/api/v1/modules/"+instance.ID+"/actions", action, map[string]string{"X-CSRF-Token": "forged"}); w.Code != 403 {
		t.Fatalf("csrf remove %d", w.Code)
	}
	if w = apiCall(s, actor, "POST", "/api/v1/modules/"+instance.ID+"/actions", action, nil); w.Code != 202 {
		t.Fatalf("remove %d %s", w.Code, w.Body.String())
	}
	u.Admin = false
	updateFixtureLocalUser(t, s, admin, u)
	denied, e := finishModuleFixture(t, s)
	if e == nil || removes != 0 || denied.DesiredState != "removed" || denied.ObservedState != "unavailable" {
		t.Fatalf("demoted physical remove %+v %v removes=%d", denied, e, removes)
	}
	if _, e = s.Store.Get(context.Background(), "resource", instance.ResourceID); e != nil {
		t.Fatalf("denied removal dropped catalog %v", e)
	}
}

package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"pl/portal/internal/model"
	"pl/portal/internal/store"
)

func settingsWorkspaceCall(s *Server, who apiIdentity, method, path string, payload any, headers map[string]string) *httptest.ResponseRecorder {
	var body bytes.Buffer
	if payload != nil {
		_ = json.NewEncoder(&body).Encode(payload)
	}
	r := httptest.NewRequest(method, s.Config.PublicURL+path, &body)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", s.Config.PublicURL)
	if who.cookie != nil {
		r.AddCookie(who.cookie)
	}
	if who.csrf != "" {
		r.Header.Set("X-CSRF-Token", who.csrf)
	}
	for key, value := range headers {
		r.Header.Set(key, value)
	}
	m := http.NewServeMux()
	s.RegisterSettingsWorkspace(m)
	m.Handle("/", s.Handler())
	w := httptest.NewRecorder()
	m.ServeHTTP(w, r)
	return w
}

func TestSettingsWorkspaceAdminAndCSRFBoundary(t *testing.T) {
	s := apiFixture(t)
	admin := apiUser(t, s, "admin", true)
	viewer := apiUser(t, s, "viewer", false)
	routes := []struct{ method, path string }{
		{"GET", "/api/v1/settings-workspace/history?kind=settings&id=global"},
		{"PUT", "/api/v1/settings-workspace/general"},
		{"PUT", "/api/v1/settings-workspace/publication"},
		{"PUT", "/api/v1/settings-workspace/dictionaries"},
		{"POST", "/api/v1/settings-workspace/integrations"},
		{"PUT", "/api/v1/settings-workspace/integrations/source"},
		{"DELETE", "/api/v1/settings-workspace/integrations/source"},
	}
	for _, route := range routes {
		for _, who := range []struct {
			identity apiIdentity
			status   int
		}{{viewer, 403}, {apiIdentity{}, 401}} {
			w := settingsWorkspaceCall(s, who.identity, route.method, route.path, map[string]any{}, nil)
			if w.Code != who.status {
				t.Fatalf("%s %s: got %d, want %d", route.method, route.path, w.Code, who.status)
			}
		}
		if route.method == "GET" {
			continue
		}
		for _, headers := range []map[string]string{{"X-CSRF-Token": ""}, {"X-CSRF-Token": "wrong"}, {"Origin": "https://attacker.test"}, {"Sec-Fetch-Site": "cross-site"}} {
			if w := settingsWorkspaceCall(s, admin, route.method, route.path, map[string]any{}, headers); w.Code != 403 {
				t.Fatalf("%s CSRF boundary bypass: %d", route.path, w.Code)
			}
		}
	}
	var changes int
	if err := s.Store.Pool.QueryRow(context.Background(), "SELECT count(*) FROM audit_events WHERE body->'details'->>'settings_history_version'='1'").Scan(&changes); err != nil || changes != 0 {
		t.Fatalf("denied request wrote history: %d %v", changes, err)
	}
}

func TestSettingsWorkspaceGroupsPreserveOthersAndConflict(t *testing.T) {
	s := apiFixture(t)
	admin := apiUser(t, s, "admin", true)
	initial := apiDecode[model.Settings](t, apiCall(s, admin, "GET", "/api/v1/settings", nil, nil), 200)
	general := map[string]any{"revision": initial.Revision, "timezone": "UTC", "stale_after_seconds": 300}
	changed := apiDecode[model.Settings](t, settingsWorkspaceCall(s, admin, "PUT", "/api/v1/settings-workspace/general", general, nil), 200)
	if changed.Timezone != "UTC" || changed.StaleAfterSeconds != 300 || changed.BoardTitle != initial.BoardTitle || changed.BoardEnabled != initial.BoardEnabled || changed.BoardAnonymous != initial.BoardAnonymous {
		t.Fatalf("general save changed publication: %#v", changed)
	}
	publication := map[string]any{"revision": initial.Revision, "board_enabled": true, "board_anonymous": false, "board_title": "Новый Board", "board_resource_ids": []string{}}
	if w := settingsWorkspaceCall(s, admin, "PUT", "/api/v1/settings-workspace/publication", publication, nil); w.Code != 409 {
		t.Fatalf("stale cross-group revision accepted: %d %s", w.Code, w.Body.String())
	}
	publication["revision"] = changed.Revision
	published := apiDecode[model.Settings](t, settingsWorkspaceCall(s, admin, "PUT", "/api/v1/settings-workspace/publication", publication, nil), 200)
	if !published.BoardEnabled || published.BoardTitle != "Новый Board" || published.Timezone != "UTC" || published.StaleAfterSeconds != 300 {
		t.Fatalf("publication save replaced general settings: %#v", published)
	}
	general["revision"], general["timezone"], general["stale_after_seconds"] = published.Revision, "Unknown/Invalid", 1
	w := settingsWorkspaceCall(s, admin, "PUT", "/api/v1/settings-workspace/general", general, nil)
	invalid := apiDecode[struct {
		FieldErrors map[string]string `json:"field_errors"`
	}](t, w, 400)
	if invalid.FieldErrors["timezone"] == "" || invalid.FieldErrors["stale_after_seconds"] == "" {
		t.Fatalf("field errors missing: %s", w.Body.String())
	}
	general["timezone"], general["stale_after_seconds"], general["board_enabled"] = "UTC", 300, false
	if w = settingsWorkspaceCall(s, admin, "PUT", "/api/v1/settings-workspace/general", general, nil); w.Code != 400 {
		t.Fatal("general route accepted publication field")
	}
	generalHistory := apiDecode[store.SettingsHistoryPage](t, settingsWorkspaceCall(s, admin, "GET", "/api/v1/settings-workspace/history?kind=settings&group=general", nil, nil), 200)
	publicationHistory := apiDecode[store.SettingsHistoryPage](t, settingsWorkspaceCall(s, admin, "GET", "/api/v1/settings-workspace/history?kind=settings&group=publication", nil, nil), 200)
	if len(generalHistory.Items) != 1 || len(generalHistory.Items[0].Changes) != 2 || len(publicationHistory.Items) != 1 || len(publicationHistory.Items[0].Changes) != 2 {
		t.Fatalf("failed write or wrong group included in history: %#v %#v", generalHistory, publicationHistory)
	}
	for _, path := range []string{"?kind=resource&id=one", "?kind=settings&id=global&group=unknown", "?kind=settings&id=global&cursor=invalid", "?kind=settings&id=global&limit=1000"} {
		if w := settingsWorkspaceCall(s, admin, "GET", "/api/v1/settings-workspace/history"+path, nil, nil); w.Code != 400 {
			t.Fatalf("invalid history query accepted %s: %d", path, w.Code)
		}
	}
}

func TestSettingsWorkspaceCRUDAndDictionaries(t *testing.T) {
	s := apiFixture(t)
	admin := apiUser(t, s, "admin", true)
	draft := model.Integration{Name: "Prepared unavailable source", Kind: "prometheus", URL: "https://not-connected.example.test", Enabled: true, PollSeconds: 60, TimeoutSeconds: 10, Concurrency: 2, Status: "connected", Config: map[string]string{}}
	created := apiDecode[model.Integration](t, settingsWorkspaceCall(s, admin, "POST", "/api/v1/settings-workspace/integrations", draft, nil), 201)
	if created.ID == "" || created.Status != "unconfigured" || len(created.Capabilities) == 0 {
		t.Fatalf("incorrect saved source: %#v", created)
	}
	created.Name = "Revised source"
	updated := apiDecode[model.Integration](t, settingsWorkspaceCall(s, admin, "PUT", "/api/v1/settings-workspace/integrations/"+created.ID, created, nil), 200)
	if w := settingsWorkspaceCall(s, admin, "PUT", "/api/v1/settings-workspace/integrations/"+created.ID, created, nil); w.Code != 409 {
		t.Fatalf("stale integration update accepted: %d", w.Code)
	}
	if w := settingsWorkspaceCall(s, admin, "DELETE", "/api/v1/settings-workspace/integrations/"+created.ID, nil, nil); w.Code != 428 {
		t.Fatalf("delete without revision accepted: %d", w.Code)
	}
	encodedRev, _ := json.Marshal(updated.Revision)
	if w := settingsWorkspaceCall(s, admin, "DELETE", "/api/v1/settings-workspace/integrations/"+created.ID, nil, map[string]string{"If-Match": string(encodedRev)}); w.Code != 204 {
		t.Fatalf("delete failed: %d %s", w.Code, w.Body.String())
	}
	history := apiDecode[store.SettingsHistoryPage](t, settingsWorkspaceCall(s, admin, "GET", "/api/v1/settings-workspace/history?kind=integration&id="+created.ID, nil, nil), 200)
	if len(history.Items) != 3 || history.Items[0].Action != "deleted" || history.Items[1].ObjectName != "Revised source" {
		t.Fatalf("integration history incomplete: %#v", history)
	}
	dictionaries := apiDecode[model.Dictionaries](t, apiCall(s, admin, "GET", "/api/v1/dictionaries", nil, nil), 200)
	dictionaries.Sites = []string{"Москва", "Москва"}
	w := settingsWorkspaceCall(s, admin, "PUT", "/api/v1/settings-workspace/dictionaries", dictionaries, nil)
	if w.Code != 400 || !strings.Contains(w.Body.String(), `"sites"`) {
		t.Fatalf("duplicate dictionary entries accepted: %d %s", w.Code, w.Body.String())
	}
	dictionaries.Sites = []string{"Москва", "Санкт-Петербург"}
	saved := apiDecode[model.Dictionaries](t, settingsWorkspaceCall(s, admin, "PUT", "/api/v1/settings-workspace/dictionaries", dictionaries, nil), 200)
	if len(saved.Sites) != 2 {
		t.Fatalf("dictionary save failed: %#v", saved)
	}
	dictionaryHistory := apiDecode[store.SettingsHistoryPage](t, settingsWorkspaceCall(s, admin, "GET", "/api/v1/settings-workspace/history?kind=dictionaries", nil, nil), 200)
	if len(dictionaryHistory.Items) != 1 || len(dictionaryHistory.Items[0].Changes) != 1 || dictionaryHistory.Items[0].Changes[0].Field != "sites" {
		t.Fatalf("dictionary history incorrect: %#v", dictionaryHistory)
	}
	var jobs int
	if err := s.Store.Pool.QueryRow(context.Background(), "SELECT count(*) FROM jobs").Scan(&jobs); err != nil || jobs != 0 {
		t.Fatalf("save queued an operation: %d %v", jobs, err)
	}
}

func TestSettingsWorkspaceCannotDetachDeleteOrProbeManagedIntegration(t *testing.T) {
	s := apiFixture(t)
	admin := apiUser(t, s, "admin", true)
	ctx := context.Background()
	value := model.Integration{ID: "22222222-2222-4222-8222-222222222222", Name: "Owned source", Kind: "prometheus", URL: "http://metrics.example.test", Enabled: true, PollSeconds: 30, TimeoutSeconds: 5, Concurrency: 1, ManagedModuleID: "33333333-3333-4333-8333-333333333333", Config: map[string]string{}}
	raw, err := s.Store.Save(ctx, "integration", value.ID, 0, value, "module-worker")
	if err != nil {
		t.Fatal(err)
	}
	current, err := store.Decode[model.Integration](raw)
	if err != nil {
		t.Fatal(err)
	}
	draft := current
	draft.ManagedModuleID = ""
	draft.Name = "Detached"
	if w := settingsWorkspaceCall(s, admin, "PUT", "/api/v1/settings-workspace/integrations/"+value.ID, draft, nil); w.Code != 409 || !strings.Contains(w.Body.String(), "managed_module") {
		t.Fatal("settings detached owned source", w.Code, w.Body.String())
	}
	if w := settingsWorkspaceCall(s, admin, "DELETE", "/api/v1/settings-workspace/integrations/"+value.ID, nil, map[string]string{"If-Match": "1"}); w.Code != 409 || !strings.Contains(w.Body.String(), "managed_module") {
		t.Fatal("settings deleted owned source", w.Code, w.Body.String())
	}
	body, _ := json.Marshal(draft)
	if w := settingsProbeAPICall(s, admin, string(body), nil); w.Code != 409 || !strings.Contains(w.Body.String(), "managed_module") {
		t.Fatal("generic draft probe bypassed module ownership", w.Code, w.Body.String())
	}
	forged := current
	forged.ID = ""
	if w := settingsWorkspaceCall(s, admin, "POST", "/api/v1/settings-workspace/integrations", forged, nil); w.Code != 409 {
		t.Fatal("forged module owner accepted", w.Code)
	}
	unchanged, err := store.Get[model.Integration](ctx, s.Store, "integration", value.ID)
	if err != nil || unchanged.Name != value.Name || unchanged.ManagedModuleID != value.ManagedModuleID || unchanged.Revision != current.Revision {
		t.Fatal("rejected settings operation changed owned source", err)
	}
}

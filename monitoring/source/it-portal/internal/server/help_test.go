package server

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"pl/portal/internal/model"
)

func TestAPIHelpStatePersonalViewerAndCSRF(t *testing.T) {
	s := apiFixture(t)
	a := apiUser(t, s, "ad:help-a", true)
	b := apiUser(t, s, "ad:help-b", true)
	viewer := apiUser(t, s, "ad:help-viewer", false)
	path := "/api/v1/help-state"
	get := func(who apiIdentity) model.HelpState {
		t.Helper()
		return apiDecode[model.HelpState](t, apiCall(s, who, "GET", path, nil, nil), 200)
	}
	initial := get(a)
	if initial.Disabled || initial.Seen == nil || len(initial.Seen) != 0 {
		t.Fatal(initial)
	}
	for _, method := range []string{"GET", "PATCH"} {
		if w := apiCall(s, apiIdentity{}, method, path, map[string]any{"topic": "home"}, nil); w.Code != 401 {
			t.Fatal("anonymous access", method, w.Code)
		}
	}
	for _, header := range []map[string]string{{"X-CSRF-Token": ""}, {"X-CSRF-Token": "wrong"}, {"Origin": "https://evil.invalid"}} {
		if w := apiCall(s, a, "PATCH", path, map[string]any{"topic": "home"}, header); w.Code != 403 {
			t.Fatal("CSRF bypass", w.Code)
		}
	}
	updated := apiDecode[model.HelpState](t, apiCall(s, a, "PATCH", path, map[string]any{"topic": "home", "disabled": true}, nil), 200)
	if !updated.Disabled || len(updated.Seen) != 1 || updated.Seen[0] != "home" {
		t.Fatal(updated)
	}
	state := get(b)
	if state.Disabled || len(state.Seen) != 0 {
		t.Fatal("different AD user inherited state", state)
	}
	v := apiDecode[model.HelpState](t, apiCall(s, viewer, "PATCH", path, map[string]any{"topic": "viewer-board"}, nil), 200)
	if v.Disabled || len(v.Seen) != 1 || v.Seen[0] != "viewer-board" {
		t.Fatal("viewer unsupported", v)
	}
	apiDecode[model.HelpState](t, apiCall(s, a, "PATCH", path, map[string]any{"topic": "catalog"}, nil), 200)
	state = get(a)
	if !state.Disabled || len(state.Seen) != 2 {
		t.Fatal("seen update reset disabled", state)
	}
	state = apiDecode[model.HelpState](t, apiCall(s, a, "PATCH", path, map[string]any{"disabled": false}, nil), 200)
	if state.Disabled || len(state.Seen) != 2 {
		t.Fatal("explicit false ignored/lost seen", state)
	}
	// Query parameters cannot select another user's state.
	state = apiDecode[model.HelpState](t, apiCall(s, b, "GET", path+"?user_id=ad:help-a", nil, nil), 200)
	if state.Disabled || len(state.Seen) != 0 {
		t.Fatal("query impersonation", state)
	}
}

func TestAPIHelpStateRejectsNullTypeUnknownAndBlank(t *testing.T) {
	s := apiFixture(t)
	user := apiUser(t, s, "ad:help-validation", true)
	for _, body := range []any{json.RawMessage(`null`), map[string]any{}, map[string]any{"topic": nil}, map[string]any{"disabled": nil}, map[string]any{"topic": ""}, map[string]any{"topic": " "}, map[string]any{"topic": "unknown"}, map[string]any{"topic": strings.Repeat("a", 81)}, map[string]any{"topic": 123}, map[string]any{"topic": []string{"home"}}, map[string]any{"disabled": "false"}, map[string]any{"disabled": 0}, map[string]any{"topic": "home", "user_id": "someone-else"}, map[string]any{"seen": []string{"home"}}, map[string]any{"disabled": true, "topic": nil}} {
		if w := apiCall(s, user, "PATCH", "/api/v1/help-state", body, nil); w.Code != 400 {
			t.Fatalf("invalid input accepted: %#v code=%d body=%s", body, w.Code, w.Body.String())
		}
	}
	state := apiDecode[model.HelpState](t, apiCall(s, user, "GET", "/api/v1/help-state", nil, nil), 200)
	if state.Disabled || len(state.Seen) != 0 {
		t.Fatal("invalid input mutated state", state)
	}
}

func TestAPIModulesHelpDismissalPersists(t *testing.T) {
	s := apiFixture(t)
	user := apiUser(t, s, "ad:help-modules", true)
	path := "/api/v1/help-state"
	for range 2 {
		state := apiDecode[model.HelpState](t, apiCall(s, user, "PATCH", path, map[string]any{"topic": "modules"}, nil), 200)
		if state.Disabled || len(state.Seen) != 1 || state.Seen[0] != "modules" {
			t.Fatalf("module dismissal changed unrelated help settings or duplicated topic: %+v", state)
		}
	}
	state := apiDecode[model.HelpState](t, apiCall(s, user, "GET", path, nil, nil), 200)
	if state.Disabled || len(state.Seen) != 1 || state.Seen[0] != "modules" {
		t.Fatalf("module dismissal was not persisted: %+v", state)
	}
}

func TestAPIWorkspaceHelpTopicsPersist(t *testing.T) {
	s := apiFixture(t)
	user := apiUser(t, s, "help-workspace", true)
	path := "/api/v1/help-state"
	topics := []string{"systems", "system-editor", "system-details", "favorite-group-editor", "operations", "module-catalog"}
	for _, topic := range topics {
		for range 2 {
			apiDecode[model.HelpState](t, apiCall(s, user, "PATCH", path, map[string]any{"topic": topic}, nil), 200)
		}
	}
	state := apiDecode[model.HelpState](t, apiCall(s, user, "GET", path, nil, nil), 200)
	if state.Disabled || len(state.Seen) != len(topics) {
		t.Fatalf("workspace help preferences lost or duplicated: %+v", state)
	}
	for _, topic := range topics {
		if !slices.Contains(state.Seen, topic) {
			t.Fatalf("workspace help topic was not persisted: %s", topic)
		}
	}
}

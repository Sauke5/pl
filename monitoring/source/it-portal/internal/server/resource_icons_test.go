package server

import (
	"encoding/json"
	"pl/portal/internal/model"
	"testing"
)

func TestResourceIconInput(t *testing.T) {
	for _, key := range append([]string{"auto"}, model.ResourceIconKeys()...) {
		raw, _ := json.Marshal(key)
		got, err := parseResourceIcon(raw)
		if err != nil || (key != "auto" && got != key) {
			t.Fatalf("key %q rejected: %v", key, err)
		}
	}
	for _, raw := range []string{`null`, `""`, `"unknown"`, `"<svg/>"`, `"https://example.test/a.svg"`, `1`, `{}`, `[]`, `true`} {
		if _, err := parseResourceIcon(json.RawMessage(raw)); err == nil {
			t.Fatalf("invalid icon accepted: %s", raw)
		}
	}
}

func TestResourceIconPersistenceAndLegacyClients(t *testing.T) {
	s := apiFixture(t)
	admin := apiUser(t, s, "icons-admin", true)
	viewer := apiUser(t, s, "icons-viewer", false)
	payload := map[string]any{"name": "Icons", "url": "https://icons.example.test/", "type": "Web-сервис", "icon": "forms"}
	created := apiDecode[model.Resource](t, apiCall(s, admin, "POST", "/api/v1/resources", payload, nil), 201)
	path := "/api/v1/resources/" + created.ID
	read := func() model.Resource {
		return apiDecode[model.Resource](t, apiCall(s, admin, "GET", path, nil, nil), 200)
	}
	if got := read(); got.Icon != "forms" || got.Revision != 1 {
		t.Fatalf("icon not persisted: %+v", got)
	}
	// Old clients send the existing full resource shape without the new field.
	raw, _ := json.Marshal(created)
	var oldClient map[string]any
	_ = json.Unmarshal(raw, &oldClient)
	delete(oldClient, "icon")
	oldClient["name"] = "Renamed icons"
	changed := apiDecode[model.Resource](t, apiCall(s, admin, "PUT", path, oldClient, nil), 200)
	if changed.Icon != "forms" || read().Icon != "forms" {
		t.Fatal("legacy update erased manual icon")
	}
	oldClient["revision"] = changed.Revision
	oldClient["icon"] = "auto"
	reset := apiDecode[model.Resource](t, apiCall(s, admin, "PUT", path, oldClient, nil), 200)
	if reset.Icon != "" || read().Icon != "" {
		t.Fatal("auto did not reset manual selection")
	}
	if w := apiCall(s, admin, "PUT", path, oldClient, nil); w.Code != 409 {
		t.Fatalf("stale icon edit accepted: %d", w.Code)
	}
	oldClient["revision"] = reset.Revision
	for _, invalid := range []any{nil, "", "missing", "<svg/>", "https://example.test/icon.svg", 7} {
		oldClient["icon"] = invalid
		if w := apiCall(s, admin, "PUT", path, oldClient, nil); w.Code != 400 {
			t.Fatalf("invalid icon %#v accepted: %d %s", invalid, w.Code, w.Body.String())
		}
		if read().Revision != reset.Revision {
			t.Fatal("rejected edit changed stored resource")
		}
	}
	if w := apiCall(s, viewer, "PUT", path, oldClient, nil); w.Code != 403 {
		t.Fatalf("viewer wrote icon: %d", w.Code)
	}
	delete(payload, "icon")
	legacy := apiDecode[model.Resource](t, apiCall(s, admin, "POST", "/api/v1/resources", payload, nil), 201)
	if legacy.Icon != "" {
		t.Fatal("old create did not retain auto default")
	}
	payload["icon"] = nil
	if w := apiCall(s, admin, "POST", "/api/v1/resources", payload, nil); w.Code != 400 {
		t.Fatalf("null accepted on create: %d", w.Code)
	}
}

func TestResourceIconEmployeeProjection(t *testing.T) {
	for _, override := range []string{"", "app", "book", "folder", "support"} {
		r := model.Resource{Icon: "forms", Name: "Доска", URL: "https://icons.example.test/", Employee: &model.EmployeeMetadata{Icon: override}}
		employee := projectBoardResource(r, "unknown", true, "https://portal.example.test")
		if employee["resource_icon"] != "forms" {
			t.Fatal("manual icon missing from employee projection")
		}
		expected := override
		if expected == "" {
			expected = "app"
		}
		if employee["icon"] != expected {
			t.Fatal("legacy employee override changed")
		}
		if _, exists := projectBoardResource(r, "unknown", false, "https://portal.example.test")["resource_icon"]; exists {
			t.Fatal("anonymous projection expanded")
		}
	}
}

func TestResourceIconSurvivesLegacyImport(t *testing.T) {
	s := apiFixture(t)
	admin := apiUser(t, s, "icons-import-admin", true)
	original := apiDecode[model.Resource](t, apiCall(s, admin, "POST", "/api/v1/resources", model.Resource{Name: "Existing", URL: "https://existing.example.test/", Icon: "forms"}, nil), 201)
	doc := exportDocument{SchemaVersion: 1, Resources: []model.Resource{{ID: original.ID, Name: "Imported rename", URL: original.URL}}}
	preview := apiDecode[apiPreview](t, apiCall(s, admin, "POST", "/api/v1/import/preview", doc, nil), 200)
	apiDecode[map[string]bool](t, apiCall(s, admin, "POST", "/api/v1/import/apply", map[string]string{"token": preview.Token}, nil), 200)
	got := apiDecode[model.Resource](t, apiCall(s, admin, "GET", "/api/v1/resources/"+original.ID, nil, nil), 200)
	if got.Name != "Imported rename" || got.Icon != "forms" {
		t.Fatalf("legacy import erased icon: %+v", got)
	}
}

func TestResourceIconPublishedBoardPersistence(t *testing.T) {
	s := apiFixture(t)
	admin := apiUser(t, s, "icon-board-admin", true)
	employee := apiUser(t, s, "icon-board-employee", false)
	resource := apiDecode[model.Resource](t, apiCall(s, admin, "POST", "/api/v1/resources", model.Resource{Name: "Published", URL: "https://board.example.test/", Icon: "forms", Employee: &model.EmployeeMetadata{Icon: "book"}}, nil), 201)
	settings := apiDecode[model.Settings](t, apiCall(s, admin, "GET", "/api/v1/settings", nil, nil), 200)
	settings.BoardEnabled = true
	settings.BoardResourceIDs = []string{resource.ID}
	apiDecode[model.Settings](t, apiCall(s, admin, "PUT", "/api/v1/settings", settings, nil), 200)
	board := apiDecode[struct {
		Items []map[string]any `json:"items"`
	}](t, apiCall(s, employee, "GET", "/api/v1/board", nil, nil), 200)
	if len(board.Items) != 1 || board.Items[0]["resource_icon"] != "forms" || board.Items[0]["icon"] != "book" {
		t.Fatalf("published icon not persisted: %+v", board)
	}
}

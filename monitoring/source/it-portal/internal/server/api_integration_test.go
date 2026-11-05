package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/providers"
	"pl/portal/internal/store/sqlgen"
)

type apiIdentity struct {
	cookie *http.Cookie
	csrf   string
}

func apiFixture(t *testing.T) *Server {
	t.Helper()
	db := localAuthTestStore(t)
	db.Q = sqlgen.New(db.Pool)
	if err := db.Defaults(context.Background()); err != nil {
		t.Fatal(err)
	}
	return New(db, Config{PublicURL: "https://portal.example.test", SessionLifetime: time.Hour}, providers.New(nil, ""), http.DefaultClient)
}
func apiUser(t *testing.T, s *Server, id string, admin bool) apiIdentity {
	t.Helper()
	r := httptest.NewRequest("POST", s.Config.PublicURL+"/test-session", nil)
	w := httptest.NewRecorder()
	if err := s.newSession(w, r, model.User{ID: id, Name: id, Admin: admin}, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatal("missing session cookie")
	}
	r.AddCookie(cookies[0])
	sess, err := s.readSession(r)
	if err != nil {
		t.Fatal(err)
	}
	return apiIdentity{cookies[0], sess.CSRF}
}
func apiCall(s *Server, who apiIdentity, method, path string, payload any, headers map[string]string) *httptest.ResponseRecorder {
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
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	return w
}
func apiDecode[T any](t *testing.T, w *httptest.ResponseRecorder, status int) T {
	t.Helper()
	var out T
	if w.Code != status {
		t.Fatalf("expected %d, got %d: %s", status, w.Code, w.Body.String())
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}
func apiResource(t *testing.T, s *Server, who apiIdentity, name string) model.Resource {
	t.Helper()
	return apiDecode[model.Resource](t, apiCall(s, who, "POST", "/api/v1/resources", model.Resource{Name: name, URL: "https://" + strings.ToLower(name) + ".example.test", Aliases: []string{"alias-" + name}, Hostname: "host-" + strings.ToLower(name), IP: "192.0.2.51", Directions: []string{"Мониторинг"}}, nil), 201)
}

func TestAPIAdministrativeBoundaryAndCSRF(t *testing.T) {
	s := apiFixture(t)
	admin := apiUser(t, s, "fixture-admin", true)
	viewer := apiUser(t, s, "fixture-viewer", false)
	endpoints := []struct{ method, path string }{
		{"GET", "/api/v1/wayline"},
		{"GET", "/api/v1/resources"}, {"GET", "/api/v1/search?q=x"}, {"POST", "/api/v1/resources"}, {"GET", "/api/v1/resources/id"}, {"PUT", "/api/v1/resources/id"}, {"DELETE", "/api/v1/resources/id"},
		{"GET", "/api/v1/collections"}, {"POST", "/api/v1/collections"}, {"PUT", "/api/v1/collections/id"}, {"DELETE", "/api/v1/collections/id"},
		{"GET", "/api/v1/integrations"}, {"POST", "/api/v1/integrations"}, {"PUT", "/api/v1/integrations/id"}, {"DELETE", "/api/v1/integrations/id"},
		{"GET", "/api/v1/preferences"}, {"PUT", "/api/v1/preferences"}, {"GET", "/api/v1/settings"}, {"PUT", "/api/v1/settings"}, {"GET", "/api/v1/dictionaries"}, {"PUT", "/api/v1/dictionaries"},
		{"GET", "/api/v1/candidates"}, {"POST", "/api/v1/candidates/resolve"}, {"GET", "/api/v1/problems"}, {"GET", "/api/v1/reports"}, {"GET", "/api/v1/events"}, {"GET", "/api/v1/audit"},
		{"GET", "/api/v1/export"}, {"POST", "/api/v1/import/preview"}, {"POST", "/api/v1/import/apply"}, {"GET", "/api/v1/jobs"}, {"GET", "/api/v1/jobs/id"}, {"POST", "/api/v1/jobs"},
		{"POST", "/api/v1/integrations/id/refresh"}, {"GET", "/api/v1/stream"}, {"GET", "/api/v1/runtime"},
	}
	for _, ep := range endpoints {
		for _, tc := range []struct {
			who  apiIdentity
			code int
		}{{viewer, 403}, {apiIdentity{}, 401}} {
			w := apiCall(s, tc.who, ep.method, ep.path, map[string]any{}, nil)
			if w.Code != tc.code {
				t.Errorf("%s %s got%d want%d", ep.method, ep.path, w.Code, tc.code)
			}
		}
	}
	for _, headers := range []map[string]string{{"X-CSRF-Token": ""}, {"X-CSRF-Token": "wrong"}, {"Origin": "https://attacker.invalid"}, {"Sec-Fetch-Site": "cross-site"}} {
		w := apiCall(s, admin, "POST", "/api/v1/resources", model.Resource{Name: "Blocked", URL: "https://blocked.example.test"}, headers)
		if w.Code != 403 {
			t.Fatalf("CSRF bypass: %d", w.Code)
		}
	}
	apiResource(t, s, admin, "Accepted")
	items := apiDecode[[]model.Resource](t, apiCall(s, admin, "GET", "/api/v1/resources", nil, nil), 200)
	if len(items) != 1 {
		t.Fatalf("denied calls mutated catalogue: %d", len(items))
	}
}

func TestAPIBoardProjectionAndSessionReload(t *testing.T) {
	s := apiFixture(t)
	admin := apiUser(t, s, "admin", true)
	viewer := apiUser(t, s, "viewer", false)
	resource := apiResource(t, s, admin, "Management")
	resource.Description = "PRIVATE-INTERNAL-DESCRIPTION"
	resource.Employee = &model.EmployeeMetadata{Description: "Public description", Category: "Published category", Icon: "book"}
	resource.Endpoints = []model.Endpoint{{Name: "PRIVATE-ENDPOINT", URL: "https://secret-mgmt.example.test"}}
	resource.Tags = []string{"PRIVATE-LABEL"}
	resource = apiDecode[model.Resource](t, apiCall(s, admin, "PUT", "/api/v1/resources/"+resource.ID, resource, nil), 200)
	if w := apiCall(s, viewer, "GET", "/api/v1/board", nil, nil); w.Code != 403 {
		t.Fatalf("default board enabled: %d", w.Code)
	}
	settings := apiDecode[model.Settings](t, apiCall(s, admin, "GET", "/api/v1/settings", nil, nil), 200)
	settings.BoardEnabled = true
	settings.BoardResourceIDs = []string{resource.ID}
	settings = apiDecode[model.Settings](t, apiCall(s, admin, "PUT", "/api/v1/settings", settings, nil), 200)
	if w := apiCall(s, apiIdentity{}, "GET", "/api/v1/board", nil, nil); w.Code != 401 {
		t.Fatalf("anonymous board leaked: %d", w.Code)
	}
	w := apiCall(s, viewer, "GET", "/api/v1/board", nil, nil)
	board := apiDecode[struct {
		Title string           `json:"title"`
		Items []map[string]any `json:"items"`
	}](t, w, 200)
	if len(board.Items) != 1 || board.Items[0]["name"] != resource.Name || board.Items[0]["status"] != "unknown" {
		t.Fatalf("incorrect projection: %s", w.Body.String())
	}
	for _, secret := range []string{resource.Hostname, resource.IP, "PRIVATE-", "endpoints", "labels", "external_ids", "executor_target"} {
		if strings.Contains(w.Body.String(), secret) {
			t.Fatalf("board leaked %q", secret)
		}
	}
	for field := range board.Items[0] {
		if field != "id" && field != "name" && field != "description" && field != "status" && field != "url" && field != "category" && field != "icon" && field != "support" {
			t.Fatalf("unapproved board field %s", field)
		}
	}
	if board.Items[0]["url"] != resource.URL {
		t.Fatal("published employee URL missing")
	}
	settings.BoardAnonymous = true
	settings = apiDecode[model.Settings](t, apiCall(s, admin, "PUT", "/api/v1/settings", settings, nil), 200)
	anonymous := apiDecode[struct {
		Items []map[string]any `json:"items"`
	}](t, apiCall(s, apiIdentity{}, "GET", "/api/v1/board", nil, nil), 200)
	if len(anonymous.Items) != 1 || len(anonymous.Items[0]) != 4 || anonymous.Items[0]["description"] != "" {
		t.Fatalf("anonymous projection expanded: %#v", anonymous)
	}
	hidden := apiResource(t, s, admin, "Hidden")
	if w := apiCall(s, viewer, "GET", "/api/v1/resources/"+hidden.ID, nil, nil); w.Code != 403 {
		t.Fatal("viewer gained catalog access")
	}
	resource.Lifecycle = "archived"
	apiDecode[model.Resource](t, apiCall(s, admin, "PUT", "/api/v1/resources/"+resource.ID, resource, nil), 200)
	removed := apiDecode[struct {
		Items []map[string]any `json:"items"`
	}](t, apiCall(s, viewer, "GET", "/api/v1/board", nil, nil), 200)
	if len(removed.Items) != 0 {
		t.Fatal("archived or unpublished resource exposed")
	}

	prefs := model.Preferences{Favorites: []string{resource.ID}, SidebarCollapsed: true, HiddenSections: []string{"events"}, WaylineCards: []model.WaylineCard{{IntegrationID: "wayline-source", TargetID: 42}}}
	apiDecode[model.Preferences](t, apiCall(s, admin, "PUT", "/api/v1/preferences", prefs, nil), 200)
	restarted := New(s.Store, s.Config, s.Providers, http.DefaultClient)
	saved := apiDecode[model.Preferences](t, apiCall(restarted, admin, "GET", "/api/v1/preferences", nil, nil), 200)
	if !saved.SidebarCollapsed || len(saved.Favorites) != 1 || saved.Favorites[0] != resource.ID || len(saved.WaylineCards) != 1 || saved.WaylineCards[0].TargetID != 42 {
		t.Fatal("preference/session lost after server recreation")
	}
	other := apiUser(t, restarted, "another-admin", true)
	otherPrefs := apiDecode[model.Preferences](t, apiCall(restarted, other, "GET", "/api/v1/preferences", nil, nil), 200)
	if len(otherPrefs.Favorites) != 0 || otherPrefs.SidebarCollapsed || len(otherPrefs.WaylineCards) != 0 {
		t.Fatal("personal preferences leaked to another user")
	}
	if w := apiCall(restarted, admin, "POST", "/auth/logout", nil, nil); w.Code != 204 {
		t.Fatalf("logout: %d", w.Code)
	}
	if w := apiCall(restarted, admin, "GET", "/api/v1/resources", nil, nil); w.Code != 401 {
		t.Fatal("logout session still valid")
	}
	if _, err := s.Store.Pool.Exec(context.Background(), "UPDATE sessions SET expires_at=now()-interval '1 minute' WHERE token_hash=$1", hash(viewer.cookie.Value)); err != nil {
		t.Fatal(err)
	}
	session := apiDecode[map[string]any](t, apiCall(s, viewer, "GET", "/api/v1/session", nil, nil), 200)
	if session["authenticated"] != false {
		t.Fatal("expired session valid")
	}
}

func TestAPICRUDConflictArchiveAndSensitiveURL(t *testing.T) {
	s := apiFixture(t)
	admin := apiUser(t, s, "admin", true)
	r := apiResource(t, s, admin, "One")
	old := r
	r.Name = "One revised"
	r = apiDecode[model.Resource](t, apiCall(s, admin, "PUT", "/api/v1/resources/"+r.ID, r, nil), 200)
	old.Name = "Stale write"
	if w := apiCall(s, admin, "PUT", "/api/v1/resources/"+r.ID, old, nil); w.Code != 409 {
		t.Fatalf("stale write accepted:%d", w.Code)
	}
	current := apiDecode[model.Resource](t, apiCall(s, admin, "GET", "/api/v1/resources/"+r.ID, nil, nil), 200)
	if current.Name != "One revised" {
		t.Fatal("conflict overwrote accepted update")
	}
	if w := apiCall(s, admin, "DELETE", "/api/v1/resources/"+r.ID, nil, map[string]string{"If-Match": fmt.Sprint(old.Revision)}); w.Code != 409 {
		t.Fatalf("stale archive accepted:%d", w.Code)
	}
	if w := apiCall(s, admin, "DELETE", "/api/v1/resources/"+r.ID, nil, map[string]string{"If-Match": fmt.Sprint(r.Revision)}); w.Code != 204 {
		t.Fatalf("archive:%d", w.Code)
	}
	current = apiDecode[model.Resource](t, apiCall(s, admin, "GET", "/api/v1/resources/"+r.ID, nil, nil), 200)
	if current.Lifecycle != "archived" {
		t.Fatal("archive deleted record or failed")
	}
	for _, url := range []string{"javascript:alert(1)", "https://user:password@example.test", "https://example.test?access_token=secret"} {
		if w := apiCall(s, admin, "POST", "/api/v1/resources", model.Resource{Name: "Unsafe", URL: url}, nil); w.Code != 400 {
			t.Errorf("unsafe URL accepted: %s status%d", url, w.Code)
		}
	}
}

type apiPreview struct {
	Token     string              `json:"token"`
	Changes   []map[string]string `json:"changes"`
	Conflicts []string            `json:"conflicts"`
}

func TestAPIImportPreviewMergeStaleReplayAndPermissions(t *testing.T) {
	s := apiFixture(t)
	admin := apiUser(t, s, "admin", true)
	other := apiUser(t, s, "other", true)
	existing := apiResource(t, s, admin, "Existing")
	incoming := model.Resource{Name: "Imported revision", URL: existing.URL + "/", Operations: []string{"restart"}, ExecutorTarget: "unapproved"}
	doc := exportDocument{SchemaVersion: 1, Resources: []model.Resource{incoming}, Collections: []model.Collection{}}
	preview := apiDecode[apiPreview](t, apiCall(s, admin, "POST", "/api/v1/import/preview", doc, nil), 200)
	if preview.Token == "" || len(preview.Changes) != 1 || preview.Changes[0]["action"] != "update" {
		t.Fatalf("URL duplicate not recognized: %+v", preview)
	}
	unchanged := apiDecode[model.Resource](t, apiCall(s, admin, "GET", "/api/v1/resources/"+existing.ID, nil, nil), 200)
	if unchanged.Name != existing.Name {
		t.Fatal("preview modified database")
	}
	if w := apiCall(s, other, "POST", "/api/v1/import/apply", map[string]string{"token": preview.Token}, nil); w.Code != 404 {
		t.Fatalf("another actor consumed import:%d", w.Code)
	}
	apiDecode[map[string]bool](t, apiCall(s, admin, "POST", "/api/v1/import/apply", map[string]string{"token": preview.Token}, nil), 200)
	if w := apiCall(s, admin, "POST", "/api/v1/import/apply", map[string]string{"token": preview.Token}, nil); w.Code != 404 {
		t.Fatalf("import replay:%d", w.Code)
	}
	merged := apiDecode[model.Resource](t, apiCall(s, admin, "GET", "/api/v1/resources/"+existing.ID, nil, nil), 200)
	if merged.Name != "Imported revision" || len(merged.Operations) != 0 || merged.ExecutorTarget != "" {
		t.Fatal("merge identity/operation permissions failed")
	}
	preview = apiDecode[apiPreview](t, apiCall(s, admin, "POST", "/api/v1/import/preview", doc, nil), 200)
	apiResource(t, s, admin, "Concurrent")
	if w := apiCall(s, admin, "POST", "/api/v1/import/apply", map[string]string{"token": preview.Token}, nil); w.Code != 409 {
		t.Fatalf("stale import applied:%d", w.Code)
	}
	duplicate := doc
	duplicate.Resources = []model.Resource{incoming, incoming}
	dup := apiDecode[apiPreview](t, apiCall(s, admin, "POST", "/api/v1/import/preview", duplicate, nil), 200)
	if dup.Token != "" || len(dup.Conflicts) == 0 {
		t.Fatal("duplicate import had apply token")
	}
	invalid := doc
	invalid.SchemaVersion = 99
	if w := apiCall(s, admin, "POST", "/api/v1/import/preview", invalid, nil); w.Code != 400 {
		t.Fatal("unknown schema accepted")
	}
	fresh := exportDocument{SchemaVersion: 1, Resources: []model.Resource{{Name: "Fresh", URL: "https://fresh.example.test", Operations: []string{"restart"}, ExecutorTarget: "unapproved"}}}
	preview = apiDecode[apiPreview](t, apiCall(s, admin, "POST", "/api/v1/import/preview", fresh, nil), 200)
	apiDecode[map[string]bool](t, apiCall(s, admin, "POST", "/api/v1/import/apply", map[string]string{"token": preview.Token}, nil), 200)
	exported := apiDecode[exportDocument](t, apiCall(s, admin, "GET", "/api/v1/export", nil, nil), 200)
	if exported.SchemaVersion != 1 || len(exported.Resources) != 3 {
		t.Fatalf("export shape/count wrong:%+v", exported)
	}
	for _, r := range exported.Resources {
		if r.Name == "Fresh" && (len(r.Operations) > 0 || r.ExecutorTarget != "") {
			t.Fatal("new import enabled privilege")
		}
	}
}

func TestAPIImportRejectsInvalidCollectionModeAndDuplicateID(t *testing.T) {
	s := apiFixture(t)
	admin := apiUser(t, s, "admin", true)
	r := apiResource(t, s, admin, "CollectionTarget")
	hybrid := model.Collection{Name: "Hybrid", ResourceIDs: []string{r.ID}, Filter: model.Filter{Q: "monitoring"}}
	// Import must preserve the same collection invariants as direct CRUD.
	if w := apiCall(s, admin, "POST", "/api/v1/collections", hybrid, nil); w.Code != 400 {
		t.Fatalf("CRUD accepted hybrid collection:%d", w.Code)
	}
	imported := exportDocument{SchemaVersion: 1, Resources: []model.Resource{}, Collections: []model.Collection{hybrid}}
	w := apiCall(s, admin, "POST", "/api/v1/import/preview", imported, nil)
	if w.Code != 400 {
		t.Errorf("import bypassed collection mode validation: %d %s", w.Code, w.Body.String())
	}
	id := "550e8400-e29b-41d4-a716-446655440000"
	imported.Collections = []model.Collection{{ID: id, Name: "One"}, {ID: id, Name: "Two"}}
	w = apiCall(s, admin, "POST", "/api/v1/import/preview", imported, nil)
	if w.Code == 200 {
		p := apiDecode[apiPreview](t, w, 200)
		if p.Token != "" || len(p.Conflicts) == 0 {
			t.Error("same imported collection ID produced an applicable plan")
		}
	} else if w.Code != 400 {
		t.Errorf("unexpected duplicate collection status:%d", w.Code)
	}
}

func TestAPIOperationConfirmationTargetAndIdempotency(t *testing.T) {
	s := apiFixture(t)
	admin := apiUser(t, s, "operator", true)
	r := apiResource(t, s, admin, "RestartTarget")
	request := model.Job{Kind: "restart", ResourceID: r.ID, IdempotencyKey: "operation-test-001", Confirmed: true, Actor: "spoofed-user"}
	if w := apiCall(s, admin, "POST", "/api/v1/jobs", request, nil); w.Code != 403 {
		t.Fatalf("operation implicitly enabled:%d", w.Code)
	}
	r.Operations = []string{"restart"}
	r.ExecutorTarget = "approved-logical-target"
	r = apiDecode[model.Resource](t, apiCall(s, admin, "PUT", "/api/v1/resources/"+r.ID, r, nil), 200)
	if w := apiCall(s, admin, "POST", "/api/v1/jobs", request, nil); w.Code != 409 {
		t.Fatalf("missing executor accepted:%d", w.Code)
	}
	s.Config.ExecutorURL = "unix:///not-contacted-by-handler.sock"
	request.Confirmed = false
	if w := apiCall(s, admin, "POST", "/api/v1/jobs", request, nil); w.Code != 403 {
		t.Fatalf("missing confirmation accepted:%d", w.Code)
	}
	request.Confirmed = true
	request.Parameters = map[string]any{"command": "do-not-run"}
	if w := apiCall(s, admin, "POST", "/api/v1/jobs", request, nil); w.Code != 400 {
		t.Fatalf("arbitrary command accepted:%d", w.Code)
	}
	request.Parameters = nil
	first := apiDecode[model.Job](t, apiCall(s, admin, "POST", "/api/v1/jobs", request, nil), 202)
	if first.Actor != "operator" || first.Status != "queued" || first.Parameters["executor_target"] != "approved-logical-target" {
		t.Fatalf("trusted actor/target snapshot failed:%+v", first)
	}
	second := apiDecode[model.Job](t, apiCall(s, admin, "POST", "/api/v1/jobs", request, nil), 202)
	if second.ID != first.ID {
		t.Fatal("retry created a second job")
	}
	request.IdempotencyKey = "operation-test-002"
	if w := apiCall(s, admin, "POST", "/api/v1/jobs", request, nil); w.Code != 409 {
		t.Fatalf("parallel restart accepted:%d", w.Code)
	}
	r.ExecutorTarget = "changed-target"
	apiDecode[model.Resource](t, apiCall(s, admin, "PUT", "/api/v1/resources/"+r.ID, r, nil), 200)
	request.IdempotencyKey = "operation-test-001"
	if w := apiCall(s, admin, "POST", "/api/v1/jobs", request, nil); w.Code != 409 {
		t.Fatalf("same key changed target accepted:%d", w.Code)
	}
	saved := apiDecode[model.Job](t, apiCall(s, admin, "GET", "/api/v1/jobs/"+first.ID, nil, nil), 200)
	if saved.Parameters["executor_target"] != "approved-logical-target" {
		t.Fatal("queued target changed with edited resource")
	}
	for _, job := range []model.Job{{Kind: "shell", IdempotencyKey: "unsupported-shell"}, {Kind: "check", IdempotencyKey: "unsupported-check", Parameters: map[string]any{"kind": "snmp", "target": "example.test"}}} {
		if w := apiCall(s, admin, "POST", "/api/v1/jobs", job, nil); w.Code != 400 {
			t.Fatalf("unsupported operation accepted:%d", w.Code)
		}
	}
	if w := apiCall(s, admin, "POST", "/api/v1/jobs", model.Job{Kind: "report", IdempotencyKey: "missing-generator"}, nil); w.Code != 409 {
		t.Fatalf("missing report generator accepted:%d", w.Code)
	}
}

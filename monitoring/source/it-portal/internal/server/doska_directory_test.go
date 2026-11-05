package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/organization"
)

func doskaDirectoryTestRequest(method, target, principal string) *http.Request {
	r := httptest.NewRequest(method, target, nil)
	if principal != "" {
		r = r.WithContext(context.WithValue(r.Context(), sessionKey, session{User: model.User{ID: principal, Admin: true}}))
	}
	return r
}

func TestDoskaDirectoryPostgreSQLHTTP(t *testing.T) {
	s := apiFixture(t)
	token := strings.Repeat("test-only-doska-directory-", 2)
	s.Config.MachineCredentialsFile = filepath.Join(t.TempDir(), "machines.json")
	config, err := json.Marshal(map[string]any{"principals": []machinePrincipal{{ID: "doska-directory", TokenSHA256: hash(token), Scopes: []string{"doska:directory:read"}, ExpiresAt: time.Now().Add(time.Hour)}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(s.Config.MachineCredentialsFile, config, 0600); err != nil {
		t.Fatal(err)
	}
	call := func(path string, want int) map[string]any {
		t.Helper()
		r := httptest.NewRequest("GET", "https://portal.example.test"+path, nil)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		var body map[string]any
		if w.Code != want {
			t.Fatalf("%s got %d want %d: %s", path, w.Code, want, w.Body.String())
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(w.Body.String(), token) || strings.Contains(w.Body.String(), "ad_groups") || strings.Contains(w.Body.String(), "provider_namespace") {
			t.Fatal("private source metadata leaked")
		}
		return body
	}
	ctx, now := context.Background(), time.Now().UTC().Truncate(time.Second)
	org := organization.NewStore(s.Store.Pool)
	dept, err := org.SaveDepartment(ctx, organization.Department{ID: "engineering", Name: "Разработка", Active: true}, 0, "test-admin", now)
	if err != nil {
		t.Fatal(err)
	}
	record := func(last byte, state organization.AccountState, at time.Time) organization.EmployeeRecord {
		guid := make([]byte, 16)
		guid[15] = last
		sub, _ := organization.ADSubject("dc=fixture,dc=test", guid)
		return organization.EmployeeRecord{Identity: organization.Identity{Subject: sub, Name: "Сотрудник", AccountState: state, Department: organization.ResolveDepartment([]string{dept.ID}, nil), LastSuccessAt: at}, Provider: "ad", ProviderNamespace: strings.Split(sub, ":")[1], ObjectGUID: guid}
	}
	r1, r2 := record(1, organization.Active, now), record(2, organization.Active, now)
	i1, err := org.SaveEmployee(ctx, r1, 0, "test-sync", now)
	if err != nil {
		t.Fatal(err)
	}
	_, err = org.SaveEmployee(ctx, r2, 0, "test-sync", now)
	if err != nil {
		t.Fatal(err)
	}
	identityPath := "/api/v1/doska-directory/identity?sub=" + url.QueryEscape(i1.Subject)
	body := call(identityPath, 200)
	if body["sub"] != i1.Subject || body["state"] != "active" || body["department_state"] != "resolved" || body["primary_department_id"] != dept.ID {
		t.Fatalf("wrong identity DTO: %v", body)
	}
	if call("/api/v1/doska-directory/identity?sub=unknown", 404)["error"] != "not_found" {
		t.Fatal("unknown identity mapping")
	}
	page1 := call("/api/v1/doska-directory/employees?limit=1", 200)
	items := page1["items"].([]any)
	if len(items) != 1 || page1["next_cursor"] == "" || page1["changes_cursor"] == "" {
		t.Fatalf("missing snapshot page/cursors: %v", page1)
	}
	next := page1["next_cursor"].(string)
	page2 := call("/api/v1/doska-directory/employees?limit=1&cursor="+url.QueryEscape(next), 200)
	if len(page2["items"].([]any)) != 1 || page2["changes_cursor"] != page1["changes_cursor"] || page2["items"].([]any)[0].(map[string]any)["sub"] == items[0].(map[string]any)["sub"] {
		t.Fatal("snapshot pagination lost or duplicated identity")
	}
	dept.HeadSubjects = []string{i1.Subject}
	if _, err := org.SaveDepartment(ctx, dept, dept.Revision, "test-admin", now); err != nil {
		t.Fatal(err)
	}
	departments := call("/api/v1/doska-directory/departments", 200)
	department := departments["items"].([]any)[0].(map[string]any)
	if department["id"] != dept.ID || len(department["head_subjects"].([]any)) != 1 {
		t.Fatal("department head metadata missing")
	}
	changes := call("/api/v1/doska-directory/changes?after="+url.QueryEscape(page1["changes_cursor"].(string)), 200)
	foundIdentity, foundDepartment := false, false
	for _, raw := range changes["items"].([]any) {
		event := raw.(map[string]any)
		switch event["type"] {
		case "identity.changed":
			foundIdentity = true
			if event["subject"] != i1.Subject || event["identity"] == nil {
				t.Fatal("identity change missing projection")
			}
		case "department.changed":
			foundDepartment = true
			if event["department"] == nil || event["identity"] != nil {
				t.Fatal("department change malformed")
			}
		}
	}
	if !foundIdentity || !foundDepartment {
		t.Fatal("durable changes missing identity or department update")
	}
	// Simulate the durable retention watermark in the isolated test schema.
	// No production retention worker or pruning is implied by this check.
	if _, err := s.Store.Pool.Exec(ctx, "UPDATE org_cursor_state SET retained_after=(SELECT max(sequence) FROM org_outbox)"); err != nil {
		t.Fatal(err)
	}
	if call("/api/v1/doska-directory/changes?after="+url.QueryEscape(page1["changes_cursor"].(string)), 410)["error"] != "resync_required" {
		t.Fatal("changes retention gap accepted")
	}
	if call("/api/v1/doska-directory/employees?cursor=notacursor", 400)["error"] != "invalid_cursor" {
		t.Fatal("invalid cursor status")
	}
	if _, err := s.Store.Pool.Exec(ctx, "UPDATE org_snapshots SET expires_at=now()-interval '1 second'"); err != nil {
		t.Fatal(err)
	}
	if call("/api/v1/doska-directory/employees?cursor="+url.QueryEscape(next), 410)["error"] != "resync_required" {
		t.Fatal("expired snapshot accepted")
	}
	r2.Identity.AccountState = organization.Disabled
	if _, err := org.SaveEmployee(ctx, r2, 1, "test-sync", now); err != nil {
		t.Fatal(err)
	}
	if call("/api/v1/doska-directory/identity?sub="+url.QueryEscape(r2.Identity.Subject), 200)["state"] != "disabled" {
		t.Fatal("disabled account not delivered")
	}
	stale := record(3, organization.Active, now.Add(-3*time.Hour))
	if _, err := org.SaveEmployee(ctx, stale, 0, "test-sync", now); err != nil {
		t.Fatal(err)
	}
	if call("/api/v1/doska-directory/identity?sub="+url.QueryEscape(stale.Identity.Subject), 503)["error"] != "directory_stale" {
		t.Fatal("stale account accepted")
	}
	s.Store.Pool.Close()
	if call(identityPath, 503)["error"] != "directory_unavailable" {
		t.Fatal("store outage accepted")
	}
}

func TestDoskaDirectoryQueryAndPrincipalBoundaries(t *testing.T) {
	s := &Server{}
	for _, tc := range []struct {
		target string
		want   int
	}{
		{"/api/v1/doska-directory/identity", 400},
		{"/api/v1/doska-directory/identity?sub=", 400},
		{"/api/v1/doska-directory/identity?sub=a&sub=b", 400},
		{"/api/v1/doska-directory/identity?sub=a&limit=1", 400},
		{"/api/v1/doska-directory/identity?sub=%00", 400},
		{"/api/v1/doska-directory/identity?sub=%FF", 400},
		{"/api/v1/doska-directory/identity?sub=%20a", 400},
		{"/api/v1/doska-directory/identity?sub=" + strings.Repeat("a", 257), 400},
		{"/api/v1/doska-directory/employees?limit=0", 400},
		{"/api/v1/doska-directory/employees?limit=101", 400},
		{"/api/v1/doska-directory/employees?limit=%2B1", 400},
		{"/api/v1/doska-directory/employees?limit=01", 400},
		{"/api/v1/doska-directory/employees?limit=1&limit=2", 400},
		{"/api/v1/doska-directory/employees?cursor=", 400},
		{"/api/v1/doska-directory/employees?cursor=a%3Db", 400},
		{"/api/v1/doska-directory/employees?cursor=" + strings.Repeat("a", 4097), 400},
		{"/api/v1/doska-directory/employees?cursor=%ZZ", 400},
		{"/api/v1/doska-directory/employees?unknown=1", 400},
		{"/api/v1/doska-directory/changes?after=", 400},
		{"/api/v1/doska-directory/changes?cursor=abc", 400},
		{"/api/v1/doska-directory/changes?after=abc&after=def", 400},
		{"/api/v1/doska-directory/departments?limit=", 400},
		{"/api/v1/doska-directory/identity?sub=ad%3Aknown", 503},
		{"/api/v1/doska-directory/employees?limit=1", 503},
		{"/api/v1/doska-directory/departments?limit=100", 503},
		{"/api/v1/doska-directory/changes", 503},
		{"/api/v1/doska-directory/unknown", 404},
	} {
		t.Run(tc.target, func(t *testing.T) {
			w := httptest.NewRecorder()
			s.doskaDirectory(w, doskaDirectoryTestRequest("GET", tc.target, "machine:doska-directory"))
			if w.Code != tc.want || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("got %d want %d: %s", w.Code, tc.want, w.Body.String())
			}
		})
	}
	for _, principal := range []string{"", "ad:person", "machine:mcp", "machine:another-service"} {
		w := httptest.NewRecorder()
		s.doskaDirectory(w, doskaDirectoryTestRequest("GET", "/api/v1/doska-directory/employees", principal))
		if w.Code != 403 {
			t.Fatalf("principal %q: %d", principal, w.Code)
		}
	}
	for _, method := range []string{"HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"} {
		w := httptest.NewRecorder()
		s.doskaDirectory(w, doskaDirectoryTestRequest(method, "/api/v1/doska-directory/employees", "machine:doska-directory"))
		if w.Code != 405 {
			t.Fatalf("method %s: %d", method, w.Code)
		}
	}
	r := doskaDirectoryTestRequest("GET", "/api/v1/doska-directory/employees", "machine:doska-directory")
	r.ContentLength = 1
	w := httptest.NewRecorder()
	s.doskaDirectory(w, r)
	if w.Code != 400 {
		t.Fatal("GET body accepted")
	}
}

func TestDoskaDirectoryDTOAndErrors(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	p := organization.Project(organization.Identity{Subject: "ad:known", Name: "Сотрудник", Revision: 12, AccountState: organization.Disabled, LastSuccessAt: now,
		Department: organization.ResolveDepartment([]string{"dept1"}, nil)}, now, organization.DefaultMaxFreshness)
	dto := doskaDirectoryIdentity(p)
	data, err := json.Marshal(dto)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(data, &fields); err != nil {
		t.Fatal(err)
	}
	if len(fields) != 10 || fields["schema_version"] != float64(1) || fields["sub"] != "ad:known" || fields["state"] != "disabled" || fields["department_state"] != "resolved" || fields["identity_revision"] != float64(12) || fields["observed_at"] != now.Format(time.RFC3339) || fields["valid_until"] != now.Add(2*time.Hour).Format(time.RFC3339) || fields["head_department_ids"] == nil {
		t.Fatalf("unexpected public DTO: %s", data)
	}
	for _, tc := range []struct {
		err    error
		status int
		code   string
	}{
		{organization.ErrNotFound, 404, "not_found"},
		{organization.ErrInvalidCursor, 400, "invalid_cursor"},
		{organization.ErrCursorExpired, 410, "resync_required"},
		{organization.ErrStale, 503, "directory_stale"},
		{errors.New("private database information"), 503, "directory_unavailable"},
	} {
		w := httptest.NewRecorder()
		doskaDirectoryError(w, tc.err)
		var body map[string]string
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if w.Code != tc.status || body["error"] != tc.code || strings.Contains(w.Body.String(), "private database") {
			t.Fatalf("error response %d %s", w.Code, w.Body.String())
		}
	}
}

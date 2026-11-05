package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pl/portal/internal/model"
)

func TestStageLocalPasswordHashAtomicAndPrivate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "local-admin.hash")
	if err := os.WriteFile(path, []byte("previous"), 0600); err != nil {
		t.Fatal(err)
	}
	temp, err := stageLocalPasswordHash(path, "replacement")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(temp)
	previous, _ := os.ReadFile(path)
	if string(previous) != "previous" {
		t.Fatal("staging replaced the active hash before session revocation")
	}
	info, _ := os.Stat(temp)
	if info.Mode().Perm() != 0600 {
		t.Fatal("staged hash is not private")
	}
	if err := os.Rename(temp, path); err != nil {
		t.Fatal(err)
	}
	replacement, _ := os.ReadFile(path)
	if string(replacement) != "replacement\n" {
		t.Fatal("replacement was not committed")
	}
	link := filepath.Join(filepath.Dir(path), "link")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if _, err := stageLocalPasswordHash(link, "unwanted"); err == nil {
		t.Fatal("symlink accepted")
	}
	if err := os.Chmod(path, 0666); err != nil {
		t.Fatal(err)
	}
	if _, err := stageLocalPasswordHash(path, "unwanted"); err == nil {
		t.Fatal("publicly writable credential accepted")
	}
}

func TestChangeLocalPasswordDisabledAndNonLocal(t *testing.T) {
	s := &Server{}
	request := httptest.NewRequest("POST", "/api/v1/local-admin/password", nil)
	w := httptest.NewRecorder()
	s.changeLocalAdminPassword(w, request)
	if w.Code != 404 {
		t.Fatal("read-only profiles must not offer password changes")
	}
	s.Config = Config{LocalAdminHashFile: "unused", LocalAdminPasswordChange: true}
	w = httptest.NewRecorder()
	request = request.WithContext(context.WithValue(request.Context(), sessionKey, session{User: model.User{ID: "ad:admin", Admin: true}}))
	s.changeLocalAdminPassword(w, request)
	if w.Code != 403 {
		t.Fatal("another administrator changed the local password")
	}
	w = httptest.NewRecorder()
	s.auth(s.changeLocalAdminPassword, true)(w, httptest.NewRequest("POST", "/api/v1/local-admin/password", nil))
	if w.Code != 401 {
		t.Fatal("anonymous password change accepted")
	}
}

func TestChangeLocalPasswordRejectsInvalidNewPasswordBeforeStorage(t *testing.T) {
	s := &Server{Config: Config{LocalAdminHashFile: "unused", LocalAdminPasswordChange: true}}
	for _, password := range []string{"short", "тотже", "same fixture password", "line\nbreak password", strings.Repeat("a", 1025)} {
		body, _ := json.Marshal(map[string]string{"current_password": "same fixture password", "new_password": password})
		r := httptest.NewRequest("POST", "/api/v1/local-admin/password", strings.NewReader(string(body)))
		r.Header.Set("Content-Type", "application/json")
		r = r.WithContext(context.WithValue(r.Context(), sessionKey, session{User: model.User{ID: "local-admin", Admin: true}}))
		w := httptest.NewRecorder()
		s.changeLocalAdminPassword(w, r)
		if w.Code != 400 {
			t.Fatalf("invalid new password reached storage: %d", w.Code)
		}
	}
}

func passwordChangeTestServer(t *testing.T) *Server {
	t.Helper()
	path := filepath.Join(t.TempDir(), "local-admin.hash")
	if err := os.WriteFile(path, []byte(localTestHash("admin")), 0600); err != nil {
		t.Fatal(err)
	}
	s := &Server{Store: localAuthTestStore(t), Config: Config{PublicURL: "http://localhost", LocalAdminUsername: "admin", LocalAdminHashFile: path, LocalAdminPasswordChange: true, SessionLifetime: time.Hour}}
	if err := os.WriteFile(s.passwordChangeMarker(), nil, 0600); err != nil {
		t.Fatal(err)
	}
	for _, row := range []struct{ token, id string }{{"local-one", "local-admin"}, {"local-two", "local-admin"}, {"external", "ad:admin"}} {
		if _, err := s.Store.Pool.Exec(context.Background(), "INSERT INTO sessions(token_hash,user_id,user_name,admin,csrf,expires_at) VALUES($1,$2,'Fixture',true,'fixture-csrf',now()+interval '1 hour')", hash(row.token), row.id); err != nil {
			t.Fatal(err)
		}
	}
	return s
}

func changePasswordRequest(s *Server, token, origin, csrf, old, next string) *httptest.ResponseRecorder {
	body, _ := json.Marshal(map[string]string{"current_password": old, "new_password": next})
	r := httptest.NewRequest("POST", "http://localhost/api/v1/local-admin/password", strings.NewReader(string(body)))
	r.RemoteAddr = "192.0.2.10:54321"
	r.Header.Set("Origin", origin)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-CSRF-Token", csrf)
	r.AddCookie(&http.Cookie{Name: "portal_session", Value: token})
	w := httptest.NewRecorder()
	s.auth(s.changeLocalAdminPassword, true)(w, r)
	return w
}

func TestChangeLocalPasswordRevokesSessionsAndChangesLogin(t *testing.T) {
	s := passwordChangeTestServer(t)
	for _, tc := range []struct{ token, origin, csrf string }{{"external", "http://localhost", "fixture-csrf"}, {"local-one", "https://other.invalid", "fixture-csrf"}, {"local-one", "http://localhost", "wrong"}} {
		if w := changePasswordRequest(s, tc.token, tc.origin, tc.csrf, "admin", "fixture new password"); w.Code != 403 {
			t.Fatalf("identity/origin/CSRF boundary: %d", w.Code)
		}
	}
	if w := changePasswordRequest(s, "local-one", "http://localhost", "fixture-csrf", "wrong", "fixture new password"); w.Code != 400 {
		t.Fatalf("wrong current password: %d", w.Code)
	}
	if w := changePasswordRequest(s, "local-one", "http://localhost", "fixture-csrf", "admin", "short"); w.Code != 400 {
		t.Fatalf("short new password: %d", w.Code)
	}
	if w := changePasswordRequest(s, "local-one", "http://localhost", "fixture-csrf", "admin", "fixture new password"); w.Code != 204 {
		t.Fatalf("change failed: %d %s", w.Code, w.Body.String())
	}
	var local, external int
	if err := s.Store.Pool.QueryRow(context.Background(), "SELECT count(*) FILTER (WHERE user_id='local-admin'),count(*) FILTER (WHERE user_id='ad:admin') FROM sessions").Scan(&local, &external); err != nil || local != 0 || external != 1 {
		t.Fatalf("session revocation: local=%d external=%d error=%v", local, external, err)
	}
	if s.localPasswordChangeRequired() {
		t.Fatal("first-login marker survived successful change")
	}
	info, err := os.Stat(s.Config.LocalAdminHashFile)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("replacement hash is not private")
	}
	if w := localRequest(s, "admin", "admin"); w.Code != 401 {
		t.Fatalf("old password still works: %d", w.Code)
	}
	if w := localRequest(s, "admin", "fixture new password"); w.Code != 200 {
		t.Fatalf("new password failed login: %d", w.Code)
	}
}

func TestChangeLocalPasswordRevokeFailurePreservesHashAndMarker(t *testing.T) {
	s := passwordChangeTestServer(t)
	_, err := s.Store.Pool.Exec(context.Background(), `CREATE FUNCTION reject_password_session_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'fixture deletion failure'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER reject_password_session_delete BEFORE DELETE ON sessions FOR EACH ROW EXECUTE FUNCTION reject_password_session_delete();`)
	if err != nil {
		t.Fatal(err)
	}
	if w := changePasswordRequest(s, "local-one", "http://localhost", "fixture-csrf", "admin", "fixture new password"); w.Code != 503 {
		t.Fatalf("DB revocation failure: %d", w.Code)
	}
	h, err := readLocalPasswordHash(s.Config.LocalAdminHashFile)
	if err != nil || !h.verify("admin") || h.verify("fixture new password") || !s.localPasswordChangeRequired() {
		t.Fatal("DB failure published a new hash or removed the first-login marker")
	}
	staged, _ := filepath.Glob(filepath.Join(filepath.Dir(s.Config.LocalAdminHashFile), ".local-admin-hash-*"))
	if len(staged) != 0 {
		t.Fatal("staged credential was left behind")
	}
}

func TestChangeLocalPasswordStorageFailurePreservesSessions(t *testing.T) {
	s := passwordChangeTestServer(t)
	if err := os.Chmod(filepath.Dir(s.Config.LocalAdminHashFile), 0777); err != nil {
		t.Fatal(err)
	}
	if w := changePasswordRequest(s, "local-one", "http://localhost", "fixture-csrf", "admin", "fixture new password"); w.Code != 503 {
		t.Fatalf("unsafe password storage: %d", w.Code)
	}
	var count int
	if err := s.Store.Pool.QueryRow(context.Background(), "SELECT count(*) FROM sessions WHERE user_id='local-admin'").Scan(&count); err != nil || count != 2 {
		t.Fatal("preparation failure revoked sessions")
	}
	h, err := readLocalPasswordHash(s.Config.LocalAdminHashFile)
	if err != nil || !h.verify("admin") || !s.localPasswordChangeRequired() {
		t.Fatal("preparation failure modified credentials")
	}
}

func TestChangeLocalPasswordWrongCurrentIsRateLimited(t *testing.T) {
	s := passwordChangeTestServer(t)
	for attempt := 0; attempt < 6; attempt++ {
		w := changePasswordRequest(s, "local-one", "http://localhost", "fixture-csrf", "wrong", "fixture new password")
		want := 400
		if attempt == 5 {
			want = 429
		}
		if w.Code != want {
			t.Fatalf("attempt %d: got %d, want %d", attempt, w.Code, want)
		}
	}
}

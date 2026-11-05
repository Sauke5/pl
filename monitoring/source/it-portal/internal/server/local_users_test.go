package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"pl/portal/internal/model"
	"pl/portal/internal/store"
)

const localUserFixturePassword = "fixture user password"

func localUsersFixture(t *testing.T) (*Server, apiIdentity) {
	t.Helper()
	s := apiFixture(t)
	s.Config.PublicURL = "http://localhost"
	path := filepath.Join(t.TempDir(), "local-admin.hash")
	if err := os.WriteFile(path, []byte(localTestHash("admin")), 0600); err != nil {
		t.Fatal(err)
	}
	s.Config.LocalAdminUsername = "admin"
	s.Config.LocalAdminHashFile = path
	s.Config.LocalUsersEnabled = true
	s.Config.LocalAdminPasswordChange = true
	return s, apiUser(t, s, "local-admin", true)
}
func createFixtureLocalUser(t *testing.T, s *Server, admin apiIdentity, username string, role bool) store.LocalUser {
	t.Helper()
	w := apiCall(s, admin, "POST", "/api/v1/local-users", map[string]any{"username": username, "name": "Тестовый пользователь", "admin": role, "password": localUserFixturePassword}, nil)
	if w.Code != 201 {
		t.Fatalf("create local user: %d %s", w.Code, w.Body.String())
	}
	var u store.LocalUser
	if err := json.Unmarshal(w.Body.Bytes(), &u); err != nil {
		t.Fatal(err)
	}
	return u
}
func localUserIdentity(t *testing.T, s *Server, username, password string) apiIdentity {
	t.Helper()
	w := localRequest(s, username, password)
	if w.Code != 200 {
		t.Fatalf("local login %q: %d %s", username, w.Code, w.Body.String())
	}
	for _, c := range w.Result().Cookies() {
		if c.Name == "portal_session" {
			r := httptest.NewRequest("GET", s.Config.PublicURL+"/api/v1/session", nil)
			r.AddCookie(c)
			v, err := s.readSession(r)
			if err != nil {
				t.Fatal(err)
			}
			return apiIdentity{c, v.CSRF}
		}
	}
	t.Fatal("missing local session")
	return apiIdentity{}
}
func updateFixtureLocalUser(t *testing.T, s *Server, admin apiIdentity, u store.LocalUser) store.LocalUser {
	t.Helper()
	w := apiCall(s, admin, "PATCH", "/api/v1/local-users/"+u.ID, map[string]any{"name": u.Name, "admin": u.Admin, "disabled": u.Disabled, "revision": u.Revision}, nil)
	if w.Code != 200 {
		t.Fatalf("update local user: %d %s", w.Code, w.Body.String())
	}
	var next store.LocalUser
	if err := json.Unmarshal(w.Body.Bytes(), &next); err != nil {
		t.Fatal(err)
	}
	return next
}

func TestLocalUserValidationAndOptIn(t *testing.T) {
	for _, name := range []string{"", " leading", "trailing ", "line\nbreak", strings.Repeat("я", 129)} {
		if validLocalName(name) {
			t.Fatalf("invalid display name accepted %q", name)
		}
	}
	for _, name := range []string{"Администратор", strings.Repeat("я", 128)} {
		if !validLocalName(name) {
			t.Fatal("valid Unicode display name rejected")
		}
	}
	for _, password := range []string{"short", "password\nline", "password\x00line", strings.Repeat("я", 513)} {
		if validLocalPassword(password) {
			t.Fatal("invalid password accepted")
		}
	}
	if !validLocalPassword(strings.Repeat("я", 12)) {
		t.Fatal("password character count treated as bytes")
	}
	for _, username := range []string{"", "_start", ".start", "-start", "with space", "юзер", strings.Repeat("a", 65)} {
		if localUsernamePattern.MatchString(username) {
			t.Fatal("invalid username accepted")
		}
	}
	if asciiLocalUsername("Kelvin") || asciiLocalUsername("Alİce") || !asciiLocalUsername("ASCII.42_-") {
		t.Fatal("Unicode case folding can alias an ASCII username")
	}
	s := &Server{}
	for _, method := range []string{"GET", "POST"} {
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, httptest.NewRequest(method, "/api/v1/local-users", nil))
		if w.Code != 404 {
			t.Fatalf("opt-out route: %d", w.Code)
		}
	}
	s.Config.LocalUsersEnabled = true
	r := httptest.NewRequest("GET", "/api/v1/local-users", nil)
	r.Header.Set("Authorization", "Bearer machine-token")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("machine credential reached user management")
	}
	t.Setenv("PORTAL_DATABASE_URL", "postgres://fixture.invalid/unused")
	t.Setenv("PORTAL_PUBLIC_URL", "http://localhost:8098")
	t.Setenv("PORTAL_DEMO", "true")
	t.Setenv("PORTAL_LOCAL_ADMIN_HASH_FILE", "")
	t.Setenv("PORTAL_LOCAL_USERS", "true")
	if _, err := LoadConfig(); err == nil || !strings.Contains(err.Error(), "local users require") {
		t.Fatalf("missing builtin hash: %v", err)
	}
	t.Setenv("PORTAL_LOCAL_USERS", "")
	if c, err := LoadConfig(); err != nil || c.LocalUsersEnabled {
		t.Fatalf("local-users opt-out default: %v", err)
	}
}

func TestLocalUsersCreationProtectionAndPublicProjection(t *testing.T) {
	s, admin := localUsersFixture(t)
	user := createFixtureLocalUser(t, s, admin, "Alice", false)
	if user.Username != "alice" || !strings.HasPrefix(user.ID, "local:") || user.Revision != 1 || user.Builtin || user.Disabled || user.CreatedAt == nil || user.UpdatedAt == nil {
		t.Fatalf("bad projection: %+v", user)
	}
	for _, tc := range []struct {
		username string
		status   int
		code     string
	}{{"ALICE", 409, "username_conflict"}, {"ADMIN", 400, "reserved_username"}, {"_bad", 400, "invalid_username"}, {"Kelvin", 400, "invalid_username"}} {
		w := apiCall(s, admin, "POST", "/api/v1/local-users", map[string]any{"username": tc.username, "name": "Fixture", "admin": false, "password": localUserFixturePassword}, nil)
		if w.Code != tc.status || !strings.Contains(w.Body.String(), tc.code) {
			t.Fatalf("create %q: %d %s", tc.username, w.Code, w.Body.String())
		}
	}
	if w := localRequest(s, "Alİce", localUserFixturePassword); w.Code != 401 || !strings.Contains(w.Body.String(), "invalid_credentials") {
		t.Fatal("non-ASCII spelling authenticated an ASCII account")
	}
	for _, path := range []string{"/api/v1/local-users/local-admin", "/api/v1/local-users/local-admin/password"} {
		method := "PATCH"
		if strings.HasSuffix(path, "/password") {
			method = "POST"
		}
		w := apiCall(s, admin, method, path, map[string]any{}, nil)
		if w.Code != 403 || !strings.Contains(w.Body.String(), "builtin_protected") {
			t.Fatalf("builtin mutation: %d %s", w.Code, w.Body.String())
		}
	}
	for _, headers := range []map[string]string{{"Origin": "https://evil.invalid"}, {"X-CSRF-Token": "invalid"}} {
		w := apiCall(s, admin, "POST", "/api/v1/local-users", map[string]any{}, headers)
		if w.Code != 403 {
			t.Fatalf("origin/CSRF: %d", w.Code)
		}
	}
	viewer := localUserIdentity(t, s, "ALICE", localUserFixturePassword)
	if w := apiCall(s, viewer, "GET", "/api/v1/local-users", nil, nil); w.Code != 403 {
		t.Fatalf("viewer list: %d", w.Code)
	}
	if w := apiCall(s, viewer, "POST", "/api/v1/local-users", map[string]any{}, nil); w.Code != 403 {
		t.Fatalf("viewer mutation: %d", w.Code)
	}
	w := apiCall(s, admin, "GET", "/api/v1/local-users", nil, nil)
	var listing struct {
		Items []store.LocalUser `json:"items"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &listing) != nil || len(listing.Items) != 2 || !listing.Items[0].Builtin || listing.Items[0].ID != "local-admin" {
		t.Fatalf("list: %d %s", w.Code, w.Body.String())
	}
	for _, path := range []string{"/api/v1/local-users", "/api/v1/audit"} {
		w := apiCall(s, admin, "GET", path, nil, nil)
		for _, secret := range []string{"argon2", "password_hash", localUserFixturePassword} {
			if strings.Contains(w.Body.String(), secret) {
				t.Fatalf("secret in %s projection", path)
			}
		}
	}
	w = apiCall(s, viewer, "GET", "/api/v1/session", nil, nil)
	var info map[string]any
	if json.Unmarshal(w.Body.Bytes(), &info) != nil || info["local_password_change_enabled"] != true || info["local_users_enabled"] != false || info["local_password_change_required"] != false {
		t.Fatalf("viewer session capabilities: %s", w.Body.String())
	}
}

func TestLocalUsersRoleDisableReenableAndSessionRevocation(t *testing.T) {
	s, admin := localUsersFixture(t)
	u := createFixtureLocalUser(t, s, admin, "operator", true)
	who := localUserIdentity(t, s, u.Username, localUserFixturePassword)
	if w := apiCall(s, who, "GET", "/api/v1/local-users", nil, nil); w.Code != 200 {
		t.Fatal("new administrator has no management capability")
	}
	u.Admin = false
	next := updateFixtureLocalUser(t, s, admin, u)
	if next.Revision != u.Revision+1 {
		t.Fatal("revision was not incremented")
	}
	if w := apiCall(s, who, "GET", "/api/v1/local-users", nil, nil); w.Code != 401 {
		t.Fatalf("demotion left session alive: %d", w.Code)
	}
	who = localUserIdentity(t, s, u.Username, localUserFixturePassword)
	if w := apiCall(s, who, "GET", "/api/v1/local-users", nil, nil); w.Code != 403 {
		t.Fatalf("demoted user still admin: %d", w.Code)
	}
	stale := apiCall(s, admin, "PATCH", "/api/v1/local-users/"+u.ID, map[string]any{"name": u.Name, "admin": true, "disabled": false, "revision": u.Revision}, nil)
	if stale.Code != 409 {
		t.Fatalf("stale revision: %d", stale.Code)
	}
	next.Disabled = true
	next = updateFixtureLocalUser(t, s, admin, next)
	if w := apiCall(s, who, "GET", "/api/v1/help-state", nil, nil); w.Code != 401 {
		t.Fatalf("disabled session remains active: %d", w.Code)
	}
	unknown := localRequest(s, "missing-user", localUserFixturePassword)
	disabled := localRequest(s, u.Username, localUserFixturePassword)
	bad := localRequest(s, "admin", "bad")
	if disabled.Code != 401 || unknown.Code != 401 || disabled.Body.String() != unknown.Body.String() || disabled.Body.String() != bad.Body.String() {
		t.Fatal("login discloses missing/disabled user status")
	}
	next.Disabled = false
	_ = updateFixtureLocalUser(t, s, admin, next)
	_ = localUserIdentity(t, s, u.Username, localUserFixturePassword)
	// Simulate an old process/session that retained its cached admin bit. Every
	// request must consult the current row even without relying on DELETE sessions.
	staleAdmin := apiUser(t, s, u.ID, true)
	if w := apiCall(s, staleAdmin, "GET", "/api/v1/local-users", nil, nil); w.Code != 403 {
		t.Fatalf("cached admin privilege accepted: %d", w.Code)
	}
	if _, err := s.Store.Pool.Exec(context.Background(), "UPDATE local_users SET disabled=true WHERE id=$1", u.ID); err != nil {
		t.Fatal(err)
	}
	if w := apiCall(s, staleAdmin, "GET", "/api/v1/local-users", nil, nil); w.Code != 401 {
		t.Fatalf("current disabled flag ignored: %d", w.Code)
	}
	s.Config.LocalUsersEnabled = false
	r := httptest.NewRequest("GET", "/api/v1/session", nil)
	r.AddCookie(staleAdmin.cookie)
	if _, err := s.readSession(r); err == nil {
		t.Fatal("local session accepted with local users disabled")
	}
}

func TestLocalUsersOwnAndAdminPasswordChanges(t *testing.T) {
	s, admin := localUsersFixture(t)
	u := createFixtureLocalUser(t, s, admin, "reader", false)
	who := localUserIdentity(t, s, u.Username, localUserFixturePassword)
	own := func(identity apiIdentity, old, next string, headers map[string]string) *httptest.ResponseRecorder {
		return apiCall(s, identity, "POST", "/api/v1/local-users/me/password", map[string]string{"current_password": old, "new_password": next}, headers)
	}
	if w := own(admin, "admin", "fixture next password", nil); w.Code != 403 {
		t.Fatal("builtin bypassed its existing password endpoint")
	}
	for _, headers := range []map[string]string{{"Origin": "https://evil.invalid"}, {"X-CSRF-Token": "bad"}} {
		if w := own(who, localUserFixturePassword, "fixture next password", headers); w.Code != 403 {
			t.Fatal("own-password origin/CSRF not enforced")
		}
	}
	if w := own(who, "wrong", "fixture next password", nil); w.Code != 400 || !strings.Contains(w.Body.String(), "invalid_current_password") {
		t.Fatalf("wrong current: %d %s", w.Code, w.Body.String())
	}
	if w := own(who, localUserFixturePassword, "fixture next password", nil); w.Code != 204 {
		t.Fatalf("own change: %d %s", w.Code, w.Body.String())
	}
	if w := apiCall(s, who, "GET", "/api/v1/help-state", nil, nil); w.Code != 401 {
		t.Fatal("own password change did not revoke sessions")
	}
	if w := localRequest(s, u.Username, localUserFixturePassword); w.Code != 401 {
		t.Fatal("old password survived")
	}
	_ = localUserIdentity(t, s, u.Username, "fixture next password")
	u.Revision++
	who = localUserIdentity(t, s, u.Username, "fixture next password")
	w := apiCall(s, admin, "POST", "/api/v1/local-users/"+u.ID+"/password", map[string]any{"password": "admin reset password", "revision": u.Revision}, nil)
	if w.Code != 200 {
		t.Fatalf("admin reset: %d %s", w.Code, w.Body.String())
	}
	var updated store.LocalUser
	if err := json.Unmarshal(w.Body.Bytes(), &updated); err != nil || updated.Revision != u.Revision+1 {
		t.Fatal("reset did not update revision")
	}
	if w := apiCall(s, who, "GET", "/api/v1/help-state", nil, nil); w.Code != 401 {
		t.Fatal("admin password reset did not revoke sessions")
	}
	_ = localUserIdentity(t, s, u.Username, "admin reset password")
	w = apiCall(s, admin, "GET", "/api/v1/audit", nil, nil)
	if strings.Contains(w.Body.String(), "admin reset password") || strings.Contains(w.Body.String(), "fixture next password") || strings.Contains(w.Body.String(), "argon2") {
		t.Fatal("password material leaked into audit")
	}
}

func TestLocalUsersMutationAndAuditRollbackTogether(t *testing.T) {
	s, admin := localUsersFixture(t)
	u := createFixtureLocalUser(t, s, admin, "rollback", true)
	who := localUserIdentity(t, s, u.Username, localUserFixturePassword)
	_, err := s.Store.Pool.Exec(context.Background(), `CREATE FUNCTION reject_user_audit() RETURNS trigger AS $$ BEGIN IF NEW.body->>'kind' LIKE 'local_user.%' THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER reject_user_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_user_audit();`)
	if err != nil {
		t.Fatal(err)
	}
	w := apiCall(s, admin, "PATCH", "/api/v1/local-users/"+u.ID, map[string]any{"name": "Changed", "admin": false, "disabled": true, "revision": u.Revision}, nil)
	if w.Code != 500 {
		t.Fatalf("audit failure: %d", w.Code)
	}
	if w := apiCall(s, who, "GET", "/api/v1/local-users", nil, nil); w.Code != 200 {
		t.Fatal("audit failure partially changed role/status or revoked session")
	}
	w = apiCall(s, admin, "POST", "/api/v1/local-users", map[string]any{"username": "not-created", "name": "No", "admin": false, "password": localUserFixturePassword}, nil)
	if w.Code != 500 {
		t.Fatal("creation ignored audit failure")
	}
	var count int
	if err = s.Store.Pool.QueryRow(context.Background(), "SELECT count(*) FROM local_users WHERE username='not-created'").Scan(&count); err != nil || count != 0 {
		t.Fatal("failed audit left created user")
	}
	// Rechecking inside the transaction defeats an actor whose admin session
	// was valid before another process completed a demotion.
	if _, err = s.Store.Pool.Exec(context.Background(), "UPDATE local_users SET admin=false WHERE id=$1", u.ID); err != nil {
		t.Fatal(err)
	}
	_, err = s.Store.CreateLocalUser(context.Background(), model.User{ID: u.ID, Admin: true}, "forbidden", "Forbidden", localTestHash("any password"), false)
	if !errors.Is(err, store.ErrLocalUserForbidden) {
		t.Fatalf("stale actor mutated users: %v", err)
	}
	if _, err = s.Store.Pool.Exec(context.Background(), `DROP TRIGGER reject_user_audit ON audit_events;
CREATE FUNCTION reject_local_user_session_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'fixture deletion failure'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER reject_local_user_session_delete BEFORE DELETE ON sessions FOR EACH ROW EXECUTE FUNCTION reject_local_user_session_delete();`); err != nil {
		t.Fatal(err)
	}
	w = apiCall(s, admin, "POST", "/api/v1/local-users/"+u.ID+"/password", map[string]any{"password": "unpublished replacement", "revision": u.Revision}, nil)
	if w.Code != 500 {
		t.Fatalf("session revocation failure: %d %s", w.Code, w.Body.String())
	}
	var encoded string
	var revision int64
	if err = s.Store.Pool.QueryRow(context.Background(), "SELECT password_hash,revision FROM local_users WHERE id=$1", u.ID).Scan(&encoded, &revision); err != nil {
		t.Fatal(err)
	}
	old, err := parseLocalPasswordHash(encoded)
	if err != nil || !old.verify(localUserFixturePassword) || revision != u.Revision {
		t.Fatal("revocation failure published a new password or revision")
	}
	if w := apiCall(s, who, "GET", "/api/v1/help-state", nil, nil); w.Code != 200 {
		t.Fatal("failed revocation partially removed the existing session")
	}
}

func TestLocalUserOwnPasswordWrongCurrentIsRateLimited(t *testing.T) {
	s, admin := localUsersFixture(t)
	u := createFixtureLocalUser(t, s, admin, "rate-limited", false)
	who := localUserIdentity(t, s, u.Username, localUserFixturePassword)
	for attempt := 0; attempt < 6; attempt++ {
		w := apiCall(s, who, "POST", "/api/v1/local-users/me/password", map[string]string{"current_password": "wrong", "new_password": "fixture next password"}, nil)
		want := 400
		if attempt == 5 {
			want = 429
		}
		if w.Code != want {
			t.Fatalf("wrong current attempt%d: %d %s", attempt, w.Code, w.Body.String())
		}
	}
}

func TestLocalUserLoginRaceWithPasswordResetRevokesCreatedSession(t *testing.T) {
	s, admin := localUsersFixture(t)
	u := createFixtureLocalUser(t, s, admin, "race", false)
	started, release := make(chan struct{}), make(chan struct{})
	loginDone, resetDone := make(chan error, 1), make(chan error, 1)
	go func() {
		_, err := s.Store.LocalUserLogin(context.Background(), u.Username, hash("race-token"), "race-csrf", "", time.Now().Add(time.Hour), func(encoded string) (bool, error) { close(started); <-release; return true, nil })
		loginDone <- err
	}()
	<-started
	go func() {
		_, err := s.Store.ResetLocalUserPassword(context.Background(), model.User{ID: "local-admin", Admin: true}, u.ID, localTestHash("reset fixture password"), u.Revision)
		resetDone <- err
	}()
	// Wait until the second transaction actually blocks on the login row lock.
	deadline := time.Now().Add(3 * time.Second)
	blocked := false
	for time.Now().Before(deadline) {
		var count int
		err := s.Store.Pool.QueryRow(context.Background(), "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0 AND query LIKE '%local_users%FOR UPDATE%'").Scan(&count)
		if err != nil {
			close(release)
			t.Fatal(err)
		}
		if count > 0 {
			blocked = true
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	close(release)
	if err := <-loginDone; err != nil {
		t.Fatal(err)
	}
	if err := <-resetDone; err != nil {
		t.Fatal(err)
	}
	if !blocked {
		t.Fatal("test did not exercise overlapping row locks")
	}
	var count int
	if err := s.Store.Pool.QueryRow(context.Background(), "SELECT count(*) FROM sessions WHERE token_hash=$1", hash("race-token")).Scan(&count); err != nil || count != 0 {
		t.Fatal("concurrent old-password login survived reset")
	}
}

type localSessionQueryKey struct{}
type localSessionSnapshotTracer struct {
	afterSessionRead func()
}

func (tracer *localSessionSnapshotTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	return context.WithValue(ctx, localSessionQueryKey{}, data.SQL)
}
func (tracer *localSessionSnapshotTracer) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryEndData) {
	sql, _ := ctx.Value(localSessionQueryKey{}).(string)
	if tracer.afterSessionRead != nil && strings.Contains(sql, "FROM sessions ") && strings.Contains(sql, "token_hash=$1") {
		after := tracer.afterSessionRead
		tracer.afterSessionRead = nil
		after()
	}
}

func TestLocalUserSessionDoesNotCombineRevokedSessionWithLaterPromotion(t *testing.T) {
	s, admin := localUsersFixture(t)
	u := createFixtureLocalUser(t, s, admin, "snapshot", false)
	who := localUserIdentity(t, s, u.Username, localUserFixturePassword)
	base := s.Store.Pool
	tracer := &localSessionSnapshotTracer{}
	config := base.Config()
	config.ConnConfig.Tracer = tracer
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	s.Store.Pool = pool
	var mutationErr error
	tracer.afterSessionRead = func() {
		// Deterministically change the account after the session result has
		// been read. A second permissions query would wrongly elevate this
		// already-revoked request using the later account state.
		tx, e := base.Begin(context.Background())
		if e != nil {
			mutationErr = e
			return
		}
		defer tx.Rollback(context.Background())
		if _, e = tx.Exec(context.Background(), "UPDATE local_users SET admin=true,revision=revision+1 WHERE id=$1", u.ID); e == nil {
			_, e = tx.Exec(context.Background(), "DELETE FROM sessions WHERE user_id=$1", u.ID)
		}
		if e == nil {
			e = tx.Commit(context.Background())
		}
		mutationErr = e
	}
	w := apiCall(s, who, "GET", "/api/v1/local-users", nil, nil)
	if mutationErr != nil {
		t.Fatal(mutationErr)
	}
	if tracer.afterSessionRead != nil {
		t.Fatal("test did not intercept the session snapshot")
	}
	if w.Code != 403 {
		t.Fatalf("revoked session acquired a later admin role: %d %s", w.Code, w.Body.String())
	}
	if w := apiCall(s, who, "GET", "/api/v1/local-users", nil, nil); w.Code != 401 {
		t.Fatal("revoked session survived the next request")
	}
}

func TestLocalUserWritesDoNotWaitForWorkerSingletonLock(t *testing.T) {
	s, _ := localUsersFixture(t)
	lockContext, cancelLock := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelLock()
	workerConnection, err := s.Store.Pool.Acquire(lockContext)
	if err != nil {
		t.Fatal(err)
	}
	defer workerConnection.Release()
	// Reproduce the live worker's session-wide singleton lock on a dedicated
	// connection. It must remain held while every user mutation executes.
	if _, err = workerConnection.Exec(lockContext, "SELECT pg_advisory_lock(7398216)"); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = workerConnection.Exec(context.Background(), "SELECT pg_advisory_unlock(7398216)") }()
	// Bound lock waiting in PostgreSQL rather than treating the total duration
	// of four writes (including WAL flushes) as evidence of lock contention.
	config := s.Store.Pool.Config()
	config.ConnConfig.RuntimeParams["lock_timeout"] = "1s"
	mutationPool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(mutationPool.Close)
	mutations := &store.Store{Pool: mutationPool}
	mutationContext, cancelMutation := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancelMutation()
	// Negative control: the mutation pool must actually observe the held
	// singleton and fail on its lock timeout before testing independent writes.
	_, err = mutationPool.Exec(mutationContext, "SELECT pg_advisory_xact_lock(7398216)")
	var lockError *pgconn.PgError
	if !errors.As(err, &lockError) || lockError.Code != "55P03" {
		t.Fatalf("worker singleton control did not hit PostgreSQL lock timeout: %v", err)
	}
	actor := model.User{ID: "local-admin", Name: "Локальный администратор", Admin: true}
	initialHash, nextHash := localTestHash("fixture initial password"), localTestHash("fixture next password")
	u, err := mutations.CreateLocalUser(mutationContext, actor, "worker-independent", "Worker independent", initialHash, false)
	if err != nil {
		t.Fatalf("creation blocked by the worker singleton: %v", err)
	}
	u, err = mutations.UpdateLocalUser(mutationContext, actor, u.ID, "Worker independent changed", true, false, u.Revision)
	if err != nil {
		t.Fatalf("update blocked by the worker singleton: %v", err)
	}
	u, err = mutations.ResetLocalUserPassword(mutationContext, actor, u.ID, nextHash, u.Revision)
	if err != nil {
		t.Fatalf("password reset blocked by the worker singleton: %v", err)
	}
	if err = mutations.ChangeLocalUserPassword(mutationContext, u.ID, nextHash, initialHash, u.Revision); err != nil {
		t.Fatalf("own password change blocked by the worker singleton: %v", err)
	}
}

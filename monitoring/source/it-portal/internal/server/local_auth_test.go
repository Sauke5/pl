package server

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/argon2"
	"pl/portal/internal/store"
	"pl/portal/internal/store/sqlgen"
)

func localTestHash(password string) string {
	salt := []byte("fixture-salt-1234")
	key := argon2.IDKey([]byte(password), salt, 2, 32768, 1, 32)
	return "$argon2id$v=19$m=32768,t=2,p=1$" + base64.RawStdEncoding.EncodeToString(salt) + "$" + base64.RawStdEncoding.EncodeToString(key)
}

func TestGenerateLocalAdminPasswordHash(t *testing.T) {
	password := []byte("  fixture password with spaces  ")
	encoded, err := GenerateLocalAdminPasswordHash(password)
	if err != nil {
		t.Fatal(err)
	}
	h, err := parseLocalPasswordHash(encoded)
	if err != nil || !h.verify(string(password)) || h.verify(strings.TrimSpace(string(password))) {
		t.Fatal("generated PHC must verify exact password using existing login contract")
	}
	second, err := GenerateLocalAdminPasswordHash(password)
	if err != nil || encoded == second {
		t.Fatal("each password hash requires a fresh random salt")
	}
	for _, invalid := range [][]byte{nil, make([]byte, 1025)} {
		if encoded, err := GenerateLocalAdminPasswordHash(invalid); err == nil || encoded != "" {
			t.Fatal("invalid password length accepted")
		}
	}
}

func TestLocalPasswordHashValidation(t *testing.T) {
	good := localTestHash("correct fixture password")
	h, err := parseLocalPasswordHash(good)
	if err != nil || !h.verify("correct fixture password") || h.verify("wrong") {
		t.Fatal("password verification failed")
	}
	cases := []string{
		"", strings.Repeat("x", 513), strings.Replace(good, "argon2id", "argon2i", 1),
		strings.Replace(good, "v=19", "v=16", 1), strings.Replace(good, "m=32768", "m=999999999", 1),
		strings.Replace(good, "m=32768", "m=32767", 1), strings.Replace(good, "t=2", "t=0", 1),
		strings.Replace(good, "t=2", "t=5", 1), strings.Replace(good, "p=1", "p=0", 1),
		strings.Replace(good, "p=1", "p=200", 1), good + "=", good + "$extra",
		strings.Replace(good, "m=32768,t=2", "t=2,m=32768", 1),
	}
	for i, value := range cases {
		if _, err := parseLocalPasswordHash(value); err == nil {
			t.Errorf("accepted invalid hash case %d", i)
		}
	}
	path := filepath.Join(t.TempDir(), "hash")
	if err := os.WriteFile(path, []byte(good+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := ValidateLocalAdminHashFile(path); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(strings.Repeat("a", 513)), 0600); err != nil {
		t.Fatal(err)
	}
	if err := ValidateLocalAdminHashFile(path); err == nil {
		t.Fatal("oversized file accepted")
	}
	if err := ValidateLocalAdminHashFile(t.TempDir()); err == nil {
		t.Fatal("directory accepted")
	}
}

func localRequest(s *Server, username, password string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, "http://localhost/auth/local", strings.NewReader(fmt.Sprintf(`{"username":%q,"password":%q}`, username, password)))
	r.RemoteAddr = "192.0.2.10:45678"
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", "http://localhost")
	w := httptest.NewRecorder()
	s.localLogin(w, r)
	return w
}

func TestLocalLoginDisabledAndOrigin(t *testing.T) {
	s := &Server{Config: Config{PublicURL: "http://localhost"}}
	if w := localRequest(s, "portal-admin", "password"); w.Code != 404 {
		t.Fatalf("disabled: %d", w.Code)
	}
	s.Config.LocalAdminHashFile = "configured-but-not-read"
	r := httptest.NewRequest(http.MethodPost, "http://localhost/auth/local", strings.NewReader(`{}`))
	r.Header.Set("Origin", "https://attacker.invalid")
	w := httptest.NewRecorder()
	s.localLogin(w, r)
	if w.Code != 403 {
		t.Fatalf("cross-origin: %d", w.Code)
	}
	r = httptest.NewRequest(http.MethodPost, "http://localhost/auth/local", strings.NewReader(`{"password":"one"} {}`))
	r.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	s.localLogin(w, r)
	if w.Code != 400 {
		t.Fatalf("trailing JSON: %d", w.Code)
	}
}

func TestLocalPeerIgnoresForwardingHeaders(t *testing.T) {
	r := httptest.NewRequest("POST", "http://localhost/auth/local", nil)
	r.RemoteAddr = "[2001:db8::10]:4000"
	r.Header.Set("X-Forwarded-For", "192.0.2.99")
	r.Header.Set("Forwarded", "for=192.0.2.99")
	if got := localPeer(r); got != "2001:db8::10" {
		t.Fatalf("untrusted forwarding affected peer: %s", got)
	}
}

func localAuthTestStore(t *testing.T) *store.Store {
	t.Helper()
	dsn := os.Getenv("PORTAL_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("PORTAL_TEST_DATABASE_URL is required for PostgreSQL local-auth integration tests")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(admin.Close)
	// First-install extension DDL shares Store.Migrate's transaction lock.
	if err = func() error {
		tx, e := admin.Begin(ctx)
		if e != nil {
			return e
		}
		defer tx.Rollback(ctx)
		if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(7398215)"); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, "CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public"); e != nil {
			return e
		}
		return tx.Commit(ctx)
	}(); err != nil {
		t.Fatal(err)
	}
	schema := "local_auth_test_" + strings.ToLower(hash(randomToken())[:20])
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = admin.Exec(ctx, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE") })
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema + ",public"
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	db := &store.Store{Pool: pool, Q: sqlgen.New(pool)}
	if err = db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	return db
}

func TestLocalLoginSessionUniformFailureAndPersistentLimit(t *testing.T) {
	db := localAuthTestStore(t)
	path := filepath.Join(t.TempDir(), "hash")
	if err := os.WriteFile(path, []byte(localTestHash("fixture password")), 0600); err != nil {
		t.Fatal(err)
	}
	cfg := Config{PublicURL: "http://localhost", LocalAdminUsername: "portal-admin", LocalAdminHashFile: path, SessionLifetime: time.Hour}
	s := &Server{Store: db, Config: cfg}
	wrongUser := localRequest(s, "unknown-user", "fixture password")
	wrongPassword := localRequest(s, "portal-admin", "wrong password")
	if wrongUser.Code != 401 || wrongPassword.Code != 401 || wrongUser.Body.String() != wrongPassword.Body.String() {
		t.Fatal("unknown username and wrong password must have identical responses")
	}
	good := localRequest(s, "portal-admin", "fixture password")
	if good.Code != 200 {
		t.Fatalf("valid login: %d %s", good.Code, good.Body.String())
	}
	cookies := good.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != "portal_session" || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteLaxMode {
		t.Fatal("missing protected session cookie")
	}
	req := httptest.NewRequest("GET", "http://localhost/api/v1/session", nil)
	req.AddCookie(cookies[0])
	session, err := s.readSession(req)
	if err != nil || session.User.ID != "local-admin" || !session.User.Admin || session.CSRF == "" {
		t.Fatalf("session: %+v %v", session.User, err)
	}
	var audit int
	if err = db.Pool.QueryRow(context.Background(), "SELECT count(*) FROM audit_events WHERE body->>'actor'='local-admin' AND body->>'kind'='auth.login'").Scan(&audit); err != nil || audit != 1 {
		t.Fatalf("login audit: %d %v", audit, err)
	}
	// Successful login is refunded; one failed account attempt remains. Four more reach the limit.
	for i := 0; i < 4; i++ {
		if w := localRequest(s, "portal-admin", "wrong password"); w.Code != 401 {
			t.Fatalf("attempt %d: %d", i, w.Code)
		}
	}
	restarted := &Server{Store: db, Config: cfg}
	limited := localRequest(restarted, "portal-admin", "fixture password")
	if limited.Code != 429 || limited.Header().Get("Retry-After") == "" {
		t.Fatalf("persistent limiter: %d", limited.Code)
	}
	if _, err = db.Pool.Exec(context.Background(), "UPDATE local_login_attempts SET window_start=now()-interval '16 minutes'"); err != nil {
		t.Fatal(err)
	}
	if w := localRequest(restarted, "portal-admin", "fixture password"); w.Code != 200 {
		t.Fatalf("expired window: %d", w.Code)
	}
	restarted.Config.LocalAdminHashFile = filepath.Join(t.TempDir(), "missing")
	if w := localRequest(restarted, "portal-admin", "fixture password"); w.Code != 503 {
		t.Fatalf("hash failure must fail closed: %d", w.Code)
	}
	restarted.Config.LocalAdminHashFile = path
	db.Pool.Close()
	if w := localRequest(restarted, "portal-admin", "fixture password"); w.Code != 503 {
		t.Fatalf("database failure must fail closed: %d", w.Code)
	}
}

func TestLocalLoginLimiterConcurrentAndRotatingUsername(t *testing.T) {
	s := &Server{Store: localAuthTestStore(t)}
	var allowed atomic.Int32
	var failures atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ok, err := s.consumeLocalLoginAttempt(context.Background(), "192.0.2.20", "portal-admin")
			if err != nil {
				failures.Add(1)
			}
			if ok {
				allowed.Add(1)
			}
		}()
	}
	wg.Wait()
	if failures.Load() != 0 || allowed.Load() != 5 {
		t.Fatalf("atomic limiter: allowed=%d errors=%d", allowed.Load(), failures.Load())
	}
	for i := 0; i < 25; i++ {
		ok, err := s.consumeLocalLoginAttempt(context.Background(), "192.0.2.21", fmt.Sprintf("rotating-%d", i))
		if err != nil || ok != (i < 20) {
			t.Fatalf("IP limit at %d: allowed=%v err=%v", i, ok, err)
		}
	}
}

func TestLoginPeerTrustsOnlySingleRealIPFromConfiguredProxy(t *testing.T) {
	s := &Server{Config: Config{TrustedProxyCIDRs: []string{"172.21.0.0/16"}}}
	for _, tc := range []struct {
		name, peer string
		real       []string
		want       string
	}{{"untrusted forged header", "192.0.2.8:123", []string{"198.51.100.1"}, "192.0.2.8"}, {"trusted IPv4", "172.21.0.3:123", []string{"198.51.100.1"}, "198.51.100.1"}, {"trusted IPv6 client", "172.21.0.3:123", []string{"2001:db8::12"}, "2001:db8::12"}, {"multiple headers rejected", "172.21.0.3:123", []string{"198.51.100.1", "198.51.100.2"}, "172.21.0.3"}, {"chain rejected", "172.21.0.3:123", []string{"198.51.100.1, 198.51.100.2"}, "172.21.0.3"}, {"hostname rejected", "172.21.0.3:123", []string{"client.example.test"}, "172.21.0.3"}, {"absent header", "172.21.0.3:123", nil, "172.21.0.3"}} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "https://portal/auth/ad", nil)
			r.RemoteAddr = tc.peer
			r.Header.Set("X-Forwarded-For", "203.0.113.55")
			for _, ip := range tc.real {
				r.Header.Add("X-Real-IP", ip)
			}
			if got := s.loginPeer(r); got != tc.want {
				t.Fatal(got, tc.want)
			}
		})
	}
	s.Config.TrustedProxyCIDRs = nil
	r := httptest.NewRequest("POST", "https://portal/auth/local", nil)
	r.RemoteAddr = "172.21.0.3:123"
	r.Header.Set("X-Real-IP", "198.51.100.1")
	if got := s.loginPeer(r); got != "172.21.0.3" {
		t.Fatal("default trusted forwarded data", got)
	}
}
func TestLoginRefundPreservesConcurrentFailuresAndWindow(t *testing.T) {
	s := &Server{Store: localAuthTestStore(t)}
	ctx := context.Background()
	receipt, ok, e := s.reserveLoginAttempt(ctx, "ad:192.0.2.88", "user")
	if e != nil || !ok {
		t.Fatal(ok, e)
	}
	for n := 0; n < 2; n++ {
		if ok, e := s.consumeLocalLoginAttempt(ctx, "ad:192.0.2.88", "user"); e != nil || !ok {
			t.Fatal(ok, e)
		}
	}
	if e = s.refundLoginAttempt(ctx, receipt); e != nil {
		t.Fatal(e)
	}
	var attempts int
	if e = s.Store.Pool.QueryRow(ctx, "SELECT sum(attempts) FROM local_login_attempts").Scan(&attempts); e != nil || attempts != 4 {
		t.Fatal("successful attempt reset unrelated failures", attempts, e)
	}
	if _, e = s.Store.Pool.Exec(ctx, "UPDATE local_login_attempts SET window_start=now()-interval '16 minutes'"); e != nil {
		t.Fatal(e)
	}
	if ok, e = s.consumeLocalLoginAttempt(ctx, "ad:192.0.2.88", "user"); e != nil || !ok {
		t.Fatal(ok, e)
	}
	if e = s.refundLoginAttempt(ctx, receipt); e != nil {
		t.Fatal(e)
	}
	if e = s.Store.Pool.QueryRow(ctx, "SELECT sum(attempts) FROM local_login_attempts").Scan(&attempts); e != nil || attempts != 2 {
		t.Fatal("old receipt removed attempts from a new window", attempts, e)
	}
}
func TestTrustedProxyConfigRejectsMalformedCIDR(t *testing.T) {
	t.Setenv("PORTAL_TRUSTED_PROXY_CIDRS", "not-a-network")
	if _, e := LoadConfig(); e == nil || !strings.Contains(e.Error(), "PORTAL_TRUSTED_PROXY_CIDRS") {
		t.Fatal(e)
	}
}

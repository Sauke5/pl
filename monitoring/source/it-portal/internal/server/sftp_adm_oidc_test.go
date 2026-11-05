package server

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"pl/portal/internal/model"
)

type sftpIssuerFixture struct {
	o        *sftpAdminOIDC
	server   *httptest.Server
	mux      *http.ServeMux
	mu       sync.Mutex
	sessions map[string]session
	audits   atomic.Int32
}

func newSFTPIssuerFixture(t *testing.T) *sftpIssuerFixture {
	t.Helper()
	mux := http.NewServeMux()
	ts := httptest.NewTLSServer(mux)
	t.Cleanup(ts.Close)
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	keyFile := filepath.Join(dir, "signing.pem")
	secretFile := filepath.Join(dir, "client.secret")
	if err = os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(secretFile, []byte(strings.Repeat("test-only-secret-", 3)), 0600); err != nil {
		t.Fatal(err)
	}
	s := &Server{Config: Config{PublicURL: ts.URL}}
	o, err := newSFTPAdminOIDC(s, SFTPAdminOIDCConfig{Issuer: ts.URL + sftpAdminIssuerPath, ClientID: "pl-sftp-adm", ClientSecretFile: secretFile, SigningKeyFile: keyFile, RedirectURL: ts.URL + "/sftp-adm/web/oidc/redirect"})
	if err != nil {
		t.Fatal(err)
	}
	f := &sftpIssuerFixture{o: o, server: ts, mux: mux, sessions: map[string]session{}}
	o.lookup = func(_ context.Context, key string) (session, error) {
		f.mu.Lock()
		defer f.mu.Unlock()
		s, ok := f.sessions[key]
		if !ok {
			return session{}, errors.New("not found")
		}
		return s, nil
	}
	o.audit = func(context.Context, sftpAdminGrant) error { f.audits.Add(1); return nil }
	o.registerRoutes(mux)
	return f
}
func (f *sftpIssuerFixture) user(id string, admin bool) *http.Cookie {
	token := "fixture-session-" + id
	f.mu.Lock()
	f.sessions[hash(token)] = session{User: model.User{ID: id, Name: "Person " + id, Admin: admin}, CSRF: "csrf-" + id, ExpiresAt: time.Now().Add(time.Hour)}
	f.mu.Unlock()
	return &http.Cookie{Name: "portal_session", Value: token}
}
func (f *sftpIssuerFixture) launch(t *testing.T, cookie *http.Cookie, mode string) *http.Cookie {
	t.Helper()
	r := httptest.NewRequest("GET", f.server.URL+"/sftp-adm/open/"+mode, nil)
	r.AddCookie(cookie)
	r.Header.Set("Sec-Fetch-Site", "same-origin")
	w := httptest.NewRecorder()
	id := strings.TrimPrefix(cookie.Value, "fixture-session-")
	if err := f.o.beginFlow(w, r, mode, sftpAdminNativeUsername(id)); err != nil {
		t.Fatal(err)
	}
	for _, c := range w.Result().Cookies() {
		if c.Name == sftpAdminFlowCookie {
			if !c.Secure || !c.HttpOnly || c.Path != sftpAdminIssuerPath || c.SameSite != http.SameSiteLaxMode {
				t.Fatal("unprotected flow cookie")
			}
			return c
		}
	}
	t.Fatal("missing flow cookie")
	return nil
}
func (f *sftpIssuerFixture) query() url.Values {
	return url.Values{"client_id": {f.o.config.ClientID}, "redirect_uri": {f.o.config.RedirectURL}, "response_type": {"code"}, "scope": {"openid profile"}, "state": {"native-state"}, "nonce": {"native-nonce"}}
}
func (f *sftpIssuerFixture) authorize(cookie, flow *http.Cookie, q url.Values) *httptest.ResponseRecorder {
	r := httptest.NewRequest("GET", f.o.config.Issuer+"/authorize?"+q.Encode(), nil)
	if cookie != nil {
		r.AddCookie(cookie)
	}
	if flow != nil {
		r.AddCookie(flow)
	}
	r.Header.Set("Sec-Fetch-Site", "same-origin")
	w := httptest.NewRecorder()
	f.mux.ServeHTTP(w, r)
	return w
}
func (f *sftpIssuerFixture) code(t *testing.T, cookie *http.Cookie, mode string, pkce string) string {
	t.Helper()
	flow := f.launch(t, cookie, mode)
	q := f.query()
	if pkce != "" {
		d := sha256.Sum256([]byte(pkce))
		q.Set("code_challenge", base64.RawURLEncoding.EncodeToString(d[:]))
		q.Set("code_challenge_method", "S256")
	}
	w := f.authorize(cookie, flow, q)
	if w.Code != 302 {
		t.Fatalf("authorize:%d %s", w.Code, w.Body.String())
	}
	u, err := url.Parse(w.Header().Get("Location"))
	if err != nil || u.Scheme+"://"+u.Host+u.Path != f.o.config.RedirectURL || u.Query().Get("state") != "native-state" {
		t.Fatalf("unsafe redirect:%s", w.Header().Get("Location"))
	}
	return u.Query().Get("code")
}
func (f *sftpIssuerFixture) exchange(code, verifier, secret string) *httptest.ResponseRecorder {
	q := url.Values{"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {f.o.config.RedirectURL}}
	if verifier != "" {
		q.Set("code_verifier", verifier)
	}
	r := httptest.NewRequest("POST", f.o.config.Issuer+"/token", strings.NewReader(q.Encode()))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	r.SetBasicAuth(url.QueryEscape(f.o.config.ClientID), url.QueryEscape(secret))
	w := httptest.NewRecorder()
	f.mux.ServeHTTP(w, r)
	return w
}
func (f *sftpIssuerFixture) verifiedClaims(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	if w.Code != 200 {
		t.Fatalf("token:%d %s", w.Code, w.Body.String())
	}
	var response struct {
		IDToken      string `json:"id_token"`
		RefreshToken string `json:"refresh_token"`
		Expires      int    `json:"expires_in"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.RefreshToken != "" || response.Expires < 1 || response.Expires > 86400 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("invalid token lifetime/cache policy")
	}
	ctx := oidc.ClientContext(context.Background(), f.server.Client())
	provider, err := oidc.NewProvider(ctx, f.o.config.Issuer)
	if err != nil {
		t.Fatal(err)
	}
	token, err := provider.Verifier(&oidc.Config{ClientID: f.o.config.ClientID}).Verify(ctx, response.IDToken)
	if err != nil {
		t.Fatal(err)
	}
	var claims map[string]any
	if err = token.Claims(&claims); err != nil {
		t.Fatal(err)
	}
	if token.Nonce != "native-nonce" {
		t.Fatal("nonce not preserved")
	}
	return claims
}

func TestSFTPAdminOIDCTokenNeverOutlivesOriginalSession(t *testing.T) {
	f := newSFTPIssuerFixture(t)
	for _, lifetime := range []time.Duration{45 * time.Second, 20 * time.Minute, 90 * time.Minute, 30 * time.Hour} {
		cookie := f.user("alice", true)
		sessionExpiry := time.Now().Add(lifetime)
		f.mu.Lock()
		sess := f.sessions[hash(cookie.Value)]
		sess.ExpiresAt = sessionExpiry
		f.sessions[hash(cookie.Value)] = sess
		f.mu.Unlock()
		started := time.Now()
		code := f.code(t, cookie, "admin", "")
		claims := f.verifiedClaims(t, f.exchange(code, "", f.o.secret))
		expires := time.Unix(int64(claims["exp"].(float64)), 0)
		if expires.After(sessionExpiry) || expires.After(time.Now().Add(24*time.Hour)) {
			t.Fatalf("token outlives original session or hard cap: lifetime=%s exp=%s session=%s", lifetime, expires, sessionExpiry)
		}
		if lifetime < 24*time.Hour && expires.Unix() != sessionExpiry.Unix() {
			t.Fatalf("token unexpectedly cuts valid Portal session short: %s", lifetime)
		}
		if lifetime >= 20*time.Minute && !expires.After(started.Add(6*time.Minute)) {
			t.Fatal("native AJAX token expires during an otherwise valid Portal session")
		}
	}
}
func TestSFTPAdminOIDCIssuesVerifiedPerUserTokensAndConsumesCode(t *testing.T) {
	f := newSFTPIssuerFixture(t)
	for _, entry := range []struct {
		id, mode, role string
		admin          bool
	}{{"alice", "admin", "admin", true}, {"alice", "files", "user", true}, {"bob", "files", "user", false}} {
		cookie := f.user(entry.id, entry.admin)
		code := f.code(t, cookie, entry.mode, "")
		w := f.exchange(code, "", f.o.secret)
		claims := f.verifiedClaims(t, w)
		if claims["sub"] != entry.id || claims["preferred_username"] != sftpAdminNativeUsername(entry.id) || claims["name"] != "Person "+entry.id || claims["sftp_role"] != entry.role {
			t.Fatalf("wrong identity:%v", claims)
		}
		if w = f.exchange(code, "", f.o.secret); w.Code != 400 {
			t.Fatalf("code replay:%d", w.Code)
		}
	}
	if f.audits.Load() != 3 {
		t.Fatal("missing per-login audit")
	}
}
func TestSFTPAdminOIDCSessionBindingRevocationAndDemotion(t *testing.T) {
	f := newSFTPIssuerFixture(t)
	a := f.user("alice", true)
	b := f.user("bob", false)
	flow := f.launch(t, a, "admin")
	if w := f.authorize(b, flow, f.query()); w.Code != 403 {
		t.Fatalf("session A→B accepted:%d", w.Code)
	}
	w := f.authorize(a, flow, f.query())
	if w.Code != 302 {
		t.Fatalf("original flow consumed by other browser:%d", w.Code)
	}
	u, _ := url.Parse(w.Header().Get("Location"))
	code := u.Query().Get("code")
	f.mu.Lock()
	sess := f.sessions[hash(a.Value)]
	sess.User.Admin = false
	f.sessions[hash(a.Value)] = sess
	f.mu.Unlock()
	if w = f.exchange(code, "", f.o.secret); w.Code != 400 {
		t.Fatal("demoted administrator accepted")
	}
	for _, change := range []string{"delete", "expire", "subject"} {
		a = f.user("alice", true)
		code = f.code(t, a, "files", "")
		f.mu.Lock()
		sess = f.sessions[hash(a.Value)]
		switch change {
		case "delete":
			delete(f.sessions, hash(a.Value))
		case "expire":
			sess.ExpiresAt = time.Now().Add(-time.Second)
			f.sessions[hash(a.Value)] = sess
		case "subject":
			sess.User.ID = "bob"
			f.sessions[hash(a.Value)] = sess
		}
		f.mu.Unlock()
		if w = f.exchange(code, "", f.o.secret); w.Code != 400 {
			t.Fatalf("%s accepted:%d", change, w.Code)
		}
	}
	if f.audits.Load() != 0 {
		t.Fatal("failed exchange created login audit")
	}
}
func TestSFTPAdminOIDCRejectsUnboundAndCrossSiteFlows(t *testing.T) {
	f := newSFTPIssuerFixture(t)
	viewer := f.user("viewer", false)
	for _, entry := range []struct{ mode, username, origin, site string }{{"admin", sftpAdminNativeUsername("viewer"), "", ""}, {"files", "portal-provisioner", "", ""}, {"files", sftpAdminNativeUsername("viewer"), "https://attacker.test", ""}, {"files", sftpAdminNativeUsername("viewer"), "", "cross-site"}} {
		r := httptest.NewRequest("GET", f.server.URL+"/sftp-adm/open/files", nil)
		r.AddCookie(viewer)
		r.Header.Set("Origin", entry.origin)
		r.Header.Set("Sec-Fetch-Site", entry.site)
		if err := f.o.beginFlow(httptest.NewRecorder(), r, entry.mode, entry.username); err == nil {
			t.Fatalf("unsafe flow accepted:%+v", entry)
		}
	}
	if w := f.authorize(viewer, nil, f.query()); w.Code != 400 {
		t.Fatal("unbound authorize accepted")
	}
	flow := f.launch(t, viewer, "files")
	r := httptest.NewRequest("GET", f.o.config.Issuer+"/authorize?"+f.query().Encode(), nil)
	r.AddCookie(viewer)
	r.AddCookie(flow)
	r.AddCookie(&http.Cookie{Name: "portal_session", Value: "another"})
	w := httptest.NewRecorder()
	f.mux.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal("ambiguous session accepted")
	}
	r = httptest.NewRequest("GET", f.o.config.Issuer+"/authorize?"+f.query().Encode(), nil)
	r.AddCookie(viewer)
	r.AddCookie(flow)
	r.Header.Set("Origin", "https://attacker.test")
	w = httptest.NewRecorder()
	f.mux.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("cross origin authorize accepted")
	}
}
func TestSFTPAdminOIDCRejectsClientRedirectScopeAndParameterConfusion(t *testing.T) {
	f := newSFTPIssuerFixture(t)
	cookie := f.user("alice", true)
	flow := f.launch(t, cookie, "admin")
	for _, entry := range []struct{ field, value string }{{"client_id", "other"}, {"redirect_uri", "https://attacker.test/callback"}, {"response_type", "token"}, {"scope", "openid email"}, {"nonce", ""}, {"state", ""}, {"code_challenge_method", "plain"}} {
		q := f.query()
		q.Set(entry.field, entry.value)
		w := f.authorize(cookie, flow, q)
		if w.Code != 400 || w.Header().Get("Location") != "" {
			t.Fatalf("%s accepted or redirected:%d", entry.field, w.Code)
		}
	}
	q := f.query()
	q.Add("redirect_uri", f.o.config.RedirectURL)
	if w := f.authorize(cookie, flow, q); w.Code != 400 {
		t.Fatal("duplicate callback accepted")
	}
	code := f.code(t, cookie, "admin", "")
	if w := f.exchange(code, "", "wrong-secret"); w.Code != 401 {
		t.Fatal("wrong secret accepted")
	}
	if w := f.exchange(code, "", f.o.secret); w.Code != 200 {
		t.Fatalf("bad client consumed code:%d", w.Code)
	}
	for _, q := range []url.Values{{"grant_type": {"refresh_token"}, "code": {"unused"}, "redirect_uri": {f.o.config.RedirectURL}}, {"grant_type": {"authorization_code"}, "code": {"unused"}, "redirect_uri": {f.o.config.RedirectURL}, "client_id": {"evil"}}, {"grant_type": {"authorization_code"}, "code": {"unused", "unused"}, "redirect_uri": {f.o.config.RedirectURL}}} {
		r := httptest.NewRequest("POST", f.o.config.Issuer+"/token", strings.NewReader(q.Encode()))
		r.SetBasicAuth(f.o.config.ClientID, f.o.secret)
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		w := httptest.NewRecorder()
		f.mux.ServeHTTP(w, r)
		if w.Code != 400 {
			t.Fatal("invalid OAuth form accepted")
		}
	}
}
func TestSFTPAdminOIDCOptionalPKCEAndConcurrentReplay(t *testing.T) {
	f := newSFTPIssuerFixture(t)
	cookie := f.user("alice", true)
	verifier := strings.Repeat("a", 50)
	code := f.code(t, cookie, "admin", verifier)
	if w := f.exchange(code, "wrong", f.o.secret); w.Code != 400 {
		t.Fatal("wrong PKCE accepted")
	}
	code = f.code(t, cookie, "admin", verifier)
	f.verifiedClaims(t, f.exchange(code, verifier, f.o.secret))
	code = f.code(t, cookie, "files", "")
	var successes atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w := f.exchange(code, "", f.o.secret)
			if w.Code == 200 {
				successes.Add(1)
			} else if w.Code != 400 {
				t.Errorf("unexpected concurrent exchange:%d", w.Code)
			}
		}()
	}
	wg.Wait()
	if successes.Load() != 1 {
		t.Fatalf("code consumed %d times", successes.Load())
	}
}
func TestSFTPAdminOIDCExpiryCapacityAuditAndCredentialGuards(t *testing.T) {
	f := newSFTPIssuerFixture(t)
	cookie := f.user("alice", true)
	code := f.code(t, cookie, "admin", "")
	f.o.mu.Lock()
	g := f.o.codes[hash(code)]
	g.expires = time.Now().Add(-time.Second)
	f.o.codes[hash(code)] = g
	f.o.mu.Unlock()
	if w := f.exchange(code, "", f.o.secret); w.Code != 400 {
		t.Fatal("expired code accepted")
	}
	code = f.code(t, cookie, "files", "")
	f.o.audit = func(context.Context, sftpAdminGrant) error { return errors.New("unavailable") }
	if w := f.exchange(code, "", f.o.secret); w.Code != 503 {
		t.Fatal("login issued without audit")
	}
	f.o.mu.Lock()
	for i := 0; i < sftpAdminPendingMax; i++ {
		f.o.codes[string(rune(i))] = sftpAdminGrant{expires: time.Now().Add(time.Minute)}
	}
	f.o.mu.Unlock()
	r := httptest.NewRequest("GET", f.server.URL+"/sftp-adm/open/files", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	if err := f.o.beginFlow(w, r, "files", sftpAdminNativeUsername("alice")); err == nil || len(w.Result().Cookies()) != 0 {
		t.Fatal("capacity overflow admitted")
	}
	c := f.o.config
	c.RedirectURL = "https://attacker.test"
	if _, err := newSFTPAdminOIDC(f.o.server, c); err == nil {
		t.Fatal("arbitrary callback configured")
	}
	c = f.o.config
	if err := os.Chmod(c.ClientSecretFile, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := newSFTPAdminOIDC(f.o.server, c); err == nil {
		t.Fatal("world-readable secret accepted")
	}
}

func TestSFTPAdminOIDCRealPortalSessionRevocationAndAudit(t *testing.T) {
	db := localAuthTestStore(t)
	f := newSFTPIssuerFixture(t)
	f.o.server.Store = db
	live, err := newSFTPAdminOIDC(f.o.server, f.o.config)
	if err != nil {
		t.Fatal(err)
	}
	f.o.lookup = live.lookup
	f.o.audit = live.audit
	launch := func() string {
		loginReq := httptest.NewRequest("POST", f.server.URL+"/test-session", nil)
		loginW := httptest.NewRecorder()
		if err := f.o.server.newSession(loginW, loginReq, model.User{ID: "ad:live-person", Name: "Живой пользователь", Admin: true}, time.Now().Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
		cookie := loginW.Result().Cookies()[0]
		r := httptest.NewRequest("GET", f.server.URL+"/sftp-adm/open/admin", nil)
		r.AddCookie(cookie)
		w := httptest.NewRecorder()
		if err := f.o.beginFlow(w, r, "admin", sftpAdminNativeUsername("ad:live-person")); err != nil {
			t.Fatal(err)
		}
		flow := w.Result().Cookies()[0]
		response := f.authorize(cookie, flow, f.query())
		if response.Code != 302 {
			t.Fatalf("live authorize:%d %s", response.Code, response.Body.String())
		}
		callback, _ := url.Parse(response.Header().Get("Location"))
		return callback.Query().Get("code")
	}
	code := launch()
	f.verifiedClaims(t, f.exchange(code, "", f.o.secret))
	var count int
	if err := db.Pool.QueryRow(context.Background(), "SELECT count(*) FROM audit_events WHERE body->>'kind'='sftp.adm.login' AND body->>'actor'='ad:live-person'").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("expected persisted per-user login audit, got %d", count)
	}
	code = launch()
	if _, err := db.Pool.Exec(context.Background(), "DELETE FROM sessions WHERE user_id=$1", "ad:live-person"); err != nil {
		t.Fatal(err)
	}
	if w := f.exchange(code, "", f.o.secret); w.Code != 400 {
		t.Fatalf("real revoked session accepted:%d", w.Code)
	}
}

func TestSFTPAdminOIDCRFCClientAuthAndBoundedRequests(t *testing.T) {
	f := newSFTPIssuerFixture(t)
	cookie := f.user("alice", true)
	f.o.secret = "test-only-client-secret-with-plus+slash/percent%and-equals="
	code := f.code(t, cookie, "files", "")
	f.verifiedClaims(t, f.exchange(code, "", f.o.secret))
	code = f.code(t, cookie, "files", "")
	q := url.Values{"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {f.o.config.RedirectURL}}
	for _, mediaType := range []string{"application/x-www-form-urlencodedevil", "application/json", "application/x-www-form-urlencoded; broken"} {
		r := httptest.NewRequest("POST", f.o.config.Issuer+"/token", strings.NewReader(q.Encode()))
		r.SetBasicAuth(url.QueryEscape(f.o.config.ClientID), url.QueryEscape(f.o.secret))
		r.Header.Set("Content-Type", mediaType)
		w := httptest.NewRecorder()
		f.mux.ServeHTTP(w, r)
		if w.Code != 400 {
			t.Fatalf("invalid media type accepted:%q", mediaType)
		}
	}
	r := httptest.NewRequest("POST", f.o.config.Issuer+"/token", strings.NewReader(strings.Repeat("a", 9000)))
	r.SetBasicAuth(url.QueryEscape(f.o.config.ClientID), url.QueryEscape(f.o.secret))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w := httptest.NewRecorder()
	f.mux.ServeHTTP(w, r)
	if w.Code != 400 {
		t.Fatal("oversize body accepted")
	}
	f.verifiedClaims(t, f.exchange(code, "", f.o.secret))
	for _, path := range []string{"/.well-known/openid-configuration", "/jwks"} {
		r := httptest.NewRequest("GET", f.o.config.Issuer+path, nil)
		w := httptest.NewRecorder()
		f.mux.ServeHTTP(w, r)
		if w.Code != 200 || strings.Contains(w.Body.String(), f.o.secret) || strings.Contains(w.Body.String(), "PRIVATE KEY") || strings.Contains(w.Body.String(), "\"d\":") {
			t.Fatal("public metadata exposed private material")
		}
	}
}

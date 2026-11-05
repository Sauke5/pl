package server

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// This issuer implements discovery, JWKS and a single-use authorization code exchange.
// Tests exercise the production verifier and OAuth client, not a replacement token verifier.
type fixtureCode struct{ nonce, challenge, redirect string }
type oidcFixture struct {
	server           *httptest.Server
	client           *http.Client
	key              *rsa.PrivateKey
	mu               sync.Mutex
	codes            map[string]fixtureCode
	mutate           func(map[string]any)
	corruptSignature bool
	tokenCalls       int
}

func newOIDCFixture(t *testing.T) *oidcFixture {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	f := &oidcFixture{key: key, codes: map[string]fixtureCode{}}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		respond(w, 200, map[string]any{"issuer": f.server.URL, "authorization_endpoint": f.server.URL + "/authorize", "token_endpoint": f.server.URL + "/token", "jwks_uri": f.server.URL + "/jwks", "response_types_supported": []string{"code"}, "subject_types_supported": []string{"public"}, "id_token_signing_alg_values_supported": []string{"RS256"}, "token_endpoint_auth_methods_supported": []string{"client_secret_basic"}, "code_challenge_methods_supported": []string{"S256"}})
	})
	mux.HandleFunc("GET /jwks", func(w http.ResponseWriter, r *http.Request) {
		respond(w, 200, map[string]any{"keys": []map[string]any{{"kty": "RSA", "use": "sig", "kid": "fixture-key", "alg": "RS256", "n": base64.RawURLEncoding.EncodeToString(key.PublicKey.N.Bytes()), "e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.PublicKey.E)).Bytes())}}})
	})
	mux.HandleFunc("GET /authorize", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("client_id") != "fixture-client" || q.Get("response_type") != "code" || q.Get("code_challenge_method") != "S256" || q.Get("state") == "" || q.Get("nonce") == "" || q.Get("code_challenge") == "" {
			problem(w, 400, "bad_authorization", "missing client/state/nonce/PKCE")
			return
		}
		code := randomToken()
		f.mu.Lock()
		f.codes[code] = fixtureCode{q.Get("nonce"), q.Get("code_challenge"), q.Get("redirect_uri")}
		f.mu.Unlock()
		redirect, err := url.Parse(q.Get("redirect_uri"))
		if err != nil {
			w.WriteHeader(400)
			return
		}
		values := redirect.Query()
		values.Set("state", q.Get("state"))
		values.Set("code", code)
		redirect.RawQuery = values.Encode()
		http.Redirect(w, r, redirect.String(), 302)
	})
	mux.HandleFunc("POST /token", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.tokenCalls++
		if err := r.ParseForm(); err != nil {
			w.WriteHeader(400)
			return
		}
		id, secret, ok := r.BasicAuth()
		if !ok || id != "fixture-client" || secret != "fixture-secret" || r.Form.Get("grant_type") != "authorization_code" {
			problem(w, 401, "invalid_client", "invalid client")
			return
		}
		code, ok := f.codes[r.Form.Get("code")]
		delete(f.codes, r.Form.Get("code"))
		challenge := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
		if !ok || code.challenge != base64.RawURLEncoding.EncodeToString(challenge[:]) || code.redirect != r.Form.Get("redirect_uri") {
			problem(w, 400, "invalid_grant", "invalid code or PKCE")
			return
		}
		claims := map[string]any{"iss": f.server.URL, "sub": "person-123", "aud": "fixture-client", "exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(), "nonce": code.nonce, "name": "Fixture person", "groups": []any{"/IT/Portal"}}
		if f.mutate != nil {
			f.mutate(claims)
		}
		header, _ := json.Marshal(map[string]string{"alg": "RS256", "kid": "fixture-key", "typ": "JWT"})
		body, _ := json.Marshal(claims)
		encoded := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(body)
		digest := sha256.Sum256([]byte(encoded))
		sig, err := rsa.SignPKCS1v15(rand.Reader, f.key, crypto.SHA256, digest[:])
		if err != nil {
			w.WriteHeader(500)
			return
		}
		if f.corruptSignature {
			sig[0] ^= 1
		}
		respond(w, 200, map[string]any{"access_token": "fixture-access-token", "token_type": "Bearer", "expires_in": 3600, "id_token": encoded + "." + base64.RawURLEncoding.EncodeToString(sig)})
	})
	f.server = httptest.NewTLSServer(mux)
	f.client = f.server.Client()
	f.client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	t.Cleanup(f.server.Close)
	return f
}
func oidcPortal(t *testing.T, f *oidcFixture) *Server {
	s := apiFixture(t)
	s.Config.Issuer = f.server.URL
	s.Config.ClientID = "fixture-client"
	s.Config.ClientSecret = "fixture-secret"
	s.Config.GroupClaim = "groups"
	s.Config.AllowedGroup = "/IT/Portal"
	s.oidcClient = f.client
	return s
}
func oidcBegin(t *testing.T, s *Server, f *oidcFixture) (string, *http.Cookie) {
	t.Helper()
	w := apiCall(s, apiIdentity{}, "GET", "/auth/login", nil, nil)
	if w.Code != 302 {
		t.Fatalf("login redirect:%d %s", w.Code, w.Body.String())
	}
	var browser *http.Cookie
	for _, c := range w.Result().Cookies() {
		if c.Name == "portal_login" {
			browser = c
		}
	}
	if browser == nil || !browser.HttpOnly || !browser.Secure {
		t.Fatal("missing protected browser binding cookie")
	}
	response, err := f.client.Get(w.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 302 {
		t.Fatalf("fixture rejected authorize:%d", response.StatusCode)
	}
	return response.Header.Get("Location"), browser
}
func oidcCallback(s *Server, location string, browser *http.Cookie) *httptest.ResponseRecorder {
	r := httptest.NewRequest("GET", location, nil)
	if browser != nil {
		r.AddCookie(browser)
	}
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	return w
}
func oidcIdentity(t *testing.T, s *Server, w *httptest.ResponseRecorder) apiIdentity {
	t.Helper()
	if w.Code != 303 {
		t.Fatalf("callback failed:%d %s", w.Code, w.Body.String())
	}
	var cookie *http.Cookie
	for _, c := range w.Result().Cookies() {
		if c.Name == "portal_session" {
			cookie = c
		}
	}
	if cookie == nil {
		t.Fatal("callback missing session cookie")
	}
	r := httptest.NewRequest("GET", s.Config.PublicURL+"/api/v1/session", nil)
	r.AddCookie(cookie)
	sess, err := s.readSession(r)
	if err != nil {
		t.Fatal(err)
	}
	return apiIdentity{cookie, sess.CSRF}
}

func TestOIDCAuthorizationCodeGroupAndBrowserBinding(t *testing.T) {
	f := newOIDCFixture(t)
	s := oidcPortal(t, f)
	location, browser := oidcBegin(t, s, f)
	// Wrong browser must not consume the legitimate pending authorization state.
	if w := oidcCallback(s, location, &http.Cookie{Name: "portal_login", Value: "other-browser"}); w.Code != 400 {
		t.Fatalf("wrong browser accepted:%d", w.Code)
	}
	who := oidcIdentity(t, s, oidcCallback(s, location, browser))
	state := apiDecode[struct {
		Authenticated bool `json:"authenticated"`
		User          struct {
			ID    string `json:"id"`
			Admin bool   `json:"admin"`
		} `json:"user"`
	}](t, apiCall(s, who, "GET", "/api/v1/session", nil, nil), 200)
	if !state.Authenticated || !state.User.Admin || state.User.ID != hash(f.server.URL+"\x00person-123") {
		t.Fatalf("admin group/subject identity: %+v", state)
	}
	if w := apiCall(s, who, "GET", "/api/v1/resources", nil, nil); w.Code != 200 {
		t.Fatalf("admin access:%d", w.Code)
	}
	if w := oidcCallback(s, location, browser); w.Code != 400 {
		t.Fatalf("callback replay accepted:%d", w.Code)
	}
	f.mu.Lock()
	calls := f.tokenCalls
	f.mu.Unlock()
	if calls != 1 {
		t.Fatalf("wrong browser/replay triggered token exchange: %d", calls)
	}
	f.mu.Lock()
	f.mutate = func(c map[string]any) { c["groups"] = []any{"/Other"} }
	f.mu.Unlock()
	location, browser = oidcBegin(t, s, f)
	viewer := oidcIdentity(t, s, oidcCallback(s, location, browser))
	if w := apiCall(s, viewer, "GET", "/api/v1/resources", nil, nil); w.Code != 403 {
		t.Fatalf("nonmember admin access:%d", w.Code)
	}
}

func TestOIDCRejectsInvalidTokenClaimsAndSignature(t *testing.T) {
	f := newOIDCFixture(t)
	s := oidcPortal(t, f)
	tests := []struct {
		name    string
		mutate  func(map[string]any)
		corrupt bool
	}{
		{"nonce", func(c map[string]any) { c["nonce"] = "other-nonce" }, false},
		{"missing_nonce", func(c map[string]any) { delete(c, "nonce") }, false},
		{"audience", func(c map[string]any) { c["aud"] = "other-client" }, false},
		{"issuer", func(c map[string]any) { c["iss"] = "https://other-issuer.invalid" }, false},
		{"expired", func(c map[string]any) { c["exp"] = time.Now().Add(-time.Hour).Unix() }, false},
		{"empty_subject", func(c map[string]any) { c["sub"] = "" }, false},
		{"signature", nil, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f.mu.Lock()
			f.mutate = tc.mutate
			f.corruptSignature = tc.corrupt
			f.mu.Unlock()
			location, browser := oidcBegin(t, s, f)
			w := oidcCallback(s, location, browser)
			if w.Code != 401 {
				t.Fatalf("invalid token accepted:%d %s", w.Code, w.Body.String())
			}
			for _, c := range w.Result().Cookies() {
				if c.Name == "portal_session" {
					t.Fatal("invalid token created session")
				}
			}
			if replay := oidcCallback(s, location, browser); replay.Code != 400 {
				t.Fatal("invalid callback state reusable")
			}
		})
	}
}

func TestOIDCMalformedAndMissingGroupsNeverGrantAdmin(t *testing.T) {
	f := newOIDCFixture(t)
	s := oidcPortal(t, f)
	for i, groups := range []any{nil, "/IT/Portal", true, []any{"/IT/Portal", false}, map[string]any{"/IT/Portal": true}} {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			f.mu.Lock()
			f.mutate = func(c map[string]any) {
				if groups == nil {
					delete(c, "groups")
				} else {
					c["groups"] = groups
				}
			}
			f.mu.Unlock()
			location, browser := oidcBegin(t, s, f)
			who := oidcIdentity(t, s, oidcCallback(s, location, browser))
			if w := apiCall(s, who, "GET", "/api/v1/settings", nil, nil); w.Code != 403 {
				t.Fatalf("malformed groups granted admin:%d", w.Code)
			}
		})
	}
}

func TestHasGroupStrictAndNested(t *testing.T) {
	for _, tc := range []struct {
		claims      map[string]any
		path, group string
		want        bool
	}{
		{map[string]any{"groups": []any{"/IT/Portal"}}, "groups", "/IT/Portal", true},
		{map[string]any{"realm": map[string]any{"groups": []any{"/IT/Portal"}}}, "realm.groups", "/IT/Portal", true},
		{map[string]any{"groups": []any{"/IT/Portal-more"}}, "groups", "/IT/Portal", false},
		{map[string]any{"groups": []any{"/IT/Portal", 123}}, "groups", "/IT/Portal", false},
		{map[string]any{"groups": "/IT/Portal"}, "groups", "/IT/Portal", false},
		{map[string]any{"groups": []any{"/IT/Portal"}}, "groups", "", false},
		{map[string]any{"realm": []any{"/IT/Portal"}}, "realm.groups", "/IT/Portal", false},
		{map[string]any{}, "groups", "/IT/Portal", false},
	} {
		if got := HasGroup(tc.claims, tc.path, tc.group); got != tc.want {
			t.Errorf("claims=%v path=%s got=%v want=%v", tc.claims, tc.path, got, tc.want)
		}
	}
}

func TestOIDCSessionExpiryLogoutAndDemoClosedInProduction(t *testing.T) {
	f := newOIDCFixture(t)
	s := oidcPortal(t, f)
	f.mu.Lock()
	f.mutate = func(c map[string]any) { c["exp"] = time.Now().Add(3 * time.Minute).Unix() }
	f.mu.Unlock()
	location, browser := oidcBegin(t, s, f)
	who := oidcIdentity(t, s, oidcCallback(s, location, browser))
	r := httptest.NewRequest("GET", s.Config.PublicURL+"/api/v1/session", nil)
	r.AddCookie(who.cookie)
	session, err := s.readSession(r)
	if err != nil {
		t.Fatal(err)
	}
	if time.Until(session.ExpiresAt) > 4*time.Minute {
		t.Fatal("session outlives ID token")
	}
	if w := apiCall(s, apiIdentity{}, "POST", "/auth/demo", map[string]string{"role": "admin"}, nil); w.Code != 404 {
		t.Fatalf("demo bypass enabled:%d", w.Code)
	}
	if w := apiCall(s, who, "POST", "/auth/logout", nil, nil); w.Code != 204 {
		t.Fatalf("logout:%d", w.Code)
	}
	w := apiCall(s, who, "GET", "/api/v1/resources", nil, nil)
	if w.Code != 401 || strings.Contains(w.Body.String(), "fixture-secret") {
		t.Fatal("logout or secret handling failed")
	}
}

func TestOIDCExpiredStateAndWrongStateNeverExchangeCode(t *testing.T) {
	f := newOIDCFixture(t)
	s := oidcPortal(t, f)
	location, browser := oidcBegin(t, s, f)
	callbackURL, err := url.Parse(location)
	if err != nil {
		t.Fatal(err)
	}
	values := callbackURL.Query()
	values.Set("state", "attacker-state")
	callbackURL.RawQuery = values.Encode()
	if w := oidcCallback(s, callbackURL.String(), browser); w.Code != 400 {
		t.Fatalf("wrong state accepted:%d", w.Code)
	}
	// The state deadline is controlled in PostgreSQL, avoiding timing-dependent sleeps.
	if _, err = s.Store.Pool.Exec(context.Background(), "UPDATE oidc_states SET expires_at=now()-interval '1 minute'"); err != nil {
		t.Fatal(err)
	}
	if w := oidcCallback(s, location, browser); w.Code != 400 {
		t.Fatalf("expired state accepted:%d", w.Code)
	}
	f.mu.Lock()
	calls := f.tokenCalls
	f.mu.Unlock()
	if calls != 0 {
		t.Fatalf("invalid state exchanged authorization code:%d", calls)
	}
}

func TestAuthenticationConfigRequiresExplicitProvider(t *testing.T) {
	for _, key := range []string{"PORTAL_DEMO", "PORTAL_OIDC_ISSUER", "PORTAL_OIDC_CLIENT_ID", "PORTAL_OIDC_CLIENT_SECRET", "PORTAL_OIDC_ALLOWED_GROUP", "PORTAL_LOCAL_ADMIN_HASH_FILE", "PORTAL_LOCAL_ADMIN_USERNAME", "PORTAL_SESSION_HOURS", "PORTAL_ALLOWED_PORTS"} {
		t.Setenv(key, "")
	}
	t.Setenv("PORTAL_PUBLIC_URL", "https://portal.example.test")
	t.Setenv("PORTAL_DATABASE_URL", "postgres://fixture.invalid/unused")
	if _, err := LoadConfig(); err == nil {
		t.Fatal("production without an explicit authentication provider accepted")
	}
	t.Setenv("PORTAL_OIDC_ISSUER", "https://issuer.example.test")
	if _, err := LoadConfig(); err == nil {
		t.Fatal("incomplete OIDC implicitly enabled authentication")
	}
	t.Setenv("PORTAL_OIDC_CLIENT_ID", "fixture-client")
	t.Setenv("PORTAL_OIDC_CLIENT_SECRET", "fixture-secret")
	t.Setenv("PORTAL_OIDC_ALLOWED_GROUP", "/IT/Portal")
	config, err := LoadConfig()
	if err != nil || config.Demo {
		t.Fatalf("complete OIDC config: demo=%v err=%v", config.Demo, err)
	}
	for _, key := range []string{"PORTAL_OIDC_ISSUER", "PORTAL_OIDC_CLIENT_ID", "PORTAL_OIDC_CLIENT_SECRET", "PORTAL_OIDC_ALLOWED_GROUP"} {
		t.Setenv(key, "")
	}
	file := filepath.Join(t.TempDir(), "local-admin.hash")
	if err := os.WriteFile(file, []byte(localTestHash("fixture-local-password")), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PORTAL_LOCAL_ADMIN_HASH_FILE", file)
	config, err = LoadConfig()
	if err != nil || config.Demo || config.LocalAdminUsername != "portal-admin" {
		t.Fatalf("explicit local-only config: demo=%v err=%v", config.Demo, err)
	}
	t.Setenv("PORTAL_LOCAL_ADMIN_USERNAME", " padded ")
	if _, err = LoadConfig(); err == nil {
		t.Fatal("unusable whitespace username accepted")
	}
	t.Setenv("PORTAL_LOCAL_ADMIN_USERNAME", "portal-admin")
	t.Setenv("PORTAL_PUBLIC_URL", "http://portal.example.test")
	if _, err = LoadConfig(); err == nil {
		t.Fatal("production local login permits plain HTTP")
	}
	t.Setenv("PORTAL_LOCAL_ADMIN_HASH_FILE", "")
	t.Setenv("PORTAL_DEMO", "true")
	config, err = LoadConfig()
	if err != nil || !config.Demo {
		t.Fatalf("explicit demo rejected:%v", err)
	}
	t.Setenv("PORTAL_DEMO", "True")
	if _, err = LoadConfig(); err == nil {
		t.Fatal("demo enabled without exact explicit true")
	}
}

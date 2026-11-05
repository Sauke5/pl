package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"pl/portal/internal/model"
	"reflect"
	"strings"
	"testing"
	"time"
)

type directoryRoundTrip func(*http.Request) (*http.Response, error)

func (f directoryRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func decodeDirectoryAssertion(t *testing.T, r *http.Request, key []byte) gatewayIdentity {
	t.Helper()
	encoded := r.Header.Get(gatewayAssertionHeader)
	if r.Header.Get(gatewaySignatureHeader) != gatewayMAC(key, "pl-gateway-v2\n"+encoded) {
		t.Fatal("bad v2 signature")
	}
	if r.Header.Get(gatewaySignatureHeader) == gatewayMAC(key, "pl-gateway-v1\n"+encoded) {
		t.Fatal("v1 domain accepted")
	}
	data, e := base64.RawURLEncoding.DecodeString(encoded)
	if e != nil {
		t.Fatal(e)
	}
	var claims gatewayIdentity
	if json.Unmarshal(data, &claims) != nil {
		t.Fatal("bad assertion")
	}
	return claims
}
func TestDirectoryV2IdentityScopeAndBinding(t *testing.T) {
	key := bytes.Repeat([]byte{42}, 32)
	now := time.Unix(1790000000, 0)
	for _, admin := range []bool{false, true} {
		sess := session{User: model.User{ID: "ad:immutable-object-guid", Name: "Иван Иванов", Admin: admin}, CSRF: "session-csrf"}
		req := httptest.NewRequest("GET", "http://source/directory/api/v1/contacts?q=a%2Fb", nil)
		if e := signDirectoryRequest(req, nil, sess, key, now, false, "192.0.2.1"); e != nil {
			t.Fatal(e)
		}
		claims := decodeDirectoryAssertion(t, req, key)
		want := []string{"directory:read"}
		if admin {
			want = []string{"directory:audit:read", "directory:read", "directory:write"}
		}
		if claims.Version != 2 || claims.Audience != "directory" || claims.Admin != admin || claims.Subject != sess.User.ID || claims.Name != sess.User.Name || !reflect.DeepEqual(claims.Scopes, want) || claims.URI != req.URL.RequestURI() || claims.Method != "GET" || claims.ExpiresAt-claims.IssuedAt != 30 || claims.CSRFToken != gatewayServiceCSRF(sess.CSRF, "directory") {
			t.Fatal(claims)
		}
		first := claims.Nonce
		if e := signDirectoryRequest(req, nil, sess, key, now, false, "192.0.2.1"); e != nil {
			t.Fatal(e)
		}
		if decodeDirectoryAssertion(t, req, key).Nonce == first {
			t.Fatal("nonce reused")
		}
		if e := signGatewayRequest(req, nil, sess, "directory", want, key, now, false, "192.0.2.1"); e == nil {
			t.Fatal("v1 accepted directory")
		}
		req.Method = "PATCH"
		req.Header.Set("Content-Type", "application/json")
		body := []byte(`{"name":"Новое"}`)
		e := signDirectoryRequest(req, body, sess, key, now, true, "192.0.2.1")
		if !admin {
			if e == nil {
				t.Fatal("employee write signed")
			}
			continue
		}
		if e != nil {
			t.Fatal(e)
		}
		claims = decodeDirectoryAssertion(t, req, key)
		digest := sha256.Sum256(body)
		if claims.BodySHA256 != hex.EncodeToString(digest[:]) || claims.Method != "PATCH" || !claims.CSRFVerified || claims.ContentType != "application/json" {
			t.Fatal(claims)
		}
		if e := signDirectoryRequest(req, body, sess, key, now, false, "192.0.2.1"); e == nil {
			t.Fatal("unsigned CSRF accepted")
		}
	}
}
func TestDirectoryGatewayEmployeeAdminAndSpoofing(t *testing.T) {
	s := apiFixture(t)
	employee := apiUser(t, s, "directory-employee", false)
	admin := apiUser(t, s, "directory-admin", true)
	key := bytes.Repeat([]byte{42}, 32)
	var received *http.Request
	var claims gatewayIdentity
	calls := 0
	rt := directoryRoundTrip(func(r *http.Request) (*http.Response, error) {
		calls++
		received = r
		claims = decodeDirectoryAssertion(t, r, key)
		for _, h := range []string{"Cookie", "Authorization", "X-User", "X-Remote-User", "Remote-User", "X-Authenticated-User", "X-PL-Forged"} {
			if r.Header.Get(h) != "" {
				t.Errorf("spoofed header escaped %s", h)
			}
		}
		if r.URL.Host != "10.200.50.33:8080" || !strings.HasPrefix(r.URL.Path, "/directory/") {
			t.Error("destination changed", r.URL)
		}
		body, _ := io.ReadAll(r.Body)
		digest := sha256.Sum256(body)
		if claims.BodySHA256 != hex.EncodeToString(digest[:]) || claims.Method != r.Method || claims.URI != r.URL.RequestURI() {
			t.Error("binding mismatch")
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Set-Cookie": []string{"evil=yes"}}, Body: io.NopCloser(strings.NewReader("ok"))}, nil
	})
	handler := s.ServiceGateway(ServiceGatewayConfig{Audience: "directory", AssertionVersion: 2, Upstream: "http://10.200.50.33:8080", Key: key, Transport: rt})
	call := func(who apiIdentity, method, path string, csrf bool) *httptest.ResponseRecorder {
		body := ""
		if method == "PATCH" {
			body = `{"name":"Иван"}`
		}
		r := httptest.NewRequest(method, s.Config.PublicURL+path, strings.NewReader(body))
		r.RemoteAddr = "192.0.2.10:1234"
		if who.cookie != nil {
			r.AddCookie(who.cookie)
		}
		r.Header.Set("Origin", s.Config.PublicURL)
		r.Header.Set("Content-Type", "application/json")
		if csrf {
			r.Header.Set("X-CSRF-Token", who.csrf)
		}
		for _, h := range []string{gatewayAssertionHeader, gatewaySignatureHeader, "X-User", "X-Remote-User", "Remote-User", "X-Authenticated-User", "X-PL-Forged"} {
			r.Header.Set(h, "forged")
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	for _, method := range []string{"GET", "HEAD", "OPTIONS"} {
		w := call(employee, method, "/directory/api/v1/contacts?q=a%2Fb", false)
		if w.Code != 200 || claims.Admin || claims.Subject != "directory-employee" || !reflect.DeepEqual(claims.Scopes, []string{"directory:read"}) || claims.CSRFVerified || w.Header().Get("Set-Cookie") != "" {
			t.Fatal(method, w.Code, w.Body.String(), claims)
		}
	}
	if w := call(admin, "PATCH", "/directory/api/v1/contacts/1", true); w.Code != 200 || !claims.Admin || !claims.CSRFVerified || received.Header.Get("X-CSRF-Token") != claims.CSRFToken {
		t.Fatal(w.Code, w.Body.String(), claims)
	}
	before := calls
	authReq := httptest.NewRequest("GET", s.Config.PublicURL+"/directory/api/v1/contacts", nil)
	authReq.AddCookie(employee.cookie)
	authReq.Header.Set("Authorization", "Bearer browser-secret")
	authResponse := httptest.NewRecorder()
	handler.ServeHTTP(authResponse, authReq)
	if authResponse.Code != 401 {
		t.Fatal("Authorization browser boundary", authResponse.Code)
	}
	for _, tc := range []struct {
		who          apiIdentity
		method, path string
		csrf         bool
		status       int
	}{
		{employee, "PATCH", "/directory/api/v1/contacts/1", true, 403}, {admin, "PATCH", "/directory/api/v1/contacts/1", false, 403}, {apiIdentity{}, "GET", "/directory/api/v1/contacts", false, 401}, {employee, "TRACE", "/directory/", false, 404}, {employee, "GET", "/directory/%2e%2e/admin", false, 404},
	} {
		if w := call(tc.who, tc.method, tc.path, tc.csrf); w.Code != tc.status {
			t.Fatal(tc.method, tc.path, w.Code, w.Body.String())
		}
	}
	if calls != before {
		t.Fatal("denied requests reached source")
	}
}
func TestDirectoryConfigOriginAndVersion(t *testing.T) {
	t.Setenv("PORTAL_DATABASE_URL", "postgres://test.invalid/test")
	t.Setenv("PORTAL_DEMO", "true")
	t.Setenv("PORTAL_PUBLIC_URL", "http://localhost:8199")
	t.Setenv("PORTAL_LOCAL_ADMIN_HASH_FILE", "")
	t.Setenv("PORTAL_AD_URL", "")
	keyPath := filepath.Join(t.TempDir(), "directory.key")
	if err := os.WriteFile(keyPath, bytes.Repeat([]byte{73}, 32), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PORTAL_DIRECTORY_URL", "http://10.200.50.33:8080")
	t.Setenv("PORTAL_DIRECTORY_KEY_FILE", keyPath)
	c, e := LoadConfig()
	if e != nil {
		t.Fatal(e)
	}
	found := false
	for _, g := range c.ServiceGateways {
		if g.Audience == "directory" {
			found = true
			if g.AssertionVersion != 2 || g.Upstream != "http://10.200.50.33:8080/directory" {
				t.Fatal(g.Upstream, g.AssertionVersion)
			}
		}
	}
	if !found {
		t.Fatal("missing directory")
	}
}

func TestDirectoryPublishedV2Vectors(t *testing.T) {
	data, err := os.ReadFile("../../docs/examples/directory-v2-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		KeyHex     string `json:"key_hex"`
		PortalCSRF string `json:"portal_csrf_utf8"`
		Vectors    []struct {
			Payload gatewayIdentity `json:"payload"`
			Request struct {
				Method  string            `json:"method"`
				URI     string            `json:"uri"`
				Headers map[string]string `json:"headers"`
			} `json:"request"`
		} `json:"vectors"`
	}
	if err = json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	key, err := hex.DecodeString(fixture.KeyHex)
	if err != nil {
		t.Fatal(err)
	}
	if len(fixture.Vectors) < 2 {
		t.Fatal("missing vectors")
	}
	for _, v := range fixture.Vectors {
		req := httptest.NewRequest(v.Request.Method, "http://source"+v.Request.URI, nil)
		if err = writeGatewayIdentity(req, v.Payload, key); err != nil {
			t.Fatal(err)
		}
		for _, name := range []string{gatewayAssertionHeader, gatewaySignatureHeader} {
			if req.Header.Get(name) != v.Request.Headers[name] {
				t.Fatalf("cross-language %s differs", name)
			}
		}
		if v.Payload.CSRFToken != gatewayServiceCSRF(fixture.PortalCSRF, "directory") {
			t.Fatal("cross-language CSRF differs")
		}
	}
}

func TestDirectoryRoutesBoundedMethods(t *testing.T) {
	for _, method := range []string{"GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"} {
		if !gatewayRoute("directory", method, "/api/v1/contacts/1") {
			t.Fatal(method)
		}
	}
	for _, tc := range [][2]string{{"TRACE", "/"}, {"CONNECT", "/"}, {"GET", "/../admin"}, {"GET", "//admin"}, {"GET", "/%2e%2e/admin"}, {"GET", "/a\\b"}} {
		if gatewayRoute("directory", tc[0], tc[1]) {
			t.Fatal(tc)
		}
	}
	if gatewayRoute("monitoring-admin", "OPTIONS", "/api/v1/session") {
		t.Fatal("v1 safe methods changed")
	}
}

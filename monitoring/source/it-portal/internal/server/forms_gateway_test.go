package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"pl/portal/internal/model"
)

const formsTestUUID = "12345678-1234-4234-8234-123456789abc"

func TestFormsExactManifestAndSigner(t *testing.T) {
	tests := []struct{ method, path, scope string }{
		{"GET", "/forms/", "forms:read"}, {"HEAD", "/forms/index.html", "forms:read"}, {"GET", "/forms/app.js", "forms:read"}, {"HEAD", "/forms/theme.js", "forms:read"}, {"GET", "/forms/styles.css", "forms:read"},
		{"GET", "/forms/api/v1/context", "forms:read"}, {"GET", "/forms/api/v1/surveys", "forms:read"}, {"GET", "/forms/api/v1/surveys/abc123", "forms:read"},
		{"POST", "/forms/api/v1/surveys/abc123/responses", "forms:respond"}, {"POST", "/forms/api/v1/surveys", "forms:admin"}, {"PUT", "/forms/api/v1/surveys/abc123", "forms:admin"}, {"POST", "/forms/api/v1/surveys/abc123/publish", "forms:admin"}, {"POST", "/forms/api/v1/surveys/abc123/close", "forms:admin"}, {"GET", "/forms/api/v1/surveys/abc123/results", "forms:admin"}, {"POST", "/forms/api/v1/surveys/abc123/results", "forms:admin"},
	}
	key := bytes.Repeat([]byte{42}, 32)
	for _, tc := range tests {
		t.Run(tc.method+tc.path, func(t *testing.T) {
			for _, admin := range []bool{false, true} {
				r := httptest.NewRequest(tc.method, "http://source"+tc.path, nil)
				unsafe := tc.method == "POST" || tc.method == "PUT"
				var body []byte
				if unsafe {
					body = []byte(`{ "answer": "Да" }`)
					r.Header.Set("Content-Type", "application/json; charset=utf-8")
					r.Header.Set("Idempotency-Key", formsTestUUID)
				}
				sess := session{User: model.User{ID: "ad:immutable-guid", Name: "Иван Иванов", Admin: admin}, CSRF: "test-only-session-csrf"}
				err := signFormsRequest(r, body, sess, key, time.Unix(1790000000, 0), unsafe, "192.0.2.10")
				if tc.scope == "forms:admin" && !admin {
					if err == nil {
						t.Fatal("employee admin assertion")
					}
					continue
				}
				if err != nil {
					t.Fatal(err)
				}
				claims := decodeDirectoryAssertion(t, r, key)
				digest := sha256.Sum256(body)
				if claims.Version != 2 || claims.Audience != "forms" || claims.Subject != sess.User.ID || claims.Name != sess.User.Name || claims.Admin != admin || !reflect.DeepEqual(claims.Scopes, []string{tc.scope}) || claims.ExpiresAt-claims.IssuedAt != 30 || claims.IssuedAt != 1790000000 || claims.Method != tc.method || claims.URI != tc.path || claims.BodySHA256 != hex.EncodeToString(digest[:]) || claims.ContentType != r.Header.Get("Content-Type") || claims.IdempotencyKey != r.Header.Get("Idempotency-Key") || claims.CSRFVerified != unsafe || claims.CSRFToken != gatewayServiceCSRF(sess.CSRF, "forms") || claims.SourceIP != "192.0.2.10" {
					t.Fatalf("wrong claims: %+v", claims)
				}
				first := claims.Nonce
				if err = signFormsRequest(r, body, sess, key, time.Unix(1790000000, 0), unsafe, "192.0.2.10"); err != nil || first == decodeDirectoryAssertion(t, r, key).Nonce {
					t.Fatal("nonce reused", err)
				}
				if signFormsRequest(r, bytes.Repeat([]byte{42}, formsBodyLimit+1), sess, key, time.Now(), unsafe, "192.0.2.10") == nil {
					t.Fatal("oversized body signed")
				}
				if unsafe && signFormsRequest(r, body, sess, key, time.Now(), false, "192.0.2.10") == nil {
					t.Fatal("unverified unsafe signed")
				}
			}
		})
	}
	for _, path := range []string{"/forms/health", "/forms/login", "/forms/api/v1/surveys/A", "/forms/api/v1/surveys/a-b", "/forms/api/v1/surveys/" + strings.Repeat("a", 33), "/forms/api/v1/surveys/a/responses/", "/forms/api/v1/surveys/a/results?", "/forms/api/v1/surveys?a=1&a=2", "/forms/?", "/forms/%61pp.js", "/forms/../admin/", "/forms//app.js", "/forms/native/api", "/forms/assets/a.js"} {
		r := httptest.NewRequest("GET", "http://source"+path, nil)
		if _, ok := formsMatchRoute(r); ok {
			t.Fatal("route opened", path)
		}
	}
	for _, method := range []string{"OPTIONS", "PATCH", "DELETE", "TRACE", "CONNECT", "POST"} {
		if _, ok := formsMatchRoute(httptest.NewRequest(method, "http://source/forms/", nil)); ok {
			t.Fatal("method opened", method)
		}
	}
	for _, path := range []string{"/forms/api/v1/context", "/forms/api/v1/surveys", "/forms/api/v1/surveys/a", "/forms/api/v1/surveys/a/results"} {
		if _, ok := formsMatchRoute(httptest.NewRequest("HEAD", "http://source"+path, nil)); ok {
			t.Fatal("API HEAD opened", path)
		}
	}
}

type formsHTTPFixture struct {
	s               *Server
	g               *formsGateway
	employee, admin apiIdentity
	key             []byte
	calls           atomic.Int32
	backend         *httptest.Server
}

func newFormsHTTPFixture(t *testing.T, handler func(http.ResponseWriter, *http.Request)) *formsHTTPFixture {
	t.Helper()
	f := &formsHTTPFixture{s: apiFixture(t), key: bytes.Repeat([]byte{42}, 32)}
	f.employee = apiUser(t, f.s, "ad:forms-employee", false)
	f.admin = apiUser(t, f.s, "ad:forms-admin", true)
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { f.calls.Add(1); handler(w, r) }))
	f.backend = backend
	t.Cleanup(backend.Close)
	g, err := f.s.newFormsGateway(&FormsGatewayConfig{Upstream: formsUpstream, Key: f.key, AllowedCIDRs: []string{"192.0.2.240/32"}})
	if err != nil {
		t.Fatal(err)
	}
	tr := g.transport.(*http.Transport)
	tr.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != "192.0.2.240:8091" {
			t.Errorf("wrong destination %s", address)
		}
		return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(backend.URL, "http://"))
	}
	t.Cleanup(tr.CloseIdleConnections)
	f.g = g
	return f
}
func (f *formsHTTPFixture) call(t *testing.T, who apiIdentity, method, path, body string, mutate func(*http.Request)) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, f.s.Config.PublicURL+path, strings.NewReader(body))
	r.RemoteAddr = "192.0.2.10:1234"
	if who.cookie != nil {
		r.AddCookie(who.cookie)
	}
	r.Header.Set("Origin", f.s.Config.PublicURL)
	r.Header.Set("Content-Type", "application/json")
	if who.csrf != "" {
		r.Header.Set("X-CSRF-Token", who.csrf)
	}
	r.Header.Set("Idempotency-Key", formsTestUUID)
	if mutate != nil {
		mutate(r)
	}
	w := httptest.NewRecorder()
	f.g.ServeHTTP(w, r)
	return w
}
func formsOK(w http.ResponseWriter, r *http.Request) {
	route, _ := formsMatchRoute(r)
	w.Header().Set("Content-Type", route.media)
	if route.media == "application/json" {
		_, _ = w.Write([]byte(`{"ok":true}`))
	} else {
		_, _ = w.Write([]byte("test asset"))
	}
}

func TestFormsHTTPIdentityRoutingAndCredentialBoundary(t *testing.T) {
	var f *formsHTTPFixture
	var claims gatewayIdentity
	f = newFormsHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		claims = decodeDirectoryAssertion(t, r, f.key)
		for _, name := range []string{"Cookie", "Authorization", "Proxy-Authorization", "Forwarded", "X-PL-Forged", "X-Auth-User", "Remote-User", "X-User", "Referer", "Connection", "Upgrade", "Accept-Language"} {
			if r.Header.Get(name) != "" {
				t.Errorf("client header escaped %s", name)
			}
		}
		if r.Host != "portal.example.test" || r.Header.Get("X-Forwarded-Host") != "portal.example.test" || r.Header.Get("X-Forwarded-Proto") != "https" || r.Header.Get("X-Forwarded-Prefix") != "/forms" || r.Header.Get("X-Forwarded-For") != "192.0.2.10" || r.Header.Get("X-Real-IP") != "192.0.2.10" {
			t.Error("spoofed forwarding", r.Header)
		}
		raw, _ := io.ReadAll(r.Body)
		sum := sha256.Sum256(raw)
		if claims.BodySHA256 != hex.EncodeToString(sum[:]) || claims.Method != r.Method || claims.URI != r.RequestURI || claims.ContentType != r.Header.Get("Content-Type") {
			t.Error("body/target changed")
		}
		if claims.CSRFVerified && (r.Header.Get("X-CSRF-Token") != claims.CSRFToken || r.Header.Get("Idempotency-Key") != formsTestUUID) {
			t.Error("CSRF/idempotency normalization")
		}
		formsOK(w, r)
	})
	spoof := func(r *http.Request) {
		for _, name := range []string{gatewayAssertionHeader, gatewaySignatureHeader, "X-PL-Forged", "X-Auth-User", "Remote-User", "X-User", "Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Real-IP", "Proxy-Authorization"} {
			r.Header.Set(name, "forged")
		}
		r.Header.Set("Connection", "Accept-Language, X-Auth-User")
		r.Header.Set("Accept-Language", "forged")
	}
	for _, path := range []string{"/forms/", "/forms/index.html", "/forms/app.js", "/forms/styles.css", "/forms/theme.js", "/forms/api/v1/context", "/forms/api/v1/surveys", "/forms/api/v1/surveys/abc123"} {
		if w := f.call(t, f.employee, "GET", path, "", spoof); w.Code != 200 || claims.Admin || claims.Subject != "ad:forms-employee" || claims.CSRFVerified || !reflect.DeepEqual(claims.Scopes, []string{"forms:read"}) {
			t.Fatalf("employee %s: %d %s", path, w.Code, w.Body.String())
		}
	}
	w := f.call(t, f.employee, "POST", "/forms/api/v1/surveys/abc123/responses", `{ "answer": "Да" }`, spoof)
	if w.Code != 200 || claims.Admin || !claims.CSRFVerified || !reflect.DeepEqual(claims.Scopes, []string{"forms:respond"}) {
		t.Fatal(w.Code, w.Body.String(), claims)
	}
	for _, tc := range [][2]string{{"POST", "/forms/api/v1/surveys"}, {"PUT", "/forms/api/v1/surveys/abc123"}, {"POST", "/forms/api/v1/surveys/abc123/publish"}, {"POST", "/forms/api/v1/surveys/abc123/close"}, {"GET", "/forms/api/v1/surveys/abc123/results"}, {"POST", "/forms/api/v1/surveys/abc123/results"}} {
		body := ""
		if tc[0] != "GET" {
			body = `{}`
		}
		if w := f.call(t, f.employee, tc[0], tc[1], body, spoof); w.Code != 403 {
			t.Fatal("employee admin route", w.Code)
		}
		if w := f.call(t, f.admin, tc[0], tc[1], body, spoof); w.Code != 200 || !claims.Admin || !reflect.DeepEqual(claims.Scopes, []string{"forms:admin"}) {
			t.Fatal("admin route", w.Code, w.Body.String())
		}
	}
	if w := f.call(t, f.employee, "HEAD", "/forms/styles.css", "", nil); w.Code != 200 || w.Body.Len() != 0 {
		t.Fatal("asset HEAD", w.Code, w.Body.String())
	}
	before := f.calls.Load()
	for _, tc := range []struct {
		who          apiIdentity
		method, path string
		status       int
		mutate       func(*http.Request)
	}{
		{apiIdentity{}, "GET", "/forms/api/v1/context", 401, nil},
		{apiIdentity{}, "GET", "/forms", 401, nil},
		{apiIdentity{}, "GET", "/forms/", 303, func(r *http.Request) { r.Header.Set("Accept", "text/html") }},
		{f.employee, "GET", "/forms", 307, nil},
		{f.employee, "GET", "/forms/?", 404, nil},
		{f.employee, "GET", "/forms/api/v1/surveys?a=1&a=2", 404, nil},
		{f.employee, "GET", "/forms/api/v1/surveys/A", 404, nil},
		{f.employee, "GET", "/forms/health", 404, nil},
		{f.employee, "GET", "/forms/api/native", 404, nil},
		{f.employee, "OPTIONS", "/forms/api/v1/surveys", 404, nil},
		{f.employee, "DELETE", "/forms/api/v1/surveys/abc123", 404, nil},
		{f.employee, "HEAD", "/forms/api/v1/surveys", 404, nil},
		{f.employee, "GET", "/forms/", 404, func(r *http.Request) { r.Header.Set("Upgrade", "websocket") }},
		{f.employee, "GET", "/forms/", 401, func(r *http.Request) { r.Header.Set("Authorization", "Bearer forged") }},
	} {
		w := f.call(t, tc.who, tc.method, tc.path, "", tc.mutate)
		if w.Code != tc.status {
			t.Fatalf("%s %s got %d want %d: %s", tc.method, tc.path, w.Code, tc.status, w.Body.String())
		}
	}
	if f.calls.Load() != before {
		t.Fatal("denied requests reached upstream")
	}
}

func TestFormsHTTPUnsafeValidation(t *testing.T) {
	f := newFormsHTTPFixture(t, formsOK)
	for _, tc := range []struct {
		name, body string
		status     int
		mutate     func(*http.Request)
	}{
		{"missing csrf", `{}`, 403, func(r *http.Request) { r.Header.Del("X-CSRF-Token") }},
		{"bad csrf", `{}`, 403, func(r *http.Request) { r.Header.Set("X-CSRF-Token", "forged") }},
		{"duplicate csrf", `{}`, 403, func(r *http.Request) { r.Header.Add("X-CSRF-Token", f.employee.csrf) }},
		{"foreign origin", `{}`, 403, func(r *http.Request) { r.Header.Set("Origin", "https://foreign.invalid") }},
		{"missing origin", `{}`, 403, func(r *http.Request) { r.Header.Del("Origin") }},
		{"foreign referer", `{}`, 403, func(r *http.Request) {
			r.Header.Del("Origin")
			r.Header.Set("Referer", "https://foreign.invalid/forms/")
		}},
		{"duplicate origin", `{}`, 403, func(r *http.Request) { r.Header.Add("Origin", f.s.Config.PublicURL) }},
		{"cross site", `{}`, 403, func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") }},
		{"nonjson", `{}`, 415, func(r *http.Request) { r.Header.Set("Content-Type", "text/plain") }},
		{"bad charset", `{}`, 415, func(r *http.Request) { r.Header.Set("Content-Type", "application/json; charset=iso-8859-1") }},
		{"duplicate content type", `{}`, 400, func(r *http.Request) { r.Header.Add("Content-Type", "application/json") }},
		{"compressed", `{}`, 415, func(r *http.Request) { r.Header.Set("Content-Encoding", "gzip") }},
		{"invalid json", `{} {}`, 400, nil},
		{"oversize", strings.Repeat(" ", formsBodyLimit+1), 413, nil},
		{"missing uuid", `{}`, 400, func(r *http.Request) { r.Header.Del("Idempotency-Key") }},
		{"nonuuid", `{}`, 400, func(r *http.Request) { r.Header.Set("Idempotency-Key", "arbitrary") }},
		{"duplicate uuid", `{}`, 400, func(r *http.Request) { r.Header.Add("Idempotency-Key", formsTestUUID) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if w := f.call(t, f.employee, "POST", "/forms/api/v1/surveys/abc123/responses", tc.body, tc.mutate); w.Code != tc.status {
				t.Fatal(w.Code, w.Body.String())
			}
		})
	}
	if f.calls.Load() != 0 {
		t.Fatal("denied writes reached backend")
	}
	for _, mutate := range []func(*http.Request){
		func(r *http.Request) { r.Header.Set("X-CSRF-Token", gatewayServiceCSRF(f.employee.csrf, "forms")) },
		func(r *http.Request) { r.Header.Del("Origin"); r.Header.Set("Referer", f.s.Config.PublicURL+"/forms/") },
	} {
		if w := f.call(t, f.employee, "POST", "/forms/api/v1/surveys/abc123/responses", `{}`, mutate); w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if w := f.call(t, f.employee, "GET", "/forms/api/v1/surveys", `{}`, nil); w.Code != 400 {
		t.Fatal("safe body", w.Code)
	}
}

func TestFormsHTTPThreeMiBImportPreservesSignedUTF8Body(t *testing.T) {
	var expected string
	f := newFormsHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil || string(body) != expected {
			t.Error("import body changed in gateway")
		}
		claims := decodeDirectoryAssertion(t, r, bytes.Repeat([]byte{42}, 32))
		digest := sha256.Sum256(body)
		if claims.Audience != "forms" || !claims.Admin || !claims.CSRFVerified ||
			claims.BodySHA256 != hex.EncodeToString(digest[:]) || claims.IdempotencyKey != formsTestUUID {
			t.Error("large import lost its signed identity, CSRF or body binding")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"saved":true}`))
	})
	document := "{\n\"title\":\"Импорт 😀\",\n\"description\":\"Первая\\nВторая\"\n}"
	for _, length := range []int{(128 << 10) + 1, 3 << 20} {
		expected = document + strings.Repeat("\n", length-len(document))
		if response := f.call(t, f.admin, "POST", "/forms/api/v1/surveys", expected, nil); response.Code != 200 {
			t.Fatalf("import bytes=%d status=%d", len(expected), response.Code)
		}
	}
	before := f.calls.Load()
	if response := f.call(t, f.admin, "POST", "/forms/api/v1/surveys", expected+"\n", nil); response.Code != 413 {
		t.Fatalf("one byte over 3 MiB returned %d", response.Code)
	}
	if response := f.call(t, f.admin, "POST", "/forms/api/v1/surveys", expected, func(r *http.Request) {
		r.Header.Set("X-CSRF-Token", "forged")
	}); response.Code != 403 {
		t.Fatalf("large import bypassed CSRF: %d", response.Code)
	}
	if f.calls.Load() != before {
		t.Fatal("rejected large import reached native service")
	}
}

func TestFormsHTTPReturnsDefinitionLargerThanThreeMiBWithinResponseBudget(t *testing.T) {
	body := `{"description":"` + strings.Repeat("Ж", (3<<19)+1) + `"}`
	f := newFormsHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, body)
	})
	response := f.call(t, f.admin, "GET", "/forms/api/v1/surveys/abc123", "", nil)
	if response.Code != 200 || response.Body.String() != body {
		t.Fatalf("definition response was truncated/rejected: status=%d bytes=%d", response.Code, response.Body.Len())
	}
}

func TestFormsHTTPUpstreamBoundariesAndTimeout(t *testing.T) {
	for _, tc := range []struct {
		name, path, media, body string
		status, want            int
		headers                 map[string]string
	}{
		{"valid api", "/forms/api/v1/context", "application/json", `{"name":"test","admin":false,"csrf_token":"derived"}`, 200, 200, nil},
		{"json mislabeled", "/forms/api/v1/context", "text/html", `{}`, 200, 502, nil},
		{"broken json", "/forms/api/v1/context", "application/json", `not JSON`, 200, 502, nil},
		{"api oversized", "/forms/api/v1/surveys", "application/json", strings.Repeat(" ", formsAPILimit+1), 200, 502, nil},
		{"asset oversized", "/forms/app.js", "application/javascript", strings.Repeat(" ", formsAssetLimit+1), 200, 502, nil},
		{"cookie", "/forms/", "text/html", "", 200, 502, map[string]string{"Set-Cookie": "native=auth; HttpOnly"}},
		{"auth challenge", "/forms/", "text/html", "", 401, 502, map[string]string{"WWW-Authenticate": "Basic realm=native"}},
		{"asset type", "/forms/app.js", "text/html", "login", 200, 502, nil},
		{"compressed response", "/forms/app.js", "application/javascript", "", 200, 502, map[string]string{"Content-Encoding": "gzip"}},
		{"open redirect", "/forms/", "text/html", "", 302, 502, map[string]string{"Location": "https://evil.invalid/forms/"}},
		{"native redirect", "/forms/", "text/html", "", 302, 502, map[string]string{"Location": "/forms/login"}},
		{"api redirect", "/forms/api/v1/surveys", "application/json", "", 302, 502, map[string]string{"Location": "/forms/"}},
		{"query redirect", "/forms/", "text/html", "", 302, 502, map[string]string{"Location": "/forms/?"}},
		{"encoded redirect", "/forms/", "text/html", "", 302, 502, map[string]string{"Location": "/forms/%61pp.js"}},
		{"refresh redirect", "/forms/", "text/html", "", 200, 502, map[string]string{"Refresh": "0; url=https://evil.invalid"}},
		{"prefix redirect", "/forms/", "text/html", "", 302, 302, map[string]string{"Location": "/forms/index.html"}},
		{"upstream redirect", "/forms/", "text/html", "", 302, 302, map[string]string{"Location": formsUpstream + "/forms/index.html"}},
		{"public redirect", "/forms/", "text/html", "", 302, 302, map[string]string{"Location": "https://portal.example.test/forms/index.html"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFormsHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", tc.media)
				for k, v := range tc.headers {
					w.Header().Set(k, v)
				}
				w.Header().Set("X-PL-Gateway-Assertion", "must-not-escape")
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			})
			w := f.call(t, f.employee, "GET", tc.path, "", nil)
			if w.Code != tc.want {
				t.Fatal(w.Code, w.Body.String())
			}
			if w.Header().Get("Set-Cookie") != "" || w.Header().Get("WWW-Authenticate") != "" || w.Header().Get(gatewayAssertionHeader) != "" {
				t.Fatal("upstream authentication escaped")
			}
			if tc.want == 302 && w.Header().Get("Location") != "/forms/index.html" {
				t.Fatal("redirect not normalized", w.Header())
			}
		})
	}
	f := newFormsHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		select {
		case <-r.Context().Done():
		case <-time.After(time.Second):
		}
	})
	f.g.timeout = 30 * time.Millisecond
	start := time.Now()
	if w := f.call(t, f.employee, "POST", "/forms/api/v1/surveys/abc123/responses", `{}`, nil); w.Code != 502 || !strings.Contains(w.Body.String(), "перед повтором") {
		t.Fatal("timeout", w.Code, w.Body.String())
	}
	if time.Since(start) > time.Second || f.calls.Load() != 1 {
		t.Fatal("timeout retried or unbounded")
	}
}

func TestFormsHTTPRevocationAndDefaultClosed(t *testing.T) {
	f := newFormsHTTPFixture(t, formsOK)
	f.backend.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, err := f.s.Store.Pool.Exec(context.Background(), "DELETE FROM sessions WHERE token_hash=$1", hash(f.employee.cookie.Value))
		if err != nil {
			t.Error(err)
		}
		formsOK(w, r)
	})
	if w := f.call(t, f.employee, "GET", "/forms/api/v1/context", "", nil); w.Code != 401 {
		t.Fatal("revoked response escaped", w.Code)
	}
	f.s.formsHandler = nil
	r := httptest.NewRequest("GET", f.s.Config.PublicURL+"/forms/api/v1/context", nil)
	r.AddCookie(f.admin.cookie)
	w := httptest.NewRecorder()
	f.s.Handler().ServeHTTP(w, r)
	if w.Code != 503 {
		t.Fatal("default open", w.Code, w.Body.String())
	}
}

func TestFormsRedirectValidation(t *testing.T) {
	g := &formsGateway{}
	base, _ := url.Parse(formsUpstream + "/forms/")
	public, _ := url.Parse("https://portal.example.test")
	for _, value := range []string{"//evil.invalid/forms/", "/forms/?", "/forms/?x=1&x=2", "/forms/#fragment", "/forms/api/v1/context", "/forms/../forms/", "/forms//app.js", "/forms/%61pp.js", "/forms/login", "https://user@portal.example.test/forms/"} {
		if g.validRedirect(base, public, value) {
			t.Fatal("redirect opened", value)
		}
	}
}

func TestFormsHTTPDoesNotRetryMutationAfterLostResponse(t *testing.T) {
	var mutations atomic.Int32
	var warmPeer atomic.Value
	f := newFormsHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			mutations.Add(1)
			if previous := warmPeer.Load(); previous == nil || previous.(string) != r.RemoteAddr {
				t.Error("mutation did not use the warmed connection")
			}
			_, _ = io.Copy(io.Discard, r.Body)
			connection, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			_ = connection.Close() // Business operation happened; its response was lost.
			return
		}
		warmPeer.Store(r.RemoteAddr)
		formsOK(w, r)
	})
	if w := f.call(t, f.employee, "GET", "/forms/api/v1/context", "", nil); w.Code != 200 {
		t.Fatal("warmup", w.Code)
	}
	if w := f.call(t, f.employee, "POST", "/forms/api/v1/surveys/abc123/responses", `{}`, nil); w.Code != 502 {
		t.Fatal("lost response accepted", w.Code)
	}
	if mutations.Load() != 1 {
		t.Fatal("unsafe automatically retried", mutations.Load())
	}
}

func TestFormsHTTPFinalSessionCheckUsesDeadline(t *testing.T) {
	var release func()
	var f *formsHTTPFixture
	f = newFormsHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		tx, err := f.s.Store.Pool.Begin(context.Background())
		if err != nil {
			t.Error(err)
			w.WriteHeader(500)
			return
		}
		release = func() { _ = tx.Rollback(context.Background()) }
		if _, err = tx.Exec(context.Background(), "LOCK TABLE sessions IN ACCESS EXCLUSIVE MODE"); err != nil {
			t.Error(err)
			w.WriteHeader(500)
			return
		}
		formsOK(w, r)
	})
	defer func() {
		if release != nil {
			release()
		}
	}()
	f.g.timeout = 100 * time.Millisecond
	start := time.Now()
	w := f.call(t, f.employee, "GET", "/forms/api/v1/context", "", nil)
	if w.Code != 401 || time.Since(start) > time.Second {
		t.Fatal("final session check exceeded deadline", w.Code, time.Since(start))
	}
}

func TestFormsHTTPConcurrencyAdmissionAndRelease(t *testing.T) {
	entered := make(chan struct{}, 4)
	release := make(chan struct{})
	f := newFormsHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		entered <- struct{}{}
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		formsOK(w, r)
	})
	results := make(chan int, 4)
	for i := 0; i < 4; i++ {
		go func() { results <- f.call(t, f.employee, "GET", "/forms/api/v1/context", "", nil).Code }()
	}
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	for i := 0; i < 4; i++ {
		select {
		case <-entered:
		case <-time.After(2 * time.Second):
			t.Fatal("four requests did not enter backend")
		}
	}
	if w := f.call(t, f.employee, "GET", "/forms/api/v1/context", "", nil); w.Code != 503 || f.calls.Load() != 4 {
		t.Fatal("fifth request not denied", w.Code, f.calls.Load())
	}
	close(release)
	for i := 0; i < 4; i++ {
		select {
		case status := <-results:
			if status != 200 {
				t.Fatal("admitted response", status)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("admitted request did not complete")
		}
	}
	if w := f.call(t, f.employee, "GET", "/forms/api/v1/context", "", nil); w.Code != 200 {
		t.Fatal("slot not released", w.Code)
	}
}

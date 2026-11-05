package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pl/portal/internal/model"
)

type proxyRoundTrip func(*http.Request) (*http.Response, error)

func TestProxyHistoryActorNameUsesVerifiedIdentity(t *testing.T) {
	s := &Server{Config: Config{ProxyControl: ProxyControlConfig{Origin: "https://controller.example.test:18791", Key: bytes.Repeat([]byte{17}, 32)}}}
	s.Config.ProxyControl.Transport = proxyRoundTrip(func(r *http.Request) (*http.Response, error) {
		payload := `{"schema_version":1,"history":[
   {"at":"2026-10-15T10:00:00Z","from":"relay","to":"final185","actor":"fixture-admin","actor_name":"Поддельное имя","reason":"test"},
   {"at":"2026-10-15T10:01:00Z","from":"final185","to":"relay","actor":"ad:other","actor_name":"Поддельное имя","reason":"test"}
  ]}`
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(payload)), Header: make(http.Header)}, nil
	})
	w := httptest.NewRecorder()
	s.proxyControlHandler()(w, proxyRequest("GET", "/api/v1/proxy-control/history", "", true))
	var result proxyHistory
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil {
		t.Fatal(w.Code, w.Body.String())
	}
	if result.History[0].Actor != "fixture-admin" || result.History[0].ActorName != "Администратор" {
		t.Fatal(result.History[0])
	}
	if result.History[1].ActorName != "" {
		t.Fatal("unverified upstream name accepted")
	}
}

func (f proxyRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func proxyFixture(t *testing.T, name string) []byte {
	t.Helper()
	b, e := os.ReadFile("testdata/proxy-control/" + name + ".json")
	if e != nil {
		t.Fatal(e)
	}
	return b
}
func proxyRequest(method, path, body string, admin bool) *http.Request {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.RemoteAddr = "10.0.0.9:1234"
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Idempotency-Key", "test-operation")
	return r.WithContext(context.WithValue(r.Context(), sessionKey, session{User: model.User{ID: "fixture-admin", Name: "Администратор", Admin: admin}, CSRF: "portal-only-secret"}))
}
func TestProxyControlFixedRoutes(t *testing.T) {
	for _, path := range []string{"/api/v1/proxy-control/status", "/api/v1/proxy-control/history", "/api/v1/proxy-control/history?limit=50"} {
		uri, ok := proxyControlURI(proxyRequest("GET", path, "", true))
		if !ok || strings.Contains(uri, "proxy-control") {
			t.Fatal(path, uri)
		}
	}
	for _, tc := range [][2]string{{"GET", "/api/v1/proxy-control/history?limit=51"}, {"GET", "/api/v1/proxy-control/history?limit=0"}, {"GET", "/api/v1/proxy-control/history?limit=1&limit=2"}, {"GET", "/api/v1/proxy-control/history?limit=%zz"}, {"GET", "/api/v1/proxy-control/status?target=http://evil"}, {"POST", "/api/v1/proxy-control/status"}, {"DELETE", "/api/v1/proxy-control/mode"}, {"GET", "/api/v1/proxy-control/history?target=relay"}} {
		if _, ok := proxyControlURI(proxyRequest(tc[0], tc[1], "", true)); ok {
			t.Fatal("accepted", tc)
		}
	}
}
func TestProxyControlSigningIsolationProjection(t *testing.T) {
	key := bytes.Repeat([]byte{17}, 32)
	for _, tc := range []struct{ method, path, body, scope string }{{"GET", "/api/v1/proxy-control/status", "", "proxy:read"}, {"GET", "/api/v1/proxy-control/history?limit=50", "", "proxy:read"}, {"POST", "/api/v1/proxy-control/mode", `{"mode":"final185","expected_revision":4,"reason":"проверка"}`, "proxy:mode"}} {
		t.Run(tc.path, func(t *testing.T) {
			s := &Server{Config: Config{ProxyControl: ProxyControlConfig{Origin: "https://controller.example.test:18791", Key: key}}}
			s.Config.ProxyControl.Transport = proxyRoundTrip(func(r *http.Request) (*http.Response, error) {
				if r.URL.Host != "controller.example.test:18791" || r.URL.Scheme != "https" || strings.Contains(r.URL.RequestURI(), "proxy-control") {
					t.Fatal("wrong destination", r.URL)
				}
				b, _ := io.ReadAll(r.Body)
				payload, e := base64.RawURLEncoding.DecodeString(r.Header.Get(gatewayAssertionHeader))
				if e != nil {
					t.Fatal(e)
				}
				var c gatewayIdentity
				if json.Unmarshal(payload, &c) != nil {
					t.Fatal("claims")
				}
				digest := sha256.Sum256(b)
				if c.Version != 1 || c.Audience != "proxy-control" || len(c.Scopes) != 1 || c.Scopes[0] != tc.scope || c.URI != r.URL.RequestURI() || c.Method != r.Method || c.BodySHA256 != hex.EncodeToString(digest[:]) || c.ContentType != r.Header.Get("Content-Type") || c.IdempotencyKey != r.Header.Get("Idempotency-Key") || c.ExpiresAt-c.IssuedAt != 30 || c.Subject != "fixture-admin" || !c.Admin {
					t.Fatal("invalid binding", c)
				}
				if gatewayMAC(key, "pl-gateway-v1\n"+r.Header.Get(gatewayAssertionHeader)) != r.Header.Get(gatewaySignatureHeader) {
					t.Fatal("signature")
				}
				for _, name := range []string{"Cookie", "Authorization", "X-PL-Forged", "Remote-User"} {
					if r.Header.Get(name) != "" {
						t.Fatal("header leak", name)
					}
				}
				if tc.method == "POST" && (!c.CSRFVerified || c.CSRFToken == "portal-only-secret" || c.CSRFToken != r.Header.Get("X-CSRF-Token")) {
					t.Fatal("csrf")
				}
				if tc.method == "GET" && (c.CSRFVerified || r.Header.Get("X-CSRF-Token") != "") {
					t.Fatal("read csrf")
				}
				name := "status"
				if strings.Contains(tc.path, "history") {
					name = "history"
				}
				return &http.Response{StatusCode: 200, Header: http.Header{"Set-Cookie": []string{"leak"}}, Body: io.NopCloser(bytes.NewReader(proxyFixture(t, name)))}, nil
			})
			r := proxyRequest(tc.method, tc.path, tc.body, true)
			r.Header.Set("Cookie", "portal_session=private")
			r.Header.Set("X-PL-Forged", "admin")
			r.Header.Set("X-CSRF-Token", "portal-only-secret")
			w := httptest.NewRecorder()
			s.proxyControlHandler()(w, r)
			if w.Code != 200 || w.Header().Get("Set-Cookie") != "" {
				t.Fatal(w.Code, w.Body.String())
			}
		})
	}
}
func TestProxyControlInputFailuresNeverReachController(t *testing.T) {
	s := &Server{Config: Config{ProxyControl: ProxyControlConfig{Origin: "https://controller.example.test:18791", Key: bytes.Repeat([]byte{1}, 32), Transport: proxyRoundTrip(func(*http.Request) (*http.Response, error) { t.Fatal("upstream reached"); return nil, nil })}}}
	cases := []struct {
		body   string
		admin  bool
		key    string
		status int
	}{
		{`{"mode":"relay","expected_revision":0}`, false, "key", 403},
		{`{"mode":"relay","expected_revision":0}`, true, "", 400},
		{`{"mode":"other","expected_revision":0}`, true, "key", 400},
		{`{"mode":"relay","expected_revision":-1}`, true, "key", 400},
		{`{"mode":"relay","expected_revision":0,"target":"evil"}`, true, "key", 400},
		{`{"mode":"relay"}`, true, "key", 400},
		{`{"mode":"relay","expected_revision":0} {}`, true, "key", 400},
		{strings.Repeat("x", 8193), true, "key", 413},
	}
	for _, tc := range cases {
		r := proxyRequest("POST", "/api/v1/proxy-control/mode", tc.body, tc.admin)
		r.Header.Set("Idempotency-Key", tc.key)
		w := httptest.NewRecorder()
		s.proxyControlHandler()(w, r)
		if w.Code != tc.status {
			t.Fatal(tc, w.Code, w.Body.String())
		}
	}
}
func TestProxyControlUpstreamFailureAndSchema(t *testing.T) {
	for _, tc := range []struct {
		code int
		body string
		want int
	}{{409, `{"error":"revision_conflict"}`, 409}, {302, `{}`, 502}, {200, `{}`, 502}, {200, strings.Repeat(" ", 256<<10) + `{}`, 502}, {200, `not json`, 502}, {503, `{"error":"control_unavailable"}`, 503}} {
		s := &Server{Config: Config{ProxyControl: ProxyControlConfig{Origin: "https://controller.example.test:18791", Key: bytes.Repeat([]byte{1}, 32), Transport: proxyRoundTrip(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: tc.code, Body: io.NopCloser(strings.NewReader(tc.body))}, nil
		})}}}
		w := httptest.NewRecorder()
		s.proxyControlHandler()(w, proxyRequest("GET", "/api/v1/proxy-control/status", "", true))
		if w.Code != tc.want {
			t.Fatal(tc.code, w.Code, w.Body.String())
		}
	}
	// Strip unknown fields and preserve nullable observations rather than fabricate zero.
	data := proxyFixture(t, "status")
	var raw map[string]any
	_ = json.Unmarshal(data, &raw)
	raw["secret"] = "must-not-leak"
	raw["counters"] = nil
	raw["sockets"] = nil
	encoded, _ := json.Marshal(raw)
	v, e := proxyControlProjection("/api/v1/status", encoded)
	if e != nil {
		t.Fatal(e)
	}
	out, _ := json.Marshal(v)
	if strings.Contains(string(out), "must-not-leak") || !strings.Contains(string(out), `"counters":null`) {
		t.Fatal(string(out))
	}
}
func TestProxyControlSessionRoleAndCSRF(t *testing.T) {
	s := apiFixture(t)
	admin := apiUser(t, s, "proxy-admin", true)
	employee := apiUser(t, s, "proxy-employee", false)
	for _, tc := range []struct {
		who    apiIdentity
		method string
		csrf   string
		want   int
	}{{apiIdentity{}, "GET", "", 401}, {employee, "GET", "", 403}, {employee, "POST", employee.csrf, 403}, {admin, "POST", "wrong", 403}, {admin, "GET", "", 503}, {admin, "POST", admin.csrf, 503}} {
		path := "/api/v1/proxy-control/status"
		if tc.method == "POST" {
			path = "/api/v1/proxy-control/mode"
		}
		w := apiCall(s, tc.who, tc.method, path, map[string]any{"mode": "auto", "expected_revision": 0}, map[string]string{"X-CSRF-Token": tc.csrf})
		if w.Code != tc.want {
			t.Fatal(tc.method, tc.want, w.Code, w.Body.String())
		}
	}
}
func TestProxyControlTimeoutAndCapacity(t *testing.T) {
	started := make(chan struct{}, 4)
	release := make(chan struct{})
	s := &Server{Config: Config{ProxyControl: ProxyControlConfig{Origin: "https://controller.example.test:18791", Key: bytes.Repeat([]byte{1}, 32), Transport: proxyRoundTrip(func(r *http.Request) (*http.Response, error) {
		started <- struct{}{}
		<-release
		return nil, context.DeadlineExceeded
	})}}}
	handler := s.proxyControlHandler()
	results := make(chan *httptest.ResponseRecorder, 4)
	for i := 0; i < 4; i++ {
		go func() {
			w := httptest.NewRecorder()
			handler(w, proxyRequest("GET", "/api/v1/proxy-control/status", "", true))
			results <- w
		}()
	}
	for i := 0; i < 4; i++ {
		<-started
	}
	w := httptest.NewRecorder()
	handler(w, proxyRequest("GET", "/api/v1/proxy-control/status", "", true))
	if w.Code != 503 || !strings.Contains(w.Body.String(), "proxy_busy") {
		t.Fatal(w.Code, w.Body.String())
	}
	close(release)
	for i := 0; i < 4; i++ {
		result := <-results
		if result.Code != 504 {
			t.Fatal(result.Code, result.Body.String())
		}
	}
}

func TestProxyControlKeyConfigurationAndScopeIsolation(t *testing.T) {
	t.Setenv("PORTAL_DATABASE_URL", "postgres://test.invalid/test")
	t.Setenv("PORTAL_DEMO", "true")
	t.Setenv("PORTAL_PUBLIC_URL", "http://localhost:8199")
	for _, name := range []string{"PORTAL_LOCAL_ADMIN_HASH_FILE", "PORTAL_AD_URL", "PORTAL_MONITORING_ADMIN_URL", "PORTAL_MONITORING_ADMIN_KEY_FILE", "PORTAL_WEBSITES_ADMIN_URL", "PORTAL_WEBSITES_ADMIN_KEY_FILE", "PORTAL_DIRECTORY_URL", "PORTAL_DIRECTORY_KEY_FILE", "PORTAL_AUDITOR_HOT_URL", "AUDITOR_HOT_GATEWAY_KEY_FILE", "PORTAL_AUDITOR_ARCH_URL", "AUDITOR_ARCH_GATEWAY_KEY_FILE"} {
		t.Setenv(name, "")
	}
	path := filepath.Join(t.TempDir(), "key")
	t.Setenv("PORTAL_PROXY_CONTROL_KEY_FILE", path)
	t.Setenv("PORTAL_PROXY_CONTROL_URL", "https://controller.example.test:18791")
	for _, size := range []int{0, 31, 33, 64} {
		if err := os.WriteFile(path, bytes.Repeat([]byte{1}, size), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadConfig(); err == nil {
			t.Fatal("invalid key accepted", size)
		}
	}
	if err := os.WriteFile(path, bytes.Repeat([]byte{1}, 32), 0600); err != nil {
		t.Fatal(err)
	}
	if config, err := LoadConfig(); err != nil || len(config.ProxyControl.Key) != 32 {
		t.Fatal(err)
	}
	t.Setenv("PORTAL_MONITORING_ADMIN_URL", "http://monitoring-admin:8080/admin")
	t.Setenv("PORTAL_MONITORING_ADMIN_KEY_FILE", path)
	if _, err := LoadConfig(); err == nil {
		t.Fatal("shared application key accepted")
	}
	r := proxyRequest("POST", "/api/v1/mode", "", true)
	for _, tc := range []struct{ aud, scope string }{{"proxy-control", "containers:restart"}, {"monitoring-admin", "proxy:mode"}, {"websites-admin", "proxy:read"}} {
		if err := signGatewayRequest(r, nil, current(r), tc.aud, []string{tc.scope}, bytes.Repeat([]byte{1}, 32), time.Now(), true, "10.0.0.9"); err == nil {
			t.Fatal("cross-application scope accepted", tc)
		}
	}
}

//go:build optional_module_acceptance

package server

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
)

// Optional local real FastAPI acceptance. Only explicit loopback endpoints are
// permitted; production databases, credentials and host mounts must not be used.
func TestGatewayRealPythonRuntime(t *testing.T) {
	for _, entry := range []struct{ aud, env, path string }{{"monitoring-admin", "PORTAL_TEST_MONITORING_GATEWAY_URL", "/admin/"}, {"websites-admin", "PORTAL_TEST_WEBSITES_GATEWAY_URL", "/websites/"}} {
		t.Run(entry.aud, func(t *testing.T) {
			endpoint := os.Getenv(entry.env)
			if endpoint == "" {
				t.Fatal("explicit isolated Python runtime is required")
			}
			u, err := url.Parse(endpoint)
			if err != nil || u.Scheme != "http" || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost") || u.User != nil {
				t.Fatal("runtime must be loopback")
			}
			key := []byte("0123456789abcdef0123456789abcdef")
			if keyPath := os.Getenv(entry.env + "_KEY_FILE"); keyPath != "" {
				key, err = os.ReadFile(keyPath)
				if err != nil {
					t.Fatal(err)
				}
			}
			s := apiFixture(t)
			s.Config.PublicURL = "https://platform.example.test"
			admin := apiUser(t, s, "ad:joint-runtime", true)
			viewer := apiUser(t, s, "ad:joint-board", false)
			transport := &http.Transport{Proxy: nil}
			defer transport.CloseIdleConnections()
			h := s.ServiceGateway(ServiceGatewayConfig{Audience: entry.aud, Upstream: strings.TrimRight(endpoint, "/") + entry.path, Key: key, Transport: transport})
			call := func(who apiIdentity, method, path, body, csrf string) *httptest.ResponseRecorder {
				r := httptest.NewRequest(method, s.Config.PublicURL+path, strings.NewReader(body))
				r.RemoteAddr = "192.0.2.10:12345"
				r.Header.Set("Origin", s.Config.PublicURL)
				r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
				if who.cookie != nil {
					r.AddCookie(who.cookie)
				}
				if csrf != "" {
					r.Header.Set("X-CSRF-Token", csrf)
				}
				w := httptest.NewRecorder()
				h.ServeHTTP(w, r)
				return w
			}
			w := call(admin, "GET", entry.path, "", "")
			if w.Code != 200 {
				t.Fatalf("actual FastAPI page: %d %s", w.Code, w.Body.String())
			}
			if strings.Contains(w.Body.String(), admin.cookie.Value) || strings.Contains(w.Body.String(), admin.csrf) {
				t.Fatal("portal credentials leaked")
			}
			if w := call(viewer, "GET", entry.path, "", ""); w.Code != 403 {
				t.Fatal("board", w.Code)
			}
			if w := call(apiIdentity{}, "GET", entry.path, "", ""); w.Code != 303 {
				t.Fatal("anonymous", w.Code)
			}
			unsigned, _ := http.NewRequest("GET", strings.TrimRight(endpoint, "/")+entry.path, nil)
			unsigned.Host = "platform.example.test"
			response, err := transport.RoundTrip(unsigned)
			if err != nil {
				t.Fatal(err)
			}
			io.Copy(io.Discard, response.Body)
			response.Body.Close()
			if response.StatusCode != 401 {
				t.Fatal("direct unsigned accepted", response.StatusCode)
			}
			if entry.aud == "monitoring-admin" {
				w := call(admin, "GET", "/admin/api/v1/session", "", "")
				if w.Code != 200 || !bytes.Contains(w.Body.Bytes(), []byte("ad:joint-runtime")) {
					t.Fatalf("session: %d %s", w.Code, w.Body.String())
				}
				if w := call(admin, "POST", "/admin/api/v1/containers/test/restart", "", "bad"); w.Code != 403 {
					t.Fatal("CSRF", w.Code)
				}
			} else {
				w := call(admin, "GET", "/websites/add", "", "")
				if w.Code != 200 {
					t.Fatalf("form: %d %s", w.Code, w.Body.String())
				}
				derived := gatewayServiceCSRF(admin.csrf, entry.aud)
				if !bytes.Contains(w.Body.Bytes(), []byte(derived)) {
					t.Fatal("form lacks session-derived CSRF")
				}
				form := url.Values{"url": {"https://example.net/"}, "csrf_token": {derived}}.Encode()
				preview := call(admin, "POST", "/websites/add/preview", form, "")
				if preview.Code != 200 || !bytes.Contains(preview.Body.Bytes(), []byte("operation_token")) {
					t.Fatalf("real preview: %d %s", preview.Code, preview.Body.String())
				}
				if w := call(admin, "POST", "/websites/add/preview", "csrf_token=bad", ""); w.Code != 403 {
					t.Fatal("form CSRF", w.Code)
				}
			}
		})
	}
}

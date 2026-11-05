package server

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pl/portal/internal/model"
)

func proxyConfigEnvironment(t *testing.T) string {
	t.Helper()
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(name, "PORTAL_") || name == "AUDITOR_HOT_GATEWAY_KEY_FILE" || name == "AUDITOR_ARCH_GATEWAY_KEY_FILE" {
			t.Setenv(name, "")
		}
	}
	t.Setenv("PORTAL_DATABASE_URL", "postgres://unused.example.test/test")
	t.Setenv("PORTAL_DEMO", "true")
	t.Setenv("PORTAL_PUBLIC_URL", "http://portal.example.test")
	path := filepath.Join(t.TempDir(), "test-key")
	if err := os.WriteFile(path, bytes.Repeat([]byte{19}, 32), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestProxyControlConfigurationPair(t *testing.T) {
	keyFile := proxyConfigEnvironment(t)
	for _, tc := range []struct {
		name, origin, key string
		valid             bool
	}{
		{"disabled", "", "", true}, {"missing-key", "https://controller.example.test", "", false}, {"missing-url", "", keyFile, false},
		{"https", "https://controller.example.test", keyFile, true}, {"http", "http://controller.example.test:18791", keyFile, true},
		{"ipv4", "http://192.0.2.9:18791", keyFile, true}, {"ipv6", "https://[2001:db8::1]:8443", keyFile, true},
		{"missing-file", "https://controller.example.test", keyFile + "-missing", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("PORTAL_PROXY_CONTROL_URL", tc.origin)
			t.Setenv("PORTAL_PROXY_CONTROL_KEY_FILE", tc.key)
			c, err := LoadConfig()
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%t: %v", tc.valid, err)
			}
			if err == nil && c.ProxyControl.Origin != tc.origin {
				t.Fatal("origin changed")
			}
			if tc.name == "disabled" && len(c.ProxyControl.Key) != 0 {
				t.Fatal("disabled key configured")
			}
		})
	}
}

func TestProxyControlConfigurationRejectsMalformedOriginWithoutDisclosure(t *testing.T) {
	keyFile := proxyConfigEnvironment(t)
	t.Setenv("PORTAL_PROXY_CONTROL_KEY_FILE", keyFile)
	for _, origin := range []string{
		"http://", "//controller.example.test", "ftp://controller.example.test", "HTTP://controller.example.test",
		"https:controller.example.test", "http:///controller.example.test", "http://controller.example.test/",
		"http://controller.example.test/api", "http://controller.example.test/%2e%2e", "http://controller.example.test?",
		"http://controller.example.test?q=private-canary", "http://controller.example.test#", "http://controller.example.test#private-canary",
		"http://user:private-canary@controller.example.test", "http://@controller.example.test",
		" http://controller.example.test", "http://controller.example.test ", "http://controller.example.test\n",
		"http://controller.example.test\t", "http://controller.example.test\x7f", "http://controller.example.test\u00a0",
		"http://controller.example.test\\other", "http://controller%2eexample.test", "http://controller.example.test:",
		"http://controller.example.test:0", "http://controller.example.test:65536", "http://controller.example.test:abc",
		"http://controller.example.test:080", "http://:8080", "http://[not-ip]", "http://[192.0.2.9]",
		"http://2001:db8::1", "http://controller..example.test", "http://controller.example.test.",
		"http://-controller.example.test", "http://controller_.example.test", "http://127.1", "http://0177.0.0.1", "http://2130706433",
	} {
		t.Setenv("PORTAL_PROXY_CONTROL_URL", origin)
		_, err := LoadConfig()
		if err == nil {
			t.Fatalf("invalid origin accepted: %q", origin)
		}
		if strings.Contains(err.Error(), "private-canary") || strings.Contains(err.Error(), origin) || strings.Contains(err.Error(), keyFile) {
			t.Fatal("configuration error disclosed input")
		}
	}
}

func TestProxyControlDisabledNeverDials(t *testing.T) {
	for _, cfg := range []ProxyControlConfig{{}, {Origin: "https://controller.example.test"}, {Key: bytes.Repeat([]byte{1}, 32)}, {Origin: "https://controller.example.test/", Key: bytes.Repeat([]byte{1}, 32)}} {
		cfg.Transport = proxyRoundTrip(func(*http.Request) (*http.Response, error) { t.Fatal("disabled controller dialed"); return nil, nil })
		s := &Server{Config: Config{ProxyControl: cfg}}
		w := httptest.NewRecorder()
		s.proxyControlHandler()(w, proxyRequest("GET", "/api/v1/proxy-control/status", "", true))
		if w.Code != 503 || !strings.Contains(w.Body.String(), "proxy_unconfigured") {
			t.Fatal(w.Code, w.Body.String())
		}
	}
}

func TestProxyControlMachineIdentityDenied(t *testing.T) {
	s := &Server{Config: Config{ProxyControl: ProxyControlConfig{Origin: "https://controller.example.test", Key: bytes.Repeat([]byte{1}, 32)}}}
	r := proxyRequest("GET", "/api/v1/proxy-control/status", "", true)
	r = r.WithContext(context.WithValue(r.Context(), sessionKey, session{User: model.User{ID: "machine:test", Admin: true}}))
	w := httptest.NewRecorder()
	s.proxyControlHandler()(w, r)
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
}

func TestProxyControlBackendTransportFailureNoRetryOrDisclosure(t *testing.T) {
	for _, method := range []string{"GET", "POST"} {
		calls := 0
		cfg := ProxyControlConfig{Origin: "https://controller.example.test", Key: bytes.Repeat([]byte{1}, 32), Transport: proxyRoundTrip(func(r *http.Request) (*http.Response, error) {
			calls++
			if method == "POST" && r.Header.Get("Idempotency-Key") != "test-operation" {
				t.Fatal("idempotency lost")
			}
			return nil, errors.New("private-canary")
		})}
		path, body := "/api/v1/proxy-control/status", ""
		if method == "POST" {
			path = "/api/v1/proxy-control/mode"
			body = `{"mode":"auto","expected_revision":1}`
		}
		w := httptest.NewRecorder()
		(&Server{Config: Config{ProxyControl: cfg}}).proxyControlHandler()(w, proxyRequest(method, path, body, true))
		if w.Code != 502 || calls != 1 || strings.Contains(w.Body.String(), "private-canary") {
			t.Fatal(w.Code, calls, w.Body.String())
		}
		if method == "POST" && !strings.Contains(w.Body.String(), "Результат переключения неизвестен") {
			t.Fatal(w.Body.String())
		}
	}
}

func TestProxyControlRedirectNeverFollowed(t *testing.T) {
	calls := 0
	cfg := ProxyControlConfig{Origin: "https://controller.example.test", Key: bytes.Repeat([]byte{1}, 32), Transport: proxyRoundTrip(func(r *http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: 302, Header: http.Header{"Location": []string{"https://other.example.test"}}, Body: io.NopCloser(strings.NewReader(`{}`))}, nil
	})}
	w := httptest.NewRecorder()
	(&Server{Config: Config{ProxyControl: cfg}}).proxyControlHandler()(w, proxyRequest("GET", "/api/v1/proxy-control/status", "", true))
	if w.Code != 502 || calls != 1 {
		t.Fatal(w.Code, calls)
	}
}

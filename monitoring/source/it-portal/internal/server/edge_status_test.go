package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"pl/portal/internal/model"
	"strings"
	"testing"
	"time"
)

func edgeRequest(admin bool) *http.Request {
	r := httptest.NewRequest("GET", "/api/v1/edge/status", nil)
	return r.WithContext(context.WithValue(r.Context(), sessionKey, session{User: model.User{ID: "fixture", Admin: admin}}))
}
func TestEdgeStatusProjectionAndFailures(t *testing.T) {
	for _, tc := range []struct {
		name, body     string
		upstream, want int
	}{
		{"running", `{"success":true,"msg":"secret-token","obj":{"xray":{"state":"running","version":"26.2.6","errorMsg":"secret-token"},"users":["secret-token"]}}`, 200, 200},
		{"stopped", `{"success":true,"obj":{"xray":{"state":"stop","version":"26.2.6"}}}`, 200, 200},
		{"error", `{"success":true,"obj":{"xray":{"state":"error","version":"26.2.6","errorMsg":"secret-token"}}}`, 200, 200},
		{"unknown", `{"success":true,"obj":{"xray":{"state":"healthy"}}}`, 200, 502},
		{"empty", `{"success":true,"obj":{}}`, 200, 502},
		{"api-failed", `{"success":false,"msg":"secret-token"}`, 200, 502},
		{"bad-json", `secret-token`, 200, 502},
		{"bad-type", `{"success":true,"obj":{"xray":{"state":true}}}`, 200, 502},
		{"unauthorized", `secret-token`, 401, 502},
		{"redirect", `secret-token`, 302, 502},
		{"oversize", strings.Repeat("s", (1<<20)+1), 200, 502},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.Method != "GET" || r.URL.Path != "/private-prefix/panel/api/server/status" || r.URL.RawQuery != "" || r.Header.Get("Authorization") != "Bearer secret-token" || r.Header.Get("Cookie") != "" {
					t.Error("unexpected upstream request")
				}
				w.Header().Set("Location", "/secret-token")
				w.WriteHeader(tc.upstream)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer upstream.Close()
			h := (&Server{}).edgeStatusHandler(EdgeConfig{endpoint: upstream.URL + "/private-prefix/panel/api/server/status", token: "secret-token", transport: upstream.Client().Transport})
			w := httptest.NewRecorder()
			h(w, edgeRequest(true))
			if w.Code != tc.want || calls != 1 {
				t.Fatalf("status=%d calls=%d", w.Code, calls)
			}
			for _, secret := range []string{"secret-token", "private-prefix", "errorMsg", "users", upstream.URL} {
				if strings.Contains(w.Body.String(), secret) {
					t.Fatal("unsafe response projection")
				}
			}
			if tc.want == 200 {
				var data edgeStatus
				if json.Unmarshal(w.Body.Bytes(), &data) != nil || !data.Configured || data.ObservedAt.IsZero() || time.Since(data.ObservedAt) > time.Minute {
					t.Fatal("invalid projection")
				}
			}
		})
	}
}
func TestEdgeStatusAccessAndDisabled(t *testing.T) {
	h := (&Server{}).edgeStatusHandler(EdgeConfig{})
	for _, tc := range []struct {
		r    *http.Request
		want int
	}{{httptest.NewRequest("GET", "/api/v1/edge/status", nil), 403}, {edgeRequest(false), 403}, {edgeRequest(true), 503}} {
		w := httptest.NewRecorder()
		h(w, tc.r)
		if w.Code != tc.want {
			t.Fatal(w.Code)
		}
	}
	machine := edgeRequest(true)
	machine = machine.WithContext(context.WithValue(machine.Context(), sessionKey, session{User: model.User{ID: "machine:test", Admin: true}}))
	w := httptest.NewRecorder()
	h(w, machine)
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
	mutation := edgeRequest(true)
	mutation.Method = "POST"
	w = httptest.NewRecorder()
	h(w, mutation)
	if w.Code != 405 {
		t.Fatal(w.Code)
	}
	query := edgeRequest(true)
	query.URL.RawQuery = "target=evil"
	w = httptest.NewRecorder()
	h(w, query)
	if w.Code != 400 {
		t.Fatal(w.Code)
	}
}
func TestEdgeStatusTLSVerification(t *testing.T) {
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("untrusted TLS accepted") }))
	defer upstream.Close()
	h := (&Server{}).edgeStatusHandler(EdgeConfig{endpoint: upstream.URL + "/panel/api/server/status", token: "secret-token"})
	w := httptest.NewRecorder()
	h(w, edgeRequest(true))
	if w.Code != 502 {
		t.Fatal(w.Code)
	}
}
func TestEdgeConfig(t *testing.T) {
	t.Setenv("PORTAL_EDGE_CONFIG_FILE", "")
	if c, e := loadEdgeConfig(); e != nil || c.endpoint != "" {
		t.Fatal("disabled config")
	}
	dir := t.TempDir()
	config := filepath.Join(dir, "edge.json")
	token := filepath.Join(dir, "token")
	if err := os.WriteFile(token, []byte("fixture-token\n"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PORTAL_EDGE_CONFIG_FILE", config)
	valid := `{"api_base_url":"https://edge.example.test/fixed","token_file":"token"}`
	for _, raw := range []string{valid, `{"api_base_url":"http://edge.test","token_file":"token"}`, `{"api_base_url":"https://edge.test","token_file":"token","unknown":true}`, `{"api_base_url":"https://edge.test","api_base_url":"https://other.test","token_file":"token"}`, `{"api_base_url":"https://edge.test","token_file":"../token"}`, valid + `{}`, `{"api_base_url":"https://edge.test","token_file":null}`} {
		if err := os.WriteFile(config, []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
		c, err := loadEdgeConfig()
		if raw == valid {
			if err != nil || c.endpoint != "https://edge.example.test/fixed/panel/api/server/status" || c.token != "fixture-token" {
				t.Fatal("valid config rejected")
			}
		} else if err == nil {
			t.Fatal("invalid config accepted")
		}
	}
	for _, raw := range []string{"https://user:secret@edge.test", "https://edge.test/?x=secret", "https://edge.test/#secret", "https://edge.test/%2e%2e", "https://edge.test/a/../b", "https://edge.test/a//b", "https://edge.test/a%2fb", "https://edge.test:0", "https://edge.test:65536", "https://edge.test:", "https://edge.test/#", "https://edge.test/?", "https://é.test", "https://edge.test/" + strings.Repeat("a", 4096)} {
		if _, ok := edgeEndpoint(raw); ok {
			t.Fatal("unsafe endpoint accepted")
		}
	}
	if err := os.WriteFile(config, []byte(valid), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(token, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := loadEdgeConfig(); err == nil {
		t.Fatal("public token accepted")
	}
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(outside, []byte("fixture-token"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(token); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, token); err != nil {
		t.Fatal(err)
	}
	if _, err := loadEdgeConfig(); err == nil {
		t.Fatal("symlink escape accepted")
	}
}

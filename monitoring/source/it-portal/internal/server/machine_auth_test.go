package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
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

func TestMachineAuth(t *testing.T) {
	token := strings.Repeat("secret", 8)
	digest := sha256.Sum256([]byte(token))
	file := filepath.Join(t.TempDir(), "machine.json")
	principal := machinePrincipal{ID: "mcp", TokenSHA256: hex.EncodeToString(digest[:]), Scopes: []string{"catalog:read", "catalog:write"}, ExpiresAt: time.Now().Add(time.Hour)}
	write := func(p machinePrincipal) {
		t.Helper()
		b, _ := json.Marshal(map[string]any{"principals": []machinePrincipal{p}})
		if err := os.WriteFile(file, b, 0600); err != nil {
			t.Fatal(err)
		}
	}
	write(principal)
	s := &Server{Config: Config{MachineCredentialsFile: file}}
	handler := s.auth(func(w http.ResponseWriter, r *http.Request) {
		if current(r).User.ID != "machine:mcp" || !current(r).User.Admin {
			t.Error("missing scoped machine identity")
		}
		w.WriteHeader(204)
	}, true)
	for _, tc := range []struct {
		name, method, path, auth, header string
		want                             int
	}{
		{"read", "GET", "/api/v1/resources", "Bearer " + token, "", 204},
		{"write without csrf", "POST", "/api/v1/resources", "Bearer " + token, "", 204},
		{"denied scope", "POST", "/api/v1/candidates/resolve", "Bearer " + token, "", 403},
		{"denied settings", "GET", "/api/v1/settings", "Bearer " + token, "", 403},
		{"bad credential", "GET", "/api/v1/resources", "Bearer " + strings.Repeat("x", 48), "", 401},
		{"empty credential no cookie fallback", "GET", "/api/v1/resources", "", "", 401},
		{"browser origin", "GET", "/api/v1/resources", "Bearer " + token, "Origin", 401},
		{"cookie", "GET", "/api/v1/resources", "Bearer " + token, "Cookie", 401},
		{"encoded path", "GET", "/api/v1/%72esources", "Bearer " + token, "", 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, tc.path, nil)
			r.Header.Set("Authorization", tc.auth)
			if tc.header != "" {
				r.Header.Set(tc.header, "")
			}
			w := httptest.NewRecorder()
			handler(w, r)
			if w.Code != tc.want {
				t.Fatalf("got %d want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if strings.Contains(w.Body.String(), token) {
				t.Fatal("credential leaked")
			}
		})
	}
	// The same handler immediately observes file rotation and expiry.
	for _, mode := range []string{"expired", "unknown scope", "invalid file", "revoked", "disabled"} {
		t.Run(mode, func(t *testing.T) {
			write(principal)
			p := principal
			switch mode {
			case "expired":
				p.ExpiresAt = time.Now().Add(-time.Second)
				write(p)
			case "unknown scope":
				p.Scopes = []string{"admin"}
				write(p)
			case "invalid file":
				os.WriteFile(file, []byte(`{"principals":[]}`+`{}`), 0600)
			case "revoked":
				os.WriteFile(file, []byte(`{"principals":[]}`), 0600)
			case "disabled":
				s.Config.MachineCredentialsFile = ""
			}
			r := httptest.NewRequest("GET", "/api/v1/resources", nil)
			r.Header.Set("Authorization", "Bearer "+token)
			w := httptest.NewRecorder()
			handler(w, r)
			if w.Code != 401 {
				t.Fatalf("got %d", w.Code)
			}
		})
	}
}

func TestMachineScope(t *testing.T) {
	id := "a5aa84ea-0979-4fd4-a7f8-953c27dc0d87"
	for _, tc := range []struct{ method, path, want string }{
		{"GET", "/api/v1/search", "catalog:read"}, {"GET", "/api/v1/resources/" + id, "catalog:read"}, {"GET", "/api/v1/resources/" + id + "/inventory", "catalog:read"},
		{"GET", "/api/v1/problems/" + id + "/links", "catalog:read"}, {"PUT", "/api/v1/problems/" + id + "/links", "problems:write"}, {"PUT", "/api/v1/resources/" + id, "catalog:write"},
		{"POST", "/api/v1/candidates/resolve", "discovery:write"},
		{"GET", "/api/v1/integrations", ""}, {"GET", "/api/v1/export", ""}, {"GET", "/api/v1/runtime", ""}, {"GET", "/api/v1/jobs", ""}, {"GET", "/api/v1/session", ""}, {"POST", "/auth/logout", ""}, {"GET", "/wayline/", ""},
		{"DELETE", "/api/v1/resources/" + id, ""}, {"GET", "/api/v1/resources/nope", ""}, {"GET", "/api/v1/resources/" + id + "/", ""}, {"GET", "/api/v1/resources/" + id + "/inventory/extra", ""},
	} {
		if got := machineScope(tc.method, tc.path); got != tc.want {
			t.Errorf("%s %s: %q want %q", tc.method, tc.path, got, tc.want)
		}
	}
}

func TestMachineAPIAudit(t *testing.T) {
	s := apiFixture(t)
	token := strings.Repeat("machine-token-", 4)
	digest := sha256.Sum256([]byte(token))
	file := filepath.Join(t.TempDir(), "machine.json")
	principal := machinePrincipal{ID: "MCP", TokenSHA256: hex.EncodeToString(digest[:]), Scopes: []string{"catalog:read", "catalog:write"}, ExpiresAt: time.Now().Add(time.Hour)}
	write := func() {
		t.Helper()
		b, _ := json.Marshal(map[string]any{"principals": []machinePrincipal{principal}})
		if e := os.WriteFile(file, b, 0600); e != nil {
			t.Fatal(e)
		}
	}
	write()
	s.Config.MachineCredentialsFile = file
	call := func(method, path, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if len(w.Result().Cookies()) != 0 {
			t.Fatal("machine response issued cookies")
		}
		return w
	}
	result := call("POST", "/api/v1/resources", `{"name":"MCP app","type":"Веб-сервис","url":"https://app.example.test","lifecycle":"active"}`)
	resource := apiDecode[model.Resource](t, result, 201)
	events, e := s.Store.Events(context.Background(), true)
	if e != nil {
		t.Fatal(e)
	}
	found := false
	for _, event := range events {
		if event.Kind == "resource.saved" && event.ResourceID == resource.ID && event.Actor == "machine:MCP" {
			found = true
		}
	}
	if !found {
		t.Fatal("machine actor missing from audit")
	}

	for _, tc := range []struct {
		name   string
		change func(*model.Resource)
	}{
		{"executor_target", func(v *model.Resource) { v.ExecutorTarget = "production-host" }},
		{"operations", func(v *model.Resource) { v.Operations = []string{"restart"} }},
		{"check", func(v *model.Resource) {
			v.Check = model.Check{Kind: "http", Target: "https://other.example.test", IntervalSeconds: 60}
		}},
		{"lifecycle", func(v *model.Resource) { v.Lifecycle = "archived" }},
	} {
		t.Run("protected_"+tc.name, func(t *testing.T) {
			changed := resource
			tc.change(&changed)
			body, _ := json.Marshal(changed)
			for _, method := range []string{"POST", "PUT"} {
				path := "/api/v1/resources"
				if method == "PUT" {
					path += "/" + resource.ID
				}
				if w := call(method, path, string(body)); w.Code != 403 {
					t.Fatalf("%s protected %s: %d %s", method, tc.name, w.Code, w.Body.String())
				}
			}
			actual := apiDecode[model.Resource](t, call("GET", "/api/v1/resources/"+resource.ID, ""), 200)
			if actual.Revision != resource.Revision {
				t.Fatal("rejected write changed revision")
			}
		})
	}
	// A normal catalog edit keeps runtime settings intact and remains permitted.
	resource.Description = "Updated via MCP"
	body, _ := json.Marshal(resource)
	resource = apiDecode[model.Resource](t, call("PUT", "/api/v1/resources/"+resource.ID, string(body)), 200)
	principal.Scopes = []string{"catalog:read"}
	write()
	if w := call("POST", "/api/v1/resources", `{}`); w.Code != 403 {
		t.Fatalf("read-only write: %d", w.Code)
	}
	if w := call("GET", "/api/v1/resources/"+resource.ID, ""); w.Code != 200 {
		t.Fatalf("read: %d", w.Code)
	}
	principal.ExpiresAt = time.Now().Add(-time.Second)
	write()
	if w := call("GET", "/api/v1/resources", ""); w.Code != 401 {
		t.Fatalf("expiry: %d", w.Code)
	}
}

func TestMachineCannotReadBrowserSession(t *testing.T) {
	s := &Server{}
	r := httptest.NewRequest("GET", "/api/v1/session", nil)
	r.Header.Set("Authorization", "Bearer "+strings.Repeat("x", 48))
	r.AddCookie(&http.Cookie{Name: "portal_session", Value: "existing"})
	if _, e := s.readSession(r); e == nil {
		t.Fatal("machine used browser session")
	}
}

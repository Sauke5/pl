package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDoskaDirectoryMachineScopeIsolation(t *testing.T) {
	token := strings.Repeat("test-only-doska-directory-", 2)
	digest := sha256.Sum256([]byte(token))
	p := machinePrincipal{ID: "doska-directory", TokenSHA256: hex.EncodeToString(digest[:]), Scopes: []string{"doska:directory:read"}, ExpiresAt: time.Now().Add(time.Hour)}
	file := filepath.Join(t.TempDir(), "machine.json")
	body, err := json.Marshal(map[string]any{"principals": []machinePrincipal{p}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, body, 0600); err != nil {
		t.Fatal(err)
	}
	s := &Server{Config: Config{MachineCredentialsFile: file}}
	for _, tc := range []struct {
		method, path, header string
		status               int
	}{
		{"GET", "/api/v1/doska-directory/identity", "", 204},
		{"GET", "/api/v1/doska-directory/employees", "", 204},
		{"GET", "/api/v1/doska-directory/departments", "", 204},
		{"GET", "/api/v1/doska-directory/changes", "", 204},
		{"POST", "/api/v1/doska-directory/employees", "", 403},
		{"HEAD", "/api/v1/doska-directory/identity", "", 403},
		{"GET", "/api/v1/doska-directory/identity/", "", 403},
		{"GET", "/api/v1/doska-directory/identity-extra", "", 403},
		{"GET", "/api/v1/resources", "", 403},
		{"GET", "/api/v1/audit", "", 403},
		{"GET", "/api/v1/doska-directory/identity", "Cookie", 401},
		{"GET", "/api/v1/doska-directory/identity", "Origin", 401},
	} {
		r := httptest.NewRequest(tc.method, tc.path, nil)
		r.Header.Set("Authorization", "Bearer "+token)
		if tc.header != "" {
			r.Header.Set(tc.header, "test-only-browser-value")
		}
		w := httptest.NewRecorder()
		s.machineAuth(func(w http.ResponseWriter, r *http.Request) {
			if current(r).User.ID != "machine:doska-directory" {
				t.Fatal("wrong machine identity")
			}
			w.WriteHeader(http.StatusNoContent)
		}, w, r)
		if w.Code != tc.status {
			t.Errorf("%s %s %s: got %d want %d", tc.method, tc.path, tc.header, w.Code, tc.status)
		}
	}
}

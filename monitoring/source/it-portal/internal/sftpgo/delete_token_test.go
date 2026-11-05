package sftpgo

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDeleteFileNativeTokenIsScopedAndPrivate(t *testing.T) {
	password := strings.Repeat("p", 64)
	token := strings.Repeat("t", 64)
	tokens, deletes := 0, 0
	c := fixtureClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v2/user/token" {
			tokens++
			user, pass, ok := r.BasicAuth()
			if !ok || user != "portal-deleter" || pass != password || r.Method != "GET" || r.Header.Get("X-SFTPGO-API-KEY") != "" {
				t.Error("token authentication not scoped")
			}
			json.NewEncoder(w).Encode(map[string]string{"access_token": token})
			return
		}
		if r.Method == "DELETE" {
			deletes++
			if r.Header.Get("Authorization") != "Bearer "+token || r.Header.Get("X-SFTPGO-API-KEY") != "" {
				t.Error("DELETE did not use ephemeral user token")
			}
			w.Write([]byte(`{}`))
			return
		}
		t.Error("unexpected request")
	})
	c.deleteCredentialFile = filepath.Join(t.TempDir(), "credential.json")
	data, _ := json.Marshal(deleteCredential{Username: "portal-deleter", Password: password})
	os.WriteFile(c.deleteCredentialFile, data, 0600)
	if e := c.DeleteFile(context.Background(), "/collections/12345678-1234-1234-1234-123456789abc/file.zip"); e != nil {
		t.Fatal(e)
	}
	if tokens != 1 || deletes != 1 || c.bearerToken != "" {
		t.Fatal("token persisted or automatic write retry")
	}
}
func TestDeleteTokenFailureDoesNotIssueDeleteOrLeakSecrets(t *testing.T) {
	for _, mode := range []string{"401", "malformed", "oversized", "redirect"} {
		t.Run(mode, func(t *testing.T) {
			writes := 0
			c := fixtureClient(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "DELETE" {
					writes++
					return
				}
				switch mode {
				case "401":
					w.WriteHeader(401)
					w.Write([]byte("secret-upstream-body"))
				case "malformed":
					w.Write([]byte(`{"access_token":"short-secret"}`))
				case "oversized":
					w.Write([]byte(strings.Repeat("s", 16385)))
				case "redirect":
					w.Header().Set("Location", "https://untrusted.invalid/")
					w.WriteHeader(307)
				}
			})
			c.deleteCredentialFile = filepath.Join(t.TempDir(), "credentials.json")
			os.WriteFile(c.deleteCredentialFile, []byte(`{"username":"portal-deleter","password":"`+strings.Repeat("p", 64)+`"}`), 0600)
			e := c.DeleteFile(context.Background(), "/collections/12345678-1234-1234-1234-123456789abc/file.zip")
			if e == nil || writes != 0 || strings.Contains(e.Error(), "secret") || strings.Contains(e.Error(), strings.Repeat("p", 10)) {
				t.Fatalf("unsafe token failure %v writes%d", e, writes)
			}
		})
	}
}
func TestDeleteCredentialStrictFile(t *testing.T) {
	p := filepath.Join(t.TempDir(), "credentials.json")
	password := strings.Repeat("x", 64)
	for _, data := range []string{`{"username":"other","password":"` + password + `"}`, `{"username":"portal-deleter","password":"short"}`, `{"username":"portal-deleter","password":"` + strings.Repeat("x", 73) + `"}`, `{"username":"portal-deleter","password":"` + password + `","extra":"forbidden"}`, `{"username":"portal-deleter","password":"` + password + `"} {}`} {
		os.WriteFile(p, []byte(data), 0600)
		if _, e := readDeleteCredential(p); e == nil {
			t.Fatal("invalid credential accepted")
		}
	}
	os.WriteFile(p, []byte(`{"username":"portal-deleter","password":"`+password+`"}`), 0600)
	os.Chmod(p, 0644)
	if _, e := readDeleteCredential(p); e == nil {
		t.Fatal("world-readable credentials accepted")
	}
}

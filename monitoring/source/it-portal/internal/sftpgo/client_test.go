package sftpgo

import (
	"context"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func fixtureClient(t *testing.T, h http.HandlerFunc) *Client {
	t.Helper()
	srv := httptest.NewTLSServer(h)
	t.Cleanup(srv.Close)
	dir := t.TempDir()
	ca := filepath.Join(dir, "ca.pem")
	key := filepath.Join(dir, "key")
	if e := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}), 0600); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(key, []byte(strings.Repeat("x", 64)), 0600); e != nil {
		t.Fatal(e)
	}
	c, e := New(Config{URL: srv.URL, CAFile: ca, AdminKeyFile: key, ReaderKeyFile: key, DataRoot: "/srv/sftpgo/data"})
	if e != nil {
		t.Fatal(e)
	}
	return c
}
func fixtureUser() User {
	return User{Username: "branch", Role: "portal-sftp", HomeDir: "/srv/sftpgo/data/accounts/fixture", AdditionalInfo: ManagedMarker("fixture"), PublicKeys: []string{}, Permissions: map[string][]string{"/": {"upload"}}, Filesystem: map[string]any{"provider": 0}, MaxSessions: 2}
}
func TestProviderUncertainWriteReconcilesWithoutRetry(t *testing.T) {
	var mu sync.Mutex
	var stored *User
	writes := 0
	c := fixtureClient(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.Header.Get("X-SFTPGO-API-KEY") == "" {
			t.Error("credential missing")
		}
		if r.Method == "GET" {
			if stored == nil {
				w.WriteHeader(404)
				return
			}
			json.NewEncoder(w).Encode(stored)
			return
		}
		writes++
		var u User
		json.NewDecoder(r.Body).Decode(&u)
		stored = &u
		w.WriteHeader(500)
	})
	if e := c.EnsureUser(context.Background(), fixtureUser()); e != nil {
		t.Fatal(e)
	}
	if e := c.EnsureUser(context.Background(), fixtureUser()); e != nil {
		t.Fatal(e)
	}
	if writes != 1 {
		t.Fatalf("uncertain write repeated: %d", writes)
	}
}
func TestProviderUnknownOwnershipNeverAdopted(t *testing.T) {
	writes := 0
	c := fixtureClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			writes++
		}
		u := fixtureUser()
		u.AdditionalInfo = "unmanaged"
		json.NewEncoder(w).Encode(u)
	})
	if e := c.EnsureUser(context.Background(), fixtureUser()); !errors.Is(e, ErrConflict) {
		t.Fatalf("unknown identity adopted: %v", e)
	}
	if writes != 0 {
		t.Fatal("unmanaged identity mutated")
	}
}
func TestProviderAuthTimeoutAndUnconfirmedWrite(t *testing.T) {
	for _, code := range []int{401, 403} {
		t.Run(http.StatusText(code), func(t *testing.T) {
			requests := 0
			c := fixtureClient(t, func(w http.ResponseWriter, r *http.Request) { requests++; w.WriteHeader(code) })
			if e := c.EnsureUser(context.Background(), fixtureUser()); ErrorCode(e) != "provider_auth_denied" {
				t.Fatalf("unexpected: %v", e)
			}
			if requests != 1 {
				t.Fatal("write attempted after auth denial")
			}
		})
	}
	t.Run("timeout", func(t *testing.T) {
		c := fixtureClient(t, func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() })
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
		defer cancel()
		if e := c.EnsureUser(ctx, fixtureUser()); ErrorCode(e) != "provider_unavailable" {
			t.Fatalf("unexpected: %v", e)
		}
	})
	t.Run("uncertain-not-applied", func(t *testing.T) {
		writes := 0
		c := fixtureClient(t, func(w http.ResponseWriter, r *http.Request) {
			if r.Method == "GET" {
				w.WriteHeader(404)
				return
			}
			writes++
			w.WriteHeader(500)
		})
		if e := c.EnsureUser(context.Background(), fixtureUser()); ErrorCode(e) != "provider_error" {
			t.Fatalf("unconfirmed accepted: %v", e)
		}
		if writes != 1 {
			t.Fatal("blind repeated write")
		}
	})
}
func TestProviderRedirectDeniedAndPathBounded(t *testing.T) {
	c := fixtureClient(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://example.invalid/steal", 302)
	})
	if e := c.EnsureUser(context.Background(), fixtureUser()); ErrorCode(e) != "provider_error" {
		t.Fatalf("unexpected redirect: %v", e)
	}
	if _, _, e := c.OpenFile(context.Background(), "/collections/../secret"); ErrorCode(e) != "invalid_file_path" {
		t.Fatal("accepted unsafe file path")
	}
}
func TestProviderSetNormalization(t *testing.T) {
	a, b := fixtureUser(), fixtureUser()
	a.Filesystem = map[string]any{"provider": float64(0)}
	a.Filters.FilePatterns = []Pattern{{Path: "/", Denied: []string{"*"}, Allowed: []string{}}}
	b.Filters.FilePatterns = []Pattern{{Path: "/", Denied: []string{"*"}}}
	if !managedUserEqual(a, b) {
		t.Fatal("server empty-array normalization rejected")
	}
	a.Permissions["/"] = []string{"download"}
	if managedUserEqual(a, b) {
		t.Fatal("permission drift accepted")
	}
}

func TestProviderOwnershipIncludesRoleAndFilesystem(t *testing.T) {
	c := fixtureClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			t.Error("changed other-role identity")
		}
		u := fixtureUser()
		u.Role = "other"
		json.NewEncoder(w).Encode(u)
	})
	if e := c.EnsureUser(context.Background(), fixtureUser()); !errors.Is(e, ErrConflict) {
		t.Fatalf("other role adopted: %v", e)
	}
	for _, filesystem := range []map[string]any{{"provider": 1}, {"provider": 0, "cryptconfig": map[string]any{"passphrase": map[string]any{"status": "Redacted"}}}} {
		c := fixtureClient(t, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != "GET" {
				t.Error("changed unknown filesystem")
			}
			f := Folder{Name: "pl-id", MappedPath: "/srv/sftpgo/data/collections/id", Description: ManagedMarker("id"), Filesystem: filesystem}
			json.NewEncoder(w).Encode(f)
		})
		if e := c.EnsureFolder(context.Background(), c.Folder("id")); !errors.Is(e, ErrConflict) {
			t.Fatalf("nonlocal filesystem adopted: %v", e)
		}
	}
}

func TestProviderChangedPolicyDisconnectsExistingSessions(t *testing.T) {
	stored := fixtureUser()
	stored.Filesystem = map[string]any{"provider": float64(0)}
	stored.Status = 1
	writes := 0
	c := fixtureClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "PUT" {
			writes++
			if r.URL.Query().Get("disconnect") != "1" {
				t.Error("revocation left active session running")
			}
			json.NewDecoder(r.Body).Decode(&stored)
			w.WriteHeader(200)
			return
		}
		json.NewEncoder(w).Encode(stored)
	})
	want := fixtureUser()
	want.Status = 0
	if e := c.EnsureUser(context.Background(), want); e != nil {
		t.Fatal(e)
	}
	if e := c.EnsureUser(context.Background(), want); e != nil {
		t.Fatal(e)
	}
	if writes != 1 {
		t.Fatalf("no-op disconnected sessions: %d writes", writes)
	}
}

func TestProviderReceiverSenderSwitchRevokesPermissionsAndDisconnects(t *testing.T) {
	receiver := fixtureUser()
	receiver.Permissions = map[string][]string{"/": {"list"}, "/first": {"list", "download"}, "/second": {"list", "download"}}
	receiver.VirtualFolders = []VirtualFolder{{Folder: Folder{Name: "first", MappedPath: "/srv/sftpgo/data/collections/first"}, VirtualPath: "/first"}, {Folder: Folder{Name: "second", MappedPath: "/srv/sftpgo/data/collections/second"}, VirtualPath: "/second"}}
	receiver.Filters.FilePatterns = []Pattern{{Path: "/first", Denied: []string{".sftpgo-upload.*"}, DenyPolicy: 1}, {Path: "/second", Denied: []string{".sftpgo-upload.*"}, DenyPolicy: 1}}
	stored := receiver
	writes := 0
	c := fixtureClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "PUT" {
			writes++
			if r.URL.Query().Get("disconnect") != "1" {
				t.Error("type/grant change did not disconnect")
			}
			stored = User{}
			json.NewDecoder(r.Body).Decode(&stored)
			w.WriteHeader(200)
			return
		}
		json.NewEncoder(w).Encode(stored)
	})
	sender := fixtureUser()
	sender.QuotaSize = 1024
	sender.Permissions = map[string][]string{"/": {"upload"}, "/first": {"upload"}}
	sender.VirtualFolders = []VirtualFolder{{Folder: receiver.VirtualFolders[0].Folder, VirtualPath: "/first", QuotaSize: 1024, QuotaFiles: 5000}}
	if e := c.EnsureUser(context.Background(), sender); e != nil {
		t.Fatal(e)
	}
	if len(stored.Permissions) != 2 || !sameStrings(stored.Permissions["/first"], []string{"upload"}) || len(stored.VirtualFolders) != 1 {
		t.Fatal("receiver read/sibling access survived sender transition")
	}
	receiver.Permissions = map[string][]string{"/": {"list"}, "/first": {"list", "download"}}
	receiver.VirtualFolders = receiver.VirtualFolders[:1]
	receiver.Filters.FilePatterns = receiver.Filters.FilePatterns[:1]
	if e := c.EnsureUser(context.Background(), receiver); e != nil {
		t.Fatal(e)
	}
	if e := c.EnsureUser(context.Background(), receiver); e != nil {
		t.Fatal(e)
	}
	if writes != 2 || !sameStrings(stored.Permissions["/first"], []string{"list", "download"}) || stored.Role != "portal-sftp" {
		t.Fatalf("mode change/no-op/readback incorrect: writes=%d", writes)
	}
}
func TestProviderReadbackChecksAtomicTemporaryFileHidePolicy(t *testing.T) {
	a, b := fixtureUser(), fixtureUser()
	a.Filesystem = map[string]any{"provider": float64(0)}
	a.Filters.FilePatterns = []Pattern{{Path: "/folder", Denied: []string{".sftpgo-upload.*"}, DenyPolicy: 0}}
	b.Filters.FilePatterns = []Pattern{{Path: "/folder", Denied: []string{".sftpgo-upload.*"}, DenyPolicy: 1}}
	if managedUserEqual(a, b) {
		t.Fatal("native readback ignored temporary-file visibility policy")
	}
}

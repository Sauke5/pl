package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"github.com/google/uuid"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"pl/portal/internal/model"
	"pl/portal/internal/sftpgo"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestSFTPDeleteBrowserAuthorization(t *testing.T) {
	st := localAuthTestStore(t)
	ctx := context.Background()
	for _, user := range []string{"admin", "viewer"} {
		_, e := st.Pool.Exec(ctx, "INSERT INTO sessions(token_hash,user_id,user_name,admin,csrf,expires_at) VALUES($1,$2,$2,$3,'csrf',now()+interval '1 hour')", hash(user), user, user == "admin")
		if e != nil {
			t.Fatal(e)
		}
	}
	s := &Server{Store: st, Config: Config{PublicURL: "http://localhost"}}
	m := http.NewServeMux()
	s.registerSFTPRoutes(m)
	for _, tc := range []struct {
		user, csrf, auth string
		want             int
	}{{"", "", "", 401}, {"viewer", "csrf", "", 403}, {"admin", "", "", 403}, {"admin", "csrf", "Bearer machine", 401}, {"admin", "csrf", "", 503}} {
		r := httptest.NewRequest("DELETE", "/api/v1/sftp-server/versions/"+uuid.NewString(), nil)
		r.AddCookie(&http.Cookie{Name: "portal_session", Value: tc.user})
		r.Header.Set("X-CSRF-Token", tc.csrf)
		if tc.auth != "" {
			r.Header.Set("Authorization", tc.auth)
		}
		w := httptest.NewRecorder()
		m.ServeHTTP(w, r)
		if w.Code != tc.want {
			t.Fatalf("auth %s: %d %s", tc.user, w.Code, w.Body)
		}
	}
}
func TestSFTPDeleteReconcilesWithoutBlindWrite(t *testing.T) {
	for _, mode := range []string{"success", "uncertain-removed", "uncertain-retained", "identity-mismatch", "already-absent", "auth-denied"} {
		t.Run(mode, func(t *testing.T) {
			st := localAuthTestStore(t)
			ctx := context.Background()
			payload := []byte("synthetic archive")
			digest := sha256.Sum256(payload)
			c, e := st.SFTPSaveCollection(ctx, model.SFTPCollection{Branch: "Delete", Label: "Delete", Folder: "delete", QuotaBytes: 1024, ReaderIDs: []string{"admin"}}, "admin")
			if e != nil {
				t.Fatal(e)
			}
			_, e = st.SFTPReceiveRemote(ctx, model.SFTPVersion{CollectionID: c.ID, Filename: "file.zip", SizeBytes: int64(len(payload)), SHA256: hex.EncodeToString(digest[:]), ReceivedAt: time.Now(), ReceivedBy: "branch", ReceivedByName: "Branch"}, "/collections/"+c.ID+"/file.zip", "delete-event")
			if e != nil {
				t.Fatal(e)
			}
			state, e := st.SFTPState(ctx, "admin", true)
			if e != nil {
				t.Fatal(e)
			}
			id := state.Versions[0].ID
			_, e = st.Pool.Exec(ctx, "INSERT INTO sessions(token_hash,user_id,user_name,admin,csrf,expires_at) VALUES($1,'admin','Admin Name',true,'csrf',now()+interval '1 hour')", hash("admin"))
			if e != nil {
				t.Fatal(e)
			}
			exists := mode != "already-absent"
			writes := 0
			var mu sync.Mutex
			getWrites := func() int { mu.Lock(); defer mu.Unlock(); return writes }
			srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				defer mu.Unlock()
				folder := sftpgo.Folder{Name: "pl-" + c.ID, MappedPath: "/srv/sftpgo/data/collections/" + c.ID, Description: sftpgo.ManagedMarker(c.ID), Filesystem: map[string]any{"provider": 0}}
				if strings.HasPrefix(r.URL.Path, "/api/v2/folders/") {
					json.NewEncoder(w).Encode(folder)
					return
				}
				if r.URL.Path == "/api/v2/users/portal-deleter" {
					json.NewEncoder(w).Encode(sftpgo.User{Username: "portal-deleter", Status: 1, Role: "portal-sftp", HomeDir: "/srv/sftpgo/data", AdditionalInfo: sftpgo.ManagedMarker("portal-deleter"), Permissions: map[string][]string{"/": {"list"}, "/collections": {"list", "delete_files"}}, Filters: sftpgo.Filters{DeniedProtocols: []string{"SSH", "FTP", "DAV"}}, Filesystem: map[string]any{"provider": 0}, VirtualFolders: []sftpgo.VirtualFolder{{Folder: folder, VirtualPath: "/collections/" + c.ID, QuotaSize: 0, QuotaFiles: 0}}})
					return
				}
				if r.URL.Query().Get("path") != "/collections/"+c.ID+"/file.zip" && r.URL.Query().Get("path") != "/collections/"+c.ID {
					t.Error("arbitrary provider path")
				}
				if r.Method == "DELETE" {
					writes++
					if mode == "success" || mode == "uncertain-removed" {
						exists = false
					}
					if strings.HasPrefix(mode, "uncertain") {
						w.WriteHeader(500)
					} else if mode == "auth-denied" {
						w.WriteHeader(403)
					} else {
						w.Write([]byte(`{}`))
					}
					return
				}
				if r.URL.Path == "/api/v2/user/dirs" {
					entries := []sftpgo.DirEntry{}
					if exists {
						entries = append(entries, sftpgo.DirEntry{Name: "file.zip", Size: int64(len(payload))})
					}
					json.NewEncoder(w).Encode(entries)
					return
				}
				if !exists {
					w.WriteHeader(404)
					return
				}
				b := payload
				if mode == "identity-mismatch" {
					b = []byte("another archive")
				}
				w.Header().Set("Content-Length", fmt.Sprint(len(b)))
				w.Write(b)
			}))
			defer srv.Close()
			dir := t.TempDir()
			ca, key := filepath.Join(dir, "ca"), filepath.Join(dir, "key")
			os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}), 0600)
			os.WriteFile(key, []byte(strings.Repeat("x", 64)), 0600)
			client, e := sftpgo.New(sftpgo.Config{URL: srv.URL, CAFile: ca, AdminKeyFile: key, ReaderKeyFile: key, DeleteKeyFile: key, DataRoot: "/srv/sftpgo/data"})
			if e != nil {
				t.Fatal(e)
			}
			s := &Server{Store: st, Config: Config{SFTP: client, PublicURL: "http://localhost"}}
			m := http.NewServeMux()
			s.registerSFTPRoutes(m)
			request := func(method string) *httptest.ResponseRecorder {
				r := httptest.NewRequest(method, "/api/v1/sftp-server/versions/"+id, nil)
				r.AddCookie(&http.Cookie{Name: "portal_session", Value: "admin"})
				r.Header.Set("X-CSRF-Token", "csrf")
				w := httptest.NewRecorder()
				m.ServeHTTP(w, r)
				return w
			}
			want := 200
			if mode == "identity-mismatch" {
				want = 409
			}
			if mode == "uncertain-retained" {
				want = 503
			}
			if mode == "auth-denied" {
				want = 502
			}
			w := request("DELETE")
			if w.Code != want {
				t.Fatalf("delete %d %s", w.Code, w.Body)
			}
			expectedWrites := 1
			if mode == "identity-mismatch" || mode == "already-absent" {
				expectedWrites = 0
			}
			if getWrites() != expectedWrites {
				t.Fatalf("writes %d", getWrites())
			}
			if want == 200 {
				get := httptest.NewRequest("GET", "/api/v1/sftp-server/versions/"+id+"/download", nil)
				get.AddCookie(&http.Cookie{Name: "portal_session", Value: "admin"})
				gone := httptest.NewRecorder()
				m.ServeHTTP(gone, get)
				if gone.Code != 410 {
					t.Fatalf("deleted payload download %d %s", gone.Code, gone.Body)
				}
				w = request("DELETE")
				if w.Code != 200 || getWrites() != expectedWrites {
					t.Fatalf("idempotency %d writes %d", w.Code, getWrites())
				}
			}
			state, e = st.SFTPState(ctx, "admin", true)
			if e != nil {
				t.Fatal(e)
			}
			v := state.Versions[0]
			if len(state.Versions) != 1 {
				t.Fatal("upload history lost")
			}
			if want == 200 && (v.DeletionState != "deleted" || v.CanDownload || v.DeletedAt == nil) {
				t.Fatalf("deleted state %+v", v)
			}
			if mode == "uncertain-retained" && v.DeletionState != "uncertain" {
				t.Fatalf("ambiguous delete not retained %+v", v)
			}
			if mode == "uncertain-retained" {
				// The previous write may have removed the old file followed by a SAME-BYTES reupload.
				mu.Lock()
				exists = false
				exists = true
				mu.Unlock()
				w = request("DELETE")
				if w.Code != 503 || getWrites() != 1 {
					t.Fatal("destructive retry on ambiguous same-hash generation", w.Code, getWrites())
				}
				mu.Lock()
				exists = false
				mu.Unlock()
				w = request("DELETE")
				if w.Code != 200 || getWrites() != 1 {
					t.Fatal("absence reconciliation retried write", w.Code, getWrites())
				}
				mu.Lock()
				exists = true
				mu.Unlock()
				w = request("DELETE")
				if w.Code != 200 || getWrites() != 1 {
					t.Fatal("old tombstone deleted new file", w.Code, getWrites())
				}
			}
		})
	}
}

func TestSFTPDownloadBlocksDeletionDuringStaging(t *testing.T) {
	st := localAuthTestStore(t)
	ctx := context.Background()
	payload := []byte("synthetic concurrent payload")
	digest := sha256.Sum256(payload)
	c, e := st.SFTPSaveCollection(ctx, model.SFTPCollection{Branch: "Test", Label: "Test", Folder: "staging-delete", QuotaBytes: 1024, ReaderIDs: []string{"reader"}}, "admin")
	if e != nil {
		t.Fatal(e)
	}
	_, e = st.SFTPReceiveRemote(ctx, model.SFTPVersion{CollectionID: c.ID, Filename: "file.zip", SizeBytes: int64(len(payload)), SHA256: hex.EncodeToString(digest[:]), ReceivedAt: time.Now(), ReceivedBy: "branch", ReceivedByName: "Branch"}, "/collections/"+c.ID+"/file.zip", "staged-deletion")
	if e != nil {
		t.Fatal(e)
	}
	state, e := st.SFTPState(ctx, "reader", false)
	if e != nil {
		t.Fatal(e)
	}
	id := state.Versions[0].ID
	_, e = st.Pool.Exec(ctx, "INSERT INTO sessions(token_hash,user_id,user_name,admin,csrf,expires_at) VALUES($1,'reader','Reader',false,'csrf',now()+interval '1 hour')", hash("reader"))
	if e != nil {
		t.Fatal(e)
	}
	client := mockSFTPClient(t, func(w http.ResponseWriter, r *http.Request) {
		op, err := st.SFTPBeginDelete(ctx, id, "admin")
		if err != nil {
			t.Error(err)
			w.WriteHeader(500)
			return
		}
		op.Close()
		w.Header().Set("Content-Length", fmt.Sprint(len(payload)))
		w.Write(payload)
	})
	s := &Server{Store: st, Config: Config{SFTP: client, PublicURL: "http://localhost"}}
	m := http.NewServeMux()
	s.registerSFTPRoutes(m)
	r := httptest.NewRequest("GET", "/api/v1/sftp-server/versions/"+id+"/download", nil)
	r.AddCookie(&http.Cookie{Name: "portal_session", Value: "reader"})
	w := httptest.NewRecorder()
	m.ServeHTTP(w, r)
	if w.Code != 410 || strings.Contains(w.Body.String(), string(payload)) {
		t.Fatalf("staging bypassed deletion block %d %s", w.Code, w.Body)
	}
}

package server

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"

	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"golang.org/x/crypto/ssh"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"pl/portal/internal/model"
	"pl/portal/internal/sftpgo"
	"pl/portal/internal/store"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func sftpPublicKeyFixture(t *testing.T) string {
	t.Helper()
	pub, _, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	key, e := ssh.NewPublicKey(pub)
	if e != nil {
		t.Fatal(e)
	}
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key)))
}
func TestSFTPPublicKeyValidation(t *testing.T) {
	key := sftpPublicKeyFixture(t)
	if keys, e := normalizeSFTPPublicKeys([]string{key + " branch"}, true); e != nil || len(keys) != 1 || keys[0] != key {
		t.Fatal("valid public key rejected")
	}
	// Construct a rejected header, without embedding a private-key marker in
	// distributed source archives scanned for accidental credential material.
	privateHeader := strings.Join([]string{"-----BEGIN OPENSSH", "PRIVATE KEY-----"}, " ")
	for _, keys := range [][]string{{}, {privateHeader}, {key, key}, {"command=bad " + key}} {
		if _, e := normalizeSFTPPublicKeys(keys, true); e == nil {
			t.Fatal("unsafe keys accepted")
		}
	}
	if _, e := normalizeSFTPPublicKeys(nil, false); e != nil {
		t.Fatal("disabled account without key rejected")
	}
}
func mockSFTPClient(t *testing.T, h http.HandlerFunc) *sftpgo.Client {
	t.Helper()
	srv := httptest.NewTLSServer(h)
	t.Cleanup(srv.Close)
	dir := t.TempDir()
	ca, key := filepath.Join(dir, "ca"), filepath.Join(dir, "key")
	os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}), 0600)
	os.WriteFile(key, []byte(strings.Repeat("x", 64)), 0600)
	client, e := sftpgo.New(sftpgo.Config{URL: srv.URL, CAFile: ca, AdminKeyFile: key, ReaderKeyFile: key, DataRoot: "/srv/sftpgo/data"})
	if e != nil {
		t.Fatal(e)
	}
	return client
}
func TestSFTPNativeReceiptsDurableAndDuplicate(t *testing.T) {
	st := localAuthTestStore(t)
	ctx := context.Background()
	collection, e := st.SFTPSaveCollection(ctx, model.SFTPCollection{Branch: "Test", Label: "Test", Folder: "test", QuotaBytes: 1 << 20, ReaderIDs: []string{"viewer"}}, "admin")
	if e != nil {
		t.Fatal(e)
	}
	account, e := st.SFTPSaveAccount(ctx, model.SFTPAccount{Username: "branch", Label: "Branch", PublicKeys: []string{sftpPublicKeyFixture(t)}, Enabled: true, QuotaBytes: 1 << 20, CollectionIDs: []string{collection.ID}}, "admin")
	if e != nil {
		t.Fatal(e)
	}
	payloadSize := 100 << 20
	payload := bytes.Repeat([]byte("x"), 32768)
	event := sftpgo.Event{ID: "receipt-0000", Timestamp: time.Now().Add(-10 * time.Second).UnixNano(), Username: account.Username, Action: "upload", Status: 1, Protocol: "SFTP", FSPath: "/srv/sftpgo/data/collections/" + collection.ID + "/first.zip", VirtualPath: "/test/first.zip", FileSize: int64(payloadSize)}
	events := make([]sftpgo.Event, 600)
	for i := range events {
		events[i] = event
		events[i].ID = fmt.Sprintf("receipt-%04d", i)
		if i > 0 {
			events[i].FSPath = "/unmanaged/fixture.zip"
		}
	}
	pageRequests := 0
	var mu sync.Mutex
	folders := map[string]sftpgo.Folder{}
	users := map[string]sftpgo.User{}
	reads := 0
	client := mockSFTPClient(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		p := r.URL.Path
		switch {
		case p == "/api/v2/status":
			json.NewEncoder(w).Encode(map[string]any{"ok": true})
		case p == "/api/v2/events/fs":
			pageRequests++
			offset := 0
			if cursor := r.URL.Query().Get("from_id"); cursor != "" {
				index, err := strconv.Atoi(strings.TrimPrefix(cursor, "receipt-"))
				if err != nil {
					t.Error("bad cursor")
				}
				offset = index + 1
			}
			end := offset + 500
			if end > len(events) {
				end = len(events)
			}
			if offset > len(events) {
				offset = len(events)
			}
			json.NewEncoder(w).Encode(events[offset:end])
		case p == "/api/v2/user/dirs":
			json.NewEncoder(w).Encode([]sftpgo.DirEntry{{Name: "first.zip", Size: int64(payloadSize), LastModified: time.Now().Add(-10 * time.Minute)}})
		case p == "/api/v2/user/files":
			reads++
			w.Header().Set("Content-Length", strconv.Itoa(payloadSize))
			io.CopyN(w, &sftpRepeatReader{payload: payload}, int64(payloadSize))
		case p == "/api/v2/folders" && r.Method == "POST":
			var f sftpgo.Folder
			json.NewDecoder(r.Body).Decode(&f)
			folders[f.Name] = f
			w.WriteHeader(201)
		case strings.HasPrefix(p, "/api/v2/folders/"):
			f, ok := folders[strings.TrimPrefix(p, "/api/v2/folders/")]
			if !ok {
				w.WriteHeader(404)
				return
			}
			json.NewEncoder(w).Encode(f)
		case p == "/api/v2/users" && r.Method == "POST":
			var u sftpgo.User
			json.NewDecoder(r.Body).Decode(&u)
			users[u.Username] = u
			w.WriteHeader(201)
		case strings.HasPrefix(p, "/api/v2/users/"):
			name := strings.TrimPrefix(p, "/api/v2/users/")
			if r.Method == "PUT" {
				var u sftpgo.User
				json.NewDecoder(r.Body).Decode(&u)
				users[name] = u
				w.WriteHeader(200)
				return
			}
			u, ok := users[name]
			if !ok {
				w.WriteHeader(404)
				return
			}
			json.NewEncoder(w).Encode(u)
		default:
			t.Errorf("unexpected provider route: %s %s", r.Method, p)
			w.WriteHeader(404)
		}
	})
	app := New(st, Config{SFTP: client}, nil, nil)
	if e = app.ReconcileSFTP(ctx); e != nil {
		t.Fatal(e)
	}
	if e = app.ReconcileSFTP(ctx); e != nil {
		t.Fatal(e)
	}
	if reads != 1 {
		t.Fatalf("receipt rehashed repeatedly: %d", reads)
	}
	if pageRequests != 4 {
		t.Fatalf("same-timestamp receipt pagination lost pages: %d", pageRequests)
	}
	state, e := st.SFTPState(ctx, "viewer", false)
	if e != nil || len(state.Versions) != 1 {
		t.Fatalf("missing version: %+v %v", state, e)
	}
	v := state.Versions[0]
	if v.Source != "sftpgo" || !v.CanDownload || v.ReceivedBy != account.Username {
		t.Fatalf("wrong source facts: %+v", v)
	}
	var stored bool
	if e = st.Pool.QueryRow(ctx, "SELECT content IS NULL FROM sftp_versions WHERE id=$1", v.ID).Scan(&stored); e != nil || !stored {
		t.Fatalf("payload leaked into PG: %v %v", stored, e)
	}
	provider, e := st.SFTPProviderState(ctx)
	if e != nil || provider.LastSuccessAt == nil || provider.Error != "" {
		t.Fatalf("freshness: %+v %v", provider, e)
	}
	admin, e := st.SFTPState(ctx, "admin", true)
	if e != nil || admin.Accounts[0].ProvisioningState != "applied" || admin.Collections[0].ProvisioningState != "applied" {
		t.Fatalf("not applied: %+v %v", admin, e)
	}
	// A different successful receipt for an already immutable path is an explicit conflict.
	conflicting := event
	conflicting.ID = "another-receipt"
	if e = app.sftpReceiveEvent(ctx, conflicting, map[string]model.SFTPAccount{account.Username: account}, map[string]model.SFTPCollection{collection.ID: collection}); sftpgo.ErrorCode(e) != "event_path_conflict" {
		t.Fatalf("distinct receipt silently dropped: %v", e)
	}
	// A transport failure must keep the last facts and expose the failed refresh.
	clientFailure := mockSFTPClient(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(401) })
	app.Config.SFTP = clientFailure
	if e = app.ReconcileSFTP(ctx); e == nil {
		t.Fatal("provider failure hidden")
	}
	provider, e = st.SFTPProviderState(ctx)
	if e != nil || provider.Error != "provider_auth_denied" || provider.LastSuccessAt == nil {
		t.Fatalf("provider failure erased history: %+v %v", provider, e)
	}
}
func TestSFTPQuotaAssignmentsAndRevision(t *testing.T) {
	st := localAuthTestStore(t)
	ctx := context.Background()
	c, e := st.SFTPSaveCollection(ctx, model.SFTPCollection{Branch: "Test", Label: "Test", Folder: "test", QuotaBytes: 1000}, "admin")
	if e != nil {
		t.Fatal(e)
	}
	a := model.SFTPAccount{Username: "branch", Label: "Branch", QuotaBytes: 999, CollectionIDs: []string{c.ID}}
	if _, e = st.SFTPSaveAccount(ctx, a, "admin"); e == nil {
		t.Fatal("underbudget folder assignment accepted")
	}
	a.QuotaBytes = 1000
	a, e = st.SFTPSaveAccount(ctx, a, "admin")
	if e != nil {
		t.Fatal(e)
	}
	c.QuotaBytes = 1001
	if _, e = st.SFTPSaveCollection(ctx, c, "admin"); e == nil {
		t.Fatal("collection change violated account budget")
	}
	a.Username = "renamed"
	if _, e = st.SFTPSaveAccount(ctx, a, "admin"); !errors.Is(e, store.ErrInvalid) {
		t.Fatalf("identity rename allowed: %v", e)
	}
	c.QuotaBytes = 161 << 30
	if _, e = st.SFTPSaveCollection(ctx, c, "admin"); e == nil {
		t.Fatal("storage budget exceeded")
	}
}

type sftpRepeatReader struct{ payload []byte }

func (r *sftpRepeatReader) Read(p []byte) (int, error) { return copy(p, r.payload), nil }

func TestSFTPQuarantineDoesNotBlockValidReceipt(t *testing.T) {
	st := localAuthTestStore(t)
	ctx := context.Background()
	collection, e := st.SFTPSaveCollection(ctx, model.SFTPCollection{Branch: "Test", Label: "Test", Folder: "test", QuotaBytes: 1024}, "admin")
	if e != nil {
		t.Fatal(e)
	}
	account, e := st.SFTPSaveAccount(ctx, model.SFTPAccount{Username: "branch", Label: "Branch", QuotaBytes: 1024, CollectionIDs: []string{collection.ID}}, "admin")
	if e != nil {
		t.Fatal(e)
	}
	bytesRead := 0
	payload := []byte("synthetic archive")
	client := mockSFTPClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v2/user/files" {
			t.Error("unexpected request for quarantined input")
			w.WriteHeader(404)
			return
		}
		bytesRead++
		w.Header().Set("Content-Length", strconv.Itoa(len(payload)))
		w.Write(payload)
	})
	app := New(st, Config{SFTP: client}, nil, nil)
	bad := sftpgo.Event{ID: "bad", Timestamp: time.Now().UnixNano(), Action: "upload", Status: 1, Protocol: "SFTP", Username: account.Username, FSPath: "/srv/sftpgo/data/collections/" + collection.ID + "/bad\n.zip", FileSize: int64(len(payload))}
	good := bad
	good.ID = "good"
	good.FSPath = "/srv/sftpgo/data/collections/" + collection.ID + "/good.zip"
	for i := 0; i < 2; i++ {
		reason, e := app.sftpProcessEvents(ctx, []sftpgo.Event{bad, good}, map[string]model.SFTPAccount{account.Username: account}, map[string]model.SFTPCollection{collection.ID: collection})
		if e != nil || reason != "quarantined_receipts" {
			t.Fatalf("quarantine blocked valid receipts: %q %v", reason, e)
		}
	}
	state, e := st.SFTPState(ctx, "viewer", false)
	if e != nil || len(state.Versions) != 1 || state.Versions[0].Filename != "good.zip" || bytesRead != 1 {
		t.Fatalf("invalid receipt indexed or repeated: %+v reads=%d %v", state.Versions, bytesRead, e)
	}
	var count int
	if e = st.Pool.QueryRow(ctx, "SELECT count(*) FROM sftp_access_audit WHERE action='receipt.quarantined'").Scan(&count); e != nil || count != 1 {
		t.Fatalf("quarantine audit repeated: %d %v", count, e)
	}
	provider, e := app.sftpProviderOverview(ctx)
	if e != nil || provider.QuarantinedReceipts != 1 || provider.Status != "error" || provider.Error != "quarantined_receipts" {
		t.Fatalf("quarantine hidden: %+v %v", provider, e)
	}
}

func TestSFTPStalePolicyCannotRestoreRevokedReadersOrKeys(t *testing.T) {
	st := localAuthTestStore(t)
	ctx := context.Background()
	c, e := st.SFTPSaveCollection(ctx, model.SFTPCollection{Branch: "Test", Label: "Test", Folder: "test", QuotaBytes: 1024, ReaderIDs: []string{"viewer"}}, "admin")
	if e != nil {
		t.Fatal(e)
	}
	staleCollection := c
	c.ReaderIDs = []string{}
	c, e = st.SFTPSaveCollection(ctx, c, "admin")
	if e != nil {
		t.Fatal(e)
	}
	if c.Revision != staleCollection.Revision+1 {
		t.Fatal("collection revision not advanced")
	}
	a, e := st.SFTPSaveAccount(ctx, model.SFTPAccount{Username: "branch", Label: "Branch", QuotaBytes: 1024, CollectionIDs: []string{c.ID}, PublicKeys: []string{sftpPublicKeyFixture(t)}, Enabled: true}, "admin")
	if e != nil {
		t.Fatal(e)
	}
	staleAccount := a
	a.PublicKeys = []string{}
	a.Enabled = false
	a, e = st.SFTPSaveAccount(ctx, a, "admin")
	if e != nil {
		t.Fatal(e)
	}
	if a.Revision != staleAccount.Revision+1 {
		t.Fatal("account revision not advanced")
	}
	app := New(st, Config{}, nil, nil)
	collectionBody, _ := json.Marshal(staleCollection)
	r := httptest.NewRequest("PUT", "/api/v1/sftp-server/collections/"+c.ID, bytes.NewReader(collectionBody))
	r.Header.Set("Content-Type", "application/json")
	r.SetPathValue("id", c.ID)
	w := httptest.NewRecorder()
	app.sftpSaveCollection(w, r)
	if w.Code != 409 {
		t.Fatalf("stale reader policy accepted: %d %s", w.Code, w.Body)
	}
	accountBody, _ := json.Marshal(staleAccount)
	r = httptest.NewRequest("PUT", "/api/v1/sftp-server/accounts/"+a.ID, bytes.NewReader(accountBody))
	r.Header.Set("Content-Type", "application/json")
	r.SetPathValue("id", a.ID)
	w = httptest.NewRecorder()
	app.sftpSaveAccount(w, r)
	if w.Code != 409 {
		t.Fatalf("stale SSH key policy accepted: %d %s", w.Code, w.Body)
	}
	staleCollection.Revision = 0
	collectionBody, _ = json.Marshal(staleCollection)
	r = httptest.NewRequest("PUT", "/api/v1/sftp-server/collections/"+c.ID, bytes.NewReader(collectionBody))
	r.Header.Set("Content-Type", "application/json")
	r.SetPathValue("id", c.ID)
	w = httptest.NewRecorder()
	app.sftpSaveCollection(w, r)
	if w.Code != 428 {
		t.Fatalf("missing revision accepted: %d", w.Code)
	}
	state, e := st.SFTPState(ctx, "admin", true)
	if e != nil || len(state.Collections[0].ReaderIDs) != 0 || state.Accounts[0].Enabled || len(state.Accounts[0].PublicKeys) != 0 {
		t.Fatalf("revoked access restored: %+v %v", state, e)
	}
}

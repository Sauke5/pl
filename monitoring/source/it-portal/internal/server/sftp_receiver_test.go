package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"pl/portal/internal/model"
	"pl/portal/internal/sftpgo"
	"pl/portal/internal/store"
	"slices"
	"testing"
	"time"
)

func TestSFTPReceiverNativePolicyAssignedFoldersOnly(t *testing.T) {
	app := &Server{Config: Config{SFTP: &sftpgo.Client{Root: "/srv/sftpgo/data"}}}
	collections := map[string]model.SFTPCollection{"a": {ID: "a", Folder: "first", QuotaBytes: 4 << 30}, "b": {ID: "b", Folder: "second", QuotaBytes: 6 << 30}, "other": {ID: "other", Folder: "private", QuotaBytes: 8 << 30}}
	account := model.SFTPAccount{Kind: model.SFTPReceiver, ID: "account", Username: "recipient", Label: "Recipient", CollectionIDs: []string{"a", "b"}, PublicKeys: []string{sftpPublicKeyFixture(t)}, Enabled: true}
	got, e := app.sftpDesiredUser(account, collections)
	if e != nil {
		t.Fatal(e)
	}
	if got.Role != "portal-sftp" || got.QuotaSize != 0 || got.QuotaFiles != 0 || got.HomeDir != "/srv/sftpgo/data/accounts/account" || got.HasPassword || got.Password != "" {
		t.Fatalf("unsafe receiver identity: %+v", got)
	}
	if !slices.Equal(got.Permissions["/"], []string{"list"}) || len(got.Permissions) != 3 || len(got.VirtualFolders) != 2 {
		t.Fatalf("unexpected root/sibling access: %+v", got.Permissions)
	}
	for _, p := range []string{"/first", "/second"} {
		if !slices.Equal(got.Permissions[p], []string{"list", "download"}) {
			t.Fatalf("unexpected folder permissions: %s %+v", p, got.Permissions)
		}
	}
	if _, ok := got.Permissions["/private"]; ok {
		t.Fatal("unassigned folder granted")
	}
	for _, folder := range got.VirtualFolders {
		if folder.QuotaSize != 0 || folder.QuotaFiles != 0 {
			t.Fatal("receiver reserved upload budget")
		}
		if folder.MappedPath != "/srv/sftpgo/data/collections/a" && folder.MappedPath != "/srv/sftpgo/data/collections/b" {
			t.Fatal("escaped assigned namespace")
		}
	}
	for _, denied := range []string{"password", "password-over-SSH", "keyboard-interactive", "publickey+password", "publickey+keyboard-interactive", "TLSCertificate", "TLSCertificate+password"} {
		if !slices.Contains(got.Filters.DeniedLoginMethods, denied) {
			t.Fatalf("login method allowed: %s", denied)
		}
	}
	for _, protocol := range []string{"HTTP", "FTP", "DAV"} {
		if !slices.Contains(got.Filters.DeniedProtocols, protocol) {
			t.Fatalf("unexpected protocol: %s", protocol)
		}
	}
	if got.Filters.AllowAPIKey || len(got.Filters.FilePatterns) == 0 || !slices.Equal(got.Filters.FilePatterns[0].Denied, []string{"*"}) {
		t.Fatal("unexpected root file/API access")
	}
	for _, filter := range got.Filters.FilePatterns[1:] {
		if len(filter.Allowed) != 0 || !slices.Equal(filter.Denied, []string{".sftpgo-upload.*"}) || filter.DenyPolicy != 1 {
			t.Fatalf("atomic temporary files not denied and hidden: %+v", filter)
		}
	}
	// Switching the same managed identity back to sender restores only upload,
	// with the original conservative writer budget and immutable namespace.
	account.Kind = model.SFTPSender
	account.QuotaBytes = 10 << 30
	sender, e := app.sftpDesiredUser(account, collections)
	if e != nil {
		t.Fatal(e)
	}
	for _, permissions := range sender.Permissions {
		if !slices.Equal(permissions, []string{"upload"}) {
			t.Fatalf("sender gained read access: %+v", sender.Permissions)
		}
	}
}
func TestSFTPReceiverStoreNoWriterBudgetAndCompatibleDefaults(t *testing.T) {
	st := localAuthTestStore(t)
	ctx := context.Background()
	c, e := st.SFTPSaveCollection(ctx, model.SFTPCollection{Branch: "Test", Label: "Test", Folder: "test", QuotaBytes: 1 << 30}, "admin")
	if e != nil {
		t.Fatal(e)
	}
	receiver, e := st.SFTPSaveAccount(ctx, model.SFTPAccount{Kind: model.SFTPReceiver, Username: "recipient", Label: "Recipient", QuotaBytes: 17, CollectionIDs: []string{c.ID}, PublicKeys: []string{sftpPublicKeyFixture(t)}, Enabled: true}, "admin")
	if e != nil {
		t.Fatal(e)
	}
	if receiver.Kind != model.SFTPReceiver || receiver.QuotaBytes != 0 || !slices.Equal(receiver.Permissions, []string{"list", "download"}) {
		t.Fatalf("receiver budget/mode: %+v", receiver)
	}
	c.QuotaBytes = 2 << 30
	c, e = st.SFTPSaveCollection(ctx, c, "admin")
	if e != nil {
		t.Fatalf("reader blocked writer quota: %v", e)
	}
	// Old PUT clients omit kind: preserve receiver instead of accidentally gaining uploads.
	receiver.Kind = ""
	receiver, e = st.SFTPSaveAccount(ctx, receiver, "admin")
	if e != nil || receiver.Kind != model.SFTPReceiver {
		t.Fatalf("omitted kind changed existing receiver: %+v %v", receiver, e)
	}
	if _, e = st.SFTPSaveAccount(ctx, model.SFTPAccount{Username: "legacy", Label: "Legacy", QuotaBytes: 2 << 30, CollectionIDs: []string{c.ID}}, "admin"); e != nil {
		t.Fatal(e)
	}
	state, e := st.SFTPState(ctx, "admin", true)
	if e != nil {
		t.Fatal(e)
	}
	if len(state.Accounts) != 2 || state.Accounts[0].Kind != model.SFTPSender || !slices.Equal(state.Accounts[0].Permissions, []string{"upload"}) {
		t.Fatalf("legacy sender changed: %+v", state.Accounts)
	}
	receiver.Kind = model.SFTPSender
	receiver.QuotaBytes = 0
	if _, e = st.SFTPSaveAccount(ctx, receiver, "admin"); e == nil {
		t.Fatal("receiver switched to sender without write budget")
	}
	// Database invariant also prevents bypassing kind/quotas through another writer.
	if _, e = st.Pool.Exec(ctx, "UPDATE sftp_accounts SET kind='receiver',quota_bytes=1 WHERE id=$1", receiver.ID); e == nil {
		t.Fatal("invalid receiver budget stored")
	}
}
func TestSFTPReceiverHistoricalUploadRemainsFact(t *testing.T) {
	st := localAuthTestStore(t)
	ctx := context.Background()
	c, e := st.SFTPSaveCollection(ctx, model.SFTPCollection{Branch: "Test", Label: "Test", Folder: "test", QuotaBytes: 1024}, "admin")
	if e != nil {
		t.Fatal(e)
	}
	account, e := st.SFTPSaveAccount(ctx, model.SFTPAccount{Username: "branch", Label: "Branch", QuotaBytes: 1024, CollectionIDs: []string{c.ID}}, "admin")
	if e != nil {
		t.Fatal(e)
	}
	receipt := sftpgo.Event{ID: "uploaded-before-type-change", Timestamp: time.Now().Add(-time.Minute).UnixNano(), Action: "upload", Status: 1, Protocol: "SFTP", Username: account.Username, FSPath: "/srv/sftpgo/data/collections/" + c.ID + "/base.zip", FileSize: 7}
	account.Kind = model.SFTPReceiver
	account, e = st.SFTPSaveAccount(ctx, account, "admin")
	if e != nil {
		t.Fatal(e)
	}
	reads := 0
	client := mockSFTPClient(t, func(w http.ResponseWriter, r *http.Request) { reads++; w.Write([]byte("fixture")) })
	app := New(st, Config{SFTP: client}, nil, nil)
	accounts := map[string]model.SFTPAccount{account.Username: account}
	collections := map[string]model.SFTPCollection{c.ID: c}
	for i := 0; i < 2; i++ {
		if e = app.sftpReceiveEvent(ctx, receipt, accounts, collections); e != nil {
			t.Fatalf("historical upload lost: %v", e)
		}
	}
	download := receipt
	download.ID = "receiver-download"
	download.Action = "download"
	if e = app.sftpReceiveEvent(ctx, download, accounts, collections); e != nil {
		t.Fatal(e)
	}
	state, e := st.SFTPState(ctx, "admin", true)
	if e != nil || len(state.Versions) != 1 || reads != 1 {
		t.Fatalf("download counted or receipt lost: %d reads=%d %v", len(state.Versions), reads, e)
	}
}
func TestSFTPReceiverAPIRejectsUnknownModeAndPreservesCAS(t *testing.T) {
	app := &Server{}
	body := []byte(`{"kind":"admin","username":"bad","label":"Bad","collection_ids":["00000000-0000-0000-0000-000000000001"]}`)
	r := httptest.NewRequest("POST", "/api/v1/sftp-server/accounts", bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	app.sftpSaveAccount(w, r)
	if w.Code != 400 {
		t.Fatalf("unknown mode accepted: %d", w.Code)
	}
	st := localAuthTestStore(t)
	ctx := context.Background()
	c, e := st.SFTPSaveCollection(ctx, model.SFTPCollection{Branch: "Test", Label: "Test", Folder: "test", QuotaBytes: 1024}, "admin")
	if e != nil {
		t.Fatal(e)
	}
	a, e := st.SFTPSaveAccount(ctx, model.SFTPAccount{Kind: model.SFTPReceiver, Username: "recipient", Label: "Recipient", CollectionIDs: []string{c.ID}}, "admin")
	if e != nil {
		t.Fatal(e)
	}
	stale := a
	a.Enabled = false
	a, e = st.SFTPSaveAccount(ctx, a, "admin")
	if e != nil {
		t.Fatal(e)
	}
	stale.Kind = model.SFTPSender
	stale.QuotaBytes = 1024
	if _, e = st.SFTPSaveAccount(ctx, stale, "admin"); !errors.Is(e, store.ErrConflict) {
		t.Fatalf("stale type escalation: %v", e)
	}
	encoded, _ := json.Marshal(a)
	r = httptest.NewRequest("PUT", "/api/v1/sftp-server/accounts/"+a.ID, bytes.NewReader(encoded))
	r.Header.Set("Content-Type", "application/json")
	r.SetPathValue("id", a.ID)
	w = httptest.NewRecorder()
	app = New(st, Config{}, nil, nil)
	app.sftpSaveAccount(w, r)
	if w.Code != 200 {
		t.Fatalf("receiver quota=0 rejected by API: %d %s", w.Code, w.Body)
	}
}

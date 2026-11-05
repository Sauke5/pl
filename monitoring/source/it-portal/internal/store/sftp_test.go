package store

import (
	"context"
	"errors"
	"pl/portal/internal/model"
	"testing"
)

func TestSFTPDurableVersionsAndPolicies(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	c, e := s.SFTPSaveCollection(ctx, model.SFTPCollection{Branch: "test", Label: "Synthetic", Folder: "synthetic", QuotaBytes: 6, ReaderIDs: []string{}}, "admin")
	if e != nil {
		t.Fatal(e)
	}
	v, dup, e := s.SFTPReceiveTest(ctx, c.ID, "first.zip", "uploader", []byte("1234"))
	if e != nil || dup {
		t.Fatalf("receive: %v %v", dup, e)
	}
	repeated, dup, e := s.SFTPReceiveTest(ctx, c.ID, "renamed.zip", "uploader", []byte("1234"))
	if e != nil || !dup || repeated.ID != v.ID || repeated.Filename != "first.zip" {
		t.Fatalf("duplicate changed immutable identity: %+v %v %v", repeated, dup, e)
	}
	if _, _, e = s.SFTPReceiveTest(ctx, c.ID, "second.zip", "uploader", []byte("5678")); !errors.Is(e, ErrInvalid) {
		t.Fatalf("quota bypass: %v", e)
	}
	if _, _, e = s.SFTPDownload(ctx, v.ID, "admin"); !errors.Is(e, ErrSFTPAccess) {
		t.Fatalf("admin implicit file access: %v", e)
	}
	if _, _, e = s.SFTPDownload(ctx, v.ID, "viewer"); !errors.Is(e, ErrSFTPAccess) {
		t.Fatalf("viewer implicit file access: %v", e)
	}
	c.ReaderIDs = []string{"viewer"}
	if c, e = s.SFTPSaveCollection(ctx, c, "admin"); e != nil {
		t.Fatal(e)
	}
	if _, data, e := s.SFTPDownload(ctx, v.ID, "viewer"); e != nil || string(data) != "1234" {
		t.Fatalf("explicit grant: %q %v", data, e)
	}
	c.ReaderIDs = []string{}
	if c, e = s.SFTPSaveCollection(ctx, c, "admin"); e != nil {
		t.Fatal(e)
	}
	if _, _, e = s.SFTPDownload(ctx, v.ID, "viewer"); !errors.Is(e, ErrSFTPAccess) {
		t.Fatalf("grant revocation ignored: %v", e)
	}
	a, e := s.SFTPSaveAccount(ctx, model.SFTPAccount{Username: "branch-test", Label: "Branch sender", QuotaBytes: 1024, CollectionIDs: []string{c.ID}, Enabled: true}, "admin")
	if e != nil {
		t.Fatal(e)
	}
	a.QuotaBytes = 2048
	a.Enabled = false
	if _, e = s.SFTPSaveAccount(ctx, a, "admin"); e != nil {
		t.Fatal(e)
	}
	state, e := s.SFTPState(ctx, "admin", true)
	if e != nil {
		t.Fatal(e)
	}
	if len(state.Accounts) != 1 || state.Accounts[0].Enabled || state.Accounts[0].QuotaBytes != 2048 || state.Accounts[0].ProvisioningState != "pending" {
		t.Fatalf("durable policy: %+v", state.Accounts)
	}
	if len(state.Versions) != 1 || state.VersionsTotal != 1 {
		t.Fatalf("version facts: %+v", state)
	}
	if _, e = s.Pool.Exec(ctx, "DELETE FROM sftp_access_audit"); e == nil {
		t.Fatal("audit was deletable")
	}
}

func TestSFTPReaderNameSurvivesLogout(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	_, err := s.Pool.Exec(ctx, "INSERT INTO sessions(token_hash,user_id,user_name,admin,csrf,expires_at) VALUES('reader-test','reader','Тестовый читатель',false,'csrf',now()+interval '1 hour')")
	if err != nil {
		t.Fatal(err)
	}
	if err = s.SFTPAccess(ctx, "reader"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Pool.Exec(ctx, "DELETE FROM sessions WHERE user_id='reader'"); err != nil {
		t.Fatal(err)
	}
	state, err := s.SFTPState(ctx, "admin", true)
	if err != nil {
		t.Fatal(err)
	}
	if len(state.AvailableReaders) != 1 || state.AvailableReaders[0].ID != "reader" || state.AvailableReaders[0].Name != "Тестовый читатель" {
		t.Fatalf("reader identity lost after logout: %+v", state.AvailableReaders)
	}
}

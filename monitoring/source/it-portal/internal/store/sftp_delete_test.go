package store

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"pl/portal/internal/model"
	"strings"
	"testing"
	"time"
)

func TestSFTPDeleteTombstoneRetainsHistoryAndSerializes(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	c, e := s.SFTPSaveCollection(ctx, model.SFTPCollection{Branch: "Test", Label: "Test", Folder: "delete-test", QuotaBytes: 1024, ReaderIDs: []string{"reader"}}, "admin")
	if e != nil {
		t.Fatal(e)
	}
	_, e = s.SFTPReceiveRemote(ctx, model.SFTPVersion{CollectionID: c.ID, Filename: "file.zip", SizeBytes: 4, SHA256: strings.Repeat("a", 64), ReceivedAt: time.Now(), ReceivedBy: "branch", ReceivedByName: "Branch"}, "/collections/"+c.ID+"/file.zip", "delete-event")
	if e != nil {
		t.Fatal(e)
	}
	state, e := s.SFTPState(ctx, "admin", true)
	if e != nil {
		t.Fatal(e)
	}
	id := state.Versions[0].ID
	op, e := s.SFTPBeginDelete(ctx, id, "admin")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.SFTPBeginDelete(ctx, id, "other"); !errors.Is(e, ErrSFTPDeleteBusy) {
		t.Fatalf("concurrent delete: %v", e)
	}
	if _, _, e = s.SFTPRemoteDownload(ctx, id, "reader"); !errors.Is(e, ErrSFTPDeleted) {
		t.Fatalf("pending download allowed: %v", e)
	}
	if e = op.Finish(ctx, "uncertain", "admin", "provider_unavailable"); e != nil {
		t.Fatal(e)
	}
	op.Close()
	op, e = s.SFTPBeginDelete(ctx, id, "admin")
	if e != nil || op.State != "uncertain" {
		t.Fatalf("lost uncertain state: %v", e)
	}
	if e = op.Finish(ctx, "deleted", "admin", "absence_verified"); e != nil {
		t.Fatal(e)
	}
	op.Close()
	op, e = s.SFTPBeginDelete(ctx, id, "other")
	if e != nil || op.State != "deleted" {
		t.Fatalf("idempotency: %v", e)
	}
	op.Close()
	state, e = s.SFTPState(ctx, "reader", false)
	if e != nil {
		t.Fatal(e)
	}
	if len(state.Versions) != 1 || state.Versions[0].DeletedAt == nil || state.Versions[0].CanDownload || state.Versions[0].CanDelete || state.Versions[0].DeletedBy != "admin" {
		t.Fatalf("tombstone state: %+v", state.Versions)
	}
	var uploads, completed int
	s.Pool.QueryRow(ctx, "SELECT count(*) FROM sftp_versions").Scan(&uploads)
	s.Pool.QueryRow(ctx, "SELECT count(*) FROM sftp_access_audit WHERE action='file.delete.deleted'").Scan(&completed)
	if uploads != 1 || completed != 1 {
		t.Fatalf("history or idempotency lost %d %d", uploads, completed)
	}
	if _, e = s.Pool.Exec(ctx, "DELETE FROM sftp_versions WHERE id=$1", id); e == nil {
		t.Fatal("immutable upload became deletable")
	}
	// A new generation may reuse a deleted path without mutating historical facts.
	next := model.SFTPVersion{CollectionID: c.ID, Filename: "file.zip", SizeBytes: 5, SHA256: strings.Repeat("b", 64), ReceivedAt: time.Now(), ReceivedBy: "branch", ReceivedByName: "Branch"}
	if _, e = s.SFTPReceiveRemote(ctx, next, "/collections/"+c.ID+"/file.zip", "next-generation"); e != nil {
		t.Fatal("path reuse rejected", e)
	}
	var nextID string
	if e = s.Pool.QueryRow(ctx, "SELECT id FROM sftp_versions WHERE provider_event_key='next-generation'").Scan(&nextID); e != nil {
		t.Fatal(e)
	}
	if _, _, e = s.SFTPRemoteDownload(ctx, id, "reader"); !errors.Is(e, ErrSFTPDeleted) {
		t.Fatal("old version can download new generation", e)
	}
	if v, _, err := s.SFTPRemoteDownload(ctx, nextID, "reader"); err != nil || v.ID != nextID {
		t.Fatal("new generation unavailable", err)
	}
	if known, err := s.SFTPRemoteReceiptKnown(ctx, "delete-event", "/collections/"+c.ID+"/file.zip", 4, "branch"); err != nil || !known {
		t.Fatal("historical receipt replay lost", err)
	}
	op, e = s.SFTPBeginDelete(ctx, id, "admin")
	if e != nil || op.State != "deleted" {
		t.Fatal("old deletion not idempotent", e)
	}
	if _, e = s.SFTPBeginDelete(ctx, nextID, "admin"); !errors.Is(e, ErrSFTPDeleteBusy) {
		t.Fatal("path lock not shared across generations", e)
	}
	op.Close()
	var owner string
	if e = s.Pool.QueryRow(ctx, "SELECT version_id FROM sftp_active_files WHERE provider_path=$1", "/collections/"+c.ID+"/file.zip").Scan(&owner); e != nil || owner != nextID {
		t.Fatal("old request altered active owner", e)
	}
	state, e = s.SFTPState(ctx, "reader", false)
	if e != nil || len(state.Versions) != 2 {
		t.Fatal("generation history lost", e)
	}
	for i := 0; i < 2; i++ {
		if _, e = s.SFTPBeginDelete(ctx, uuid.NewString(), "admin"); !errors.Is(e, ErrNotFound) {
			t.Fatal(e)
		}
	}
}

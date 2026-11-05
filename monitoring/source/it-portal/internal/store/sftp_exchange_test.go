package store

import (
	"context"
	"testing"

	"pl/portal/internal/model"
)

func TestSFTPExchangeBranchesKeepLatestDeletedBeyondGlobalVersionLimit(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	busy, err := s.SFTPSaveCollection(ctx, model.SFTPCollection{Branch: "Busy", Label: "Busy DBF", Folder: "busy", QuotaBytes: 1 << 30}, "admin")
	if err != nil {
		t.Fatal(err)
	}
	quiet, err := s.SFTPSaveCollection(ctx, model.SFTPCollection{Branch: "Quiet", Label: "Quiet DBF", Folder: "quiet", QuotaBytes: 1 << 30}, "admin")
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.Pool.Exec(ctx, `
INSERT INTO sftp_versions(id,collection_id,filename,size_bytes,sha256,received_at,received_by,received_by_name,source,provider_path,provider_event_key)
SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,$1::uuid,
       'busy-'||n||'.zip',n,lpad(to_hex(n),64,'0'),
       '2026-01-01 00:00:00+00'::timestamptz+n*interval '1 second',
       'busy-sender','Busy sender','sftpgo','/collections/'||$1::text||'/busy-'||n||'.zip','busy-'||n
FROM generate_series(1,1001) n`, busy.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.Pool.Exec(ctx, `
INSERT INTO sftp_versions(id,collection_id,filename,size_bytes,sha256,received_at,received_by,received_by_name,source,provider_path,provider_event_key)
VALUES('10000000-0000-4000-8000-000000000001',$1::uuid,'quiet.zip',42,$2,'2025-12-01 00:00:00+00','quiet-sender','Quiet sender','sftpgo','/collections/'||$1::text||'/quiet.zip','quiet-1')`, quiet.ID, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.Pool.Exec(ctx, `INSERT INTO sftp_active_files(provider_path,version_id)
VALUES('/collections/'||$1::text||'/quiet.zip','10000000-0000-4000-8000-000000000001')`, quiet.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.Pool.Exec(ctx, `INSERT INTO sftp_version_deletions(version_id,state,actor,deleted_at)
VALUES('00000000-0000-4000-8000-000000001001','deleted','admin',now())`)
	if err != nil {
		t.Fatal(err)
	}

	branches, err := s.SFTPExchangeBranches(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(branches) != 2 {
		t.Fatalf("branches=%d want 2: %+v", len(branches), branches)
	}
	got := map[string]model.SFTPExchangeBranch{}
	for _, branch := range branches {
		got[branch.ID] = branch
	}
	if branch := got[busy.ID]; branch.ReceivedCount != 1001 || branch.LastReceived == nil || branch.LastReceived.Filename != "busy-1001.zip" || branch.LastReceived.Availability != "deleted" {
		t.Fatalf("busy aggregate lost history/latest deletion: %+v", branch)
	}
	if branch := got[quiet.ID]; branch.ReceivedCount != 1 || branch.LastReceived == nil || branch.LastReceived.Filename != "quiet.zip" || branch.LastReceived.Sender != "Quiet sender" || branch.LastReceived.Availability != "available" {
		t.Fatalf("quiet collection lost behind global limit: %+v", branch)
	}
}

func TestSFTPExchangeBranchesExcludeTestsAndRetiredCollections(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	active, err := s.SFTPSaveCollection(ctx, model.SFTPCollection{Branch: "Active", Label: "Active", Folder: "active", QuotaBytes: 1024}, "admin")
	if err != nil {
		t.Fatal(err)
	}
	retired, err := s.SFTPSaveCollection(ctx, model.SFTPCollection{Branch: "Retired", Label: "Retired", Folder: "retired", QuotaBytes: 1024}, "admin")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.SFTPReceiveTest(ctx, active.ID, "test.zip", "admin", []byte("fixture")); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Pool.Exec(ctx, "UPDATE sftp_collections SET retired_at=now() WHERE id=$1", retired.ID); err != nil {
		t.Fatal(err)
	}
	branches, err := s.SFTPExchangeBranches(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(branches) != 1 || branches[0].ID != active.ID || branches[0].ReceivedCount != 0 || branches[0].LastReceived != nil {
		t.Fatalf("test receipt or retired collection leaked: %+v", branches)
	}
}

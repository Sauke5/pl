package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"pl/portal/internal/model"
)

func TestSFTPCollectionRetirementPreservesFactsAndClosesAccess(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	retired, err := s.SFTPSaveCollection(ctx, model.SFTPCollection{Branch: "Synthetic", Label: "Retirement fixture", Folder: "retirement-fixture", QuotaBytes: 150 << 30, ReaderIDs: []string{"reader"}}, "admin")
	if err != nil {
		t.Fatal(err)
	}
	active, err := s.SFTPSaveCollection(ctx, model.SFTPCollection{Branch: "Business", Label: "Active export", Folder: "active-business", QuotaBytes: 10 << 30, ReaderIDs: []string{"reader"}}, "admin")
	if err != nil {
		t.Fatal(err)
	}
	oldBlob, _, err := s.SFTPReceiveTest(ctx, retired.ID, "old-test.zip", "fixture", []byte("test"))
	if err != nil {
		t.Fatal(err)
	}
	if err = s.SFTPSeen(ctx, oldBlob.ID, "reader"); err != nil {
		t.Fatal(err)
	}
	retiredPath := "/collections/" + retired.ID + "/old-remote.zip"
	_, err = s.SFTPReceiveRemote(ctx, model.SFTPVersion{CollectionID: retired.ID, Filename: "old-remote.zip", SizeBytes: 4, SHA256: strings.Repeat("a", 64), ReceivedAt: time.Now(), ReceivedBy: "fixture", ReceivedByName: "Fixture"}, retiredPath, "retired-receipt")
	if err != nil {
		t.Fatal(err)
	}
	var oldRemoteID string
	if err = s.Pool.QueryRow(ctx, "SELECT id FROM sftp_versions WHERE provider_event_key='retired-receipt'").Scan(&oldRemoteID); err != nil {
		t.Fatal(err)
	}
	op, err := s.SFTPBeginDelete(ctx, oldRemoteID, "admin")
	if err != nil {
		t.Fatal(err)
	}
	if err = op.Finish(ctx, "deleted", "admin", "absence_verified"); err != nil {
		op.Close()
		t.Fatal(err)
	}
	op.Close()
	live, _, err := s.SFTPReceiveTest(ctx, active.ID, "business.zip", "business-sender", []byte("business"))
	if err != nil {
		t.Fatal(err)
	}
	activePath := "/collections/" + active.ID + "/business-real.zip"
	if _, err = s.SFTPReceiveRemote(ctx, model.SFTPVersion{CollectionID: active.ID, Filename: "business-real.zip", SizeBytes: 5940000, SHA256: strings.Repeat("c", 64), ReceivedAt: time.Now(), ReceivedBy: "business-sender", ReceivedByName: "Business"}, activePath, "business-real-receipt"); err != nil {
		t.Fatal(err)
	}
	var activeRemoteID string
	if err = s.Pool.QueryRow(ctx, "SELECT id FROM sftp_versions WHERE provider_event_key='business-real-receipt'").Scan(&activeRemoteID); err != nil {
		t.Fatal(err)
	}
	_, err = s.SFTPSaveAccount(ctx, model.SFTPAccount{Username: "retired-account", Label: "Fixture", Enabled: false, QuotaBytes: retired.QuotaBytes, CollectionIDs: []string{retired.ID}}, "admin")
	if err != nil {
		t.Fatal(err)
	}
	account, err := s.SFTPSaveAccount(ctx, model.SFTPAccount{Username: "active-account", Label: "Business", Enabled: true, QuotaBytes: active.QuotaBytes, CollectionIDs: []string{active.ID}}, "admin")
	if err != nil {
		t.Fatal(err)
	}

	var immutableBefore, auditBefore string
	var auditMax int64
	if err = s.Pool.QueryRow(ctx, "SELECT jsonb_agg(to_jsonb(v) ORDER BY id)::text FROM sftp_versions v").Scan(&immutableBefore); err != nil {
		t.Fatal(err)
	}
	if err = s.Pool.QueryRow(ctx, "SELECT max(id),jsonb_agg(to_jsonb(a) ORDER BY id)::text FROM sftp_access_audit a").Scan(&auditMax, &auditBefore); err != nil {
		t.Fatal(err)
	}
	// Retirement is deliberately an internal operator transaction, not an API capability.
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "UPDATE sftp_collections SET retired_at=now() WHERE id=$1", retired.ID); err != nil {
		t.Fatal(err)
	}
	if err = sftpAudit(ctx, tx, "collection.retired", "operator", retired.ID, ""); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	for _, administrator := range []bool{false, true} {
		state, err := s.SFTPState(ctx, "reader", administrator)
		if err != nil {
			t.Fatal(err)
		}
		if len(state.Collections) != 1 || state.Collections[0].ID != active.ID || len(state.Versions) != 2 || state.VersionsTotal != 2 {
			t.Fatalf("retired data leaked into active state: %+v", state)
		}
		for _, version := range state.Versions {
			if version.CollectionID != active.ID || !version.CanDownload {
				t.Fatalf("active business version changed: %+v", version)
			}
		}
		if administrator && (len(state.Accounts) != 1 || state.Accounts[0].ID != account.ID) {
			t.Fatalf("retired desired policy would be reconciled: %+v", state.Accounts)
		}
	}
	if _, _, err = s.SFTPDownload(ctx, oldBlob.ID, "reader"); !errors.Is(err, ErrSFTPAccess) {
		t.Fatalf("retired blob download: %v", err)
	}
	if _, _, err = s.SFTPRemoteDownload(ctx, oldRemoteID, "reader"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("retired remote metadata/download: %v", err)
	}
	if op, err = s.SFTPBeginDelete(ctx, oldRemoteID, "admin"); !errors.Is(err, ErrNotFound) {
		if op != nil {
			op.Close()
		}
		t.Fatalf("retired delete lookup: %v", err)
	}
	for _, actor := range []string{"reader", "new-reader"} {
		if err = s.SFTPSeen(ctx, oldBlob.ID, actor); !errors.Is(err, ErrNotFound) {
			t.Fatalf("retired seen (%s): %v", actor, err)
		}
	}
	retired.Label = "Stale mutation"
	retired.ReaderIDs = []string{"attacker"}
	if _, err = s.SFTPSaveCollection(ctx, retired, "admin"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("retired collection mutation: %v", err)
	}
	account.CollectionIDs = []string{retired.ID}
	if _, err = s.SFTPSaveAccount(ctx, account, "admin"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("retired rebind: %v", err)
	}
	if _, err = s.SFTPSaveAccount(ctx, model.SFTPAccount{Username: "new-retired-receiver", Kind: model.SFTPReceiver, CollectionIDs: []string{retired.ID}}, "admin"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("retired receiver binding: %v", err)
	}
	if _, _, err = s.SFTPReceiveTest(ctx, retired.ID, "new-test.zip", "fixture", []byte("new")); !errors.Is(err, ErrNotFound) {
		t.Fatalf("retired test upload: %v", err)
	}
	if _, err = s.SFTPReceiveRemote(ctx, model.SFTPVersion{CollectionID: retired.ID, Filename: "new-remote.zip", SizeBytes: 4, SHA256: strings.Repeat("b", 64), ReceivedAt: time.Now(), ReceivedBy: "fixture"}, "/collections/"+retired.ID+"/new-remote.zip", "new-retired-receipt"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("retired remote import: %v", err)
	}
	if err = s.SFTPProvisioned(ctx, "collection", retired.ID, retired.Revision, ""); !errors.Is(err, ErrNotFound) {
		t.Fatalf("retired provisioning metadata: %v", err)
	}
	if _, data, err := s.SFTPDownload(ctx, live.ID, "reader"); err != nil || string(data) != "business" {
		t.Fatalf("business download affected: %q %v", data, err)
	}
	if version, path, err := s.SFTPRemoteDownload(ctx, activeRemoteID, "reader"); err != nil || version.ID != activeRemoteID || path != activePath {
		t.Fatalf("active remote business file affected: %+v %q %v", version, path, err)
	}
	// A retired allocation no longer consumes the receiver's active storage budget.
	fresh, err := s.SFTPSaveCollection(ctx, model.SFTPCollection{Branch: "New", Label: "New active export", Folder: "new-active", QuotaBytes: 150 << 30}, "admin")
	if err != nil {
		t.Fatalf("retired quota was still allocated: %v", err)
	}
	if _, err = s.SFTPSaveAccount(ctx, model.SFTPAccount{Username: "new-active-sender", CollectionIDs: []string{fresh.ID}, QuotaBytes: fresh.QuotaBytes}, "admin"); err != nil {
		t.Fatalf("new active binding affected: %v", err)
	}

	_, err = s.SFTPSaveCollection(ctx, model.SFTPCollection{Branch: "Over budget", Label: "Over budget", Folder: "over-budget", QuotaBytes: 1}, "admin")
	var budget *SFTPQuotaError
	if !errors.As(err, &budget) || !budget.Budget {
		t.Fatalf("active storage allocation was not enforced: %v", err)
	}

	var immutableAfter, auditAfter string
	if err = s.Pool.QueryRow(ctx, "SELECT jsonb_agg(to_jsonb(v) ORDER BY id)::text FROM sftp_versions v").Scan(&immutableAfter); err != nil {
		t.Fatal(err)
	}
	if err = s.Pool.QueryRow(ctx, "SELECT jsonb_agg(to_jsonb(a) ORDER BY id)::text FROM sftp_access_audit a WHERE id<=$1", auditMax).Scan(&auditAfter); err != nil {
		t.Fatal(err)
	}
	if immutableAfter != immutableBefore || auditAfter != auditBefore {
		t.Fatal("retirement altered or removed immutable received facts/audit")
	}
	var readers, retiredRows, retirementEvents int
	if err = s.Pool.QueryRow(ctx, "SELECT count(*) FROM sftp_collection_readers WHERE collection_id=$1 AND user_id='reader'", retired.ID).Scan(&readers); err != nil {
		t.Fatal(err)
	}
	if err = s.Pool.QueryRow(ctx, "SELECT count(*) FROM sftp_collections WHERE id=$1 AND retired_at IS NOT NULL", retired.ID).Scan(&retiredRows); err != nil {
		t.Fatal(err)
	}
	if err = s.Pool.QueryRow(ctx, "SELECT count(*) FROM sftp_access_audit WHERE action='collection.retired' AND collection_id=$1", retired.ID).Scan(&retirementEvents); err != nil {
		t.Fatal(err)
	}
	if readers != 1 || retiredRows != 1 || retirementEvents != 1 {
		t.Fatalf("retirement/grant history changed: %d %d %d", readers, retiredRows, retirementEvents)
	}
	if _, err = s.Pool.Exec(ctx, "DELETE FROM sftp_versions WHERE id=$1", oldBlob.ID); err == nil {
		t.Fatal("version immutability trigger bypassed")
	}
	if _, err = s.Pool.Exec(ctx, "DELETE FROM sftp_access_audit WHERE id=$1", auditMax); err == nil {
		t.Fatal("audit immutability trigger bypassed")
	}
}

func TestSFTPRetirementSerializesIncomingBindingsAndReceipts(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	collection, err := s.SFTPSaveCollection(ctx, model.SFTPCollection{Branch: "Race", Label: "Race", Folder: "retirement-race", QuotaBytes: 1024}, "admin")
	if err != nil {
		t.Fatal(err)
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "UPDATE sftp_collections SET retired_at=now() WHERE id=$1", collection.ID); err != nil {
		t.Fatal(err)
	}
	blocked, cancel := context.WithTimeout(ctx, 150*time.Millisecond)
	_, err = s.SFTPSaveAccount(blocked, model.SFTPAccount{Username: "retire-race", CollectionIDs: []string{collection.ID}, QuotaBytes: 1024}, "admin")
	cancel()
	if err == nil {
		t.Fatal("binding ignored concurrent parent retirement lock")
	}
	blocked, cancel = context.WithTimeout(ctx, 150*time.Millisecond)
	_, err = s.SFTPReceiveRemote(blocked, model.SFTPVersion{CollectionID: collection.ID, Filename: "racing.zip", SizeBytes: 4, SHA256: strings.Repeat("c", 64), ReceivedAt: time.Now()}, "/collections/"+collection.ID+"/racing.zip", "retire-race")
	cancel()
	if err == nil {
		t.Fatal("receipt import ignored concurrent parent retirement lock")
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = s.SFTPSaveAccount(ctx, model.SFTPAccount{Username: "retire-race", CollectionIDs: []string{collection.ID}, QuotaBytes: 1024}, "admin"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("binding after retirement: %v", err)
	}
	var versions, accounts int
	if err = s.Pool.QueryRow(ctx, "SELECT count(*) FROM sftp_versions WHERE collection_id=$1", collection.ID).Scan(&versions); err != nil {
		t.Fatal(err)
	}
	if err = s.Pool.QueryRow(ctx, "SELECT count(*) FROM sftp_accounts WHERE username='retire-race'").Scan(&accounts); err != nil {
		t.Fatal(err)
	}
	if versions != 0 || accounts != 0 {
		t.Fatalf("concurrent retirement left partial data: %d versions, %d accounts", versions, accounts)
	}
}

package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"pl/portal/internal/model"
)

func journalEvent(t *testing.T, s *Store, id, kind, resource string, at time.Time) {
	t.Helper()
	e := s.Event(context.Background(), kind, id, resource, "system", map[string]any{"source_kind": "alertmanager", "time_basis": "source", "occurred_at": at.Format(time.RFC3339Nano)}, false)
	if e != nil {
		t.Fatal(e)
	}
}
func TestJournalArrivalSnapshotCommitOrderAndReadIsolation(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, "SAVEPOINT event_write"); e != nil {
		t.Fatal(e)
	}
	if e = record(ctx, tx, "target.down", "Delayed transaction", "", "system", nil, false); e != nil {
		t.Fatal(e)
	}
	var arrival, top string
	if e = tx.QueryRow(ctx, "SELECT arrival_tx::text,pg_current_xact_id()::text FROM events WHERE body->>'title'='Delayed transaction'").Scan(&arrival, &top); e != nil || arrival != top {
		t.Fatalf("not top-level xid: %q %q %v", arrival, top, e)
	}
	if _, e = tx.Exec(ctx, "RELEASE SAVEPOINT event_write"); e != nil {
		t.Fatal(e)
	}
	if e = s.InitializeJournal(ctx, "alice"); e != nil {
		t.Fatal(e)
	}
	frozen, e := s.Journal(ctx, "alice", JournalFilter{Channel: "events"})
	if e != nil {
		t.Fatal(e)
	}
	journalEvent(t, s, "Later allocation first commit", "problem.firing", "", time.Now().Add(-time.Hour))
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	same, e := s.Journal(ctx, "alice", JournalFilter{Channel: "events", Snapshot: frozen.Snapshot})
	if e != nil {
		t.Fatal(e)
	}
	if same.Total != 0 || len(same.Items) != 0 || same.NewCount != 2 {
		t.Fatalf("frozen snapshot lost late commit: %+v", same)
	}
	fresh, e := s.Journal(ctx, "alice", JournalFilter{Channel: "events"})
	if e != nil {
		t.Fatal(e)
	}
	if len(fresh.Items) != 2 {
		t.Fatalf("refresh: %+v", fresh)
	}
	for _, v := range fresh.Items {
		if !v.Unread {
			t.Fatal("post-baseline arrival must be unread")
		}
	}
	if e = s.InitializeJournal(ctx, "bob"); e != nil {
		t.Fatal(e)
	}
	if e = s.InitializeJournal(ctx, "alice"); e != nil {
		t.Fatal(e)
	} // reload must not move Alice's baseline
	if e = s.MarkJournalSeen(ctx, "alice", "events", []string{fresh.Items[0].ID}); e != nil {
		t.Fatal(e)
	}
	alice, e := s.Journal(ctx, "alice", JournalFilter{Channel: "events"})
	if e != nil {
		t.Fatal(e)
	}
	bob, e := s.Journal(ctx, "bob", JournalFilter{Channel: "events"})
	if e != nil {
		t.Fatal(e)
	}
	if alice.Items[0].Unread || !alice.Items[1].Unread || bob.Items[0].Unread || bob.Items[1].Unread {
		t.Fatal("personal baseline/seen leaked")
	}
	rolled, e := s.Pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if e = record(ctx, rolled, "target.down", "rolled back", "", "system", nil, false); e != nil {
		t.Fatal(e)
	}
	rolled.Rollback(ctx)
	stable, e := s.Journal(ctx, "alice", JournalFilter{Channel: "events", Snapshot: fresh.Snapshot})
	if e != nil || stable.NewCount != 0 {
		t.Fatalf("rollback counted: %+v %v", stable, e)
	}
}
func TestJournalPaginationFiltersSourceTimeAndLegacy(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	if e := s.InitializeJournal(ctx, "alice"); e != nil {
		t.Fatal(e)
	}
	at := time.Now().UTC().Add(-2 * time.Hour).Truncate(time.Microsecond)
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(ctx)
	for n := 0; n < 205; n++ {
		if e = record(ctx, tx, "problem.firing", fmt.Sprintf("Event %d", n), "r1", "system", map[string]any{"source_kind": "alertmanager", "time_basis": "source", "occurred_at": at.Format(time.RFC3339Nano)}, false); e != nil {
			t.Fatal(e)
		}
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	f := JournalFilter{Channel: "events", Source: "alertmanager", ResourceID: "r1", From: at.Add(-time.Minute), To: at.Add(time.Minute), Limit: 37}
	seen := map[string]bool{}
	var snapshot string
	for {
		p, e := s.Journal(ctx, "alice", f)
		if e != nil {
			t.Fatal(e)
		}
		if p.Total != 205 {
			t.Fatalf("total %d", p.Total)
		}
		snapshot = p.Snapshot
		for _, v := range p.Items {
			if seen[v.ID] {
				t.Fatal("duplicate pagination row")
			}
			seen[v.ID] = true
			if !v.OccurredAt.Equal(at) || !v.ReceivedAt.After(at) || v.TimeBasis != "source" {
				t.Fatalf("time semantics: %+v", v)
			}
		}
		if p.NextCursor == "" {
			break
		}
		f.Snapshot = p.Snapshot
		f.Cursor = p.NextCursor
	}
	if len(seen) != 205 {
		t.Fatalf("history capped: %d", len(seen))
	}
	legacy, e := s.Events(ctx, false)
	if e != nil || len(legacy) != 200 {
		t.Fatalf("legacy shape/limit changed %d %v", len(legacy), e)
	}
	bad := f
	bad.ResourceID = "other"
	bad.Snapshot = snapshot
	if _, e = s.Journal(ctx, "alice", bad); !errors.Is(e, ErrInvalid) {
		t.Fatalf("snapshot scope reuse allowed: %v", e)
	}
	// A late arrival belongs to its source-time period and is counted there.
	journalEvent(t, s, "late", "problem.firing", "r1", at)
	f.Cursor = ""
	f.Snapshot = snapshot
	p, e := s.Journal(ctx, "alice", f)
	if e != nil || p.NewCount != 1 {
		t.Fatalf("late source-time lost: %+v %v", p, e)
	}
	if e = s.Event(ctx, "job.succeeded", "Audit operation", "r1", "alice", nil, true); e != nil {
		t.Fatal(e)
	}
	audit, e := s.Journal(ctx, "alice", JournalFilter{Channel: "audit"})
	if e != nil || len(audit.Items) != 1 || !audit.Items[0].Unread {
		t.Fatalf("audit baseline %+v %v", audit, e)
	}
	if e = s.MarkJournalSeen(ctx, "alice", "events", []string{audit.Items[0].ID}); e != nil {
		t.Fatal(e)
	}
	audit, e = s.Journal(ctx, "alice", JournalFilter{Channel: "audit"})
	if e != nil || !audit.Items[0].Unread {
		t.Fatal("cross-channel seen")
	}
}
func TestJournalLegacyMarkerAndSafeTime(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	var volatility string
	if e := s.Pool.QueryRow(ctx, "SELECT provolatile::text FROM pg_proc WHERE oid='pg_current_xact_id()'::regprocedure").Scan(&volatility); e != nil {
		t.Fatal(e)
	}
	t.Logf("pg_current_xact_id volatility: %s", volatility)
	if volatility != "s" && volatility != "v" {
		t.Fatalf("unexpected volatility %q", volatility)
	}
	// Verify the migration's fast constant default does not rewrite existing data.
	if _, e := s.Pool.Exec(ctx, "CREATE TABLE journal_fast_default_test(id int); INSERT INTO journal_fast_default_test SELECT generate_series(1,100)"); e != nil {
		t.Fatal(e)
	}
	var before, after uint32
	if e := s.Pool.QueryRow(ctx, "SELECT pg_relation_filenode('journal_fast_default_test')").Scan(&before); e != nil {
		t.Fatal(e)
	}
	if _, e := s.Pool.Exec(ctx, "ALTER TABLE journal_fast_default_test ADD COLUMN arrival_tx xid8 NOT NULL DEFAULT '0'::xid8; ALTER TABLE journal_fast_default_test ALTER COLUMN arrival_tx SET DEFAULT pg_current_xact_id()"); e != nil {
		t.Fatal(e)
	}
	var visible bool
	if e := s.Pool.QueryRow(ctx, "SELECT pg_relation_filenode('journal_fast_default_test'),pg_visible_in_snapshot('0'::xid8,pg_current_snapshot())").Scan(&after, &visible); e != nil {
		t.Fatal(e)
	}
	if before != after || !visible {
		t.Fatalf("constant marker rewrote or invisible: %d %d %v", before, after, visible)
	}
	body, _ := json.Marshal(model.Event{ID: "legacy", Title: "legacy", CreatedAt: time.Now().UTC(), Details: map[string]any{"time_basis": "source", "occurred_at": "not-a-timestamp"}})
	if _, e := s.Pool.Exec(ctx, "INSERT INTO events(id,body,arrival_tx) VALUES('legacy',$1,'0'::xid8)", body); e != nil {
		t.Fatal(e)
	}
	if e := s.InitializeJournal(ctx, "alice"); e != nil {
		t.Fatal(e)
	}
	page, e := s.Journal(ctx, "alice", JournalFilter{Channel: "events"})
	if e != nil || len(page.Items) != 1 || page.Items[0].Unread {
		t.Fatalf("legacy baseline %+v %v", page, e)
	}
}
func TestJournalTokensRejectMalformed(t *testing.T) {
	for _, v := range []string{"", "junk", encodeJournalToken("20:10:"), encodeJournalToken("10:20:15,14"), encodeJournalToken("10:20:20"), encodeJournalToken("-1:20:")} {
		if _, e := decodeJournalSnapshot(v); !errors.Is(e, ErrInvalid) {
			t.Errorf("accepted %q", v)
		}
	}
	if _, e := decodeJournalSnapshot(encodeJournalToken("10:20:10,14")); e != nil {
		t.Fatal(e)
	}
}

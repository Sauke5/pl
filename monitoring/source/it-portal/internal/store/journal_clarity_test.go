package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"pl/portal/internal/model"
)

func rawJournalAudit(t *testing.T, s *Store, id, kind, object string, details map[string]any) {
	t.Helper()
	body := model.Event{ID: id, Kind: kind, Title: "Изменена запись", ResourceID: object, Actor: "alice", CreatedAt: time.Now().UTC(), Details: details}
	if _, err := s.Pool.Exec(context.Background(), "INSERT INTO audit_events(id,body) VALUES($1,$2)", id, encode(body)); err != nil {
		t.Fatal(err)
	}
}
func TestJournalAuditPersonalAndEmptyObjectsHaveNoRelated(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	if err := s.InitializeJournal(ctx, "alice"); err != nil {
		t.Fatal(err)
	}
	for _, entry := range []struct{ id, kind, object string }{{"prefs-1", "preferences.saved", "alice"}, {"prefs-2", "preferences.saved", "alice"}, {"layout", "dashboard_layout.saved", "alice"}, {"workspace", "workspace_preferences.saved", "alice"}, {"login1", "auth.login", ""}, {"login2", "auth.login", ""}} {
		rawJournalAudit(t, s, entry.id, entry.kind, entry.object, nil)
	}
	for _, id := range []string{"prefs-1", "prefs-2", "layout", "workspace", "login1", "login2"} {
		page, err := s.JournalDetail(ctx, "alice", "audit", id)
		if err != nil {
			t.Fatal(err)
		}
		if len(page.Related) != 0 {
			t.Fatalf("%s linked unrelated audit: %+v", id, page.Related)
		}
	}
	// The read-only projection names the object without inventing an old diff.
	detail, err := s.JournalDetail(ctx, "alice", "audit", "prefs-1")
	if err != nil {
		t.Fatal(err)
	}
	if detail.Event.ObjectKind != "preferences" || detail.Event.ObjectName != "Личные настройки" || detail.Event.Title != "Изменена запись" {
		t.Fatalf("legacy projection: %+v", detail.Event)
	}
	if _, ok := detail.Event.Details["changed_fields"]; ok {
		t.Fatal("invented legacy change history")
	}
	var raw []byte
	if err = s.Pool.QueryRow(ctx, "SELECT body FROM audit_events WHERE id='prefs-1'").Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "object_kind") {
		t.Fatal("journal rewrote raw history")
	}
	rawJournalAudit(t, s, "resource1", "resource.saved", "shared-id", nil)
	rawJournalAudit(t, s, "resource2", "resource.deleted", "shared-id", nil)
	rawJournalAudit(t, s, "integration", "integration.saved", "shared-id", nil)
	detail, err = s.JournalDetail(ctx, "alice", "audit", "resource1")
	if err != nil {
		t.Fatal(err)
	}
	if len(detail.Related) != 1 || detail.Related[0].ID != "resource2" {
		t.Fatalf("cross-namespace correlation: %+v", detail.Related)
	}
}
func TestJournalExcludeCollectionTotalsSnapshotPagingAndAudit(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	if err := s.InitializeJournal(ctx, "alice"); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"target.down", "target.up", "problem.firing", "problem.resolved", "source.disconnected"} {
		if err := s.Event(ctx, kind, kind, "", "system", nil, false); err != nil {
			t.Fatal(err)
		}
	}
	f := JournalFilter{Channel: "events", ExcludeCollection: true, Limit: 2}
	first, err := s.Journal(ctx, "alice", f)
	if err != nil {
		t.Fatal(err)
	}
	if first.Total != 3 || len(first.Items) != 2 || first.NextCursor == "" {
		t.Fatalf("firstpage: %+v", first)
	}
	f.Snapshot = first.Snapshot
	f.Cursor = first.NextCursor
	next, err := s.Journal(ctx, "alice", f)
	if err != nil {
		t.Fatal(err)
	}
	if next.Total != 3 || len(next.Items) != 1 || next.NextCursor != "" {
		t.Fatalf("nextpage: %+v", next)
	}
	for _, v := range append(first.Items, next.Items...) {
		if v.Kind == "target.up" || v.Kind == "target.down" {
			t.Fatal("collection transition leaked")
		}
	}
	for _, kind := range []string{"target.up", "problem.firing"} {
		if err = s.Event(ctx, kind, "late", "", "system", nil, false); err != nil {
			t.Fatal(err)
		}
	}
	f.Cursor = ""
	same, err := s.Journal(ctx, "alice", f)
	if err != nil {
		t.Fatal(err)
	}
	if same.NewCount != 1 || same.Total != 3 {
		t.Fatalf("filtered arrival counts: %+v", same)
	}
	f.ExcludeCollection = false
	if _, err = s.Journal(ctx, "alice", f); !errors.Is(err, ErrInvalid) {
		t.Fatalf("scope flag ignored: %v", err)
	}
	all, err := s.Journal(ctx, "alice", JournalFilter{Channel: "events"})
	if err != nil || all.Total != 7 {
		t.Fatalf("default raw history changed: %+v %v", all, err)
	}
	rawJournalAudit(t, s, "audit-target", "target.down", "", nil)
	audit, err := s.Journal(ctx, "alice", JournalFilter{Channel: "audit", ExcludeCollection: true})
	if err != nil || audit.Total != 1 {
		t.Fatalf("audit filtered: %+v %v", audit, err)
	}
}
func TestAuditNewPreferencesDistinguishOrderMembershipAndDeletionName(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	prefs := model.Preferences{Favorites: []string{"one", "two"}}
	if _, err := s.Save(ctx, "preferences", "alice", 0, prefs, "alice"); err != nil {
		t.Fatal(err)
	}
	prefs.Favorites = []string{"two", "one"}
	if _, err := s.Save(ctx, "preferences", "alice", 1, prefs, "alice"); err != nil {
		t.Fatal(err)
	}
	prefs.Favorites = []string{"two", "three"}
	if _, err := s.Save(ctx, "preferences", "alice", 2, prefs, "alice"); err != nil {
		t.Fatal(err)
	}
	events, err := s.Events(ctx, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 3 || events[0].Title != "Изменён состав избранного" || events[1].Title != "Изменён порядок избранного" || detailString(events[1].Details, "favorites_change") != "order" {
		t.Fatalf("precise audit history: %+v", events)
	}
	resource := putResource(t, s, model.Resource{Name: "Named resource"})
	if err = s.Delete(ctx, "resource", resource.ID, resource.Revision, "alice"); err != nil {
		t.Fatal(err)
	}
	events, err = s.Events(ctx, true)
	if err != nil {
		t.Fatal(err)
	}
	if detailString(events[0].Details, "object_name") != "Named resource" {
		t.Fatal("deleted object name lost")
	}
}
func TestJournalRefreshJobContextAndExactLifecycleCorrelation(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	if err := s.InitializeJournal(ctx, "alice"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Pool.Exec(ctx, `INSERT INTO documents(kind,id,body) VALUES('integration','source-a','{"name":"Prometheus fixture"}')`); err != nil {
		t.Fatal(err)
	}
	job, err := s.Enqueue(ctx, model.Job{Kind: "refresh", IntegrationID: "source-a", Actor: "alice", IdempotencyKey: "refresh-first", ResourceName: "spoofed"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Enqueue(ctx, model.Job{Kind: "refresh", IntegrationID: "source-a", Actor: "alice", IdempotencyKey: "refresh-second"}); err != nil {
		t.Fatal(err)
	}
	job.Status = "succeeded"
	if err = s.Finish(ctx, job); err != nil {
		t.Fatal(err)
	}
	jobs, err := s.Jobs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 2 || jobs[0].IntegrationName != "Prometheus fixture" || jobs[0].ResourceName != "" {
		t.Fatalf("job names: %+v", jobs)
	}
	fetched, err := s.Job(ctx, job.ID)
	if err != nil || fetched.IntegrationName != "Prometheus fixture" {
		t.Fatalf("job detail names: %+v %v", fetched, err)
	}
	page, err := s.Journal(ctx, "alice", JournalFilter{Channel: "audit"})
	if err != nil {
		t.Fatal(err)
	}
	var completed JournalEvent
	for _, event := range page.Items {
		if event.Kind == "job.succeeded" {
			completed = event
		}
	}
	if completed.JobKind != "refresh" || completed.ObjectKind != "job" || completed.ObjectID != job.ID || completed.ObjectName != "Prometheus fixture" {
		t.Fatalf("legacy/joined job context: %+v", completed)
	}
	detail, err := s.JournalDetail(ctx, "alice", "audit", completed.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(detail.Related) != 1 || detailString(detail.Related[0].Details, "job_id") != job.ID {
		t.Fatalf("unrelated refresh joined: %+v", detail.Related)
	}
	// Historical completion records lacking kind and name resolve through the durable job.
	rawJournalAudit(t, s, "legacy-job", "job.succeeded", "", map[string]any{"job_id": job.ID, "status": "succeeded"})
	legacy, err := s.JournalDetail(ctx, "alice", "audit", "legacy-job")
	if err != nil {
		t.Fatal(err)
	}
	if legacy.Event.JobKind != "refresh" || legacy.Event.ObjectName != "Prometheus fixture" {
		b, _ := json.Marshal(legacy.Event)
		t.Fatalf("legacy job context: %s", b)
	}
}

func TestJournalAuditResourceFilterSeparatesDocumentNamespaces(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	if err := s.InitializeJournal(ctx, "alice"); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"preferences.saved", "dashboard_layout.saved", "integration.saved", "resource.saved", "job.succeeded"} {
		rawJournalAudit(t, s, kind, kind, "same-id", nil)
	}
	page, err := s.Journal(ctx, "alice", JournalFilter{Channel: "audit", ResourceID: "same-id"})
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 2 {
		t.Fatalf("personal documents leaked into resource filter: %+v", page)
	}
	for _, event := range page.Items {
		if event.Kind != "resource.saved" && event.Kind != "job.succeeded" {
			t.Fatalf("namespace collision: %+v", event)
		}
	}
}

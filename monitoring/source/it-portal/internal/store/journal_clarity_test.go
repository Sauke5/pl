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

func TestJournalModuleLifecycleProjectionAndServiceRefreshFilter(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	if err := s.InitializeJournal(ctx, "alice"); err != nil {
		t.Fatal(err)
	}
	instance := model.ModuleInstance{ID: "module-fixture", ModuleID: "prometheus", Name: "Метрики стенда", Mode: "external"}
	if _, err := s.Pool.Exec(ctx, `INSERT INTO documents(kind,id,body) VALUES('module_instance',$1,$2)`, instance.ID, encode(instance)); err != nil {
		t.Fatal(err)
	}
	var automatic model.Job
	for _, row := range []struct{ actor, action, status string }{{"system:modules", "refresh", "succeeded"}, {"alice", "refresh", "succeeded"}, {"system:modules", "refresh", "failed"}, {"system:modules", "configure", "succeeded"}} {
		j, err := s.Enqueue(ctx, model.Job{Kind: "module", Actor: row.actor, IdempotencyKey: row.actor + row.action + row.status, Parameters: map[string]any{"instance_id": instance.ID, "action": row.action, "secret": "not-for-journal"}})
		if err != nil {
			t.Fatal(err)
		}
		if row.status == "failed" {
			j.Error = "Provider unavailable"
		}
		j.Status = row.status
		rawInstance, getErr := s.Get(ctx, "module_instance", instance.ID)
		if getErr != nil {
			t.Fatal(getErr)
		}
		observed, decodeErr := Decode[model.ModuleInstance](rawInstance)
		if decodeErr != nil {
			t.Fatal(decodeErr)
		}
		observed.LastJobID = j.ID
		observed.ObservedState = "running"
		observed.Version = "3.11.0"
		j.Result = map[string]any{"instance": observed}
		if _, err = s.Pool.Exec(ctx, `UPDATE documents SET body=jsonb_set(body,'{last_job_id}',to_jsonb($1::text)) WHERE kind='module_instance' AND id=$2`, j.ID, instance.ID); err != nil {
			t.Fatal(err)
		}
		if err = s.Finish(ctx, j); err != nil {
			t.Fatal(err)
		}
		if row.actor == "system:modules" && row.action == "refresh" && row.status == "succeeded" {
			automatic = j
		}
	}
	jobs, err := s.JobsForTimeline(ctx, true)
	if err != nil || len(jobs) != 3 {
		t.Fatalf("timeline filtering: %d %v", len(jobs), err)
	}
	job, err := s.Job(ctx, automatic.ID)
	if err != nil || job.Parameters["module_name"] != instance.Name {
		t.Fatalf("job projection: %+v %v", job, err)
	}
	page, err := s.Journal(ctx, "alice", JournalFilter{Channel: "events", ExcludeServiceRefresh: true, Limit: 1})
	if err != nil || page.Total != 3 || len(page.Items) != 1 || page.NextCursor == "" {
		t.Fatalf("filtered total/page: %+v %v", page, err)
	}
	all, err := s.Journal(ctx, "alice", JournalFilter{Channel: "events"})
	if err != nil || all.Total != 4 {
		t.Fatalf("complete history: %+v %v", all, err)
	}
	for _, event := range all.Items {
		if event.JobKind != "module" || event.ObjectName != instance.Name || event.Action == "" || !strings.Contains(event.Title, instance.Name) {
			t.Fatalf("module context: %+v", event)
		}
		if event.Kind == "job.succeeded" && !strings.Contains(detailString(event.Details, "result_summary"), "3.11.0") {
			t.Fatalf("result summary missing: %+v", event)
		}
		if _, ok := event.Details["secret"]; ok {
			t.Fatal("parameters leaked into journal")
		}
		if event.Actor == "system:modules" && event.ActorName != "Система · modules" {
			t.Fatalf("system actor: %+v", event)
		}
	}
	// Legacy completion title/context must be projected without rewriting stored history.
	rawJournalAudit(t, s, "legacy-module", "job.succeeded", "", map[string]any{"job_id": automatic.ID, "status": "succeeded"})
	detail, err := s.JournalDetail(ctx, "alice", "audit", "legacy-module")
	if err != nil || detail.Event.Action != "refresh" || detail.Event.ObjectName != instance.Name || !strings.Contains(detail.Event.Title, "Обновление состояния модуля") {
		t.Fatalf("legacy projection: %+v %v", detail, err)
	}
	var raw []byte
	if err = s.Pool.QueryRow(ctx, `SELECT body FROM audit_events WHERE id='legacy-module'`).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "module_action") || strings.Contains(string(raw), instance.Name) {
		t.Fatal("raw history rewritten")
	}
	rawJournalAudit(t, s, "legacy-queued-module", "module.queued", instance.ID, map[string]any{"job_id": automatic.ID, "action": "refresh"})
	queued, err := s.JournalDetail(ctx, "alice", "audit", "legacy-queued-module")
	if err != nil || queued.Event.ObjectKind != "job" || queued.Event.ObjectID != automatic.ID || queued.Event.EventType != "operation" || !strings.Contains(queued.Event.Title, "в очереди") {
		t.Fatalf("queued lifecycle: %+v %v", queued, err)
	}
	// Scope changes must invalidate the pagination snapshot.
	_, err = s.Journal(ctx, "alice", JournalFilter{Channel: "events", Snapshot: page.Snapshot})
	if !errors.Is(err, ErrInvalid) {
		t.Fatalf("filter scope ignored: %v", err)
	}
}

func TestModuleQueuedAuditStoresStableContext(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	instance, job, err := s.QueueModule(ctx, "local-admin", "journal-install", "", "install", model.ModuleRequest{ModuleID: "forms", Name: "Формы стенда", Mode: "local"})
	if err != nil {
		t.Fatal(err)
	}
	events, err := s.Events(ctx, true)
	if err != nil {
		t.Fatal(err)
	}
	var event model.Event
	for _, row := range events {
		if row.Kind == "module.queued" {
			event = row
		}
	}
	if event.ResourceID != "" || detailString(event.Details, "object_kind") != "job" || detailString(event.Details, "object_id") != job.ID || detailString(event.Details, "instance_id") != instance.ID || detailString(event.Details, "module_id") != "forms" || detailString(event.Details, "object_name") != "Формы стенда" || !strings.Contains(event.Title, "Установка модуля · Формы стенда") {
		t.Fatalf("queued audit: %+v", event)
	}
}

package server

import (
	"context"
	"net/http"
	"testing"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/store"
)

func TestEventJournalAPIAuthorizationAndValidation(t *testing.T) {
	s := apiFixture(t)
	admin := apiUser(t, s, "journal-admin", true)
	viewer := apiUser(t, s, "journal-viewer", false)
	routes := []struct{ method, path string }{{"GET", "/api/v1/event-journal"}, {"POST", "/api/v1/event-journal/view"}, {"GET", "/api/v1/event-journal/missing"}}
	for _, r := range routes {
		for _, who := range []struct {
			user apiIdentity
			code int
		}{{viewer, 403}, {apiIdentity{}, 401}} {
			if w := apiCall(s, who.user, r.method, r.path, map[string]any{"initialize": true}, nil); w.Code != who.code {
				t.Fatalf("%s %s: %d want %d", r.method, r.path, w.Code, who.code)
			}
		}
	}
	for _, headers := range []map[string]string{{"X-CSRF-Token": ""}, {"X-CSRF-Token": "wrong"}, {"Origin": "https://attacker.invalid"}} {
		if w := apiCall(s, admin, "POST", "/api/v1/event-journal/view", map[string]any{"initialize": true}, headers); w.Code != 403 {
			t.Fatalf("CSRF accepted: %d", w.Code)
		}
	}
	badBodies := []any{map[string]any{}, map[string]any{"initialize": true, "ids": []string{"x"}}, map[string]any{"initialize": true, "channel": "audit"}, map[string]any{"initialize": true, "user_id": "other"}, map[string]any{"channel": "other", "ids": []string{"x"}}, map[string]any{"channel": "events", "ids": []string{}}, map[string]any{"channel": "events", "ids": make([]string, 101)}}
	for _, body := range badBodies {
		if w := apiCall(s, admin, "POST", "/api/v1/event-journal/view", body, nil); w.Code != 400 {
			t.Fatalf("invalid body %v accepted: %d", body, w.Code)
		}
	}
	for _, suffix := range []string{"?channel=nope", "?from=yesterday", "?from=2026-10-24T00:00:00Z&to=2026-10-23T00:00:00Z", "?limit=101", "?limit=0", "?source=other", "?type=other", "?monitoring_only=maybe", "?exclude_collection=maybe", "?snapshot=bad"} {
		if w := apiCall(s, admin, "GET", "/api/v1/event-journal"+suffix, nil, nil); w.Code != 400 {
			t.Fatalf("invalid query %s accepted: %d %s", suffix, w.Code, w.Body.String())
		}
	}
	if w := apiCall(s, admin, "POST", "/api/v1/event-journal/view", map[string]any{"initialize": true}, nil); w.Code != http.StatusNoContent {
		t.Fatalf("init: %d %s", w.Code, w.Body.String())
	}
	if e := s.Store.Event(context.Background(), "problem.firing", "Journal API event", "", "system", map[string]any{"source_kind": "alertmanager", "time_basis": "source", "occurred_at": time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)}, false); e != nil {
		t.Fatal(e)
	}
	page := apiDecode[store.JournalPage](t, apiCall(s, admin, "GET", "/api/v1/event-journal", nil, nil), 200)
	if len(page.Items) != 1 || !page.Items[0].Unread {
		t.Fatalf("journal API: %+v", page)
	}
	detail := apiDecode[store.JournalDetail](t, apiCall(s, admin, "GET", "/api/v1/event-journal/"+page.Items[0].ID, nil, nil), 200)
	if detail.Event.ID != page.Items[0].ID {
		t.Fatal("wrong detail")
	}
	if w := apiCall(s, admin, "POST", "/api/v1/event-journal/view", map[string]any{"channel": "events", "ids": []string{page.Items[0].ID}}, nil); w.Code != 204 {
		t.Fatal(w.Code, w.Body.String())
	}
	audit := apiDecode[store.JournalPage](t, apiCall(s, admin, "GET", "/api/v1/event-journal?channel=audit&actor=journal-admin", nil, nil), 200)
	if len(audit.Items) != 1 {
		t.Fatalf("actor substring search: %+v", audit)
	}
	absent := apiDecode[store.JournalPage](t, apiCall(s, admin, "GET", "/api/v1/event-journal?channel=audit&actor=no-such-user", nil, nil), 200)
	if len(absent.Items) != 0 {
		t.Fatal("actor filter ignored")
	}
	reread := apiDecode[store.JournalPage](t, apiCall(s, admin, "GET", "/api/v1/event-journal", nil, nil), 200)
	if reread.Items[0].Unread {
		t.Fatal("read acknowledgement not persisted")
	}
}

func TestModuleOperationAPIContextAndServiceFilter(t *testing.T) {
	s := apiFixture(t)
	admin := apiUser(t, s, "module-journal-admin", true)
	ctx := context.Background()
	if w := apiCall(s, admin, "POST", "/api/v1/event-journal/view", map[string]any{"initialize": true}, nil); w.Code != 204 {
		t.Fatal(w.Code, w.Body.String())
	}
	if _, err := s.Store.Pool.Exec(ctx, `INSERT INTO documents(kind,id,body) VALUES('module_instance','module-api','{"id":"module-api","module_id":"prometheus","name":"Метрики API"}')`); err != nil {
		t.Fatal(err)
	}
	job, err := s.Store.Enqueue(ctx, model.Job{Kind: "module", Actor: "system:modules", IdempotencyKey: "api-module", Parameters: map[string]any{"instance_id": "module-api", "action": "refresh"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Store.Pool.Exec(ctx, `UPDATE jobs SET status='succeeded',body=jsonb_set(body,'{status}','"succeeded"') WHERE id=$1`, job.ID); err != nil {
		t.Fatal(err)
	}
	if err = s.Store.Event(ctx, "job.succeeded", "Задание — завершено", "", "system:modules", map[string]any{"job_id": job.ID, "status": "succeeded"}, false); err != nil {
		t.Fatal(err)
	}
	operations := apiDecode[[]workspaceOperation](t, apiCall(s, admin, "GET", "/api/v1/operations", nil, nil), 200)
	if len(operations) != 1 || operations[0].ActorName != "Система · modules" || operations[0].Parameters["module_name"] != "Метрики API" {
		t.Fatalf("operations: %+v", operations)
	}
	hidden := apiDecode[[]workspaceOperation](t, apiCall(s, admin, "GET", "/api/v1/operations?exclude_service_refresh=true", nil, nil), 200)
	if len(hidden) != 0 {
		t.Fatalf("service operations visible: %+v", hidden)
	}
	detail := apiDecode[model.Job](t, apiCall(s, admin, "GET", "/api/v1/jobs/"+job.ID, nil, nil), 200)
	if detail.Parameters["module_name"] != "Метрики API" || detail.Parameters["action"] != "refresh" {
		t.Fatalf("job detail metadata: %+v", detail)
	}
	page := apiDecode[store.JournalPage](t, apiCall(s, admin, "GET", "/api/v1/event-journal", nil, nil), 200)
	if len(page.Items) != 1 || page.Items[0].Action != "refresh" || page.Items[0].ObjectName != "Метрики API" || page.Items[0].ActorName != "Система · modules" {
		t.Fatalf("journal: %+v", page)
	}
	filtered := apiDecode[store.JournalPage](t, apiCall(s, admin, "GET", "/api/v1/event-journal?exclude_service_refresh=true", nil, nil), 200)
	if filtered.Total != 0 || len(filtered.Items) != 0 {
		t.Fatalf("service events visible: %+v", filtered)
	}
	for _, path := range []string{"/api/v1/event-journal?exclude_service_refresh=maybe", "/api/v1/operations?exclude_service_refresh=maybe"} {
		if w := apiCall(s, admin, "GET", path, nil, nil); w.Code != 400 {
			t.Fatalf("invalid bool accepted: %s %d", path, w.Code)
		}
	}
}

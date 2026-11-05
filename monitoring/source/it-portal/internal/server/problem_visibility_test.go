package server

import (
	"context"
	"pl/portal/internal/model"
	"pl/portal/internal/store"
	"testing"
	"time"
)

func TestAPIProblemVisibilityAdminCSRFAndSharedState(t *testing.T) {
	s := apiFixture(t)
	ctx := context.Background()
	ad := apiUser(t, s, "ad:platform-member", true)
	local := apiUser(t, s, "local-admin", true)
	viewer := apiUser(t, s, "ad:nonmember", false)
	b, e := s.Store.Save(ctx, "integration", "visibility-source", 0, model.Integration{ID: "visibility-source", Kind: "alertmanager", Enabled: true}, "test")
	if e != nil {
		t.Fatal(e)
	}
	source, e := store.Decode[model.Integration](b)
	if e != nil {
		t.Fatal(e)
	}
	snapshot := model.Snapshot{Problems: []model.Problem{{ExternalID: "test-alert", Title: "Known problem", StartedAt: time.Now().UTC().Add(-time.Minute)}}}
	if e = s.Store.ApplySnapshot(ctx, source, snapshot, nil); e != nil {
		t.Fatal(e)
	}
	id := store.SourceID(source.ID, "test-alert")
	path := "/api/v1/problems/" + id + "/visibility"
	for _, tc := range []struct {
		who     apiIdentity
		headers map[string]string
		code    int
	}{{viewer, nil, 403}, {apiIdentity{}, nil, 401}, {ad, map[string]string{"X-CSRF-Token": ""}, 403}, {ad, map[string]string{"Origin": "https://evil.invalid"}, 403}} {
		if w := apiCall(s, tc.who, "PUT", path, map[string]bool{"hidden": true}, tc.headers); w.Code != tc.code {
			t.Fatalf("got %d want %d", w.Code, tc.code)
		}
	}
	for _, body := range []any{map[string]any{}, map[string]any{"hidden": nil}, map[string]any{"hidden": "true"}, map[string]any{"hidden": true, "actor": "forged"}} {
		if w := apiCall(s, ad, "PUT", path, body, nil); w.Code != 400 {
			t.Fatalf("invalid input accepted: %d", w.Code)
		}
	}
	if w := apiCall(s, ad, "PUT", "/api/v1/problems/missing/visibility", map[string]bool{"hidden": true}, nil); w.Code != 404 {
		t.Fatal(w.Code)
	}
	if w := apiCall(s, ad, "PUT", path, map[string]any{"hidden": true, "expected_started_at": snapshot.Problems[0].StartedAt}, nil); w.Code != 204 {
		t.Fatal(w.Code, w.Body.String())
	}
	items := apiDecode[[]model.Problem](t, apiCall(s, local, "GET", "/api/v1/problems", nil, nil), 200)
	if len(items) != 1 || !items[0].Hidden || items[0].Status != "firing" || items[0].HiddenBy != "ad:platform-member" || items[0].HiddenByName != "ad:platform-member" {
		t.Fatal(items)
	}
	if w := apiCall(s, local, "PUT", path, map[string]bool{"hidden": false}, nil); w.Code != 204 {
		t.Fatal(w.Code, w.Body.String())
	}
	items = apiDecode[[]model.Problem](t, apiCall(s, ad, "GET", "/api/v1/problems", nil, nil), 200)
	if len(items) != 1 || items[0].Hidden || items[0].HiddenBy != "" || items[0].HiddenAt != nil || items[0].Status != "firing" {
		t.Fatal(items)
	}
	// The source advances after the browser read but before its mutation.
	oldStarted := snapshot.Problems[0].StartedAt
	snapshot.Problems[0].StartedAt = oldStarted.Add(time.Minute)
	if e = s.Store.ApplySnapshot(ctx, source, snapshot, nil); e != nil {
		t.Fatal(e)
	}
	for _, hidden := range []bool{true, false} {
		w := apiCall(s, ad, "PUT", path, map[string]any{"hidden": hidden, "expected_started_at": oldStarted}, nil)
		if w.Code != 409 {
			t.Fatal("stale occurrence accepted", w.Code, w.Body.String())
		}
	}
	items = apiDecode[[]model.Problem](t, apiCall(s, ad, "GET", "/api/v1/problems", nil, nil), 200)
	if len(items) != 1 || items[0].Hidden {
		t.Fatal("stale hide changed new occurrence", items)
	}
	events := apiDecode[[]model.Event](t, apiCall(s, ad, "GET", "/api/v1/audit", nil, nil), 200)
	found := map[string]string{}
	for _, event := range events {
		if event.Kind == "problem.hidden" || event.Kind == "problem.shown" {
			found[event.Kind] = event.ActorName
		}
	}
	if found["problem.hidden"] != "ad:platform-member" || found["problem.shown"] != "local-admin" {
		t.Fatal(found)
	}
}

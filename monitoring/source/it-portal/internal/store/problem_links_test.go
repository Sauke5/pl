package store

import (
	"context"
	"errors"
	"pl/portal/internal/model"
	"reflect"
	"testing"
	"time"
)

func TestExactProblemLinksNeverGuessSharedHostsOrSubstrings(t *testing.T) {
	resources := []model.Resource{
		{ID: "grafana", URL: "https://monitoring.example/grafana/", Hostname: "monitoring.example"},
		{ID: "prom", URL: "https://monitoring.example/prometheus/", Hostname: "monitoring.example"},
		{ID: "db", Type: "Сервер", Hostname: "Vega-sql01", IP: "10.0.0.5"},
		{ID: "vega", URL: "https://vega.example", Hostname: "vega"},
		{ID: "archive", Hostname: "old-node", Lifecycle: "archived"},
	}
	for _, tc := range []struct {
		target     string
		ids        []string
		candidates int
	}{
		{"https://MONITORING.example/grafana", []string{"grafana"}, 1},
		{"monitoring.example:9100", []string{}, 2},
		{"Vega-sql01:9182", []string{"db"}, 1},
		{"Vega-sql010:9182", []string{}, 0},
		{"10.0.0.5:9182", []string{"db"}, 1},
		{"old-node:9100", []string{}, 0},
	} {
		result := ResolveProblemLinks(model.Problem{Labels: map[string]string{"instance": tc.target}}, resources, emptyLinkConfig())
		if !reflect.DeepEqual(result.ResourceIDs, tc.ids) || len(result.Candidates) != tc.candidates {
			t.Fatalf("%s: %+v", tc.target, result)
		}
	}
	// Identical URLs belonging to different active cards are ambiguous.
	resources = append(resources, model.Resource{ID: "duplicate", URL: resources[0].URL})
	result := ResolveProblemLinks(model.Problem{Labels: map[string]string{"target": resources[0].URL}}, resources, emptyLinkConfig())
	if len(result.ResourceIDs) != 0 || len(result.Candidates) != 2 {
		t.Fatal(result)
	}
}
func TestProblemLinkOverridesSurvivePollAndRulesFollowTarget(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	source := putIntegration(t, s, "alertmanager")
	a := putResource(t, s, model.Resource{Name: "DB", Type: "Сервер", URL: "https://db.example", Hostname: "db-node", Lifecycle: "active"})
	b := putResource(t, s, model.Resource{Name: "Backup", URL: "https://backup.example", Lifecycle: "active"})
	snapshot := model.Snapshot{Problems: []model.Problem{{ExternalID: "alert", Title: "CPU", StartedAt: time.Now().UTC(), Labels: map[string]string{"instance": "db-node:9182", "job": "windows"}}}}
	if e := s.ApplySnapshot(ctx, source, snapshot, nil); e != nil {
		t.Fatal(e)
	}
	id := SourceID(source.ID, "alert")
	state, e := s.ProblemLinks(ctx, id)
	if e != nil || !reflect.DeepEqual(state.ResourceIDs, []string{a.ID}) {
		t.Fatal(state, e)
	}
	actor := model.User{ID: "local-admin", Name: "Admin"}
	update := model.ProblemLinkUpdate{Revision: state.Revision, Mode: "manual", Scope: "problem", ResourceIDs: []string{b.ID}}
	if e = s.SetProblemLinks(ctx, id, update, actor); e != nil {
		t.Fatal(e)
	}
	if e = s.SetProblemLinks(ctx, id, update, actor); !errors.Is(e, ErrConflict) {
		t.Fatal("stale write accepted", e)
	}
	if e = s.ApplySnapshot(ctx, source, snapshot, nil); e != nil {
		t.Fatal(e)
	}
	state, e = s.ProblemLinks(ctx, id)
	if e != nil || state.Revision != 1 || !reflect.DeepEqual(state.ResourceIDs, []string{b.ID}) {
		t.Fatal(state, e)
	}
	update = model.ProblemLinkUpdate{Revision: state.Revision, Mode: "manual", Scope: "target", Label: "instance", Value: "db-node:9182", Job: "windows", ResourceIDs: []string{a.ID, b.ID}}
	if e = s.SetProblemLinks(ctx, id, update, actor); e != nil {
		t.Fatal(e)
	}
	snapshot.Problems = append(snapshot.Problems, model.Problem{ExternalID: "another-alert", Title: "Memory", StartedAt: time.Now().UTC(), Labels: map[string]string{"instance": "db-node:9182", "job": "windows"}})
	if e = s.ApplySnapshot(ctx, source, snapshot, nil); e != nil {
		t.Fatal(e)
	}
	second := SourceID(source.ID, "another-alert")
	state, e = s.ProblemLinks(ctx, second)
	if e != nil || state.Rule == nil || !reflect.DeepEqual(state.ResourceIDs, []string{a.ID, b.ID}) {
		t.Fatal(state, e)
	}
	if e = s.SetProblemLinks(ctx, second, model.ProblemLinkUpdate{Revision: state.Revision, Mode: "disabled", Scope: "problem"}, actor); e != nil {
		t.Fatal(e)
	}
	state, e = s.ProblemLinks(ctx, second)
	if e != nil || state.Mode != "disabled" || len(state.ResourceIDs) != 0 {
		t.Fatal(state, e)
	}
	config, e := s.LinkConfig(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.SetProblemLinks(ctx, id, model.ProblemLinkUpdate{Revision: config.Revision, Mode: "auto", Scope: "problem", RemoveRuleID: config.Rules[0].ID}, actor); e != nil {
		t.Fatal(e)
	}
	state, e = s.ProblemLinks(ctx, id)
	if e != nil || state.Mode != "auto" || !reflect.DeepEqual(state.ResourceIDs, []string{a.ID}) {
		t.Fatal(state, e)
	}
	// Changing the resource identity immediately recalculates read-side links.
	a.Hostname = "different-node"
	if _, e = s.Save(ctx, "resource", a.ID, a.Revision, a, actor.ID); e != nil {
		t.Fatal(e)
	}
	problems, e := s.Problems(ctx)
	if e != nil {
		t.Fatal(e)
	}
	for _, p := range problems {
		if p.ResourceID != "" || len(p.ResourceIDs) != 0 {
			t.Fatal("stale match remained", p)
		}
	}
}

func TestWebEndpointMismatchIsOnlyASuggestion(t *testing.T) {
	resources := []model.Resource{{ID: "web", Type: "Web-сервис", URL: "https://node.example/app", Hostname: "node.example"}}
	for _, target := range []string{"http://node.example:443/app", "node.example:9100", "https://node.example/other"} {
		result := ResolveProblemLinks(model.Problem{Labels: map[string]string{"instance": target}}, resources, emptyLinkConfig())
		if len(result.ResourceIDs) != 0 {
			t.Fatalf("wrong automatic mapping for %s: %+v", target, result)
		}
	}
}

func TestProblemEventsUseCurrentManualLinkBeforeNextFiringPoll(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	source := putIntegration(t, s, "alertmanager")
	a := putResource(t, s, model.Resource{Name: "A", Type: "Сервер", Hostname: "host", Lifecycle: "active"})
	b := putResource(t, s, model.Resource{Name: "B", Lifecycle: "active"})
	snapshot := model.Snapshot{Problems: []model.Problem{{ExternalID: "alert", Title: "Down", StartedAt: time.Now().UTC(), Labels: map[string]string{"instance": "host:9100"}}}}
	if e := s.ApplySnapshot(ctx, source, snapshot, nil); e != nil {
		t.Fatal(e)
	}
	id := SourceID(source.ID, "alert")
	initial, e := s.ProblemLinks(ctx, id)
	if e != nil || len(initial.ResourceIDs) != 1 || initial.ResourceIDs[0] != a.ID {
		t.Fatal(initial, e)
	}
	actor := model.User{ID: "local-admin", Name: "Admin"}
	if e = s.SetProblemLinks(ctx, id, model.ProblemLinkUpdate{Revision: 0, Mode: "manual", Scope: "problem", ResourceIDs: []string{b.ID}}, actor); e != nil {
		t.Fatal(e)
	}
	if e = s.SetProblemVisibility(ctx, id, true, actor, nil); e != nil {
		t.Fatal(e)
	}
	if e = s.ApplySnapshot(ctx, source, model.Snapshot{}, nil); e != nil {
		t.Fatal(e)
	}
	events, e := s.Events(ctx, false)
	if e != nil {
		t.Fatal(e)
	}
	found := 0
	for _, event := range events {
		if event.Kind == "problem.resolved" || event.Kind == "problem.hidden" {
			found++
			if event.ResourceID != b.ID {
				t.Fatal("old link in event", event)
			}
		}
	}
	if found != 2 {
		t.Fatal("missing transition events", found)
	}
}

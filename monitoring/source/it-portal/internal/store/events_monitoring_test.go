package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"pl/portal/internal/model"
)

func TestProblemEventSourceTime(t *testing.T) {
	i := model.Integration{ID: "am", Name: "Alertmanager", Kind: "alertmanager"}
	p := model.Problem{ID: "p", ExternalID: "fp", Severity: "critical", StartedAt: time.Date(2026, 10, 23, 10, 0, 0, 0, time.UTC)}
	firing := problemEventDetails(i, p, true)
	if firing["time_basis"] != "source" || firing["occurred_at"] != "2026-10-23T10:00:00Z" || firing["source_kind"] != "alertmanager" {
		t.Fatal(firing)
	}
	resolved := problemEventDetails(i, p, false)
	if resolved["time_basis"] != "observed" || resolved["occurred_at"] != nil || resolved["integration_id"] != "am" {
		t.Fatal(resolved)
	}
}

func TestPostgresMonitoringTransitionsAndConfirmations(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	i := putIntegration(t, s, "prometheus")
	sample := model.MonitoringTarget{ExternalID: "t", Name: "node", Health: "down", LastScrape: time.Now().UTC(), Labels: map[string]string{"job": "node"}}
	apply := func(targets []model.MonitoringTarget, err error) {
		t.Helper()
		if e := s.ApplySnapshot(ctx, i, model.Snapshot{Targets: targets}, err); e != nil {
			t.Fatal(e)
		}
	}
	apply([]model.MonitoringTarget{sample}, nil) // baseline down stays silent
	apply([]model.MonitoringTarget{sample}, nil) // repeat stays silent
	apply(nil, errors.New("failure"))
	apply(nil, errors.New("failure")) // one disconnected event
	o, e := Get[EventObservation](ctx, s, "event_observation", SourceID(i.ID, "target:t"))
	if e != nil || o.Health != "down" || o.Confirmations != 2 {
		t.Fatalf("last known lost: %+v %v", o, e)
	}
	sample.Health = "up"
	apply([]model.MonitoringTarget{sample}, nil)
	apply(nil, nil) // absence must not invent down/up
	sample.Health = "unknown"
	apply([]model.MonitoringTarget{sample}, nil)
	sample.Health = "up"
	apply([]model.MonitoringTarget{sample}, nil) // unknown did not replace last known
	sample.Health = "down"
	apply([]model.MonitoringTarget{sample}, nil)
	sample.ExternalID = "new-down"
	apply([]model.MonitoringTarget{sample}, nil) // newly observed down after baseline matters
	events, e := s.Events(ctx, false)
	if e != nil {
		t.Fatal(e)
	}
	counts := map[string]int{}
	for _, event := range events {
		counts[event.Kind]++
		if event.Details["source_kind"] != "prometheus" {
			t.Fatalf("missing source: %+v", event)
		}
	}
	if counts["target.up"] != 1 || counts["target.down"] != 2 || counts["source.disconnected"] != 1 || counts["source.reconnected"] != 1 || len(events) != 5 {
		t.Fatal(counts)
	}
	// A later health transition must not overwrite an earlier episode's details.
	for _, event := range events {
		if event.Kind != "target.up" {
			continue
		}
		id, ok := event.Details["observation_id"].(string)
		if !ok {
			t.Fatal("missing episode id")
		}
		history, err := Get[EventObservation](ctx, s, "event_observation", id)
		if err != nil || history.Health != "up" || history.Confirmations != 2 {
			t.Fatalf("historical episode overwritten: %+v %v", history, err)
		}
	}

}

func TestPostgresProblemConfirmationsDoNotCreateEvents(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	i := putIntegration(t, s, "alertmanager")
	p := model.Problem{ExternalID: "fp", Title: "Down", StartedAt: time.Now().UTC().Add(-time.Minute)}
	for n := 0; n < 3; n++ {
		if e := s.ApplySnapshot(ctx, i, model.Snapshot{Problems: []model.Problem{p}}, nil); e != nil {
			t.Fatal(e)
		}
	}
	o, e := Get[EventObservation](ctx, s, "event_observation", problemObservationID(i, p))
	if e != nil || o.Confirmations != 3 || o.LastConfirmedAt.Before(o.FirstSeen) {
		t.Fatalf("%+v %v", o, e)
	}
	events, e := s.Events(ctx, false)
	if e != nil || len(events) != 1 || events[0].Kind != "problem.firing" {
		t.Fatalf("%+v %v", events, e)
	}
	// A changed source startsAt proves a new firing episode, even if polling missed recovery.
	p.StartedAt = p.StartedAt.Add(time.Second)
	if e := s.ApplySnapshot(ctx, i, model.Snapshot{Problems: []model.Problem{p}}, nil); e != nil {
		t.Fatal(e)
	}
	events, e = s.Events(ctx, false)
	if e != nil || len(events) != 2 {
		t.Fatalf("missed new source episode: %+v %v", events, e)
	}
}

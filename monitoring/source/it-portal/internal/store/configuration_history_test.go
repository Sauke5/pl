package store

import (
	"context"
	"github.com/google/uuid"
	"pl/portal/internal/model"
	"strings"
	"testing"
	"time"
)

func TestConfigurationHistoryIdentityBindingsAndStaleness(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	first, second := uuid.NewString(), uuid.NewString()
	for _, id := range []string{first, second} {
		if _, err := s.Save(ctx, "resource", id, 0, model.Resource{ID: id, Name: "Router"}, "admin"); err != nil {
			t.Fatal(err)
		}
	}
	i := model.Integration{ID: uuid.NewString(), Kind: "oxidized", URL: "https://oxidized.example", Enabled: true, Status: "connected", PollSeconds: 60, Config: map[string]string{"gitea_repository_url": "https://git.example/ops/configs", "node_bindings": `{"a/r1":"` + first + `"}`}}
	if _, err := s.Save(ctx, "integration", i.ID, 0, i, "admin"); err != nil {
		t.Fatal(err)
	}
	apply := func(nodes []model.ConfigurationNode) {
		t.Helper()
		tx, err := s.Pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if err = applyConfigurationSnapshot(ctx, tx, i, &model.ConfigurationSnapshot{ObservedAt: now, Nodes: nodes}, now); err != nil {
			t.Fatal(err)
		}
		if err = tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}
	update := func() {
		t.Helper()
		if _, err := s.Pool.Exec(ctx, "UPDATE documents SET body=$2 WHERE kind='integration' AND id=$1", i.ID, encode(i)); err != nil {
			t.Fatal(err)
		}
	}
	read := func() model.ConfigurationHistory {
		t.Helper()
		v, err := s.ConfigurationHistory(ctx, i.ID)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	apply([]model.ConfigurationNode{{Key: "a/r1", Name: "r1", Group: "a", CollectionStatus: "success", LastSuccessfulCollectionAt: &now, LastChangeAt: &now, Revision: strings.Repeat("a", 40)}})
	history := read()
	if history.Stale || history.SourceStatus != "ok" || len(history.Nodes) != 1 || history.Nodes[0].ResourceID != first || history.Nodes[0].DiffURL == "" {
		t.Fatalf("bad history: %+v", history)
	}
	i.Config["node_bindings"] = `{"a/r1":"` + second + `"}`
	i.Config["gitea_repository_url"] = "https://git.example/new/repo"
	update()
	history = read()
	if history.Nodes[0].ResourceID != second || !strings.Contains(history.Nodes[0].HistoryURL, "/new/repo/") {
		t.Fatal("stale binding", history)
	}
	linked, err := s.ResourceConfigurationHistory(ctx, first)
	if err != nil || len(linked) != 0 {
		t.Fatal("old binding exposed", linked, err)
	}
	linked, err = s.ResourceConfigurationHistory(ctx, second)
	if err != nil || len(linked) != 1 {
		t.Fatal("new binding missing", linked, err)
	}
	apply([]model.ConfigurationNode{{Key: "a/r1", Name: "r1", Group: "a", CollectionStatus: "failed", Error: "История недоступна"}})
	history = read()
	if history.SourceStatus != "partial" || !history.Stale || history.Nodes[0].LastSuccessfulCollectionAt == nil || !history.Nodes[0].LastSuccessfulCollectionAt.Equal(now) || history.Nodes[0].Revision != strings.Repeat("a", 40) || history.Nodes[0].LastChangeAt == nil || !history.Nodes[0].LastChangeAt.Equal(now) {
		t.Fatal("lost evidence", history)
	}
	i.Status = "error"
	update()
	history = read()
	if history.SourceStatus != "stale" || len(history.Nodes) != 1 {
		t.Fatal("lost cached data", history)
	}
	i.Status = "connected"
	i.Enabled = false
	update()
	if history = read(); history.SourceStatus != "stale" {
		t.Fatal(history)
	}
	i.Enabled = true
	i.URL = "https://replacement.example"
	update()
	history = read()
	if history.ObservedAt != nil || len(history.Nodes) != 0 || history.SourceStatus != "unavailable" {
		t.Fatal("old identity exposed", history)
	}
	var raw []byte
	if err = s.Pool.QueryRow(ctx, "SELECT body FROM documents WHERE kind='configuration_history' AND id=$1", i.ID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), first) || strings.Contains(string(raw), "git.example") {
		t.Fatal("mutable metadata persisted")
	}
}

func TestConfigurationHistoryRejectsAmbiguousCache(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	node := model.ConfigurationNode{Key: "a/r", Group: "a", Name: "r"}
	if err = applyConfigurationSnapshot(ctx, tx, model.Integration{ID: uuid.NewString()}, &model.ConfigurationSnapshot{ObservedAt: time.Now(), Nodes: []model.ConfigurationNode{node, node}}, time.Now()); err == nil {
		t.Fatal("duplicate node accepted")
	}
}

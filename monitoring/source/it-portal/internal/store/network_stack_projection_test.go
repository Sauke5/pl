package store

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"pl/portal/internal/model"
)

func networkStackTestInstance() model.ModuleInstance {
	return model.ModuleInstance{ID: "22222222-2222-4222-8222-222222222222", ModuleID: "netmap", Name: "NetMap",
		ResourceID:    SourceID("module-resource", "22222222-2222-4222-8222-222222222222"),
		IntegrationID: SourceID("module-integration", "22222222-2222-4222-8222-222222222222"), Mode: "local",
		DesiredState: "enabled", ObservedState: "running"}
}

func networkStackTransaction(t *testing.T, s *Store, fn func(context.Context, pgx.Tx) error) {
	t.Helper()
	ctx := context.Background()
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err = fn(ctx, tx); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func networkStackID(instance model.ModuleInstance, kind string) string {
	return SourceID("module-component-resource", instance.ID+":"+kind)
}

func TestNetworkStackHelpersIgnoreOtherModulesWithoutDatabaseAccess(t *testing.T) {
	ctx := context.Background()
	for _, kind := range []string{"", "grafana", "bookstack", "sftpgo", "prometheus"} {
		instance := model.ModuleInstance{ModuleID: kind}
		if err := syncNetworkStackResources(ctx, nil, instance); err != nil {
			t.Fatal(err)
		}
		if err := deleteNetworkStackResources(ctx, nil, instance, "test"); err != nil {
			t.Fatal(err)
		}
	}
	if err := syncNetworkStackResources(ctx, nil, model.ModuleInstance{ModuleID: "netmap"}); !errors.Is(err, ErrConflict) {
		t.Fatal("empty instance ownership admitted", err)
	}
}

func TestNetworkStackProjectionCreatesStableChildrenAndPreservesMainCard(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	instance := networkStackTestInstance()
	main := putResource(t, s, model.Resource{ID: instance.ResourceID, ManagedModuleID: instance.ID, Name: "NetMap", URL: "/netmap/", Directions: []string{"Сети"}})
	for i := 0; i < 2; i++ {
		networkStackTransaction(t, s, func(ctx context.Context, tx pgx.Tx) error { return syncNetworkStackResources(ctx, tx, instance) })
	}
	resources, err := List[model.Resource](ctx, s, "resource")
	if err != nil || len(resources) != 4 {
		t.Fatalf("expected main and three stable cards, got %d: %v", len(resources), err)
	}
	for _, component := range networkStackComponents {
		id := networkStackID(instance, component.kind)
		resource, err := Get[model.Resource](ctx, s, "resource", id)
		if err != nil || resource.ID != id || resource.ManagedModuleID != instance.ID || resource.Name != component.name || resource.URL != "/netmap/"+component.kind+"/" || !reflect.DeepEqual(resource.Directions, []string{component.direction}) {
			t.Fatalf("invalid component projection: %+v %v", resource, err)
		}
		if resource.CreatedAt.IsZero() || resource.UpdatedAt.Before(resource.CreatedAt) {
			t.Fatal("component timestamps missing")
		}
	}
	stored, err := Get[model.Resource](ctx, s, "resource", instance.ResourceID)
	if err != nil || !reflect.DeepEqual(main, stored) {
		t.Fatalf("child sync changed main card: %+v %v", stored, err)
	}
}

func TestNetworkStackResyncPreservesOwnedManualMetadataAndRestoresManagedURL(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	instance := networkStackTestInstance()
	networkStackTransaction(t, s, func(ctx context.Context, tx pgx.Tx) error { return syncNetworkStackResources(ctx, tx, instance) })
	id := networkStackID(instance, "netbox")
	resource, err := Get[model.Resource](ctx, s, "resource", id)
	if err != nil {
		t.Fatal(err)
	}
	resource.Name, resource.Description, resource.Icon = "Инвентаризация", "Локальное описание", "database"
	resource.URL, resource.Directions, resource.Tags = "https://manual.example/", []string{"Своя группа"}, []string{"manual"}
	resource.Aliases, resource.Site, resource.Environment = []string{"registry"}, "Площадка", "Test"
	resource.Relations = []model.Relation{{ResourceID: "custom-peer", Label: "Локальная связь"}}
	resource.Endpoints = []model.Endpoint{{Name: "API", URL: "https://local.example/api"}}
	resource.Employee = &model.EmployeeMetadata{DisplayName: "Реестр", Description: "Для сотрудников", Category: "Сети", Icon: "network"}
	resource = putResource(t, s, resource)
	created := resource.CreatedAt
	networkStackTransaction(t, s, func(ctx context.Context, tx pgx.Tx) error { return syncNetworkStackResources(ctx, tx, instance) })
	updated, err := Get[model.Resource](ctx, s, "resource", id)
	if err != nil {
		t.Fatal(err)
	}
	// Only routing and save metadata are managed on an existing owned card.
	expected := resource
	expected.URL, expected.Revision, expected.UpdatedAt = "/netmap/netbox/", updated.Revision, updated.UpdatedAt
	if !reflect.DeepEqual(updated, expected) || !updated.CreatedAt.Equal(created) || updated.Revision <= resource.Revision {
		t.Fatalf("manual metadata lost after resync: got %+v want %+v", updated, expected)
	}
}

func TestNetworkStackSyncNeverAdoptsForeignDeterministicResource(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	instance := networkStackTestInstance()
	id := networkStackID(instance, "gitea")
	foreign := putResource(t, s, model.Resource{ID: id, Name: "Чужой ресурс", ManagedModuleID: "foreign", URL: "https://foreign.example/"})
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = syncNetworkStackResources(ctx, tx, instance); !errors.Is(err, ErrConflict) {
		tx.Rollback(ctx)
		t.Fatalf("foreign deterministic resource adopted: %v", err)
	}
	if err = tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	stored, err := Get[model.Resource](ctx, s, "resource", id)
	if err != nil || !reflect.DeepEqual(stored, foreign) {
		t.Fatalf("foreign resource changed: %+v %v", stored, err)
	}
	resources, err := List[model.Resource](ctx, s, "resource")
	if err != nil || len(resources) != 1 {
		t.Fatalf("transaction kept partial child creations: %d %v", len(resources), err)
	}
}

func TestNetworkStackRemovalPrunesChildReferencesAndKeepsUnrelatedResources(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	instance := networkStackTestInstance()
	main := putResource(t, s, model.Resource{ID: instance.ResourceID, Name: "NetMap", ManagedModuleID: instance.ID, URL: "/netmap/"})
	networkStackTransaction(t, s, func(ctx context.Context, tx pgx.Tx) error { return syncNetworkStackResources(ctx, tx, instance) })
	ids := []string{networkStackID(instance, "netbox"), networkStackID(instance, "oxidized"), networkStackID(instance, "gitea")}
	peer := putResource(t, s, model.Resource{Name: "Другой ресурс", Relations: []model.Relation{{ResourceID: ids[0], Label: "NetBox"}, {ResourceID: ids[1], Label: "Oxidized"}, {ResourceID: ids[2], Label: "Gitea"}, {ResourceID: main.ID, Label: "NetMap"}}})
	all := append(append([]string{}, ids...), main.ID, peer.ID)
	collection := putCollection(t, s, model.Collection{Name: "Все сервисы", ResourceIDs: all})
	for kind, entry := range map[string]struct {
		id    string
		value any
	}{
		"preferences": {"test-user", model.Preferences{Favorites: all}},
		"settings":    {"global", model.Settings{BoardResourceIDs: all}},
		"problem_links": {"global", model.ProblemLinkConfig{
			Overrides: map[string]model.ProblemLinkOverride{
				"shared":     {Mode: "manual", ResourceIDs: all},
				"child-only": {Mode: "manual", ResourceIDs: ids},
			},
			Rules: []model.ProblemLinkRule{{ID: "shared", ResourceIDs: all}, {ID: "child-only", ResourceIDs: ids}},
		}},
	} {
		revision := int64(0)
		if kind == "settings" {
			settings, err := Get[model.Settings](ctx, s, kind, entry.id)
			if err != nil {
				t.Fatal(err)
			}
			revision = settings.Revision
		}
		if kind == "problem_links" {
			current, err := Get[model.ProblemLinkConfig](ctx, s, kind, entry.id)
			if err != nil && !errors.Is(err, ErrNotFound) {
				t.Fatal(err)
			}
			if err == nil {
				revision = current.Revision
			}
		}
		if _, err := s.Save(ctx, kind, entry.id, revision, entry.value, "test"); err != nil {
			t.Fatal(err)
		}
	}
	networkStackTransaction(t, s, func(ctx context.Context, tx pgx.Tx) error {
		return deleteNetworkStackResources(ctx, tx, instance, "test-admin")
	})
	for _, id := range ids {
		if _, err := Get[model.Resource](ctx, s, "resource", id); !errors.Is(err, ErrNotFound) {
			t.Fatalf("component survived removal: %s %v", id, err)
		}
	}
	for _, item := range []struct{ kind, id string }{{"collection", collection.ID}, {"preferences", "test-user"}, {"settings", "global"}, {"problem_links", "global"}} {
		var body []byte
		if err := s.Pool.QueryRow(ctx, "SELECT body FROM documents WHERE kind=$1 AND id=$2", item.kind, item.id).Scan(&body); err != nil {
			t.Fatal(err)
		}
		for _, id := range ids {
			if strings.Contains(string(body), id) {
				t.Fatalf("child reference retained in %s", item.kind)
			}
		}
		if !strings.Contains(string(body), main.ID) || !strings.Contains(string(body), peer.ID) {
			t.Fatalf("unrelated references removed from %s", item.kind)
		}
	}
	peerAfter, err := Get[model.Resource](ctx, s, "resource", peer.ID)
	if err != nil || !reflect.DeepEqual(peerAfter.Relations, []model.Relation{{ResourceID: main.ID, Label: "NetMap"}}) {
		t.Fatalf("relation pruning changed unrelated relation: %+v %v", peerAfter.Relations, err)
	}
	mainAfter, err := Get[model.Resource](ctx, s, "resource", main.ID)
	if err != nil || !reflect.DeepEqual(mainAfter, main) {
		t.Fatalf("child removal changed main resource: %+v %v", mainAfter, err)
	}
	// Missing children make a repeated delete a no-op.
	networkStackTransaction(t, s, func(ctx context.Context, tx pgx.Tx) error {
		return deleteNetworkStackResources(ctx, tx, instance, "test-admin")
	})
}

func TestNetworkStackRemovalPreflightsAllOwnersBeforeAnyPruning(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	instance := networkStackTestInstance()
	networkStackTransaction(t, s, func(ctx context.Context, tx pgx.Tx) error { return syncNetworkStackResources(ctx, tx, instance) })
	foreign, err := Get[model.Resource](ctx, s, "resource", networkStackID(instance, "gitea"))
	if err != nil {
		t.Fatal(err)
	}
	foreign.ManagedModuleID = "foreign"
	foreign = putResource(t, s, foreign)
	collection := putCollection(t, s, model.Collection{Name: "Keep references", ResourceIDs: []string{networkStackID(instance, "netbox"), foreign.ID}})
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err = deleteNetworkStackResources(ctx, tx, instance, "test-admin"); !errors.Is(err, ErrConflict) {
		t.Fatalf("foreign child did not block removal: %v", err)
	}
	// Inspect inside the still-open transaction: refusal must precede all writes.
	var count int
	if err = tx.QueryRow(ctx, "SELECT count(*) FROM documents WHERE kind='resource' AND body->>'managed_module_id'=$1", instance.ID).Scan(&count); err != nil || count != 2 {
		t.Fatalf("owned cards were removed before foreign preflight: %d %v", count, err)
	}
	var body []byte
	if err = tx.QueryRow(ctx, "SELECT body || jsonb_build_object('revision',revision) FROM documents WHERE kind='collection' AND id=$1", collection.ID).Scan(&body); err != nil {
		t.Fatal(err)
	}
	stored, err := Decode[model.Collection](body)
	if err != nil || stored.Revision != collection.Revision || !reflect.DeepEqual(stored.ResourceIDs, collection.ResourceIDs) {
		t.Fatalf("references pruned before refusal: %+v %v", stored, err)
	}
}

func TestNetworkStackGenericLifecycleRemovesAllFourServiceCards(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	instance := networkStackTestInstance()
	networkStackTransaction(t, s, func(ctx context.Context, tx pgx.Tx) error {
		if err := syncModuleLinks(ctx, tx, &instance); err != nil {
			return err
		}
		_, err := save(ctx, tx, "module_instance", instance.ID, 0, instance)
		return err
	})
	resources, err := List[model.Resource](ctx, s, "resource")
	if err != nil || len(resources) != 4 {
		t.Fatalf("shared sync must project all four cards: %d %v", len(resources), err)
	}
	networkStackTransaction(t, s, func(ctx context.Context, tx pgx.Tx) error {
		return deleteModule(ctx, tx, instance, "test-admin")
	})
	for _, id := range []string{instance.ResourceID, networkStackID(instance, "netbox"), networkStackID(instance, "oxidized"), networkStackID(instance, "gitea")} {
		if _, err := Get[model.Resource](ctx, s, "resource", id); !errors.Is(err, ErrNotFound) {
			t.Fatalf("service card survived generic module removal: %s %v", id, err)
		}
	}
	for _, pair := range []struct{ kind, id string }{{"integration", instance.IntegrationID}, {"module_instance", instance.ID}} {
		var count int
		if err := s.Pool.QueryRow(ctx, "SELECT count(*) FROM documents WHERE kind=$1 AND id=$2", pair.kind, pair.id).Scan(&count); err != nil || count != 0 {
			t.Fatalf("module projection survived removal: %s %d %v", pair.kind, count, err)
		}
	}
	if _, err := Get[model.ModuleInstance](ctx, s, "module_tombstone", instance.ID); err != nil {
		t.Fatal("generic removal lost module tombstone", err)
	}
}

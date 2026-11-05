package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"pl/portal/internal/model"
)

type networkStackComponent struct {
	kind, name, description, direction string
}

var networkStackComponents = [...]networkStackComponent{
	{"netbox", "NetBox", "Реестр сетевого оборудования", "Сети"},
	{"oxidized", "Oxidized", "Конфигурации сетевого оборудования", "Сети"},
	{"gitea", "Gitea", "Репозитории конфигураций", "Управление"},
}

// The main NetMap card belongs to syncModuleLinks. These three children use
// independent stable IDs; their owner and URL are managed, other metadata is local.
// The caller owns the transaction/lock and performs the final shared reindex.
func syncNetworkStackResources(ctx context.Context, tx pgx.Tx, instance model.ModuleInstance) error {
	if instance.ModuleID != "netmap" {
		return nil
	}
	if instance.ID == "" {
		return ErrConflict
	}
	for _, component := range networkStackComponents {
		id := SourceID("module-component-resource", instance.ID+":"+component.kind)
		var body []byte
		var resource model.Resource
		err := tx.QueryRow(ctx, "SELECT body || jsonb_build_object('id',id,'revision',revision) FROM documents WHERE kind='resource' AND id=$1 FOR UPDATE", id).Scan(&body)
		if err == nil {
			resource, err = Decode[model.Resource](body)
			if err != nil {
				return err
			}
			if resource.ManagedModuleID != instance.ID {
				return ErrConflict
			}
		} else if errors.Is(err, pgx.ErrNoRows) {
			resource = model.Resource{ID: id, ManagedModuleID: instance.ID, Name: component.name,
				Description: component.description, Type: "Приложение", Directions: []string{component.direction},
				Source: "module", Lifecycle: "active", CreatedAt: time.Now().UTC(),
				Aliases: []string{}, Tags: []string{}, Relations: []model.Relation{}, Endpoints: []model.Endpoint{},
				Links: []model.Endpoint{}, ExternalIDs: []string{}, Operations: []string{}}
		} else {
			return err
		}
		resource.URL = "/netmap/" + component.kind + "/"
		resource.UpdatedAt = time.Now().UTC()
		if _, err = save(ctx, tx, "resource", id, resource.Revision, resource); err != nil {
			return err
		}
	}
	return nil
}

// Preflight every child before pruning/deleting any of them. A deterministic ID
// collision never authorizes adoption or removal of a foreign catalog resource.
func deleteNetworkStackResources(ctx context.Context, tx pgx.Tx, instance model.ModuleInstance, actor string) error {
	if instance.ModuleID != "netmap" {
		return nil
	}
	if instance.ID == "" {
		return ErrConflict
	}
	var owned []networkStackComponent
	for _, component := range networkStackComponents {
		id := SourceID("module-component-resource", instance.ID+":"+component.kind)
		var owner string
		err := tx.QueryRow(ctx, "SELECT COALESCE(body->>'managed_module_id','') FROM documents WHERE kind='resource' AND id=$1 FOR UPDATE", id).Scan(&owner)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return err
		}
		if owner != instance.ID {
			return ErrConflict
		}
		owned = append(owned, component)
	}
	ids := map[string]bool{}
	for _, component := range networkStackComponents {
		ids[SourceID("module-component-resource", instance.ID+":"+component.kind)] = true
	}
	if err := pruneNetworkStackProblemLinks(ctx, tx, ids); err != nil {
		return err
	}
	for _, component := range owned {
		id := SourceID("module-component-resource", instance.ID+":"+component.kind)
		child := instance
		child.ResourceID = id
		if err := pruneModuleReferences(ctx, tx, child); err != nil {
			return err
		}
		deleted, err := tx.Exec(ctx, "DELETE FROM documents WHERE kind='resource' AND id=$1 AND body->>'managed_module_id'=$2", id, instance.ID)
		if err != nil {
			return err
		}
		if deleted.RowsAffected() != 1 {
			return ErrConflict
		}
		if err = record(ctx, tx, "resource.deleted", "Ресурс удалён", id, actor,
			map[string]any{"instance_id": instance.ID, "module_id": instance.ModuleID, "component": component.kind}, true); err != nil {
			return err
		}
	}
	return nil
}

func pruneNetworkStackProblemLinks(ctx context.Context, tx pgx.Tx, ids map[string]bool) error {
	var body []byte
	err := tx.QueryRow(ctx, "SELECT body || jsonb_build_object('revision',revision) FROM documents WHERE kind='problem_links' AND id='global' FOR UPDATE").Scan(&body)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	config, err := Decode[model.ProblemLinkConfig](body)
	if err != nil {
		return err
	}
	changed := false
	filter := func(before []string) []string {
		after := make([]string, 0, len(before))
		for _, id := range before {
			if ids[id] {
				changed = true
			} else {
				after = append(after, id)
			}
		}
		return after
	}
	for id, override := range config.Overrides {
		before := len(override.ResourceIDs)
		override.ResourceIDs = filter(override.ResourceIDs)
		if before == len(override.ResourceIDs) {
			continue
		}
		if override.Mode == "manual" && len(override.ResourceIDs) == 0 {
			delete(config.Overrides, id)
		} else {
			config.Overrides[id] = override
		}
	}
	rules := make([]model.ProblemLinkRule, 0, len(config.Rules))
	for _, rule := range config.Rules {
		before := len(rule.ResourceIDs)
		rule.ResourceIDs = filter(rule.ResourceIDs)
		if before > 0 && len(rule.ResourceIDs) == 0 {
			continue
		}
		rules = append(rules, rule)
	}
	if !changed {
		return nil
	}
	config.Rules = rules
	_, err = save(ctx, tx, "problem_links", "global", config.Revision, config)
	return err
}

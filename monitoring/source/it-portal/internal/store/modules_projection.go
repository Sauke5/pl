package store

import (
	"context"
	"errors"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"pl/portal/internal/model"
)

// ModuleExistsError makes a second installation an explicit administrator choice.
type ModuleExistsError struct{ InstanceID string }

func (e *ModuleExistsError) Error() string { return "module_exists" }

// syncModuleLinks owns only the module's two projection documents. It never adopts
// an existing user resource or rewrites unrelated catalog metadata.
func syncModuleLinks(ctx context.Context, tx pgx.Tx, instance *model.ModuleInstance) error {
	if instance.ModuleID == "xray" {
		return syncXrayResource(ctx, tx, instance)
	}
	if instance.IntegrationID == "" {
		instance.IntegrationID = SourceID("module-integration", instance.ID)
	}
	if instance.ResourceID == "" {
		instance.ResourceID = SourceID("module-resource", instance.ID)
	}
	var body []byte
	var integration model.Integration
	err := tx.QueryRow(ctx, "SELECT body || jsonb_build_object('id',id,'revision',revision) FROM documents WHERE kind='integration' AND id=$1 FOR UPDATE", instance.IntegrationID).Scan(&body)
	if err == nil {
		integration, err = Decode[model.Integration](body)
		if err != nil {
			return err
		}
		if integration.ManagedModuleID != instance.ID {
			return ErrConflict
		}
	} else if errors.Is(err, pgx.ErrNoRows) {
		integration = model.Integration{ID: instance.IntegrationID, ManagedModuleID: instance.ID, Name: instance.Name, Kind: "prometheus", PollSeconds: 60, TimeoutSeconds: 15, Concurrency: 1, Config: map[string]string{"discovery_enabled": "true"}, Capabilities: []string{"discovery"}, Status: "unconfigured"}
	} else {
		return err
	}
	if definition, ok := model.ModuleDefinition(instance.ModuleID); ok {
		integration.Kind = definition.IntegrationKind
		integration.Capabilities = definition.Capabilities
		if instance.ModuleID != "prometheus" && integration.Config == nil {
			integration.Config = map[string]string{}
		}
		if instance.ModuleID == "alertmanager" {
			integration.Config = map[string]string{}
		}
	}
	if instance.ModuleID == "wayline" {
		if integration.Config == nil {
			integration.Config = map[string]string{}
		}
		integration.Config["module_mode"] = instance.Mode
		integration.Config["public_url"] = "/wayline/"
	}
	if instance.ModuleID == "forms" || instance.ModuleID == "doska" || instance.ModuleID == "sftpgo" {
		integration.Config = map[string]string{"managed": "true", "module_mode": "local", "public_url": "/" + instance.ModuleID + "/"}
	}
	if definition, ok := model.ModuleDefinition(instance.ModuleID); ok && definition.PublicPath != "" {
		if (instance.ModuleID != "bookstack" && instance.ModuleID != "netmap") || instance.Mode != "external" || integration.Config == nil {
			integration.Config = map[string]string{}
		}
		if instance.ModuleID == "bookstack" {
			delete(integration.Config, "discovery_enabled")
		}
		integration.Config["managed"] = "true"
		integration.Config["module_mode"] = instance.Mode
		integration.Config["public_url"] = definition.PublicPath
	}
	integration.URL = instance.Endpoint
	integration.Enabled = instance.DesiredState == "enabled"
	integration.LastAttempt = instance.LastAttempt
	integration.Error = instance.Error
	if instance.ObservedState == "pending" || instance.ObservedState == "removing" {
		integration.Status = "pending"
	} else if instance.DesiredState != "enabled" {
		integration.Status = "disabled"
	} else if instance.ObservedState == "running" && instance.ModuleID != "xray" {
		integration.Status = "connected"
		// ApplySnapshot owns the completed snapshot timestamp shared with its
		// candidates. The later module observation must not make them stale.
		integration.Error = ""
	} else if instance.Error != "" {
		integration.Status = "error"
		integration.Error = instance.Error
	}
	if instance.ModuleID == "wayline" || instance.ModuleID == "grafana" || instance.ModuleID == "fileauditor" || instance.ModuleID == "forms" || instance.ModuleID == "doska" || instance.ModuleID == "sftpgo" || instance.ModuleID == "netmap" || instance.ModuleID == "bookstack" {
		integration.LastSuccess = instance.LastSuccess
	}
	if _, err = save(ctx, tx, "integration", integration.ID, integration.Revision, integration); err != nil {
		return err
	}
	var resource model.Resource
	err = tx.QueryRow(ctx, "SELECT body || jsonb_build_object('id',id,'revision',revision) FROM documents WHERE kind='resource' AND id=$1 FOR UPDATE", instance.ResourceID).Scan(&body)
	if err == nil {
		resource, err = Decode[model.Resource](body)
		if err != nil {
			return err
		}
		if resource.ManagedModuleID != instance.ID {
			return ErrConflict
		}
	} else if errors.Is(err, pgx.ErrNoRows) {
		now := time.Now().UTC()
		resource = model.Resource{ID: instance.ResourceID, ManagedModuleID: instance.ID, Name: instance.Name, Description: moduleResourceDescription(instance.ModuleID), Type: "Приложение", Directions: []string{"Мониторинг"}, Source: "module", Lifecycle: "active", CreatedAt: now, Aliases: []string{}, Tags: []string{}, Relations: []model.Relation{}, Endpoints: []model.Endpoint{}, Links: []model.Endpoint{}, ExternalIDs: []string{}, Operations: []string{}}
	} else {
		return err
	}
	if instance.ModuleID == "alertmanager" {
		resource.URL = "/#modules?instance=" + instance.ID + "&view=alertmanager"
	} else if instance.ModuleID == "mailcow" {
		resource.URL = "/#modules?instance=" + instance.ID + "&view=mailcow"
	} else {
		resource.URL = "/#modules?instance=" + instance.ID + "&view=monitoring"
	}
	if instance.ModuleID == "grafana" {
		resource.URL = "/grafana/"
	}
	if instance.ModuleID == "wayline" {
		resource.URL = "/wayline/"
		resource.Directions = []string{"Сети"}
	}
	if instance.ModuleID == "fileauditor" {
		resource.URL = "/audit/"
		if address, e := url.Parse(instance.Endpoint); e == nil {
			resource.URL = strings.TrimRight(address.Path, "/") + "/"
		}
		resource.Directions = []string{"Файлы"}
	}
	if instance.ModuleID == "forms" || instance.ModuleID == "doska" || instance.ModuleID == "sftpgo" {
		resource.URL = "/" + instance.ModuleID + "/"
		resource.Directions = []string{"Управление"}
		if instance.ModuleID == "sftpgo" {
			resource.Directions = []string{"Файлы"}
		}
	}
	if definition, ok := model.ModuleDefinition(instance.ModuleID); ok && definition.PublicPath != "" {
		resource.URL = definition.PublicPath
		if resource.Revision == 0 {
			resource.Directions = []string{definition.Direction}
		}
	}
	resource.UpdatedAt = time.Now().UTC()
	if _, err = save(ctx, tx, "resource", resource.ID, resource.Revision, resource); err != nil {
		return err
	}
	if err = syncNetworkStackResources(ctx, tx, *instance); err != nil {
		return err
	}
	return reindex(ctx, tx)
}

// ReconcileModules backfills links for earlier installations without touching their
// containers or declaring a previously successful health probe a connected source.
func (s *Store) ReconcileModules(ctx context.Context) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(7398218)"); err != nil {
		return err
	}
	rows, err := tx.Query(ctx, "SELECT body || jsonb_build_object('id',id,'revision',revision) FROM documents WHERE kind='module_instance' ORDER BY id FOR UPDATE")
	if err != nil {
		return err
	}
	var instances []model.ModuleInstance
	for rows.Next() {
		var b []byte
		if err = rows.Scan(&b); err != nil {
			rows.Close()
			return err
		}
		instance, e := Decode[model.ModuleInstance](b)
		if e != nil {
			rows.Close()
			return e
		}
		instances = append(instances, instance)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, instance := range instances {
		if instance.ResourceID != "" && (instance.IntegrationID != "" || instance.ModuleID == "xray") {
			continue
		}
		if instance.ObservedState == "running" {
			instance.ObservedState = "unavailable"
			instance.Error = "Подключение источника ожидает первой проверки данных"
		}
		if err = syncModuleLinks(ctx, tx, &instance); err != nil {
			return err
		}
		if _, err = save(ctx, tx, "module_instance", instance.ID, instance.Revision, instance); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// deleteModule removes only source-owned observations and the module service card.
// Accepted/linked target resources belong to the catalog and deliberately survive.
func deleteModule(ctx context.Context, tx pgx.Tx, instance model.ModuleInstance, actor string) error {
	if _, err := tx.Exec(ctx, "DELETE FROM integration_credentials WHERE integration_id=$1", instance.IntegrationID); err != nil {
		return err
	}
	for _, pair := range []struct{ kind, id string }{{"integration", instance.IntegrationID}, {"resource", instance.ResourceID}} {
		if pair.id == "" {
			continue
		}
		var owner string
		err := tx.QueryRow(ctx, "SELECT body->>'managed_module_id' FROM documents WHERE kind=$1 AND id=$2 FOR UPDATE", pair.kind, pair.id).Scan(&owner)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return err
		}
		if owner != instance.ID {
			return ErrConflict
		}
	}
	// Visibility and link overrides are local metadata owned by each source alert.
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(7398220)"); err != nil {
		return err
	}
	if err := deleteNetworkStackResources(ctx, tx, instance, actor); err != nil {
		return err
	}
	rows, err := tx.Query(ctx, "SELECT id FROM documents WHERE kind='problem' AND body->>'integration_id'=$1 AND $1<>'' ORDER BY id FOR UPDATE", instance.IntegrationID)
	if err != nil {
		return err
	}
	removedProblems := map[string]bool{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		removedProblems[id] = true
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "DELETE FROM documents WHERE kind='problem_visibility' AND id IN (SELECT id FROM documents WHERE kind='problem' AND body->>'integration_id'=$1 AND $1<>'')", instance.IntegrationID); err != nil {
		return err
	}
	var linksBody []byte
	err = tx.QueryRow(ctx, "SELECT body || jsonb_build_object('revision',revision) FROM documents WHERE kind='problem_links' AND id='global' FOR UPDATE").Scan(&linksBody)
	if err == nil {
		config, e := Decode[model.ProblemLinkConfig](linksBody)
		if e != nil {
			return e
		}
		changed := false
		for id := range removedProblems {
			if _, exists := config.Overrides[id]; exists {
				delete(config.Overrides, id)
				changed = true
			}
		}
		for id, override := range config.Overrides {
			if Contains(override.ResourceIDs, instance.ResourceID) {
				override.ResourceIDs = withoutModuleID(override.ResourceIDs, instance.ResourceID)
				changed = true
				if override.Mode == "manual" && len(override.ResourceIDs) == 0 {
					delete(config.Overrides, id)
				} else {
					config.Overrides[id] = override
				}
			}
		}
		rules := make([]model.ProblemLinkRule, 0, len(config.Rules))
		for _, rule := range config.Rules {
			if instance.IntegrationID != "" && rule.IntegrationID == instance.IntegrationID {
				changed = true
				continue
			}
			if Contains(rule.ResourceIDs, instance.ResourceID) {
				rule.ResourceIDs = withoutModuleID(rule.ResourceIDs, instance.ResourceID)
				changed = true
				if len(rule.ResourceIDs) == 0 {
					continue
				}
			}
			rules = append(rules, rule)
		}
		if changed {
			config.Rules = rules
			if _, e = save(ctx, tx, "problem_links", "global", config.Revision, config); e != nil {
				return e
			}
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if _, err = tx.Exec(ctx, "DELETE FROM documents WHERE kind IN ('candidate','problem','report') AND body->>'integration_id'=$1 AND $1<>''", instance.IntegrationID); err != nil {
		return err
	}
	if err = pruneModuleReferences(ctx, tx, instance); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "DELETE FROM documents WHERE (kind IN ('integration','mailcow_snapshot') AND id=$1 AND $1<>'') OR (kind='resource' AND id=$2) OR (kind='module_instance' AND id=$3)", instance.IntegrationID, instance.ResourceID, instance.ID); err != nil {
		return err
	}
	if _, err := save(ctx, tx, "module_tombstone", instance.ID, 0, instance); err != nil {
		return err
	}
	if err := record(ctx, tx, "module.removed", "Модуль удалён", instance.ResourceID, actor, map[string]any{"instance_id": instance.ID, "integration_id": instance.IntegrationID, "mode": instance.Mode, "job_id": instance.LastJobID}, true); err != nil {
		return err
	}
	return reindex(ctx, tx)
}

// Prune active references in the same transaction as removal, preserving the other
// members and revision contracts of collections, preferences and published board.
func pruneModuleReferences(ctx context.Context, tx pgx.Tx, instance model.ModuleInstance) error {
	for _, field := range []struct{ kind, key string }{{"collection", "resource_ids"}, {"preferences", "favorites"}, {"settings", "board_resource_ids"}} {
		_, err := tx.Exec(ctx, `UPDATE documents SET body=jsonb_set(body,ARRAY[$2::text],COALESCE((SELECT jsonb_agg(v ORDER BY n) FROM jsonb_array_elements(body->$2::text) WITH ORDINALITY AS a(v,n) WHERE v<>to_jsonb($3::text)),'[]'::jsonb)),revision=revision+1,updated_at=now() WHERE kind=$1 AND jsonb_typeof(body->$2::text)='array' AND (body->$2::text) ? $3`, field.kind, field.key, instance.ResourceID)
		if err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE documents SET body=jsonb_set(body,'{relations}',COALESCE((SELECT jsonb_agg(v ORDER BY n) FROM jsonb_array_elements(body->'relations') WITH ORDINALITY AS a(v,n) WHERE v->>'resource_id' IS DISTINCT FROM $1),'[]'::jsonb)),revision=revision+1,updated_at=now() WHERE kind='resource' AND jsonb_typeof(body->'relations')='array' AND EXISTS(SELECT 1 FROM jsonb_array_elements(body->'relations') AS a(v) WHERE v->>'resource_id'=$1)`, instance.ResourceID); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `UPDATE documents SET body=jsonb_set(body,'{wayline_cards}',COALESCE((SELECT jsonb_agg(v ORDER BY n) FROM jsonb_array_elements(body->'wayline_cards') WITH ORDINALITY AS a(v,n) WHERE v->>'integration_id' IS DISTINCT FROM $1),'[]'::jsonb)),revision=revision+1,updated_at=now() WHERE $1<>'' AND kind='preferences' AND jsonb_typeof(body->'wayline_cards')='array' AND EXISTS(SELECT 1 FROM jsonb_array_elements(body->'wayline_cards') AS a(v) WHERE v->>'integration_id'=$1)`, instance.IntegrationID)
	return err
}

func withoutModuleID(ids []string, removed string) []string {
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if id != removed {
			out = append(out, id)
		}
	}
	return out
}

func syncXrayResource(ctx context.Context, tx pgx.Tx, instance *model.ModuleInstance) error {
	if instance.IntegrationID != "" {
		return ErrConflict
	}
	if instance.ResourceID == "" {
		instance.ResourceID = SourceID("module-resource", instance.ID)
	}
	var body []byte
	var resource model.Resource
	err := tx.QueryRow(ctx, "SELECT body || jsonb_build_object('id',id,'revision',revision) FROM documents WHERE kind='resource' AND id=$1 FOR UPDATE", instance.ResourceID).Scan(&body)
	if err == nil {
		resource, err = Decode[model.Resource](body)
		if err != nil {
			return err
		}
		if resource.ManagedModuleID != instance.ID {
			return ErrConflict
		}
	} else if errors.Is(err, pgx.ErrNoRows) {
		resource = model.Resource{ID: instance.ResourceID, ManagedModuleID: instance.ID, Name: instance.Name, Description: "SOCKS и HTTP прокси Xray", Type: "Приложение", Directions: []string{"Сети"}, Source: "module", Lifecycle: "active", CreatedAt: time.Now().UTC(), Aliases: []string{}, Tags: []string{}, Relations: []model.Relation{}, Endpoints: []model.Endpoint{}, Links: []model.Endpoint{}, ExternalIDs: []string{}, Operations: []string{}}
	} else {
		return err
	}
	resource.URL = "/#modules?instance=" + instance.ID + "&view=xray"
	resource.UpdatedAt = time.Now().UTC()
	if _, err = save(ctx, tx, "resource", resource.ID, resource.Revision, resource); err != nil {
		return err
	}
	return reindex(ctx, tx)
}

func moduleResourceDescription(moduleID string) string {
	if definition, ok := model.ModuleDefinition(moduleID); ok {
		return definition.Description
	}
	if moduleID == "alertmanager" {
		return "Маршрутизация уведомлений Alertmanager"
	}
	return "Метрики, цели сбора и запросы Prometheus"
}

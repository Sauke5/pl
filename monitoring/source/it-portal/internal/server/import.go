package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"pl/portal/internal/model"
	"pl/portal/internal/store"
)

type exportDocument struct {
	SchemaVersion int                `json:"schema_version"`
	Resources     []model.Resource   `json:"resources"`
	Collections   []model.Collection `json:"collections"`
}

func (s *Server) export(w http.ResponseWriter, r *http.Request) {
	resources, e := store.List[model.Resource](r.Context(), s.Store, "resource")
	if e != nil {
		s.fail(w, e)
		return
	}
	collections, e := store.List[model.Collection](r.Context(), s.Store, "collection")
	if e != nil {
		s.fail(w, e)
		return
	}
	// Module services are recreated by lifecycle operations, never as orphaned
	// manual catalog cards on a different installation.
	excluded := map[string]bool{}
	ordinary := make([]model.Resource, 0, len(resources))
	for _, resource := range resources {
		if resource.ManagedModuleID != "" {
			excluded[resource.ID] = true
			continue
		}
		ordinary = append(ordinary, resource)
	}
	for n := range ordinary {
		relations := make([]model.Relation, 0, len(ordinary[n].Relations))
		for _, relation := range ordinary[n].Relations {
			if !excluded[relation.ResourceID] {
				relations = append(relations, relation)
			}
		}
		ordinary[n].Relations = relations
	}
	resources = ordinary
	for n := range collections {
		ids := make([]string, 0, len(collections[n].ResourceIDs))
		for _, id := range collections[n].ResourceIDs {
			if !excluded[id] {
				ids = append(ids, id)
			}
		}
		collections[n].ResourceIDs = ids
	}
	w.Header().Set("Content-Disposition", `attachment; filename="pl-catalog-v1.json"`)
	respond(w, 200, exportDocument{1, resources, collections})
}
func canonicalURL(v string) string { return strings.TrimRight(strings.TrimSpace(v), "/") }
func (s *Server) importPreview(w http.ResponseWriter, r *http.Request) {
	var doc exportDocument
	if !decode(w, r, &doc) {
		return
	}
	if doc.SchemaVersion != 1 || len(doc.Resources) > 5000 || len(doc.Collections) > 1000 {
		problem(w, 400, "unsupported_schema", "Ожидается schema_version=1, не более 5000 ресурсов и 1000 подборок")
		return
	}
	before, e := s.Store.CatalogDigest(r.Context())
	if e != nil {
		s.fail(w, e)
		return
	}
	existing, e := store.List[model.Resource](r.Context(), s.Store, "resource")
	if e != nil {
		s.fail(w, e)
		return
	}
	existingCollections, e := store.List[model.Collection](r.Context(), s.Store, "collection")
	if e != nil {
		s.fail(w, e)
		return
	}
	byID := map[string]model.Resource{}
	byURL := map[string][]model.Resource{}
	for _, v := range existing {
		byID[v.ID] = v
		key := canonicalURL(v.URL)
		if key != "" {
			byURL[key] = append(byURL[key], v)
		}
	}
	colByID := map[string]model.Collection{}
	for _, v := range existingCollections {
		colByID[v.ID] = v
	}
	plan := store.ImportPlan{Token: randomToken(), Actor: current(r).User.ID, Baseline: before, ExpiresAt: time.Now().UTC().Add(15 * time.Minute), Writes: []store.ImportWrite{}}
	changes := []map[string]string{}
	conflicts := []string{}
	seenURL := map[string]bool{}
	seenID := map[string]bool{}
	remap := map[string]string{}
	now := time.Now().UTC()
	for n := range doc.Resources {
		v := &doc.Resources[n]
		if v.ManagedModuleID != "" {
			problem(w, 409, "managed_module", "Модульные карточки подключаются через каталог модулей")
			return
		}
		if e := validateResource(v); e != nil {
			problem(w, 400, "invalid_resource", v.Name+": "+e.Error())
			return
		}
		key := canonicalURL(v.URL)
		if (key != "" && seenURL[key]) || v.ID != "" && seenID[v.ID] {
			conflicts = append(conflicts, "Повторяющийся ресурс в файле: "+v.Name)
			continue
		}
		seenURL[key] = true
		seenID[v.ID] = true
		original := v.ID
		old, found := byID[v.ID]
		if !found {
			matches := byURL[key]
			if len(matches) > 1 {
				conflicts = append(conflicts, "Несколько существующих ресурсов с адресом: "+v.Name)
				continue
			}
			if len(matches) == 1 {
				old = matches[0]
				found = true
			}
		}
		action, reason := "create", "Новая запись; разрешения операций включаются отдельно"
		if found {
			if old.ManagedModuleID != "" {
				problem(w, 409, "managed_module", "Импорт не изменяет карточки установленных модулей")
				return
			}
			if len(byURL[key]) > 0 && byURL[key][0].ID != old.ID {
				conflicts = append(conflicts, "ID и адрес относятся к разным ресурсам: "+v.Name)
				continue
			}
			v.ID = old.ID
			v.Revision = old.Revision
			v.CreatedAt = old.CreatedAt
			if v.Icon == "" {
				v.Icon = old.Icon
			}
			v.Source = old.Source
			v.ExternalIDs = old.ExternalIDs
			v.Operations = old.Operations
			v.ExecutorTarget = old.ExecutorTarget
			action = "update"
			reason = "Совпадение ID или точного адреса; замена общих полей после подтверждения"
		} else {
			v.ID = uuid.NewString()
			v.Revision = 0
			v.CreatedAt = now
			v.Source = "import"
			v.ExternalIDs = []string{}
			v.Operations = []string{}
			v.ExecutorTarget = ""
		}
		v.UpdatedAt = now
		if original != "" {
			remap[original] = v.ID
		}
		changes = append(changes, map[string]string{"action": action, "id": v.ID, "name": v.Name, "reason": reason})
	}
	if len(conflicts) > 0 {
		respond(w, 200, map[string]any{"token": "", "expires_at": plan.ExpiresAt, "changes": changes, "conflicts": conflicts})
		return
	}
	for _, v := range doc.Resources {
		for n, rel := range v.Relations {
			if mapped, ok := remap[rel.ResourceID]; ok {
				v.Relations[n].ResourceID = mapped
			} else if _, ok = byID[rel.ResourceID]; !ok {
				problem(w, 400, "invalid_relation", "В импортируемом файле есть отсутствующая связь")
				return
			}
		}
		b, _ := json.Marshal(v)
		plan.Writes = append(plan.Writes, store.ImportWrite{Kind: "resource", ID: v.ID, Revision: v.Revision, Body: b})
	}
	seenCollections := map[string]bool{}
	for _, v := range doc.Collections {
		if v.ID != "" && seenCollections[v.ID] {
			problem(w, 400, "duplicate_collection", "Повторяющийся ID подборки в файле")
			return
		}
		seenCollections[v.ID] = true
		if v.Mode == "" {
			v.Mode = "manual"
		}
		if v.Mode != "manual" && v.Mode != "filter" || (v.Mode == "manual" && v.Filter != model.Filter{}) || (v.Mode == "filter" && len(v.ResourceIDs) > 0) {
			problem(w, 400, "invalid_collection", "Выберите ручную подборку или фильтр")
			return
		}
		if strings.TrimSpace(v.Name) == "" || len(v.Name) > 160 {
			problem(w, 400, "invalid_collection", "Некорректная подборка")
			return
		}
		action := "create"
		old, ok := colByID[v.ID]
		if ok {
			v.ID = old.ID
			v.Revision = old.Revision
			action = "update"
		} else {
			v.ID = uuid.NewString()
			v.Revision = 0
		}
		for n, id := range v.ResourceIDs {
			if mapped, ok := remap[id]; ok {
				v.ResourceIDs[n] = mapped
			} else if _, ok = byID[id]; !ok {
				problem(w, 400, "invalid_collection", "Ресурс подборки отсутствует")
				return
			}
		}
		b, _ := json.Marshal(v)
		plan.Writes = append(plan.Writes, store.ImportWrite{Kind: "collection", ID: v.ID, Revision: v.Revision, Body: b})
		changes = append(changes, map[string]string{"action": action, "id": v.ID, "name": v.Name, "reason": "Подборка"})
	}
	after, e := s.Store.CatalogDigest(r.Context())
	if e != nil {
		s.fail(w, e)
		return
	}
	if before != after {
		s.fail(w, store.ErrConflict)
		return
	}
	if e = s.Store.SaveImportPlan(r.Context(), plan); e != nil {
		s.fail(w, e)
		return
	}
	respond(w, 200, map[string]any{"token": plan.Token, "expires_at": plan.ExpiresAt, "changes": changes, "conflicts": conflicts})
}
func (s *Server) importApply(w http.ResponseWriter, r *http.Request) {
	var p struct {
		Token string `json:"token"`
	}
	if !decode(w, r, &p) {
		return
	}
	if e := s.Store.ApplyImport(r.Context(), p.Token, current(r).User.ID); e != nil {
		s.fail(w, e)
		return
	}
	s.Hub.Notify("all")
	respond(w, 200, map[string]bool{"applied": true})
}

package server

import (
	"errors"
	"net/http"
	"pl/portal/internal/model"
	"pl/portal/internal/store"
)

func (s *Server) validateIntegrationBindings(w http.ResponseWriter, r *http.Request, draft model.Integration) bool {
	if draft.Kind != "oxidized" {
		return true
	}
	bindings, err := model.OxidizedBindings(draft.Config)
	if err != nil {
		settingsWorkspaceInvalid(w, "Проверьте соответствия устройств", map[string]string{"config.node_bindings": "Проверьте имена устройств и выбранные ресурсы"})
		return false
	}
	checked := map[string]bool{}
	for _, id := range bindings {
		if checked[id] {
			continue
		}
		checked[id] = true
		if _, err = s.Store.Get(r.Context(), "resource", id); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				settingsWorkspaceInvalid(w, "Ресурс не найден", map[string]string{"config.node_bindings": "Обновите список и выберите существующий ресурс"})
			} else {
				s.fail(w, err)
			}
			return false
		}
	}
	return true
}

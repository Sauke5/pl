package server

import (
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"pl/portal/internal/model"
	"pl/portal/internal/store"
)

// Keep this classification aligned with frontend resourceKind.ts. A management
// URL does not turn a host, VM, device or storage object into an application.
func isServiceCardResource(resource model.Resource, origin string) bool {
	switch strings.ToLower(strings.TrimSpace(resource.Type)) {
	case "сервер", "виртуальная машина", "устройство", "сетевое устройство", "хранилище",
		"server", "virtual machine", "vm", "device", "network device", "storage":
		return false
	}
	return serviceCardNavigationURL(resource, origin) != ""
}

// Old managed Prometheus records used an API gateway URL. Resolve that exact
// owned path to the existing Pl monitoring page without modifying stored data
// or allowing arbitrary API paths as application navigation.
func serviceCardNavigationURL(resource model.Resource, origin string) string {
	value := resource.URL
	id, err := uuid.Parse(resource.ManagedModuleID)
	if err == nil && id.String() == resource.ManagedModuleID && resource.Source == "module" &&
		value == "/api/v1/modules/"+resource.ManagedModuleID+"/prometheus/" {
		value = "/#modules?instance=" + resource.ManagedModuleID + "&view=monitoring"
	}
	return employeeNavigationURL(value, origin)
}

// Validate additions only. Legacy IDs stay in their original document/group so
// an unrelated edit cannot silently delete old choices or copy them elsewhere.
func (s *Server) validateServiceCardAdditions(w http.ResponseWriter, r *http.Request, requested, existing []string) bool {
	for _, id := range requested {
		if store.Contains(existing, id) {
			continue
		}
		resource, err := store.Get[model.Resource](r.Context(), s.Store, "resource", id)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			s.fail(w, err)
			return false
		}
		if err != nil || !isServiceCardResource(resource, s.Config.PublicURL) {
			problem(w, http.StatusBadRequest, "invalid_service_card", "Для карточки выберите веб-приложение с действующей ссылкой")
			return false
		}
	}
	return true
}

package server

import (
	"net/http"
	"strings"

	"github.com/google/uuid"
	"pl/portal/internal/model"
	"pl/portal/internal/store"
)

// This is routing metadata for Nginx, not a Platform authentication gate.
// Grafana handles login, authorization, cookies, CSRF and all native routes.
func (s *Server) grafanaNativeUpstream(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !s.Config.PortableRelease {
		http.NotFound(w, r)
		return
	}
	if r.URL.RawQuery != "" {
		problem(w, http.StatusBadRequest, "invalid_routing_query", "Маршрут Grafana не принимает параметры")
		return
	}
	if s.Store == nil {
		problem(w, http.StatusServiceUnavailable, "grafana_unavailable", "Локальная Grafana не установлена")
		return
	}
	// Preserve the connector selection rule: exactly one enabled Grafana
	// integration. Never select the first instance or a client-supplied target.
	integration, err := s.connectorSource(r, "grafana", "")
	if err != nil {
		problem(w, http.StatusServiceUnavailable, "grafana_unavailable", "Локальная Grafana не установлена, отключена или выбрана неоднозначно")
		return
	}
	instance, err := store.Get[model.ModuleInstance](r.Context(), s.Store, "module_instance", integration.ManagedModuleID)
	if err != nil {
		problem(w, http.StatusServiceUnavailable, "grafana_unavailable", "Связь Grafana с установленным модулем не подтверждена")
		return
	}
	upstream, ok := grafanaNativeContainerUpstream(integration, instance)
	if !ok {
		problem(w, http.StatusServiceUnavailable, "grafana_unavailable", "Связь Grafana с установленным локальным модулем не подтверждена")
		return
	}
	w.Header().Set("X-Pl-Grafana-Upstream", upstream)
	w.Header().Set("X-Pl-Grafana-Cookie", grafanaNativeCookies(r.Header.Values("Cookie")))
	w.WriteHeader(http.StatusNoContent)
}

func grafanaNativeContainerUpstream(integration model.Integration, instance model.ModuleInstance) (string, bool) {
	id, err := uuid.Parse(instance.ID)
	if err != nil || id.String() != instance.ID || integration.ID == "" || integration.Kind != "grafana" || !integration.Enabled || integration.ManagedModuleID != instance.ID || instance.IntegrationID != integration.ID || instance.ModuleID != "grafana" || instance.Mode != "local" || instance.DesiredState != "enabled" {
		return "", false
	}
	// Endpoint and integration.URL are observations/configuration, never routing
	// authority. Only the controller's deterministic Docker alias is used.
	return "http://pl-grafana-" + instance.ID + ":3000", true
}

func grafanaNativeCookies(headers []string) string {
	var native []string
	for _, header := range headers {
		for _, part := range strings.Split(header, ";") {
			part = strings.TrimSpace(part)
			name, _, _ := strings.Cut(part, "=")
			if part != "" && strings.TrimSpace(name) != "portal_session" {
				native = append(native, part)
			}
		}
	}
	return strings.Join(native, "; ")
}

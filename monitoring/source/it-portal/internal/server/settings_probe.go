package server

import (
	"net/http"
	"strings"

	"pl/portal/internal/model"
)

// RegisterSettingsProbe mounts the additive draft probe on the Platform mux.
// The shared server owner calls this alongside the other subject route groups.
func (s *Server) RegisterSettingsProbe(m *http.ServeMux) {
	m.HandleFunc("POST /api/v1/settings-workspace/probe", s.auth(s.settingsProbe, true))
}

func (s *Server) settingsProbe(w http.ResponseWriter, r *http.Request) {
	var draft model.Integration
	if !decode(w, r, &draft) {
		return
	}
	if draft.ManagedModuleID != "" {
		problem(w, 409, "managed_module", "Проверьте подключение на странице модулей")
		return
	}
	if !s.settingsIntegrationUnmanaged(w, r, draft.ID) {
		return
	}
	if err := validateIntegration(&draft); err != nil {
		message := err.Error()
		if strings.HasPrefix(message, "Недопустимый параметр интеграции:") {
			message = "Параметры не подходят выбранному типу подключения."
		}
		problem(w, http.StatusBadRequest, "invalid_integration", message)
		return
	}
	if s.Providers == nil {
		problem(w, http.StatusServiceUnavailable, "probe_unavailable", "Проверка подключений сейчас недоступна.")
		return
	}
	result := s.Providers.ProbeIntegration(r.Context(), draft)
	if result.Status == "busy" {
		w.Header().Set("Retry-After", "1")
		respond(w, http.StatusTooManyRequests, result)
		return
	}
	respond(w, http.StatusOK, result)
}

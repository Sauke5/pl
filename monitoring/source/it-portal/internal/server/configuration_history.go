package server

import "net/http"

// Admin-only metadata endpoints; no requests are made to Oxidized or Gitea.
func (s *Server) RegisterConfigurationHistoryRoutes(m *http.ServeMux) {
	add := func(pattern string, handler http.HandlerFunc) {
		m.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			if _, ok := r.Header["Authorization"]; ok {
				problem(w, http.StatusUnauthorized, "browser_session_required", "Требуется сессия Платформы")
				return
			}
			s.auth(handler, true)(w, r)
		})
	}
	add("GET /api/v1/integrations/{id}/configuration-history", s.configurationHistory)
	add("GET /api/v1/resources/{id}/configuration-history", s.resourceConfigurationHistory)
}
func (s *Server) configurationHistory(w http.ResponseWriter, r *http.Request) {
	value, err := s.Store.ConfigurationHistory(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, err)
		return
	}
	respond(w, http.StatusOK, value)
}
func (s *Server) resourceConfigurationHistory(w http.ResponseWriter, r *http.Request) {
	value, err := s.Store.ResourceConfigurationHistory(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, err)
		return
	}
	respond(w, http.StatusOK, value)
}

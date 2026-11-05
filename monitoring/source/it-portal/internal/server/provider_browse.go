package server

import (
	"errors"
	"net/http"

	"pl/portal/internal/model"
	"pl/portal/internal/providers"
	"pl/portal/internal/store"
)

func (s *Server) registerProviderBrowseRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/integrations/{id}/prometheus/options", s.auth(s.prometheusOptions, true))
	m.HandleFunc("GET /api/v1/integrations/{id}/grafana/dashboards", s.auth(s.grafanaDashboards, true))
	m.HandleFunc("GET /api/v1/integrations/{id}/grafana/dashboards/{uid}/panels", s.auth(s.grafanaPanels, true))
	m.HandleFunc("POST /api/v1/integrations/{id}/grafana/query", s.auth(s.grafanaQuery, true))
}
func (s *Server) browseIntegration(w http.ResponseWriter, r *http.Request, kind string) (model.Integration, bool) {
	i, e := store.Get[model.Integration](r.Context(), s.Store, "integration", r.PathValue("id"))
	if e != nil {
		s.fail(w, e)
		return i, false
	}
	if !i.Enabled || i.Kind != kind {
		problem(w, 400, "source_disabled", "Нужен включённый источник подходящего типа.")
		return i, false
	}
	return i, true
}
func (s *Server) browseError(w http.ResponseWriter, e error) {
	code, status := "source_unavailable", http.StatusBadGateway
	switch {
	case errors.Is(e, providers.ErrBrowseAuth):
		code = "source_auth_required"
	case errors.Is(e, providers.ErrBrowseInvalid):
		code, status = "invalid_parameters", 400
	case errors.Is(e, providers.ErrPanelUnsupported):
		code, status = "panel_unsupported", 422
	case errors.Is(e, providers.ErrBrowseLimit):
		code, status = "source_limit", 422
	case errors.Is(e, providers.ErrBrowseBusy):
		code, status = "source_busy", 429
	}
	problem(w, status, code, providers.BrowseErrorMessage(e))
}
func (s *Server) prometheusOptions(w http.ResponseWriter, r *http.Request) {
	i, ok := s.browseIntegration(w, r, "prometheus")
	if !ok {
		return
	}
	out, e := s.Providers.PrometheusOptions(r.Context(), i, r.URL.Query().Get("job"), r.URL.Query().Get("label"))
	if e != nil {
		s.browseError(w, e)
		return
	}
	respond(w, 200, out)
}
func (s *Server) grafanaDashboards(w http.ResponseWriter, r *http.Request) {
	i, ok := s.browseIntegration(w, r, "grafana")
	if !ok {
		return
	}
	out, e := s.Providers.GrafanaDashboards(r.Context(), i)
	if e != nil {
		s.browseError(w, e)
		return
	}
	respond(w, 200, out)
}
func (s *Server) grafanaPanels(w http.ResponseWriter, r *http.Request) {
	i, ok := s.browseIntegration(w, r, "grafana")
	if !ok {
		return
	}
	out, e := s.Providers.GrafanaPanels(r.Context(), i, r.PathValue("uid"))
	if e != nil {
		s.browseError(w, e)
		return
	}
	respond(w, 200, out)
}
func (s *Server) grafanaQuery(w http.ResponseWriter, r *http.Request) {
	var input providers.GrafanaQuery
	if !decode(w, r, &input) {
		return
	}
	i, ok := s.browseIntegration(w, r, "grafana")
	if !ok {
		return
	}
	out, e := s.Providers.GrafanaQuery(r.Context(), i, input)
	if e != nil {
		s.browseError(w, e)
		return
	}
	respond(w, 200, out)
}

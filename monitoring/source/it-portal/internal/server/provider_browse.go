package server

import (
	"errors"
	"net/http"
	"strings"

	"pl/portal/internal/model"
	"pl/portal/internal/modules"
	"pl/portal/internal/providers"
	"pl/portal/internal/store"
)

const grafanaChartPrefix = "/grafana/_pl/charts"

func (s *Server) registerProviderBrowseRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/integrations/{id}/prometheus/options", s.auth(s.prometheusOptions, true))
	for _, prefix := range []string{"", grafanaChartPrefix} {
		base := prefix + "/api/v1/integrations/{id}/grafana"
		m.HandleFunc("GET "+base+"/dashboards", s.auth(s.grafanaDashboards, true))
		m.HandleFunc("GET "+base+"/dashboards/{uid}/panels", s.auth(s.grafanaPanels, true))
		m.HandleFunc("POST "+base+"/query", s.auth(s.grafanaQuery, true))
	}
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
	r, ok = s.grafanaChartRequest(w, r, i)
	if !ok {
		return
	}
	out, e := s.Providers.GrafanaDashboards(r.Context(), i)
	if e != nil {
		s.grafanaChartError(w, r, e)
		return
	}
	respond(w, 200, out)
}
func (s *Server) grafanaPanels(w http.ResponseWriter, r *http.Request) {
	i, ok := s.browseIntegration(w, r, "grafana")
	if !ok {
		return
	}
	r, ok = s.grafanaChartRequest(w, r, i)
	if !ok {
		return
	}
	out, e := s.Providers.GrafanaPanels(r.Context(), i, r.PathValue("uid"))
	if e != nil {
		s.grafanaChartError(w, r, e)
		return
	}
	respond(w, 200, out)
}
func (s *Server) grafanaQuery(w http.ResponseWriter, r *http.Request) {
	i, ok := s.browseIntegration(w, r, "grafana")
	if !ok {
		return
	}
	r, ok = s.grafanaChartRequest(w, r, i)
	if !ok {
		return
	}
	var input providers.GrafanaQuery
	if !decode(w, r, &input) {
		return
	}
	out, e := s.Providers.GrafanaQuery(r.Context(), i, input)
	if e != nil {
		s.grafanaChartError(w, r, e)
		return
	}
	respond(w, 200, out)
}

func (s *Server) grafanaChartRequest(w http.ResponseWriter, r *http.Request, i model.Integration) (*http.Request, bool) {
	scoped := strings.HasPrefix(r.URL.Path, grafanaChartPrefix+"/")
	if !s.Config.PortableRelease || i.ManagedModuleID == "" {
		if scoped {
			http.NotFound(w, r)
			return r, false
		}
		return r, true
	}
	w.Header().Set("Cache-Control", "no-store")
	if !scoped {
		// Grafana scopes its session cookie to /grafana. Keep the public chart
		// API compatible and preserve the method and body on same-origin redirects.
		http.Redirect(w, r, grafanaChartPrefix+r.URL.EscapedPath(), http.StatusTemporaryRedirect)
		return r, false
	}
	source, err := s.connectorSource(r, "grafana", "")
	if err != nil || source.ID != i.ID {
		s.browseError(w, providers.ErrBrowseUnavailable)
		return r, false
	}
	cookies := r.CookiesNamed(modules.GrafanaSessionCookie)
	if len(cookies) != 1 || !modules.ValidGrafanaSession(cookies[0].Value) {
		s.grafanaChartError(w, r, providers.ErrBrowseAuth)
		return r, false
	}
	ctx := modules.WithGrafanaSession(r.Context(), cookies[0].Value, func(cookie *http.Cookie) {
		http.SetCookie(w, cookie)
	})
	return r.WithContext(ctx), true
}

func (s *Server) grafanaChartError(w http.ResponseWriter, r *http.Request, err error) {
	if strings.HasPrefix(r.URL.Path, grafanaChartPrefix+"/") && errors.Is(err, providers.ErrBrowseAuth) {
		problem(w, http.StatusBadGateway, "grafana_session_required", "Войдите в Grafana с учётной записью, у которой есть доступ к дашборду и источнику данных.")
		return
	}
	s.browseError(w, err)
}

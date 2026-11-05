package server

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/providers"
	"pl/portal/internal/store"
)

var errProxySourceMissing = errors.New("proxy observation source missing")
var errProxySourceAmbiguous = errors.New("proxy observation source ambiguous")

func (s *Server) loadProxyObservation(ctx context.Context) (providers.ProxyExternalObservation, error) {
	empty := providers.ProxyExternalObservation{}
	if s.Store == nil || s.Providers == nil {
		return empty, errProxySourceMissing
	}
	integrations, err := store.List[model.Integration](ctx, s.Store, "integration")
	if err != nil {
		return empty, err
	}
	var selected *model.Integration
	for _, integration := range integrations {
		if integration.Kind != "prometheus" || !integration.Enabled {
			continue
		}
		if selected != nil {
			return empty, errProxySourceAmbiguous
		}
		copy := integration
		selected = &copy
	}
	if selected == nil {
		return empty, errProxySourceMissing
	}
	return s.Providers.ProxyExternal(ctx, *selected)
}

func (s *Server) proxyObservabilityHandler() http.HandlerFunc {
	return newProxyObservabilityHandler(s.loadProxyObservation, time.Now)
}
func newProxyObservabilityHandler(load proxyObservationLoader, now func() time.Time) http.HandlerFunc {
	cache := proxyObservationCache{load: load, now: now}
	return func(w http.ResponseWriter, r *http.Request) {
		if !current(r).User.Admin || current(r).User.ID == "" || strings.HasPrefix(current(r).User.ID, "machine:") {
			problem(w, 403, "forbidden", "Доступ только администратору")
			return
		}
		if r.URL.RawQuery != "" {
			problem(w, 400, "proxy_observation_parameters", "Параметры запроса не поддерживаются")
			return
		}
		out, err := cache.get(r.Context())
		if err != nil {
			return
		} // This caller disconnected; the bounded shared refresh continues.
		respond(w, 200, out)
	}
}

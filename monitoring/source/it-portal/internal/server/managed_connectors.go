package server

import (
	"net/http"
	"net/url"
	"strings"

	"pl/portal/internal/model"
	"pl/portal/internal/modules"
	"pl/portal/internal/providers"
	"pl/portal/internal/store"
)

// Resolve only enabled persisted sources. Ambiguity requires administrator
// configuration; a browser can never supply an arbitrary upstream URL.
func (s *Server) connectorSource(r *http.Request, kind, prefix string) (model.Integration, error) {
	items, err := store.List[model.Integration](r.Context(), s.Store, "integration")
	if err != nil {
		return model.Integration{}, err
	}
	selected := model.Integration{}
	for _, item := range items {
		if item.Kind != kind || !item.Enabled {
			continue
		}
		if prefix != "" {
			address, e := url.Parse(item.URL)
			if e != nil || strings.TrimRight(address.Path, "/") != prefix {
				continue
			}
		}
		if selected.ID != "" {
			return model.Integration{}, store.ErrConflict
		}
		selected = item
	}
	if selected.ID == "" {
		return selected, store.ErrNotFound
	}
	return selected, nil
}

func (s *Server) managedAuditorGateway(prefix string) http.Handler {
	slots := make(chan struct{}, 4)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := s.readSession(r); err != nil {
			problem(w, 401, "session_expired", "Войдите в Платформу")
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			problem(w, 405, "read_only", "File Auditor подключён для просмотра")
			return
		}
		select {
		case slots <- struct{}{}:
			defer func() { <-slots }()
		default:
			problem(w, 503, "auditor_busy", "File Auditor занят. Повторите запрос позднее")
			return
		}
		integration, err := s.connectorSource(r, "fileauditor", prefix)
		if err != nil || s.Providers == nil {
			problem(w, 503, "auditor_unavailable", "File Auditor не подключён или выбран неоднозначно")
			return
		}
		if _, err = modules.ValidateAuditorEndpoint(integration.URL); err != nil {
			problem(w, 503, "auditor_unavailable", "Проверьте адрес File Auditor")
			return
		}
		key, err := providers.ResolveGatewayKey(integration.SecretRef)
		if err != nil {
			problem(w, 503, "auditor_unavailable", "Ключ File Auditor недоступен")
			return
		}
		transport, err := s.Providers.ServiceGatewayTransport(integration.URL)
		if err != nil {
			problem(w, 503, "auditor_unavailable", "Адрес File Auditor не разрешён политикой подключения")
			return
		}
		s.ServiceGateway(ServiceGatewayConfig{AssertionVersion: 2, Audience: "auditor", Prefix: prefix, Upstream: integration.URL, Key: key, Transport: transport}).ServeHTTP(w, r)
	})
}

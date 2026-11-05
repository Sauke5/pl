package server

import (
	"errors"
	"io"
	"mime"
	"net/http"
	"pl/portal/internal/modules"
	"strings"
	"unicode"
)

func (s *Server) grafanaGateway() http.Handler {
	slots := make(chan struct{}, 8)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		session, err := s.readSession(r)
		if err != nil {
			problem(w, 401, "session_expired", "Войдите в Платформу")
			return
		}
		read := r.Method == http.MethodGet || r.Method == http.MethodHead
		contentType := ""
		path := r.URL.Path
		if r.URL.RawPath != "" || strings.ContainsAny(path, "%\\") || strings.Contains(path, "..") || strings.Contains(path, "//") || len(r.URL.RawQuery) > 8192 || strings.ContainsFunc(path+r.URL.RawQuery, unicode.IsControl) {
			problem(w, 400, "invalid_path", "Недопустимый маршрут Grafana")
			return
		}
		if path == "/grafana" && read {
			http.Redirect(w, r, "/grafana/", http.StatusTemporaryRedirect)
			return
		}
		if !read {
			// Native Grafana uses its own frontend. Mandatory same-origin Origin plus
			// non-simple JSON requests enforce CSRF without exposing the Portal token
			// or granting CORS. Native upstream CSRF protection remains enabled.
			if r.Header.Get("Origin") == "" || !s.sameOrigin(r) {
				problem(w, 403, "csrf", "Недопустимый источник запроса Grafana")
				return
			}
			if r.Method != http.MethodDelete {
				mediaType, _, e := mime.ParseMediaType(r.Header.Get("Content-Type"))
				if e != nil || mediaType != "application/json" {
					problem(w, 415, "json_required", "Grafana ожидает JSON")
					return
				}
				contentType = mediaType
			}
			viewerQuery := r.Method == http.MethodPost && (path == "/grafana/api/ds/query" || path == "/grafana/api/frontend-metrics")
			if !session.User.Admin && !viewerQuery {
				problem(w, 403, "forbidden", "Изменение Grafana доступно администратору")
				return
			}
		}
		if s.Modules == nil {
			problem(w, 503, "grafana_unavailable", "Grafana не установлена")
			return
		}
		integration, err := s.connectorSource(r, "grafana", "")
		if err != nil || integration.ManagedModuleID == "" {
			problem(w, 503, "grafana_unavailable", "Локальная Grafana не установлена, отключена или выбрана неоднозначно")
			return
		}
		select {
		case slots <- struct{}{}:
			defer func() { <-slots }()
		default:
			problem(w, 503, "grafana_busy", "Grafana занята. Повторите запрос позднее")
			return
		}
		var body []byte
		if !read {
			body, err = io.ReadAll(http.MaxBytesReader(w, r.Body, 512<<10))
			if err != nil {
				problem(w, 413, "body_too_large", "Слишком большой запрос Grafana")
				return
			}
		}
		response, err := s.Modules.GrafanaRequest(r.Context(), integration, r.Method, path, r.URL.RawQuery, contentType, session.User.ID, session.User.Name, session.User.Admin, body)
		if err != nil {
			status := 502
			if errors.Is(err, modules.ErrGrafanaUnavailable) {
				status = 503
			}
			problem(w, status, "grafana_unavailable", "Grafana не ответила. Проверьте состояние модуля")
			return
		}
		defer response.Body.Close()
		data, err := io.ReadAll(io.LimitReader(response.Body, (8<<20)+1))
		if err != nil || len(data) > 8<<20 {
			problem(w, 502, "grafana_response", "Не удалось получить полный ответ Grafana")
			return
		}
		// A long query may outlive a logout or a role change.
		current, e := s.readSession(r)
		if e != nil || current.User.ID != session.User.ID || current.User.Admin != session.User.Admin {
			problem(w, 401, "session_changed", "Сессия изменилась. Войдите заново")
			return
		}
		w.Header().Set("Content-Type", response.Header.Get("Content-Type"))
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(response.StatusCode)
		if r.Method != http.MethodHead {
			_, _ = w.Write(data)
		}
	})
}

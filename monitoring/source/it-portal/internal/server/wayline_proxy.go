package server

import (
	"bytes"
	"context"
	"crypto/subtle"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/store"
)

const waylinePrefix = "/wayline"

var waylineTargetPath = regexp.MustCompile(`^/api/v1/targets/[1-9][0-9]*$`)
var waylineRunPath = regexp.MustCompile(`^/api/v1/targets/[1-9][0-9]*/checks$`)
var waylineCheckPath = regexp.MustCompile(`^/api/v1/checks/[1-9][0-9]*$`)
var waylineAssetPath = regexp.MustCompile(`^/assets/[A-Za-z0-9_./-]+$`)

// WaylineProxy binds one server-selected integration. The transport factory must
// use the destination guard and add only server-side Wayline credentials. It is
// never selected from browser input. No WebSocket or streaming routes exist in
// the supported Wayline contract.
func (s *Server) WaylineProxy(integrationID string, transport func(model.Integration) (http.RoundTripper, error)) http.Handler {
	slots := make(chan struct{}, 4)
	static := newGatewayStaticCapacity()
	reads := newGatewayReadCapacity(slots)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		sess, err := s.readSession(r)
		if err != nil {
			if (r.Method == http.MethodGet || r.Method == http.MethodHead) && (r.URL.Path == waylinePrefix || r.URL.Path == waylinePrefix+"/") {
				http.Redirect(w, r, "/", http.StatusSeeOther)
			} else {
				problem(w, 401, "session_expired", "Войдите в портал")
			}
			return
		}
		if !sess.User.Admin {
			problem(w, 403, "forbidden", "Доступ только для IT-группы")
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			if !s.sameOrigin(r) || subtle.ConstantTimeCompare([]byte(r.Header.Get("X-CSRF-Token")), []byte(sess.CSRF)) != 1 {
				problem(w, 403, "csrf", "Запрос не прошёл проверку сессии")
				return
			}
		}
		if r.URL.Path == waylinePrefix && r.URL.RawQuery == "" && r.URL.RawPath == "" && (r.Method == "GET" || r.Method == "HEAD") {
			http.Redirect(w, r, waylinePrefix+"/", http.StatusTemporaryRedirect)
			return
		}
		path, query, ok := waylineRoute(r)
		if !ok || r.Header.Get("Upgrade") != "" {
			problem(w, 404, "wayline_route", "Этот маршрут Wayline недоступен через портал")
			return
		}
		selectedID := integrationID
		if selectedID == "" {
			source, e := s.connectorSource(r, "wayline", "")
			if e != nil {
				if errors.Is(e, store.ErrNotFound) && s.tryModuleStartupPage(w, r, "wayline", "", true) {
					return
				}
				problem(w, 503, "wayline_unavailable", "Подключите один активный Wayline или выберите основной источник в конфигурации")
				return
			}
			selectedID = source.ID
		}
		if transport == nil {
			problem(w, 503, "wayline_unavailable", "Wayline не настроен")
			return
		}
		source, err := store.Get[model.Integration](r.Context(), s.Store, "integration", selectedID)
		if err != nil || !source.Enabled || source.Kind != "wayline" {
			problem(w, 503, "wayline_unavailable", "Источник Wayline недоступен")
			return
		}
		if source.ManagedModuleID != "" && s.tryModuleStartupPage(w, r, "wayline", source.ManagedModuleID, false) {
			return
		}
		// Only an origin or an explicitly configured gateway path is accepted. All
		// browser-controlled paths have already passed the fixed route allowlist.
		base, err := url.Parse(source.URL)
		if err != nil || (base.Scheme != "http" && base.Scheme != "https") || base.Host == "" || base.User != nil || base.RawQuery != "" || base.Fragment != "" || strings.ContainsAny(base.EscapedPath(), "%\\") || strings.Contains(base.Path, "..") {
			problem(w, 503, "wayline_unavailable", "Адрес Wayline настроен неверно")
			return
		}
		if (r.Method == http.MethodGet || r.Method == http.MethodHead) && (waylineAssetPath.MatchString(path) || path == "/favicon.svg") {
			if !static.acquire(r.Context()) {
				problem(w, 503, "wayline_busy", "Wayline занят. Повторите запрос позднее")
				return
			}
			defer func() { <-static.slots }()
		} else if r.Method == http.MethodGet || r.Method == http.MethodHead {
			if !reads.acquire(r.Context()) {
				problem(w, 503, "wayline_busy", "Wayline занят. Повторите запрос позднее")
				return
			}
			defer func() { <-slots }()
		} else {
			select {
			case slots <- struct{}{}:
				defer func() { <-slots }()
			default:
				problem(w, 503, "wayline_busy", "Wayline занят. Повторите запрос позднее")
				return
			}
		}
		var body []byte
		if r.Method != "GET" && r.Method != "HEAD" {
			body, err = io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
			if err != nil {
				problem(w, 413, "wayline_body_limit", "Запрос Wayline слишком большой")
				return
			}
			if len(body) > 0 {
				mediaType, _, e := mime.ParseMediaType(r.Header.Get("Content-Type"))
				if e != nil || mediaType != "application/json" {
					problem(w, 415, "wayline_content_type", "Wayline принимает JSON")
					return
				}
			}
		}
		rt, err := transport(source)
		if err != nil || rt == nil {
			problem(w, 503, "wayline_unavailable", "Не удалось подключиться к Wayline")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 220*time.Second)
		defer cancel()
		base.Path = strings.TrimRight(base.Path, "/") + path
		base.RawPath = ""
		base.RawQuery = query
		out, err := http.NewRequestWithContext(ctx, r.Method, base.String(), bytes.NewReader(body))
		if err != nil {
			problem(w, 503, "wayline_unavailable", "Не удалось подключиться к Wayline")
			return
		}
		// An allowlist, rather than a denylist, prevents cookies, authorization,
		// forwarded identity and client-supplied CSRF headers crossing this boundary.
		if strings.HasPrefix(path, "/api/") {
			out.Header.Set("Accept", "application/json")
		}
		if len(body) > 0 {
			out.Header.Set("Content-Type", "application/json")
		}
		client := &http.Client{Transport: rt, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		resp, err := client.Do(out)
		if err != nil {
			problem(w, 502, "wayline_unavailable", "Wayline не ответил. Если запускалась проверка, проверьте её результат перед повтором")
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode >= 300 && resp.StatusCode < 400 || resp.StatusCode == 401 || resp.StatusCode == 403 || resp.StatusCode >= 500 {
			problem(w, 502, "wayline_unavailable", "Wayline отклонил запрос или временно недоступен")
			return
		}
		result, err := io.ReadAll(io.LimitReader(resp.Body, (8<<20)+1))
		if err != nil || len(result) > 8<<20 {
			problem(w, 502, "wayline_response_limit", "Не удалось получить полный ответ Wayline")
			return
		}
		// A slow manual check can outlive a session or concurrent logout. Its source
		// side effect is not retried; its response must not revive a revoked session.
		latest, err := s.readSession(r)
		if err != nil || !latest.User.Admin {
			problem(w, 401, "session_expired", "Сессия завершена. Войдите в портал и проверьте результат операции")
			return
		}
		if ct := resp.Header.Get("Content-Type"); ct != "" {
			w.Header().Set("Content-Type", ct)
		}
		w.WriteHeader(resp.StatusCode)
		if r.Method != "HEAD" {
			_, _ = w.Write(result)
		}
	})
}

func waylineRoute(r *http.Request) (string, string, bool) {
	if !strings.HasPrefix(r.URL.Path, waylinePrefix+"/") || r.URL.RawPath != "" || strings.ContainsAny(r.URL.EscapedPath(), "%\\") || r.URL.Fragment != "" {
		return "", "", false
	}
	path := strings.TrimPrefix(r.URL.Path, waylinePrefix)
	for _, part := range strings.Split(path, "/") {
		if part == "." || part == ".." {
			return "", "", false
		}
	}
	if strings.Contains(path, "//") {
		return "", "", false
	}
	q, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return "", "", false
	}
	for _, values := range q {
		if len(values) != 1 {
			return "", "", false
		}
	}
	read := r.Method == "GET" || r.Method == "HEAD"
	allowed := false
	switch {
	case path == "/" || path == "/favicon.svg" || waylineAssetPath.MatchString(path):
		allowed = read && len(q) == 0
	case path == "/api/v1/targets":
		allowed = (read || r.Method == "POST") && len(q) == 0
	case waylineTargetPath.MatchString(path):
		allowed = (r.Method == "PUT" || r.Method == "DELETE") && len(q) == 0
	case path == "/api/v1/checks/latest":
		allowed = read && len(q) == 1 && (q.Get("kind") == "path" || q.Get("kind") == "iperf")
	case path == "/api/v1/checks":
		id, e := strconv.ParseUint(q.Get("target_id"), 10, 63)
		limit, le := strconv.Atoi(q.Get("limit"))
		allowed = read && len(q) == 2 && e == nil && id > 0 && le == nil && limit > 0 && limit <= 50
	case waylineCheckPath.MatchString(path):
		allowed = read && len(q) == 0
	case waylineRunPath.MatchString(path):
		allowed = r.Method == "POST" && len(q) == 0
	}
	return path, q.Encode(), allowed
}

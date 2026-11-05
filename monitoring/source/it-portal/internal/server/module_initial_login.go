package server

import (
	"bytes"
	"crypto/subtle"
	"encoding/json"
	"io"
	"mime"
	"net/http"
)

// Registered only as a POST through moduleAuth. This is an explicit disclosure
// of an initial native human login, never an account-reset operation.
func (s *Server) moduleInitialLogin(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Referrer-Policy", "no-referrer")
	if !s.Config.PortableRelease {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodPost || r.URL.RawQuery != "" {
		problem(w, 400, "invalid_initial_login", "Недопустимый запрос первоначального входа")
		return
	}
	before, err := s.readSession(r)
	if err != nil {
		problem(w, 401, "session_expired", "Войдите в Платформу")
		return
	}
	if !before.User.Admin || r.Header.Get("Origin") != s.Config.PublicURL || !s.sameOrigin(r) || len(r.Header.Values("X-CSRF-Token")) != 1 || subtle.ConstantTimeCompare([]byte(before.CSRF), []byte(r.Header.Get("X-CSRF-Token"))) != 1 {
		problem(w, 403, "forbidden", "Первоначальный вход доступен администратору из Платформы")
		return
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		problem(w, 415, "json_required", "Ожидается JSON")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 256))
	var input struct {
		Service string `json:"service"`
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err != nil || len(bytes.TrimSpace(body)) == 0 || bytes.TrimSpace(body)[0] != '{' || decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF || (input.Service != "netbox" && input.Service != "gitea" && input.Service != "bookstack" && input.Service != "grafana") || !canonicalUUID(r.PathValue("id")) {
		problem(w, 400, "invalid_initial_login", "Выберите установленный сервис")
		return
	}
	if s.Modules == nil {
		problem(w, 503, "initial_login_unavailable", "Первоначальные данные входа недоступны")
		return
	}
	value, err := s.Modules.InitialLogin(r.Context(), r.PathValue("id"), input.Service)
	if err != nil {
		problem(w, 409, "initial_login_unavailable", "Первоначальные данные входа недоступны. Проверьте состояние модуля")
		return
	}
	// Do not release a password after logout, role change or session rotation.
	after, err := s.readSession(r)
	if err != nil || !after.User.Admin || after.User.ID != before.User.ID || after.CSRF != before.CSRF {
		problem(w, 401, "session_changed", "Сессия изменилась. Войдите заново")
		return
	}
	respond(w, 200, value)
}

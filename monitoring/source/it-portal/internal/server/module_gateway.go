package server

import (
	"context"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"pl/portal/internal/model"
	"pl/portal/internal/modules"
	"pl/portal/internal/store"
)

var moduleReadSlots = make(chan struct{}, 4)
var moduleReadWaiters = make(chan struct{}, 16)

// modulePrometheus is registered behind moduleAuth (fresh browser admin session).
// It exposes a finite GET/HEAD UI/API surface, never arbitrary upstream headers,
// credentials, redirects, lifecycle, administrative API or server-side writes.
// Prometheus v3.15 uses relative Vite assets and derives its router basename from
// the current page URL, so managed container flags and existing data need no change:
// https://github.com/prometheus/prometheus/blob/v3.15.0/web/ui/mantine-ui/vite.config.ts
// https://github.com/prometheus/prometheus/blob/v3.15.0/web/ui/mantine-ui/src/state/settingsSlice.ts
func (s *Server) modulePrometheus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		problem(w, 405, "method_not_allowed", "Доступно только чтение Prometheus")
		return
	}
	id := r.PathValue("id")
	parsed, err := uuid.Parse(id)
	if err != nil || parsed.String() != id {
		problem(w, 400, "invalid_module", "Некорректный ID модуля")
		return
	}
	path := "/" + r.PathValue("path")
	if strings.Contains(r.URL.EscapedPath(), "%") {
		problem(w, 400, "invalid_route", "Некорректный маршрут Prometheus")
		return
	}
	instance, err := store.Get[model.ModuleInstance](r.Context(), s.Store, "module_instance", id)
	if err != nil {
		s.fail(w, err)
		return
	}
	if instance.ModuleID != "prometheus" || instance.DesiredState != "enabled" || instance.IntegrationID == "" {
		problem(w, 409, "module_disabled", "Модуль не подключён")
		return
	}
	integration, err := store.Get[model.Integration](r.Context(), s.Store, "integration", instance.IntegrationID)
	if err != nil {
		s.fail(w, err)
		return
	}
	if integration.ManagedModuleID != instance.ID || !integration.Enabled {
		problem(w, 409, "module_disabled", "Интеграция модуля отключена")
		return
	}
	if instance.Mode == "external" {
		// Keep the browser on Pl. Only parsed JSON crosses the external API
		// boundary; administrator-provided HTML and scripts are never trusted here.
		if path == "/" || path == "/query" {
			http.Redirect(w, r, "/#modules?instance="+id+"&view=monitoring", http.StatusFound)
			return
		}
		if !strings.HasPrefix(path, "/api/v1/") || modules.ValidateRead(path, r.URL.RawQuery) != nil {
			problem(w, 404, "unsupported_route", "Внешний Prometheus доступен через страницу мониторинга и API Платформы")
			return
		}
	}
	if path == "/" || path == "/graph" {
		location := "/api/v1/modules/" + id + "/prometheus/query"
		if r.URL.RawQuery != "" {
			location += "?" + r.URL.RawQuery
		}
		http.Redirect(w, r, location, http.StatusFound)
		return
	}
	// The upstream UI explicitly falls back to finite polling when this endpoint
	// returns 204. Do not leave an unbounded SSE stream holding a host-controller lock.
	if path == "/api/v1/notifications/live" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err = modules.ValidateRead(path, r.URL.RawQuery); err != nil {
		problem(w, 404, "unsupported_route", err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	select {
	case moduleReadWaiters <- struct{}{}:
	default:
		problem(w, 429, "module_busy", "Слишком много запросов к модулю")
		return
	}
	select {
	case moduleReadSlots <- struct{}{}:
		<-moduleReadWaiters
		defer func() { <-moduleReadSlots }()
	case <-ctx.Done():
		<-moduleReadWaiters
		problem(w, 503, "module_busy", "Модуль занят; повторите запрос")
		return
	}
	response, err := s.Modules.ReadIntegration(ctx, integration, path, r.URL.RawQuery)
	if err != nil {
		problem(w, 502, "module_unavailable", err.Error())
		return
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, modules.ReadLimit+1))
	if err != nil || len(body) > modules.ReadLimit {
		problem(w, 502, "module_response_limit", "Ответ Prometheus прерван или превышает допустимый размер")
		return
	}
	contentType := response.Header.Get("Content-Type")
	if instance.Mode == "external" {
		mediaType, _, e := mime.ParseMediaType(contentType)
		if e != nil || mediaType != "application/json" || !json.Valid(body) || (response.StatusCode < 200 || response.StatusCode >= 300 && response.StatusCode < 400 || response.StatusCode >= 600) {
			problem(w, 502, "module_invalid_json", "Внешний Prometheus вернул некорректный JSON")
			return
		}
		contentType = "application/json"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "same-origin")
	w.Header().Set("Content-Security-Policy", "frame-ancestors 'self'; object-src 'none'; base-uri 'self'")
	w.WriteHeader(response.StatusCode)
	if r.Method == http.MethodGet {
		_, _ = w.Write(body)
	}
}

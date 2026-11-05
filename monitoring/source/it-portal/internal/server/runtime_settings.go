package server

import (
	"context"
	"errors"
	"net/http"
	"runtime"
	"strings"
	"time"
	"unicode/utf8"

	"pl/portal/internal/model"
	"pl/portal/internal/store"
)

// Read policy from persisted settings, never mutate shared Config during requests.
func (s *Server) runtimePolicy(ctx context.Context) (model.Settings, error) {
	if s.Store == nil {
		return model.Settings{}, nil
	}
	v, err := store.Get[model.Settings](ctx, s.Store, "settings", "global")
	if errors.Is(err, store.ErrNotFound) {
		return model.Settings{}, nil
	}
	return v, err
}
func (s *Server) sessionLifetime(ctx context.Context) (time.Duration, error) {
	v, err := s.runtimePolicy(ctx)
	if err != nil {
		return 0, err
	}
	if v.SessionLifetimeMinutes != 0 {
		if v.SessionLifetimeMinutes < 15 || v.SessionLifetimeMinutes > 10080 {
			return 0, errors.New("invalid session policy")
		}
		return time.Duration(v.SessionLifetimeMinutes) * time.Minute, nil
	}
	if s.Config.SessionLifetime > 0 {
		return s.Config.SessionLifetime, nil
	}
	return 8 * time.Hour, nil
}
func passwordMinimum(v model.Settings) int {
	if v.LocalPasswordMinLength == 0 {
		return 12
	}
	return v.LocalPasswordMinLength
}
func (s *Server) validPasswordForRequest(r *http.Request, password string) bool {
	v, err := s.runtimePolicy(r.Context())
	if err != nil {
		return false
	}
	minimum := v.LocalPasswordMinLength
	if minimum == 0 {
		minimum = 12
	}
	return minimum >= 8 && minimum <= 128 && utf8.ValidString(password) && utf8.RuneCountInString(password) >= minimum && len(password) <= 1024 && !strings.ContainsAny(password, "\x00\r\n")
}
func (s *Server) runtimeSettings(w http.ResponseWriter, r *http.Request) {
	lifetime, err := s.sessionLifetime(r.Context())
	if err != nil {
		s.fail(w, err)
		return
	}
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	response := map[string]any{
		"go_version": runtime.Version(), "os": runtime.GOOS, "architecture": runtime.GOARCH,
		"process_memory_bytes": mem.Sys, "process_heap_bytes": mem.HeapAlloc,
		"available_cpus": runtime.NumCPU(), "goroutines": runtime.NumGoroutine(),
		"session_lifetime_minutes": int(lifetime / time.Minute),
		"allowed_cidrs":            s.Config.CIDRs, "allowed_ports": s.Config.Ports,
		"demo": s.Config.Demo, "oidc_configured": s.Config.Issuer != "", "executor_configured": s.Config.ExecutorURL != "",
	}
	if s.Modules == nil {
		response["host_error"] = "Диагностика хоста недоступна: host controller не подключён"
	} else if host, err := s.Modules.HostStatus(r.Context()); err != nil {
		response["host_error"] = "Не удалось получить состояние хоста"
	} else {
		response["host"] = host
	}
	respond(w, 200, response)
}

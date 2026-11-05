package server

import (
	"net/http"
	"os"
	"path/filepath"
)

// Check writes at backend admission as well as at ingress: Nginx can finish
// buffering an older request after the API has already been replaced.
func (s *Server) maintenanceGate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.Config.PortableRelease || s.Config.MaintenanceDir == "" || maintenanceReadOrControl(r) {
			next.ServeHTTP(w, r)
			return
		}
		_, err := os.Lstat(filepath.Join(s.Config.MaintenanceDir, "active"))
		if os.IsNotExist(err) {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Retry-After", "2")
		w.Header().Set("Cache-Control", "no-store")
		problem(w, http.StatusServiceUnavailable, "installation_maintenance", "Платформа проходит обслуживание. Повторите действие после его завершения.")
	})
}

func maintenanceReadOrControl(r *http.Request) bool {
	if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
		return true
	}
	if r.Method == http.MethodPost {
		switch r.URL.Path {
		case "/api/v1/delivery/check", "/api/v1/delivery/upgrade", "/api/v1/delivery/module-upgrade", "/api/v1/delivery/recover", "/api/v1/installation/configure", "/internal/delivery/reconcile":
			return true
		}
	}
	return false
}

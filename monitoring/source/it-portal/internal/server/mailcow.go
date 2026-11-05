package server

import (
	"github.com/google/uuid"
	"net/http"
	"pl/portal/internal/model"
	"strings"
)

func validMailcowSecretRef(ref string) bool {
	if strings.HasPrefix(ref, "file:") {
		name := strings.TrimPrefix(ref, "file:")
		return name != "" && name != "." && name != ".." && strings.TrimSpace(name) == name && !strings.ContainsAny(name, "/\\")
	}
	name, ok := strings.CutPrefix(ref, "env:PORTAL_SECRET_")
	if !ok || name == "" {
		return false
	}
	for _, ch := range name {
		if !(ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9' || ch == '_') {
			return false
		}
	}
	return true
}

func (s *Server) mailcowSnapshot(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, err := uuid.Parse(id); err != nil {
		problem(w, 400, "invalid_module", "Укажите подключение Mailcow")
		return
	}
	snapshot, err := s.Store.MailcowSnapshot(r.Context(), id)
	if err != nil {
		s.fail(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	respond(w, 200, snapshot)
}

func (s *Server) mailcowSettings(w http.ResponseWriter, r *http.Request) {
	var settings model.MailcowSettings
	if !decode(w, r, &settings) {
		return
	}
	if err := s.Store.SaveMailcowSettings(r.Context(), r.PathValue("id"), current(r).User.ID, settings); err != nil {
		s.fail(w, err)
		return
	}
	s.mailcowSnapshot(w, r)
}

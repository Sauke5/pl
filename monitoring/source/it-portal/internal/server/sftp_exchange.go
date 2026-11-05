package server

import (
	"net/http"
	"time"

	"pl/portal/internal/model"
)

// RegisterSFTPExchangeRoutes is kept separate so the shared route registry can
// be integrated by its owner without coupling this read-only adapter to SFTP UI.
func (s *Server) RegisterSFTPExchangeRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/sftp-exchange", func(w http.ResponseWriter, r *http.Request) {
		// Browser APIs must not inherit machine credentials or scopes.
		if _, ok := r.Header["Authorization"]; ok {
			problem(w, http.StatusUnauthorized, "browser_session_required", "Требуется сессия Платформы")
			return
		}
		s.auth(s.sftpExchange, true)(w, r)
	})
}

func (s *Server) sftpExchange(w http.ResponseWriter, r *http.Request) {
	branches, err := s.Store.SFTPExchangeBranches(r.Context())
	if err != nil {
		s.fail(w, err)
		return
	}
	provider, err := s.sftpProviderOverview(r.Context())
	if err != nil {
		s.fail(w, err)
		return
	}
	respond(w, http.StatusOK, model.SFTPExchangeState{
		ObservedAt: time.Now().UTC(),
		Provider:   provider,
		Branches:   branches,
	})
}

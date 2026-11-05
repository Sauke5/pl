package server

import (
	"net/http"
	"strings"
)

// dozzleAuth is for an nginx internal auth_request only. Dozzle receives this
// server-derived identity, never a browser supplied Remote-User or portal cookie.
func (s *Server) dozzleAuth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	sess, err := s.readSession(r)
	if err != nil {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	if !sess.User.Admin {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	method := r.Header.Get("X-Original-Method")
	if method != "GET" && method != "HEAD" {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	if strings.EqualFold(r.Header.Get("X-Original-Upgrade"), "websocket") && !s.gatewayOrigin(r) {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	w.Header().Set("X-Auth-User", "portal-"+hash(sess.User.ID)[:32])
	w.WriteHeader(http.StatusNoContent)
}

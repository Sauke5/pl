package server

import "net/http"

func (s *Server) resourceInventory(w http.ResponseWriter, r *http.Request) {
	v, err := s.Store.ResourceInventory(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, err)
		return
	}
	respond(w, http.StatusOK, v)
}

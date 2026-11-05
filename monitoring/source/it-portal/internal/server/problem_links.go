package server

import (
	"net/http"
	"pl/portal/internal/model"
)

func (s *Server) problemLinks(w http.ResponseWriter, r *http.Request) {
	if r.Method == "PUT" {
		var input model.ProblemLinkUpdate
		if !decode(w, r, &input) {
			return
		}
		if e := s.Store.SetProblemLinks(r.Context(), r.PathValue("id"), input, current(r).User); e != nil {
			s.fail(w, e)
			return
		}
		s.Hub.Notify("problems")
		s.Hub.Notify("events")
	}
	links, e := s.Store.ProblemLinks(r.Context(), r.PathValue("id"))
	if e != nil {
		s.fail(w, e)
		return
	}
	respond(w, 200, links)
}

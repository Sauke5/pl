package server

import (
	"net/http"
	"time"
)

func (s *Server) problemVisibility(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Hidden            *bool      `json:"hidden"`
		ExpectedStartedAt *time.Time `json:"expected_started_at,omitempty"`
	}
	if !decode(w, r, &input) {
		return
	}
	if input.Hidden == nil {
		problem(w, 400, "invalid_data", "Укажите hidden: true или false")
		return
	}
	if e := s.Store.SetProblemVisibility(r.Context(), r.PathValue("id"), *input.Hidden, current(r).User, input.ExpectedStartedAt); e != nil {
		s.fail(w, e)
		return
	}
	s.Hub.Notify("problems")
	s.Hub.Notify("events")
	w.WriteHeader(http.StatusNoContent)
}

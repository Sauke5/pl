package server

import (
	"encoding/json"
	"net/http"
)

func (s *Server) helpState(w http.ResponseWriter, r *http.Request) {
	state, e := s.Store.HelpState(r.Context(), current(r).User.ID)
	if e != nil {
		s.fail(w, e)
		return
	}
	respond(w, http.StatusOK, state)
}

func (s *Server) updateHelpState(w http.ResponseWriter, r *http.Request) {
	// Raw fields distinguish omission from explicit null; false remains a valid update.
	var input struct {
		Topic    json.RawMessage `json:"topic"`
		Disabled json.RawMessage `json:"disabled"`
	}
	if !decode(w, r, &input) {
		return
	}
	var topic *string
	var disabled *bool
	if len(input.Topic) > 0 {
		if e := json.Unmarshal(input.Topic, &topic); e != nil || topic == nil {
			problem(w, 400, "invalid_data", "topic должен быть строкой")
			return
		}
	}
	if len(input.Disabled) > 0 {
		if e := json.Unmarshal(input.Disabled, &disabled); e != nil || disabled == nil {
			problem(w, 400, "invalid_data", "disabled должен быть true или false")
			return
		}
	}
	state, e := s.Store.UpdateHelpState(r.Context(), current(r).User.ID, topic, disabled)
	if e != nil {
		s.fail(w, e)
		return
	}
	respond(w, http.StatusOK, state)
}

package server

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"pl/portal/internal/store"
)

func journalChannel(r *http.Request) (string, error) {
	channel := r.URL.Query().Get("channel")
	if channel == "" {
		channel = "events"
	}
	if channel != "events" && channel != "audit" {
		return "", store.ErrInvalid
	}
	return channel, nil
}
func (s *Server) eventJournal(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	channel, e := journalChannel(r)
	if e != nil {
		s.fail(w, e)
		return
	}
	f := store.JournalFilter{Channel: channel, ResourceID: q.Get("resource_id"), Source: q.Get("source"), Type: q.Get("type"), Actor: q.Get("actor"), Snapshot: q.Get("snapshot"), Cursor: q.Get("cursor"), Limit: 50}
	for _, v := range []string{f.ResourceID, f.Actor} {
		if len(v) > 256 {
			s.fail(w, store.ErrInvalid)
			return
		}
	}
	if f.Source != "" && f.Source != "prometheus" && f.Source != "alertmanager" && f.Source != "platform" {
		s.fail(w, store.ErrInvalid)
		return
	}
	switch f.Type {
	case "", "problem", "recovery", "connection", "discovery", "operation", "change":
	default:
		s.fail(w, store.ErrInvalid)
		return
	}
	if q.Get("monitoring_only") != "" {
		f.MonitoringOnly, e = strconv.ParseBool(q.Get("monitoring_only"))
		if e != nil {
			s.fail(w, store.ErrInvalid)
			return
		}
	}
	if q.Get("exclude_collection") != "" {
		f.ExcludeCollection, e = strconv.ParseBool(q.Get("exclude_collection"))
		if e != nil {
			s.fail(w, store.ErrInvalid)
			return
		}
	}
	if q.Get("limit") != "" {
		f.Limit, e = strconv.Atoi(q.Get("limit"))
		if e != nil || f.Limit < 1 || f.Limit > 100 {
			s.fail(w, store.ErrInvalid)
			return
		}
	}
	for key, dst := range map[string]*time.Time{"from": &f.From, "to": &f.To} {
		if v := q.Get(key); v != "" {
			*dst, e = time.Parse(time.RFC3339Nano, v)
			if e != nil {
				s.fail(w, store.ErrInvalid)
				return
			}
		}
	}
	result, e := s.Store.Journal(r.Context(), current(r).User.ID, f)
	if e != nil {
		s.fail(w, e)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	respond(w, 200, result)
}
func (s *Server) eventJournalView(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Initialize bool     `json:"initialize"`
		Channel    string   `json:"channel"`
		IDs        []string `json:"ids"`
	}
	if !decode(w, r, &in) {
		return
	}
	var e error
	if in.Initialize {
		if in.Channel != "" || in.IDs != nil {
			s.fail(w, store.ErrInvalid)
			return
		}
		e = s.Store.InitializeJournal(r.Context(), current(r).User.ID)
	} else {
		if in.Channel != "events" && in.Channel != "audit" || len(in.IDs) == 0 || len(in.IDs) > 100 {
			s.fail(w, store.ErrInvalid)
			return
		}
		e = s.Store.MarkJournalSeen(r.Context(), current(r).User.ID, in.Channel, in.IDs)
	}
	if e != nil {
		s.fail(w, e)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
func (s *Server) eventJournalDetail(w http.ResponseWriter, r *http.Request) {
	channel, e := journalChannel(r)
	if e != nil {
		s.fail(w, e)
		return
	}
	id := r.PathValue("id")
	if len(id) == 0 || len(id) > 128 {
		s.fail(w, store.ErrInvalid)
		return
	}
	result, e := s.Store.JournalDetail(r.Context(), current(r).User.ID, channel, id)
	if e != nil {
		if errors.Is(e, store.ErrNotFound) {
			problem(w, 404, "not_found", "Событие не найдено")
			return
		}
		s.fail(w, e)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	respond(w, 200, result)
}

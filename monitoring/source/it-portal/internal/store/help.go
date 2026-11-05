package store

import (
	"context"
	"errors"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"pl/portal/internal/model"
)

func (s *Store) HelpState(ctx context.Context, userID string) (model.HelpState, error) {
	state := model.HelpState{Seen: []string{}}
	if strings.TrimSpace(userID) == "" {
		return state, ErrInvalid
	}
	found, e := Get[model.HelpState](ctx, s, "help_state", userID)
	if errors.Is(e, ErrNotFound) {
		return state, nil
	}
	if e != nil {
		return state, e
	}
	if found.Seen == nil {
		found.Seen = []string{}
	}
	return found, nil
}

func (s *Store) UpdateHelpState(ctx context.Context, userID string, topic *string, disabled *bool) (model.HelpState, error) {
	state := model.HelpState{Seen: []string{}}
	if strings.TrimSpace(userID) == "" || (topic == nil && disabled == nil) || (topic != nil && !model.ValidHelpTopic(*topic)) {
		return state, ErrInvalid
	}
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return state, e
	}
	defer tx.Rollback(ctx)
	// Serialize even the first absent document; separate tabs append rather than replace.
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", "help-state:"+userID); e != nil {
		return state, e
	}
	var revision int64
	var body []byte
	e = tx.QueryRow(ctx, "SELECT revision,body FROM documents WHERE kind='help_state' AND id=$1", userID).Scan(&revision, &body)
	if e == nil {
		state, e = Decode[model.HelpState](body)
		if e != nil {
			return state, e
		}
	} else if !errors.Is(e, pgx.ErrNoRows) {
		return state, e
	}
	if state.Seen == nil {
		state.Seen = []string{}
	}
	changed := false
	if topic != nil && !Contains(state.Seen, *topic) {
		if len(state.Seen) >= 100 {
			return state, ErrInvalid
		}
		state.Seen = append(state.Seen, *topic)
		sort.Strings(state.Seen)
		changed = true
	}
	if disabled != nil && state.Disabled != *disabled {
		state.Disabled = *disabled
		changed = true
	}
	if changed {
		if _, e = save(ctx, tx, "help_state", userID, revision, state); e != nil {
			return state, e
		}
	}
	return state, tx.Commit(ctx)
}

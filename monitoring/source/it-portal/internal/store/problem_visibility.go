package store

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"pl/portal/internal/model"
	"time"
)

// Visibility is local presentation state, separate from the source's alert.
// An Alertmanager fingerprint can recur; StartedAt identifies its occurrence.
type problemVisibility struct {
	ID           string    `json:"id"`
	StartedAt    time.Time `json:"started_at"`
	Hidden       bool      `json:"hidden"`
	HiddenBy     string    `json:"hidden_by"`
	HiddenByName string    `json:"hidden_by_name"`
	HiddenAt     time.Time `json:"hidden_at"`
}

func applyProblemVisibility(p *model.Problem, v problemVisibility) {
	p.Hidden = v.Hidden && p.Status == "firing" && !p.StartedAt.IsZero() && p.StartedAt.Equal(v.StartedAt)
	p.HiddenBy, p.HiddenByName, p.HiddenAt = "", "", nil
	if p.Hidden {
		p.HiddenBy = v.HiddenBy
		p.HiddenByName = v.HiddenByName
		p.HiddenAt = &v.HiddenAt
	}
}

func (s *Store) SetProblemVisibility(ctx context.Context, id string, hidden bool, actor model.User, expectedStartedAt *time.Time) error {
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var body []byte
	// Serialize with source updates so a hide always belongs to one exact occurrence.
	if e = tx.QueryRow(ctx, "SELECT body FROM documents WHERE kind='problem' AND id=$1 FOR UPDATE", id).Scan(&body); e != nil {
		return translate(e)
	}
	p, e := Decode[model.Problem](body)
	if e != nil {
		return e
	}
	if expectedStartedAt != nil && !p.StartedAt.Equal(*expectedStartedAt) {
		return ErrConflict
	}
	if hidden && (p.Status != "firing" || p.StartedAt.IsZero()) {
		return ErrInvalid
	}
	var revision int64
	var visibility problemVisibility
	e = tx.QueryRow(ctx, "SELECT revision,body FROM documents WHERE kind='problem_visibility' AND id=$1", id).Scan(&revision, &body)
	if e == nil {
		visibility, e = Decode[problemVisibility](body)
		if e != nil {
			return e
		}
	} else if !errors.Is(e, pgx.ErrNoRows) {
		return e
	}
	resources, links, e := transactionLinkState(ctx, tx)
	if e != nil {
		return e
	}
	applyLinks(&p, resources, links)
	applyProblemVisibility(&p, visibility)
	if visibility.Hidden == hidden && (!hidden || p.Hidden) {
		return tx.Commit(ctx)
	}
	visibility.ID = id
	visibility.Hidden = hidden
	if hidden {
		visibility.StartedAt = p.StartedAt
		visibility.HiddenBy = actor.ID
		visibility.HiddenByName = actor.Name
		visibility.HiddenAt = time.Now().UTC()
	}
	if _, e = save(ctx, tx, "problem_visibility", id, revision, visibility); e != nil {
		return e
	}
	kind, title := "problem.shown", "Возвращена проблема: "
	if hidden {
		kind, title = "problem.hidden", "Скрыта проблема: "
	}
	details := map[string]any{"problem_id": id, "started_at": p.StartedAt, "hidden": hidden, "resource_ids": p.ResourceIDs}
	for _, audit := range []bool{true, false} {
		if e = record(ctx, tx, kind, title+p.Title, p.ResourceID, actor.ID, details, audit); e != nil {
			return e
		}
	}
	return tx.Commit(ctx)
}

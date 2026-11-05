package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/store/sqlgen"
)

type ImportWrite struct {
	Kind     string          `json:"kind"`
	ID       string          `json:"id"`
	Revision int64           `json:"revision"`
	Body     json.RawMessage `json:"body"`
}
type ImportPlan struct {
	Token     string        `json:"token"`
	Actor     string        `json:"actor"`
	Baseline  string        `json:"baseline"`
	Writes    []ImportWrite `json:"writes"`
	ExpiresAt time.Time     `json:"expires_at"`
}

func catalogDigest(ctx context.Context, q *sqlgen.Queries) (string, error) {
	h := sha256.New()
	for _, kind := range []string{"resource", "collection"} {
		ds, e := q.ListDocuments(ctx, kind)
		if e != nil {
			return "", e
		}
		for _, d := range ds {
			h.Write(encode(struct {
				Kind, ID string
				Revision int64
			}{kind, d.ID, d.Revision}))
		}
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
func (s *Store) CatalogDigest(ctx context.Context) (string, error) { return catalogDigest(ctx, s.Q) }
func (s *Store) SaveImportPlan(ctx context.Context, p ImportPlan) error {
	_, e := s.Pool.Exec(ctx, "INSERT INTO import_plans(token,actor,body,expires_at) VALUES($1,$2,$3,$4)", p.Token, p.Actor, encode(p), p.ExpiresAt)
	return e
}
func (s *Store) ApplyImport(ctx context.Context, token, actor string) error {
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(7398218)"); e != nil {
		return e
	}
	var b []byte
	e = tx.QueryRow(ctx, "SELECT body FROM import_plans WHERE token=$1 AND actor=$2 AND expires_at>now() FOR UPDATE", token, actor).Scan(&b)
	if e != nil {
		return translate(e)
	}
	p, e := Decode[ImportPlan](b)
	if e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, "LOCK TABLE documents IN SHARE ROW EXCLUSIVE MODE"); e != nil {
		return e
	}
	digest, e := catalogDigest(ctx, sqlgen.New(tx))
	if e != nil {
		return e
	}
	if digest != p.Baseline {
		return ErrConflict
	}
	for _, v := range p.Writes {
		if v.Kind == "resource" {
			r, err := Decode[model.Resource](v.Body)
			if err != nil {
				return err
			}
			// A newly imported card has no linked source identity in this catalog.
			if v.Revision == 0 {
				r.IPSource = ""
			}
			if err = prepareResourceIPSource(ctx, tx, v.ID, v.Revision, &r); err != nil {
				return err
			}
			v.Body = encode(r)
		}
		if _, e = save(ctx, tx, v.Kind, v.ID, v.Revision, v.Body); e != nil {
			return e
		}
	}
	if e = reindex(ctx, tx); e != nil {
		return e
	}
	if e = record(ctx, tx, "import.applied", "Применён импорт каталога", "", actor, map[string]any{"count": len(p.Writes)}, true); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, "DELETE FROM import_plans WHERE token=$1", token); e != nil {
		return e
	}
	return tx.Commit(ctx)
}

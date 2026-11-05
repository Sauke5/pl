package store

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"pl/portal/internal/model"
)

// Callers hold the report advisory transaction lock, including for absent URLs.
// This serializes archive adoption against completion of a generation job.
func upsertReport(ctx context.Context, tx pgx.Tx, report model.Report, imported bool) error {
	var revision int64
	var body []byte
	var e error
	if report.URL != "" {
		e = tx.QueryRow(ctx, "SELECT revision,body FROM documents WHERE kind='report' AND body->>'url'=$1 ORDER BY (body->>'job_id' <> '') DESC LIMIT 1", report.URL).Scan(&revision, &body)
	} else {
		e = pgx.ErrNoRows
	}
	if errors.Is(e, pgx.ErrNoRows) {
		// Failed jobs have no URL, and a repeat Finish must update their existing ID.
		e = tx.QueryRow(ctx, "SELECT revision,body FROM documents WHERE kind='report' AND id=$1", report.ID).Scan(&revision, &body)
	}
	if e == nil {
		old, err := Decode[model.Report](body)
		if err != nil {
			return err
		}
		if imported && old.JobID != "" {
			return nil
		}
		report.ID = old.ID
	} else if !errors.Is(e, pgx.ErrNoRows) {
		return e
	}
	_, e = save(ctx, tx, "report", report.ID, revision, report)
	return e
}

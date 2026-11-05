package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"pl/portal/internal/model"
	"pl/portal/internal/store/sqlgen"
)

// EventObservation aggregates confirmations, never appending one event per poll.
// Polling observes snapshots: transitions entirely between successful polls cannot
// be reconstructed. Missing targets are not recoveries. Unknown target health and
// failed polls do not replace the last known up/down observation.
type EventObservation struct {
	EpisodeID       string            `json:"episode_id,omitempty"`
	ID              string            `json:"id"`
	IntegrationID   string            `json:"integration_id"`
	SourceKind      string            `json:"source_kind"`
	ExternalID      string            `json:"external_id"`
	Name            string            `json:"name"`
	Health          string            `json:"health"`
	Labels          map[string]string `json:"labels,omitempty"`
	FirstSeen       time.Time         `json:"first_seen"`
	LastConfirmedAt time.Time         `json:"last_confirmed_at"`
	FirstSample     time.Time         `json:"first_sample"`
	LastSample      time.Time         `json:"last_sample"`
	Confirmations   int64             `json:"confirmations"`
}

func monitoringDetails(i model.Integration, severity string) map[string]any {
	return map[string]any{"source_kind": i.Kind, "source_name": i.Name, "integration_id": i.ID, "time_basis": "observed", "severity": severity}
}

func recordSourceTransition(ctx context.Context, tx pgx.Tx, i model.Integration, previous string, pollErr error) error {
	if i.Kind != "prometheus" && i.Kind != "alertmanager" {
		return nil
	}
	if pollErr != nil && previous != "error" {
		return record(ctx, tx, "source.disconnected", "Источник недоступен: "+i.Name, "", "system", monitoringDetails(i, "warning"), false)
	}
	if pollErr == nil && previous == "error" {
		return record(ctx, tx, "source.reconnected", "Связь с источником восстановлена: "+i.Name, "", "system", monitoringDetails(i, "info"), false)
	}
	return nil
}

func problemEventDetails(i model.Integration, p model.Problem, firing bool) map[string]any {
	severity := p.Severity
	if !firing {
		severity = "info"
	}
	details := monitoringDetails(i, severity)
	details["problem_id"] = p.ID
	details["resource_ids"] = p.ResourceIDs
	details["labels"] = p.Labels
	details["observation_id"] = problemObservationID(i, p)
	if firing && !p.StartedAt.IsZero() {
		details["occurred_at"] = p.StartedAt.UTC().Format(time.RFC3339Nano)
		details["time_basis"] = "source"
	}
	// Alertmanager absence has no exact source endsAt; resolution is observed.
	return details
}

func loadEventObservation(ctx context.Context, tx pgx.Tx, id string) (EventObservation, int64, error) {
	d, err := sqlgen.New(tx).GetDocument(ctx, sqlgen.GetDocumentParams{Kind: "event_observation", ID: id})
	if errors.Is(err, pgx.ErrNoRows) {
		return EventObservation{ID: id}, 0, nil
	}
	if err != nil {
		return EventObservation{}, 0, err
	}
	o, err := Decode[EventObservation](d.Body)
	return o, d.Revision, err
}

func problemObservationID(i model.Integration, p model.Problem) string {
	return SourceID(i.ID, "problem:"+p.ExternalID+":"+p.StartedAt.UTC().Format(time.RFC3339Nano))
}

func confirmProblemObservation(ctx context.Context, tx pgx.Tx, i model.Integration, p model.Problem, now time.Time) error {
	id := problemObservationID(i, p)
	o, rev, err := loadEventObservation(ctx, tx, id)
	if err != nil {
		return err
	}
	if rev == 0 {
		o.FirstSeen, o.FirstSample, o.Confirmations = now, now, 0
	}
	o.IntegrationID, o.SourceKind, o.ExternalID = i.ID, i.Kind, p.ExternalID
	o.Name, o.Health, o.Labels = p.Title, "firing", p.Labels
	o.LastConfirmedAt, o.LastSample = now, now
	o.Confirmations++
	_, err = save(ctx, tx, "event_observation", id, rev, o)
	return err
}

func applyTargetObservations(ctx context.Context, tx pgx.Tx, i model.Integration, targets []model.MonitoringTarget, now time.Time) error {
	baselineID := SourceID(i.ID, "targets:baseline")
	_, baselineRevision, err := loadEventObservation(ctx, tx, baselineID)
	if err != nil {
		return err
	}
	for _, target := range targets {
		if target.Health != "up" && target.Health != "down" {
			continue
		}
		id := SourceID(i.ID, "target:"+target.ExternalID)
		o, rev, err := loadEventObservation(ctx, tx, id)
		if err != nil {
			return err
		}
		changed := o.Health != target.Health
		// Existing baseline targets are silent. Later newly discovered down targets
		// matter, whereas first observation of a healthy target is not a recovery.
		emit := baselineRevision > 0 && changed && (rev > 0 || target.Health == "down")
		if rev == 0 || changed {
			o.FirstSeen, o.FirstSample, o.Confirmations = now, target.LastScrape, 0
			o.EpisodeID = SourceID(id, now.Format(time.RFC3339Nano))
		}
		o.IntegrationID, o.SourceKind, o.ExternalID = i.ID, i.Kind, target.ExternalID
		o.Name, o.Health, o.Labels = target.Name, target.Health, target.Labels
		o.LastConfirmedAt, o.LastSample = now, target.LastScrape
		o.Confirmations++
		if _, err = save(ctx, tx, "event_observation", id, rev, o); err != nil {
			return err
		}
		_, episodeRev, err := loadEventObservation(ctx, tx, o.EpisodeID)
		if err != nil {
			return err
		}
		episode := o
		episode.ID = o.EpisodeID
		if _, err = save(ctx, tx, "event_observation", o.EpisodeID, episodeRev, episode); err != nil {
			return err
		}
		if !emit {
			continue
		}
		severity, title := "warning", "Сбор метрик прекратился: "
		if target.Health == "up" {
			severity, title = "info", "Сбор метрик восстановлен: "
		}
		details := monitoringDetails(i, severity)
		details["target_id"], details["observation_id"] = target.ExternalID, o.EpisodeID
		details["labels"], details["target_name"] = target.Labels, target.Name
		resourceID := ""
		candidate, err := sqlgen.New(tx).GetDocument(ctx, sqlgen.GetDocumentParams{Kind: "candidate", ID: SourceID(i.ID, target.ExternalID)})
		if err == nil {
			c, decodeErr := Decode[model.Candidate](candidate.Body)
			if decodeErr != nil {
				return decodeErr
			}
			resourceID = c.ResourceID
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if err = record(ctx, tx, "target."+target.Health, title+target.Name, resourceID, "system", details, false); err != nil {
			return err
		}
	}
	if baselineRevision == 0 {
		_, err = save(ctx, tx, "event_observation", baselineID, 0, EventObservation{ID: baselineID, IntegrationID: i.ID, SourceKind: i.Kind, Health: "baseline", FirstSeen: now, LastConfirmedAt: now})
	}
	return err
}

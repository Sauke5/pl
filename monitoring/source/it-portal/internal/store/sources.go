package store

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"pl/portal/internal/model"
	"pl/portal/internal/store/sqlgen"
)

func SourceID(source, external string) string {
	return uuid.NewSHA1(uuid.NameSpaceURL, []byte(source+"\x00"+external)).String()
}
func (s *Store) ApplySnapshot(ctx context.Context, i model.Integration, snapshot model.Snapshot, pollErr error) error {
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	// Match the resource/candidate lock order used by candidate resolution.
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(7398218)"); e != nil {
		return e
	}
	var rev int64
	var b []byte
	e = tx.QueryRow(ctx, "SELECT revision,body FROM documents WHERE kind='integration' AND id=$1 FOR UPDATE", i.ID).Scan(&rev, &b)
	if e != nil {
		return translate(e)
	}
	if rev != i.Revision {
		return ErrConflict
	}
	current, e := Decode[model.Integration](b)
	if e != nil {
		return e
	}
	if !current.Enabled {
		return nil
	}
	now := time.Now().UTC()
	previousStatus := current.Status
	current.LastAttempt = &now
	if pollErr != nil {
		current.Status = "error"
		current.Error = "Источник недоступен или ответ не прошёл проверку"
	} else {
		current.LastSuccess = &now
		current.Status = "connected"
		current.Error = ""
	}
	if _, e = tx.Exec(ctx, "UPDATE documents SET body=$2,updated_at=now() WHERE kind='integration' AND id=$1", i.ID, encode(current)); e != nil {
		return e
	}
	if e = recordSourceTransition(ctx, tx, current, previousStatus, pollErr); e != nil {
		return e
	}
	if pollErr != nil {
		return tx.Commit(ctx)
	}
	if i.Kind == "oxidized" {
		if e = applyConfigurationSnapshot(ctx, tx, current, snapshot.Configuration, now); e != nil {
			return e
		}
	}
	if i.Kind == "prometheus" {
		if e = applyTargetObservations(ctx, tx, current, snapshot.Targets, now); e != nil {
			return e
		}
	}
	if len(snapshot.Reports) > 0 {
		if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(7398219)"); e != nil {
			return e
		}
		for _, report := range snapshot.Reports {
			if report.URL == "" {
				return errors.New("report URL required")
			}
			report.ID = SourceID("report-url", report.URL)
			if e = upsertReport(ctx, tx, report, true); e != nil {
				return e
			}
		}
	}
	q := sqlgen.New(tx)
	refreshed := []model.Candidate{}
	for _, candidate := range snapshot.Candidates {
		candidate.ID = SourceID(i.ID, candidate.ExternalID)
		candidate.IntegrationID = i.ID
		candidate.LastSeen = now
		candidate.State = "pending"
		candidate.ResourceID = ""
		old, e := q.GetDocument(ctx, sqlgen.GetDocumentParams{Kind: "candidate", ID: candidate.ID})
		var oldRevision int64
		if e == nil {
			v, e := Decode[model.Candidate](old.Body)
			if e != nil {
				return e
			}
			candidate.State = v.State
			candidate.ResourceID = v.ResourceID
			oldRevision = old.Revision
		} else if !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
		if _, e = save(ctx, tx, "candidate", candidate.ID, oldRevision, candidate); e != nil {
			return e
		}
		refreshed = append(refreshed, candidate)
		if oldRevision == 0 {
			if e = record(ctx, tx, "discovery.new", "Обнаружен ресурс: "+candidate.Name, "", "system", map[string]any{"integration_id": i.ID, "candidate_id": candidate.ID}, false); e != nil {
				return e
			}
		}
	}
	if i.Kind == "netbox" {
		if e = refreshLinkedInventoryIPs(ctx, tx, refreshed); e != nil {
			return e
		}
	}
	if i.Kind == "alertmanager" {
		existing, e := q.ListDocuments(ctx, "problem")
		if e != nil {
			return e
		}
		byID := map[string]sqlgen.Document{}
		for _, d := range existing {
			p, e := Decode[model.Problem](d.Body)
			if e != nil {
				return e
			}
			if p.IntegrationID == i.ID {
				byID[d.ID] = d
			}
		}
		resourceDocs, e := q.ListDocuments(ctx, "resource")
		if e != nil {
			return e
		}
		resources := []model.Resource{}
		for _, d := range resourceDocs {
			r, e := Decode[model.Resource](d.Body)
			if e != nil {
				return e
			}
			resources = append(resources, r)
		}
		resources, e = transactionCandidateIdentities(ctx, tx, resources)
		if e != nil {
			return e
		}
		links := emptyLinkConfig()
		if d, e := q.GetDocument(ctx, sqlgen.GetDocumentParams{Kind: "problem_links", ID: "global"}); e == nil {
			links, e = Decode[model.ProblemLinkConfig](d.Body)
			if e != nil {
				return e
			}
		} else if !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
		seen := map[string]bool{}
		for _, p := range snapshot.Problems {
			p.ID = SourceID(i.ID, p.ExternalID)
			p.IntegrationID = i.ID
			p.LastSeen = now
			p.Stale = false
			p.Status = "firing"
			p.ResolvedAt = nil
			seen[p.ID] = true
			var revision int64
			transition := true
			if d, ok := byID[p.ID]; ok {
				revision = d.Revision
				old, e := Decode[model.Problem](d.Body)
				if e != nil {
					return e
				}
				p.ResourceID = old.ResourceID
				transition = old.Status != "firing" || !old.StartedAt.Equal(p.StartedAt)
			}
			applyLinks(&p, resources, links)
			if _, e = save(ctx, tx, "problem", p.ID, revision, p); e != nil {
				return e
			}
			if e = confirmProblemObservation(ctx, tx, i, p, now); e != nil {
				return e
			}
			if transition {
				if e = record(ctx, tx, "problem.firing", p.Title, p.ResourceID, "system", problemEventDetails(i, p, true), false); e != nil {
					return e
				}
			}
		}
		for id, d := range byID {
			if seen[id] {
				continue
			}
			p, e := Decode[model.Problem](d.Body)
			if e != nil {
				return e
			}
			if p.Status == "resolved" {
				continue
			}
			applyLinks(&p, resources, links)
			p.Status = "resolved"
			p.ResolvedAt = &now
			p.LastSeen = now
			p.Stale = false
			if _, e = save(ctx, tx, "problem", id, d.Revision, p); e != nil {
				return e
			}
			if e = record(ctx, tx, "problem.resolved", "Восстановлено: "+p.Title, p.ResourceID, "system", problemEventDetails(i, p, false), false); e != nil {
				return e
			}
		}
	}
	if e = autoLinkInventory(ctx, tx); e != nil {
		return e
	}
	return tx.Commit(ctx)
}
func (s *Store) Problems(ctx context.Context) ([]model.Problem, error) {
	items, e := List[model.Problem](ctx, s, "problem")
	if e != nil {
		return nil, e
	}
	sources, e := List[model.Integration](ctx, s, "integration")
	if e != nil {
		return nil, e
	}
	settings, e := Get[model.Settings](ctx, s, "settings", "global")
	if e != nil {
		return nil, e
	}
	visibility, e := List[problemVisibility](ctx, s, "problem_visibility")
	if e != nil {
		return nil, e
	}
	visibilityByID := make(map[string]problemVisibility, len(visibility))
	for _, v := range visibility {
		visibilityByID[v.ID] = v
	}
	byID := map[string]model.Integration{}
	for _, i := range sources {
		byID[i.ID] = i
	}
	resources, e := List[model.Resource](ctx, s, "resource")
	if e != nil {
		return nil, e
	}
	resources, e = s.candidateIdentities(ctx, resources)
	if e != nil {
		return nil, e
	}
	links, e := s.LinkConfig(ctx)
	if e != nil {
		return nil, e
	}
	for n := range items {
		applyLinks(&items[n], resources, links)
		applyProblemVisibility(&items[n], visibilityByID[items[n].ID])
		i, ok := byID[items[n].IntegrationID]
		observed := items[n].LastSeen
		if items[n].Status == "resolved" && i.LastSuccess != nil {
			observed = *i.LastSuccess
		}
		items[n].Stale = !ok || !i.Enabled || i.Status != "connected" || i.LastSuccess == nil || time.Since(observed) > time.Duration(settings.StaleAfterSeconds)*time.Second
	}
	return items, nil
}
func (s *Store) ResolveCandidates(ctx context.Context, ids []string, action, resourceID, actor string) ([]model.Candidate, error) {
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(7398218)"); e != nil {
		return nil, e
	}
	out := []model.Candidate{}
	q := sqlgen.New(tx)
	if action == "link" {
		if _, e = q.GetDocument(ctx, sqlgen.GetDocumentParams{Kind: "resource", ID: resourceID}); e != nil {
			return nil, translate(e)
		}
	}
	seen := map[string]bool{}
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		var b []byte
		var rev int64
		e = tx.QueryRow(ctx, "SELECT body,revision FROM documents WHERE kind='candidate' AND id=$1 FOR UPDATE", id).Scan(&b, &rev)
		if e != nil {
			return nil, translate(e)
		}
		c, e := Decode[model.Candidate](b)
		if e != nil {
			return nil, e
		}
		if action == "restore" {
			if c.State != "ignored" {
				return nil, ErrConflict
			}
		} else if c.State != "pending" {
			if c.State == "linked" && action == "add" || c.State == "ignored" && action == "ignore" {
				out = append(out, c)
				continue
			}
			return nil, ErrConflict
		}
		switch action {
		case "restore":
			c.State = "pending"
		case "ignore":
			c.State = "ignored"
		case "add":
			rs, e := q.ListDocuments(ctx, "resource")
			if e != nil {
				return nil, e
			}
			now := time.Now().UTC()
			r := model.Resource{ID: uuid.NewString(), Name: c.Name, URL: c.URL, Type: "Приложение", Aliases: []string{}, Directions: []string{}, Tags: []string{}, Endpoints: []model.Endpoint{}, Links: []model.Endpoint{}, Relations: []model.Relation{}, ExternalIDs: []string{iExternal(c)}, Operations: []string{}, Source: "discovery", Lifecycle: "active", CreatedAt: now, UpdatedAt: now}
			if e = initializeUniqueInventoryResource(ctx, tx, &r, c); e != nil {
				return nil, e
			}
			existing := []model.Resource{}
			for _, d := range rs {
				old, err := Decode[model.Resource](document(d))
				if err != nil {
					return nil, err
				}
				existing = append(existing, old)
			}
			match, ambiguous := existingCandidateHost(r, c, existing)
			if ambiguous {
				return nil, ErrConflict
			}
			if match != nil {
				r = *match
				ext := iExternal(c)
				if !Contains(r.ExternalIDs, ext) {
					r.ExternalIDs = append(r.ExternalIDs, ext)
					r.UpdatedAt = now
					if _, e = save(ctx, tx, "resource", r.ID, r.Revision, r); e != nil {
						return nil, e
					}
				}
			} else {
				for _, old := range existing {
					if r.URL != "" && strings.TrimRight(old.URL, "/") == strings.TrimRight(r.URL, "/") {
						return nil, ErrConflict
					}
				}
				if isHostResource(r) && r.URL == "" && r.Hostname == "" && r.IP == "" {
					return nil, ErrInvalid
				}
				if !isHostResource(r) && r.URL == "" {
					return nil, ErrInvalid
				}
				if _, e = save(ctx, tx, "resource", r.ID, 0, r); e != nil {
					return nil, e
				}
			}
			c.State = "linked"
			c.ResourceID = r.ID
		case "link":
			c.State = "linked"
			c.ResourceID = resourceID
			rDoc, e := q.GetDocument(ctx, sqlgen.GetDocumentParams{Kind: "resource", ID: resourceID})
			if e != nil {
				return nil, e
			}
			r, e := Decode[model.Resource](document(rDoc))
			if e != nil {
				return nil, e
			}
			ext := iExternal(c)
			if !Contains(r.ExternalIDs, ext) {
				r.ExternalIDs = append(r.ExternalIDs, ext)
				r.UpdatedAt = time.Now().UTC()
				if _, e = save(ctx, tx, "resource", r.ID, r.Revision, r); e != nil {
					return nil, e
				}
			}
		default:
			return nil, ErrInvalid
		}
		if _, e = save(ctx, tx, "candidate", id, rev, c); e != nil {
			return nil, e
		}
		out = append(out, c)
		if e = record(ctx, tx, "discovery."+action, "Обработан обнаруженный ресурс", c.ResourceID, actor, map[string]any{"candidate_id": id}, true); e != nil {
			return nil, e
		}
	}
	if e = autoLinkInventory(ctx, tx); e != nil {
		return nil, e
	}
	if e = reindex(ctx, tx); e != nil {
		return nil, e
	}
	if e = tx.Commit(ctx); e != nil {
		return nil, e
	}
	return out, nil
}
func iExternal(c model.Candidate) string { return c.IntegrationID + ":" + c.ExternalID }

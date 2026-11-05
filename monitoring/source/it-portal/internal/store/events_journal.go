package store

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"pl/portal/internal/model"
)

type JournalFilter struct {
	Channel                         string
	From, To                        time.Time
	ResourceID, Source, Type, Actor string
	MonitoringOnly                  bool
	ExcludeCollection               bool
	Snapshot, Cursor                string
	Limit                           int
}
type JournalEvent struct {
	model.Event
	ObjectKind   string    `json:"object_kind,omitempty"`
	ObjectID     string    `json:"object_id,omitempty"`
	ObjectName   string    `json:"object_name,omitempty"`
	Action       string    `json:"action,omitempty"`
	JobKind      string    `json:"job_kind,omitempty"`
	OccurredAt   time.Time `json:"occurred_at"`
	ReceivedAt   time.Time `json:"received_at"`
	TimeBasis    string    `json:"time_basis"`
	Source       string    `json:"source"`
	SourceName   string    `json:"source_name"`
	ResourceName string    `json:"resource_name"`
	EventType    string    `json:"event_type"`
	Severity     string    `json:"severity"`
	Unread       bool      `json:"unread"`
	SourceStale  bool      `json:"source_stale"`
}
type JournalPage struct {
	Items      []JournalEvent `json:"items"`
	Snapshot   string         `json:"snapshot"`
	NextCursor string         `json:"next_cursor"`
	Total      int            `json:"total"`
	NewCount   int            `json:"new_count"`
}
type JournalDetail struct {
	Event       JournalEvent   `json:"event"`
	Related     []JournalEvent `json:"related"`
	Observation map[string]any `json:"observation,omitempty"`
}
type journalCursor struct {
	At       time.Time `json:"at"`
	ID       string    `json:"id"`
	Scope    string    `json:"scope"`
	Snapshot string    `json:"snapshot"`
}
type journalSnapshot struct {
	Value string `json:"value"`
	Scope string `json:"scope"`
}

func journalScope(f JournalFilter) string {
	scope := []any{f.Channel, f.From.UTC(), f.To.UTC(), f.ResourceID, f.Source, f.Type, f.Actor, f.MonitoringOnly}
	if f.ExcludeCollection {
		scope = append(scope, true)
	}
	b, _ := json.Marshal(scope)
	return fmt.Sprintf("%x", sha256.Sum256(b))
}

func journalTable(channel string) (string, error) {
	switch channel {
	case "events":
		return "events", nil
	case "audit":
		return "audit_events", nil
	}
	return "", ErrInvalid
}
func encodeJournalToken(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }

// Validate the full snapshot grammar before it reaches a PostgreSQL cast. These
// are top-level xid8 identities (not xmin/subtransaction IDs), safe across wraparound.
func decodeJournalSnapshot(token string) (string, error) {
	if len(token) > 32768 {
		return "", ErrInvalid
	}
	b, e := base64.RawURLEncoding.DecodeString(token)
	if e != nil {
		return "", ErrInvalid
	}
	p := strings.Split(string(b), ":")
	if len(p) != 3 {
		return "", ErrInvalid
	}
	min, e := strconv.ParseUint(p[0], 10, 64)
	if e != nil {
		return "", ErrInvalid
	}
	max, e := strconv.ParseUint(p[1], 10, 64)
	if e != nil || max < min {
		return "", ErrInvalid
	}
	var prev uint64
	if p[2] != "" {
		for n, v := range strings.Split(p[2], ",") {
			id, e := strconv.ParseUint(v, 10, 64)
			if e != nil || id < min || id >= max || (n > 0 && id <= prev) {
				return "", ErrInvalid
			}
			prev = id
		}
	}
	return string(b), nil
}
func decodeJournalCursor(token string) (journalCursor, error) {
	var v journalCursor
	if len(token) > 65536 {
		return v, ErrInvalid
	}
	b, e := base64.RawURLEncoding.DecodeString(token)
	if e != nil {
		return v, ErrInvalid
	}
	if json.Unmarshal(b, &v) != nil || v.At.IsZero() || len(v.ID) == 0 || len(v.ID) > 128 {
		return v, ErrInvalid
	}
	return v, nil
}
func (s *Store) InitializeJournal(ctx context.Context, user string) error {
	if user == "" {
		return ErrInvalid
	}
	_, e := s.Pool.Exec(ctx, "INSERT INTO event_journal_readers(user_id) VALUES($1) ON CONFLICT DO NOTHING", user)
	return e
}
func (s *Store) MarkJournalSeen(ctx context.Context, user, channel string, ids []string) error {
	table, e := journalTable(channel)
	if e != nil || user == "" || len(ids) > 100 {
		return ErrInvalid
	}
	for _, id := range ids {
		if id == "" || len(id) > 128 {
			return ErrInvalid
		}
	}
	if len(ids) == 0 {
		return nil
	}
	_, e = s.Pool.Exec(ctx, `INSERT INTO event_journal_seen(user_id,channel,event_id)
 SELECT r.user_id,$2,e.id FROM event_journal_readers r CROSS JOIN `+table+` e
 WHERE r.user_id=$1 AND e.id=ANY($3::text[]) ON CONFLICT DO NOTHING`, user, channel, ids)
	return e
}

const journalSourceSQL = `COALESCE(NULLIF(e.body #>> '{details,source_kind}',''),CASE WHEN e.body->>'kind' IN ('problem.firing','problem.resolved') THEN 'alertmanager' ELSE 'platform' END)`
const journalTypeSQL = `CASE
 WHEN e.body->>'kind' IN ('problem.firing','target.down') THEN 'problem'
 WHEN e.body->>'kind' IN ('problem.resolved','target.up') THEN 'recovery'
 WHEN e.body->>'kind' LIKE 'source.%' THEN 'connection'
 WHEN e.body->>'kind' LIKE 'discovery.%' THEN 'discovery'
 WHEN e.body->>'kind' LIKE 'job.%' OR e.body->>'kind' LIKE 'sftp%' THEN 'operation'
 ELSE 'change' END`

func journalWhere(f JournalFilter, args *[]any) string {
	add := func(v any) string { *args = append(*args, v); return fmt.Sprintf("$%d", len(*args)) }
	parts := []string{"true"}
	if !f.From.IsZero() {
		parts = append(parts, "e.occurred_at >= "+add(f.From))
	}
	if !f.To.IsZero() {
		parts = append(parts, "e.occurred_at <= "+add(f.To))
	}
	if f.ResourceID != "" {
		p := add(f.ResourceID)
		resourceMatch := "(e.body->>'resource_id'=" + p + " OR (e.body #> '{details,resource_ids}') ? " + p + ")"
		if f.Channel == "audit" {
			// Legacy resource_id also held IDs of personal/settings documents.
			resourceMatch = "((" + journalObjectKindSQL + ") IN ('resource','job') AND " + resourceMatch + ")"
		}
		parts = append(parts, resourceMatch)
	}
	if f.Source != "" {
		parts = append(parts, journalSourceSQL+"="+add(f.Source))
	}
	if f.Type != "" {
		parts = append(parts, "("+journalTypeSQL+")="+add(f.Type))
	}
	if f.Actor != "" {
		pattern := "%" + strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(f.Actor) + "%"
		p := add(pattern)
		parts = append(parts, "(e.body->>'actor' ILIKE "+p+" OR e.body->>'actor_name' ILIKE "+p+" OR EXISTS(SELECT 1 FROM sessions actor_session WHERE actor_session.user_id=e.body->>'actor' AND actor_session.user_name ILIKE "+p+"))")
	}
	if f.MonitoringOnly {
		parts = append(parts, "e.body->>'kind' IN ('problem.firing','problem.resolved','target.down','target.up')")
	}
	if f.ExcludeCollection && f.Channel == "events" {
		parts = append(parts, "COALESCE(e.body->>'kind','') NOT IN ('target.down','target.up')")
	}
	return strings.Join(parts, " AND ")
}

// Existing event records remain authoritative. Enrichment is read-only and the
// journal never modifies or conflates the original events/audit streams.
func journalSelect(table string) string {
	return `SELECT e.body,e.occurred_at,e.created_at,` + journalSourceSQL + `,` + journalTypeSQL + `,
 COALESCE(r.body->>'name',''),COALESCE(i.body,'{}'::jsonb), COALESCE((settings.body->>'stale_after_seconds')::int,180),
 COALESCE(NULLIF(e.body->>'actor_name',''),(SELECT user_name FROM sessions WHERE user_id=e.body->>'actor' ORDER BY expires_at DESC LIMIT 1),''),
 NOT pg_visible_in_snapshot(e.arrival_tx,u.baseline) AND seen.event_id IS NULL,
 COALESCE(obj.body->>'name',''), COALESCE(job.body,'{}'::jsonb), COALESCE(job_resource.body->>'name',job_integration.body->>'name','')
 FROM ` + table + ` e
 JOIN event_journal_readers u ON u.user_id=$1
 LEFT JOIN event_journal_seen seen ON seen.user_id=$1 AND seen.channel=$2 AND seen.event_id=e.id
 LEFT JOIN documents r ON r.kind='resource' AND r.id=e.body->>'resource_id' AND (` + journalObjectKindSQL + `) IN ('','resource','problem','job')
 LEFT JOIN documents i ON i.kind='integration' AND i.id=e.body #>> '{details,integration_id}'
 LEFT JOIN documents settings ON settings.kind='settings' AND settings.id='global'
 LEFT JOIN documents obj ON obj.kind=(` + journalObjectKindSQL + `) AND obj.id=(` + journalObjectIDSQL + `)
 LEFT JOIN jobs job ON job.id=e.body #>> '{details,job_id}'
 LEFT JOIN documents job_resource ON job_resource.kind='resource' AND job_resource.id=job.body->>'resource_id'
 LEFT JOIN documents job_integration ON job_integration.kind='integration' AND job_integration.id=job.body->>'integration_id'`
}
func detailString(m map[string]any, key string) string { v, _ := m[key].(string); return v }
func scanJournal(rows pgx.Rows) ([]JournalEvent, error) {
	out := []JournalEvent{}
	for rows.Next() {
		var v JournalEvent
		var body, integration, jobBody []byte
		var objectName, jobTargetName string
		var staleAfter int
		var actorName string
		if e := rows.Scan(&body, &v.OccurredAt, &v.ReceivedAt, &v.Source, &v.EventType, &v.ResourceName, &integration, &staleAfter, &actorName, &v.Unread, &objectName, &jobBody, &jobTargetName); e != nil {
			return nil, e
		}
		if e := json.Unmarshal(body, &v.Event); e != nil {
			return nil, e
		}
		if v.ActorName == "" {
			v.ActorName = actorName
		}
		if v.Details == nil {
			v.Details = map[string]any{}
		}
		v.TimeBasis = "observed"
		if detailString(v.Details, "time_basis") == "source" {
			if at, e := time.Parse(time.RFC3339Nano, detailString(v.Details, "occurred_at")); e == nil && at.Equal(v.OccurredAt) {
				v.TimeBasis = "source"
			}
		}
		// Platform records have an exact application timestamp, unlike inferred
		// monitoring transitions observed by a periodic collector.
		if v.Source == "platform" && !strings.HasPrefix(v.Kind, "source.") {
			v.TimeBasis = "source"
		}
		v.SourceName = detailString(v.Details, "source_name")
		if v.SourceName == "" {
			switch v.Source {
			case "prometheus":
				v.SourceName = "Prometheus"
			case "alertmanager":
				v.SourceName = "Alertmanager"
			default:
				v.SourceName = "Платформа"
			}
		}
		v.Severity = detailString(v.Details, "severity")
		v.SourceStale = v.Source == "prometheus" || v.Source == "alertmanager"
		var i model.Integration
		if len(integration) > 2 && json.Unmarshal(integration, &i) == nil {
			v.SourceStale = !i.Enabled || i.Status != "connected" || i.LastSuccess == nil || time.Since(*i.LastSuccess) > time.Duration(staleAfter)*time.Second
		}
		if v.ResourceName == "" {
			v.ResourceName = detailString(v.Details, "resource_name")
			if v.ResourceName == "" {
				v.ResourceName = detailString(v.Details, "target_name")
			}
		}
		v.ObjectKind, v.ObjectID = eventObject(v.Kind, v.ResourceID, v.Details)
		v.Action = eventAction(v.Kind, v.Details)
		v.ObjectName = detailString(v.Details, "object_name")
		if v.ObjectName == "" {
			v.ObjectName = objectName
		}
		if v.ObjectName == "" {
			v.ObjectName = auditObjectLabel(v.ObjectKind)
		}
		if v.ObjectKind == "resource" && v.ObjectName == "" {
			v.ObjectName = v.ResourceName
		}
		if v.ObjectKind == "job" {
			v.JobKind = detailString(v.Details, "job_kind")
			if v.JobKind == "" {
				v.JobKind = detailString(v.Details, "kind")
			}
			var job model.Job
			if json.Unmarshal(jobBody, &job) == nil && v.JobKind == "" {
				v.JobKind = job.Kind
			}
			if v.ObjectName == "" {
				v.ObjectName = jobTargetName
			}
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
func (s *Store) Journal(ctx context.Context, user string, f JournalFilter) (JournalPage, error) {
	out := JournalPage{Items: []JournalEvent{}}
	table, e := journalTable(f.Channel)
	if e != nil {
		return out, e
	}
	if f.Limit == 0 {
		f.Limit = 50
	}
	if f.Limit < 1 || f.Limit > 100 {
		return out, ErrInvalid
	}
	if !f.From.IsZero() && !f.To.IsZero() && f.From.After(f.To) {
		return out, ErrInvalid
	}
	// A snapshot watermark tracks committed arrival transactions. A lower ID
	// allocated by an older, still running transaction cannot get lost on refresh.
	var snapshot string
	scope := journalScope(f)
	if f.Snapshot == "" {
		e = s.Pool.QueryRow(ctx, "SELECT pg_current_snapshot()::text").Scan(&snapshot)
	} else {
		if len(f.Snapshot) > 65536 {
			return out, ErrInvalid
		}
		b, err := base64.RawURLEncoding.DecodeString(f.Snapshot)
		if err != nil {
			return out, ErrInvalid
		}
		var v journalSnapshot
		if json.Unmarshal(b, &v) != nil || v.Scope != scope {
			return out, ErrInvalid
		}
		snapshot, e = decodeJournalSnapshot(v.Value)
	}
	if e != nil {
		return out, e
	}
	token, _ := json.Marshal(journalSnapshot{encodeJournalToken(snapshot), scope})
	out.Snapshot = encodeJournalToken(string(token))
	args := []any{user, f.Channel, snapshot}
	where := journalWhere(f, &args)
	e = s.Pool.QueryRow(ctx, `SELECT count(*) FILTER(WHERE pg_visible_in_snapshot(e.arrival_tx,$3::pg_snapshot)),
 count(*) FILTER(WHERE NOT pg_visible_in_snapshot(e.arrival_tx,$3::pg_snapshot)) FROM `+table+` e JOIN event_journal_readers u ON u.user_id=$1 WHERE $2::text IN ('events','audit') AND `+where, args...).Scan(&out.Total, &out.NewCount)
	if e != nil {
		return out, e
	}
	// Count queries have no user projection but keep parameter numbers consistent.
	// PostgreSQL requires typed parameters even when only used by the projection.
	query := journalSelect(table) + " WHERE " + where + " AND pg_visible_in_snapshot(e.arrival_tx,$3::pg_snapshot)"
	if f.Cursor != "" {
		c, e := decodeJournalCursor(f.Cursor)
		if e != nil {
			return out, e
		}
		if c.Scope != scope || c.Snapshot != out.Snapshot {
			return out, ErrInvalid
		}
		args = append(args, c.At, c.ID)
		query += fmt.Sprintf(" AND (e.occurred_at,e.id)<($%d,$%d)", len(args)-1, len(args))
	}
	args = append(args, f.Limit+1)
	query += fmt.Sprintf(" ORDER BY e.occurred_at DESC,e.id DESC LIMIT $%d", len(args))
	rows, e := s.Pool.Query(ctx, query, args...)
	if e != nil {
		return out, e
	}
	defer rows.Close()
	out.Items, e = scanJournal(rows)
	if e != nil {
		return out, e
	}
	if len(out.Items) > f.Limit {
		out.Items = out.Items[:f.Limit]
		last := out.Items[len(out.Items)-1]
		b, _ := json.Marshal(journalCursor{last.OccurredAt, last.ID, scope, out.Snapshot})
		out.NextCursor = encodeJournalToken(string(b))
	}
	return out, nil
}
func (s *Store) JournalDetail(ctx context.Context, user, channel, id string) (JournalDetail, error) {
	out := JournalDetail{Related: []JournalEvent{}}
	table, e := journalTable(channel)
	if e != nil {
		return out, e
	}
	rows, e := s.Pool.Query(ctx, journalSelect(table)+" WHERE e.id=$3", user, channel, id)
	if e != nil {
		return out, e
	}
	items, e := scanJournal(rows)
	rows.Close()
	if e != nil {
		return out, e
	}
	if len(items) == 0 {
		return out, ErrNotFound
	}
	out.Event = items[0]
	obs := detailString(out.Event.Details, "observation_id")
	if obs != "" {
		b, e := s.Get(ctx, "event_observation", obs)
		if e == nil {
			if e = json.Unmarshal(b, &out.Observation); e != nil {
				return out, e
			}
		} else if !errors.Is(e, ErrNotFound) {
			return out, e
		}
	}
	if channel == "audit" {
		switch out.Event.ObjectKind {
		case "preferences", "dashboard_layout", "workspace_preferences", "chart_settings", "session":
			return out, nil
		}
	}
	if channel == "audit" || out.Event.ObjectKind == "job" {
		if out.Event.ObjectKind == "" || out.Event.ObjectID == "" {
			return out, nil
		}
		rows, err := s.Pool.Query(ctx, journalSelect(table)+" WHERE e.id<>$3 AND ("+journalObjectKindSQL+")=$4 AND ("+journalObjectIDSQL+")=$5 ORDER BY e.occurred_at DESC,e.id DESC LIMIT 20", user, channel, id, out.Event.ObjectKind, out.Event.ObjectID)
		if err != nil {
			return out, err
		}
		defer rows.Close()
		out.Related, err = scanJournal(rows)
		return out, err
	}
	problemID := detailString(out.Event.Details, "problem_id")
	// Related means an explicit common object/problem/observation, never closeness
	// in time or title. Do not merge rows or assume causality from these links.
	rows, e = s.Pool.Query(ctx, journalSelect(table)+` WHERE e.id<>$3 AND
 (($4<>'' AND (e.body->>'resource_id'=$4 OR (e.body #> '{details,resource_ids}') ? $4))
 OR ($5<>'' AND e.body #>> '{details,problem_id}'=$5)
 OR ($6<>'' AND e.body #>> '{details,observation_id}'=$6)
 OR ($7<>'' AND $8<>'' AND e.body #>> '{details,target_id}'=$7 AND e.body #>> '{details,integration_id}'=$8))
 ORDER BY e.occurred_at DESC,e.id DESC LIMIT 20`, user, channel, id, out.Event.ResourceID, problemID, obs, detailString(out.Event.Details, "target_id"), detailString(out.Event.Details, "integration_id"))
	if e != nil {
		return out, e
	}
	defer rows.Close()
	out.Related, e = scanJournal(rows)
	return out, e
}

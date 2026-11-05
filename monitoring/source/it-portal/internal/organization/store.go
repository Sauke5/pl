package organization

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrNotFound      = errors.New("organization_not_found")
	ErrStale         = errors.New("organization_stale")
	ErrConflict      = errors.New("organization_revision_conflict")
	ErrInvalid       = errors.New("organization_invalid")
	ErrInvalidCursor = errors.New("organization_invalid_cursor")
	ErrCursorExpired = errors.New("organization_cursor_expired")
)

const SnapshotLifetime = 15 * time.Minute
const organizationWriterLock = 7398221

type Store struct{ pool *pgxpool.Pool }

func NewStore(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

type ADGroupMapping struct {
	ProviderNamespace string `json:"provider_namespace"`
	ObjectGUID        string `json:"object_guid"`
	DN                string `json:"dn"`
}
type Department struct {
	ID           string           `json:"id"`
	Name         string           `json:"name"`
	Active       bool             `json:"active"`
	Revision     uint64           `json:"revision"`
	ADGroups     []ADGroupMapping `json:"ad_groups"`
	HeadSubjects []string         `json:"head_subjects"`
}
type EmployeeRecord struct {
	Identity          Identity
	Provider          string
	ProviderNamespace string
	ObjectGUID        []byte
}
type EmployeesPage struct {
	Items         []Projection `json:"items"`
	NextCursor    string       `json:"next_cursor"`
	ChangesCursor string       `json:"changes_cursor"`
}
type DepartmentsPage struct {
	Items         []Department `json:"items"`
	NextCursor    string       `json:"next_cursor"`
	ChangesCursor string       `json:"changes_cursor"`
}
type StoredChange struct {
	Cursor string `json:"cursor"`
	ChangeEvent
	Department *Department `json:"department,omitempty"`
}
type ChangesPage struct {
	Items      []StoredChange `json:"items"`
	NextCursor string         `json:"next_cursor"`
}
type cursor struct {
	Kind     string `json:"k"`
	Snapshot string `json:"s,omitempty"`
	After    string `json:"a"`
}

func encodeCursor(c cursor) string {
	b, _ := json.Marshal(c)
	return base64.RawURLEncoding.EncodeToString(b)
}
func decodeCursor(raw, kind string) (cursor, error) {
	var c cursor
	if len(raw) > 1024 {
		return c, ErrInvalidCursor
	}
	b, e := base64.RawURLEncoding.Strict().DecodeString(raw)
	if e != nil {
		return c, ErrInvalidCursor
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if d.Decode(&c) != nil || d.Decode(new(any)) != io.EOF || c.Kind != kind || encodeCursor(c) != raw {
		return c, ErrInvalidCursor
	}
	if kind == "changes" {
		if c.Snapshot != "" {
			return c, ErrInvalidCursor
		}
		n, e := strconv.ParseInt(c.After, 10, 64)
		if e != nil || n < 0 || strconv.FormatInt(n, 10) != c.After {
			return c, ErrInvalidCursor
		}
	} else if _, e := uuid.Parse(c.Snapshot); e != nil {
		return c, ErrInvalidCursor
	}
	return c, nil
}
func changeCursor(n int64) string {
	return encodeCursor(cursor{Kind: "changes", After: strconv.FormatInt(n, 10)})
}
func validLimit(limit int) bool { return limit >= 1 && limit <= 100 }
func validText(s string) bool {
	return strings.TrimSpace(s) != "" && len(s) <= 256 && !strings.ContainsAny(s, "\x00\r\n")
}
func validNamespace(ns string) bool {
	b, e := hex.DecodeString(ns)
	return e == nil && len(b) == 8 && strings.ToLower(ns) == ns
}

func (s *Store) Lookup(ctx context.Context, subject string, now time.Time) (Projection, error) {
	var body []byte
	err := s.pool.QueryRow(ctx, "SELECT body FROM org_employees WHERE subject=$1", subject).Scan(&body)
	if errors.Is(err, pgx.ErrNoRows) {
		return Projection{}, ErrNotFound
	}
	if err != nil {
		return Projection{}, err
	}
	var identity Identity
	if err = json.Unmarshal(body, &identity); err != nil {
		return Projection{}, err
	}
	p := Project(identity, now, DefaultMaxFreshness)
	if !p.Fresh {
		return p, ErrStale
	}
	return p, nil
}

func beginWrite(ctx context.Context, pool *pgxpool.Pool) (pgx.Tx, error) {
	tx, e := pool.Begin(ctx)
	if e != nil {
		return nil, e
	}
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", organizationWriterLock); e != nil {
		tx.Rollback(ctx)
		return nil, e
	}
	return tx, nil
}
func readEmployee(ctx context.Context, tx pgx.Tx, subject string) (EmployeeRecord, error) {
	var r EmployeeRecord
	var body []byte
	e := tx.QueryRow(ctx, "SELECT provider,provider_namespace,object_guid,body FROM org_employees WHERE subject=$1", subject).Scan(&r.Provider, &r.ProviderNamespace, &r.ObjectGUID, &body)
	if errors.Is(e, pgx.ErrNoRows) {
		return r, ErrNotFound
	}
	if e != nil {
		return r, e
	}
	e = json.Unmarshal(body, &r.Identity)
	return r, e
}

// SaveEmployee persists one confirmed fact snapshot. expectedRevision=0 creates
// an employee; updates preserve provider/namespace/GUID and explicit selections.
// Head assignments are managed by SaveDepartment, never by the AD adapter.
func (s *Store) SaveEmployee(ctx context.Context, r EmployeeRecord, expectedRevision uint64, actor string, now time.Time) (Identity, error) {
	if !validText(actor) || !validText(r.Identity.Subject) || !validText(r.Identity.Name) || r.Provider != "ad" || !validNamespace(r.ProviderNamespace) || len(r.ObjectGUID) != 16 || now.IsZero() || r.Identity.LastSuccessAt.IsZero() || r.Identity.LastSuccessAt.After(now) {
		return Identity{}, ErrInvalid
	}
	if r.Identity.Subject != "ad:"+r.ProviderNamespace+":"+hex.EncodeToString(r.ObjectGUID) {
		return Identity{}, ErrInvalid
	}
	tx, e := beginWrite(ctx, s.pool)
	if e != nil {
		return Identity{}, e
	}
	defer tx.Rollback(ctx)
	old, e := readEmployee(ctx, tx, r.Identity.Subject)
	var previous *Identity
	if e == nil {
		if old.Identity.Revision != expectedRevision || old.Provider != r.Provider || old.ProviderNamespace != r.ProviderNamespace || !bytes.Equal(old.ObjectGUID, r.ObjectGUID) {
			return Identity{}, ErrConflict
		}
		if r.Identity.LastSuccessAt.Before(old.Identity.LastSuccessAt) {
			return Identity{}, ErrConflict
		}
		previous = &old.Identity
		r.Identity.Department.ExplicitSelection = old.Identity.Department.ExplicitSelection
		r.Identity.HeadDepartmentIDs = old.Identity.HeadDepartmentIDs
	} else if !errors.Is(e, ErrNotFound) {
		return Identity{}, e
	} else if expectedRevision != 0 {
		return Identity{}, ErrConflict
	} else {
		r.Identity.HeadDepartmentIDs = nil
		r.Identity.Department.ExplicitSelection = nil
	}
	for _, id := range canonicalIDs(r.Identity.Department.CandidateIDs) {
		var active bool
		e = tx.QueryRow(ctx, "SELECT active FROM org_departments WHERE id=$1", id).Scan(&active)
		if e != nil || !active {
			if e != nil && !errors.Is(e, pgx.ErrNoRows) {
				return Identity{}, e
			}
			return Identity{}, ErrInvalid
		}
	}
	next, e := persistEmployee(ctx, tx, r, previous, actor, now)
	if e != nil {
		return Identity{}, e
	}
	if e = tx.Commit(ctx); e != nil {
		return Identity{}, e
	}
	return next, nil
}

func persistEmployee(ctx context.Context, tx pgx.Tx, r EmployeeRecord, previous *Identity, actor string, now time.Time) (Identity, error) {
	next, event, e := PrepareChange(previous, r.Identity, uuid.NewString(), now)
	if e != nil {
		return Identity{}, e
	}
	if next.Revision > math.MaxInt64 {
		return Identity{}, ErrInvalid
	}
	body, e := json.Marshal(next)
	if e != nil {
		return Identity{}, e
	}
	_, e = tx.Exec(ctx, `INSERT INTO org_employees(subject,provider,provider_namespace,object_guid,revision,body) VALUES($1,$2,$3,$4,$5,$6)
 ON CONFLICT(subject) DO UPDATE SET revision=excluded.revision,body=excluded.body`, next.Subject, r.Provider, r.ProviderNamespace, r.ObjectGUID, int64(next.Revision), body)
	if e != nil {
		return Identity{}, e
	}
	// Delete selection first because it references candidate membership.
	for _, table := range []string{"org_primary_selections", "org_employee_candidates", "org_department_heads"} {
		if _, e = tx.Exec(ctx, "DELETE FROM "+table+" WHERE subject=$1", next.Subject); e != nil {
			return Identity{}, e
		}
	}
	for _, id := range next.Department.CandidateIDs {
		if _, e = tx.Exec(ctx, "INSERT INTO org_employee_candidates(subject,department_id) VALUES($1,$2)", next.Subject, id); e != nil {
			return Identity{}, e
		}
	}
	if choice := next.Department.ExplicitSelection; choice != nil {
		if _, e = tx.Exec(ctx, "INSERT INTO org_primary_selections(subject,department_id,selected_by) VALUES($1,$2,$3)", next.Subject, choice.DepartmentID, choice.SelectedBy); e != nil {
			return Identity{}, e
		}
	}
	for _, id := range next.HeadDepartmentIDs {
		if _, e = tx.Exec(ctx, "INSERT INTO org_department_heads(department_id,subject) VALUES($1,$2)", id, next.Subject); e != nil {
			return Identity{}, e
		}
	}
	if event != nil {
		b, e := json.Marshal(event)
		if e != nil {
			return Identity{}, e
		}
		if e = appendEvent(ctx, tx, event.EventID, b, actor, now); e != nil {
			return Identity{}, e
		}
	}
	return next, nil
}
func appendEvent(ctx context.Context, tx pgx.Tx, id string, body []byte, actor string, now time.Time) error {
	if _, e := tx.Exec(ctx, "INSERT INTO org_outbox(event_id,body,created_at) VALUES($1,$2,$3)", id, body, now); e != nil {
		return e
	}
	_, e := tx.Exec(ctx, "INSERT INTO org_audit(event_id,actor,body,created_at) VALUES($1,$2,$3,$4)", id, actor, body, now)
	return e
}

func (s *Store) SelectPrimary(ctx context.Context, subject, department, actor string, expectedRevision uint64, now time.Time) (Identity, error) {
	if !validText(actor) || now.IsZero() {
		return Identity{}, ErrInvalid
	}
	tx, e := beginWrite(ctx, s.pool)
	if e != nil {
		return Identity{}, e
	}
	defer tx.Rollback(ctx)
	r, e := readEmployee(ctx, tx, subject)
	if e != nil {
		return Identity{}, e
	}
	if r.Identity.Revision != expectedRevision {
		return Identity{}, ErrConflict
	}
	if !Project(r.Identity, now, DefaultMaxFreshness).Fresh {
		return Identity{}, ErrStale
	}
	previous := r.Identity
	resolution, e := SelectPrimary(r.Identity.Department.CandidateIDs, department, actor)
	if e != nil {
		return Identity{}, ErrInvalid
	}
	r.Identity.Department = resolution
	next, e := persistEmployee(ctx, tx, r, &previous, actor, now)
	if e != nil {
		return Identity{}, e
	}
	if e = tx.Commit(ctx); e != nil {
		return Identity{}, e
	}
	return next, nil
}

func loadDepartment(ctx context.Context, tx pgx.Tx, id string) (Department, error) {
	d := Department{ADGroups: []ADGroupMapping{}, HeadSubjects: []string{}}
	var revision int64
	e := tx.QueryRow(ctx, "SELECT id,name,active,revision FROM org_departments WHERE id=$1", id).Scan(&d.ID, &d.Name, &d.Active, &revision)
	if errors.Is(e, pgx.ErrNoRows) {
		return d, ErrNotFound
	}
	if e != nil {
		return d, e
	}
	d.Revision = uint64(revision)
	rows, e := tx.Query(ctx, "SELECT provider_namespace,encode(object_guid,'hex'),dn FROM org_department_groups WHERE department_id=$1 ORDER BY provider_namespace,object_guid", id)
	if e != nil {
		return d, e
	}
	for rows.Next() {
		var g ADGroupMapping
		if e = rows.Scan(&g.ProviderNamespace, &g.ObjectGUID, &g.DN); e != nil {
			rows.Close()
			return d, e
		}
		d.ADGroups = append(d.ADGroups, g)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return d, e
	}
	rows, e = tx.Query(ctx, "SELECT subject FROM org_department_heads WHERE department_id=$1 ORDER BY subject", id)
	if e != nil {
		return d, e
	}
	defer rows.Close()
	for rows.Next() {
		var sub string
		if e = rows.Scan(&sub); e != nil {
			return d, e
		}
		d.HeadSubjects = append(d.HeadSubjects, sub)
	}
	return d, rows.Err()
}

// SaveDepartment updates metadata and independent heads atomically. Changing
// AD bindings or disabling the department revokes its old candidate grants;
// subsequent confirmed AD observations may establish membership again.
func (s *Store) SaveDepartment(ctx context.Context, d Department, expectedRevision uint64, actor string, now time.Time) (Department, error) {
	if !validText(d.ID) || !validText(d.Name) || !validText(actor) || now.IsZero() {
		return Department{}, ErrInvalid
	}
	d.HeadSubjects = canonicalIDs(d.HeadSubjects)
	if d.ADGroups == nil {
		d.ADGroups = []ADGroupMapping{}
	}
	keys := map[string]bool{}
	for _, g := range d.ADGroups {
		b, e := hex.DecodeString(g.ObjectGUID)
		key := g.ProviderNamespace + ":" + g.ObjectGUID
		if !validNamespace(g.ProviderNamespace) || e != nil || len(b) != 16 || strings.ToLower(g.ObjectGUID) != g.ObjectGUID || strings.TrimSpace(g.DN) == "" || len(g.DN) > 2048 || strings.ContainsAny(g.DN, "\x00\r\n") || keys[key] {
			return Department{}, ErrInvalid
		}
		keys[key] = true
	}
	// Preserve deterministic mapping order, independent of a caller's list order.
	sortGroups(d.ADGroups)
	tx, e := beginWrite(ctx, s.pool)
	if e != nil {
		return Department{}, e
	}
	defer tx.Rollback(ctx)
	old, e := loadDepartment(ctx, tx, d.ID)
	if e == nil {
		if old.Revision != expectedRevision {
			return Department{}, ErrConflict
		}
		d.Revision = old.Revision + 1
	} else if !errors.Is(e, ErrNotFound) {
		return Department{}, e
	} else if expectedRevision != 0 {
		return Department{}, ErrConflict
	} else {
		d.Revision = 1
	}
	if d.Revision > math.MaxInt64 {
		return Department{}, ErrInvalid
	}
	if !d.Active && len(d.HeadSubjects) > 0 {
		return Department{}, ErrInvalid
	}
	for _, sub := range d.HeadSubjects {
		if _, e = readEmployee(ctx, tx, sub); e != nil {
			return Department{}, e
		}
	}
	revoke := old.ID != "" && (!d.Active || !sameGroupBindings(old.ADGroups, d.ADGroups))
	rows, e := tx.Query(ctx, `SELECT subject FROM org_department_heads WHERE department_id=$1 UNION SELECT subject FROM org_employee_candidates WHERE department_id=$1`, d.ID)
	if e != nil {
		return Department{}, e
	}
	affected := map[string]bool{}
	for rows.Next() {
		var sub string
		if e = rows.Scan(&sub); e != nil {
			rows.Close()
			return Department{}, e
		}
		affected[sub] = true
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return Department{}, e
	}
	for _, sub := range d.HeadSubjects {
		affected[sub] = true
	}
	if _, e = tx.Exec(ctx, `INSERT INTO org_departments(id,name,active,revision) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET name=excluded.name,active=excluded.active,revision=excluded.revision`, d.ID, d.Name, d.Active, int64(d.Revision)); e != nil {
		return Department{}, e
	}
	if _, e = tx.Exec(ctx, "DELETE FROM org_department_groups WHERE department_id=$1", d.ID); e != nil {
		return Department{}, e
	}
	for _, g := range d.ADGroups {
		b, _ := hex.DecodeString(g.ObjectGUID)
		if _, e = tx.Exec(ctx, "INSERT INTO org_department_groups(department_id,provider_namespace,object_guid,dn) VALUES($1,$2,$3,$4)", d.ID, g.ProviderNamespace, b, g.DN); e != nil {
			return Department{}, e
		}
	}
	heads := map[string]bool{}
	for _, sub := range d.HeadSubjects {
		heads[sub] = true
	}
	for sub := range affected {
		r, e := readEmployee(ctx, tx, sub)
		if e != nil {
			return Department{}, e
		}
		previous := r.Identity
		r.Identity.HeadDepartmentIDs = without(r.Identity.HeadDepartmentIDs, d.ID)
		if heads[sub] {
			r.Identity.HeadDepartmentIDs = append(r.Identity.HeadDepartmentIDs, d.ID)
		}
		if revoke {
			r.Identity.Department.CandidateIDs = without(r.Identity.Department.CandidateIDs, d.ID)
		}
		if _, e = persistEmployee(ctx, tx, r, &previous, actor, now); e != nil {
			return Department{}, e
		}
	}
	// Department changes have their own outbox event, separate from employee revs.
	id := uuid.NewString()
	b, e := json.Marshal(map[string]any{"event_id": id, "type": "department.changed", "occurred_at": now, "department": d})
	if e != nil {
		return Department{}, e
	}
	if e = appendEvent(ctx, tx, id, b, actor, now); e != nil {
		return Department{}, e
	}
	if e = tx.Commit(ctx); e != nil {
		return Department{}, e
	}
	return d, nil
}
func without(ids []string, id string) []string {
	out := []string{}
	for _, v := range ids {
		if v != id {
			out = append(out, v)
		}
	}
	return out
}
func sortGroups(groups []ADGroupMapping) {
	sort.Slice(groups, func(i, j int) bool {
		a, b := groups[i], groups[j]
		return a.ProviderNamespace+":"+a.ObjectGUID < b.ProviderNamespace+":"+b.ObjectGUID
	})
}

// DN is a mutable locator. Renaming a group preserves its objectGUID binding
// and must not revoke confirmed membership as though it were a different group.
func sameGroupBindings(a, b []ADGroupMapping) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].ProviderNamespace != b[i].ProviderNamespace || a[i].ObjectGUID != b[i].ObjectGUID {
			return false
		}
	}
	return true
}

// snapshotPage captures immutable fact snapshots and an outbox watermark while
// holding the same writer lock as mutations. Following pages remain stable
// during concurrent changes; consumers replay changes after the watermark.
func (s *Store) snapshotPage(ctx context.Context, kind, raw string, limit int, now time.Time) ([][]byte, string, string, error) {
	if !validLimit(limit) || now.IsZero() {
		return nil, "", "", ErrInvalid
	}
	tx, e := beginWrite(ctx, s.pool)
	if e != nil {
		return nil, "", "", e
	}
	defer tx.Rollback(ctx)
	var c cursor
	var watermark int64
	if raw == "" {
		c = cursor{Kind: kind, Snapshot: uuid.NewString()}
		// Only expired snapshots are disposable; outbox history is not pruned here.
		if _, e = tx.Exec(ctx, `DELETE FROM org_snapshots WHERE id IN
 (SELECT id FROM org_snapshots WHERE expires_at<=$1 ORDER BY expires_at,id LIMIT 100)`, now); e != nil {
			return nil, "", "", e
		}
		if e = tx.QueryRow(ctx, "SELECT COALESCE(max(sequence),0) FROM org_outbox").Scan(&watermark); e != nil {
			return nil, "", "", e
		}
		if _, e = tx.Exec(ctx, "INSERT INTO org_snapshots(id,kind,watermark,expires_at) VALUES($1,$2,$3,$4)", c.Snapshot, kind, watermark, now.Add(SnapshotLifetime)); e != nil {
			return nil, "", "", e
		}
		if kind == "employees" {
			_, e = tx.Exec(ctx, "INSERT INTO org_snapshot_items(snapshot_id,item_key,body) SELECT $1,subject,body FROM org_employees", c.Snapshot)
		} else {
			rows, err := tx.Query(ctx, "SELECT id FROM org_departments ORDER BY id")
			if err != nil {
				return nil, "", "", err
			}
			ids := []string{}
			for rows.Next() {
				var id string
				if err = rows.Scan(&id); err != nil {
					rows.Close()
					return nil, "", "", err
				}
				ids = append(ids, id)
			}
			err = rows.Err()
			rows.Close()
			if err != nil {
				return nil, "", "", err
			}
			for _, id := range ids {
				d, err := loadDepartment(ctx, tx, id)
				if err != nil {
					return nil, "", "", err
				}
				b, err := json.Marshal(d)
				if err != nil {
					return nil, "", "", err
				}
				if _, err = tx.Exec(ctx, "INSERT INTO org_snapshot_items(snapshot_id,item_key,body) VALUES($1,$2,$3)", c.Snapshot, id, b); err != nil {
					return nil, "", "", err
				}
			}
		}
		if e != nil {
			return nil, "", "", e
		}
	} else {
		c, e = decodeCursor(raw, kind)
		if e != nil {
			return nil, "", "", e
		}
		var storedKind string
		var expiry time.Time
		e = tx.QueryRow(ctx, "SELECT kind,watermark,expires_at FROM org_snapshots WHERE id=$1", c.Snapshot).Scan(&storedKind, &watermark, &expiry)
		if errors.Is(e, pgx.ErrNoRows) {
			return nil, "", "", ErrCursorExpired
		}
		if e != nil {
			return nil, "", "", e
		}
		if storedKind != kind {
			return nil, "", "", ErrInvalidCursor
		}
		if !now.Before(expiry) {
			return nil, "", "", ErrCursorExpired
		}
		if c.After != "" {
			var exists bool
			if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM org_snapshot_items WHERE snapshot_id=$1 AND item_key=$2)", c.Snapshot, c.After).Scan(&exists); e != nil {
				return nil, "", "", e
			}
			if !exists {
				return nil, "", "", ErrInvalidCursor
			}
		}
	}
	rows, e := tx.Query(ctx, "SELECT item_key,body FROM org_snapshot_items WHERE snapshot_id=$1 AND item_key>$2 ORDER BY item_key LIMIT $3", c.Snapshot, c.After, limit+1)
	if e != nil {
		return nil, "", "", e
	}
	bodies := [][]byte{}
	keys := []string{}
	for rows.Next() {
		var key string
		var body []byte
		if e = rows.Scan(&key, &body); e != nil {
			rows.Close()
			return nil, "", "", e
		}
		keys = append(keys, key)
		bodies = append(bodies, body)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, "", "", e
	}
	next := ""
	if len(bodies) > limit {
		bodies = bodies[:limit]
		c.After = keys[limit-1]
		next = encodeCursor(c)
	}
	if e = tx.Commit(ctx); e != nil {
		return nil, "", "", e
	}
	return bodies, next, changeCursor(watermark), nil
}
func (s *Store) ListEmployees(ctx context.Context, cursor string, limit int, now time.Time) (EmployeesPage, error) {
	p := EmployeesPage{Items: []Projection{}}
	bodies, next, changes, e := s.snapshotPage(ctx, "employees", cursor, limit, now)
	if e != nil {
		return p, e
	}
	p.NextCursor = next
	p.ChangesCursor = changes
	for _, body := range bodies {
		var identity Identity
		if e = json.Unmarshal(body, &identity); e != nil {
			return p, e
		}
		p.Items = append(p.Items, Project(identity, now, DefaultMaxFreshness))
	}
	return p, nil
}
func (s *Store) ListDepartments(ctx context.Context, cursor string, limit int) (DepartmentsPage, error) {
	return s.listDepartmentsAt(ctx, cursor, limit, time.Now().UTC())
}
func (s *Store) listDepartmentsAt(ctx context.Context, cursor string, limit int, now time.Time) (DepartmentsPage, error) {
	p := DepartmentsPage{Items: []Department{}}
	bodies, next, changes, e := s.snapshotPage(ctx, "departments", cursor, limit, now)
	if e != nil {
		return p, e
	}
	p.NextCursor = next
	p.ChangesCursor = changes
	for _, body := range bodies {
		var d Department
		if e = json.Unmarshal(body, &d); e != nil {
			return p, e
		}
		p.Items = append(p.Items, d)
	}
	return p, nil
}
func (s *Store) Changes(ctx context.Context, after string, limit int) (ChangesPage, error) {
	p := ChangesPage{Items: []StoredChange{}}
	if !validLimit(limit) {
		return p, ErrInvalid
	}
	var sequence int64
	if after != "" {
		c, e := decodeCursor(after, "changes")
		if e != nil {
			return p, e
		}
		sequence, _ = strconv.ParseInt(c.After, 10, 64)
	}
	// Serialize with writers so the high-water mark and returned rows describe a
	// single committed prefix. No sequence allocated by an uncommitted writer can
	// later appear below a cursor already returned by this reader.
	tx, e := beginWrite(ctx, s.pool)
	if e != nil {
		return p, e
	}
	defer tx.Rollback(ctx)
	var floor, max int64
	e = tx.QueryRow(ctx, "SELECT retained_after FROM org_cursor_state WHERE singleton").Scan(&floor)
	if e != nil {
		return p, e
	}
	e = tx.QueryRow(ctx, "SELECT GREATEST($1,COALESCE(max(sequence),0)) FROM org_outbox", floor).Scan(&max)
	if e != nil {
		return p, e
	}
	if sequence < floor {
		return p, ErrCursorExpired
	}
	if sequence > max {
		return p, ErrInvalidCursor
	}
	rows, e := tx.Query(ctx, "SELECT sequence,body FROM org_outbox WHERE sequence>$1 ORDER BY sequence LIMIT $2", sequence, limit)
	if e != nil {
		return p, e
	}
	for rows.Next() {
		var seq int64
		var body []byte
		if e = rows.Scan(&seq, &body); e != nil {
			rows.Close()
			return p, e
		}
		var item StoredChange
		if e = json.Unmarshal(body, &item); e != nil {
			rows.Close()
			return p, e
		}
		item.Cursor = changeCursor(seq)
		p.Items = append(p.Items, item)
		sequence = seq
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return p, e
	}
	p.NextCursor = changeCursor(sequence)
	if e = tx.Commit(ctx); e != nil {
		return p, e
	}
	return p, nil
}

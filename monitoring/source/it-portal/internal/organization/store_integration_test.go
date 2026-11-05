package organization

import (
	"context"
	"encoding/hex"
	"errors"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	portalstore "pl/portal/internal/store"
)

// Each test owns a random schema in a dedicated disposable test database.
func organizationTestStore(t *testing.T) *Store {
	t.Helper()
	dsn := os.Getenv("PORTAL_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("PORTAL_TEST_DATABASE_URL required")
	}
	ctx := context.Background()
	admin, e := pgx.Connect(ctx, dsn)
	if e != nil {
		t.Fatal(e)
	}
	// Extensions are database-wide. Install into public before switching to a
	// disposable schema, otherwise its cleanup can remove pg_trgm for other suites.
	if e = func() error {
		tx, err := admin.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(7398215)"); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, "CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public"); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}(); e != nil {
		admin.Close(ctx)
		t.Fatal(e)
	}
	schema := "organization_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, e = admin.Exec(ctx, "CREATE SCHEMA "+quoted); e != nil {
		admin.Close(ctx)
		t.Fatal(e)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA "+quoted+" CASCADE")
		admin.Close(context.Background())
	})
	u, e := url.Parse(dsn)
	if e != nil {
		t.Fatal(e)
	}
	q := u.Query()
	q.Set("search_path", schema+",public")
	u.RawQuery = q.Encode()
	base, e := portalstore.Open(ctx, u.String())
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(base.Pool.Close)
	return NewStore(base.Pool)
}
func saveDepartmentFixture(t *testing.T, s *Store, id string, now time.Time) Department {
	t.Helper()
	d, e := s.SaveDepartment(context.Background(), Department{ID: id, Name: id, Active: true}, 0, "fixture-admin", now)
	if e != nil {
		t.Fatal(e)
	}
	return d
}
func employeeFixture(n byte, departments []string, now time.Time) EmployeeRecord {
	guid := make([]byte, 16)
	guid[15] = n
	namespace := "0123456789abcdef"
	return EmployeeRecord{Provider: "ad", ProviderNamespace: namespace, ObjectGUID: guid, Identity: Identity{Subject: "ad:" + namespace + ":" + hex.EncodeToString(guid), Name: "Сотрудник", AccountState: Active, LastSuccessAt: now, Department: ResolveDepartment(departments, nil)}}
}
func saveEmployeeFixture(t *testing.T, s *Store, n byte, departments []string, now time.Time) Identity {
	t.Helper()
	i, e := s.SaveEmployee(context.Background(), employeeFixture(n, departments, now), 0, "fixture-sync", now)
	if e != nil {
		t.Fatal(e)
	}
	return i
}

func TestOrganizationPersistenceAndAtomicRevision(t *testing.T) {
	s := organizationTestStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	saveDepartmentFixture(t, s, "it", now)
	saveDepartmentFixture(t, s, "hr", now)
	old := saveEmployeeFixture(t, s, 1, []string{"hr", "it"}, now)
	if old.Department.State != Ambiguous || old.Department.PrimaryDepartmentID != nil {
		t.Fatal(old)
	}
	next, e := s.SelectPrimary(ctx, old.Subject, "it", "admin", old.Revision, now)
	if e != nil || next.Revision != 2 {
		t.Fatal(next, e)
	}
	record := employeeFixture(1, []string{"hr", "it"}, now.Add(time.Second))
	refreshed, e := s.SaveEmployee(ctx, record, next.Revision, "sync", now.Add(time.Second))
	if e != nil || refreshed.Revision != 2 || refreshed.Department.ExplicitSelection == nil {
		t.Fatal(refreshed, e)
	}
	record.Identity.Department = ResolveDepartment([]string{"hr"}, nil)
	moved, e := s.SaveEmployee(ctx, record, refreshed.Revision, "sync", now.Add(time.Second))
	if e != nil || moved.Revision != 3 || *moved.Department.PrimaryDepartmentID != "hr" || moved.Department.ExplicitSelection != nil {
		t.Fatal(moved, e)
	}
	if _, e = s.SaveEmployee(ctx, record, 2, "sync", now.Add(time.Second)); !errors.Is(e, ErrConflict) {
		t.Fatal("lost optimistic check", e)
	}
	p, e := s.Lookup(ctx, old.Subject, now.Add(time.Minute))
	if e != nil || p.Revision != 3 || !p.AccessAllowed {
		t.Fatal(p, e)
	}
	if _, e = s.Lookup(ctx, "unknown", now); !errors.Is(e, ErrNotFound) {
		t.Fatal(e)
	}
	stale, e := s.Lookup(ctx, old.Subject, now.Add(3*time.Hour))
	if !errors.Is(e, ErrStale) || stale.AccountState != Active || stale.AccessAllowed {
		t.Fatal(stale, e)
	}
	var events, audit int
	if e = s.pool.QueryRow(ctx, "SELECT count(*) FROM org_outbox").Scan(&events); e != nil {
		t.Fatal(e)
	}
	if e = s.pool.QueryRow(ctx, "SELECT count(*) FROM org_audit").Scan(&audit); e != nil || events != audit || events != 5 {
		t.Fatal(events, audit, e)
	}
	// A failure after employee mutation (outbox insert) rolls back the aggregate,
	// candidate relations, revision and audit together.
	if _, e = s.pool.Exec(ctx, "ALTER TABLE org_outbox ADD CONSTRAINT fixture_reject CHECK(false) NOT VALID"); e != nil {
		t.Fatal(e)
	}
	record.Identity.AccountState = Disabled
	if _, e = s.SaveEmployee(ctx, record, 3, "sync", now.Add(time.Second)); e == nil {
		t.Fatal("outbox failure accepted")
	}
	p, e = s.Lookup(ctx, old.Subject, now.Add(time.Minute))
	if e != nil || p.AccountState != Active || p.Revision != 3 {
		t.Fatal("partial transaction", p, e)
	}
}

func TestOrganizationDepartmentHeadsAndMappingRevocation(t *testing.T) {
	s := organizationTestStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	d := saveDepartmentFixture(t, s, "it", now)
	i := saveEmployeeFixture(t, s, 1, []string{"it"}, now)
	d.HeadSubjects = []string{i.Subject}
	d, e := s.SaveDepartment(ctx, d, d.Revision, "admin", now)
	if e != nil {
		t.Fatal(e)
	}
	p, e := s.Lookup(ctx, i.Subject, now)
	if e != nil || p.Revision != 2 || len(p.HeadDepartmentIDs) != 1 {
		t.Fatal(p, e)
	}
	d.ADGroups = []ADGroupMapping{{ProviderNamespace: "0123456789abcdef", ObjectGUID: "00000000000000000000000000000001", DN: "CN=IT,DC=test"}}
	d, e = s.SaveDepartment(ctx, d, d.Revision, "admin", now)
	if e != nil {
		t.Fatal(e)
	}
	p, e = s.Lookup(ctx, i.Subject, now)
	if e != nil || p.Department.State != Unassigned || p.DepartmentEligible || len(p.HeadDepartmentIDs) != 1 {
		t.Fatal(p, e)
	}
	// AD does not own head assignments, even when a refresh supplies others.
	record := employeeFixture(1, []string{"it"}, now.Add(time.Second))
	record.Identity.HeadDepartmentIDs = []string{"forged"}
	updated, e := s.SaveEmployee(ctx, record, p.Revision, "sync", now.Add(time.Second))
	if e != nil || len(updated.HeadDepartmentIDs) != 1 || updated.HeadDepartmentIDs[0] != "it" {
		t.Fatal(updated, e)
	}
	d.ADGroups[0].DN = "CN=Renamed IT,DC=test"
	d, e = s.SaveDepartment(ctx, d, d.Revision, "admin", now.Add(time.Second))
	if e != nil {
		t.Fatal(e)
	}
	p, e = s.Lookup(ctx, i.Subject, now.Add(time.Second))
	if e != nil || !p.DepartmentEligible || p.Revision != updated.Revision {
		t.Fatal("group DN rename revoked stable GUID membership", p, e)
	}
	d.Active = false
	d.HeadSubjects = nil
	if _, e = s.SaveDepartment(ctx, d, d.Revision, "admin", now.Add(time.Second)); e != nil {
		t.Fatal(e)
	}
	p, e = s.Lookup(ctx, i.Subject, now.Add(time.Second))
	if e != nil || len(p.HeadDepartmentIDs) != 0 || p.DepartmentEligible {
		t.Fatal(p, e)
	}
	page, e := s.ListDepartments(ctx, "", 10)
	if e != nil || len(page.Items) != 1 || page.Items[0].Active {
		t.Fatal(page, e)
	}
}

func TestOrganizationExpiredSnapshotCacheCleanup(t *testing.T) {
	s := organizationTestStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	saveDepartmentFixture(t, s, "it", now)
	saveEmployeeFixture(t, s, 1, []string{"it"}, now)
	saveEmployeeFixture(t, s, 2, []string{"it"}, now)
	expired, e := s.ListEmployees(ctx, "", 1, now)
	if e != nil {
		t.Fatal(e)
	}
	active, e := s.ListEmployees(ctx, "", 1, now.Add(14*time.Minute))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.ListEmployees(ctx, "", 1, now.Add(16*time.Minute)); e != nil {
		t.Fatal(e)
	}
	if _, e = s.ListEmployees(ctx, expired.NextCursor, 1, now.Add(16*time.Minute)); !errors.Is(e, ErrCursorExpired) {
		t.Fatal(e)
	}
	if p, err := s.ListEmployees(ctx, active.NextCursor, 1, now.Add(16*time.Minute)); err != nil || len(p.Items) != 1 {
		t.Fatal("active snapshot was removed", p, err)
	}
	var snapshots, items, events, audit int
	if e = s.pool.QueryRow(ctx, "SELECT (SELECT count(*) FROM org_snapshots),(SELECT count(*) FROM org_snapshot_items),(SELECT count(*) FROM org_outbox),(SELECT count(*) FROM org_audit)").Scan(&snapshots, &items, &events, &audit); e != nil {
		t.Fatal(e)
	}
	if snapshots != 2 || items != 4 || events != 3 || audit != 3 {
		t.Fatal(snapshots, items, events, audit)
	}
	if _, e = s.pool.Exec(ctx, `INSERT INTO org_snapshots(id,kind,watermark,expires_at)
 SELECT gen_random_uuid(),'employees',0,$1 FROM generate_series(1,101)`, now.Add(-time.Hour)); e != nil {
		t.Fatal(e)
	}
	if _, e = s.ListEmployees(ctx, "", 1, now.Add(16*time.Minute)); e != nil {
		t.Fatal(e)
	}
	var remaining int
	if e = s.pool.QueryRow(ctx, "SELECT count(*) FROM org_snapshots WHERE expires_at<=$1", now.Add(16*time.Minute)).Scan(&remaining); e != nil || remaining != 1 {
		t.Fatal("cache cleanup must remove at most 100 snapshots", remaining, e)
	}
}

func TestOrganizationStableSnapshotAndChangesCursor(t *testing.T) {
	s := organizationTestStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	saveDepartmentFixture(t, s, "it", now)
	first := saveEmployeeFixture(t, s, 1, []string{"it"}, now)
	second := saveEmployeeFixture(t, s, 2, []string{"it"}, now)
	page, e := s.ListEmployees(ctx, "", 1, now)
	if e != nil || len(page.Items) != 1 || page.NextCursor == "" || page.ChangesCursor == "" {
		t.Fatal(page, e)
	}
	record := employeeFixture(2, []string{"it"}, now.Add(time.Second))
	record.Identity.AccountState = Disabled
	changed, e := s.SaveEmployee(ctx, record, second.Revision, "sync", now.Add(time.Second))
	if e != nil {
		t.Fatal(e)
	}
	saveEmployeeFixture(t, s, 3, []string{"it"}, now.Add(time.Second))
	tail, e := s.ListEmployees(ctx, page.NextCursor, 1, now.Add(time.Second))
	if e != nil || len(tail.Items) != 1 || tail.Items[0].Subject != second.Subject || tail.Items[0].AccountState != Active || tail.NextCursor != "" || tail.ChangesCursor != page.ChangesCursor {
		t.Fatal(tail, e)
	}
	changes, e := s.Changes(ctx, page.ChangesCursor, 100)
	if e != nil || len(changes.Items) != 2 || changes.Items[0].Identity.Revision != changed.Revision || changes.Items[0].Identity.Subject != second.Subject {
		t.Fatal(changes, e)
	}
	empty, e := s.Changes(ctx, changes.NextCursor, 100)
	if e != nil || len(empty.Items) != 0 || empty.NextCursor != changes.NextCursor {
		t.Fatal(empty, e)
	}
	if _, e = s.ListEmployees(ctx, page.NextCursor, 1, now.Add(SnapshotLifetime)); !errors.Is(e, ErrCursorExpired) {
		t.Fatal("snapshot not expired", e)
	}
	if _, e = s.ListEmployees(ctx, "not-base64", 1, now); !errors.Is(e, ErrInvalidCursor) {
		t.Fatal(e)
	}
	if _, e = s.Changes(ctx, changeCursor(999999), 10); !errors.Is(e, ErrInvalidCursor) {
		t.Fatal(e)
	}
	if _, e = s.ListDepartments(ctx, page.NextCursor, 1); !errors.Is(e, ErrInvalidCursor) {
		t.Fatal("cross-kind cursor accepted", e)
	}
	// No history pruning runs automatically. A configured retention floor makes
	// an older cursor explicitly require snapshot resync rather than omit events.
	if _, e = s.pool.Exec(ctx, "UPDATE org_cursor_state SET retained_after=2"); e != nil {
		t.Fatal(e)
	}
	if _, e = s.Changes(ctx, changeCursor(1), 10); !errors.Is(e, ErrCursorExpired) {
		t.Fatal(e)
	}
	if first.Subject == second.Subject {
		t.Fatal("fixture collision")
	}
}

func TestOrganizationConcurrentWritersAndCommittedCursor(t *testing.T) {
	s := organizationTestStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	saveDepartmentFixture(t, s, "it", now)
	old := saveEmployeeFixture(t, s, 1, []string{"it"}, now)
	start := make(chan struct{})
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for _, state := range []AccountState{Disabled, Expired} {
		wg.Add(1)
		go func(state AccountState) {
			defer wg.Done()
			<-start
			r := employeeFixture(1, []string{"it"}, now)
			r.Identity.AccountState = state
			_, e := s.SaveEmployee(ctx, r, old.Revision, "sync", now)
			results <- e
		}(state)
	}
	close(start)
	wg.Wait()
	close(results)
	success, conflict := 0, 0
	for e := range results {
		if e == nil {
			success++
		} else if errors.Is(e, ErrConflict) {
			conflict++
		} else {
			t.Fatal(e)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatal(success, conflict)
	}
	// Hold an uncommitted writer after sequence allocation; Changes must wait
	// for its commit, so it can never publish a cursor over a hidden earlier row.
	tx, e := beginWrite(ctx, s.pool)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, "INSERT INTO org_outbox(event_id,body,created_at) VALUES('blocked','{\"event_id\":\"blocked\",\"type\":\"fixture\"}',now())"); e != nil {
		t.Fatal(e)
	}
	done := make(chan ChangesPage, 1)
	errs := make(chan error, 1)
	go func() { p, e := s.Changes(ctx, "", 100); done <- p; errs <- e }()
	select {
	case <-done:
		t.Fatal("reader passed uncommitted writer")
	case <-time.After(100 * time.Millisecond):
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	select {
	case p := <-done:
		if e = <-errs; e != nil || p.Items[len(p.Items)-1].EventID != "blocked" {
			t.Fatal(p, e)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("cursor reader blocked after commit")
	}
}

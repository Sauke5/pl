package store

import (
	"context"
	"errors"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"pl/portal/internal/model"
)

// Each test uses its own schema, never truncates existing application tables.
// Set PORTAL_TEST_DATABASE_URL to a dedicated, disposable PostgreSQL database.
func TestEventKeepsActorNameAfterSessionEnds(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	_, err := s.Pool.Exec(ctx, "INSERT INTO sessions(token_hash,user_id,user_name,admin,csrf,expires_at) VALUES('test-token','ad:stable-id','Имя сотрудника',true,'csrf',now()+interval '1 hour')")
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Event(ctx, "resource.saved", "Изменён ресурс", "", "ad:stable-id", nil, false); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Pool.Exec(ctx, "DELETE FROM sessions WHERE user_id='ad:stable-id'"); err != nil {
		t.Fatal(err)
	}
	events, err := s.Events(ctx, false)
	if err != nil || len(events) != 1 || events[0].Actor != "ad:stable-id" || events[0].ActorName != "Имя сотрудника" {
		t.Fatalf("actor snapshot not preserved: %#v, %v", events, err)
	}
}

func testStore(t *testing.T) *Store {
	t.Helper()
	dsn := os.Getenv("PORTAL_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("PORTAL_TEST_DATABASE_URL is required for PostgreSQL integration tests")
	}
	ctx := context.Background()
	admin, e := pgx.Connect(ctx, dsn)
	if e != nil {
		t.Fatal("test database connection:", e)
	}
	// Serialize first-install DDL with other package helpers and Store.Migrate.
	// Release this transaction before Open acquires the migration lock itself.
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
	schema := "portal_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
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
	s, e := Open(ctx, u.String())
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(s.Pool.Close)
	if e = s.Defaults(ctx); e != nil {
		t.Fatal(e)
	}
	return s
}
func putResource(t *testing.T, s *Store, r model.Resource) model.Resource {
	t.Helper()
	if r.ID == "" {
		r.ID = uuid.NewString()
	}
	if r.Lifecycle == "" {
		r.Lifecycle = "active"
	}
	if r.URL == "" {
		r.URL = "https://" + r.ID + ".test"
	}
	if r.CreatedAt.IsZero() {
		r.CreatedAt = time.Now().UTC()
	}
	r.UpdatedAt = time.Now().UTC()
	b, e := s.Save(context.Background(), "resource", r.ID, r.Revision, r, "test-admin")
	if e != nil {
		t.Fatal(e)
	}
	v, e := Decode[model.Resource](b)
	if e != nil {
		t.Fatal(e)
	}
	return v
}
func putIntegration(t *testing.T, s *Store, kind string) model.Integration {
	t.Helper()
	i := model.Integration{ID: uuid.NewString(), Name: kind, Kind: kind, Enabled: true, URL: "http://source.test", PollSeconds: 30, TimeoutSeconds: 5}
	b, e := s.Save(context.Background(), "integration", i.ID, 0, i, "test-admin")
	if e != nil {
		t.Fatal(e)
	}
	v, e := Decode[model.Integration](b)
	if e != nil {
		t.Fatal(e)
	}
	return v
}
func putCollection(t *testing.T, s *Store, c model.Collection) model.Collection {
	t.Helper()
	if c.ID == "" {
		c.ID = uuid.NewString()
	}
	b, e := s.Save(context.Background(), "collection", c.ID, c.Revision, c, "test-admin")
	if e != nil {
		t.Fatal(e)
	}
	v, e := Decode[model.Collection](b)
	if e != nil {
		t.Fatal(e)
	}
	return v
}
func search(t *testing.T, s *Store, f model.Filter) []model.Resource {
	t.Helper()
	r, e := s.Search(context.Background(), f, nil)
	if e != nil {
		t.Fatal(e)
	}
	return r
}
func hasID(rs []model.Resource, id string) bool {
	for _, r := range rs {
		if r.ID == id {
			return true
		}
	}
	return false
}

func TestPostgresCRUDOptimisticRevision(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	r := putResource(t, s, model.Resource{Name: "Grafana"})
	if r.Revision != 1 {
		t.Fatal(r.Revision)
	}
	old := r
	r.Description = "Изменено первым администратором"
	r = putResource(t, s, r)
	if r.Revision != 2 {
		t.Fatal(r.Revision)
	}
	old.Name = "Overwrite"
	if _, e := s.Save(ctx, "resource", old.ID, old.Revision, old, "second-admin"); !errors.Is(e, ErrConflict) {
		t.Fatal("stale write accepted", e)
	}
	stored, e := Get[model.Resource](ctx, s, "resource", r.ID)
	if e != nil || stored.Description != r.Description || stored.Name != "Grafana" {
		t.Fatal(stored, e)
	}
	r.Lifecycle = "archived"
	putResource(t, s, r)
	if len(search(t, s, model.Filter{})) != 0 || len(search(t, s, model.Filter{Lifecycle: "archived"})) != 1 {
		t.Fatal("archive filter failed")
	}
	audit, e := s.Events(ctx, true)
	if e != nil || len(audit) != 3 {
		t.Fatal("audit must contain successful mutations only", len(audit), e)
	}
}

func TestPostgresSearchRankingAndAttributes(t *testing.T) {
	s := testStore(t)
	r := putResource(t, s, model.Resource{Name: "Grafana", Aliases: []string{"Графана", "дашборды"}, IP: "10.12.1.20", Hostname: "grafana.msk.internal", Description: "Мониторинг серверов", Type: "Приложение", Site: "Москва", Environment: "Prod", Directions: []string{"Мониторинг"}, Tags: []string{"observability", "frontend"}})
	putResource(t, s, model.Resource{Name: "A monitoring description", Description: "Grafana grafana.msk.internal 10.12.1.20", Site: "СПб"})
	for _, q := range []string{"Grafana", "графана", "ГРАФАНА", "graf", "graafna", "10.12.1.20", "grafana.msk.internal", "observability Москва Prod", "Графана Москва Prod", "мониторинга серверов"} {
		t.Run(q, func(t *testing.T) {
			rs := search(t, s, model.Filter{Q: q})
			if len(rs) == 0 || !hasID(rs, r.ID) {
				t.Fatalf("missing matching resource for %q: %v", q, rs)
			}
			if q == "Grafana" || q == "10.12.1.20" || q == "grafana.msk.internal" {
				if rs[0].ID != r.ID {
					t.Fatalf("exact must outrank description: %v", rs)
				}
			}
		})
	}
	rs, e := s.Search(context.Background(), model.Filter{Q: "Grafana"}, []string{"nonexistent"})
	if e != nil || rs[0].ID != r.ID {
		t.Fatal(rs, e)
	}
	if len(search(t, s, model.Filter{Q: "Grafana impossibleXYZ"})) != 0 {
		t.Fatal("query terms must combine with AND")
	}
}

func TestPostgresCollectionAndRelationsSearch(t *testing.T) {
	s := testStore(t)
	peer := putResource(t, s, model.Resource{Name: "Primary VMware"})
	r := putResource(t, s, model.Resource{Name: "Compute console", Relations: []model.Relation{{ResourceID: peer.ID, Label: "зависит от"}}})
	c := putCollection(t, s, model.Collection{Mode: "manual", Name: "Критичные вычисления", ResourceIDs: []string{r.ID}})
	for _, q := range []string{"Критичные вычисления", "Primary VMware", "зависит"} {
		if !hasID(search(t, s, model.Filter{Q: q}), r.ID) {
			t.Error("resource not searchable by explicit context", q)
		}
	}
	if rs := search(t, s, model.Filter{Collection: c.ID}); len(rs) != 1 || rs[0].ID != r.ID {
		t.Fatal(rs)
	}
	peer.Name = "Renamed virtualization"
	putResource(t, s, peer)
	if !hasID(search(t, s, model.Filter{Q: "Renamed virtualization"}), r.ID) {
		t.Fatal("renamed relation was not reindexed")
	}
}

func TestPostgresSavedFilterMatchesSearch(t *testing.T) {
	s := testStore(t)
	r := putResource(t, s, model.Resource{Name: "Grafana", Site: "Москва", Environment: "Prod", Tags: []string{"observability"}})
	f := model.Filter{Q: "Grafana Москва Prod observability"}
	baseline := search(t, s, f)
	if len(baseline) != 1 {
		t.Fatal("invalid baseline", baseline)
	}
	c := putCollection(t, s, model.Collection{Mode: "filter", Name: "Monitoring in Moscow", Filter: f})
	rs := search(t, s, model.Filter{Collection: c.ID})
	if len(rs) != 1 || rs[0].ID != r.ID {
		t.Fatalf("saved search must match direct search, got %v", rs)
	}
}
func TestPostgresEmptyManualCollectionHasNoMembers(t *testing.T) {
	s := testStore(t)
	r := putResource(t, s, model.Resource{Name: "An unrelated service"})
	c := putCollection(t, s, model.Collection{Mode: "manual", Name: "Empty collection", ResourceIDs: []string{}})
	if rs := search(t, s, model.Filter{Collection: c.ID}); len(rs) != 0 {
		t.Fatalf("empty manual collection contains unrelated resource %s: %v", r.ID, rs)
	}
	if hasID(search(t, s, model.Filter{Q: "Empty collection"}), r.ID) {
		t.Fatal("empty collection name indexed onto unrelated resource")
	}
}

func TestPostgresDiscoveryManualEditsAndIgnoredState(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	i := putIntegration(t, s, "prometheus")
	snapshot := model.Snapshot{Candidates: []model.Candidate{{ExternalID: "target-a", Name: "Technical target", URL: "http://target.test/metrics", Labels: map[string]string{"job": "node"}}, {ExternalID: "target-b", Name: "Ignored", URL: "http://ignore.test/metrics"}}}
	for n := 0; n < 2; n++ {
		if e := s.ApplySnapshot(ctx, i, snapshot, nil); e != nil {
			t.Fatal(e)
		}
	}
	cs, e := List[model.Candidate](ctx, s, "candidate")
	if e != nil || len(cs) != 2 {
		t.Fatal(cs, e)
	}
	aID := SourceID(i.ID, "target-a")
	a, e := s.ResolveCandidates(ctx, []string{aID}, "add", "", "operator")
	if e != nil || len(a) != 1 {
		t.Fatal(a, e)
	}
	resource, e := Get[model.Resource](ctx, s, "resource", a[0].ResourceID)
	if e != nil {
		t.Fatal(e)
	}
	if len(resource.Operations) != 0 {
		t.Fatal("discovery enabled operations")
	}
	resource.Name = "Manual service name"
	resource.Description = "Manual description"
	resource = putResource(t, s, resource)
	if _, e = s.ResolveCandidates(ctx, []string{SourceID(i.ID, "target-b")}, "ignore", "", "operator"); e != nil {
		t.Fatal(e)
	}
	snapshot.Candidates[0].Name = "Changed source title"
	if e = s.ApplySnapshot(ctx, i, snapshot, nil); e != nil {
		t.Fatal(e)
	}
	resources, e := List[model.Resource](ctx, s, "resource")
	if e != nil || len(resources) != 1 || resources[0].Name != resource.Name || resources[0].Description != resource.Description {
		t.Fatal("manual resource overwritten", resources, e)
	}
	ignored, e := Get[model.Candidate](ctx, s, "candidate", SourceID(i.ID, "target-b"))
	if e != nil || ignored.State != "ignored" {
		t.Fatal(ignored, e)
	}
	linked, e := Get[model.Candidate](ctx, s, "candidate", aID)
	if e != nil || linked.ResourceID != resource.ID || linked.State != "linked" {
		t.Fatal(linked, e)
	}
	// Restoring is explicit: polls preserve ignored state, and only ignored candidates may return.
	if _, e = s.ResolveCandidates(ctx, []string{ignored.ID, aID}, "restore", "", "operator"); !errors.Is(e, ErrConflict) {
		t.Fatal("mixed restore must reject linked candidate atomically", e)
	}
	stillIgnored, e := Get[model.Candidate](ctx, s, "candidate", ignored.ID)
	if e != nil || stillIgnored.State != "ignored" {
		t.Fatal("failed batch partially restored candidates", stillIgnored, e)
	}
	restored, e := s.ResolveCandidates(ctx, []string{ignored.ID}, "restore", "", "operator")
	if e != nil || len(restored) != 1 || restored[0].State != "pending" || restored[0].ExternalID != ignored.ExternalID {
		t.Fatal("ignored candidate not restored with identity preserved", restored, e)
	}
	if _, e = s.ResolveCandidates(ctx, []string{ignored.ID}, "restore", "", "operator"); !errors.Is(e, ErrConflict) {
		t.Fatal("pending candidate must not restore", e)
	}
	if e = s.ApplySnapshot(ctx, i, snapshot, nil); e != nil {
		t.Fatal(e)
	}
	restoredCandidate, e := Get[model.Candidate](ctx, s, "candidate", ignored.ID)
	if e != nil || restoredCandidate.State != "pending" {
		t.Fatal("poll lost restored state", restoredCandidate, e)
	}
	if _, e = s.ResolveCandidates(ctx, []string{ignored.ID}, "add", "", "operator"); e != nil {
		t.Fatal("restored candidate cannot be accepted", e)
	}
	if e = s.ApplySnapshot(ctx, i, model.Snapshot{}, nil); e != nil {
		t.Fatal(e)
	}
	if _, e = Get[model.Resource](ctx, s, "resource", resource.ID); e != nil {
		t.Fatal("missing target deleted catalog resource", e)
	}
}

func TestPostgresProblemTransitionsFailureAndRecovery(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	i := putIntegration(t, s, "alertmanager")
	snapshot := model.Snapshot{Problems: []model.Problem{{ExternalID: "fingerprint", Title: "Down", StartedAt: time.Now().Add(-time.Minute), Labels: map[string]string{"portal_silenced": "true"}}}}
	for n := 0; n < 2; n++ {
		if e := s.ApplySnapshot(ctx, i, snapshot, nil); e != nil {
			t.Fatal(e)
		}
	}
	problems, e := s.Problems(ctx)
	if e != nil || len(problems) != 1 || problems[0].Status != "firing" || problems[0].Stale {
		t.Fatal(problems, e)
	}
	if e = s.ApplySnapshot(ctx, i, model.Snapshot{}, errors.New("source network failure")); e != nil {
		t.Fatal(e)
	}
	problems, e = s.Problems(ctx)
	if e != nil || problems[0].Status != "firing" || !problems[0].Stale || problems[0].ResolvedAt != nil {
		t.Fatal("failed poll falsely restored", problems, e)
	}
	if e = s.ApplySnapshot(ctx, i, model.Snapshot{}, nil); e != nil {
		t.Fatal(e)
	}
	problems, e = s.Problems(ctx)
	if e != nil || problems[0].Status != "resolved" || problems[0].ResolvedAt == nil || problems[0].Stale {
		t.Fatal(problems, e)
	}
	if e = s.ApplySnapshot(ctx, i, snapshot, nil); e != nil {
		t.Fatal(e)
	}
	problems, e = s.Problems(ctx)
	if e != nil || problems[0].Status != "firing" || problems[0].ResolvedAt != nil {
		t.Fatal(problems, e)
	}
	events, e := s.Events(ctx, false)
	if e != nil {
		t.Fatal(e)
	}
	counts := map[string]int{}
	for _, v := range events {
		counts[v.Kind]++
	}
	if counts["problem.firing"] != 2 || counts["problem.resolved"] != 1 {
		t.Fatal("unchanged polling emitted transition noise", counts)
	}
}

func TestPostgresJobConcurrentIdempotenceAndActiveRestart(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	input := model.Job{Kind: "restart", ResourceID: "resource-a", Actor: "actor-a", IdempotencyKey: "once", Confirmed: true, Parameters: map[string]any{"executor_target": "container-a"}}
	var wg sync.WaitGroup
	ids := make(chan string, 8)
	for n := 0; n < 8; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			j, e := s.Enqueue(ctx, input)
			if e != nil {
				t.Error(e)
				return
			}
			ids <- j.ID
		}()
	}
	wg.Wait()
	close(ids)
	first := ""
	for id := range ids {
		if first == "" {
			first = id
		}
		if first != id {
			t.Fatal("idempotence returned distinct jobs")
		}
	}
	changed := input
	changed.ResourceID = "other"
	if _, e := s.Enqueue(ctx, changed); !errors.Is(e, ErrConflict) {
		t.Fatal("same key different input accepted", e)
	}
	changed = input
	changed.Actor = "actor-b"
	changed.IdempotencyKey = "other"
	if _, e := s.Enqueue(ctx, changed); !errors.Is(e, ErrConflict) {
		t.Fatal("parallel restart target accepted", e)
	}
	j, e := s.Claim(ctx)
	if e != nil || j.ID != first || j.Status != "running" {
		t.Fatal(j, e)
	}
	if _, e = s.Claim(ctx); !errors.Is(e, ErrNotFound) {
		t.Fatal("claimed same job twice", e)
	}
	j.Status = "succeeded"
	j.Result = map[string]any{"ok": true}
	if e = s.Finish(ctx, j); e != nil {
		t.Fatal(e)
	}
	again, e := s.Enqueue(ctx, input)
	if e != nil || again.ID != first || again.Status != "succeeded" {
		t.Fatal("lost completed idempotence", again, e)
	}
	if _, e = s.Enqueue(ctx, changed); e != nil {
		t.Fatal("new confirmed request after completion rejected", e)
	}
}

func TestPostgresRecoverDoesNotRepeatMutations(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	for _, kind := range []string{"restart", "report", "check"} {
		input := model.Job{Kind: kind, ResourceID: kind, Actor: "actor", IdempotencyKey: kind, Parameters: map[string]any{}}
		if _, e := s.Enqueue(ctx, input); e != nil {
			t.Fatal(e)
		}
		if _, e := s.Claim(ctx); e != nil {
			t.Fatal(e)
		}
	}
	if e := s.Recover(ctx); e != nil {
		t.Fatal(e)
	}
	jobs, e := s.Jobs(ctx)
	if e != nil || len(jobs) != 3 {
		t.Fatal(jobs, e)
	}
	for _, j := range jobs {
		want := "unknown"
		if j.Kind == "check" {
			want = "failed"
		}
		if j.Status != want || j.FinishedAt == nil {
			t.Fatal("unsafe crash recovery", j)
		}
	}
	if _, e = s.Claim(ctx); !errors.Is(e, ErrNotFound) {
		t.Fatal("recovery requeued side effects", e)
	}
	if e = s.Recover(ctx); e != nil {
		t.Fatal("repeat recovery not idempotent", e)
	}
	reports, e := List[model.Report](ctx, s, "report")
	if e != nil || len(reports) != 1 || reports[0].Status != "unknown" {
		t.Fatal(reports, e)
	}
}

func TestPostgresConcurrentDistinctCatalogEdits(t *testing.T) {
	s := testStore(t)
	resources := []model.Resource{}
	for n := 0; n < 4; n++ {
		resources = append(resources, putResource(t, s, model.Resource{Name: uuid.NewString()}))
	}
	start := make(chan struct{})
	var wg sync.WaitGroup
	for _, r := range resources {
		wg.Add(1)
		go func(r model.Resource) {
			defer wg.Done()
			<-start
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			r.Description = "Independent edit"
			if _, e := s.Save(ctx, "resource", r.ID, r.Revision, r, "parallel-admin"); e != nil {
				t.Error("independent edits must not deadlock during global reindex:", e)
			}
		}(r)
	}
	close(start)
	wg.Wait()
	for _, r := range resources {
		v, e := Get[model.Resource](context.Background(), s, "resource", r.ID)
		if e != nil || v.Description != "Independent edit" {
			t.Error("independent update not persisted", v.ID, e)
		}
	}
}

func TestPostgresImportPlanBoundToActorDigestAndOneApply(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	r := putResource(t, s, model.Resource{Name: "Before import"})
	baseline, e := s.CatalogDigest(ctx)
	if e != nil {
		t.Fatal(e)
	}
	r.Name = "Imported name"
	p := ImportPlan{Token: uuid.NewString(), Actor: "owner", Baseline: baseline, ExpiresAt: time.Now().Add(time.Minute), Writes: []ImportWrite{{Kind: "resource", ID: r.ID, Revision: r.Revision, Body: encode(r)}}}
	if e = s.SaveImportPlan(ctx, p); e != nil {
		t.Fatal(e)
	}
	if e = s.ApplyImport(ctx, p.Token, "other"); !errors.Is(e, ErrNotFound) {
		t.Fatal("other actor applied preview", e)
	}
	putResource(t, s, model.Resource{Name: "Concurrent catalog edit"})
	if e = s.ApplyImport(ctx, p.Token, p.Actor); !errors.Is(e, ErrConflict) {
		t.Fatal("stale preview overwrote changes", e)
	}
	actual, e := Get[model.Resource](ctx, s, "resource", r.ID)
	if e != nil || actual.Name != "Before import" {
		t.Fatal(actual, e)
	}
	p.Token = uuid.NewString()
	p.Baseline, e = s.CatalogDigest(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.SaveImportPlan(ctx, p); e != nil {
		t.Fatal(e)
	}
	if e = s.ApplyImport(ctx, p.Token, p.Actor); e != nil {
		t.Fatal(e)
	}
	actual, e = Get[model.Resource](ctx, s, "resource", r.ID)
	if e != nil || actual.Name != "Imported name" || actual.Revision != 2 {
		t.Fatal(actual, e)
	}
	if e = s.ApplyImport(ctx, p.Token, p.Actor); !errors.Is(e, ErrNotFound) {
		t.Fatal("preview applied twice", e)
	}
}
func TestPostgresImportRollbackOnAnyConflict(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	baseline, e := s.CatalogDigest(ctx)
	if e != nil {
		t.Fatal(e)
	}
	id := uuid.NewString()
	p := ImportPlan{Token: uuid.NewString(), Actor: "owner", Baseline: baseline, ExpiresAt: time.Now().Add(time.Minute), Writes: []ImportWrite{{Kind: "resource", ID: id, Revision: 0, Body: encode(model.Resource{ID: id, Name: "Must roll back", URL: "https://test", Lifecycle: "active"})}, {Kind: "resource", ID: uuid.NewString(), Revision: 99, Body: encode(model.Resource{Name: "Missing revision"})}}}
	if e = s.SaveImportPlan(ctx, p); e != nil {
		t.Fatal(e)
	}
	if e = s.ApplyImport(ctx, p.Token, p.Actor); !errors.Is(e, ErrConflict) {
		t.Fatal("invalid plan should conflict", e)
	}
	if _, e = Get[model.Resource](ctx, s, "resource", id); !errors.Is(e, ErrNotFound) {
		t.Fatal("partial import persisted", e)
	}
}

func TestPostgresReportPeriodUsesGeneratorDefault(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	j, e := s.Enqueue(ctx, model.Job{Kind: "report", IntegrationID: "reports", Actor: "operator", IdempotencyKey: "default-report-period", Parameters: map[string]any{}})
	if e != nil {
		t.Fatal(e)
	}
	j, e = s.Claim(ctx)
	if e != nil {
		t.Fatal(e)
	}
	j.Status = "succeeded"
	j.Result = map[string]any{"period": "2026-09-25", "url": "https://reports.test/reports/report.pdf"}
	if e = s.Finish(ctx, j); e != nil {
		t.Fatal(e)
	}
	reports, e := List[model.Report](ctx, s, "report")
	if e != nil || len(reports) != 1 || reports[0].Period != "2026-09-25" {
		t.Fatal("generator default period not persisted", reports, e)
	}
}

func TestPostgresExistingReportsIdempotentAndGeneratedMerge(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	i := putIntegration(t, s, "reports")
	url := "https://portal.test/reports/infrastructure-2026-09-24-run-93.html"
	snap := model.Snapshot{Reports: []model.Report{{URL: url, Title: "Existing report", Period: "2026-09-24", Run: 93, ReportType: "daily", Status: "succeeded"}}}
	for n := 0; n < 2; n++ {
		if e := s.ApplySnapshot(ctx, i, snap, nil); e != nil {
			t.Fatal(e)
		}
	}
	rs, e := List[model.Report](ctx, s, "report")
	if e != nil || len(rs) != 1 || rs[0].JobID != "" || !rs[0].CreatedAt.IsZero() {
		t.Fatal(rs, e)
	}
	importedID := rs[0].ID
	if e = s.ApplySnapshot(ctx, i, model.Snapshot{}, errors.New("manifest unavailable")); e != nil {
		t.Fatal(e)
	}
	if e = s.ApplySnapshot(ctx, i, model.Snapshot{}, nil); e != nil {
		t.Fatal(e)
	}
	rs, e = List[model.Report](ctx, s, "report")
	if e != nil || len(rs) != 1 {
		t.Fatal(rs, e)
	}
	job, e := s.Enqueue(ctx, model.Job{Kind: "report", IntegrationID: i.ID, Actor: "test", IdempotencyKey: "existing-url", Parameters: map[string]any{}})
	if e != nil {
		t.Fatal(e)
	}
	job.Status = "succeeded"
	job.Result = map[string]any{"url": url, "period": "2026-09-24", "run": float64(93), "report_type": "daily"}
	var wg sync.WaitGroup
	for n := 0; n < 4; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := s.ApplySnapshot(ctx, i, snap, nil); err != nil {
				t.Error(err)
			}
		}()
	}
	if e = s.Finish(ctx, job); e != nil {
		t.Fatal(e)
	}
	wg.Wait()
	if e = s.ApplySnapshot(ctx, i, snap, nil); e != nil {
		t.Fatal(e)
	}
	rs, e = List[model.Report](ctx, s, "report")
	if e != nil || len(rs) != 1 || rs[0].ID != importedID || rs[0].JobID != job.ID || rs[0].CreatedAt.IsZero() || rs[0].Run != 93 || rs[0].ReportType != "daily" {
		t.Fatal(rs, e)
	}
	// A generated URL first seen locally must also survive later archive ingestion.
	otherURL := "https://portal.test/reports/infrastructure-2026-09-24-run-94.html"
	job, e = s.Enqueue(ctx, model.Job{Kind: "report", IntegrationID: i.ID, Actor: "test", IdempotencyKey: "generated-first", Parameters: map[string]any{}})
	if e != nil {
		t.Fatal(e)
	}
	job.Status = "succeeded"
	job.Result = map[string]any{"url": otherURL, "period": "2026-09-24", "run": 94, "report_type": "daily"}
	if e = s.Finish(ctx, job); e != nil {
		t.Fatal(e)
	}
	snap.Reports = append(snap.Reports, model.Report{URL: otherURL, Period: "2026-09-24", Status: "succeeded", Run: 94, ReportType: "daily"})
	if e = s.ApplySnapshot(ctx, i, snap, nil); e != nil {
		t.Fatal(e)
	}
	rs, e = List[model.Report](ctx, s, "report")
	if e != nil || len(rs) != 2 {
		t.Fatal(rs, e)
	}
}

func TestPostgresEventNamesEnrichedAtReadWithoutChangingSnapshots(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	insert := func(table, id, actor, name string, offset time.Duration) {
		t.Helper()
		ev := model.Event{ID: id, Actor: actor, ActorName: name, Kind: "fixture", CreatedAt: time.Now().Add(offset)}
		if _, err := s.Pool.Exec(ctx, "INSERT INTO "+table+"(id,body,created_at) VALUES($1,$2,$3)", id, encode(ev), ev.CreatedAt); err != nil {
			t.Fatal(err)
		}
	}
	// Names can come from either event table, including records outside the page.
	insert("events", "known-event", "actor-event", "Имя из событий", -48*time.Hour)
	insert("audit_events", "known-audit-old", "actor-audit", "Старое имя аудита", -49*time.Hour)
	insert("audit_events", "known-audit", "actor-audit", "Имя из аудита", -48*time.Hour)
	for _, table := range []string{"events", "audit_events"} {
		insert(table, table+"-legacy-event", "actor-event", "", 0)
		insert(table, table+"-legacy-audit", "actor-audit", "", 0)
		insert(table, table+"-legacy-session", "actor-session", "", 0)
		insert(table, table+"-snapshot", "actor-session", "Историческое имя", 0)
		insert(table, table+"-unknown", "actor-unknown", "", 0)
		insert(table, table+"-different-id", "actor-session-other", "", 0)
		// Push the named source snapshots outside the latest 200 rows.
		if _, err := s.Pool.Exec(ctx, "INSERT INTO "+table+"(id,body,created_at) SELECT 'filler-'||n,jsonb_build_object('id','filler-'||n,'actor',''),now()-interval '1 hour' FROM generate_series(1,200) AS n"); err != nil {
			t.Fatal(err)
		}
	}
	for _, session := range []struct {
		token, name string
		offset      time.Duration
	}{{"older", "Старое имя сессии", time.Hour}, {"newer", "Текущее имя сессии", 2 * time.Hour}} {
		if _, err := s.Pool.Exec(ctx, "INSERT INTO sessions(token_hash,user_id,user_name,admin,csrf,expires_at) VALUES($1,'actor-session',$2,true,'csrf',$3)", session.token, session.name, time.Now().Add(session.offset)); err != nil {
			t.Fatal(err)
		}
	}
	for _, audit := range []bool{false, true} {
		table := "events"
		if audit {
			table = "audit_events"
		}
		got, err := s.Events(ctx, audit)
		if err != nil {
			t.Fatal(err)
		}
		names := map[string]string{}
		for _, v := range got {
			names[v.ID] = v.ActorName
		}
		for suffix, want := range map[string]string{"legacy-event": "Имя из событий", "legacy-audit": "Имя из аудита", "legacy-session": "Текущее имя сессии", "snapshot": "Историческое имя", "unknown": "", "different-id": ""} {
			name, ok := names[table+"-"+suffix]
			if !ok || name != want {
				t.Fatalf("%s: name=%q want=%q present=%v", table+"-"+suffix, name, want, ok)
			}
		}
		var mutated int
		if err = s.Pool.QueryRow(ctx, "SELECT count(*) FROM "+table+" WHERE id LIKE $1 AND COALESCE(body->>'actor_name','')<>''", table+"-legacy-%").Scan(&mutated); err != nil || mutated != 0 {
			t.Fatal("read changed historical data", mutated, err)
		}
	}
	// A later logout removes sessions, but a trustworthy saved snapshot remains.
	if _, err := s.Pool.Exec(ctx, "DELETE FROM sessions WHERE user_id='actor-session'"); err != nil {
		t.Fatal(err)
	}
	got, err := s.Events(ctx, true)
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range got {
		if v.ID == "audit_events-legacy-session" && v.ActorName != "Историческое имя" {
			t.Fatal("snapshot fallback after logout", v)
		}
	}
}

func TestPostgresProblemVisibilityIsGlobalOccurrenceState(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	i := putIntegration(t, s, "alertmanager")
	actor := model.User{ID: "ad:operator", Name: "Иван Иванов", Admin: true}
	if _, e := s.Pool.Exec(ctx, "INSERT INTO sessions(token_hash,user_id,user_name,admin,csrf,expires_at) VALUES('visibility-token',$1,$2,true,'csrf',now()+interval '1 hour')", actor.ID, actor.Name); e != nil {
		t.Fatal(e)
	}
	started := time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond)
	snapshot := model.Snapshot{Problems: []model.Problem{{ExternalID: "alert-a", Title: "Known issue", StartedAt: started, Labels: map[string]string{"portal_silenced": "true"}}}}
	poll := func(snap model.Snapshot, err error) {
		t.Helper()
		if e := s.ApplySnapshot(ctx, i, snap, err); e != nil {
			t.Fatal(e)
		}
	}
	poll(snapshot, nil)
	id := SourceID(i.ID, "alert-a")
	read := func(hidden bool, status string) model.Problem {
		t.Helper()
		items, e := s.Problems(ctx)
		if e != nil || len(items) != 1 {
			t.Fatal(items, e)
		}
		p := items[0]
		if p.Hidden != hidden || p.Status != status || p.Labels["portal_silenced"] != "true" {
			t.Fatalf("visibility changed source semantics: %+v", p)
		}
		return p
	}
	read(false, "firing")
	for n := 0; n < 2; n++ {
		if e := s.SetProblemVisibility(ctx, id, true, actor, nil); e != nil {
			t.Fatal(e)
		}
	}
	p := read(true, "firing")
	if p.HiddenBy != actor.ID || p.HiddenByName != actor.Name || p.HiddenAt == nil {
		t.Fatal(p)
	}
	poll(snapshot, nil)
	read(true, "firing")
	poll(model.Snapshot{}, errors.New("source timeout"))
	p = read(true, "firing")
	if !p.Stale {
		t.Fatal("source failure lost stale")
	}
	raw, e := Get[model.Problem](ctx, s, "problem", id)
	if e != nil || raw.Hidden || !raw.StartedAt.Equal(started) {
		t.Fatal("visibility persisted into source problem", raw, e)
	}
	if e = s.SetProblemVisibility(ctx, id, false, actor, nil); e != nil {
		t.Fatal(e)
	}
	read(false, "firing")
	audits, e := s.Events(ctx, true)
	if e != nil {
		t.Fatal(e)
	}
	counts := map[string]int{}
	for _, ev := range audits {
		if ev.Kind == "problem.hidden" || ev.Kind == "problem.shown" {
			counts[ev.Kind]++
			if ev.Actor != actor.ID || ev.ActorName != actor.Name {
				t.Fatal(ev)
			}
		}
	}
	if counts["problem.hidden"] != 1 || counts["problem.shown"] != 1 {
		t.Fatal("duplicate mutation audit", counts)
	}
	if e = s.SetProblemVisibility(ctx, id, true, actor, nil); e != nil {
		t.Fatal(e)
	}
	poll(model.Snapshot{}, nil)
	read(false, "resolved")
	vis, e := Get[problemVisibility](ctx, s, "problem_visibility", id)
	if e != nil || !vis.Hidden {
		t.Fatal("recovery deleted visibility", vis, e)
	}
	if e = s.SetProblemVisibility(ctx, id, true, actor, nil); !errors.Is(e, ErrInvalid) {
		t.Fatal("resolved occurrence hidden", e)
	}
	snapshot.Problems[0].StartedAt = started.Add(time.Hour)
	poll(snapshot, nil)
	read(false, "firing")
	// Matching uses instants, not the spelling of a time zone.
	if e = s.SetProblemVisibility(ctx, id, true, actor, nil); e != nil {
		t.Fatal(e)
	}
	snapshot.Problems[0].StartedAt = snapshot.Problems[0].StartedAt.In(time.FixedZone("offset", 3*3600))
	poll(snapshot, nil)
	read(true, "firing")
	snapshot.Problems[0].StartedAt = snapshot.Problems[0].StartedAt.Add(time.Minute)
	poll(snapshot, nil)
	read(false, "firing")
	if e = s.SetProblemVisibility(ctx, id, false, actor, nil); e != nil {
		t.Fatal(e)
	}
	vis, e = Get[problemVisibility](ctx, s, "problem_visibility", id)
	if e != nil || vis.Hidden {
		t.Fatal("restore did not clear old preference", vis, e)
	}
}

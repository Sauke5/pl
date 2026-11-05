package store

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"pl/portal/internal/model"
)

func TestClaimLaneFIFOIsolationAndSkipLocked(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	kinds := []struct{ kind, action string }{{"check", "refresh"}, {"module", "install"}, {"module", "refresh"}, {"refresh", ""}, {"module", ""}, {"module", "refresh"}, {"future-kind", "refresh"}}
	jobs := make([]model.Job, 0, len(kinds))
	for n, row := range kinds {
		j, err := s.Enqueue(ctx, model.Job{Kind: row.kind, Actor: "lane-test", IdempotencyKey: fmt.Sprint(n), Parameters: map[string]any{"action": row.action}})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = s.Pool.Exec(ctx, `UPDATE jobs SET created_at=$2 WHERE id=$1`, j.ID, time.Now().Add(time.Duration(n-100)*time.Minute)); err != nil {
			t.Fatal(err)
		}
		jobs = append(jobs, j)
	}
	// A locked oldest health row must not block either lane or be claimed twice.
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT id FROM jobs WHERE id=$1 FOR UPDATE`, jobs[2].ID); err != nil {
		t.Fatal(err)
	}
	health, err := s.ClaimLane(ctx, true)
	if err != nil || health.ID != jobs[5].ID {
		t.Fatalf("health skipped oldest locked row: %+v %v", health, err)
	}
	for _, n := range []int{0, 1, 3, 4, 6} {
		got, err := s.ClaimLane(ctx, false)
		if err != nil || got.ID != jobs[n].ID || got.Status != "running" || got.StartedAt == nil {
			t.Fatalf("other FIFO index %d: %+v %v", n, got, err)
		}
	}
	if _, err = s.ClaimLane(ctx, false); !errors.Is(err, ErrNotFound) {
		t.Fatalf("other stole health: %v", err)
	}
	if err = tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	health, err = s.ClaimLane(ctx, true)
	if err != nil || health.ID != jobs[2].ID {
		t.Fatalf("unlocked health lost: %+v %v", health, err)
	}
	if _, err = s.Claim(ctx); !errors.Is(err, ErrNotFound) {
		t.Fatalf("legacy Claim returned completed claim: %v", err)
	}
	// The legacy API remains unrestricted.
	legacy, err := s.Enqueue(ctx, model.Job{Kind: "module", Actor: "lane-test", IdempotencyKey: "legacy", Parameters: map[string]any{"action": "refresh"}})
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.Claim(ctx)
	if err != nil || got.ID != legacy.ID {
		t.Fatalf("legacy Claim: %+v %v", got, err)
	}
}

func TestClaimLaneConcurrentClaimsAreAtomic(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	const perLane = 12
	for n := 0; n < 2*perLane; n++ {
		kind := "check"
		if n%2 == 0 {
			kind = "module"
		}
		if _, err := s.Enqueue(ctx, model.Job{Kind: kind, Actor: "concurrent-lanes", IdempotencyKey: fmt.Sprint(n), Parameters: map[string]any{"action": "refresh"}}); err != nil {
			t.Fatal(err)
		}
	}
	type result struct {
		job    model.Job
		health bool
		err    error
	}
	results := make(chan result, 2*perLane)
	var wg sync.WaitGroup
	for n := 0; n < 2*perLane; n++ {
		health := n%2 == 0
		wg.Add(1)
		go func() { defer wg.Done(); job, err := s.ClaimLane(ctx, health); results <- result{job, health, err} }()
	}
	wg.Wait()
	close(results)
	seen := map[string]bool{}
	for got := range results {
		if got.err != nil {
			t.Fatal(got.err)
		}
		if seen[got.job.ID] {
			t.Fatalf("duplicate claim: %s", got.job.ID)
		}
		seen[got.job.ID] = true
		if (got.job.Kind == "module") != got.health || got.job.Status != "running" {
			t.Fatalf("cross-lane claim: %+v", got)
		}
	}
	if len(seen) != 2*perLane {
		t.Fatalf("lost jobs: %d", len(seen))
	}
	for _, health := range []bool{true, false} {
		if _, err := s.ClaimLane(ctx, health); !errors.Is(err, ErrNotFound) {
			t.Fatalf("lane not drained: %v", err)
		}
	}
}

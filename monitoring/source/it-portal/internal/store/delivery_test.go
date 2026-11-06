package store

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"pl/portal/internal/model"
	"strings"
	"sync"
	"testing"
)

func deliveryRequestFixture() DeliveryRequest {
	return DeliveryRequest{ID: uuid.NewString(), Actor: "ad:initiator", Action: "module-upgrade", ModuleID: "forms", Target: "Forms", Version: "0.1.0", ArtifactSHA256: strings.Repeat("a", 64)}
}
func deliveryObserveFixture(id, phase string) DeliveryObservation {
	return DeliveryObservation{ID: id, Kind: "module_upgrade", ModuleID: "forms", Phase: phase, CurrentVersion: "0.6.3", RecoveryMode: "resume"}
}
func deliveryEventCount(t *testing.T, s *Store, id string) int {
	t.Helper()
	var n int
	if err := s.Pool.QueryRow(context.Background(), "SELECT count(*) FROM audit_events WHERE body #>> '{details,job_id}'=$1", id).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestDeliveryIntentDurableIdempotentAndExternallyManaged(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	request := deliveryRequestFixture()
	job, err := s.BeginDelivery(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	if job.ID != request.ID || job.Kind != "delivery" || job.Actor != request.Actor || job.Status != "running" {
		t.Fatalf("lost external identity: %#v", job)
	}
	original := finishRawJob(t, s, job.ID)
	var concurrent sync.WaitGroup
	for i := 0; i < 4; i++ {
		concurrent.Add(1)
		go func() {
			defer concurrent.Done()
			if _, e := s.BeginDelivery(ctx, request); e != nil {
				t.Error(e)
			}
		}()
	}
	concurrent.Wait()
	again, err := s.BeginDelivery(ctx, request)
	if err != nil || again.ID != job.ID {
		t.Fatal(again, err)
	}
	if deliveryEventCount(t, s, job.ID) != 1 {
		t.Fatal("duplicate intent event")
	}
	// Startup recovery must not fail or queue a still-running host operation.
	if err = s.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	if string(original) != string(finishRawJob(t, s, job.ID)) {
		t.Fatal("ordinary recovery changed external job")
	}
	// Even an accidentally queued external row must not enter either worker lane.
	if _, err = s.Pool.Exec(ctx, "UPDATE jobs SET status='queued' WHERE id=$1", job.ID); err != nil {
		t.Fatal(err)
	}
	for _, claim := range []func(context.Context) (model.Job, error){s.Claim, func(c context.Context) (model.Job, error) { return s.ClaimLane(c, false) }, func(c context.Context) (model.Job, error) { return s.ClaimLane(c, true) }} {
		if _, err = claim(ctx); !errors.Is(err, ErrNotFound) {
			t.Fatalf("worker claimed external operation: %v", err)
		}
	}
}

func TestDeliveryObservationRecoveryAndTerminalDeduplication(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	request := deliveryRequestFixture()
	if _, err := s.BeginDelivery(ctx, request); err != nil {
		t.Fatal(err)
	}
	for _, phase := range []string{"unconfirmed", "downloading", "recovery_required", "restoring", "resuming", "complete"} {
		observed := deliveryObserveFixture(request.ID, phase)
		if phase == "unconfirmed" {
			observed = DeliveryObservation{ID: request.ID, Phase: phase}
		}
		if err := s.ObserveDelivery(ctx, observed); err != nil {
			t.Fatal(phase, err)
		}
		n := deliveryEventCount(t, s, request.ID)
		raw := string(finishRawJob(t, s, request.ID))
		if err := s.ObserveDelivery(ctx, observed); err != nil {
			t.Fatal(err)
		}
		if deliveryEventCount(t, s, request.ID) != n || string(finishRawJob(t, s, request.ID)) != raw {
			t.Fatal("duplicate status mutated job/events", phase)
		}
		job, _ := s.Job(ctx, request.ID)
		want := "running"
		if phase == "unconfirmed" || phase == "recovery_required" {
			want = "unknown"
		}
		if phase == "complete" {
			want = "succeeded"
		}
		if job.Actor != request.Actor || job.Status != want || job.Parameters["version"] != "0.1.0" || job.Result["target_version"] != "0.1.0" {
			t.Fatalf("lost original context: %#v", job)
		}
	}
	terminal := string(finishRawJob(t, s, request.ID))
	if err := s.ObserveDelivery(ctx, DeliveryObservation{ID: request.ID, Phase: "unconfirmed"}); err != nil {
		t.Fatal(err)
	}
	if err := s.ObserveDelivery(ctx, deliveryObserveFixture(request.ID, "downloading")); err != nil {
		t.Fatal(err)
	}
	if string(finishRawJob(t, s, request.ID)) != terminal {
		t.Fatal("delayed observations overwrote terminal proof")
	}
	for i := 0; i < 2; i++ {
		if err := s.RecordDeliveryRecovery(ctx, request.ID, "other-admin"); err != nil {
			t.Fatal(err)
		}
	}
	var count int
	if err := s.Pool.QueryRow(ctx, "SELECT count(*) FROM audit_events WHERE body->>'kind'='delivery.recovery_requested'").Scan(&count); err != nil || count != 1 {
		t.Fatal(count, err)
	}
	job, _ := s.Job(ctx, request.ID)
	if job.Actor != request.Actor {
		t.Fatal("recovery replaced initiator")
	}
}

func TestDeliveryRejectsUUIDPayloadActorAndTargetConflicts(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	request := deliveryRequestFixture()
	if _, err := s.BeginDelivery(ctx, request); err != nil {
		t.Fatal(err)
	}
	for _, change := range []string{"actor", "artifact", "version", "module", "action"} {
		candidate := request
		switch change {
		case "actor":
			candidate.Actor = "reader"
		case "artifact":
			candidate.ArtifactSHA256 = strings.Repeat("b", 64)
		case "version":
			candidate.Version = "1.0.0"
		case "module":
			candidate.ModuleID = "netmap"
		case "action":
			candidate.Action = "upgrade"
			candidate.ModuleID = ""
		}
		if _, err := s.BeginDelivery(ctx, candidate); !errors.Is(err, ErrConflict) {
			t.Fatal(change, err)
		}
	}
	observed := deliveryObserveFixture(request.ID, "complete")
	observed.ModuleID = "netmap"
	if err := s.ObserveDelivery(ctx, observed); !errors.Is(err, ErrConflict) {
		t.Fatal("wrong host target admitted", err)
	}
	if err := s.ObserveDelivery(ctx, deliveryObserveFixture(uuid.NewString(), "complete")); err != nil {
		t.Fatal(err)
	}
	jobs, err := s.Jobs(ctx)
	if err != nil || len(jobs) != 1 {
		t.Fatal("GET observation created missing legacy job", jobs, err)
	}
}

func TestDeliveryCoreHostPreparationPhasesRemainRunning(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	request := DeliveryRequest{ID: uuid.NewString(), Actor: "original-admin", Action: "upgrade", Target: "Платформа", Version: "0.6.3"}
	if _, err := s.BeginDelivery(ctx, request); err != nil {
		t.Fatal(err)
	}
	for _, phase := range []string{"queued", "queued_recovery", "downloading", "preparing_host", "verifying_host", "quiescing", "snapshot", "applying", "verifying", "resuming", "reconciling", "restoring", "complete"} {
		if err := s.ObserveDelivery(ctx, DeliveryObservation{ID: request.ID, Kind: "upgrade", Phase: phase, CurrentVersion: "0.6.2"}); err != nil {
			t.Fatal(phase, err)
		}
		job, err := s.Job(ctx, request.ID)
		if err != nil || job.Actor != request.Actor || job.Result["phase"] != phase {
			t.Fatal(job, err)
		}
		want := "running"
		if phase == "complete" {
			want = "succeeded"
		}
		if job.Status != want {
			t.Fatal(job)
		}
	}
}

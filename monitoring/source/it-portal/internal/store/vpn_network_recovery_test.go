package store_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"pl/portal/internal/model"
	"pl/portal/internal/modules"
	"pl/portal/internal/providers"
	"pl/portal/internal/store"
	"pl/portal/internal/worker"
)

const exhaustedVPNPool = "module_network_pool_exhausted: Исчерпан диапазон сетей модулей."

type vpnRecoveryController struct {
	mu         sync.Mutex
	operation  modules.DeliveryOperation
	vpnRunning bool
}

func (c *vpnRecoveryController) Delivery(context.Context, string, *modules.DeliveryUpgrade) (modules.DeliveryStatus, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	op := c.operation
	return modules.DeliveryStatus{CoreAPI: 1, Operation: &op}, nil
}

func (c *vpnRecoveryController) Apply(_ context.Context, op modules.Operation) (modules.Observation, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if op.ModuleID == "ocserv" && !c.vpnRunning {
		if op.Action != "enable" || c.operation.Phase != "complete" {
			return modules.Observation{}, errors.New("the VPN is not yet installed")
		}
		c.vpnRunning = true
	}
	return modules.Observation{OperationID: op.OperationID, State: "running", Version: "fixture"}, nil
}

func seedVPNRecoveryModule(t *testing.T, s *store.Store, kind, actor, failure string) (model.ModuleInstance, model.Job) {
	t.Helper()
	ctx := context.Background()
	input := model.ModuleRequest{ModuleID: kind, Mode: "local", Name: kind + " fixture"}
	instance, job, err := s.QueueModule(ctx, actor, uuid.NewString(), "", "install", input)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	instance.LastAttempt = &now
	if failure != "" {
		instance.ObservedState, instance.Error, job.Status = "unavailable", failure, "failed"
	} else {
		instance.ObservedState, instance.Version, instance.LastSuccess, job.Status = "running", "fixture", &now, "succeeded"
	}
	job.Result = map[string]any{"instance": instance}
	if err = s.Finish(ctx, job); err != nil {
		t.Fatal(err)
	}
	return instance, job
}

func TestVPNNetworkRecoveryWaitsForCoreUpdateAndUsesOriginalActor(t *testing.T) {
	s := store.OpenTestStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	actor := "local:" + uuid.NewString()
	if _, err := s.Pool.Exec(ctx, "INSERT INTO local_users(id,username,name,admin,password_hash) VALUES($1,'fixture','Fixture',true,'fixture')", actor); err != nil {
		t.Fatal(err)
	}
	vpn, install := seedVPNRecoveryModule(t, s, "ocserv", actor, exhaustedVPNPool)
	for _, kind := range []string{"f12", "syslog"} {
		seedVPNRecoveryModule(t, s, kind, "local-admin", "")
	}

	// The ordinary state check can replace the specific setup error on the
	// instance. The original setup job remains the source of its cause.
	vpn, refresh, err := s.QueueModule(ctx, "system:modules", uuid.NewString(), vpn.ID, "refresh", model.ModuleRequest{})
	if err != nil {
		t.Fatal(err)
	}
	vpn.ObservedState, vpn.Error, refresh.Status = "unavailable", "generic observation error", "failed"
	refresh.Result = map[string]any{"instance": vpn}
	if err = s.Finish(ctx, refresh); err != nil {
		t.Fatal(err)
	}

	controller := &vpnRecoveryController{operation: modules.DeliveryOperation{
		OperationID: uuid.NewString(), Kind: "upgrade", Phase: "reconciling", StartedAt: time.Now().UTC().Format(time.RFC3339),
	}}
	manager := modules.New(s, controller)
	manager.DeliveryEnabled = true
	m := worker.New(s, providers.New(nil, ""), func(string) {})
	m.Modules = manager
	done := make(chan struct{})
	go func() { defer close(done); m.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("worker did not stop")
		}
	})

	result, err := manager.ReconcileDelivery(ctx, modules.DeliveryReconcileRequest{
		OperationID: controller.operation.OperationID, RequestID: uuid.NewString(),
	})
	if err != nil || !result.Ready || result.Instances != 2 {
		t.Fatalf("reconcile installed modules and defer the failed VPN: %+v %v", result, err)
	}
	seen, err := store.Get[model.ModuleInstance](ctx, s, "module_instance", vpn.ID)
	if err != nil || seen.LastJobID != refresh.ID || seen.ObservedState != "unavailable" {
		t.Fatalf("reconciling changed the failed install: %+v %v", seen, err)
	}

	controller.mu.Lock()
	controller.operation.Phase = "complete"
	controller.mu.Unlock()
	poll := time.NewTicker(50 * time.Millisecond)
	defer poll.Stop()
	for seen.ObservedState != "running" {
		select {
		case <-ctx.Done():
			t.Fatalf("VPN enable did not finish: %+v", seen)
		case <-poll.C:
			seen, err = store.Get[model.ModuleInstance](ctx, s, "module_instance", vpn.ID)
			if err != nil {
				t.Fatal(err)
			}
		}
	}
	job, err := s.Job(ctx, seen.LastJobID)
	if err != nil || job.Actor != actor || job.Status != "succeeded" || job.Parameters["action"] != "enable" ||
		job.IdempotencyKey != "vpn-network-recovery:"+install.ID {
		t.Fatalf("unexpected recovery job: %+v %v", job, err)
	}
	// A later ordinary core check must also accept a healthy endpointless VPN.
	controller.mu.Lock()
	controller.operation.Phase = "reconciling"
	controller.mu.Unlock()
	result, err = manager.ReconcileDelivery(ctx, modules.DeliveryReconcileRequest{
		OperationID: controller.operation.OperationID, RequestID: uuid.NewString(),
	})
	if err != nil || !result.Ready || result.Instances != 3 {
		t.Fatalf("reconcile the installed VPN with an empty endpoint: %+v %v", result, err)
	}
}

func TestVPNNetworkRecoveryRechecksActorAndDoesNotRepeat(t *testing.T) {
	s := store.OpenTestStore(t)
	ctx := context.Background()
	actor := "local:" + uuid.NewString()
	if _, err := s.Pool.Exec(ctx, "INSERT INTO local_users(id,username,name,admin,password_hash) VALUES($1,'fixture','Fixture',true,'fixture')", actor); err != nil {
		t.Fatal(err)
	}
	vpn, install := seedVPNRecoveryModule(t, s, "ocserv", actor, exhaustedVPNPool)
	recordDelivery := func(currentVersion string) {
		t.Helper()
		update, err := s.BeginDelivery(ctx, store.DeliveryRequest{ID: uuid.NewString(), Actor: "local-admin", Action: "upgrade", Target: "PL", Version: "0.9.1"})
		if err != nil {
			t.Fatal(err)
		}
		if err = s.ObserveDelivery(ctx, store.DeliveryObservation{ID: update.ID, Kind: "upgrade", Phase: "complete", CurrentVersion: currentVersion}); err != nil {
			t.Fatal(err)
		}
	}
	recordDelivery("0.9.0")
	if queued, err := s.QueueVPNNetworkRecovery(ctx, vpn, time.Time{}); err != nil || queued {
		t.Fatalf("the requested core version was not activated: queued=%t error=%v", queued, err)
	}
	recordDelivery("0.9.1")
	var attempts sync.WaitGroup
	for range 2 {
		attempts.Go(func() {
			_, err := s.QueueVPNNetworkRecovery(ctx, vpn, time.Time{})
			if err != nil && !errors.Is(err, store.ErrConflict) {
				t.Error(err)
			}
		})
	}
	attempts.Wait()
	job, err := s.Claim(ctx)
	if err != nil || job.Actor != actor || job.IdempotencyKey != "vpn-network-recovery:"+install.ID {
		t.Fatalf("expected the one recovery job backed by the stored upgrade: %+v %v", job, err)
	}
	if _, err = s.Claim(ctx); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("concurrent schedules queued another job: %v", err)
	}
	if _, err = s.Pool.Exec(ctx, "UPDATE local_users SET admin=false WHERE id=$1", actor); err != nil {
		t.Fatal(err)
	}
	controller := &vpnRecoveryController{operation: modules.DeliveryOperation{Kind: "upgrade", Phase: "complete"}}
	manager := modules.New(s, controller)
	job.Result, err = manager.Execute(ctx, job)
	if err == nil || controller.vpnRunning {
		t.Fatalf("permission loss did not prevent VPN startup: %v", err)
	}
	job.Status = "failed"
	if err = s.Finish(ctx, job); err != nil {
		t.Fatal(err)
	}
	if queued, err := s.QueueVPNNetworkRecovery(ctx, vpn, time.Time{}); err != nil || queued {
		t.Fatalf("a newer lifecycle job must supersede the original failed install: queued=%t error=%v", queued, err)
	}
	current, err := store.Get[model.ModuleInstance](ctx, s, "module_instance", vpn.ID)
	if err != nil || current.DesiredState != "disabled" || current.LastJobID != job.ID {
		t.Fatalf("unexpected state after permission loss: %+v %v", current, err)
	}
}

func TestVPNNetworkRecoveryRequiresExactOldFailure(t *testing.T) {
	s := store.OpenTestStore(t)
	ctx := context.Background()
	vpn, _ := seedVPNRecoveryModule(t, s, "ocserv", "local-admin", "module_network_pool_exhausted_extra: fixture failure")
	before := time.Now().Add(time.Second)
	if eligible, err := s.VPNInstallNeedsNetworkRecovery(ctx, vpn, before); err != nil || eligible {
		t.Fatalf("unrelated install failure must still be observed at reconciliation: eligible=%t error=%v", eligible, err)
	}
	if queued, err := s.QueueVPNNetworkRecovery(ctx, vpn, before); err != nil || queued {
		t.Fatalf("unrelated install failure must never be retried: queued=%t error=%v", queued, err)
	}
}

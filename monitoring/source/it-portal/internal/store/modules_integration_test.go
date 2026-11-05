package store

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"pl/portal/internal/model"
)

func TestQueuedModuleRefreshPreservesObservationUntilCompletion(t *testing.T) {
	for _, tc := range []struct {
		name, kind, mode, desired, observed, lastError string
	}{
		{"forms-running", "forms", "local", "enabled", "running", ""},
		{"doska-running", "doska", "local", "enabled", "running", ""},
		{"external-unavailable", "prometheus", "external", "enabled", "unavailable", "last probe failed"},
		{"forms-disabled", "forms", "local", "disabled", "disabled", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := testStore(t)
			ctx := context.Background()
			input := model.ModuleRequest{ModuleID: tc.kind, Name: "Refresh fixture", Mode: tc.mode}
			if tc.mode == "external" {
				input.Endpoint = "http://192.168.1.10:9090"
			}
			instance, install, err := s.QueueModule(ctx, "local-admin", "refresh:install", "", "install", input)
			if err != nil {
				t.Fatal(err)
			}
			lastSuccess := time.Now().UTC().Add(-time.Minute).Truncate(time.Microsecond)
			instance.DesiredState, instance.ObservedState = tc.desired, tc.observed
			instance.Version, instance.Error, instance.LastSuccess = "fixture-version", tc.lastError, &lastSuccess
			install.Status, install.Result = "succeeded", map[string]any{"instance": instance}
			if err = s.Finish(ctx, install); err != nil {
				t.Fatal(err)
			}
			before, err := Get[model.ModuleInstance](ctx, s, "module_instance", instance.ID)
			if err != nil || before.LastSuccess == nil {
				t.Fatalf("initial observation missing: %+v %v", before, err)
			}
			queued, refresh, err := s.QueueModule(ctx, "system:modules", "refresh:observe", instance.ID, "refresh", model.ModuleRequest{})
			if err != nil {
				t.Fatal(err)
			}
			stored, err := Get[model.ModuleInstance](ctx, s, "module_instance", instance.ID)
			if err != nil {
				t.Fatal(err)
			}
			for _, value := range []model.ModuleInstance{queued, stored} {
				if value.ObservedState != before.ObservedState || value.DesiredState != before.DesiredState || value.Error != before.Error || value.Version != before.Version || value.Endpoint != before.Endpoint || value.LastSuccess == nil || !value.LastSuccess.Equal(*before.LastSuccess) {
					t.Fatalf("queued refresh replaced the last observation: %+v", value)
				}
				if value.LastJobID != refresh.ID || value.LastJobID == before.LastJobID {
					t.Fatal("refresh activity is not linked to its durable job")
				}
			}
			if refresh.Status != "queued" || refresh.Parameters["action"] != "refresh" {
				t.Fatal("refresh was not queued")
			}
			_, retry, err := s.QueueModule(ctx, "system:modules", "refresh:observe", instance.ID, "refresh", model.ModuleRequest{})
			if err != nil || retry.ID != refresh.ID {
				t.Fatalf("refresh retry did not reuse its job: %+v %v", retry, err)
			}
			// A timeout before Execute returns an observation must still replace
			// stale health once the failed job is durably completed.
			refresh.Status, refresh.Error, refresh.Result = "failed", "probe timeout", map[string]any{}
			if err = s.Finish(ctx, refresh); err != nil {
				t.Fatal(err)
			}
			failed, err := Get[model.ModuleInstance](ctx, s, "module_instance", instance.ID)
			if err != nil || failed.ObservedState != "unavailable" || failed.Error == "" || failed.DesiredState != before.DesiredState || failed.LastSuccess == nil || !failed.LastSuccess.Equal(*before.LastSuccess) {
				t.Fatalf("failed refresh retained stale health or lost history: %+v %v", failed, err)
			}
		})
	}
}

func TestModuleCompletionPreservesSnapshotFreshness(t *testing.T) {
	for _, mode := range []string{"local", "external"} {
		t.Run(mode, func(t *testing.T) {
			s := testStore(t)
			ctx := context.Background()
			input := model.ModuleRequest{ModuleID: "prometheus", Name: "Metrics", Mode: mode}
			if mode == "external" {
				input.Endpoint = "http://192.168.1.10:9090"
			}
			instance, job, err := s.QueueModule(ctx, "local-admin", "freshness:install", "", "install", input)
			if err != nil {
				t.Fatal(err)
			}
			complete := func(snapshot model.Snapshot) {
				t.Helper()
				integration, err := Get[model.Integration](ctx, s, "integration", instance.IntegrationID)
				if err != nil {
					t.Fatal(err)
				}
				if err = s.ApplySnapshot(ctx, integration, snapshot, nil); err != nil {
					t.Fatal(err)
				}
				integration, err = Get[model.Integration](ctx, s, "integration", instance.IntegrationID)
				if err != nil || integration.LastSuccess == nil {
					t.Fatalf("snapshot success missing: %+v %v", integration, err)
				}
				snapshotTime := *integration.LastSuccess
				completed := snapshotTime.Add(time.Second)
				instance.LastSuccess = &completed
				instance.ObservedState = "running"
				job.Status = "succeeded"
				job.Result = map[string]any{"instance": instance}
				if err = s.Finish(ctx, job); err != nil {
					t.Fatal(err)
				}
				integration, err = Get[model.Integration](ctx, s, "integration", instance.IntegrationID)
				if err != nil || integration.LastSuccess == nil || !integration.LastSuccess.Equal(snapshotTime) {
					t.Fatalf("module completion changed snapshot timestamp: %+v %v", integration, err)
				}
			}
			snapshot := model.Snapshot{Candidates: []model.Candidate{{ExternalID: "target", Name: "Target", URL: "http://192.168.1.20:9100", Observation: &model.TargetObservation{Health: "up"}}}}
			complete(snapshot)
			candidateID := SourceID(instance.IntegrationID, "target")
			if _, err = s.ResolveCandidates(ctx, []string{candidateID}, "add", "", "local-admin"); err != nil {
				t.Fatal(err)
			}
			candidate, err := Get[model.Candidate](ctx, s, "candidate", candidateID)
			if err != nil || candidate.ResourceID == "" {
				t.Fatalf("candidate not linked: %+v %v", candidate, err)
			}
			check := func(stale bool) {
				t.Helper()
				inventory, err := s.ResourceInventory(ctx, candidate.ResourceID)
				if err != nil || len(inventory.Sources) != 1 {
					t.Fatalf("inventory: %+v %v", inventory, err)
				}
				source := inventory.Sources[0]
				if source.CandidateID != candidateID || source.IntegrationID != instance.IntegrationID || source.Stale != stale || source.Observation == nil || source.Observation.Health != "up" {
					t.Fatalf("inventory freshness: %+v; want stale=%v", source, stale)
				}
			}
			check(false)
			for n, next := range []model.Snapshot{{}, snapshot} {
				instance, job, err = s.QueueModule(ctx, "local-admin", []string{"freshness:missing", "freshness:restored"}[n], instance.ID, "refresh", model.ModuleRequest{})
				if err != nil {
					t.Fatal(err)
				}
				complete(next)
				check(n == 0)
			}
		})
	}
}

func TestModuleCreationRetryAndConcurrentAction(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	input := model.ModuleRequest{ModuleID: "prometheus", Name: "Metrics", Mode: "external", Endpoint: "http://192.168.1.10:9090"}
	var wg sync.WaitGroup
	ids := make(chan string, 8)
	jobs := make(chan string, 8)
	errs := make(chan error, 8)
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			i, j, e := s.QueueModule(ctx, "local-admin", "create:metrics", "", "install", input)
			ids <- i.ID
			jobs <- j.ID
			errs <- e
		}()
	}
	wg.Wait()
	close(ids)
	close(jobs)
	close(errs)
	for e := range errs {
		if e != nil {
			t.Fatal(e)
		}
	}
	var id, job string
	for v := range ids {
		if id == "" {
			id = v
		} else if id != v {
			t.Fatal("duplicate instance")
		}
	}
	for v := range jobs {
		if job == "" {
			job = v
		} else if job != v {
			t.Fatal("duplicate job")
		}
	}
	changed := input
	changed.Name = "Other"
	if _, _, e := s.QueueModule(ctx, "local-admin", "create:metrics", "", "install", changed); !errors.Is(e, ErrConflict) {
		t.Fatalf("payload conflict: %v", e)
	}
	if _, _, e := s.QueueModule(ctx, "local-admin", "disable:metrics", id, "disable", model.ModuleRequest{}); !errors.Is(e, ErrConflict) {
		t.Fatalf("concurrent action: %v", e)
	}
	j, e := s.Claim(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.Recover(ctx); e != nil {
		t.Fatal(e)
	}
	recovered, e := s.Claim(ctx)
	if e != nil || recovered.ID != j.ID || recovered.Parameters["recovered"] != true {
		t.Fatalf("recovery %+v %v", recovered, e)
	}
	i, e := Get[model.ModuleInstance](ctx, s, "module_instance", id)
	if e != nil {
		t.Fatal(e)
	}
	i.ObservedState = "running"
	i.Version = "3.15.0"
	recovered.Status = "succeeded"
	recovered.Result = map[string]any{"instance": i}
	if e = s.Finish(ctx, recovered); e != nil {
		t.Fatal(e)
	}
	stored, e := Get[model.ModuleInstance](ctx, s, "module_instance", id)
	if e != nil || stored.ObservedState != "running" || stored.Revision != 2 {
		t.Fatalf("atomic finish %+v %v", stored, e)
	}
	if _, _, e = s.QueueModule(ctx, "local-admin", "disable:metrics", id, "disable", model.ModuleRequest{}); e != nil {
		t.Fatal(e)
	}
}

func TestModuleLinksBackfillDuplicatesAndRemoval(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	input := model.ModuleRequest{ModuleID: "prometheus", Name: "Metrics", Mode: "external", Endpoint: "http://192.168.1.10:9090"}
	instance, job, err := s.QueueModule(ctx, "local-admin", "create:linked", "", "install", input)
	if err != nil {
		t.Fatal(err)
	}
	integration, err := Get[model.Integration](ctx, s, "integration", instance.IntegrationID)
	if err != nil || integration.ManagedModuleID != instance.ID || integration.Status != "pending" {
		t.Fatalf("integration %+v %v", integration, err)
	}
	resource, err := Get[model.Resource](ctx, s, "resource", instance.ResourceID)
	if err != nil || resource.ManagedModuleID != instance.ID || resource.URL != "/#modules?instance="+instance.ID+"&view=monitoring" {
		t.Fatalf("resource %+v %v", resource, err)
	}
	if _, _, err = s.QueueModule(ctx, "local-admin", "create:duplicate", "", "install", input); err == nil {
		t.Fatal("duplicate accepted")
	} else {
		var exists *ModuleExistsError
		if !errors.As(err, &exists) || exists.InstanceID != instance.ID {
			t.Fatalf("wrong duplicate %v", err)
		}
	}
	input.AdditionalInstance = true
	extra, _, err := s.QueueModule(ctx, "local-admin", "create:additional", "", "install", input)
	if err != nil || extra.ID == instance.ID {
		t.Fatalf("explicit additional %+v %v", extra, err)
	}
	instance.ObservedState = "running"
	job.Status = "succeeded"
	job.Result = map[string]any{"instance": instance}
	if err = s.Finish(ctx, job); err != nil {
		t.Fatal(err)
	}
	integration, err = Get[model.Integration](ctx, s, "integration", instance.IntegrationID)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.ApplySnapshot(ctx, integration, model.Snapshot{Candidates: []model.Candidate{{ExternalID: "target", Name: "Target", URL: "http://192.168.1.20:9100"}}}, nil); err != nil {
		t.Fatal(err)
	}
	candidateID := SourceID(integration.ID, "target")
	accepted, err := s.ResolveCandidates(ctx, []string{candidateID}, "add", "", "local-admin")
	if err != nil || len(accepted) != 1 {
		t.Fatalf("accept %+v %v", accepted, err)
	}
	acceptedCandidate, err := Get[model.Candidate](ctx, s, "candidate", candidateID)
	if err != nil {
		t.Fatal(err)
	}
	// Source-owned problem presentation state is removed with its source.
	problem := model.Problem{ID: "module-problem", IntegrationID: integration.ID, ExternalID: "alert", Title: "Test alert", Status: "firing"}
	if _, err = s.Save(ctx, "problem", problem.ID, 0, problem, "local-admin"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Save(ctx, "problem_visibility", problem.ID, 0, map[string]any{"hidden": true}, "local-admin"); err != nil {
		t.Fatal(err)
	}
	config := model.ProblemLinkConfig{Overrides: map[string]model.ProblemLinkOverride{problem.ID: {Mode: "disabled"}, "other-problem": {Mode: "disabled"}}, Rules: []model.ProblemLinkRule{{ID: "own-rule", IntegrationID: integration.ID}, {ID: "other-rule", IntegrationID: "other-source"}}}
	if _, err = s.Save(ctx, "problem_links", "global", 0, config, "local-admin"); err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.QueueModule(ctx, "local-admin", "remove:wrong", instance.ID, "remove", model.ModuleRequest{ConfirmName: "wrong"}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("confirmation %v", err)
	}
	removing, removeJob, err := s.QueueModule(ctx, "local-admin", "remove:linked", instance.ID, "remove", model.ModuleRequest{ConfirmName: instance.Name})
	if err != nil {
		t.Fatal(err)
	}
	// A failed physical removal retains every record and prevents re-enabling.
	removing.ObservedState = "unavailable"
	removing.Error = "Controller unavailable"
	removeJob.Status = "failed"
	removeJob.Result = map[string]any{"instance": removing}
	if err = s.Finish(ctx, removeJob); err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.QueueModule(ctx, "local-admin", "enable:removing", instance.ID, "enable", model.ModuleRequest{}); !errors.Is(err, ErrConflict) {
		t.Fatalf("revived removing module %v", err)
	}
	if _, err = s.Get(ctx, "integration", instance.IntegrationID); err != nil {
		t.Fatalf("failed removal deleted projection %v", err)
	}
	removing, removeJob, err = s.QueueModule(ctx, "local-admin", "remove:retry", instance.ID, "remove", model.ModuleRequest{ConfirmName: instance.Name})
	if err != nil {
		t.Fatal(err)
	}
	removing.ObservedState = "absent"
	removeJob.Status = "succeeded"
	removeJob.Result = map[string]any{"instance": removing}
	if err = s.Finish(ctx, removeJob); err != nil {
		t.Fatal(err)
	}
	for kind, id := range map[string]string{"module_instance": instance.ID, "integration": instance.IntegrationID, "resource": instance.ResourceID, "candidate": candidateID} {
		if _, err = s.Get(ctx, kind, id); !errors.Is(err, ErrNotFound) {
			t.Fatalf("orphan %s %v", kind, err)
		}
	}
	for _, kind := range []string{"problem", "problem_visibility"} {
		if _, err = s.Get(ctx, kind, problem.ID); !errors.Is(err, ErrNotFound) {
			t.Fatalf("orphan %s %v", kind, err)
		}
	}
	remainingLinks, err := Get[model.ProblemLinkConfig](ctx, s, "problem_links", "global")
	if err != nil || len(remainingLinks.Overrides) != 1 || remainingLinks.Rules[0].ID != "other-rule" {
		t.Fatalf("link metadata cleanup %+v %v", remainingLinks, err)
	}
	if _, err = s.Get(ctx, "resource", acceptedCandidate.ResourceID); err != nil {
		t.Fatalf("accepted target removed %v", err)
	}
	retry, retryJob, err := s.QueueModule(ctx, "local-admin", "remove:retry", instance.ID, "remove", model.ModuleRequest{ConfirmName: instance.Name})
	if err != nil || retry.ObservedState != "absent" || retryJob.ID != removeJob.ID {
		t.Fatalf("same-key removed retry %+v %+v %v", retry, retryJob, err)
	}
	_, newJob, err := s.QueueModule(ctx, "local-admin", "remove:already", instance.ID, "remove", model.ModuleRequest{ConfirmName: instance.Name})
	if err != nil || newJob.Status != "succeeded" {
		t.Fatalf("already removed %+v %v", newJob, err)
	}
	if _, _, err = s.QueueModule(ctx, "local-admin", "remove:already", instance.ID, "remove", model.ModuleRequest{ConfirmName: "wrong"}); !errors.Is(err, ErrConflict) {
		t.Fatalf("tombstone retry fingerprint %v", err)
	}
}

func TestModuleBackfillDoesNotReinstallOrClaimData(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	legacy := model.ModuleInstance{ID: "legacy-module", ModuleID: "prometheus", Name: "Legacy", Mode: "local", DesiredState: "enabled", ObservedState: "running"}
	if _, err := s.Save(ctx, "module_instance", legacy.ID, 0, legacy, "local-admin"); err != nil {
		t.Fatal(err)
	}
	if err := s.ReconcileModules(ctx); err != nil {
		t.Fatal(err)
	}
	backfilled, err := Get[model.ModuleInstance](ctx, s, "module_instance", legacy.ID)
	if err != nil || backfilled.IntegrationID == "" || backfilled.ObservedState == "running" {
		t.Fatalf("backfill %+v %v", backfilled, err)
	}
	i, err := Get[model.Integration](ctx, s, "integration", backfilled.IntegrationID)
	if err != nil || i.Status == "connected" {
		t.Fatalf("false connection %+v %v", i, err)
	}
	jobs, err := s.Jobs(ctx)
	if err != nil || len(jobs) != 0 {
		t.Fatalf("backfill installs %+v %v", jobs, err)
	}
	beforeRevision := backfilled.Revision
	if err = s.ReconcileModules(ctx); err != nil {
		t.Fatal(err)
	}
	after, err := Get[model.ModuleInstance](ctx, s, "module_instance", legacy.ID)
	if err != nil || after.Revision != beforeRevision {
		t.Fatalf("backfill not idempotent %+v %v", after, err)
	}
}

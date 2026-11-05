package store

import (
	"context"
	"errors"
	"pl/portal/internal/model"
	"testing"
)

func TestPrometheusDraftRevisionAndApplyQueueFreeze(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	instance, job, err := s.QueueModule(ctx, "local-admin", "configuration:create", "", "install", model.ModuleRequest{ModuleID: "prometheus", Name: "Metrics", Mode: "local"})
	if err != nil {
		t.Fatal(err)
	}
	// Complete only the fixture's lifecycle job; no host calls are involved.
	instance.ObservedState = "running"
	job.Status = "succeeded"
	job.Result = map[string]any{"instance": instance}
	if err = s.Finish(ctx, job); err != nil {
		t.Fatal(err)
	}
	draft := model.DefaultPrometheusConfiguration()
	saved, err := s.SavePrometheusDraft(ctx, instance.ID, "local-admin", draft)
	if err != nil {
		t.Fatal(err)
	}
	if saved.PrometheusDraft.Revision != 1 || saved.PrometheusApplied != nil {
		t.Fatal("save changed applied state")
	}
	if _, err = s.SavePrometheusDraft(ctx, instance.ID, "local-admin", draft); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale save %v", err)
	}
	_, apply, err := s.QueueModule(ctx, "local-admin", "configuration:apply", instance.ID, "configure", model.ModuleRequest{ConfigurationRevision: 1})
	if err != nil {
		t.Fatal(err)
	}
	_, retry, err := s.QueueModule(ctx, "local-admin", "configuration:apply", instance.ID, "configure", model.ModuleRequest{ConfigurationRevision: 1})
	if err != nil || retry.ID != apply.ID {
		t.Fatalf("apply retry duplicated: %v", err)
	}
	draft.Revision = 1
	draft.Global.ScrapeInterval = "30s"
	if _, err = s.SavePrometheusDraft(ctx, instance.ID, "local-admin", draft); !errors.Is(err, ErrConflict) {
		t.Fatalf("draft edited during apply %v", err)
	}
	frozen, err := Decode[model.PrometheusConfiguration](encode(apply.Parameters["configuration"]))
	if err != nil || frozen.Global.ScrapeInterval != "15s" || frozen.Revision != 1 {
		t.Fatalf("queue did not freeze draft: %+v %v", frozen, err)
	}
}

func TestPrometheusRetryReusesFrozenOperationAndKeepsActor(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	instance, install, err := s.QueueModule(ctx, "local-admin", "config:retry:create", "", "install", model.ModuleRequest{ModuleID: "prometheus", Name: "Retry", Mode: "local"})
	if err != nil {
		t.Fatal(err)
	}
	instance.ObservedState = "running"
	install.Status = "succeeded"
	install.Result = map[string]any{"instance": instance}
	if err = s.Finish(ctx, install); err != nil {
		t.Fatal(err)
	}
	if _, err = s.SavePrometheusDraft(ctx, instance.ID, "local-admin", model.DefaultPrometheusConfiguration()); err != nil {
		t.Fatal(err)
	}
	instance, job, err := s.QueueModule(ctx, "local-admin", "config:retry:apply", instance.ID, "configure", model.ModuleRequest{ConfigurationRevision: 1})
	if err != nil {
		t.Fatal(err)
	}
	instance.ObservedState = "unavailable"
	instance.ConfigurationError = "Результат reload не подтверждён"
	job.Status = "failed"
	job.Error = instance.ConfigurationError
	job.Result = map[string]any{"instance": instance}
	if err = s.Finish(ctx, job); err != nil {
		t.Fatal(err)
	}
	if _, _, e := s.QueueModule(ctx, "local-admin", "config:retry:unsafe-new", instance.ID, "configure", model.ModuleRequest{ConfigurationRevision: 1}); !errors.Is(e, ErrConflict) {
		t.Fatalf("new apply replaced unconfirmed operation: %v", e)
	}
	if _, _, err = s.RetryPrometheusConfiguration(ctx, instance.ID, "another-admin", job.ID); !errors.Is(err, ErrConflict) {
		t.Fatalf("different actor retry %v", err)
	}
	// Draft changes cannot mutate the failed operation's frozen input.
	next := model.DefaultPrometheusConfiguration()
	next.Revision = 1
	next.Global.ScrapeInterval = "30s"
	if _, err = s.SavePrometheusDraft(ctx, instance.ID, "local-admin", next); err != nil {
		t.Fatal(err)
	}
	restored, retry, err := s.RetryPrometheusConfiguration(ctx, instance.ID, "local-admin", job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if retry.ID != job.ID || retry.Status != "queued" || restored.LastJobID != job.ID || restored.ObservedState != "pending" {
		t.Fatalf("retry changed operation: %+v", retry)
	}
	frozen, err := Decode[model.PrometheusConfiguration](encode(retry.Parameters["configuration"]))
	if err != nil || frozen.Revision != 1 || frozen.Global.ScrapeInterval != "15s" {
		t.Fatalf("retry changed frozen configuration: %+v %v", frozen, err)
	}
	_, same, err := s.RetryPrometheusConfiguration(ctx, instance.ID, "local-admin", job.ID)
	if err != nil || same.ID != job.ID {
		t.Fatalf("retry was not idempotent: %v", err)
	}
}

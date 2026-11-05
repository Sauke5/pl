package store

import (
	"context"
	"errors"
	"testing"

	"pl/portal/internal/model"
)

func wikiConnectionInput(endpoint, ips string) model.ModuleRequest {
	return model.ModuleRequest{ModuleID: "bookstack", Name: "Remote Wiki", Mode: "external", Endpoint: endpoint,
		Config: map[string]string{"connection_origin": endpoint, "connection_ips": ips, "app_url": "https://pl.example/wiki"}}
}

func finishWikiStoreOperation(t *testing.T, s *Store, instance model.ModuleInstance, job model.Job, state string) {
	t.Helper()
	instance.ObservedState = state
	job.Status, job.Result = "succeeded", map[string]any{"instance": instance}
	if err := s.Finish(context.Background(), job); err != nil {
		t.Fatal(err)
	}
}

func TestBookStackAliasIsExclusiveAcrossLocalExternalDisabledAndAdditionalInstances(t *testing.T) {
	for _, mode := range []string{"local", "external"} {
		t.Run(mode, func(t *testing.T) {
			s, ctx := testStore(t), context.Background()
			first := wikiConnectionInput("https://wiki.example", `["10.20.30.40"]`)
			first.Mode = mode
			if mode == "local" {
				first.Endpoint, first.Config = "", nil
			}
			instance, job, err := s.QueueModule(ctx, "local-admin", "wiki:singleton:first", "", "install", first)
			if err != nil {
				t.Fatal(err)
			}
			finishWikiStoreOperation(t, s, instance, job, "running")
			disabled, disable, err := s.QueueModule(ctx, "local-admin", "wiki:singleton:disable", instance.ID, "disable", model.ModuleRequest{})
			if err != nil {
				t.Fatal(err)
			}
			finishWikiStoreOperation(t, s, disabled, disable, "disabled")
			second := wikiConnectionInput("https://other.example", `["10.20.30.41"]`)
			if mode == "external" {
				second.Mode, second.Endpoint, second.Config = "local", "", nil
			}
			for _, additional := range []bool{false, true} {
				second.AdditionalInstance = additional
				_, _, err = s.QueueModule(ctx, "local-admin", "wiki:singleton:second", "", "install", second)
				var exists *ModuleExistsError
				if !errors.As(err, &exists) || exists.InstanceID != instance.ID {
					t.Fatal("disabled alias owner was bypassed by changing mode or additional_instance", err)
				}
			}
		})
	}
}

func TestBookStackConnectionReconnectIsAtomicRevisionCheckedAndIndependentOfLocalState(t *testing.T) {
	s, ctx := testStore(t), context.Background()
	input := wikiConnectionInput("https://old.example:8443", `["10.20.30.40"]`)
	instance, job, err := s.QueueModule(ctx, "local-admin", "wiki:connect:first", "", "install", input)
	if err != nil {
		t.Fatal(err)
	}
	// Retrying the same request must not see mutations of caller-owned Config.
	if again, retry, err := s.QueueModule(ctx, "local-admin", "wiki:connect:first", "", "install", input); err != nil || again.ID != instance.ID || retry.ID != job.ID {
		t.Fatal("registration retry lost idempotency", err)
	}
	finishWikiStoreOperation(t, s, instance, job, "running")
	instance, err = Get[model.ModuleInstance](ctx, s, "module_instance", instance.ID)
	if err != nil {
		t.Fatal(err)
	}
	replacement := wikiConnectionInput("https://new.example:9443", `["192.168.20.10"]`)
	replacement.ConnectionRevision = instance.Revision + 1
	if _, _, err = s.QueueModule(ctx, "local-admin", "wiki:reconnect:stale", instance.ID, "reconnect", replacement); !errors.Is(err, ErrConflict) {
		t.Fatal("stale revision changed the connection", err)
	}
	unchanged, err := Get[model.Integration](ctx, s, "integration", instance.IntegrationID)
	if err != nil || unchanged.URL != input.Endpoint || unchanged.Config["connection_ips"] != input.Config["connection_ips"] {
		t.Fatal("failed reconnect partially changed source binding", err)
	}
	replacement.ConnectionRevision = instance.Revision
	changed, operation, err := s.QueueModule(ctx, "local-admin", "wiki:reconnect:replace", instance.ID, "reconnect", replacement)
	if err != nil || changed.ID != instance.ID || changed.IntegrationID != instance.IntegrationID || changed.ResourceID != instance.ResourceID || changed.Endpoint != replacement.Endpoint || changed.ObservedState != "pending" {
		t.Fatal("reconnect did not preserve connection identities or block access until observation", changed, err)
	}
	canonical, err := Get[model.Integration](ctx, s, "integration", instance.IntegrationID)
	if err != nil || canonical.URL != replacement.Endpoint || canonical.Config["connection_origin"] != replacement.Endpoint || canonical.Config["connection_ips"] != replacement.Config["connection_ips"] || canonical.Config["module_mode"] != "external" || canonical.SecretRef != "" {
		t.Fatal("reconnect did not atomically replace persisted binding", canonical, err)
	}
	if _, _, err := s.QueueModule(ctx, "local-admin", "wiki:reconnect:concurrent", instance.ID, "disable", model.ModuleRequest{}); !errors.Is(err, ErrConflict) {
		t.Fatal("concurrent lifecycle bypassed connection operation", err)
	}
	if again, retry, err := s.QueueModule(ctx, "local-admin", "wiki:reconnect:replace", instance.ID, "reconnect", replacement); err != nil || again.ID != changed.ID || retry.ID != operation.ID {
		t.Fatal("reconnect retry created another operation", err)
	}
	finishWikiStoreOperation(t, s, changed, operation, "running")
	if err := s.ReconcileModules(ctx); err != nil {
		t.Fatal(err)
	}
	canonical, err = Get[model.Integration](ctx, s, "integration", instance.IntegrationID)
	if err != nil || canonical.Config["connection_ips"] != replacement.Config["connection_ips"] || canonical.Config["app_url"] != "https://pl.example/wiki" {
		t.Fatal("reconciliation destroyed external binding", canonical, err)
	}
	resource, err := Get[model.Resource](ctx, s, "resource", instance.ResourceID)
	if err != nil || resource.URL != "/wiki/" {
		t.Fatal("resource left the Pl native route", resource.URL, err)
	}
	removed, removal, err := s.QueueModule(ctx, "local-admin", "wiki:connection:remove", instance.ID, "remove", model.ModuleRequest{ConfirmName: instance.Name})
	if err != nil {
		t.Fatal(err)
	}
	finishWikiStoreOperation(t, s, removed, removal, "absent")
	for kind, id := range map[string]string{"module_instance": instance.ID, "integration": instance.IntegrationID, "resource": instance.ResourceID} {
		if _, err := Get[map[string]any](ctx, s, kind, id); !errors.Is(err, ErrNotFound) {
			t.Fatal("removal retained connection state", kind, err)
		}
	}
	if next, _, err := s.QueueModule(ctx, "local-admin", "wiki:connection:fresh-host", "", "install", input); err != nil || next.ID == instance.ID {
		t.Fatal("removed connection or local installation blocked a new host", err)
	}
}

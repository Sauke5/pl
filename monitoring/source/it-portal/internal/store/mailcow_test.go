package store

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"pl/portal/internal/model"
)

func mailcowStoreFixture(t *testing.T, s *Store, name string) (model.ModuleInstance, model.Integration) {
	t.Helper()
	ctx := context.Background()
	instance, job, err := s.QueueModule(ctx, "test-admin", "mailcow:install:"+name, "", "install", model.ModuleRequest{ModuleID: "mailcow", Mode: "external", Name: name, Endpoint: "https://mailcow.invalid", SecretRef: "file:mailcow-private-reference", AdditionalInstance: true})
	if err != nil {
		t.Fatal(err)
	}
	instance.ObservedState = "running"
	job.Status, job.Result = "succeeded", map[string]any{"instance": instance}
	if err = s.Finish(ctx, job); err != nil {
		t.Fatal(err)
	}
	instance, err = Get[model.ModuleInstance](ctx, s, "module_instance", instance.ID)
	if err != nil {
		t.Fatal(err)
	}
	source, err := Get[model.Integration](ctx, s, "integration", instance.IntegrationID)
	if err != nil {
		t.Fatal(err)
	}
	return instance, source
}
func mailcowStoreEnable(t *testing.T, s *Store, instance model.ModuleInstance, names ...string) model.Integration {
	t.Helper()
	snapshot, err := s.MailcowSnapshot(context.Background(), instance.ID)
	if err != nil {
		t.Fatal(err)
	}
	settings := model.MailcowSettings{Revision: snapshot.Revision, Groups: map[string]model.MailcowGroupSettings{}}
	for name, value := range snapshot.Groups {
		settings.Groups[name] = model.MailcowGroupSettings{Enabled: value.Enabled, IntervalSeconds: value.IntervalSeconds}
	}
	for _, name := range names {
		value := settings.Groups[name]
		value.Enabled = true
		settings.Groups[name] = value
	}
	if err = s.SaveMailcowSettings(context.Background(), instance.ID, "test-admin", settings); err != nil {
		t.Fatal(err)
	}
	source, err := Get[model.Integration](context.Background(), s, "integration", instance.IntegrationID)
	if err != nil {
		t.Fatal(err)
	}
	return source
}
func mailcowStoreDataEqual(t *testing.T, got, want json.RawMessage) {
	t.Helper()
	var actual, expected any
	if err := json.Unmarshal(got, &actual); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(want, &expected); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actual, expected) {
		t.Fatalf("cache changed: got=%s want=%s", got, want)
	}
}
func TestMailcowStoreDefaultReadIsCacheOnlyAndHidesSecret(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	instance, source := mailcowStoreFixture(t, s, "Default")
	for attempt := 0; attempt < 2; attempt++ {
		snapshot, err := s.MailcowSnapshot(ctx, instance.ID)
		if err != nil {
			t.Fatal(err)
		}
		if !snapshot.Enabled || snapshot.Revision != source.Revision || len(snapshot.Groups) != 6 {
			t.Fatalf("bad source projection: %+v", snapshot)
		}
		for name, value := range snapshot.Groups {
			if value.Enabled || value.IntervalSeconds != 60 || value.Status != "disabled" || value.Data != nil || value.LastAttempt != nil || value.LastSuccess != nil {
				t.Fatalf("group polled before opt-in: %s %+v", name, value)
			}
		}
		raw, err := json.Marshal(snapshot)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(raw), source.SecretRef) || strings.Contains(string(raw), "secret_ref") {
			t.Fatal("GET snapshot exposes secret reference")
		}
	}
	if _, err := s.Get(ctx, "mailcow_snapshot", source.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("read created a polling/cache write: %v", err)
	}
}
func TestMailcowStoreSettingsRevisionAndFullValidation(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	instance, source := mailcowStoreFixture(t, s, "Settings")
	valid := model.MailcowSettings{Revision: source.Revision, Groups: model.MailcowGroupConfig(nil)}
	for _, mutate := range []func(*model.MailcowSettings){
		func(v *model.MailcowSettings) { delete(v.Groups, "queue") },
		func(v *model.MailcowSettings) {
			delete(v.Groups, "queue")
			v.Groups["unknown"] = model.MailcowGroupSettings{IntervalSeconds: 60}
		},
		func(v *model.MailcowSettings) {
			v.Groups["queue"] = model.MailcowGroupSettings{Enabled: true, IntervalSeconds: 4}
		},
		func(v *model.MailcowSettings) {
			v.Groups["queue"] = model.MailcowGroupSettings{Enabled: true, IntervalSeconds: 86401}
		},
	} {
		candidate := model.MailcowSettings{Revision: valid.Revision, Groups: model.MailcowGroupConfig(nil)}
		mutate(&candidate)
		if err := s.SaveMailcowSettings(ctx, instance.ID, "test-admin", candidate); !errors.Is(err, ErrInvalid) {
			t.Fatalf("invalid update admitted: %v", err)
		}
	}
	for index, name := range model.MailcowGroups() {
		valid.Groups[name] = model.MailcowGroupSettings{Enabled: index%2 == 0, IntervalSeconds: 5 + index*11}
	}
	if err := s.SaveMailcowSettings(ctx, instance.ID, "test-admin", valid); err != nil {
		t.Fatal(err)
	}
	snapshot, err := s.MailcowSnapshot(ctx, instance.ID)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Revision != valid.Revision+1 {
		t.Fatalf("unexpected revision %d", snapshot.Revision)
	}
	for name, want := range valid.Groups {
		got := snapshot.Groups[name]
		if got.Enabled != want.Enabled || got.IntervalSeconds != want.IntervalSeconds {
			t.Fatalf("partial settings write: %s %+v", name, got)
		}
	}
	if err = s.SaveMailcowSettings(ctx, instance.ID, "test-admin", valid); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale revision accepted: %v", err)
	}
	current, err := Get[model.Integration](ctx, s, "integration", source.ID)
	if err != nil {
		t.Fatal(err)
	}
	if current.SecretRef != source.SecretRef || current.Config["module_mode"] != "external" || current.Revision != snapshot.Revision {
		t.Fatalf("settings changed connection or stale request wrote state: %+v", current)
	}
}
func TestMailcowStorePerGroupSuccessErrorAndRecoveryAreAtomic(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	instance, _ := mailcowStoreFixture(t, s, "Atomic")
	source := mailcowStoreEnable(t, s, instance, "inventory", "mailboxes", "storage")
	started := time.Now().UTC().Add(-time.Minute)
	inventory := json.RawMessage(`{"version":"2026-10","mailboxes":3,"messages":6,"used_bytes":90}`)
	storage := json.RawMessage(`{"used_percent":69,"used_display":"78G","total_display":"113G"}`)
	if err := s.ApplyMailcowGroup(ctx, source, "inventory", inventory, "", started); err != nil {
		t.Fatal(err)
	}
	if err := s.ApplyMailcowGroup(ctx, source, "storage", storage, "", started); err != nil {
		t.Fatal(err)
	}
	before, err := s.MailcowSnapshot(ctx, instance.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.ApplyMailcowGroup(ctx, source, "inventory", json.RawMessage(`{"error":"private-upstream-body"}`), "network", started.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if err = s.ApplyMailcowGroup(ctx, source, "mailboxes", nil, "unsupported", started.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	after, err := s.MailcowSnapshot(ctx, instance.ID)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(after)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "private-upstream-body") || strings.Contains(string(encoded), source.SecretRef) {
		t.Fatal("error payload or secret reference entered GET snapshot")
	}
	old, failed := before.Groups["inventory"], after.Groups["inventory"]
	if failed.Status != "error" || failed.LastAttemptStatus != "error" || failed.ErrorCode != "network" || failed.LastSuccess == nil || !failed.LastSuccess.Equal(*old.LastSuccess) || failed.LastAttempt == nil || !failed.LastAttempt.Equal(started.Add(time.Second)) {
		t.Fatalf("failed attempt lost success provenance: %+v", failed)
	}
	mailcowStoreDataEqual(t, failed.Data, inventory)
	healthy := after.Groups["storage"]
	if healthy.Status != "ok" || !healthy.LastSuccess.Equal(*before.Groups["storage"].LastSuccess) {
		t.Fatalf("other group touched by failure: %+v", healthy)
	}
	mailcowStoreDataEqual(t, healthy.Data, storage)
	unsupported := after.Groups["mailboxes"]
	if unsupported.Status != "unsupported" || (len(unsupported.Data) != 0 && string(unsupported.Data) != "null") || unsupported.LastSuccess != nil {
		t.Fatalf("unsupported generated business zeros: %+v", unsupported)
	}
	recovered := json.RawMessage(`{"version":"2026-10","mailboxes":3,"messages":7,"used_bytes":110}`)
	if err = s.ApplyMailcowGroup(ctx, source, "inventory", recovered, "", started.Add(2*time.Second)); err != nil {
		t.Fatal(err)
	}
	snapshot, err := s.MailcowSnapshot(ctx, instance.ID)
	if err != nil {
		t.Fatal(err)
	}
	value := snapshot.Groups["inventory"]
	if value.Status != "ok" || value.ErrorCode != "" || value.LastAttemptStatus != "success" || value.LastSuccess == nil || value.LastSuccess.Before(*old.LastSuccess) {
		t.Fatalf("recovery incomplete: %+v", value)
	}
	mailcowStoreDataEqual(t, value.Data, recovered)
	// An older attempt must not replace the successful result or its timestamps.
	if err = s.ApplyMailcowGroup(ctx, source, "inventory", inventory, "", started); !errors.Is(err, ErrConflict) {
		t.Fatalf("older attempt accepted: %v", err)
	}
	unchanged, err := s.MailcowSnapshot(ctx, instance.ID)
	if err != nil {
		t.Fatal(err)
	}
	mailcowStoreDataEqual(t, unchanged.Groups["inventory"].Data, recovered)
}
func TestMailcowStoreRejectsInflightAfterSettingsAndLifecycle(t *testing.T) {
	for _, action := range []string{"group-disabled", "interval-changed", "disable", "remove"} {
		t.Run(action, func(t *testing.T) {
			s := testStore(t)
			ctx := context.Background()
			instance, _ := mailcowStoreFixture(t, s, action)
			source := mailcowStoreEnable(t, s, instance, "queue")
			data := json.RawMessage(`{"messages_observed":2,"empty_ambiguous":false}`)
			started := time.Now().UTC().Add(-time.Minute)
			if err := s.ApplyMailcowGroup(ctx, source, "queue", data, "", started); err != nil {
				t.Fatal(err)
			}
			if action == "group-disabled" || action == "interval-changed" {
				settings := model.MailcowSettings{Revision: source.Revision, Groups: model.MailcowGroupConfig(source.Config)}
				queue := settings.Groups["queue"]
				if action == "group-disabled" {
					queue.Enabled = false
				} else {
					queue.IntervalSeconds = 120
				}
				settings.Groups["queue"] = queue
				if err := s.SaveMailcowSettings(ctx, instance.ID, "test-admin", settings); err != nil {
					t.Fatal(err)
				}
			} else {
				request := model.ModuleRequest{}
				if action == "remove" {
					request.ConfirmName = instance.Name
				}
				if _, _, err := s.QueueModule(ctx, "test-admin", "mailcow:"+action, instance.ID, action, request); err != nil {
					t.Fatal(err)
				}
			}
			if err := s.ApplyMailcowGroup(ctx, source, "queue", json.RawMessage(`{"messages_observed":99}`), "", started.Add(time.Second)); !errors.Is(err, ErrConflict) {
				t.Fatalf("inflight result accepted after %s: %v", action, err)
			}
			snapshot, err := s.MailcowSnapshot(ctx, instance.ID)
			if err != nil {
				t.Fatal(err)
			}
			mailcowStoreDataEqual(t, snapshot.Groups["queue"].Data, data)
		})
	}
}
func TestMailcowStoreRemovalDeletesOnlyOwnedCacheAndRejectsLateResult(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	instance, _ := mailcowStoreFixture(t, s, "Remove")
	other, _ := mailcowStoreFixture(t, s, "Keep")
	source := mailcowStoreEnable(t, s, instance, "queue")
	otherSource := mailcowStoreEnable(t, s, other, "queue")
	data := json.RawMessage(`{"messages_observed":1}`)
	started := time.Now().UTC().Add(-time.Minute)
	for _, current := range []model.Integration{source, otherSource} {
		if err := s.ApplyMailcowGroup(ctx, current, "queue", data, "", started); err != nil {
			t.Fatal(err)
		}
	}
	removing, job, err := s.QueueModule(ctx, "test-admin", "mailcow:remove-owned", instance.ID, "remove", model.ModuleRequest{ConfirmName: instance.Name})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Get(ctx, "mailcow_snapshot", source.ID); err != nil {
		t.Fatal("cache removed before lifecycle completion", err)
	}
	removing.ObservedState = "absent"
	job.Status, job.Result = "succeeded", map[string]any{"instance": removing}
	if err = s.Finish(ctx, job); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Get(ctx, "mailcow_snapshot", source.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("owned cache survived removal: %v", err)
	}
	remaining, err := s.MailcowSnapshot(ctx, other.ID)
	if err != nil {
		t.Fatal("other source removed", err)
	}
	mailcowStoreDataEqual(t, remaining.Groups["queue"].Data, data)
	if err = s.ApplyMailcowGroup(ctx, source, "queue", data, "", started.Add(time.Second)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("late result recreated removed source: %v", err)
	}
	if _, err = s.Get(ctx, "mailcow_snapshot", source.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("late result recreated cache: %v", err)
	}
}
func TestMailcowStoreFreshnessDerivedAtReadWithoutRewritingCache(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	instance, _ := mailcowStoreFixture(t, s, "Stale")
	source := mailcowStoreEnable(t, s, instance, "inventory")
	data := json.RawMessage(`{"mailboxes":3,"messages":6}`)
	if err := s.ApplyMailcowGroup(ctx, source, "inventory", data, "", time.Now().UTC().Add(-time.Minute)); err != nil {
		t.Fatal(err)
	}
	old := time.Now().UTC().Add(-time.Hour)
	if _, err := s.Pool.Exec(ctx, `UPDATE documents SET body=jsonb_set(body,'{groups,inventory,last_success_at}',to_jsonb($1::text)) WHERE kind='mailcow_snapshot' AND id=$2`, old.Format(time.RFC3339Nano), source.ID); err != nil {
		t.Fatal(err)
	}
	var before, after []byte
	if err := s.Pool.QueryRow(ctx, "SELECT body FROM documents WHERE kind='mailcow_snapshot' AND id=$1", source.ID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	snapshot, err := s.MailcowSnapshot(ctx, instance.ID)
	if err != nil {
		t.Fatal(err)
	}
	value := snapshot.Groups["inventory"]
	if value.Status != "stale" || !value.Stale || value.LastSuccess == nil || !value.LastSuccess.Equal(old) {
		t.Fatalf("stale provenance lost: %+v", value)
	}
	mailcowStoreDataEqual(t, value.Data, data)
	if err = s.Pool.QueryRow(ctx, "SELECT body FROM documents WHERE kind='mailcow_snapshot' AND id=$1", source.ID).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("GET persisted derived freshness")
	}
}

package store

import (
	"context"
	"errors"
	"pl/portal/internal/model"
	"strings"
	"testing"
)

func TestSFTPGoApplyFreezesMatchingPreparedPlan(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	instance, install, err := s.QueueModule(ctx, "admin", "sftpgo:install", "", "install", model.ModuleRequest{ModuleID: "sftpgo", Mode: "local", Name: "Files"})
	if err != nil {
		t.Fatal(err)
	}
	instance.ObservedState = "running"
	install.Status, install.Result = "succeeded", map[string]any{"instance": instance}
	if err = s.Finish(ctx, install); err != nil {
		t.Fatal(err)
	}
	first := model.SFTPGoConfiguration{Ref: "123e4567-e89b-42d3-a456-426614174000", Revision: 1, Hash: strings.Repeat("a", 64), ListenIP: "127.0.0.1", Port: 2022}
	if _, err = s.SaveSFTPGoDraft(ctx, instance.ID, "admin", first); err != nil {
		t.Fatal(err)
	}
	// Both prepared plans were based on applied revision zero. Only the latest
	// persisted private-plan reference can be queued, even with equal revisions.
	second := first
	second.Ref = "223e4567-e89b-42d3-a456-426614174000"
	second.Port = 2222
	if _, err = s.SaveSFTPGoDraft(ctx, instance.ID, "admin", second); err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.QueueModule(ctx, "admin", "sftpgo:stale", instance.ID, "configure", model.ModuleRequest{ConfigurationRevision: 1, Config: map[string]string{"configuration_ref": first.Ref}}); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale plan queued: %v", err)
	}
	_, job, err := s.QueueModule(ctx, "admin", "sftpgo:apply", instance.ID, "configure", model.ModuleRequest{ConfigurationRevision: 1, Config: map[string]string{"configuration_ref": second.Ref, "request_hash": strings.Repeat("b", 64)}})
	if err != nil {
		t.Fatal(err)
	}
	if job.Parameters["configuration_ref"] != second.Ref || job.Parameters["configuration_revision"] != int64(1) {
		t.Fatal("job did not freeze matching plan")
	}
	if _, err = s.SaveSFTPGoDraft(ctx, instance.ID, "admin", first); !errors.Is(err, ErrConflict) {
		t.Fatalf("draft replaced during apply: %v", err)
	}
	if _, same, exists, e := s.SFTPGoConfigurationJob(ctx, instance.ID, "admin", "sftpgo:apply", strings.Repeat("b", 64)); e != nil || !exists || same.ID != job.ID {
		t.Fatalf("retry not found: %v", e)
	}
	if _, _, _, e := s.SFTPGoConfigurationJob(ctx, instance.ID, "admin", "sftpgo:apply", strings.Repeat("c", 64)); !errors.Is(e, ErrConflict) {
		t.Fatal("changed retry accepted")
	}
}

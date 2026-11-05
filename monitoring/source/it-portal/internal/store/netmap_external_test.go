package store

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"pl/portal/internal/connectorcredentials"
	"pl/portal/internal/model"
)

func TestNetMapExternalCredentialIsolationAliasLifecycleAndNewHost(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	codec, err := connectorcredentials.New(bytes.Repeat([]byte{11}, 32))
	if err != nil {
		t.Fatal(err)
	}
	secret := strings.Repeat("07", 32)
	input := model.ModuleRequest{ModuleID: "netmap", Mode: "external", Name: "Remote NetMap", Endpoint: "https://netmap.example", Config: map[string]string{"platform_origin": "https://pl.example"}}
	seals := 0
	prepare := func(endpoint, value string) *ModuleCredential {
		return &ModuleCredential{Origin: endpoint, ApprovedIPs: []string{"10.20.30.40"}, Fingerprint: codec.Fingerprint(value), Seal: func(id string) ([]byte, error) { seals++; return codec.Seal(id, endpoint, value) }}
	}
	credential := prepare(input.Endpoint, secret)
	instance, job, err := s.QueueModuleWithCredential(ctx, "admin", "netmap:external:create", "", "install", input, credential)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := s.IntegrationCredential(ctx, instance.IntegrationID)
	if err != nil {
		t.Fatal(err)
	}
	opened, err := codec.Open(instance.IntegrationID, input.Endpoint, stored.Envelope)
	if err != nil || opened != secret || bytes.Contains(stored.Envelope, []byte(secret)) {
		t.Fatal("gateway key was not encrypted and bound")
	}
	if _, err := codec.Open("another-integration", input.Endpoint, stored.Envelope); err == nil {
		t.Fatal("envelope crossed integration identity")
	}
	again, retry, err := s.QueueModuleWithCredential(ctx, "admin", "netmap:external:create", "", "install", input, credential)
	if err != nil || again.ID != instance.ID || retry.ID != job.ID || seals != 1 {
		t.Fatal("credential retry was not atomic/idempotent", err, seals)
	}
	if _, _, err := s.QueueModuleWithCredential(ctx, "admin", "netmap:external:create", "", "install", input, prepare(input.Endpoint, strings.Repeat("08", 32))); !errors.Is(err, ErrConflict) {
		t.Fatal("changed key reused request identity", err)
	}
	local := model.ModuleRequest{ModuleID: "netmap", Mode: "local", Name: "Local NetMap"}
	if _, _, err := s.QueueModule(ctx, "admin", "netmap:local:collision", "", "install", local); err == nil {
		t.Fatal("local and remote simultaneously acquired /netmap/")
	}
	finish := func(value model.ModuleInstance, operation model.Job, state string) {
		t.Helper()
		value.ObservedState = state
		operation.Status = "succeeded"
		operation.Result = map[string]any{"instance": value}
		if err := s.Finish(ctx, operation); err != nil {
			t.Fatal(err)
		}
	}
	finish(instance, job, "running")
	integration, err := Get[model.Integration](ctx, s, "integration", instance.IntegrationID)
	if err != nil || integration.SecretRef != "managed:"+integration.ID || integration.Config["platform_origin"] != "https://pl.example" || integration.Config["module_mode"] != "external" {
		t.Fatal("credential binding/config lost in projection", err)
	}
	rows, err := s.Pool.Query(ctx, "SELECT body::text FROM documents UNION ALL SELECT body::text FROM jobs UNION ALL SELECT body::text FROM audit_events")
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var body string
		if err = rows.Scan(&body); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(body, secret) || strings.Contains(body, credential.Fingerprint) {
			t.Fatal("gateway key/fingerprint leaked into public state")
		}
	}
	rows.Close()
	if rows.Err() != nil {
		t.Fatal(rows.Err())
	}
	disabled, operation, err := s.QueueModule(ctx, "admin", "netmap:external:disable", instance.ID, "disable", model.ModuleRequest{})
	if err != nil {
		t.Fatal(err)
	}
	finish(disabled, operation, "disabled")
	retained, err := s.IntegrationCredential(ctx, instance.IntegrationID)
	if err != nil || !bytes.Equal(stored.Envelope, retained.Envelope) {
		t.Fatal("disable changed external credentials", err)
	}
	if _, _, err := s.QueueModule(ctx, "admin", "netmap:local:disabled-collision", "", "install", local); err == nil {
		t.Fatal("disabled connection released its alias before removal")
	}
	removed, operation, err := s.QueueModule(ctx, "admin", "netmap:external:remove", instance.ID, "remove", model.ModuleRequest{ConfirmName: input.Name})
	if err != nil {
		t.Fatal(err)
	}
	finish(removed, operation, "absent")
	if _, err = s.IntegrationCredential(ctx, instance.IntegrationID); !errors.Is(err, ErrNotFound) {
		t.Fatal("removed connection retained its key", err)
	}
	input.Endpoint = "https://replacement.example"
	replacement, _, err := s.QueueModuleWithCredential(ctx, "admin", "netmap:external:replacement", "", "install", input, prepare(input.Endpoint, strings.Repeat("09", 32)))
	if err != nil || replacement.ID == instance.ID || replacement.IntegrationID == instance.IntegrationID {
		t.Fatal("removed host prevented a fresh connection", err)
	}
}

func TestNetMapExternalRequiresCredentialAndEnableCannotStealAlias(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	input := model.ModuleRequest{ModuleID: "netmap", Mode: "external", Name: "Remote", Endpoint: "https://netmap.example"}
	if _, _, err := s.QueueModule(ctx, "admin", "netmap:missing:key", "", "install", input); !errors.Is(err, ErrInvalid) {
		t.Fatal("external NetMap accepted without encrypted credential", err)
	}
	local, job, err := s.QueueModule(ctx, "admin", "netmap:local:legacy", "", "install", model.ModuleRequest{ModuleID: "netmap", Mode: "local", Name: "Local"})
	if err != nil {
		t.Fatal(err)
	}
	local.DesiredState, local.ObservedState = "disabled", "disabled"
	job.Status, job.Result = "succeeded", map[string]any{"instance": local}
	if err = s.Finish(ctx, job); err != nil {
		t.Fatal(err)
	}
	// A conflicting legacy document must not turn an enable into ambiguous routing.
	foreign := model.ModuleInstance{ID: "44444444-4444-4444-8444-444444444444", ModuleID: "netmap", Mode: "external", DesiredState: "enabled", ObservedState: "running"}
	if _, err = s.Save(ctx, "module_instance", foreign.ID, 0, foreign, "test"); err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.QueueModule(ctx, "admin", "netmap:enable:conflict", local.ID, "enable", model.ModuleRequest{}); !errors.Is(err, ErrConflict) {
		t.Fatal("enable stole shared NetMap alias", err)
	}
}

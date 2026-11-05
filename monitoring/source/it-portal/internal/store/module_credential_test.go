package store

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"strings"
	"testing"

	"pl/portal/internal/connectorcredentials"
	"pl/portal/internal/model"
)

func TestModuleCredentialAtomicIdempotencyAndRemoval(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	codec, err := connectorcredentials.New(bytes.Repeat([]byte{9}, 32))
	if err != nil {
		t.Fatal(err)
	}
	const secret = "mailcow-private-fixture-token"
	input := model.ModuleRequest{ModuleID: "mailcow", Mode: "external", Name: "Mail", Endpoint: "https://mail.example:8443"}
	seals := 0
	credential := &ModuleCredential{Fingerprint: codec.Fingerprint(secret), Origin: input.Endpoint, ApprovedIPs: []string{"10.20.30.40"},
		Seal: func(id string) ([]byte, error) { seals++; return codec.Seal(id, input.Endpoint, secret) }}
	instance, job, err := s.QueueModuleWithCredential(ctx, "admin", "mailcow:credential:create", "", "install", input, credential)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := s.IntegrationCredential(ctx, instance.IntegrationID)
	if err != nil {
		t.Fatal(err)
	}
	if opened, err := codec.Open(instance.IntegrationID, input.Endpoint, stored.Envelope); err != nil || opened != secret {
		t.Fatal("committed credential has the wrong binding")
	}
	again, retried, err := s.QueueModuleWithCredential(ctx, "admin", "mailcow:credential:create", "", "install", input, credential)
	if err != nil || again.ID != instance.ID || retried.ID != job.ID || seals != 1 {
		t.Fatal("retry created another operation or encrypted a second credential", err, seals)
	}
	changed := *credential
	changed.Fingerprint = codec.Fingerprint("different-fixture-token")
	if _, _, err = s.QueueModuleWithCredential(ctx, "admin", "mailcow:credential:create", "", "install", input, &changed); !errors.Is(err, ErrConflict) {
		t.Fatal("different key reused the original idempotency key", err)
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
		if strings.Contains(body, secret) || strings.Contains(body, credential.Fingerprint) || strings.Contains(body, base64.StdEncoding.EncodeToString(stored.Envelope)) {
			t.Fatal("credential material leaked into a public document, job or audit event")
		}
	}
	rows.Close()
	if rows.Err() != nil {
		t.Fatal(rows.Err())
	}
	finish := func(value model.ModuleInstance, operation model.Job, state string) {
		t.Helper()
		value.ObservedState = state
		operation.Status, operation.Result = "succeeded", map[string]any{"instance": value}
		if err := s.Finish(ctx, operation); err != nil {
			t.Fatal(err)
		}
	}
	finish(instance, job, "running")
	disabled, operation, err := s.QueueModule(ctx, "admin", "mailcow:credential:disable", instance.ID, "disable", model.ModuleRequest{})
	if err != nil {
		t.Fatal(err)
	}
	finish(disabled, operation, "disabled")
	retained, err := s.IntegrationCredential(ctx, instance.IntegrationID)
	if err != nil || !bytes.Equal(retained.Envelope, stored.Envelope) {
		t.Fatal("disable destroyed or replaced the saved credential")
	}
	removed, operation, err := s.QueueModule(ctx, "admin", "mailcow:credential:remove", instance.ID, "remove", model.ModuleRequest{ConfirmName: input.Name})
	if err != nil {
		t.Fatal(err)
	}
	finish(removed, operation, "absent")
	if _, err = s.IntegrationCredential(ctx, instance.IntegrationID); !errors.Is(err, ErrNotFound) {
		t.Fatal("removed connection retained its credential")
	}
	input.Endpoint = "https://replacement.example"
	credential.Origin = input.Endpoint
	credential.ApprovedIPs = []string{"192.168.10.5"}
	replacement, _, err := s.QueueModuleWithCredential(ctx, "admin", "mailcow:credential:replacement", "", "install", input, credential)
	if err != nil || replacement.ID == instance.ID || replacement.IntegrationID == instance.IntegrationID {
		t.Fatal("old connection prevents registration on another host", err)
	}
}

func TestModuleCredentialFailureRollsBackAllRegistrationState(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	var before int
	if err := s.Pool.QueryRow(ctx, "SELECT count(*) FROM documents").Scan(&before); err != nil {
		t.Fatal(err)
	}
	input := model.ModuleRequest{ModuleID: "mailcow", Mode: "external", Name: "Mail", Endpoint: "https://mail.example"}
	credential := &ModuleCredential{Fingerprint: strings.Repeat("a", 64), Origin: input.Endpoint, ApprovedIPs: []string{"10.20.30.40"},
		Seal: func(string) ([]byte, error) { return nil, errors.New("fixture sealing failure") }}
	if _, _, err := s.QueueModuleWithCredential(ctx, "admin", "mailcow:credential:rollback", "", "install", input, credential); !errors.Is(err, ErrInvalid) {
		t.Fatal("failed preparation was accepted", err)
	}
	var documents, jobs, credentials int
	if err := s.Pool.QueryRow(ctx, "SELECT (SELECT count(*) FROM documents),(SELECT count(*) FROM jobs),(SELECT count(*) FROM integration_credentials)").Scan(&documents, &jobs, &credentials); err != nil {
		t.Fatal(err)
	}
	if documents != before || jobs != 0 || credentials != 0 {
		t.Fatal("failed registration left partial state", documents, before, jobs, credentials)
	}
}

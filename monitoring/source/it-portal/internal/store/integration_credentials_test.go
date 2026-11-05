package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"pl/portal/internal/connectorcredentials"
)

func credentialFixture(t *testing.T) (*connectorcredentials.Codec, IntegrationCredential) {
	t.Helper()
	c, err := connectorcredentials.New(bytes.Repeat([]byte{6}, 32))
	if err != nil {
		t.Fatal(err)
	}
	credential := IntegrationCredential{IntegrationID: "integration-fixture", Origin: "https://mail.example.test:8443", ApprovedIPs: []string{"192.0.2.10", "2001:db8::10"}}
	credential.Envelope, err = c.Seal(credential.IntegrationID, credential.Origin, "private-mailcow-key-fixture")
	if err != nil {
		t.Fatal(err)
	}
	return c, credential
}

func TestIntegrationCredentialTransactionIsolationAndInsertOnly(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	c, credential := credentialFixture(t)
	if _, err := s.IntegrationCredential(ctx, credential.IntegrationID); !errors.Is(err, ErrNotFound) {
		t.Fatal("missing credential did not return ErrNotFound")
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err = putIntegrationCredential(ctx, tx, credential); err != nil {
		t.Fatal(err)
	}
	if _, err = s.IntegrationCredential(ctx, credential.IntegrationID); !errors.Is(err, ErrNotFound) {
		t.Fatal("uncommitted credential visible to a different connection")
	}
	if err = tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = s.IntegrationCredential(ctx, credential.IntegrationID); !errors.Is(err, ErrNotFound) {
		t.Fatal("rollback retained credential")
	}
	tx, err = s.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err = putIntegrationCredential(ctx, tx, credential); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	got, err := s.IntegrationCredential(ctx, credential.IntegrationID)
	if err != nil || !reflect.DeepEqual(got, credential) {
		t.Fatal("credential envelope/policy did not round trip")
	}
	if secret, err := c.Open(got.IntegrationID, got.Origin, got.Envelope); err != nil || secret != "private-mailcow-key-fixture" {
		t.Fatal("stored credential cannot be decrypted with its binding")
	}
	var createdAt time.Time
	if err = s.Pool.QueryRow(ctx, "SELECT created_at FROM integration_credentials WHERE integration_id=$1", credential.IntegrationID).Scan(&createdAt); err != nil || createdAt.IsZero() {
		t.Fatal("credential creation timestamp missing")
	}
	changed := credential
	changed.Origin = "https://other.example.test"
	changed.Envelope, err = c.Seal(changed.IntegrationID, changed.Origin, "replacement-fixture")
	if err != nil {
		t.Fatal(err)
	}
	if err = putIntegrationCredential(ctx, s.Pool, changed); !errors.Is(err, ErrConflict) {
		t.Fatal("duplicate credential did not conflict")
	}
	got, err = s.IntegrationCredential(ctx, credential.IntegrationID)
	if err != nil || !reflect.DeepEqual(got, credential) {
		t.Fatal("conflicting insert rotated an existing credential")
	}
	other, err := s.IntegrationCredential(ctx, "different-integration")
	if !errors.Is(err, ErrNotFound) || !reflect.DeepEqual(other, IntegrationCredential{}) {
		t.Fatal("lookup exposed another integration's credential")
	}
	encoded, err := json.Marshal(got)
	if err != nil || string(encoded) != "{}" {
		t.Fatal("credential is exposed through JSON")
	}
	for _, kind := range []string{"integration", "integration_credentials", "job", "audit"} {
		documents, err := s.List(ctx, kind)
		if err != nil || len(documents) != 0 {
			t.Fatal("credential unexpectedly created a generic document")
		}
	}
	for _, table := range []string{"jobs", "audit_events", "events"} {
		var count int
		if err := s.Pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&count); err != nil || count != 0 {
			t.Fatal("credential insert produced a job, audit or event payload")
		}
	}
}

func TestIntegrationCredentialRejectsInvalidStorageInput(t *testing.T) {
	_, original := credentialFixture(t)
	for _, tc := range []struct {
		name   string
		change func(*IntegrationCredential)
	}{
		{"missing owner", func(c *IntegrationCredential) { c.IntegrationID = "" }},
		{"oversize owner", func(c *IntegrationCredential) { c.IntegrationID = strings.Repeat("i", 257) }},
		{"owner control", func(c *IntegrationCredential) { c.IntegrationID = "owner\x00" }},
		{"noncanonical origin", func(c *IntegrationCredential) { c.Origin += "/" }},
		{"path origin", func(c *IntegrationCredential) { c.Origin += "/api" }},
		{"empty envelope", func(c *IntegrationCredential) { c.Envelope = nil }},
		{"oversize envelope", func(c *IntegrationCredential) { c.Envelope = make([]byte, 8193) }},
		{"no approved IPs", func(c *IntegrationCredential) { c.ApprovedIPs = nil }},
		{"too many IPs", func(c *IntegrationCredential) { c.ApprovedIPs = make([]string, 33) }},
		{"hostname", func(c *IntegrationCredential) { c.ApprovedIPs = []string{"mail.example.test"} }},
		{"CIDR", func(c *IntegrationCredential) { c.ApprovedIPs = []string{"192.0.2.10/32"} }},
		{"duplicate IP", func(c *IntegrationCredential) { c.ApprovedIPs = []string{"192.0.2.10", "192.0.2.10"} }},
		{"noncanonical IP", func(c *IntegrationCredential) { c.ApprovedIPs = []string{"2001:0db8::10"} }},
		{"mapped IP", func(c *IntegrationCredential) { c.ApprovedIPs = []string{"::ffff:192.0.2.10"} }},
		{"scoped IP", func(c *IntegrationCredential) { c.ApprovedIPs = []string{"fe80::1%eth0"} }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			candidate := original
			tc.change(&candidate)
			// Nil DB proves validation happens before any SQL/persistence.
			if err := putIntegrationCredential(context.Background(), nil, candidate); !errors.Is(err, ErrInvalid) {
				t.Fatal("invalid credential reached storage")
			}
		})
	}
}

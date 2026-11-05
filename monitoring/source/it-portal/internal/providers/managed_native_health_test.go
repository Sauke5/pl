package providers

import (
	"context"
	"errors"
	"testing"

	"pl/portal/internal/model"
)

func TestNativeApplicationHealthUsesControllerCallbackOnly(t *testing.T) {
	for _, kind := range []string{"forms", "doska", "sftpgo"} {
		t.Run(kind, func(t *testing.T) {
			registry := New(nil, "")
			integration := model.Integration{ID: "native-source", ManagedModuleID: "owned-native", Kind: kind, Enabled: true, URL: "not-a-target", SecretRef: "not-a-secret-authority"}
			calls := 0
			registry.ManagedHealth = func(ctx context.Context, got model.Integration) error {
				calls++
				if got.ID != integration.ID || got.ManagedModuleID != integration.ManagedModuleID || got.Kind != kind {
					t.Fatal("native ownership identity lost")
				}
				if _, ok := ctx.Deadline(); !ok {
					t.Fatal("controller health must have a bounded context")
				}
				return nil
			}
			if result := registry.ProbeIntegration(context.Background(), integration); result.Status != "connected" || calls != 1 {
				t.Fatalf("native controller callback not used: %#v calls=%d", result, calls)
			}
			registry.ManagedHealth = func(context.Context, model.Integration) error { return errors.New("native database unavailable") }
			if result := registry.ProbeIntegration(context.Background(), integration); result.Status == "connected" {
				t.Fatal("failed native readiness reported connected")
			}
			registry.ManagedHealth = nil
			if result := registry.ProbeIntegration(context.Background(), integration); result.Status != "unreachable" {
				t.Fatalf("missing native observer: %#v", result)
			}
			integration.ManagedModuleID = ""
			if result := registry.ProbeIntegration(context.Background(), integration); result.Status != "unsupported" {
				t.Fatalf("external native application must not acquire a fake provider: %#v", result)
			}
		})
	}
}

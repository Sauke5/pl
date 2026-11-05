//go:build optional_module_acceptance

package providers

import (
	"context"
	"os"
	"pl/portal/internal/model"
	"pl/portal/internal/netguard"
	"testing"
)

func TestProxyExternalLiveReadOnly(t *testing.T) {
	if os.Getenv("PORTAL_TEST_PROXY_LIVE_READONLY") != "1" {
		t.Fatal("explicit read-only live verification only")
	}
	guard, err := netguard.New([]string{"172.18.0.2/32"}, []int{9090}, "")
	if err != nil {
		t.Fatal(err)
	}
	registry := New(guard, "")
	observation, err := registry.ProxyExternal(context.Background(), model.Integration{Kind: "prometheus", Enabled: true, URL: "http://prometheus:9090"})
	if err != nil {
		t.Fatal(err)
	}
	known := 0
	for _, probe := range observation.Probes {
		if probe.ObservedAt != nil {
			known++
		}
		t.Logf("%s/%s %s cycles=%d last_success_present=%t", probe.Source, probe.Inbound, probe.State, probe.ObservedCycles, probe.LastSuccess != nil)
	}
	if len(observation.Probes) != 12 || known != 12 {
		t.Fatalf("known=%d total=%d", known, len(observation.Probes))
	}
}

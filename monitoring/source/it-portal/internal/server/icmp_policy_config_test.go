package server

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"pl/portal/internal/model"
	"pl/portal/internal/netguard"
	"pl/portal/internal/providers"
)

func icmpOptionalEnv(t *testing.T, key string, value *string) {
	t.Helper()
	old, present := os.LookupEnv(key)
	t.Cleanup(func() {
		if present {
			_ = os.Setenv(key, old)
		} else {
			_ = os.Unsetenv(key)
		}
	})
	var err error
	if value == nil {
		err = os.Unsetenv(key)
	} else {
		err = os.Setenv(key, *value)
	}
	if err != nil {
		t.Fatal(err)
	}
}

func TestICMPPolicyConfigPreservesOmittedAndExplicitEmpty(t *testing.T) {
	t.Setenv("PORTAL_DATABASE_URL", "postgres://test.invalid/test")
	t.Setenv("PORTAL_DEMO", "true")
	t.Setenv("PORTAL_PUBLIC_URL", "http://localhost:8199")
	t.Setenv("PORTAL_LOCAL_ADMIN_HASH_FILE", "")
	t.Setenv("PORTAL_ICMP_EXECUTOR_URL", "")
	t.Setenv("PORTAL_ALLOWED_CIDRS", "192.0.2.22/32")
	t.Setenv("PORTAL_CHECK_INHERIT_INTEGRATION_POLICY", "false")
	t.Setenv("PORTAL_CHECK_ALLOWED_CIDRS", "198.51.100.25/32")
	empty, interactive, strict, invalid := "", "interactive", "cidr", "all"
	list, ipv6, noncanonical, duplicate := "10.20.30.0/24", "::/0", "10.20.30.1/24", "10.20.30.0/24,10.20.30.0/24"
	for _, tc := range []struct {
		name        string
		mode, cidrs *string
		wantMode    string
		wantCIDRs   []string
		invalid     bool
	}{
		{name: "new-default", wantMode: "interactive"},
		{name: "legacy-empty-denies", cidrs: &empty, wantMode: "cidr"},
		{name: "legacy-list", cidrs: &list, wantMode: "cidr", wantCIDRs: []string{list}},
		{name: "explicit-interactive", mode: &interactive, wantMode: "interactive"},
		{name: "interactive-clear", mode: &interactive, cidrs: &empty, wantMode: "interactive"},
		{name: "strict-without-list-denies", mode: &strict, wantMode: "cidr"},
		{name: "interactive-inactive-list", mode: &interactive, cidrs: &list, invalid: true},
		{name: "unknown-mode", mode: &invalid, invalid: true},
		{name: "ipv6-list", cidrs: &ipv6, invalid: true},
		{name: "noncanonical-list", cidrs: &noncanonical, invalid: true},
		{name: "duplicate-list", cidrs: &duplicate, invalid: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			icmpOptionalEnv(t, "PORTAL_ICMP_POLICY", tc.mode)
			icmpOptionalEnv(t, "PORTAL_ICMP_ALLOWED_CIDRS", tc.cidrs)
			cfg, err := LoadConfig()
			if tc.invalid {
				if err == nil {
					t.Fatal("invalid ICMP policy accepted")
				}
				return
			}
			wantCIDRs := tc.wantCIDRs
			if wantCIDRs == nil {
				wantCIDRs = []string{}
			}
			if err != nil || cfg.ICMPPolicyMode != tc.wantMode || !reflect.DeepEqual(cfg.ICMPCIDRs, wantCIDRs) {
				t.Fatalf("ICMP migration differs: mode=%s cidrs=%v error=%v", cfg.ICMPPolicyMode, cfg.ICMPCIDRs, err)
			}
			if !reflect.DeepEqual(cfg.CIDRs, []string{"192.0.2.22/32"}) || !reflect.DeepEqual(cfg.CheckCIDRs, []string{"198.51.100.25/32"}) {
				t.Fatal("ICMP policy changed provider/manual CIDRs")
			}
		})
	}
}

func TestServerICMPModeDoesNotExpandIntegrationPolicy(t *testing.T) {
	base, _ := netguard.New([]string{"192.0.2.22/32"}, []int{443}, "")
	endpoint := "unix://" + filepath.Join(t.TempDir(), "absent-icmp.sock")
	for _, mode := range []string{"", "cidr", "interactive"} {
		registry := providers.New(base, "")
		New(nil, Config{ICMPPolicyMode: mode, ICMPExecutorURL: endpoint}, registry, nil)
		_, err := registry.Execute(context.Background(), model.Job{Kind: "check", Parameters: map[string]any{"kind": "icmp", "target": "198.51.100.25"}}, nil, nil)
		want := providers.ErrPolicyDenied
		if mode == "interactive" {
			want = providers.ErrICMPUnavailable // The allowed request reaches only the absent Unix helper.
		}
		if !errors.Is(err, want) {
			t.Fatalf("ICMP mode %q: %v", mode, err)
		}
		if _, err := base.Resolve(context.Background(), "198.51.100.25"); !errors.Is(err, netguard.ErrPolicyDenied) {
			t.Fatal("integration policy expanded", err)
		}
	}
}

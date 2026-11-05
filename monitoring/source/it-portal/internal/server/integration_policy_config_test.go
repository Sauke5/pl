package server

import (
	"reflect"
	"testing"
)

func TestIntegrationConfigDoesNotWidenCheckPolicyWhenSeparated(t *testing.T) {
	t.Setenv("PORTAL_DATABASE_URL", "postgres://test.invalid/test")
	t.Setenv("PORTAL_DEMO", "true")
	t.Setenv("PORTAL_PUBLIC_URL", "http://localhost:8199")
	t.Setenv("PORTAL_LOCAL_ADMIN_HASH_FILE", "")
	t.Setenv("PORTAL_ALLOWED_CIDRS", "192.0.2.22/32")
	t.Setenv("PORTAL_ALLOWED_PORTS", "18080")
	t.Setenv("PORTAL_CHECK_ALLOWED_CIDRS", "127.0.0.1/32")
	t.Setenv("PORTAL_CHECK_ALLOWED_PORTS", "80,443")
	for _, inherit := range []string{"", "true", "false"} {
		t.Run("inherit="+inherit, func(t *testing.T) {
			t.Setenv("PORTAL_CHECK_INHERIT_INTEGRATION_POLICY", inherit)
			cfg, err := LoadConfig()
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(cfg.CIDRs, []string{"192.0.2.22/32"}) || !reflect.DeepEqual(cfg.Ports, []int{18080}) {
				t.Fatal("integration policy was changed")
			}
			if inherit == "false" {
				if !reflect.DeepEqual(cfg.CheckCIDRs, []string{"127.0.0.1/32"}) {
					t.Fatalf("check CIDRs inherited integration: %v", cfg.CheckCIDRs)
				}
				for _, port := range cfg.CheckPorts {
					if port != 80 && port != 443 {
						t.Fatalf("check port inherited integration: %d", port)
					}
				}
			} else if !reflect.DeepEqual(cfg.CheckCIDRs, []string{"192.0.2.22/32", "127.0.0.1/32"}) || cfg.CheckPorts[0] != 18080 {
				t.Fatal("existing inherited policy changed")
			}
		})
	}
	t.Setenv("PORTAL_CHECK_INHERIT_INTEGRATION_POLICY", "false")
	t.Setenv("PORTAL_CHECK_ALLOWED_PORTS", "")
	cfg, err := LoadConfig()
	if err != nil || !reflect.DeepEqual(cfg.CheckPorts, []int{80, 443}) {
		t.Fatal("separate check ports lost safe defaults", err)
	}
	t.Setenv("PORTAL_CHECK_INHERIT_INTEGRATION_POLICY", "flase")
	if _, err = LoadConfig(); err == nil {
		t.Fatal("invalid policy mode accepted")
	}
}

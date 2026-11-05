package server

import (
	"reflect"
	"testing"
)

func TestCheckCIDRsAreAdditiveAndDoNotExpandIntegrationPolicy(t *testing.T) {
	t.Setenv("PORTAL_DATABASE_URL", "postgres://test.invalid/test")
	t.Setenv("PORTAL_DEMO", "true")
	t.Setenv("PORTAL_PUBLIC_URL", "http://localhost:8199")
	t.Setenv("PORTAL_ALLOWED_PORTS", "80,443")
	t.Setenv("PORTAL_CHECK_ALLOWED_PORTS", "9182,2043,46969")
	t.Setenv("PORTAL_ALLOWED_CIDRS", "192.0.2.4/32")
	t.Setenv("PORTAL_CHECK_ALLOWED_CIDRS", "198.51.100.0/24,203.0.113.27/32")
	t.Setenv("PORTAL_LOCAL_ADMIN_HASH_FILE", "")
	c, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(c.CIDRs, []string{"192.0.2.4/32"}) {
		t.Fatalf("integration policy expanded: %v", c.CIDRs)
	}
	if !reflect.DeepEqual(c.CheckCIDRs, []string{"192.0.2.4/32", "198.51.100.0/24", "203.0.113.27/32"}) {
		t.Fatalf("wrong check policy: %v", c.CheckCIDRs)
	}
	if !reflect.DeepEqual(c.Ports, []int{80, 443}) || !reflect.DeepEqual(c.CheckPorts, []int{80, 443, 9182, 2043, 46969}) {
		t.Fatalf("wrong integration/check ports: %v %v", c.Ports, c.CheckPorts)
	}
	t.Setenv("PORTAL_CHECK_ALLOWED_PORTS", "")
	t.Setenv("PORTAL_CHECK_ALLOWED_CIDRS", "")
	c, err = LoadConfig()
	if err != nil || (!reflect.DeepEqual(c.CheckCIDRs, c.CIDRs) || !reflect.DeepEqual(c.CheckPorts, c.Ports)) {
		t.Fatalf("default policy changed: %v %v", c.CheckCIDRs, err)
	}
	for _, value := range []string{"22,bad", "0", "65536"} {
		t.Setenv("PORTAL_CHECK_ALLOWED_PORTS", value)
		if _, err := LoadConfig(); err == nil || err.Error() != "invalid PORTAL_CHECK_ALLOWED_PORTS" {
			t.Fatalf("invalid check ports accepted: %s: %v", value, err)
		}
	}
}

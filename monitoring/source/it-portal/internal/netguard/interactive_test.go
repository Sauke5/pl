package netguard

import (
	"context"
	"errors"
	"net"
	"testing"
)

func TestInteractiveChecksSeparateDestinationsAndPorts(t *testing.T) {
	base, err := New(nil, []int{443}, "")
	if err != nil {
		t.Fatal(err)
	}
	checks := base.InteractiveChecks()
	for _, target := range []struct {
		host string
		port int
	}{
		{"10.73.43.22", 19100}, {"10.73.43.25", 22}, {"10.33.2.4", 445},
		{"8.8.8.8", 8443}, {"2606:4700:4700::1111", 65535}, {"fd00::25", 5206},
	} {
		ips, err := checks.Resolve(context.Background(), target.host)
		if err != nil {
			t.Fatalf("manual destination %s: %v", target.host, err)
		}
		if err := checks.ValidatePortIPs(ips, target.port); err != nil {
			t.Fatalf("manual port %s:%d: %v", target.host, target.port, err)
		}
		if _, err := base.Resolve(context.Background(), target.host); !errors.Is(err, ErrPolicyDenied) {
			t.Fatalf("base policy expanded for %s: %v", target.host, err)
		}
	}
	for _, port := range []int{0, -1, 65536} {
		if !errors.Is(checks.ValidatePortIPs([]net.IP{net.ParseIP("10.73.43.25")}, port), ErrPolicyDenied) {
			t.Errorf("invalid port %d accepted", port)
		}
	}
	for _, host := range []string{"127.0.0.1", "::1", "169.254.169.254", "100.100.100.200", "168.63.129.16", "fd00:ec2::254", "fe80::1", "224.0.0.1", "0.0.0.0"} {
		if _, err := checks.Resolve(context.Background(), host); !errors.Is(err, ErrPolicyDenied) {
			t.Errorf("protected destination %s accepted: %v", host, err)
		}
	}
	rebinding, err := NewWithDependencies(nil, []int{443}, "", resolverFunc(func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("10.73.43.25")}, {IP: net.ParseIP("127.0.0.1")}}, nil
	}), func(context.Context, string, string) (net.Conn, error) {
		t.Fatal("mixed DNS must not dial")
		return nil, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := rebinding.InteractiveChecks().DialContext(context.Background(), "tcp", "server.test:19100"); !errors.Is(err, ErrPolicyDenied) {
		t.Fatalf("mixed DNS accepted: %v", err)
	}
}

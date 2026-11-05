package netguard

import (
	"context"
	"errors"
	"net"
	"reflect"
	"testing"
)

func TestICMPInteractivePolicyDoesNotExpandOtherGuards(t *testing.T) {
	base, err := New(nil, []int{443}, "")
	if err != nil {
		t.Fatal(err)
	}
	icmp := base.InteractiveChecks()
	for _, host := range []string{"10.20.30.40", "8.8.8.8", "192.0.2.10", "100.64.0.1", "198.18.0.1"} {
		ips, err := icmp.ResolveICMPTarget(context.Background(), host)
		if err != nil || len(ips) != 1 || !ips[0].Equal(net.ParseIP(host)) {
			t.Fatalf("interactive IPv4 %s: %v", host, err)
		}
		if _, err := base.Resolve(context.Background(), host); !errors.Is(err, ErrPolicyDenied) {
			t.Fatalf("provider policy expanded: %s: %v", host, err)
		}
		if _, err := icmp.ResolveNetworkTarget(context.Background(), host); !errors.Is(err, ErrPolicyDenied) {
			t.Fatalf("legacy strict resolver expanded: %s: %v", host, err)
		}
	}
	if len(base.networks) != 0 || len(icmp.networks) != 0 {
		t.Fatal("interactive mode inserted a global CIDR")
	}
}

func TestICMPPolicyAlwaysRejectsSpecialIPv4(t *testing.T) {
	strict, _ := New([]string{"0.0.0.0/0"}, nil, "")
	interactive := strict.InteractiveChecks()
	for _, guard := range []*Guard{strict, interactive} {
		for _, host := range []string{"0.0.0.0", "0.1.2.3", "127.0.0.1", "169.254.1.1", "169.254.169.254", "224.0.0.1", "240.0.0.1", "255.255.255.255", "100.100.100.200", "168.63.129.16"} {
			if _, err := guard.ResolveICMPTarget(context.Background(), host); !errors.Is(err, ErrPolicyDenied) {
				t.Errorf("special IPv4 allowed: %s: %v", host, err)
			}
		}
	}
}

func TestICMPIPv4ResolutionValidatesAllAAnswers(t *testing.T) {
	answers := []net.IPAddr{{IP: net.ParseIP("10.20.30.40")}, {IP: net.ParseIP("192.0.2.10")}, {IP: net.ParseIP("::1")}}
	guard, err := NewWithDependencies(nil, nil, "", resolverFunc(func(context.Context, string) ([]net.IPAddr, error) {
		return answers, nil
	}), func(context.Context, string, string) (net.Conn, error) {
		t.Fatal("resolution must not dial")
		return nil, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	interactive := guard.InteractiveChecks()
	ips, err := interactive.ResolveICMPTarget(context.Background(), "fixture.example")
	if err != nil || len(ips) != 2 || ips[0].String() != "10.20.30.40" || ips[1].String() != "192.0.2.10" {
		t.Fatal("IPv4 order/pinning changed", ips, err)
	}
	answers = append(answers, net.IPAddr{IP: net.ParseIP("127.0.0.1")})
	if _, err := interactive.ResolveICMPTarget(context.Background(), "fixture.example"); !errors.Is(err, ErrPolicyDenied) {
		t.Fatal("mixed allowed/denied A answers accepted", err)
	}
	answers = []net.IPAddr{{IP: net.ParseIP("2001:db8::1")}}
	if _, err := interactive.ResolveICMPTarget(context.Background(), "fixture.example"); !errors.Is(err, ErrDNS) {
		t.Fatal("AAAA-only hostname became an IPv4 target", err)
	}
}

func TestICMPStrictCIDREmptyAndNetworkBoundaries(t *testing.T) {
	for _, tc := range []struct {
		cidrs []string
		want  []bool
	}{
		{nil, []bool{false, false, false}},
		{[]string{}, []bool{false, false, false}},
		{[]string{"10.20.30.0/24"}, []bool{false, true, false}},
		{[]string{"10.20.30.0/31", "10.20.30.255/32"}, []bool{true, false, true}},
	} {
		guard, err := New(tc.cidrs, nil, "")
		if err != nil {
			t.Fatal(err)
		}
		got := []bool{}
		for _, host := range []string{"10.20.30.0", "10.20.30.40", "10.20.30.255"} {
			_, err := guard.ResolveICMPTarget(context.Background(), host)
			got = append(got, err == nil)
		}
		if !reflect.DeepEqual(got, tc.want) {
			t.Fatalf("strict boundaries %v: %v", tc.cidrs, got)
		}
	}
}

package netguard

import (
	"context"
	"errors"
	"net"
	"net/url"
	"reflect"
	"testing"
)

type connectorResolver struct {
	ips []net.IPAddr
}

func (r *connectorResolver) LookupIPAddr(context.Context, string) ([]net.IPAddr, error) {
	return append([]net.IPAddr(nil), r.ips...), nil
}

func TestConnectorPolicyPinsOriginWithoutChangingOtherClients(t *testing.T) {
	resolver := &connectorResolver{ips: []net.IPAddr{{IP: net.ParseIP("10.20.30.40")}}}
	dials := 0
	g, err := NewWithDependencies([]string{"127.0.0.1/32"}, []int{443}, "", resolver,
		func(context.Context, string, string) (net.Conn, error) {
			dials++
			return nil, errors.New("fixture dial")
		})
	if err != nil {
		t.Fatal(err)
	}
	origin, ips, err := g.ApproveConnector(context.Background(), "https://MAIL.example:8443/")
	if err != nil || origin != "https://mail.example:8443" || !reflect.DeepEqual(ips, []string{"10.20.30.40"}) {
		t.Fatalf("approval: %q %v %v", origin, ips, err)
	}
	bound, err := g.BoundOrigin(origin, ips)
	if err != nil {
		t.Fatal(err)
	}
	valid, _ := url.Parse(origin + "/api/v1/get/status/version")
	if err = bound.ValidateURL(valid); err != nil {
		t.Fatal(err)
	}
	if _, err = bound.Resolve(context.Background(), "mail.example"); err != nil {
		t.Fatal(err)
	}
	if _, err = g.Resolve(context.Background(), "mail.example"); !errors.Is(err, ErrPolicyDenied) {
		t.Fatal("connection approval widened the original guard")
	}
	if bound.roots != g.roots || bound.TLSConfig().InsecureSkipVerify {
		t.Fatal("bound connection changed CA verification")
	}
	for _, other := range []string{"https://other.example:8443/api/v1/get/status/version", "http://mail.example:8443/api/v1/get/status/version", "https://mail.example/api/v1/get/status/version"} {
		u, _ := url.Parse(other)
		if err = bound.ValidateURL(u); !errors.Is(err, ErrPolicyDenied) {
			t.Fatalf("foreign origin accepted: %s", other)
		}
	}
	// A later DNS change is denied before any connection is attempted, including
	// mixed answers containing both the previously approved and a new address.
	resolver.ips = append(resolver.ips, net.IPAddr{IP: net.ParseIP("10.20.30.41")})
	if _, err = bound.DialContext(context.Background(), "tcp", "mail.example:8443"); !errors.Is(err, ErrPolicyDenied) || dials != 0 {
		t.Fatal("DNS rebinding reached dial", err, dials)
	}
}

func TestConnectorPolicyRejectsSpecialAddressesAndUnboundInputs(t *testing.T) {
	resolver := &connectorResolver{}
	g, err := NewWithDependencies(nil, nil, "", resolver, func(context.Context, string, string) (net.Conn, error) {
		t.Fatal("approval must never dial")
		return nil, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{"127.0.0.1", "169.254.169.254", "100.100.100.200", "0.1.2.3", "224.0.0.1", "240.0.0.1", "::1", "fe80::1", "fd00:ec2::254", "::"} {
		resolver.ips = []net.IPAddr{{IP: net.ParseIP(value)}}
		if _, _, err = g.ApproveConnector(context.Background(), "https://mail.example"); !errors.Is(err, ErrPolicyDenied) {
			t.Fatalf("special address approved: %s (%v)", value, err)
		}
	}
	resolver.ips = []net.IPAddr{{IP: net.ParseIP("10.20.30.40")}, {IP: net.ParseIP("169.254.169.254")}}
	if _, _, err = g.ApproveConnector(context.Background(), "https://mail.example"); !errors.Is(err, ErrPolicyDenied) {
		t.Fatal("mixed metadata answer approved")
	}
	for _, addresses := range [][]string{nil, {"10.20.30.40", "10.20.30.40"}, {"garbage"}, {"::ffff:10.20.30.40"}, {"127.0.0.1"}} {
		if _, err = g.BoundOrigin("https://mail.example", addresses); !errors.Is(err, ErrPolicyDenied) {
			t.Fatalf("invalid binding accepted: %v", addresses)
		}
	}
}

package netguard

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"sort"
	"strconv"

	"pl/portal/internal/connectorcredentials"
)

// ApproveConnector resolves only the endpoint explicitly submitted by an
// administrator. It does not extend the policy used by other integrations/jobs.
// The returned addresses must be persisted with the credential before use.
func (g *Guard) ApproveConnector(ctx context.Context, endpoint string) (string, []string, error) {
	if g == nil {
		return "", nil, ErrPolicyDenied
	}
	origin, err := connectorcredentials.CanonicalOrigin(endpoint)
	if err != nil {
		return "", nil, ErrPolicyDenied
	}
	u, _ := url.Parse(origin)
	var addresses []net.IPAddr
	if ip := net.ParseIP(u.Hostname()); ip != nil {
		addresses = []net.IPAddr{{IP: ip}}
	} else {
		addresses, err = g.resolver.LookupIPAddr(ctx, u.Hostname())
		if err != nil {
			return "", nil, ErrDNS
		}
	}
	if len(addresses) == 0 || len(addresses) > 32 {
		return "", nil, ErrDNS
	}
	unique := map[string]bool{}
	for _, address := range addresses {
		if address.Zone != "" || !connectorIP(address.IP) {
			return "", nil, ErrPolicyDenied
		}
		unique[address.IP.String()] = true
	}
	ips := make([]string, 0, len(unique))
	for ip := range unique {
		ips = append(ips, ip)
	}
	sort.Strings(ips)
	return origin, ips, nil
}

func connectorIP(ip net.IP) bool {
	if !ip.IsGlobalUnicast() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	if v4 := ip.To4(); v4 != nil {
		return v4[0] != 0 && v4[0] < 224 && !ip.Equal(net.ParseIP("100.100.100.200"))
	}
	return !ip.Equal(net.ParseIP("fd00:ec2::254"))
}

// BoundOrigin preserves the normal CA verification and transport dependencies,
// but permits only one origin, one port and its previously approved IPs. Every
// dial resolves DNS again; changed answers fail until the connection is updated.
func (g *Guard) BoundOrigin(origin string, approvedIPs []string) (*Guard, error) {
	if g == nil || len(approvedIPs) == 0 || len(approvedIPs) > 32 {
		return nil, ErrPolicyDenied
	}
	canonical, err := connectorcredentials.CanonicalOrigin(origin)
	if err != nil || canonical != origin {
		return nil, ErrPolicyDenied
	}
	u, _ := url.Parse(origin)
	port := 80
	if u.Scheme == "https" {
		port = 443
	}
	if u.Port() != "" {
		port, err = strconv.Atoi(u.Port())
		if err != nil || port < 1 || port > 65535 {
			return nil, ErrPolicyDenied
		}
	}
	bound := *g
	bound.publicWeb, bound.interactive, bound.origin = false, false, origin
	bound.networks = nil
	bound.ports = map[int]bool{port: true}
	seen := map[string]bool{}
	for _, value := range approvedIPs {
		ip := net.ParseIP(value)
		if !connectorIP(ip) || ip.String() != value || seen[value] {
			return nil, fmt.Errorf("%w: invalid connection address", ErrPolicyDenied)
		}
		seen[value] = true
		bits := 128
		if ip.To4() != nil {
			bits = 32
		}
		bound.networks = append(bound.networks, &net.IPNet{IP: ip, Mask: net.CIDRMask(bits, bits)})
	}
	return &bound, nil
}

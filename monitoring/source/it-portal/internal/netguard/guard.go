// Package netguard enforces one destination policy for checks and integrations.
package netguard

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"pl/portal/internal/connectorcredentials"
)

var ErrPolicyDenied = errors.New("destination policy denied")
var ErrDNS = errors.New("DNS lookup failed")

type Resolver interface {
	LookupIPAddr(context.Context, string) ([]net.IPAddr, error)
}
type Guard struct {
	publicWeb   bool
	interactive bool
	origin      string
	networks    []*net.IPNet
	ports       map[int]bool
	roots       *x509.CertPool
	resolver    Resolver
	dial        func(context.Context, string, string) (net.Conn, error)
}

func New(cidrs []string, ports []int, caFile string) (*Guard, error) {
	g := &Guard{ports: map[int]bool{}, resolver: net.DefaultResolver, dial: (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext}
	for _, s := range cidrs {
		_, n, e := net.ParseCIDR(strings.TrimSpace(s))
		if e != nil {
			return nil, fmt.Errorf("invalid allowed CIDR: %w", e)
		}
		g.networks = append(g.networks, n)
	}
	for _, p := range ports {
		if p < 1 || p > 65535 {
			return nil, errors.New("invalid allowed port")
		}
		g.ports[p] = true
	}
	roots, e := x509.SystemCertPool()
	if e != nil {
		roots = x509.NewCertPool()
	}
	g.roots = roots
	if caFile != "" {
		b, e := os.ReadFile(caFile)
		if e != nil {
			return nil, e
		}
		if !roots.AppendCertsFromPEM(b) {
			return nil, errors.New("corporate CA file has no certificates")
		}
	}
	return g, nil
}

// PublicWebChecks extends the legacy endpoint/enrichment policy with public web
// ports. Existing integration clients keep the original destination allowlist.
func (g *Guard) PublicWebChecks() *Guard {
	copy := *g
	copy.publicWeb = true
	copy.ports = make(map[int]bool, len(g.ports)+2)
	for p, allowed := range g.ports {
		copy.ports[p] = allowed
	}
	copy.ports[80], copy.ports[443] = true, true
	return &copy
}

// InteractiveChecks is used only for authenticated, explicitly requested check
// jobs. Provider clients and enrichment keep their own destination allowlists.
func (g *Guard) InteractiveChecks() *Guard {
	copy := *g
	copy.interactive = true
	return &copy
}

// IperfChecks permits only dedicated iperf ports at explicitly configured
// destinations unless the explicitly enabled interactive policy is used.
func (g *Guard) IperfChecks() *Guard {
	if g.interactive {
		return g
	}
	copy := *g
	copy.publicWeb = false
	copy.ports = map[int]bool{5201: true, 5202: true, 5203: true, 5204: true, 5205: true}
	return &copy
}

func (g *Guard) portAllowed(port int) bool {
	return port > 0 && port <= 65535 && (g.interactive || g.ports[port])
}

func (g *Guard) explicitlyAllowed(ip net.IP) bool {
	for _, n := range g.networks {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

var nonPublic = func() []*net.IPNet {
	var out []*net.IPNet
	for _, prefix := range []string{"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4", "2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20"} {
		_, network, _ := net.ParseCIDR(prefix)
		out = append(out, network)
	}
	return out
}()

func publicIP(ip net.IP) bool {
	if !ip.IsGlobalUnicast() || ip.IsPrivate() {
		return false
	}
	for _, n := range nonPublic {
		if n.Contains(ip) {
			return false
		}
	}
	if ip.To4() == nil {
		_, global, _ := net.ParseCIDR("2000::/3")
		return global.Contains(ip)
	}
	return true
}
func (g *Guard) allowed(ip net.IP) bool {
	if ip == nil || ip.IsLoopback() || ip.IsUnspecified() || ip.IsMulticast() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return false
	}
	// Block metadata services even where they use globally routed addresses.
	for _, s := range []string{"100.100.100.200", "168.63.129.16", "fd00:ec2::254"} {
		if ip.Equal(net.ParseIP(s)) {
			return false
		}
	}
	return g.explicitlyAllowed(ip) || (g.publicWeb && publicIP(ip)) || (g.interactive && ip.IsGlobalUnicast())
}
func (g *Guard) Resolve(ctx context.Context, host string) ([]net.IP, error) {
	if host == "" || strings.ContainsAny(host, "/%@\\\x00") {
		return nil, fmt.Errorf("%w: invalid hostname", ErrPolicyDenied)
	}
	var ips []net.IP
	if ip := net.ParseIP(host); ip != nil {
		ips = []net.IP{ip}
	} else {
		a, e := g.resolver.LookupIPAddr(ctx, host)
		if e != nil {
			return nil, fmt.Errorf("%w: %w", ErrDNS, e)
		}
		for _, v := range a {
			ips = append(ips, v.IP)
		}
	}
	if len(ips) == 0 {
		return nil, ErrDNS
	}
	for _, ip := range ips {
		if !g.allowed(ip) {
			return nil, fmt.Errorf("%w: destination is outside allowed networks", ErrPolicyDenied)
		}
	}
	return ips, nil
}

// ValidatePortIPs applies the same destination policy before a bounded external
// scanner connects to pinned numeric addresses, without opening a connection.
func (g *Guard) ValidatePortIPs(ips []net.IP, port int) error {
	if !g.portAllowed(port) || len(ips) == 0 {
		return fmt.Errorf("%w: destination port is not allowed", ErrPolicyDenied)
	}
	for _, ip := range ips {
		if !g.allowed(ip) || (!g.interactive && !g.explicitlyAllowed(ip) && port != 80 && port != 443) {
			return fmt.Errorf("%w: destination is outside the check policy", ErrPolicyDenied)
		}
	}
	return nil
}
func (g *Guard) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	if network != "tcp" && network != "tcp4" && network != "tcp6" {
		return nil, fmt.Errorf("%w: only TCP is allowed", ErrPolicyDenied)
	}
	h, p, e := net.SplitHostPort(address)
	if e != nil {
		return nil, fmt.Errorf("%w: destination requires host:port", ErrPolicyDenied)
	}
	port, e := strconv.Atoi(p)
	if e != nil || !g.portAllowed(port) {
		return nil, fmt.Errorf("%w: destination port is not allowed", ErrPolicyDenied)
	}
	ips, e := g.Resolve(ctx, h)
	if e != nil {
		return nil, e
	}
	if e := g.ValidatePortIPs(ips, port); e != nil {
		return nil, e
	}
	var last error
	for _, ip := range ips {
		c, e := g.dial(ctx, network, net.JoinHostPort(ip.String(), p))
		if e == nil {
			return c, nil
		}
		last = e
	}
	return nil, fmt.Errorf("connection failed: %w", last)
}
func (g *Guard) TLSConfig() *tls.Config {
	return &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: g.roots}
}
func (g *Guard) ValidateURL(u *url.URL) error {
	if (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || u.Fragment != "" {
		return fmt.Errorf("%w: only HTTP(S) URLs without credentials or fragments are allowed", ErrPolicyDenied)
	}
	if g.origin != "" {
		origin, err := connectorcredentials.CanonicalOrigin(u.Scheme + "://" + u.Host)
		if err != nil || origin != g.origin {
			return fmt.Errorf("%w: connection origin differs", ErrPolicyDenied)
		}
	}
	p := u.Port()
	if p == "" {
		p = "80"
		if u.Scheme == "https" {
			p = "443"
		}
	}
	n, e := strconv.Atoi(p)
	if e != nil || !g.portAllowed(n) {
		return fmt.Errorf("%w: destination port is not allowed", ErrPolicyDenied)
	}
	return nil
}

type guardedTransport struct {
	g *Guard
	t *http.Transport
}

func (t guardedTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if e := t.g.ValidateURL(r.URL); e != nil {
		return nil, e
	}
	return t.t.RoundTrip(r)
}
func (g *Guard) Client(timeout time.Duration) *http.Client {
	t := &http.Transport{Proxy: nil, DialContext: g.DialContext, TLSClientConfig: g.TLSConfig(), TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 15 * time.Second, MaxResponseHeaderBytes: 64 << 10, MaxIdleConns: 20, MaxIdleConnsPerHost: 2, IdleConnTimeout: 30 * time.Second, DisableKeepAlives: true}
	return &http.Client{Timeout: timeout, Transport: guardedTransport{g, t}, CheckRedirect: func(r *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return fmt.Errorf("%w: redirect limit reached", ErrPolicyDenied)
		}
		if e := g.ValidateURL(r.URL); e != nil {
			return e
		}
		if len(via) > 0 && via[0].Header.Get("Authorization") != "" && (r.URL.Host != via[0].URL.Host || r.URL.Scheme != via[0].URL.Scheme) {
			return fmt.Errorf("%w: authenticated cross-origin redirect denied", ErrPolicyDenied)
		}
		_, e := g.Resolve(r.Context(), r.URL.Hostname())
		return e
	}}
}

// NewWithDependencies injects DNS and transport for controlled contract tests.
// Network and port policies remain enforced before the injected dial is called.
// Production callers use New; never expose these dependencies to API inputs.
func NewWithDependencies(cidrs []string, ports []int, caFile string, resolver Resolver, dial func(context.Context, string, string) (net.Conn, error)) (*Guard, error) {
	g, e := New(cidrs, ports, caFile)
	if e != nil {
		return nil, e
	}
	if resolver == nil || dial == nil {
		return nil, errors.New("resolver and dialer required")
	}
	g.resolver = resolver
	g.dial = dial
	return g, nil
}

// ResolveNetworkTarget keeps non-web diagnostics within explicit CIDRs.
// Enabling public HTTP checks does not grant arbitrary raw ICMP destinations.
func (g *Guard) ResolveNetworkTarget(ctx context.Context, host string) ([]net.IP, error) {
	copy := *g
	copy.publicWeb = false
	copy.interactive = false
	if host == "" || strings.ContainsAny(host, "/%@\\\x00") {
		return nil, fmt.Errorf("%w: invalid hostname", ErrPolicyDenied)
	}
	var values []net.IPAddr
	if ip := net.ParseIP(host); ip != nil {
		values = []net.IPAddr{{IP: ip}}
	} else {
		var err error
		values, err = copy.resolver.LookupIPAddr(ctx, host)
		if err != nil {
			return nil, fmt.Errorf("%w: %w", ErrDNS, err)
		}
	}
	ips := []net.IP{}
	for _, value := range values {
		if ip := value.IP.To4(); ip != nil {
			if !copy.allowed(ip) {
				return nil, fmt.Errorf("%w: destination is outside allowed networks", ErrPolicyDenied)
			}
			ips = append(ips, ip)
		}
	}
	if len(ips) == 0 {
		return nil, ErrDNS
	}
	return ips, nil
}

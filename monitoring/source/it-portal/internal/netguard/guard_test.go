package netguard

import (
	"context"
	"encoding/pem"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type resolverFunc func(context.Context, string) ([]net.IPAddr, error)

func (f resolverFunc) LookupIPAddr(c context.Context, h string) ([]net.IPAddr, error) { return f(c, h) }
func TestPolicy(t *testing.T) {
	g, e := New([]string{"0.0.0.0/0", "::/0"}, []int{80, 443}, "")
	if e != nil {
		t.Fatal(e)
	}
	for _, h := range []string{"127.0.0.1", "::1", "169.254.169.254", "100.100.100.200", "168.63.129.16", "0.0.0.0", "fe80::1", "ff02::1", "localhost%lo0"} {
		if _, e = g.Resolve(context.Background(), h); e == nil {
			t.Errorf("allowed forbidden %s", h)
		}
	}
	g, _ = New([]string{"10.0.0.0/8"}, []int{443}, "")
	if _, e = g.Resolve(context.Background(), "10.1.2.3"); e != nil {
		t.Fatal(e)
	}
	if _, e = g.Resolve(context.Background(), "8.8.8.8"); e == nil {
		t.Fatal("allowed unlisted public IP")
	}
	if _, e = g.DialContext(context.Background(), "tcp", "10.1.2.3:22"); e == nil {
		t.Fatal("allowed unlisted port")
	}
}
func TestDNSPinningMixedAndRebinding(t *testing.T) {
	calls := 0
	var dialed string
	r := resolverFunc(func(context.Context, string) ([]net.IPAddr, error) {
		calls++
		if calls == 1 {
			return []net.IPAddr{{IP: net.ParseIP("10.0.0.5")}}, nil
		}
		return []net.IPAddr{{IP: net.ParseIP("127.0.0.1")}}, nil
	})
	g, _ := NewWithDependencies([]string{"10.0.0.0/8"}, []int{80}, "", r, func(_ context.Context, _, a string) (net.Conn, error) { dialed = a; return nil, errors.New("stub") })
	_, _ = g.DialContext(context.Background(), "tcp", "service.test:80")
	if dialed != "10.0.0.5:80" || calls != 1 {
		t.Fatalf("not pinned: %s calls=%d", dialed, calls)
	}
	dialed = ""
	_, e := g.DialContext(context.Background(), "tcp", "service.test:80")
	if e == nil || dialed != "" {
		t.Fatal("rebinding bypassed policy")
	}
	g.resolver = resolverFunc(func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("10.0.0.5")}, {IP: net.ParseIP("127.0.0.1")}}, nil
	})
	if _, e = g.Resolve(context.Background(), "mixed.test"); e == nil {
		t.Fatal("mixed allowed and forbidden answers accepted")
	}
}

func TestNetworkTargetRequiresExplicitIPv4AndRejectsMixedAnswers(t *testing.T) {
	g, _ := New([]string{"10.0.0.0/8"}, nil, "")
	g.resolver = resolverFunc(func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("2001:db8::1")}, {IP: net.ParseIP("10.0.0.5")}}, nil
	})
	ips, err := g.ResolveNetworkTarget(context.Background(), "dual.example")
	if err != nil || len(ips) != 1 || ips[0].String() != "10.0.0.5" {
		t.Fatalf("IPv4 resolution: %v, %v", ips, err)
	}
	g.resolver = resolverFunc(func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("10.0.0.5")}, {IP: net.ParseIP("192.0.2.1")}}, nil
	})
	if _, err = g.ResolveNetworkTarget(context.Background(), "mixed.example"); !errors.Is(err, ErrPolicyDenied) {
		t.Fatalf("mixed answers: %v", err)
	}
	empty, _ := New(nil, nil, "")
	if _, err = empty.ResolveNetworkTarget(context.Background(), "10.0.0.5"); !errors.Is(err, ErrPolicyDenied) {
		t.Fatalf("empty policy: %v", err)
	}
}
func TestRedirectAndProxyPolicy(t *testing.T) {
	hits := 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		http.Redirect(w, r, "http://169.254.169.254/latest/meta-data", 302)
	}))
	defer s.Close()
	addr := strings.TrimPrefix(s.URL, "http://")
	g, _ := NewWithDependencies([]string{"10.0.0.0/8"}, []int{80}, "", resolverFunc(func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("10.0.0.5")}}, nil
	}), func(c context.Context, n, a string) (net.Conn, error) { return (&net.Dialer{}).DialContext(c, n, addr) })
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
	_, e := g.Client(time.Second).Get("http://service.test")
	if e == nil || hits != 1 {
		t.Fatalf("redirect escaped policy hits=%d err=%v", hits, e)
	}
	_, e = g.Client(time.Second).Get("http://user:pass@service.test")
	if e == nil {
		t.Fatal("URL credentials allowed")
	}
}
func TestAuthenticatedCrossOriginRedirectDenied(t *testing.T) {
	hits := 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits++; http.Redirect(w, r, "http://other.test/", 302) }))
	defer s.Close()
	addr := strings.TrimPrefix(s.URL, "http://")
	g, _ := NewWithDependencies([]string{"10.0.0.0/8"}, []int{80}, "", resolverFunc(func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("10.0.0.5")}}, nil
	}), func(c context.Context, n, a string) (net.Conn, error) { return (&net.Dialer{}).DialContext(c, n, addr) })
	req, _ := http.NewRequest("GET", "http://service.test", nil)
	req.Header.Set("Authorization", "Bearer token")
	_, e := g.Client(time.Second).Do(req)
	if e == nil || hits != 1 {
		t.Fatal("credential redirect was followed", hits, e)
	}
}
func TestCorporateCAAndHostnameVerification(t *testing.T) {
	s := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
	defer s.Close()
	addr := strings.TrimPrefix(s.URL, "https://")
	dns := resolverFunc(func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("10.0.0.5")}}, nil
	})
	dial := func(c context.Context, n, a string) (net.Conn, error) { return (&net.Dialer{}).DialContext(c, n, addr) }
	ca := filepath.Join(t.TempDir(), "ca.pem")
	if e := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: s.Certificate().Raw}), 0600); e != nil {
		t.Fatal(e)
	}
	g, e := NewWithDependencies([]string{"10.0.0.0/8"}, []int{443}, ca, dns, dial)
	if e != nil {
		t.Fatal(e)
	}
	resp, e := g.Client(time.Second).Get("https://example.com")
	if e != nil {
		t.Fatal(e)
	}
	resp.Body.Close()
	if _, e = g.Client(time.Second).Get("https://wrong-host.test"); e == nil {
		t.Fatal("hostname verification disabled")
	}
	g, _ = NewWithDependencies([]string{"10.0.0.0/8"}, []int{443}, "", dns, dial)
	if _, e = g.Client(time.Second).Get("https://example.com"); e == nil {
		t.Fatal("untrusted cert accepted")
	}
}

func TestPublicChecksSeparatePolicyAndPorts(t *testing.T) {
	base, _ := New([]string{"10.20.0.0/16"}, []int{22, 443}, "")
	check := base.PublicWebChecks()
	if _, e := base.Resolve(context.Background(), "8.8.8.8"); e == nil {
		t.Fatal("public access leaked into integrations")
	}
	if _, e := check.Resolve(context.Background(), "8.8.8.8"); e != nil {
		t.Fatal(e)
	}
	for _, ip := range []string{"127.0.0.1", "169.254.169.254", "168.63.129.16", "100.100.100.200", "100.64.1.1", "192.168.1.1", "198.18.0.1", "203.0.113.1", "240.0.0.1", "::1", "fc00::1", "64:ff9b::a00:1", "2001:db8::1", "2002:a00:1::1", "3fff::1"} {
		if _, e := check.Resolve(context.Background(), ip); e == nil {
			t.Errorf("forbidden public target %s", ip)
		}
	}
	dialed := ""
	check.dial = func(_ context.Context, _, addr string) (net.Conn, error) {
		dialed = addr
		return nil, errors.New("stub")
	}
	_, e := check.DialContext(context.Background(), "tcp", "8.8.8.8:22")
	if !errors.Is(e, ErrPolicyDenied) || dialed != "" {
		t.Fatal("public SSH allowed")
	}
	_, _ = check.DialContext(context.Background(), "tcp", "8.8.8.8:443")
	if dialed != "8.8.8.8:443" {
		t.Fatal("public HTTPS not dialed")
	}
	dialed = ""
	_, _ = check.DialContext(context.Background(), "tcp", "10.20.1.1:22")
	if dialed != "10.20.1.1:22" {
		t.Fatal("internal port policy changed")
	}
	check.resolver = resolverFunc(func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("8.8.8.8")}, {IP: net.ParseIP("127.0.0.1")}}, nil
	})
	dialed = ""
	_, e = check.DialContext(context.Background(), "tcp", "mixed.example:443")
	if !errors.Is(e, ErrPolicyDenied) || dialed != "" {
		t.Fatal("mixed public/private resolution escaped")
	}
}

func TestPublicRedirectIsRevalidated(t *testing.T) {
	hits := 0
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		http.Redirect(w, r, "http://169.254.169.254/latest/meta-data", 302)
	}))
	defer target.Close()
	g, _ := NewWithDependencies(nil, []int{80}, "", resolverFunc(func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("8.8.8.8")}}, nil
	}), func(ctx context.Context, network, addr string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(target.URL, "http://"))
	})
	c := g.PublicWebChecks().Client(time.Second)
	_, e := c.Get("http://public.example/")
	if !errors.Is(e, ErrPolicyDenied) || hits != 1 {
		t.Fatalf("redirect escaped: hits=%d err=%v", hits, e)
	}
}

func TestIperfPolicyIsIsolated(t *testing.T) {
	base, err := New([]string{"10.200.50.10/32"}, []int{443}, "")
	if err != nil {
		t.Fatal(err)
	}
	g := base.PublicWebChecks().IperfChecks()
	ctx := context.Background()
	for _, host := range []string{"8.8.8.8", "169.254.169.254", "10.200.50.11"} {
		if _, err := g.Resolve(ctx, host); err == nil {
			t.Fatalf("iperf allowed %s", host)
		}
	}
	ips, err := g.Resolve(ctx, "10.200.50.10")
	if err != nil {
		t.Fatal(err)
	}
	for port := 5201; port <= 5205; port++ {
		if err := g.ValidatePortIPs(ips, port); err != nil {
			t.Fatal(err)
		}
	}
	if err := g.ValidatePortIPs(ips, 443); err == nil {
		t.Fatal("iperf allowed web port")
	}
	if err := base.ValidatePortIPs(ips, 5201); err == nil {
		t.Fatal("iperf modified base policy")
	}
}

package providers

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"pl/portal/internal/model"
	"pl/portal/internal/netguard"
)

func TestEndpointChecksAndEnrichmentUseSeparatePolicy(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/private-redirect":
			http.Redirect(w, r, "http://192.168.77.99/", http.StatusFound)
		case "/metadata-redirect":
			http.Redirect(w, r, "http://169.254.169.254/", http.StatusFound)
		default:
			w.Header().Set("Content-Type", "text/html")
			w.Write([]byte("<title>Catalog endpoint</title>"))
		}
	}))
	defer server.Close()
	dialed := 0
	dial := func(ctx context.Context, network, address string) (net.Conn, error) {
		dialed++
		return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(server.URL, "http://"))
	}
	base, err := netguard.NewWithDependencies([]string{"172.20.0.4/32"}, []int{80, 443}, "", quickResolver{}, dial)
	if err != nil {
		t.Fatal(err)
	}
	checks, err := netguard.NewWithDependencies([]string{"172.20.0.4/32", "10.73.40.8/32", "10.73.41.27/32", "10.73.42.100/32", "192.0.2.51/32", "192.0.2.52/32", "192.0.2.53/32", "192.0.2.54/32"}, []int{80, 443, 9182, 2043, 46969}, "", quickResolver{}, dial)
	if err != nil {
		t.Fatal(err)
	}
	r := New(base, "")
	r.SetCheckGuard(checks)
	for _, kind := range []string{"check", "enrich"} {
		before := dialed
		_, err := r.Execute(context.Background(), model.Job{Kind: kind, Parameters: map[string]any{"kind": "http", "target": "http://public.example/"}}, nil, nil)
		if !errors.Is(err, ErrPolicyDenied) || dialed != before {
			t.Fatalf("public mode disabled, %s escaped policy: %v", kind, err)
		}
	}
	r.EnablePublicWebChecks()
	for _, target := range []string{"http://10.73.40.8/", "http://10.73.41.27/", "http://public.example/", "http://10.73.42.100:9182/", "http://192.0.2.51:2043/", "http://192.0.2.52:2043/", "http://192.0.2.53:46969/", "http://192.0.2.54:46969/"} {
		for _, kind := range []string{"check", "enrich"} {
			out, err := r.Execute(context.Background(), model.Job{Kind: kind, Parameters: map[string]any{"kind": "http", "target": target}}, nil, nil)
			if err != nil {
				t.Fatalf("%s %s: %v", kind, target, err)
			}
			if kind == "enrich" && out["suggestions"].(map[string]any)["name"] != "Catalog endpoint" {
				t.Fatalf("missing observed metadata: %#v", out)
			}
		}
	}
	for _, target := range []string{"http://192.168.77.99/", "http://169.254.169.254/", "http://127.0.0.1/", "http://public.example:8080/", "http://10.73.40.8:22/", "http://192.0.2.51:22/", "http://public.example:2043/", "http://public.example:46969/", "http://public.example:9182/"} {
		for _, kind := range []string{"check", "enrich"} {
			before := dialed
			_, err := r.Execute(context.Background(), model.Job{Kind: kind, Parameters: map[string]any{"kind": "http", "target": target}}, nil, nil)
			if !errors.Is(err, ErrPolicyDenied) || dialed != before {
				t.Fatalf("%s %s escaped policy before dial: %v", kind, target, err)
			}
		}
	}
	for _, path := range []string{"/private-redirect", "/metadata-redirect"} {
		for _, kind := range []string{"check", "enrich"} {
			before := dialed
			_, err := r.Execute(context.Background(), model.Job{Kind: kind, Parameters: map[string]any{"kind": "http", "target": "http://public.example" + path}}, nil, nil)
			if !errors.Is(err, ErrPolicyDenied) || dialed != before+1 {
				t.Fatalf("%s %s redirect escaped policy: %v; dials=%d", kind, path, err, dialed-before)
			}
		}
	}
	for _, port := range []int{9182, 2043, 46969} {
		if err := base.ValidatePortIPs([]net.IP{net.ParseIP("172.20.0.4")}, port); !errors.Is(err, netguard.ErrPolicyDenied) {
			t.Fatalf("integration port access expanded to %d: %v", port, err)
		}
	}
	for _, host := range []string{"10.73.40.8", "10.73.41.27", "public.example", "192.0.2.51", "192.0.2.52", "192.0.2.53", "192.0.2.54", "10.73.42.100"} {
		if _, err := base.Resolve(context.Background(), host); !errors.Is(err, netguard.ErrPolicyDenied) {
			t.Fatalf("integration access expanded for %s: %v", host, err)
		}
		if _, err := base.IperfChecks().Resolve(context.Background(), host); !errors.Is(err, netguard.ErrPolicyDenied) {
			t.Fatalf("throughput access expanded for %s: %v", host, err)
		}
	}
}

func TestExplicitCheckDestinationStillVerifiesTLS(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("untrusted TLS reached application") }))
	defer server.Close()
	dial := func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(server.URL, "https://"))
	}
	base, err := netguard.NewWithDependencies(nil, []int{443}, "", quickResolver{}, dial)
	if err != nil {
		t.Fatal(err)
	}
	checks, err := netguard.NewWithDependencies([]string{"192.0.2.42/32"}, []int{443, 2043}, "", quickResolver{}, dial)
	if err != nil {
		t.Fatal(err)
	}
	r := New(base, "")
	r.SetCheckGuard(checks)
	for _, kind := range []string{"check", "enrich"} {
		_, err := r.Execute(context.Background(), model.Job{Kind: kind, Parameters: map[string]any{"kind": "http", "target": "https://192.0.2.42:2043/"}}, nil, nil)
		// Both hostname and chain verification must reject this test certificate;
		// their reporting order differs between Go versions.
		if !errors.Is(err, ErrTLSHostname) && !errors.Is(err, ErrTLSUntrusted) {
			t.Fatalf("%s certificate failure misclassified or ignored: %v", kind, err)
		}
	}
}

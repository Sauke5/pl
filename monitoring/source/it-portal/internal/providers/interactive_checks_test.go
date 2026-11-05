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

func TestInteractiveJobsDoNotExpandEnrichmentOrProviders(t *testing.T) {
	fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
	defer fixture.Close()
	var dialed []string
	base, err := netguard.NewWithDependencies(nil, []int{443}, "", quickResolver{}, func(ctx context.Context, network, address string) (net.Conn, error) {
		dialed = append(dialed, address)
		return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(fixture.URL, "http://"))
	})
	if err != nil {
		t.Fatal(err)
	}
	r := New(base, "")
	r.EnableInteractiveChecks()
	for _, target := range []string{"http://10.73.43.22:19100/metrics", "http://public.example:8443/"} {
		out, err := r.Execute(context.Background(), model.Job{Kind: "check", Parameters: map[string]any{"kind": "http", "target": target}}, nil, nil)
		if err != nil || out["http_status"] != 200 {
			t.Fatalf("manual HTTP %s: %v %#v", target, err, out)
		}
		before := len(dialed)
		_, err = r.Execute(context.Background(), model.Job{Kind: "enrich", Parameters: map[string]any{"target": target}}, nil, nil)
		if !errors.Is(err, ErrPolicyDenied) || len(dialed) != before {
			t.Fatalf("enrichment expanded %s: %v", target, err)
		}
	}
	if dialed[0] != "10.73.43.22:19100" || dialed[1] != "8.8.8.8:8443" {
		t.Fatalf("unbound address: %#v", dialed)
	}
	if _, err := base.Resolve(context.Background(), "10.73.43.22"); !errors.Is(err, netguard.ErrPolicyDenied) {
		t.Fatalf("provider guard changed: %v", err)
	}
	for _, target := range []string{"http://127.0.0.1:19100/", "http://169.254.169.254/"} {
		before := len(dialed)
		_, err = r.Execute(context.Background(), model.Job{Kind: "check", Parameters: map[string]any{"kind": "http", "target": target}}, nil, nil)
		if !errors.Is(err, ErrPolicyDenied) || len(dialed) != before {
			t.Fatalf("protected target dialed %s: %v", target, err)
		}
	}
	for kind, target := range map[string]string{"dns": "10.73.43.22:19100", "reverse_dns": "http://10.73.43.22:19100/metrics"} {
		r.records = quickResolver{}
		out, err := r.Execute(context.Background(), model.Job{Kind: "check", Parameters: map[string]any{"kind": kind, "target": target}}, nil, nil)
		if err != nil || out["kind"] != kind {
			t.Fatalf("pasted endpoint %s: %v", kind, err)
		}
	}
}

func TestInteractiveHTTPStillVerifiesTLS(t *testing.T) {
	fixture := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("untrusted certificate reached application") }))
	defer fixture.Close()
	base, err := netguard.NewWithDependencies(nil, []int{443}, "", quickResolver{}, func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(fixture.URL, "https://"))
	})
	if err != nil {
		t.Fatal(err)
	}
	r := New(base, "")
	r.EnableInteractiveChecks()
	_, err = r.Execute(context.Background(), model.Job{Kind: "check", Parameters: map[string]any{"kind": "http", "target": "https://10.73.43.22:19100/"}}, nil, nil)
	if !errors.Is(err, ErrTLSHostname) && !errors.Is(err, ErrTLSUntrusted) {
		t.Fatalf("TLS verification was bypassed or obscured: %v", err)
	}
}

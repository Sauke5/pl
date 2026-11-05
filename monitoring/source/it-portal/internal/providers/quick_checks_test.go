package providers

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"pl/portal/internal/netguard"
	"strings"
	"testing"
)

type quickResolver struct{}

func (quickResolver) LookupIPAddr(context.Context, string) ([]net.IPAddr, error) {
	return []net.IPAddr{{IP: net.ParseIP("8.8.8.8")}}, nil
}
func (quickResolver) LookupAddr(context.Context, string) ([]string, error) {
	return []string{"mail.example."}, nil
}
func (quickResolver) LookupMX(context.Context, string) ([]*net.MX, error) {
	return []*net.MX{{Host: "mx.example.", Pref: 10}}, nil
}
func (quickResolver) LookupTXT(_ context.Context, host string) ([]string, error) {
	if strings.HasPrefix(host, "_dmarc.") {
		return []string{"v=DMARC1; p=reject"}, nil
	}
	return []string{"v=spf1 -all", "unrelated"}, nil
}
func TestQuickCheckDNSAndPolicy(t *testing.T) {
	g, _ := netguard.NewWithDependencies(nil, []int{443}, "", quickResolver{}, func(context.Context, string, string) (net.Conn, error) { return nil, errors.New("unexpected dial") })
	r := New(g, "")
	r.records = quickResolver{}
	if _, e := r.check(context.Background(), "dns", "public.example"); !errors.Is(e, netguard.ErrPolicyDenied) {
		t.Fatal("default policy changed")
	}
	r.EnablePublicWebChecks()
	for _, kind := range []string{"dns", "reverse_dns", "dns_records"} {
		target := "public.example"
		if kind == "reverse_dns" {
			target = "8.8.8.8"
		}
		v, e := r.check(context.Background(), kind, target)
		if e != nil {
			t.Fatal(e)
		}
		if v["origin"] != "portal backend" || v["kind"] != kind {
			t.Fatal(v)
		}
		if kind == "dns_records" {
			if len(v["mx"].([]map[string]any)) != 1 || len(v["spf"].([]string)) != 1 || len(v["dmarc"].([]string)) != 1 {
				t.Fatal(v)
			}
		}
	}
	if _, e := r.check(context.Background(), "reverse_dns", "169.254.169.254"); !errors.Is(e, netguard.ErrPolicyDenied) {
		t.Fatal("metadata PTR allowed")
	}
}
func TestHTTPResultExplainsReachability(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(403)
	}))
	defer ts.Close()
	g, _ := netguard.NewWithDependencies(nil, []int{80}, "", quickResolver{}, func(ctx context.Context, network, addr string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(ts.URL, "http://"))
	})
	r := New(g, "")
	r.EnablePublicWebChecks()
	out, e := r.check(context.Background(), "http", "http://public.example/")
	if e != nil {
		t.Fatal(e)
	}
	if out["http_status"] != 403 || out["reachable"] != true || out["http_success"] != false || out["final_url"] != "http://public.example/" || out["content_type"] != "text/plain" {
		t.Fatalf("wrong summary %#v", out)
	}
}

package providers

import (
	"pl/portal/internal/model"
	"testing"
)

func TestCheckTargetSyntaxPreservesHostPortAndURLSemantics(t *testing.T) {
	for _, tc := range []struct {
		kind, target string
		valid        bool
	}{
		{"tcp", "", false}, {"tcp", "host", false}, {"tcp", ":443", false}, {"tcp", "host:0", false}, {"tcp", "https://host:70000", false},
		{"tcp", "host:445", true}, {"tcp", "[2001:db8::1]:445", true}, {"tcp", "https://host/path", true},
		{"http", "https://host/path?x=1", true}, {"http", "host/path", true}, {"http", "http://", false}, {"http", "https://user:password@host", false},
		{"dns", "server.example.test", true}, {"dns", "2001:db8::1", true}, {"dns", "https://host/path", true}, {"dns", "host:445", true},
		{"tls", "host", true}, {"tls", "[2001:db8::1]:443", true}, {"tls", "2001:db8::1", true},
		{"reverse_dns", "2001:db8::1", true}, {"reverse_dns", "http://10.73.43.22:9100/metrics", true},
		{"dns", "host:bad", false}, {"dns", "host:0", false}, {"dns", "https://user:secret@host", false},
		{"dns_records", "https://example.test/path", true}, {"dns_records", "host:19100", true}, {"dns_records", "10.73.43.22:19100", false}, {"nmap", "host:80,443", true}, {"iperf", "host:5201", true},
	} {
		if got := ValidateCheckTarget(tc.kind, tc.target) == nil; got != tc.valid {
			t.Errorf("%s %q valid=%v, want %v", tc.kind, tc.target, got, tc.valid)
		}
	}
	r := model.Resource{URL: "https://fallback.test", Hostname: "host.test", Check: model.Check{Target: "  "}}
	if ResourceCheckTarget(r) != r.URL {
		t.Fatal("blank explicit target must use URL")
	}
	r.URL = ""
	if ResourceCheckTarget(r) != "" {
		t.Fatal("host identity must not invent a check endpoint")
	}
}

package modules

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type resolverFunc func(context.Context, string) ([]net.IPAddr, error)

func (f resolverFunc) LookupIPAddr(c context.Context, h string) ([]net.IPAddr, error) { return f(c, h) }
func TestEndpointRejectsServiceAndCredentialURLs(t *testing.T) {
	for _, url := range []string{"file:///etc/passwd", "http://user:pass@192.168.1.1", "http://127.0.0.1:9090", "http://[::1]", "http://169.254.169.254", "http://100.100.100.200", "http://168.63.129.16", "http://0.1.2.3", "http://192.168.1.1?query=a", "http://192.168.1.1#x", "http://192.168.1.1/../secret", "http://192.168.1.1/%2fsecret", "http://192.168.1.1:0"} {
		if _, err := ValidateEndpoint(url); err == nil {
			t.Errorf("accepted %q", url)
		}
	}
	for _, url := range []string{"http://192.168.1.1:9090", "https://metrics.example.net/prometheus/", "http://[fd00::1]:9090"} {
		if _, err := ValidateEndpoint(url); err != nil {
			t.Errorf("rejected %q: %v", url, err)
		}
	}
}
func probeFixture(t *testing.T, handler http.HandlerFunc) (*PrometheusProbe, *int) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	calls := 0
	p := &PrometheusProbe{resolver: resolverFunc(func(context.Context, string) ([]net.IPAddr, error) {
		calls++
		return []net.IPAddr{{IP: net.ParseIP("192.168.1.10")}}, nil
	}), dial: func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != "192.168.1.10:9090" {
			t.Errorf("unpinned dial %s", address)
		}
		return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(server.URL, "http://"))
	}}
	return p, &calls
}
func TestPrometheusProbePinsDNSAndReadsActualTargets(t *testing.T) {
	paths := []string{}
	p, calls := probeFixture(t, func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		if r.Host != "prom.example:9090" {
			t.Error(r.Host)
		}
		switch r.URL.Path {
		case "/prom/-/ready":
			w.Write([]byte("ready"))
		case "/prom/api/v1/status/buildinfo":
			w.Write([]byte(`{"status":"success","data":{"version":"3.15.0"}}`))
		case "/prom/api/v1/targets":
			w.Write([]byte(`{"status":"success","data":{"activeTargets":[{"health":"up"},{"health":"down"}]}}`))
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
		}
	})
	out, err := p.Probe(context.Background(), "http://prom.example:9090/prom")
	if err != nil || out.State != "running" || out.Version != "3.15.0" || out.TargetsUp != 1 || out.TargetsTotal != 2 || *calls != 1 || len(paths) != 3 {
		t.Fatalf("%+v %v DNS=%d paths=%v", out, err, *calls, paths)
	}
}
func TestPrometheusRejectsRebindingBeforeDial(t *testing.T) {
	dialed := false
	p := NewPrometheusProbe()
	p.resolver = resolverFunc(func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("192.168.1.10")}, {IP: net.ParseIP("169.254.169.254")}}, nil
	})
	p.dial = func(context.Context, string, string) (net.Conn, error) { dialed = true; return nil, nil }
	if _, err := p.Probe(context.Background(), "http://prom.example:9090"); err == nil || dialed {
		t.Fatalf("DNS policy bypass err=%v dialed=%v", err, dialed)
	}
}
func TestPrometheusRejectsRedirectAndFalseSuccess(t *testing.T) {
	for _, scenario := range []string{"redirect", "false-json", "missing-targets", "too-large"} {
		t.Run(scenario, func(t *testing.T) {
			p, _ := probeFixture(t, func(w http.ResponseWriter, r *http.Request) {
				switch scenario {
				case "redirect":
					http.Redirect(w, r, "http://127.0.0.1/", 302)
				case "false-json":
					json.NewEncoder(w).Encode(map[string]any{"status": "ok"})
				case "missing-targets":
					if strings.HasSuffix(r.URL.Path, "buildinfo") {
						w.Write([]byte(`{"status":"success","data":{"version":"test"}}`))
					} else {
						w.Write([]byte(`{"status":"success","data":{}}`))
					}
				case "too-large":
					w.Write([]byte(strings.Repeat("a", (2<<20)+1)))
				}
			})
			if _, err := p.Probe(context.Background(), "http://prom.example:9090"); err == nil {
				t.Fatal("accepted false success")
			}
		})
	}
}

package modules

import (
	"context"
	"encoding/pem"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pl/portal/internal/model"
	"pl/portal/internal/netguard"
)

type bookstackDNS struct{ ips []net.IPAddr }

func (d *bookstackDNS) LookupIPAddr(context.Context, string) ([]net.IPAddr, error) {
	return append([]net.IPAddr(nil), d.ips...), nil
}

func bookstackConnectorFixture(t *testing.T, handler http.HandlerFunc) (*BookStackConnector, model.Integration, *bookstackDNS, *int) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	dns := &bookstackDNS{[]net.IPAddr{{IP: net.ParseIP("10.20.30.40")}}}
	dials := new(int)
	guard, err := netguard.NewWithDependencies(nil, []int{443}, "", dns, func(ctx context.Context, network, address string) (net.Conn, error) {
		*dials++
		if address != "10.20.30.40:8084" {
			t.Error("connection escaped its pinned address", address)
		}
		return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(server.URL, "http://"))
	})
	if err != nil {
		t.Fatal(err)
	}
	connector := NewBookStackConnector(guard)
	origin, config, err := connector.Approve(context.Background(), "http://WIKI.example:8084/", "https://pl.example")
	if err != nil {
		t.Fatal(err)
	}
	config["module_mode"] = "external"
	integration := model.Integration{ID: "33333333-3333-4333-8333-333333333333", ManagedModuleID: "22222222-2222-4222-8222-222222222222", Kind: "bookstack", URL: origin, Enabled: true, Config: config}
	return connector, integration, dns, dials
}

func bookstackFixtureResponse(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/status" {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"database":true,"cache":true,"session":true}`)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	io.WriteString(w, `<form method="POST" action="https://pl.example/wiki/login"><input name="_token"></form>`)
}

func TestBookStackExternalProbeUsesBoundAddressNativeStatusAndExactAPPURL(t *testing.T) {
	requests := 0
	connector, integration, _, dials := bookstackConnectorFixture(t, func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Host != "pl.example" || r.Method != http.MethodGet || r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" || r.Header.Get("X-PL-User") != "" || r.Header.Get("X-Forwarded-Proto") != "https" {
			t.Error("health request carries credentials or wrong public origin")
		}
		bookstackFixtureResponse(w, r)
	})
	observation, err := connector.Probe(context.Background(), integration, "https://pl.example")
	if err != nil || observation.State != "running" || observation.Endpoint != "http://wiki.example:8084" || observation.Version != "" || requests != 2 || *dials != 2 {
		t.Fatalf("native readiness not confirmed: %+v %v requests=%d dials=%d", observation, err, requests, *dials)
	}
}

func TestBookStackExternalRejectsRebindingBeforeDialAndForeignSavedBinding(t *testing.T) {
	connector, integration, dns, dials := bookstackConnectorFixture(t, bookstackFixtureResponse)
	for _, values := range [][]net.IPAddr{
		{{IP: net.ParseIP("10.20.30.41")}},
		{{IP: net.ParseIP("10.20.30.40")}, {IP: net.ParseIP("10.20.30.41")}},
		{{IP: net.ParseIP("169.254.169.254")}},
	} {
		dns.ips = values
		if _, err := connector.Probe(context.Background(), integration, "https://pl.example"); err == nil || *dials != 0 {
			t.Fatal("DNS change reached the transport", err, *dials)
		}
	}
	dns.ips = []net.IPAddr{{IP: net.ParseIP("10.20.30.40")}}
	for _, key := range []string{"connection_origin", "connection_ips", "app_url", "module_mode"} {
		copy := integration
		copy.Config = make(map[string]string)
		for name, value := range integration.Config {
			copy.Config[name] = value
		}
		copy.Config[key] = "foreign"
		if _, err := connector.Probe(context.Background(), copy, "https://pl.example"); err == nil || *dials != 0 {
			t.Fatal("invalid persisted binding reached the transport", key, err)
		}
	}
}

func TestBookStackExternalApprovalRejectsSpecialDestinationsAndSelectablePaths(t *testing.T) {
	connector, _, dns, dials := bookstackConnectorFixture(t, bookstackFixtureResponse)
	for _, endpoint := range []string{"https://wiki.example/wiki", "https://wiki.example/status", "https://user:password@wiki.example", "https://wiki.example?target=other", "https://wiki.example#fragment"} {
		if _, _, err := connector.Approve(context.Background(), endpoint, "https://pl.example"); err == nil {
			t.Error("selectable target accepted", endpoint)
		}
	}
	for _, address := range []string{"127.0.0.1", "169.254.169.254", "100.100.100.200", "168.63.129.16", "fd00:ec2::254", "::1"} {
		dns.ips = []net.IPAddr{{IP: net.ParseIP(address)}}
		if _, _, err := connector.Approve(context.Background(), "https://wiki.example", "https://pl.example"); err == nil {
			t.Error("special destination accepted", address)
		}
	}
	if *dials != 0 {
		t.Fatal("approval performed an HTTP request")
	}
}

func TestBookStackExternalReadinessRejectsRedirectIncompleteStatusAndWrongAPPURL(t *testing.T) {
	for _, scenario := range []string{"status-redirect", "login-redirect", "missing-cache", "foreign-app-url", "wrong-login-path"} {
		t.Run(scenario, func(t *testing.T) {
			requests := 0
			connector, integration, _, _ := bookstackConnectorFixture(t, func(w http.ResponseWriter, r *http.Request) {
				requests++
				if scenario == "status-redirect" && r.URL.Path == "/status" || scenario == "login-redirect" && r.URL.Path == "/login" {
					http.Redirect(w, r, "/must-not-follow", 302)
					return
				}
				if scenario == "missing-cache" {
					io.WriteString(w, `{"database":true,"session":true}`)
					return
				}
				if r.URL.Path == "/login" && scenario == "foreign-app-url" {
					w.Header().Set("Content-Type", "text/html")
					io.WriteString(w, `<form action="https://old.example/wiki/login"></form>`)
					return
				}
				if r.URL.Path == "/login" && scenario == "wrong-login-path" {
					w.Header().Set("Content-Type", "text/html")
					io.WriteString(w, `<form action="https://pl.example/login"></form>`)
					return
				}
				bookstackFixtureResponse(w, r)
			})
			if _, err := connector.Probe(context.Background(), integration, "https://pl.example"); err == nil || requests > 2 {
				t.Fatal("incomplete native contract accepted or redirect followed", err, requests)
			}
		})
	}
}

func TestBookStackExternalTLSRequiresTrustedCAAndOriginalHostname(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(bookstackFixtureResponse))
	defer server.Close()
	ca := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []struct {
		name, host, ca string
		valid          bool
	}{{"trusted", "example.com", ca, true}, {"untrusted", "example.com", "", false}, {"wrong-hostname", "wrong.example", ca, false}} {
		t.Run(scenario.name, func(t *testing.T) {
			dns := &bookstackDNS{[]net.IPAddr{{IP: net.ParseIP("10.20.30.40")}}}
			guard, err := netguard.NewWithDependencies(nil, nil, scenario.ca, dns, func(ctx context.Context, network, address string) (net.Conn, error) {
				if address != "10.20.30.40:443" {
					t.Error("TLS connected outside approved destination", address)
				}
				return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(server.URL, "https://"))
			})
			if err != nil {
				t.Fatal(err)
			}
			connector := NewBookStackConnector(guard)
			endpoint, config, err := connector.Approve(context.Background(), "https://"+scenario.host, "https://pl.example")
			if err != nil {
				t.Fatal(err)
			}
			config["module_mode"] = "external"
			_, err = connector.Probe(context.Background(), model.Integration{Kind: "bookstack", ManagedModuleID: "22222222-2222-4222-8222-222222222222", Enabled: true, URL: endpoint, Config: config}, "https://pl.example")
			if (err == nil) != scenario.valid {
				t.Fatalf("TLS verification result %v want success=%v", err, scenario.valid)
			}
		})
	}
}

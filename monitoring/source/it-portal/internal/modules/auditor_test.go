package modules

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/netguard"
)

func auditorFixture(t *testing.T, handler http.HandlerFunc) (*AuditorConnector, model.Integration) {
	t.Helper()
	upstream := httptest.NewServer(handler)
	t.Cleanup(upstream.Close)
	guard, err := netguard.NewWithDependencies([]string{"10.0.0.0/8"}, []int{80, 443}, "", resolverFunc(func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("10.0.0.5")}}, nil
	}), func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != "10.0.0.5:80" {
			t.Errorf("unapproved dial: %s", address)
		}
		return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(upstream.URL, "http://"))
	})
	if err != nil {
		t.Fatal(err)
	}
	key := []byte("0123456789abcdef0123456789abcdef")
	connector := NewAuditorConnector(guard, func(_ context.Context, i model.Integration) ([]byte, error) {
		if i.SecretRef != "file:auditor-fixture.key" {
			t.Fatal("unexpected key reference")
		}
		return key, nil
	})
	connector.clock = func() time.Time { return time.Unix(1790000000, 0) }
	return connector, model.Integration{ID: "auditor-source", Kind: "fileauditor", URL: "http://auditor.example/audit", Enabled: true, SecretRef: "file:auditor-fixture.key", TimeoutSeconds: 2}
}

func TestAuditorEndpointAndRouteBoundaries(t *testing.T) {
	for _, endpoint := range []string{"https://auditor.example/audit", "http://10.73.43.25:8443/audit-arch/"} {
		if _, err := ValidateAuditorEndpoint(endpoint); err != nil {
			t.Fatalf("rejected supported endpoint: %v", err)
		}
	}
	for _, endpoint := range []string{"http://127.0.0.1/audit", "http://169.254.169.254/audit", "http://100.100.100.200/audit", "http://user:secret@auditor.example/audit", "https://auditor.example/", "https://auditor.example/audit/foo", "https://auditor.example/audit?key=fixture", "https://auditor.example/audit#fixture", "https://auditor.example/%61udit", "https://auditor.example/audit//"} {
		if _, err := ValidateAuditorEndpoint(endpoint); err == nil {
			t.Errorf("accepted invalid endpoint: %s", endpoint)
		}
	}
	for _, path := range []string{"/api/instance", "/api/findings", "/api/dashboard", "/api/scans/current", "/api/scans/latest", "/api/departments/1", "/assets/index-abcdef12.js", "/"} {
		if err := ValidateAuditorRead(path, "q=a%2Fb"); err != nil {
			t.Errorf("rejected gateway read: %s", path)
		}
	}
	for _, pair := range [][2]string{{"/login", ""}, {"/health", ""}, {"/api/config", ""}, {"/api/../instance", ""}, {"/api/%2e%2e/instance", ""}, {"//api/instance", ""}, {"/api/instance", "q=%0a"}, {"/api/instance", "q=%zz"}, {"/api/instance", "q=тест"}, {"/api/instance", strings.Repeat("x", 8193)}, {"/api/instance", "x=1#fragment"}} {
		if err := ValidateAuditorRead(pair[0], pair[1]); err == nil {
			t.Errorf("accepted unsafe gateway read: %q", pair)
		}
	}
}

func TestAuditorProbeAuthenticatesReadAndRequiresInstanceJSON(t *testing.T) {
	requests := 0
	key := []byte("0123456789abcdef0123456789abcdef")
	connector, integration := auditorFixture(t, func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Method != http.MethodGet || r.URL.RequestURI() != "/audit/api/instance" || r.Host != "auditor.example" || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.Header.Get("Proxy-Authorization") != "" {
			t.Error("unexpected request identity or target")
		}
		encoded := r.Header.Get("X-PL-Gateway-Assertion")
		mac := hmac.New(sha256.New, key)
		_, _ = mac.Write([]byte("pl-gateway-v2\n" + encoded))
		if r.Header.Get("X-PL-Gateway-Signature") != base64.RawURLEncoding.EncodeToString(mac.Sum(nil)) {
			t.Error("invalid v2 signature")
		}
		payload, err := base64.RawURLEncoding.DecodeString(encoded)
		if err != nil {
			t.Fatal(err)
		}
		var claims map[string]any
		if json.Unmarshal(payload, &claims) != nil || claims["v"] != float64(2) || claims["aud"] != "auditor" || claims["admin"] != false || claims["csrf_verified"] != false || claims["method"] != "GET" || claims["uri"] != r.URL.RequestURI() || claims["exp"].(float64)-claims["iat"].(float64) != 30 || claims["body_sha256"] != "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" {
			t.Fatal("incorrect signed read capabilities or target")
		}
		scopes, ok := claims["scopes"].([]any)
		if !ok || len(scopes) != 1 || scopes[0] != "auditor:read" || claims["sub"] != "system:modules:fileauditor" {
			t.Fatal("background connector grants user or scan privileges")
		}
		if nonce, err := base64.RawURLEncoding.DecodeString(claims["nonce"].(string)); err != nil || len(nonce) != 32 {
			t.Fatal("invalid nonce")
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write([]byte(`{"machineName":"FILES-LAB","roots":[{"name":"Documents","path":"D:\\Data"}],"futureField":true}`))
	})
	instance, err := connector.Instance(context.Background(), integration)
	if err != nil || instance.MachineName != "FILES-LAB" || instance.RootCount != 1 {
		t.Fatalf("instance contract rejected: %+v %v", instance, err)
	}
	observation, err := connector.Probe(context.Background(), integration)
	if err != nil || observation.State != "running" || observation.Endpoint != integration.URL || observation.Version != "" || observation.TargetsUp != 0 || observation.TargetsTotal != 0 || requests != 2 {
		t.Fatalf("probe fabricated non-instance data: %+v %v requests=%d", observation, err, requests)
	}
}

func TestAuditorReadPreservesSignedQueryAndDropsUpstreamHeaders(t *testing.T) {
	connector, integration := auditorFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RequestURI() != "/audit-arch/api/findings?q=a%2Fb&q=two" {
			t.Error("query or prefix was reconstructed")
		}
		payload, _ := base64.RawURLEncoding.DecodeString(r.Header.Get("X-PL-Gateway-Assertion"))
		var claims map[string]any
		if json.Unmarshal(payload, &claims) != nil || claims["uri"] != r.URL.RequestURI() {
			t.Error("query not bound to assertion")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Set-Cookie", "upstream=fixture")
		w.Header().Set("X-PL-Gateway-Assertion", "must-not-forward")
		w.Header().Set("Location", "https://other.example")
		_, _ = w.Write([]byte(`{"items":[]}`))
	})
	integration.URL = "http://auditor.example/audit-arch"
	response, err := connector.Read(context.Background(), integration, "/api/findings", "q=a%2Fb&q=two")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if len(response.Header) != 1 || response.Header.Get("Content-Type") != "application/json" {
		t.Fatal("upstream headers escaped connector")
	}
	body, _ := io.ReadAll(response.Body)
	if string(body) != `{"items":[]}` {
		t.Fatal("read body changed")
	}
}

func TestAuditorRejectsFalseSuccessWithoutLeakingSourceErrors(t *testing.T) {
	for _, scenario := range []string{"html", "unauthorized", "redirect", "malformed", "missing-name", "missing-roots", "null-roots", "control-name", "trailing-json", "too-large"} {
		t.Run(scenario, func(t *testing.T) {
			requests := 0
			connector, integration := auditorFixture(t, func(w http.ResponseWriter, r *http.Request) {
				requests++
				w.Header().Set("Content-Type", "application/json")
				switch scenario {
				case "html":
					w.Header().Set("Content-Type", "text/html")
					_, _ = w.Write([]byte("<html>login secret-fixture</html>"))
				case "unauthorized":
					w.WriteHeader(401)
					_, _ = w.Write([]byte(`{"error":"secret-fixture"}`))
				case "redirect":
					http.Redirect(w, r, "http://auditor.example/audit/api/instance", 302)
				case "malformed":
					_, _ = w.Write([]byte(`{"secret-fixture"`))
				case "missing-name":
					_, _ = w.Write([]byte(`{"roots":[]}`))
				case "missing-roots":
					_, _ = w.Write([]byte(`{"machineName":"FILES-LAB"}`))
				case "null-roots":
					_, _ = w.Write([]byte(`{"machineName":"FILES-LAB","roots":null}`))
				case "control-name":
					_, _ = w.Write([]byte(`{"machineName":"FILES\nLAB","roots":[]}`))
				case "trailing-json":
					_, _ = w.Write([]byte(`{"machineName":"FILES-LAB","roots":[]} {"extra":true}`))
				case "too-large":
					_, _ = w.Write([]byte(strings.Repeat("a", (1<<20)+1)))
				}
			})
			observation, err := connector.Probe(context.Background(), integration)
			if err == nil || observation.State == "running" || requests != 1 || strings.Contains(err.Error(), "secret-fixture") || strings.Contains(err.Error(), "0123456789abcdef") {
				t.Fatalf("accepted incomplete/unsafe instance response: state=%s err=%v calls=%d", observation.State, err, requests)
			}
		})
	}
}

func TestAuditorRejectsUnconfiguredKeysAndDisabledIntegrationsBeforeNetwork(t *testing.T) {
	requests := 0
	connector, integration := auditorFixture(t, func(w http.ResponseWriter, r *http.Request) { requests++ })
	for _, scenario := range []string{"disabled", "wrong-kind", "no-reference", "key-error", "short-key", "long-key"} {
		t.Run(scenario, func(t *testing.T) {
			input := integration
			candidate := *connector
			switch scenario {
			case "disabled":
				input.Enabled = false
			case "wrong-kind":
				input.Kind = "prometheus"
			case "no-reference":
				input.SecretRef = ""
			case "key-error":
				candidate.resolveKey = func(context.Context, model.Integration) ([]byte, error) { return nil, errors.New("secret-fixture") }
			case "short-key", "long-key":
				length := 31
				if scenario == "long-key" {
					length = 33
				}
				candidate.resolveKey = func(context.Context, model.Integration) ([]byte, error) { return make([]byte, length), nil }
			}
			_, err := candidate.Probe(context.Background(), input)
			if err == nil || strings.Contains(err.Error(), "secret-fixture") || requests != 0 {
				t.Fatalf("unconfigured integration reached source or leaked key: err=%v calls=%d", err, requests)
			}
		})
	}
}

func TestAuditorReadHandlesCurrentScanAbsenceWithoutInventingData(t *testing.T) {
	requests := 0
	connector, integration := auditorFixture(t, func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.URL.Path != "/audit/api/scans/current" {
			t.Error("unexpected endpoint")
		}
		w.WriteHeader(http.StatusNoContent)
	})
	response, err := connector.Read(context.Background(), integration, "/api/scans/current", "")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode != 204 || len(body) != 0 || requests != 1 {
		t.Fatal("no active scan was replaced with fabricated data")
	}
}

func TestAuditorRejectsDestinationAndRoutePolicyBeforeKeyResolution(t *testing.T) {
	requests, keys := 0, 0
	connector, integration := auditorFixture(t, func(w http.ResponseWriter, r *http.Request) { requests++ })
	connector.resolveKey = func(context.Context, model.Integration) ([]byte, error) {
		keys++
		return []byte("0123456789abcdef0123456789abcdef"), nil
	}
	for _, path := range []string{"/api/config", "/api/../instance", "/api/%2e%2e/instance", "/login"} {
		if _, err := connector.Read(context.Background(), integration, path, ""); err == nil {
			t.Error("unapproved route accepted")
		}
	}
	guard, err := netguard.NewWithDependencies([]string{"10.0.0.0/8"}, []int{80}, "", resolverFunc(func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("10.0.0.5")}, {IP: net.ParseIP("169.254.169.254")}}, nil
	}), func(context.Context, string, string) (net.Conn, error) {
		t.Fatal("denied destination was dialed")
		return nil, errors.New("denied")
	})
	if err != nil {
		t.Fatal(err)
	}
	connector.guard = guard
	if _, err = connector.Probe(context.Background(), integration); err == nil {
		t.Error("mixed DNS policy denial accepted")
	}
	if requests != 0 || keys != 0 {
		t.Fatalf("rejected routes/destination reached key or source: requests=%d keys=%d", requests, keys)
	}
}

func TestAuditorDNSPreflightCannotBypassConnectionPolicy(t *testing.T) {
	lookups, keys, dials := 0, 0, 0
	guard, err := netguard.NewWithDependencies([]string{"10.0.0.0/8"}, []int{80}, "", resolverFunc(func(context.Context, string) ([]net.IPAddr, error) {
		lookups++
		if lookups == 1 {
			return []net.IPAddr{{IP: net.ParseIP("10.0.0.5")}}, nil
		}
		return []net.IPAddr{{IP: net.ParseIP("169.254.169.254")}}, nil
	}), func(context.Context, string, string) (net.Conn, error) {
		dials++
		return nil, errors.New("unexpected connection")
	})
	if err != nil {
		t.Fatal(err)
	}
	connector := NewAuditorConnector(guard, func(context.Context, model.Integration) ([]byte, error) {
		keys++
		return []byte("0123456789abcdef0123456789abcdef"), nil
	})
	integration := model.Integration{Kind: "fileauditor", URL: "http://auditor.example/audit", Enabled: true, SecretRef: "file:auditor.key"}
	observation, err := connector.Probe(context.Background(), integration)
	if err == nil || observation.State == "running" || lookups < 2 || keys != 1 || dials != 0 {
		t.Fatalf("preflight bypassed connection policy: state=%s err=%v lookups=%d keys=%d dials=%d", observation.State, err, lookups, keys, dials)
	}
}

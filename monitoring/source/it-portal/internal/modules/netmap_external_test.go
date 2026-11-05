package modules

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
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

func netMapExternalFixture(t *testing.T, handler http.HandlerFunc) (*NetMapConnector, model.Integration, *bookstackDNS, *int, *int, string) {
	t.Helper()
	key := bytes.Repeat([]byte{7}, 32)
	requests, dials := new(int), new(int)
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*requests++
		assertion := r.Header.Get("X-PL-Gateway-Assertion")
		signature, _ := base64.RawURLEncoding.DecodeString(r.Header.Get("X-PL-Gateway-Signature"))
		mac := hmac.New(sha256.New, key)
		mac.Write([]byte("pl-gateway-v2\n" + assertion))
		if !hmac.Equal(signature, mac.Sum(nil)) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.Header.Get("Authorization") != "" || r.Header.Get("X-Pl-Signature") != "" || r.Header.Get("X-Auth-User") != "" {
			t.Error("transport leaked non-gateway credentials")
		}
		handler(w, r)
	}))
	t.Cleanup(upstream.Close)
	ca := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: upstream.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	dns := &bookstackDNS{[]net.IPAddr{{IP: net.ParseIP("10.20.30.40")}}}
	guard, err := netguard.NewWithDependencies(nil, nil, ca, dns, func(ctx context.Context, network, address string) (net.Conn, error) {
		*dials++
		if address != "10.20.30.40:443" {
			t.Error("NetMap escaped approved numeric address", address)
		}
		return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(upstream.URL, "https://"))
	})
	if err != nil {
		t.Fatal(err)
	}
	connector := NewNetMapConnector(guard, func(_ context.Context, i model.Integration) ([]byte, *netguard.Guard, error) {
		if i.URL != "https://example.com" {
			return nil, nil, ErrNetMapConnection
		}
		bound, err := guard.BoundOrigin(i.URL, []string{"10.20.30.40"})
		return bytes.Clone(key), bound, err
	})
	i := model.Integration{ID: "33333333-3333-4333-8333-333333333333", ManagedModuleID: "22222222-2222-4222-8222-222222222222",
		Kind: "netmap", URL: "https://example.com", Enabled: true, Config: map[string]string{"module_mode": "external", "platform_origin": "https://pl.example"}}
	i.SecretRef = "managed:" + i.ID
	return connector, i, dns, requests, dials, upstream.URL
}

func netMapDescriptorResponse(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.URL.Path == "/netmap/api/instance" {
		io.WriteString(w, `{"module":"netmap","protocol":"pl-gateway-v2","version":"1.0.0","platform_origin":"https://pl.example"}`)
	} else if r.URL.Path == "/netmap/api/health" {
		io.WriteString(w, `{"status":"ok","sources_ok":1,"sources_total":1}`)
	} else {
		w.WriteHeader(404)
	}
}

func TestNetMapExternalPreflightRequiresSignedModuleDescriptorAndExpectedOrigin(t *testing.T) {
	for _, scenario := range []string{"valid", "wrong-key", "wrong-origin", "fake-200", "redirect", "wrong-protocol"} {
		t.Run(scenario, func(t *testing.T) {
			connector, _, _, requests, _, _ := netMapExternalFixture(t, func(w http.ResponseWriter, r *http.Request) {
				if scenario == "redirect" {
					http.Redirect(w, r, "https://other.example/netmap/api/instance", 302)
					return
				}
				if r.Method != "GET" || r.URL.RawQuery != "" || r.Header.Get("Cookie") != "" {
					t.Error("preflight is not a finite anonymous service read")
				}
				raw, _ := base64.RawURLEncoding.DecodeString(r.Header.Get("X-PL-Gateway-Assertion"))
				var claims map[string]any
				if json.Unmarshal(raw, &claims) != nil || claims["aud"] != "netmap" || claims["admin"] != false || claims["uri"] != r.URL.RequestURI() || claims["csrf_verified"] != false {
					t.Error("incorrect service assertion")
				}
				if r.URL.Path == "/netmap/api/instance" && scenario != "valid" && scenario != "wrong-key" {
					w.Header().Set("Content-Type", "application/json")
					switch scenario {
					case "wrong-origin":
						io.WriteString(w, `{"module":"netmap","protocol":"pl-gateway-v2","version":"1.0.0","platform_origin":"https://old.example"}`)
					case "wrong-protocol":
						io.WriteString(w, `{"module":"netmap","protocol":"bearer","version":"1.0.0","platform_origin":"https://pl.example"}`)
					default:
						io.WriteString(w, `{"status":"ok"}`)
					}
					return
				}
				netMapDescriptorResponse(w, r)
			})
			key := bytes.Repeat([]byte{7}, 32)
			if scenario == "wrong-key" {
				key[0]++
			}
			origin, ips, err := connector.Approve(context.Background(), "https://EXAMPLE.com/", "https://pl.example", key)
			if scenario == "valid" {
				if err != nil || origin != "https://example.com" || len(ips) != 1 || *requests != 2 {
					t.Fatal("preflight did not confirm both native identity and health", err, *requests)
				}
			} else if err == nil || *requests != 1 {
				t.Fatal("invalid source accepted or redirect followed", err, *requests)
			}
		})
	}
}

func TestNetMapExternalRejectsSSRFRebindingAndUntrustedTLS(t *testing.T) {
	connector, integration, dns, requests, dials, upstream := netMapExternalFixture(t, netMapDescriptorResponse)
	for _, ip := range []string{"127.0.0.1", "169.254.169.254", "::1", "fd00:ec2::254"} {
		dns.ips = []net.IPAddr{{IP: net.ParseIP(ip)}}
		if _, _, err := connector.Approve(context.Background(), integration.URL, "https://pl.example", bytes.Repeat([]byte{7}, 32)); err == nil {
			t.Error("SSRF destination accepted", ip)
		}
	}
	dns.ips = []net.IPAddr{{IP: net.ParseIP("10.20.30.41")}}
	if _, err := connector.Probe(context.Background(), integration, "https://pl.example"); err == nil || *dials != 0 {
		t.Fatal("DNS rebind reached numeric dial", err, *dials)
	}
	dns.ips = []net.IPAddr{{IP: net.ParseIP("10.20.30.40")}}
	for _, endpoint := range []string{"http://example.com", "https://example.com/netmap/", "https://user:pass@example.com", "https://example.com?target=other"} {
		if _, _, err := connector.Approve(context.Background(), endpoint, "https://pl.example", bytes.Repeat([]byte{7}, 32)); err == nil {
			t.Error("invalid endpoint accepted", endpoint)
		}
	}
	// Dial the actual fixture TLS listener while leaving its CA untrusted.
	untrustedGuard, err := netguard.NewWithDependencies(nil, nil, "", dns, func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != "10.20.30.40:443" {
			t.Error("TLS escaped approved IP", address)
		}
		return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(upstream, "https://"))
	})
	if err != nil {
		t.Fatal(err)
	}
	bad := NewNetMapConnector(untrustedGuard, connector.credential)
	if _, _, err := bad.Approve(context.Background(), integration.URL, "https://pl.example", bytes.Repeat([]byte{7}, 32)); err == nil || *requests != 0 {
		t.Fatal("untrusted TLS certificate reached application", err, *requests)
	}
	if _, _, err := connector.Approve(context.Background(), "https://wrong.example", "https://pl.example", bytes.Repeat([]byte{7}, 32)); err == nil || *requests != 0 {
		t.Fatal("wrong TLS hostname accepted", err, *requests)
	}
}

func TestNetMapExternalTransportPreservesSignedNativeWireAndRejectsChangesBeforeDial(t *testing.T) {
	const path = "/netmap/netbox/login/"
	const query = "return=%2Fnetmap%2Fnetbox%2F&tag=a%2Fb"
	body := []byte("username=pl-admin&password=native&_token=csrf")
	headers, _ := netMapProbeHeaders("/netmap/api/health", bytes.Repeat([]byte{7}, 32))
	raw, _ := base64.RawURLEncoding.DecodeString(headers.Get("X-PL-Gateway-Assertion"))
	var claims map[string]any
	json.Unmarshal(raw, &claims)
	digest := sha256.Sum256(body)
	claims["method"], claims["uri"], claims["content_type"], claims["body_sha256"] = "POST", path+"?"+query, "application/x-www-form-urlencoded", hex.EncodeToString(digest[:])
	claims["sub"], claims["admin"], claims["scopes"], claims["csrf_verified"] = "browser-admin", true, []string{"netmap:admin"}, true
	raw, _ = json.Marshal(claims)
	assertion := base64.RawURLEncoding.EncodeToString(raw)
	mac := hmac.New(sha256.New, bytes.Repeat([]byte{7}, 32))
	mac.Write([]byte("pl-gateway-v2\n" + assertion))
	headers.Set("X-PL-Gateway-Assertion", assertion)
	headers.Set("X-PL-Gateway-Signature", base64.RawURLEncoding.EncodeToString(mac.Sum(nil)))
	headers.Set("Cookie", "pl_netbox_sessionid=native")
	connector, integration, _, requests, _, _ := netMapExternalFixture(t, func(w http.ResponseWriter, r *http.Request) {
		actual, _ := io.ReadAll(r.Body)
		if r.Method != "POST" || r.URL.RequestURI() != path+"?"+query || !bytes.Equal(actual, body) || r.Header.Get("X-PL-Gateway-Assertion") != assertion || r.Header.Get("Cookie") != "pl_netbox_sessionid=native" {
			t.Error("signed native wire changed")
		}
		w.Header().Set("Content-Type", "text/html")
		w.Header().Set("Location", "https://pl.example/netmap/netbox/")
		w.Header().Set("Set-Cookie", "pl_netbox_sessionid=updated; Path=/netmap/netbox/; Secure; HttpOnly")
		w.Header().Set("X-Accel-Redirect", "/auth/logout")
		w.WriteHeader(302)
	})
	response, err := connector.Request(context.Background(), integration, "https://pl.example", "POST", path, query, "application/x-www-form-urlencoded", headers, body)
	if err != nil || response.StatusCode != 302 || *requests != 1 || response.Header.Get("X-Accel-Redirect") != "" || response.Header.Get("Location") != "https://pl.example/netmap/netbox/" {
		t.Fatal("native redirect not returned as guarded response", err, *requests)
	}
	response.Body.Close()
	for _, mutate := range []func(http.Header){func(h http.Header) { h.Set("Authorization", "Bearer private") }, func(h http.Header) { h.Set("X-PL-Gateway-Signature", "forged") }} {
		bad := headers.Clone()
		mutate(bad)
		if _, err := connector.Request(context.Background(), integration, "https://pl.example", "POST", path, query, "application/x-www-form-urlencoded", bad, body); err == nil || *requests != 1 {
			t.Fatal("unsafe request reached remote", err, *requests)
		}
	}
	if _, err := connector.Request(context.Background(), integration, "https://pl.example", "POST", path, query, "application/x-www-form-urlencoded", headers, []byte("changed")); err == nil || *requests != 1 {
		t.Fatal("signature reused for another body", err, *requests)
	}
}

func TestNetMapExternalNativeResponseContentTypeFallbackAndValidation(t *testing.T) {
	for _, scenario := range []struct {
		name, method string
		status       int
		contentTypes []string
		wantType     string
	}{
		{"not-modified-without-type", "GET", 304, nil, "application/octet-stream"},
		{"no-content-without-type", "GET", 204, nil, "application/octet-stream"},
		{"head-without-type", "HEAD", 200, nil, "application/octet-stream"},
		{"explicit-type-preserved", "GET", 200, []string{"application/javascript"}, "application/javascript"},
		{"duplicate-type", "GET", 200, []string{"application/javascript", "text/css"}, ""},
		{"empty-type-is-not-absent", "GET", 200, []string{""}, ""},
		{"oversized-type", "GET", 200, []string{strings.Repeat("a", 257)}, ""},
		{"invalid-control-in-type", "GET", 200, []string{"text/plain\x01"}, ""},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			const path = "/netmap/netbox/static/app.js"
			key := bytes.Repeat([]byte{7}, 32)
			headers, err := netMapProbeHeaders("/netmap/api/health", key)
			if err != nil {
				t.Fatal(err)
			}
			raw, _ := base64.RawURLEncoding.DecodeString(headers.Get("X-PL-Gateway-Assertion"))
			var claims map[string]any
			if err = json.Unmarshal(raw, &claims); err != nil {
				t.Fatal(err)
			}
			claims["method"], claims["uri"], claims["admin"], claims["scopes"] = scenario.method, path, true, []string{"netmap:admin"}
			raw, _ = json.Marshal(claims)
			assertion := base64.RawURLEncoding.EncodeToString(raw)
			mac := hmac.New(sha256.New, key)
			mac.Write([]byte("pl-gateway-v2\n" + assertion))
			headers.Set("X-PL-Gateway-Assertion", assertion)
			headers.Set("X-PL-Gateway-Signature", base64.RawURLEncoding.EncodeToString(mac.Sum(nil)))
			headers.Set("If-None-Match", `"fixture-v1"`)
			connector, integration, _, requests, _, _ := netMapExternalFixture(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Method != scenario.method || r.URL.Path != path || r.Header.Get("If-None-Match") != `"fixture-v1"` {
					t.Error("native cache request changed")
				}
				// A nil slice suppresses Go's automatic content sniffing and emits no header.
				w.Header()["Content-Type"] = scenario.contentTypes
				w.Header().Set("ETag", `"fixture-v1"`)
				w.WriteHeader(scenario.status)
			})
			response, err := connector.Request(context.Background(), integration, "https://pl.example", scenario.method, path, "", "", headers, nil)
			if scenario.wantType == "" {
				if err == nil || response != nil {
					t.Fatal("invalid/duplicate content type accepted", scenario.name)
				}
				return
			}
			if err != nil {
				t.Fatal("native response without content type was rejected", err)
			}
			defer response.Body.Close()
			body, readErr := io.ReadAll(response.Body)
			if readErr != nil || response.StatusCode != scenario.status || response.Header.Get("Content-Type") != scenario.wantType || response.Header.Get("ETag") != `"fixture-v1"` || len(body) != 0 || *requests != 1 {
				t.Fatal("native cache/empty response was not preserved", response.StatusCode, response.Header, len(body), readErr)
			}
		})
	}
}

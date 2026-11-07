package modules

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

const netmapTestID = "123e4567-e89b-42d3-a456-426614174000"

func netmapTestHeaders() http.Header {
	return http.Header{"X-Pl-Gateway-Assertion": []string{"signed"}, "X-Pl-Gateway-Signature": []string{"signature"}}
}
func netmapTestEnvelope(id string, status int, body []byte, headers []map[string]string) map[string]any {
	return map[string]any{"instance_id": id, "status": status, "content_type": "application/json", "body": base64.StdEncoding.EncodeToString(body), "headers": headers}
}

func TestNetMapTransportAuthenticatesExactThreeMiBEnvelopeAndPreservesNativeHeaders(t *testing.T) {
	body := bytes.Repeat([]byte("x"), netMapBodyLimit)
	var calls atomic.Int32
	client := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		actual, _ := io.ReadAll(r.Body)
		mac := hmac.New(sha256.New, make([]byte, 32))
		mac.Write([]byte(r.Header.Get("X-Pl-Timestamp") + "\nPOST\n/v1/netmap/request\n"))
		mac.Write(actual)
		if r.URL.Path != "/v1/netmap/request" || r.Header.Get("X-Pl-Signature") != hex.EncodeToString(mac.Sum(nil)) || len(r.TransferEncoding) != 0 || r.ContentLength != int64(len(actual)) {
			t.Error("RPC identity or framing changed")
		}
		var payload struct {
			Instance string            `json:"instance_id"`
			Method   string            `json:"method"`
			Path     string            `json:"path"`
			Query    string            `json:"query"`
			Body     string            `json:"body"`
			Headers  map[string]string `json:"headers"`
		}
		if json.Unmarshal(actual, &payload) != nil {
			t.Fatal("invalid envelope")
		}
		decoded, _ := base64.StdEncoding.DecodeString(payload.Body)
		if payload.Instance != netmapTestID || payload.Path != "/netmap/netbox/login/" || payload.Query != "next=%2Fnetmap%2Fnetbox%2F" || payload.Method != "POST" || !bytes.Equal(decoded, body) {
			t.Error("signed application request changed")
		}
		_ = json.NewEncoder(w).Encode(netmapTestEnvelope(netmapTestID, 302, nil, []map[string]string{{"name": "Set-Cookie", "value": "pl_netbox_sessionid=native; Path=/netmap/netbox/"}, {"name": "Set-Cookie", "value": "pl_netbox_csrftoken=csrf; Path=/netmap/netbox/"}, {"name": "Location", "value": "/netmap/netbox/"}}))
	})
	response, err := client.netMapRequest(context.Background(), netmapTestID, "POST", "/netmap/netbox/login/", "next=%2Fnetmap%2Fnetbox%2F", "application/x-www-form-urlencoded", netmapTestHeaders(), body)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 302 || len(response.Header.Values("Set-Cookie")) != 2 || response.Header.Get("Location") != "/netmap/netbox/" || calls.Load() != 1 {
		t.Fatal("native headers/status lost or request replayed")
	}
}

func TestNetMapTransportRejectsUntrustedEnvelopeAndDestinations(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(map[string]any)
	}{
		{"foreign-instance", func(v map[string]any) { v["instance_id"] = "foreign" }},
		{"base64", func(v map[string]any) { v["body"] = "***" }},
		{"header-injection", func(v map[string]any) {
			v["headers"] = []map[string]string{{"name": "Location", "value": "/netmap/\r\nInjected: value"}}
		}},
		{"untrusted-header", func(v map[string]any) { v["headers"] = []map[string]string{{"name": "X-Auth-User", "value": "admin"}} }},
		{"unknown-field", func(v map[string]any) { v["endpoint"] = "http://foreign" }},
		{"duplicate-location", func(v map[string]any) {
			v["headers"] = []map[string]string{{"name": "Location", "value": "/netmap/netbox/"}, {"name": "Location", "value": "/netmap/gitea/"}}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			client := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
				value := netmapTestEnvelope(netmapTestID, 200, []byte(`{}`), nil)
				tc.mutate(value)
				_ = json.NewEncoder(w).Encode(value)
			})
			if response, err := client.netMapRequest(context.Background(), netmapTestID, "GET", "/netmap/api/topology", "", "", netmapTestHeaders(), nil); err == nil {
				response.Body.Close()
				t.Fatal("untrusted envelope admitted")
			}
		})
	}
	client := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) { t.Fatal("invalid request reached controller") })
	for _, path := range []string{"http://foreign/", "/netmap/../auth", "/netmap/%2e%2e/private", "/netmap//api/profiles", "/netmap/netbox/a b"} {
		if _, err := client.netMapRequest(context.Background(), netmapTestID, "GET", path, "", "", netmapTestHeaders(), nil); err == nil {
			t.Fatal("invalid destination", path)
		}
	}
	if _, err := client.netMapRequest(context.Background(), netmapTestID, "POST", "/netmap/api/profiles", "", "application/json", netmapTestHeaders(), bytes.Repeat([]byte("x"), netMapBodyLimit+1)); err == nil {
		t.Fatal("accepted oversized request")
	}
	headers := netmapTestHeaders()
	headers["Cookie"] = []string{"one", "two"}
	if _, err := client.netMapRequest(context.Background(), netmapTestID, "GET", "/netmap/", "", "", headers, nil); err == nil {
		t.Fatal("duplicate headers")
	}
}

func TestNetMapTransportResponseBoundary(t *testing.T) {
	for _, length := range []int{netMapResponseLimit, netMapResponseLimit + 1} {
		t.Run(strings.Repeat("x", length-netMapResponseLimit+1), func(t *testing.T) {
			client := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
				_ = json.NewEncoder(w).Encode(netmapTestEnvelope(netmapTestID, 200, bytes.Repeat([]byte("x"), length), nil))
			})
			response, err := client.netMapRequest(context.Background(), netmapTestID, "GET", "/netmap/api/topology", "", "", netmapTestHeaders(), nil)
			if length > netMapResponseLimit {
				if err == nil {
					response.Body.Close()
					t.Fatal("oversized response admitted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.ContentLength != int64(length) {
				t.Fatal("response truncated")
			}
		})
	}
}

func TestNetMapTransportKeepsOnlyFiniteManagementErrorCodes(t *testing.T) {
	for _, tc := range []struct {
		name, path, method, body, code string
		status                         int
	}{
		{"observations", "/netmap/api/networks/1234567890abcdef/observations", "POST", `{"error":"netmap_invalid_observations"}`, "netmap_invalid_observations", 400},
		{"snmp", "/netmap/api/profiles", "POST", `{"error":"netmap_snmp_required"}`, "netmap_snmp_required", 400},
		{"legacy", "/netmap/api/profiles", "POST", `{"error":"invalid NetMap request"}`, "netmap_invalid_request", 400},
		{"unknown", "/netmap/api/profiles", "POST", `{"error":"private-password"}`, "netmap_invalid_request", 400},
		{"extra-fields", "/netmap/api/profiles", "POST", `{"error":"netmap_snmp_required","details":"private-password"}`, "netmap_invalid_request", 400},
		{"duplicate-field", "/netmap/api/profiles", "POST", `{"error":"private-password","error":"netmap_snmp_required"}`, "netmap_invalid_request", 400},
		{"wrong-status", "/netmap/api/profiles", "POST", `{"error":"netmap_snmp_required"}`, "netmap_conflict", 409},
		{"busy", "/netmap/api/profiles", "POST", `{"error":"netmap_poll_running"}`, "netmap_poll_running", 409},
		{"host-key-port", "/netmap/api/inventory/ssh-host-key", "POST", `{"error":"inventory_invalid_port"}`, "inventory_invalid_port", 400},
		{"host-key-required", "/netmap/api/inventory/enroll", "POST", `{"error":"inventory_host_key_required"}`, "inventory_host_key_required", 422},
		{"host-key-dependency", "/netmap/api/inventory/ssh-host-key", "POST", `{"error":"inventory_dependency_missing"}`, "inventory_dependency_missing", 503},
		{"upstream", "/netmap/api/profiles", "POST", `{"error":"private-password"}`, "netmap_request_failed", 502},
		{"native", "/netmap/gitea/user/login", "POST", `{"error":"native validation"}`, "", 400},
		{"head", "/netmap/api/profiles", "HEAD", "", "", 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
				_ = json.NewEncoder(w).Encode(netmapTestEnvelope(netmapTestID, tc.status, []byte(tc.body), nil))
			})
			contentType := "application/json"
			var body []byte = []byte(`{}`)
			if tc.method == "HEAD" {
				contentType, body = "", nil
			}
			response, err := client.netMapRequest(context.Background(), netmapTestID, tc.method, tc.path, "", contentType, netmapTestHeaders(), body)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			data, _ := io.ReadAll(response.Body)
			want := tc.body
			if tc.code != "" {
				want = `{"error":"` + tc.code + `"}`
			}
			if response.StatusCode != tc.status || string(data) != want || response.ContentLength != int64(len(data)) {
				t.Fatal("management status/error sanitization changed native or finite behavior")
			}
		})
	}
	for _, body := range []string{`not JSON private-password`, `{"error":"netmap_snmp_required"} trailing`} {
		client := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewEncoder(w).Encode(netmapTestEnvelope(netmapTestID, 400, []byte(body), nil))
		})
		if response, err := client.netMapRequest(context.Background(), netmapTestID, "POST", "/netmap/api/profiles", "", "application/json", netmapTestHeaders(), []byte(`{}`)); err == nil {
			response.Body.Close()
			t.Fatal("malformed adapter error was treated as a valid validation response")
		}
	}
}

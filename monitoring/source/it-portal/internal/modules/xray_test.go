package modules

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"

	"pl/portal/internal/model"
)

func TestXrayControllerFiniteSignedRequestsAndRedaction(t *testing.T) {
	id := "11111111-1111-4111-8111-111111111111"
	ref := "22222222-2222-4222-8222-222222222222"
	var requests atomic.Int32
	c := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
		}
		mac := hmac.New(sha256.New, make([]byte, 32))
		mac.Write([]byte(r.Header.Get("X-Pl-Timestamp") + "\nPOST\n" + r.URL.Path + "\n"))
		mac.Write(body)
		if r.Method != "POST" || r.Header.Get("X-Pl-Signature") != hex.EncodeToString(mac.Sum(nil)) {
			t.Error("unsigned Xray request")
		}
		var input map[string]json.RawMessage
		if json.Unmarshal(body, &input) != nil {
			t.Error("invalid request")
		}
		var received string
		json.Unmarshal(input["instance_id"], &received)
		if received != id {
			t.Error("wrong instance")
		}
		switch r.URL.Path {
		case "/v1/xray/prepare":
			if !strings.Contains(string(body), "write-only-secret") {
				t.Error("prepare omitted credential")
			}
			json.NewEncoder(w).Encode(model.XrayConfiguration{Revision: 1, Ref: ref, Inbounds: []model.XrayInbound{}, Outbound: model.XrayOutbound{Mode: "direct"}, Routing: "proxy_all"})
		case "/v1/xray/validate":
			if string(input["configuration_ref"]) != `"`+ref+`"` || len(input) != 2 {
				t.Error("validate includes more than plan reference")
			}
			io.WriteString(w, `{"valid":true}`)
		case "/v1/xray/status":
			if len(input) != 1 {
				t.Error("arbitrary status parameters")
			}
			json.NewEncoder(w).Encode(model.XrayStatus{State: "running"})
		default:
			t.Error("unexpected endpoint")
			w.WriteHeader(404)
		}
	})
	input := model.XrayConfigurationInput{Inbounds: []model.XrayInboundInput{{Password: "write-only-secret"}}, Outbound: model.XrayOutboundInput{Mode: "direct"}}
	plan, err := c.PrepareXray(context.Background(), id, input)
	if err != nil || plan.Ref != ref {
		t.Fatalf("prepare %+v %v", plan, err)
	}
	if err := c.ValidateXray(context.Background(), id, ref); err != nil {
		t.Fatal(err)
	}
	if status, err := c.XrayStatus(context.Background(), id); err != nil || status.State != "running" {
		t.Fatalf("status %+v %v", status, err)
	}
	if requests.Load() != 3 {
		t.Fatal("unexpected request count")
	}
	bad := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(422)
		io.WriteString(w, `{"error":"write-only-secret vless://credential@example.invalid"}`)
	})
	_, err = bad.PrepareXray(context.Background(), id, input)
	if err == nil || strings.Contains(err.Error(), "write-only-secret") || strings.Contains(err.Error(), "vless://") {
		t.Fatalf("upstream failure leaked %v", err)
	}
	if err := c.ValidateXray(context.Background(), id, "foreign"); err == nil {
		t.Fatal("invalid plan accepted")
	}
}

func TestXrayOperationContainsOnlyFrozenReference(t *testing.T) {
	encoded, err := json.Marshal(Operation{OperationID: "job", InstanceID: "instance", ModuleID: "xray", Action: "configure", ConfigurationRef: "plan"})
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	json.Unmarshal(encoded, &wire)
	if wire["configuration_ref"] != "plan" || wire["configuration"] != nil || len(wire) != 5 {
		t.Fatalf("unsafe Xray operation %s", encoded)
	}
}

func TestXrayControllerAcceptsOnlyAllowlistedHTTP400Diagnostics(t *testing.T) {
	id := "11111111-1111-4111-8111-111111111111"
	cases := []struct {
		name, code string
		status     int
		known      bool
	}{
		{"invalid-outbound", "xray_invalid_outbound", 400, true},
		{"parameters", "xray_unsupported_outbound_parameters", 400, true},
		{"transport", "xray_unsupported_transport", 400, true},
		{"host-addresses", "xray_host_addresses_unavailable", 400, true},
		{"bind-address", "xray_invalid_bind_address", 400, true},
		{"port-in-use", "xray_port_in_use", 400, true},
		{"bind-unavailable", "xray_bind_unavailable", 400, true},
		{"unknown-code", "private-token-secret", 400, false},
		{"missing-code", "", 400, false},
		{"wrong-status", "xray_invalid_outbound", 500, false},
		{"unauthenticated-status", "xray_invalid_outbound", 403, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
				body, _ := io.ReadAll(r.Body)
				mac := hmac.New(sha256.New, make([]byte, 32))
				mac.Write([]byte(r.Header.Get("X-Pl-Timestamp") + "\nPOST\n" + r.URL.Path + "\n"))
				mac.Write(body)
				if r.Method != "POST" || r.URL.Path != "/v1/xray/prepare" || r.Header.Get("X-Pl-Signature") != hex.EncodeToString(mac.Sum(nil)) {
					t.Error("unsigned diagnostic request")
				}
				w.WriteHeader(tc.status)
				json.NewEncoder(w).Encode(map[string]string{"code": tc.code, "error": "private-token-secret vless://private@example.invalid", "message": "private-token-secret"})
			})
			_, err := c.PrepareXray(context.Background(), id, model.XrayConfigurationInput{})
			if err == nil {
				t.Fatal("rejection became success")
			}
			var diagnostic *XrayConfigurationError
			if errors.As(err, &diagnostic) != tc.known {
				t.Fatal("wrong diagnostic trust decision")
			}
			if tc.known && (diagnostic.Code != tc.code || !diagnostic.Known() || diagnostic.Error() != xrayConfigurationMessage(tc.code)) {
				t.Fatal("diagnostic was not mapped to fixed text")
			}
			if strings.Contains(err.Error(), "private-token-secret") || strings.Contains(err.Error(), "vless://") {
				t.Fatal("diagnostic exposed raw response")
			}
		})
	}
	unknown := &XrayConfigurationError{Code: "private-token-secret"}
	if unknown.Known() || strings.Contains(unknown.Error(), "private-token-secret") {
		t.Fatal("typed error accepts arbitrary code")
	}
}

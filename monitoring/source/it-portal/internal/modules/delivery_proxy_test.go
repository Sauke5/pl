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
	"testing"
)

func proxyText(v string) *string { return &v }
func proxyRequestFixture() DeliveryProxyConfiguration {
	return DeliveryProxyConfiguration{Mode: DeliveryProxyExternal, External: &DeliveryProxyExternalConfiguration{
		Protocol: DeliveryProxyHTTP, Host: "proxy.example.test", Port: 3128, Auth: DeliveryProxyPasswordAuth,
		Username: "fixture-user", PasswordAction: DeliveryProxySetPassword, Password: proxyText("proxy-request-only-fixture"),
	}}
}

func TestDeliveryProxyTransportBindsFinitePathsAndProjectsNoSecrets(t *testing.T) {
	const secret = "proxy-request-only-fixture"
	var client *HostController
	var seen []string
	client = controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mac := hmac.New(sha256.New, client.key)
		mac.Write([]byte(r.Header.Get("X-Pl-Timestamp") + "\nPOST\n" + r.URL.Path + "\n"))
		mac.Write(body)
		if r.Method != "POST" || r.Header.Get("X-Pl-Timestamp") == "" || r.Header.Get("X-Pl-Signature") != hex.EncodeToString(mac.Sum(nil)) {
			t.Error("proxy request lost authenticated method/path/body binding")
		}
		seen = append(seen, r.URL.Path)
		switch r.URL.Path {
		case "/v1/delivery/proxy/status":
			if string(body) != "{}" {
				t.Error("status accepts unexpected input")
			}
		case "/v1/delivery/proxy/configure":
			var change DeliveryProxyChange
			if json.Unmarshal(body, &change) != nil || change.Revision != 3 || !canonicalID(change.OperationID) || change.Configuration.External == nil || change.Configuration.External.Password == nil || *change.Configuration.External.Password != secret {
				t.Error("configure did not carry its finite secret input")
			}
		case "/v1/delivery/proxy/test":
			var test DeliveryProxyTestRequest
			if json.Unmarshal(body, &test) != nil || test.Revision != 3 || test.Configuration.External == nil {
				t.Error("invalid test input")
			}
			io.WriteString(w, `{"ok":false,"checked_at":"2026-11-05T12:00:00Z","mode":"external","latest_version":"","error_code":"delivery_proxy_auth","error":"proxy-request-only-fixture","password":"proxy-request-only-fixture"}`)
			return
		default:
			t.Error("unbounded proxy endpoint")
		}
		io.WriteString(w, `{"core_api":1,"revision":4,"configuration":{"mode":"external","external":{"protocol":"http","host":"proxy.example.test","port":3128,"auth":"password","username":"fixture-user","password_configured":true,"password":"proxy-request-only-fixture"},"ca_pem":"proxy-request-only-fixture"},"custom_ca":false,"ca_sha256":"","xray_inbounds":[],"error_code":"delivery_proxy_auth","error":"proxy-request-only-fixture"}`)
	})
	status, err := client.DeliveryProxyStatus(context.Background())
	if err != nil {
		t.Fatal("status request failed")
	}
	if status.Revision != 4 || status.Configuration.External == nil || !status.Configuration.External.PasswordConfigured {
		t.Fatal("public configuration was lost")
	}
	configured, err := client.ConfigureDeliveryProxy(context.Background(), DeliveryProxyChange{OperationID: "727b18f8-99da-410f-b94f-e677f2967731", Revision: 3, Configuration: proxyRequestFixture()})
	if err != nil {
		t.Fatal("configure request failed")
	}
	tested, err := client.TestDeliveryProxy(context.Background(), DeliveryProxyTestRequest{Revision: 3, Configuration: proxyRequestFixture()})
	if err != nil || tested.OK || tested.ErrorCode != "delivery_proxy_auth" || tested.Error == "" {
		t.Fatal("safe test failure was not projected")
	}
	for _, value := range []any{status, configured, tested} {
		encoded, err := json.Marshal(value)
		if err != nil || strings.Contains(string(encoded), secret) || strings.Contains(string(encoded), `"password":`) || strings.Contains(string(encoded), `"ca_pem":`) {
			t.Fatal("private host data reached a public proxy response")
		}
	}
	if strings.Join(seen, ",") != "/v1/delivery/proxy/status,/v1/delivery/proxy/configure,/v1/delivery/proxy/test" {
		t.Fatal("finite proxy calls changed")
	}
}

func TestDeliveryProxyPreservesOptionalSecretActionsOnWire(t *testing.T) {
	var client *HostController
	client = controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var request struct {
			Configuration map[string]json.RawMessage `json:"configuration"`
		}
		if json.Unmarshal(body, &request) != nil {
			t.Error("invalid proxy request")
		}
		if raw, present := request.Configuration["ca_pem"]; !present || string(raw) != `""` {
			t.Error("explicit CA clear lost its presence")
		}
		var external map[string]json.RawMessage
		if json.Unmarshal(request.Configuration["external"], &external) != nil || external["password"] != nil || string(external["password_action"]) != `"keep"` {
			t.Error("retained password was echoed or its action changed")
		}
		io.WriteString(w, `{"ok":true,"checked_at":"2026-11-05T12:00:00Z","mode":"external","latest_version":"0.4.0","error_code":"","error":""}`)
	})
	config := proxyRequestFixture()
	config.External.Password = nil
	config.External.PasswordAction = DeliveryProxyKeepPassword
	config.CAPEM = proxyText("")
	result, err := client.TestDeliveryProxy(context.Background(), DeliveryProxyTestRequest{Revision: 3, Configuration: config})
	if err != nil || !result.OK {
		t.Fatal("retained credential request failed")
	}
}

func TestDeliveryProxyRejectsInvalidConfigurationBeforeTransport(t *testing.T) {
	for _, modify := range []func(*DeliveryProxyConfiguration){
		func(v *DeliveryProxyConfiguration) { v.Mode = "arbitrary" },
		func(v *DeliveryProxyConfiguration) { v.Mode = DeliveryProxyDirect },
		func(v *DeliveryProxyConfiguration) { v.Xray = &DeliveryProxyXrayConfiguration{} },
		func(v *DeliveryProxyConfiguration) { v.External.Protocol = "socks4" },
		func(v *DeliveryProxyConfiguration) { v.External.Host = "http://user:password@proxy.example.test" },
		func(v *DeliveryProxyConfiguration) { v.External.Port = 0 },
		func(v *DeliveryProxyConfiguration) { v.External.Username = "user:invalid" },
		func(v *DeliveryProxyConfiguration) { v.External.Username = "user\tinvalid" },
		func(v *DeliveryProxyConfiguration) { v.External.Auth = DeliveryProxyNoAuth },
		func(v *DeliveryProxyConfiguration) { v.External.PasswordAction = DeliveryProxyKeepPassword },
		func(v *DeliveryProxyConfiguration) {
			v.External.PasswordAction = DeliveryProxyClearPassword
			v.External.Password = nil
		},
		func(v *DeliveryProxyConfiguration) { v.External.Password = nil },
		func(v *DeliveryProxyConfiguration) { v.External.Password = proxyText(strings.Repeat("x", 1025)) },
		func(v *DeliveryProxyConfiguration) {
			v.External.Protocol = DeliveryProxySOCKS5
			v.External.Password = proxyText(strings.Repeat("я", 128))
		},
		func(v *DeliveryProxyConfiguration) { v.External.Password = proxyText("invalid\x7fpassword") },
		func(v *DeliveryProxyConfiguration) { v.CAPEM = proxyText(strings.Repeat("x", 65537)) },
	} {
		value := proxyRequestFixture()
		modify(&value)
		if ValidateDeliveryProxyConfiguration(value) == nil {
			t.Fatal("invalid proxy configuration accepted")
		}
	}
	for _, value := range []DeliveryProxyConfiguration{
		{Mode: DeliveryProxyDirect},
		{Mode: DeliveryProxyXray, Xray: &DeliveryProxyXrayConfiguration{InstanceID: "727b18f8-99da-410f-b94f-e677f2967731", InboundTag: "updates"}},
		{Mode: DeliveryProxyExternal, External: &DeliveryProxyExternalConfiguration{Protocol: DeliveryProxySOCKS5, Host: "::1", Port: 1080, Auth: DeliveryProxyNoAuth, PasswordAction: DeliveryProxyClearPassword}},
	} {
		if ValidateDeliveryProxyConfiguration(value) != nil {
			t.Fatal("valid finite proxy configuration rejected")
		}
	}
	client := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) { t.Error("invalid/oversized proxy request reached host") })
	bad := proxyRequestFixture()
	bad.CAPEM = proxyText(strings.Repeat("<", 65536))
	if _, err := client.TestDeliveryProxy(context.Background(), DeliveryProxyTestRequest{Configuration: bad}); err == nil {
		t.Fatal("oversized encoded proxy request accepted")
	}
	if _, err := client.ConfigureDeliveryProxy(context.Background(), DeliveryProxyChange{OperationID: "../host", Configuration: proxyRequestFixture()}); err == nil {
		t.Fatal("noncanonical operation accepted")
	}
}

func TestDeliveryProxyReturnsOnlyReviewedHostErrorCodes(t *testing.T) {
	for _, tc := range []struct {
		code   string
		status int
		typed  bool
	}{
		{"delivery_proxy_invalid", 400, true}, {"delivery_proxy_conflict", 409, true}, {"delivery_proxy_busy", 409, true},
		{"delivery_proxy_unavailable", 502, true}, {"delivery_proxy_auth", 502, true}, {"delivery_proxy_tls", 502, true},
		{"delivery_proxy_timeout", 504, true}, {"delivery_proxy_catalog", 502, true}, {"private-unknown-code", 400, false}, {"delivery_proxy_invalid", 500, false},
	} {
		t.Run(tc.code+"-"+http.StatusText(tc.status), func(t *testing.T) {
			client := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": tc.code, "message": "proxy-fixture-must-not-leak"}})
			})
			_, err := client.DeliveryProxyStatus(context.Background())
			var known *DeliveryProxyError
			if err == nil || errors.As(err, &known) != tc.typed || strings.Contains(err.Error(), "proxy-fixture-must-not-leak") || strings.Contains(err.Error(), "private-unknown-code") {
				t.Fatal("unsafe host failure projected")
			}
		})
	}
}

func TestDeliveryProxyRejectsOversizedMalformedAndWrongProtocolStatus(t *testing.T) {
	for _, raw := range []string{"{", `{"core_api":2,"configuration":{"mode":"direct"}}`, strings.Repeat(" ", deliveryProxyResponseLimit+1)} {
		client := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, raw) })
		if _, err := client.DeliveryProxyStatus(context.Background()); err == nil {
			t.Fatal("unconfirmed proxy response accepted")
		}
	}
}

func TestDeliveryProxyJSONDoesNotEraseNullMissingOrDuplicateRequestFields(t *testing.T) {
	for _, raw := range []string{
		`{"configuration":{"mode":"direct"}}`,
		`{"revision":0,"revision":0,"configuration":{"mode":"direct"}}`,
		`{"revision":0,"configuration":{"mode":"direct","mode":"direct"}}`,
		`{"revision":0,"configuration":{"mode":"direct","external":null}}`,
		`{"revision":0,"configuration":{"mode":"direct","ca_pem":null}}`,
		`{"revision":0,"configuration":{"mode":"external","external":{"protocol":"http","host":"proxy.example.test","port":3128,"auth":"password","username":"fixture-user","password_action":"keep","password":null}}}`,
		`{"revision":0,"configuration":{"mode":"external","external":{"protocol":"http","host":"proxy.example.test","port":3128,"auth":"none","password_action":"clear"}}}`,
	} {
		var request DeliveryProxyTestRequest
		if json.Unmarshal([]byte(raw), &request) == nil {
			t.Fatal("proxy JSON silently changed presence or duplicate-key semantics")
		}
	}
}

func TestDeliveryProxyUnknownDiagnosticNeverEchoesHostDetails(t *testing.T) {
	client := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"core_api":1,"revision":0,"configuration":{"mode":"direct"},"error_code":"private-proxy-fixture","error":"private-proxy-fixture"}`)
	})
	status, err := client.DeliveryProxyStatus(context.Background())
	if err != nil || status.ErrorCode != "delivery_proxy_unavailable" || strings.Contains(status.Error, "private-proxy-fixture") {
		t.Fatal("unreviewed status diagnostic reached public projection")
	}
}

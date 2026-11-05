package modules

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestInstallationICMPPolicySignedOptionalWire(t *testing.T) {
	interactive, strict := "interactive", "cidr"
	empty := []string{}
	for _, tc := range []struct {
		name     string
		mode     *string
		cidrs    *[]string
		response string
	}{
		{"legacy", nil, nil, `{"core_api":1,"revision":1}`},
		{"interactive-clear", &interactive, &empty, `{"core_api":1,"revision":1,"icmp_policy_mode":"interactive","icmp_allowed_cidrs":[]}`},
		{"cidr-mode-only", &strict, nil, `{"core_api":1,"revision":1,"icmp_policy_mode":"cidr","icmp_allowed_cidrs":[]}`},
		{"explicit-empty-deny", nil, &empty, `{"core_api":1,"revision":1,"icmp_policy_mode":"cidr","icmp_allowed_cidrs":[]}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var client *HostController
			client = controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
				body, _ := io.ReadAll(r.Body)
				mac := hmac.New(sha256.New, client.key)
				mac.Write([]byte(r.Header.Get("X-Pl-Timestamp") + "\nPOST\n" + r.URL.Path + "\n"))
				mac.Write(body)
				if r.Method != "POST" || r.URL.Path != "/v1/installation/configure" || r.Header.Get("X-Pl-Signature") != hex.EncodeToString(mac.Sum(nil)) {
					t.Error("ICMP installation write is not bound to its exact finite HMAC request")
				}
				var fields map[string]json.RawMessage
				if json.Unmarshal(body, &fields) != nil {
					t.Error("invalid signed request JSON")
				}
				if _, present := fields["icmp_policy_mode"]; present != (tc.mode != nil) {
					t.Error("omitted ICMP mode changed meaning")
				}
				if raw, present := fields["icmp_allowed_cidrs"]; present != (tc.cidrs != nil) || present && string(raw) != "[]" {
					t.Error("explicit empty CIDR list was omitted or became null")
				}
				_, _ = io.WriteString(w, tc.response)
			})
			change := &InstallationChange{InstallationSettings: InstallationSettings{ICMPPolicyMode: tc.mode, ICMPAllowedCIDRs: tc.cidrs}, OperationID: "727b18f8-99da-410f-b94f-e677f2967731"}
			got, err := client.Installation(context.Background(), change)
			if err != nil || got.Revision != 1 || (got.ICMPPolicyMode == nil) != (tc.name == "legacy") {
				t.Fatal("optional ICMP status was not projected", err)
			}
		})
	}
}

func TestInstallationICMPPolicyJSONRejectsNullAndDuplicateFields(t *testing.T) {
	for _, fields := range []string{
		`"icmp_policy_mode":null`, `"icmp_allowed_cidrs":null`,
		`"icmp_policy_mode":"interactive","icmp_policy_mode":"cidr"`,
		`"icmp_allowed_cidrs":[],"icmp_allowed_cidrs":["10.20.30.40/32"]`,
		`"icmp_policy_mode":5`, `"icmp_allowed_cidrs":"10.20.30.40/32"`,
		`"unexpected_field":true`,
	} {
		var change InstallationChange
		if err := json.Unmarshal([]byte(`{`+fields+`}`), &change); err == nil {
			t.Fatalf("ambiguous/unknown installation fields accepted: %s", fields)
		}
	}
	for _, fields := range []string{``, `"icmp_allowed_cidrs":[]`, `"icmp_policy_mode":"interactive","icmp_allowed_cidrs":[]`} {
		var change InstallationChange
		if err := json.Unmarshal([]byte(`{`+fields+`}`), &change); err != nil {
			t.Fatal("compatible optional policy rejected", err)
		}
		if strings.Contains(fields, "icmp_allowed_cidrs") && (change.ICMPAllowedCIDRs == nil || len(*change.ICMPAllowedCIDRs) != 0) {
			t.Fatal("explicit deny/clear list was erased")
		}
	}
}

func TestInstallationSettingsSignedFiniteTransport(t *testing.T) {
	var client *HostController
	client = controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mac := hmac.New(sha256.New, client.key)
		mac.Write([]byte(r.Header.Get("X-Pl-Timestamp") + "\nPOST\n" + r.URL.Path + "\n"))
		mac.Write(body)
		if r.Header.Get("X-Pl-Signature") != hex.EncodeToString(mac.Sum(nil)) || r.Method != "POST" {
			t.Error("unsigned installation request")
		}
		if r.URL.Path != "/v1/installation/status" && r.URL.Path != "/v1/installation/configure" {
			t.Error("unbounded path")
		}
		json.NewEncoder(w).Encode(InstallationStatus{CoreAPI: 1, InstallationSettings: InstallationSettings{Revision: 1, PublicURL: "https://pl.example.test", BindAddress: "0.0.0.0", AllowedCIDRs: []string{"10.20.0.0/16"}, AllowedPorts: []int{443}}})
	})
	for _, change := range []*InstallationChange{nil, {InstallationSettings: InstallationSettings{Revision: 0, PublicURL: "https://pl.example.test", BindAddress: "0.0.0.0"}, OperationID: "727b18f8-99da-410f-b94f-e677f2967731"}} {
		got, err := client.Installation(context.Background(), change)
		if err != nil || got.Revision != 1 {
			t.Fatal(got, err)
		}
	}
}
func TestInstallationSettingsOnlyReturnsWhitelistedHostFailures(t *testing.T) {
	for _, code := range []string{"installation_conflict", "installation_origin_modules", "internal_error"} {
		client := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(409)
			json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": code, "message": "fixture-error"}})
		})
		_, err := client.Installation(context.Background(), nil)
		if err == nil {
			t.Fatal("failure accepted")
		}
		_, typed := err.(*InstallationError)
		if typed != (code != "internal_error") {
			t.Fatal("untrusted host error projected", code, err)
		}
	}
}

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

func TestInitialLoginTransportBindsRequestAndRejectsProviderSecrets(t *testing.T) {
	valid := NativeInitialLogin{InstanceID: netmapTestID, ModuleID: "netmap", Service: "netbox", Username: "pl-admin", Password: strings.Repeat("a", 64), Path: "/netmap/netbox/login/"}
	client := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mac := hmac.New(sha256.New, make([]byte, 32))
		mac.Write([]byte(r.Header.Get("X-Pl-Timestamp") + "\nPOST\n/v1/native/initial-login\n"))
		mac.Write(body)
		if r.Method != "POST" || r.URL.Path != "/v1/native/initial-login" || r.Header.Get("X-Pl-Signature") != hex.EncodeToString(mac.Sum(nil)) {
			t.Error("initial credential request lost authenticated binding")
		}
		var input map[string]string
		if json.Unmarshal(body, &input) != nil || len(input) != 3 || input["instance_id"] != netmapTestID || input["module_id"] != "netmap" || input["service"] != "netbox" {
			t.Error("unexpected controller request")
		}
		_ = json.NewEncoder(w).Encode(valid)
	})
	if value, err := client.InitialLogin(context.Background(), netmapTestID, "netmap", "netbox"); err != nil || value != valid {
		t.Fatal("valid administrator login not preserved")
	}
	for _, tc := range [][3]string{{netmapTestID, "netmap", "collector"}, {netmapTestID, "bookstack", "netbox"}, {"foreign", "netmap", "netbox"}} {
		if _, err := client.InitialLogin(context.Background(), tc[0], tc[1], tc[2]); err == nil {
			t.Fatal("unknown native identity accepted")
		}
	}
	for _, mutate := range []func(map[string]any){
		func(v map[string]any) { v["instance_id"] = "foreign" },
		func(v map[string]any) { v["username"] = "pl-collector" },
		func(v map[string]any) { v["path"] = "https://foreign.invalid/" },
		func(v map[string]any) { v["password"] = "line\nbreak" },
		func(v map[string]any) { v["token"] = "must-not-be-released" },
	} {
		client := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
			data, _ := json.Marshal(valid)
			var output map[string]any
			_ = json.Unmarshal(data, &output)
			mutate(output)
			_ = json.NewEncoder(w).Encode(output)
		})
		if _, err := client.InitialLogin(context.Background(), netmapTestID, "netmap", "netbox"); err == nil {
			t.Fatal("untrusted administrator response accepted")
		}
	}
}

func TestInitialLoginReturnsCompleteNewAndLegacyBootstrapPasswords(t *testing.T) {
	for _, identity := range []struct{ kind, service, username, path string }{
		{"netmap", "netbox", "pl-admin", "/netmap/netbox/login/"},
		{"netmap", "gitea", "pl-admin", "/netmap/gitea/user/login"},
		{"bookstack", "bookstack", "admin@pl.invalid", "/wiki/login"},
	} {
		t.Run(identity.service, func(t *testing.T) {
			legacy := strings.Repeat("e", 64)
			if identity.service == "gitea" {
				legacy = strings.Repeat("G!", 20)
			}
			for _, password := range []string{"Az09By18", legacy} {
				want := NativeInitialLogin{InstanceID: netmapTestID, ModuleID: identity.kind, Service: identity.service, Username: identity.username, Path: identity.path, Password: password}
				client := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
					_ = json.NewEncoder(w).Encode(want)
				})
				value, err := client.InitialLogin(context.Background(), netmapTestID, identity.kind, identity.service)
				if err != nil || value != want {
					t.Fatal("bootstrap password was rejected, truncated or changed")
				}
			}
			for _, password := range []string{"short77", "longer999", "Az09-B18", "Az09By1\n", "пароль88"} {
				invalid := NativeInitialLogin{InstanceID: netmapTestID, ModuleID: identity.kind, Service: identity.service, Username: identity.username, Path: identity.path, Password: password}
				client := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
					_ = json.NewEncoder(w).Encode(invalid)
				})
				if _, err := client.InitialLogin(context.Background(), netmapTestID, identity.kind, identity.service); err == nil {
					t.Fatal("invalid new bootstrap password accepted")
				}
			}
		})
	}
}

func TestInitialLoginGrafanaAcceptsOnlyOfficialInitialHumanIdentity(t *testing.T) {
	valid := NativeInitialLogin{InstanceID: netmapTestID, ModuleID: "grafana", Service: "grafana", Username: "admin", Password: "admin", Path: "/grafana/login"}
	for _, tc := range []struct {
		name   string
		mutate func(map[string]any)
		valid  bool
	}{
		{"official default", func(map[string]any) {}, true},
		{"legacy service", func(v map[string]any) { v["username"] = "pl-bootstrap" }, false},
		{"provider secret", func(v map[string]any) { v["password"] = strings.Repeat("a", 64) }, false},
		{"wrong module", func(v map[string]any) { v["module_id"] = "netmap" }, false},
		{"wrong service", func(v map[string]any) { v["service"] = "netbox" }, false},
		{"foreign instance", func(v map[string]any) { v["instance_id"] = "foreign" }, false},
		{"foreign path", func(v map[string]any) { v["path"] = "https://foreign.invalid/" }, false},
		{"infrastructure key", func(v map[string]any) { v["secret_key"] = "private" }, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
				var input map[string]string
				if json.NewDecoder(r.Body).Decode(&input) != nil || len(input) != 3 || input["instance_id"] != netmapTestID || input["module_id"] != "grafana" || input["service"] != "grafana" {
					t.Error("Grafana initial login lost request identity")
				}
				data, _ := json.Marshal(valid)
				var output map[string]any
				_ = json.Unmarshal(data, &output)
				tc.mutate(output)
				_ = json.NewEncoder(w).Encode(output)
			})
			value, err := client.InitialLogin(context.Background(), netmapTestID, "grafana", "grafana")
			if tc.valid && (err != nil || value != valid) || !tc.valid && err == nil {
				t.Fatal("Grafana initial login identity validation failed")
			}
		})
	}
}

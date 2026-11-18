package server

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"pl/portal/internal/model"
	"pl/portal/internal/modules"
)

type vpnSetupFixture struct {
	modules.Controller
	actions []string
	input   map[string]any
	subject string
	denied  bool
}

const testPin = "pin-sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

func (c *vpnSetupFixture) OcservRequest(_ context.Context, id, action string, data any) (modules.NativeControlReply, error) {
	c.actions = append(c.actions, action)
	c.input = data.(map[string]any)
	result := map[string]any{"revision": strings.Repeat("a", 64), "name": "VPN", "key_pem": "hidden-secret", "client_secret": "hidden-secret"}
	status := 200
	if action == "connection" {
		result = map[string]any{"subject": c.subject, "auth_mode": "oidc", "issuer": "https://id.example.test/dex", "public_host": "vpn.example.test",
			"public_port": 14443, "certificate_pin": testPin, "client_key_pem": "hidden-secret"}
		if c.denied {
			status = 404
			result = map[string]any{"error": map[string]string{"code": "ocserv_connection", "message": "Недоступно"}}
		}
	}
	raw, err := json.Marshal(result)
	return modules.NativeControlReply{InstanceID: id, Status: status, Body: raw}, err
}

func TestOcservWizardAndEmployeeAuthorization(t *testing.T) {
	s, admin := localUsersFixture(t)
	c := &vpnSetupFixture{subject: "alice"}
	s.Modules = modules.New(s.Store, c)
	id := uuid.NewString()
	if _, err := s.Store.Save(context.Background(), "module_instance", id, 0, model.ModuleInstance{ID: id, ModuleID: "ocserv", Name: "VPN", Mode: "local", DesiredState: "enabled", ObservedState: "running"}, "fixture"); err != nil {
		t.Fatal(err)
	}
	base := "/api/v1/modules/" + id + "/ocserv/"
	owner := apiUser(t, s, hash("https://id.example.test/dex\x00alice"), false)
	other := apiUser(t, s, hash("https://id.example.test/dex\x00someone-else"), false)
	body := map[string]any{"revision": strings.Repeat("a", 64), "auth_mode": "certificate", "name": "VPN", "public_host": "vpn.example.test", "public_port": 14443, "bind_address": "10.2.3.4", "port": 4443, "pool": "10.77.0.0/24"}
	for _, tc := range []struct {
		who     apiIdentity
		headers map[string]string
		want    int
	}{
		{apiIdentity{}, nil, 401}, {other, nil, 403}, {admin, map[string]string{"Origin": "https://other.example"}, 403}, {admin, map[string]string{"Authorization": "Bearer test"}, 403},
	} {
		if w := apiCall(s, tc.who, "POST", base+"setup", body, tc.headers); w.Code != tc.want {
			t.Fatalf("wizard auth %d", w.Code)
		}
	}
	if len(c.actions) != 0 {
		t.Fatal("unadmitted action reached host")
	}
	if w := apiCall(s, admin, "POST", base+"setup", body, nil); w.Code != 200 || strings.Contains(w.Body.String(), "hidden-secret") || c.input["actor"] != "local-admin" {
		t.Fatalf("setup %d", w.Code)
	}
	body["actor"] = "someone-else"
	if w := apiCall(s, admin, "POST", base+"setup", body, nil); w.Code != 400 || len(c.actions) != 1 {
		t.Fatal("client supplied actor")
	}
	if w := apiCall(s, admin, "GET", base+"client-profile?subject=alice", nil, nil); w.Code != 200 || strings.Contains(w.Body.String(), "hidden-secret") || !strings.Contains(w.Body.String(), "server=https://vpn.example.test:14443") || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("invalid admin download")
	}
	if w := apiCall(s, other, "GET", base+"client-profile?subject=alice", nil, nil); w.Code != 403 {
		t.Fatal("non-admin accepted")
	}
	for _, tc := range []struct {
		who     apiIdentity
		path    string
		headers map[string]string
		code    int
	}{
		{apiIdentity{}, "/status", nil, 401}, {owner, "?subject=alice", nil, 400}, {owner, "", map[string]string{"Authorization": "Bearer test"}, 403}, {other, "", nil, 404}, {owner, "", nil, 200},
	} {
		w := apiCall(s, tc.who, "GET", "/api/v1/me/vpn-profile"+tc.path, nil, tc.headers)
		if w.Code != tc.code {
			t.Errorf("self request %q: got %d want %d", tc.path, w.Code, tc.code)
		}
	}
	if c.input["portal_user_id"] != hash("https://id.example.test/dex\x00alice") {
		t.Fatal("unbound self profile")
	}
	if w := apiCall(s, owner, "GET", "/api/v1/me/vpn-profile/status", nil, nil); w.Code != 200 || !strings.Contains(w.Body.String(), `"available":true`) || c.input["status_only"] != true || strings.Contains(w.Body.String(), "secret") {
		t.Fatal("status exposed enrollment")
	}
	c.denied = true
	for _, who := range []apiIdentity{owner, other} {
		if w := apiCall(s, who, "GET", "/api/v1/me/vpn-profile/status", nil, nil); w.Code != 200 || !strings.Contains(w.Body.String(), `"available":false`) {
			t.Fatal("inactive grant still available")
		}
		if w := apiCall(s, who, "GET", "/api/v1/me/vpn-profile", nil, nil); w.Code != 404 {
			t.Fatal("inactive grant downloaded")
		}
	}
}

func TestOcservClientProfileStrictOutput(t *testing.T) {
	for _, change := range []map[string]any{{"public_host": "vpn.example\nno-cert-check"}, {"certificate_pin": testPin + "\n"}, {"subject": "../abc"}, {"public_port": 0}, {"auth_mode": "certificate", "client_key_pem": "broken"}} {
		input := map[string]any{"auth_mode": "oidc", "subject": "alice", "issuer": "https://id.example.test", "public_host": "vpn.example.test", "public_port": 443, "certificate_pin": testPin}
		for k, v := range change {
			input[k] = v
		}
		raw, _ := json.Marshal(input)
		w := httptest.NewRecorder()
		vpnProfileResponse(w, raw, "alice", "", false)
		if w.Code != 503 || w.Header().Get("Content-Disposition") != "" {
			t.Fatal("untrusted material reached downloadable profile")
		}
	}
	raw, err := vpnProfileZip("cfg", "crt", "key")
	if err != nil {
		t.Fatal(err)
	}
	reader, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatal(err)
	}
	files := map[string]string{}
	for _, f := range reader.File {
		r, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		b, err := io.ReadAll(r)
		r.Close()
		if err != nil || f.Mode().Perm() != 0600 {
			t.Fatal("unsafe archive")
		}
		files[f.Name] = string(b)
	}
	if len(files) != 4 || files["client.key"] != "key" || files["pl-vpn.conf"] != "cfg" || files["client.crt"] != "crt" || !strings.Contains(files["README.txt"], "--config pl-vpn.conf") {
		t.Fatal("incomplete archive")
	}
}

//go:build optional_module_acceptance

package server

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"pl/portal/internal/organization"
)

// Owner-started disposable catalog harness uses the real Node createApp and
// PostgreSQL; this gate exercises only import, durable replay and current ACL.
func TestDoskaTaskImportGatewayExternal(t *testing.T) {
	if os.Getenv("DOSKA_TASK_IMPORT_TEST_ENABLE") != "1" {
		t.Fatal("disposable Doska catalog harness required")
	}
	var m struct {
		Upstream         string `json:"upstream"`
		GatewayKeyFile   string `json:"gatewayKeyFile"`
		ControlTokenFile string `json:"controlTokenFile"`
		ProjectID        string `json:"projectId"`
		ColumnID         string `json:"columnId"`
		Actors           []struct {
			ID      string `json:"id"`
			Subject string `json:"subject"`
			Name    string `json:"name"`
			Admin   bool   `json:"admin"`
		} `json:"actors"`
	}
	data, e := doskaReadFile(os.Getenv("DOSKA_TASK_IMPORT_TEST_METADATA"), 64<<10)
	if e != nil || json.Unmarshal(data, &m) != nil {
		t.Fatal("fixture metadata required")
	}
	local := func(raw string, scheme string) bool {
		u, e := url.Parse(raw)
		return e == nil && u.Scheme == scheme && net.ParseIP(u.Hostname()).IsLoopback() && u.Port() != ""
	}
	if !local(m.Upstream, "http") || !local(os.Getenv("PORTAL_TEST_DATABASE_URL"), "postgres") || !catalogID.MatchString(m.ProjectID) || !catalogID.MatchString(m.ColumnID) {
		t.Fatal("explicit disposable loopback fixtures required")
	}
	key, e := doskaReadFile(m.GatewayKeyFile, 32)
	if e != nil || len(key) != 32 {
		t.Fatal("synthetic fixture key required")
	}
	token, e := doskaReadFile(m.ControlTokenFile, 4096)
	if e != nil {
		t.Fatal("synthetic fixture control required")
	}
	s := apiFixture(t)
	users := map[string]apiIdentity{}
	for _, a := range m.Actors {
		parts := strings.Split(a.Subject, ":")
		if len(parts) != 3 || parts[0] != "ad" {
			t.Fatal("canonical AD subject required")
		}
		guid, e := hex.DecodeString(parts[2])
		if e != nil || len(guid) != 16 {
			t.Fatal("fixture GUID required")
		}
		now := time.Now().UTC()
		_, e = organization.NewStore(s.Store.Pool).SaveEmployee(context.Background(), organization.EmployeeRecord{Identity: organization.Identity{Subject: a.Subject, Name: a.Name, AccountState: organization.Active, LastSuccessAt: now}, Provider: "ad", ProviderNamespace: parts[1], ObjectGUID: guid}, 0, "task-import-fixture", now)
		if e != nil {
			t.Fatal(e)
		}
		users[a.ID] = apiUser(t, s, a.Subject, a.Admin)
	}
	for _, id := range []string{"fixture-employee", "fixture-observer", "fixture-denied", "fixture-revocable"} {
		if _, ok := users[id]; !ok {
			t.Fatal("fixture actor missing")
		}
	}
	g, e := s.newDoskaGateway(DoskaGatewayConfig{APIUpstream: m.Upstream, WebUpstream: m.Upstream, Key: key, Manifest: importManifest(), Transport: &http.Transport{Proxy: nil, DisableCompression: true, ResponseHeaderTimeout: 30 * time.Second}})
	if e != nil {
		t.Fatal(e)
	}
	gateway := httptest.NewServer(g)
	defer gateway.Close()
	s.Config.PublicURL = gateway.URL
	client := &http.Client{Timeout: 70 * time.Second}
	defer client.CloseIdleConnections()
	body, _ := json.Marshal(map[string]any{"clientRequestId": uuid.NewString(), "tasks": []any{map[string]any{"title": "Actual Portal signed import " + uuid.NewString(), "columnId": m.ColumnID}}})
	call := func(actor string, want int) []byte {
		t.Helper()
		r, _ := http.NewRequest("POST", gateway.URL+"/doska/api/doska/projects/"+m.ProjectID+"/task-imports", bytes.NewReader(body))
		r.AddCookie(users[actor].cookie)
		r.Header.Set("Origin", gateway.URL)
		r.Header.Set("X-CSRF-Token", users[actor].csrf)
		r.Header.Set("Content-Type", "application/json")
		resp, e := client.Do(r)
		if e != nil {
			t.Fatal("gateway call", e)
		}
		defer resp.Body.Close()
		data, e := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		if e != nil || resp.StatusCode != want {
			t.Fatalf("%s got%d want%d: %.1000s", actor, resp.StatusCode, want, data)
		}
		return data
	}
	first := call("fixture-employee", 201)
	var created struct {
		TaskIDs  []string `json:"taskIds"`
		Imported int      `json:"imported"`
		Replayed bool     `json:"replayed"`
	}
	if json.Unmarshal(first, &created) != nil || created.Imported != 1 || created.Replayed || len(created.TaskIDs) != 1 {
		t.Fatal("first import response")
	}
	second := call("fixture-employee", 201)
	var replay struct {
		TaskIDs  []string `json:"taskIds"`
		Replayed bool     `json:"replayed"`
	}
	if json.Unmarshal(second, &replay) != nil || !replay.Replayed || len(replay.TaskIDs) != 1 || replay.TaskIDs[0] != created.TaskIDs[0] {
		t.Fatal("durable receipt replay")
	}
	call("fixture-observer", 403)
	call("fixture-denied", 404)
	control := func(action string) {
		t.Helper()
		r, _ := http.NewRequest("POST", m.Upstream+"/__fixture/"+action, nil)
		r.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
		resp, e := client.Do(r)
		if e != nil {
			t.Fatal("fixture control")
		}
		resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatal("fixture control rejected")
		}
	}
	// A second actor first obtains a receipt, then loses backend identity access.
	body, _ = json.Marshal(map[string]any{"clientRequestId": uuid.NewString(), "tasks": []any{map[string]any{"title": "Revocation receipt " + uuid.NewString(), "columnId": m.ColumnID}}})
	call("fixture-revocable", 201)
	call("fixture-revocable", 201)
	control("revoke")
	defer control("restore")
	call("fixture-revocable", 403)
}

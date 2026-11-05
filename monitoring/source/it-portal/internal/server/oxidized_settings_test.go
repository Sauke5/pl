package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
	"pl/portal/internal/model"
	"pl/portal/internal/providers"
)

func TestOxidizedSettingsReferencesAndOptionalProbe(t *testing.T) {
	s := apiFixture(t)
	admin := apiUser(t, s, "oxidized-settings-admin", true)
	missing := uuid.NewString()
	draft := model.Integration{Name: "Oxidized / Gitea", Kind: "oxidized", URL: "http://draft.example.test", Enabled: true, PollSeconds: 60, TimeoutSeconds: 2, Concurrency: 2, Config: map[string]string{"gitea_repository_url": "https://git.example.test/network/configs", "node_bindings": `{"msk/router":"` + missing + `"}`}}
	response := settingsWorkspaceCall(s, admin, "POST", "/api/v1/settings-workspace/integrations", draft, nil)
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "config.node_bindings") {
		t.Fatalf("missing resource accepted: %d %s", response.Code, response.Body)
	}
	if _, err := s.Store.Save(context.Background(), "resource", missing, 0, model.Resource{ID: missing, Name: "Router"}, "admin"); err != nil {
		t.Fatal(err)
	}
	s.Providers = settingsProbeProvider(t, func(w http.ResponseWriter, r *http.Request) { http.Error(w, "unavailable", 503) })
	body, _ := json.Marshal(draft)
	probe := apiDecode[providers.IntegrationProbe](t, settingsProbeAPICall(s, admin, string(body), nil), 200)
	if probe.Status != "invalid_response" {
		t.Fatal("unexpected draft check", probe)
	}
	saved := apiDecode[model.Integration](t, settingsWorkspaceCall(s, admin, "POST", "/api/v1/settings-workspace/integrations", draft, nil), 201)
	if saved.Revision != 1 || saved.Kind != "oxidized" || len(saved.Capabilities) != 1 || saved.Capabilities[0] != "configuration_history" {
		t.Fatal(saved)
	}
	var jobs, cache int
	if err := s.Store.Pool.QueryRow(context.Background(), "SELECT (SELECT count(*) FROM jobs),(SELECT count(*) FROM documents WHERE kind='configuration_history')").Scan(&jobs, &cache); err != nil || jobs != 0 || cache != 0 {
		t.Fatalf("draft check wrote runtime state: jobs=%d cache=%d err=%v", jobs, cache, err)
	}
}

func TestOxidizedSettingsProbeUsesMetadataContract(t *testing.T) {
	s := apiFixture(t)
	admin := apiUser(t, s, "oxidized-probe-admin", true)
	s.Providers = settingsProbeProvider(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/nodes.json":
			w.Write([]byte(`[{"name":"router","group":"msk","status":"success","last":{"status":"success","end":"2026-10-26 10:00:00 UTC"}}]`))
		case "/node/version.json":
			if r.URL.Query().Get("node_full") != "msk/router" {
				t.Error("wrong node locator")
			}
			w.Write([]byte(`[{"oid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","time":"2026-10-26T10:00:00Z"}]`))
		default:
			t.Error("unexpected route", r.URL)
			http.Error(w, "unexpected", 500)
		}
	})
	input := `{"name":"Draft Oxidized","kind":"oxidized","url":"http://draft.example.test","enabled":true,"poll_seconds":60,"timeout_seconds":2,"concurrency":2,"config":{"gitea_repository_url":"https://git.example.test/network/configs"}}`
	probe := apiDecode[providers.IntegrationProbe](t, settingsProbeAPICall(s, admin, input, nil), 200)
	if probe.Status != "connected" {
		t.Fatal(probe)
	}
}

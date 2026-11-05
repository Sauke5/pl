package server

import (
	"bytes"
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"pl/portal/internal/model"
	"pl/portal/internal/netguard"
	"pl/portal/internal/providers"
	"pl/portal/internal/store"
)

func mailcowConnectionResponses() map[string]string {
	return map[string]string{
		"status/version": `{"version":"test-fixture"}`, "domain/all": `[]`, "mailbox/all": `[]`, "mailq/all": `[]`,
		"status/containers": `{"postfix-mailcow":{"state":"running","started_at":"2026-10-30T06:43:30Z"},"dockerapi-mailcow":{"state":"running","started_at":"2026-10-30T06:43:30Z"}}`,
		"status/vmail":      `{"used_percent":"0%","used":"0G","total":"16G"}`,
		"logs/rspamd-stats": `{"scanned":0,"actions":{}}`,
	}
}

func mailcowNativeConnectionFixture(t *testing.T, s *Server, token string, handler http.HandlerFunc) *int {
	t.Helper()
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Method != http.MethodGet || r.Header.Get("X-API-Key") != token || r.URL.RawQuery != "" {
			t.Error("preflight escaped authenticated read-only request contract")
			w.WriteHeader(http.StatusForbidden)
			return
		}
		path := strings.TrimPrefix(r.URL.Path, "/api/v1/get/")
		value, known := mailcowConnectionResponses()[path]
		if !known || !strings.HasPrefix(r.URL.Path, "/api/v1/get/") {
			t.Error("preflight requested an endpoint outside its finite read capability")
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if handler != nil {
			handler(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(value))
	}))
	t.Cleanup(upstream.Close)
	u, _ := url.Parse(upstream.URL)
	guard, err := netguard.NewWithDependencies([]string{"10.20.30.40/32"}, []int{18080}, "", credentialTestDNS{}, func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != "10.20.30.40:18080" {
			t.Error("preflight dialled an unapproved endpoint")
			return nil, errors.New("unapproved fixture dial")
		}
		return (&net.Dialer{}).DialContext(ctx, network, u.Host)
	})
	if err != nil {
		t.Fatal(err)
	}
	s.Providers = providers.New(guard, "")
	keyFile := filepath.Join(t.TempDir(), "integration-key")
	if err := os.WriteFile(keyFile, bytes.Repeat([]byte{9}, 32), 0600); err != nil {
		t.Fatal(err)
	}
	if err := s.InitConnectorCredentials(keyFile, guard); err != nil {
		t.Fatal(err)
	}
	return &calls
}

func mailcowRegistrationCounts(t *testing.T, s *Server) []int {
	t.Helper()
	var documents, jobs, credentials int
	if err := s.Store.Pool.QueryRow(context.Background(), `SELECT (SELECT count(*) FROM documents), (SELECT count(*) FROM jobs), (SELECT count(*) FROM integration_credentials)`).Scan(&documents, &jobs, &credentials); err != nil {
		t.Fatal(err)
	}
	return []int{documents, jobs, credentials}
}

func TestMailcowPreconnectRejectsBeforeAnyPersistence(t *testing.T) {
	for _, tc := range []struct {
		name, path, body, cause string
		status                  int
	}{
		{"unauthorized", "status/version", `private-error-body`, "auth", 401},
		{"forbidden", "status/version", `private-error-body`, "auth", 403},
		{"HTML login", "status/version", `<html>login</html>`, "schema", 200},
		{"invalid JSON", "status/version", `{`, "schema", 200},
		{"no known fields", "status/version", `{}`, "schema", 200},
		{"Mailcow error body", "status/version", `{"type":"error","msg":"private-error-body"}`, "upstream", 200},
		{"Mailcow danger body", "status/version", `{"type":"danger","msg":"private-error-body"}`, "upstream", 200},
		{"late malformed data", "logs/rspamd-stats", `{"scanned":0}`, "schema", 200},
		{"wrong mailbox schema", "mailbox/all", `[{"unknown":0}]`, "schema", 200},
		{"redirect", "status/version", ``, "policy", 302},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, admin, _, _ := mailcowHTTPFixture(t)
			const token = "private-preflight-token"
			calls := mailcowNativeConnectionFixture(t, s, token, func(w http.ResponseWriter, r *http.Request) {
				path := strings.TrimPrefix(r.URL.Path, "/api/v1/get/")
				if path == tc.path {
					w.Header().Set("Location", "http://mail.example.test:18080/private")
					w.WriteHeader(tc.status)
					body := tc.body
					if tc.status == 401 || tc.status == 403 {
						body += " " + token
					}
					_, _ = w.Write([]byte(body))
					return
				}
				_, _ = w.Write([]byte(mailcowConnectionResponses()[path]))
			})
			before := mailcowRegistrationCounts(t, s)
			body := mailcowCreateBody("mailcow:preflight:"+tc.name, "")
			body["api_key"] = token
			response := apiCall(s, admin, http.MethodPost, "/api/v1/modules", body, nil)
			problem := apiDecode[struct {
				Error  string `json:"error"`
				Status int    `json:"upstream_status"`
			}](t, response, 422)
			if problem.Error != "mailcow_"+tc.cause || tc.status == 401 && problem.Status != 401 || tc.status == 403 && problem.Status != 403 {
				t.Fatalf("wrong finite cause: %+v", problem)
			}
			if *calls == 0 || strings.Contains(response.Body.String(), token) || strings.Contains(response.Body.String(), "private-error-body") {
				t.Fatal("probe skipped or leaked upstream data")
			}
			if after := mailcowRegistrationCounts(t, s); !reflect.DeepEqual(before, after) {
				t.Fatalf("failed preflight persisted state: %v -> %v", before, after)
			}
			portal := apiDecode[struct {
				Authenticated bool `json:"authenticated"`
			}](t, apiCall(s, admin, http.MethodGet, "/api/v1/session", nil, nil), 200)
			if !portal.Authenticated {
				t.Fatal("upstream refusal ended the PL session")
			}
		})
	}
}

func TestMailcowPreconnectValidEmptyDataKeepsGroupsOptIn(t *testing.T) {
	s, admin, _, _ := mailcowHTTPFixture(t)
	const token = "private-preflight-token"
	upstreamDown := false
	calls := mailcowNativeConnectionFixture(t, s, token, func(w http.ResponseWriter, r *http.Request) {
		if upstreamDown {
			w.WriteHeader(503)
			return
		}
		_, _ = w.Write([]byte(mailcowConnectionResponses()[strings.TrimPrefix(r.URL.Path, "/api/v1/get/")]))
	})
	body := mailcowCreateBody("mailcow:preflight:valid-empty", "")
	body["api_key"] = token
	response := apiCall(s, admin, http.MethodPost, "/api/v1/modules", body, nil)
	created := apiDecode[struct {
		Instance model.ModuleInstance `json:"instance"`
		Job      model.Job            `json:"job"`
	}](t, response, 202)
	if *calls != 7 || strings.Contains(response.Body.String(), token) {
		t.Fatal("preflight did not validate seven native endpoints or leaked credential", *calls)
	}
	if _, err := finishModuleFixture(t, s); err != nil {
		t.Fatal(err)
	}
	integration, err := store.Get[model.Integration](context.Background(), s.Store, "integration", created.Instance.IntegrationID)
	if err != nil {
		t.Fatal(err)
	}
	for _, group := range model.MailcowGroupConfig(integration.Config) {
		if group.Enabled {
			t.Fatal("preflight enabled a collector")
		}
	}
	snapshot, err := s.Store.MailcowSnapshot(context.Background(), created.Instance.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, group := range snapshot.Groups {
		if group.Data != nil || group.LastAttempt != nil || group.LastSuccess != nil {
			t.Fatal("preflight created a collector snapshot")
		}
	}
	// Replaying an accepted create reads its durable result without an upstream call.
	upstreamDown = true
	if replay := apiCall(s, admin, http.MethodPost, "/api/v1/modules", body, nil); replay.Code != 202 || !strings.Contains(replay.Body.String(), created.Job.ID) || *calls != 7 {
		t.Fatal("accepted retry was re-probed or recreated")
	}
	body["api_key"] = "changed-private-token"
	if conflict := apiCall(s, admin, http.MethodPost, "/api/v1/modules", body, nil); conflict.Code != 409 || *calls != 7 {
		t.Fatal("credential change bypassed idempotency conflict")
	}
	if _, _, err := s.Store.QueueModule(context.Background(), created.Job.Actor, "mailcow:remove:preflight", created.Instance.ID, "remove", model.ModuleRequest{ConfirmName: created.Instance.Name}); err != nil {
		t.Fatal(err)
	}
	if _, err := finishModuleFixture(t, s); err != nil {
		t.Fatal(err)
	}
	body["api_key"] = token
	if replay := apiCall(s, admin, http.MethodPost, "/api/v1/modules", body, nil); replay.Code != 202 || !strings.Contains(replay.Body.String(), created.Job.ID) || *calls != 7 {
		t.Fatal("tombstone replay differs from QueueModule semantics")
	}
}

func TestMailcowPreconnectUnavailableServicesFailClosed(t *testing.T) {
	s, admin, _, _ := mailcowHTTPFixture(t)
	before := mailcowRegistrationCounts(t, s)
	s.Providers = nil
	body := mailcowCreateBody("mailcow:preflight:unavailable", "")
	body["api_key"] = "private-preflight-key"
	if response := apiCall(s, admin, http.MethodPost, "/api/v1/modules", body, nil); response.Code != 503 {
		t.Fatal("missing provider did not fail closed", response.Code)
	}
	if after := mailcowRegistrationCounts(t, s); !reflect.DeepEqual(before, after) {
		t.Fatal("missing provider persisted a connection")
	}
	if err := s.probeMailcowConnection(context.Background(), "http://mail.example.test:18080", "", "key", nil); err == nil {
		t.Fatal("missing prepared credential accepted")
	}
	s.connectorCredentials = nil
	if err := s.probeMailcowConnection(context.Background(), "http://mail.example.test:18080", "", "key", nil); err == nil {
		t.Fatal("missing credential service accepted")
	}
}

func TestMailcowPreconnectUnreachableDoesNotPersist(t *testing.T) {
	s, admin, _, _ := mailcowHTTPFixture(t)
	const token = "private-unreachable-token"
	guard, err := netguard.NewWithDependencies([]string{"10.20.30.40/32"}, []int{18080}, "", credentialTestDNS{}, func(context.Context, string, string) (net.Conn, error) {
		return nil, errors.New("unreachable " + token)
	})
	if err != nil {
		t.Fatal(err)
	}
	s.connectorCredentials.guard = guard
	before := mailcowRegistrationCounts(t, s)
	body := mailcowCreateBody("mailcow:preflight:unreachable", "")
	body["api_key"] = token
	response := apiCall(s, admin, http.MethodPost, "/api/v1/modules", body, nil)
	problem := apiDecode[map[string]any](t, response, 422)
	if problem["error"] != "mailcow_network" || strings.Contains(response.Body.String(), token) {
		t.Fatal("network cause lost or private error leaked")
	}
	if after := mailcowRegistrationCounts(t, s); !reflect.DeepEqual(before, after) {
		t.Fatal("unreachable source persisted registration")
	}
}

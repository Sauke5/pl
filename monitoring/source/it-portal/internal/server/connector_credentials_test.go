package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pl/portal/internal/model"
	"pl/portal/internal/netguard"
	"pl/portal/internal/providers"
	"pl/portal/internal/store"
)

type credentialTestDNS struct{}

func (credentialTestDNS) LookupIPAddr(context.Context, string) ([]net.IPAddr, error) {
	return []net.IPAddr{{IP: net.ParseIP("10.20.30.40")}}, nil
}

func TestMailcowWriteOnlyKeyRegistrationAndBoundCollection(t *testing.T) {
	s, admin, _, _ := mailcowHTTPFixture(t)
	const token = "private-mailcow-api-fixture-key"
	upstreamCalls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls++
		if r.Method != http.MethodGet || r.Header.Get("X-API-Key") != token {
			t.Error("credential was not sent through the finite native read capability")
			w.WriteHeader(http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		value, ok := mailcowConnectionResponses()[strings.TrimPrefix(r.URL.Path, "/api/v1/get/")]
		if !ok {
			t.Error("unexpected upstream endpoint")
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte(value))
	}))
	defer upstream.Close()
	upstreamURL, _ := url.Parse(upstream.URL)
	guard, err := netguard.NewWithDependencies([]string{"127.0.0.1/32"}, []int{443}, "", credentialTestDNS{},
		func(ctx context.Context, network, address string) (net.Conn, error) {
			if address != "10.20.30.40:18080" {
				t.Errorf("unapproved dial: %s", address)
			}
			return (&net.Dialer{}).DialContext(ctx, network, upstreamURL.Host)
		})
	if err != nil {
		t.Fatal(err)
	}
	s.Providers = providers.New(guard, "")
	keyFile := filepath.Join(t.TempDir(), "integration-key")
	if err = os.WriteFile(keyFile, bytes.Repeat([]byte{5}, 32), 0600); err != nil {
		t.Fatal(err)
	}
	if err = s.InitConnectorCredentials(keyFile, guard); err != nil {
		t.Fatal(err)
	}
	body := mailcowCreateBody("mailcow:write-only:key", "")
	delete(body, "secret_ref")
	body["endpoint"], body["api_key"] = "http://MAIL.example.test:18080/", token
	viewer := apiUser(t, s, "read-only-credential-fixture", false)
	if w := apiCall(s, viewer, http.MethodPost, "/api/v1/modules", body, nil); w.Code != 403 {
		t.Fatal("non-administrator stored a credential", w.Code)
	}
	if w := apiCall(s, admin, http.MethodPost, "/api/v1/modules", body, map[string]string{"X-CSRF-Token": "wrong"}); w.Code != 403 {
		t.Fatal("credential write accepted without CSRF", w.Code)
	}
	response := apiCall(s, admin, http.MethodPost, "/api/v1/modules", body, nil)
	if response.Code != http.StatusAccepted || strings.Contains(response.Body.String(), token) {
		t.Fatal("write-only registration failed or exposed the key", response.Code, response.Body.String())
	}
	var created struct {
		Instance model.ModuleInstance `json:"instance"`
		Job      model.Job            `json:"job"`
	}
	if err = json.Unmarshal(response.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Instance.Endpoint != "http://mail.example.test:18080" || upstreamCalls != 7 {
		t.Fatal("registration failed to normalize origin or skipped the native preflight")
	}
	if w := apiCall(s, admin, http.MethodPost, "/api/v1/modules", body, nil); w.Code != 202 || !strings.Contains(w.Body.String(), created.Job.ID) {
		t.Fatal("repeated request did not reuse its operation", w.Code)
	}
	body["api_key"] = "different-private-fixture-key"
	if w := apiCall(s, admin, http.MethodPost, "/api/v1/modules", body, nil); w.Code != http.StatusConflict {
		t.Fatal("changed credential reused an idempotency key", w.Code)
	}
	if _, err = finishModuleFixture(t, s); err != nil {
		t.Fatal(err)
	}
	integration, err := store.Get[model.Integration](context.Background(), s.Store, "integration", created.Instance.IntegrationID)
	if err != nil || integration.SecretRef != "managed:"+integration.ID {
		t.Fatal("managed credential reference was not bound to the integration", err)
	}
	data, err := s.Providers.MailcowCollect(context.Background(), integration, "inventory")
	if err != nil || !strings.Contains(string(data), "test-fixture") || strings.Contains(string(data), token) || upstreamCalls != 9 {
		t.Fatal("bound provider did not collect through its stored credential", err, upstreamCalls)
	}
	copy := integration
	copy.URL = "http://other.example.test:18080"
	if _, err = s.Providers.MailcowCollect(context.Background(), copy, "inventory"); providers.MailcowErrorCode(err) != "policy" || upstreamCalls != 9 {
		t.Fatal("credential followed an integration URL change", err, upstreamCalls)
	}
}

func TestMailcowWriteOnlyKeyCapabilityAndAmbiguousInput(t *testing.T) {
	s, admin, _, _ := mailcowHTTPFixture(t)
	s.connectorCredentials = nil
	body := mailcowCreateBody("mailcow:write-only:unavailable", "")
	body["api_key"] = "private-fixture-key"
	if w := apiCall(s, admin, http.MethodPost, "/api/v1/modules", body, nil); w.Code != 409 {
		t.Fatal("installation without its root key accepted a credential", w.Code)
	}
	body["secret_ref"] = "file:mailcow-ro.key"
	if w := apiCall(s, admin, http.MethodPost, "/api/v1/modules", body, nil); w.Code != 400 {
		t.Fatal("two credential sources accepted", w.Code)
	}
	body["secret_ref"], body["api_key"] = "", "has a space"
	if w := apiCall(s, admin, http.MethodPost, "/api/v1/modules", body, nil); w.Code != 400 {
		t.Fatal("invalid API key accepted", w.Code)
	}
}

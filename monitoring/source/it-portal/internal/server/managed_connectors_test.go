package server

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	"pl/portal/internal/model"
	"pl/portal/internal/netguard"
	"pl/portal/internal/providers"
)

func managedAuditorFixture(t *testing.T, handler func(http.ResponseWriter, *http.Request, []byte)) (*Server, apiIdentity, string) {
	t.Helper()
	s := apiFixture(t)
	admin := apiUser(t, s, "managed-auditor-admin", true)
	key := []byte("0123456789abcdef0123456789abcdef")
	directory := t.TempDir()
	keyFile := filepath.Join(directory, "auditor.key")
	if err := os.WriteFile(keyFile, key, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PORTAL_SECRETS_DIR", directory)
	t.Setenv("PORTAL_SECRET_REFS", "file:auditor.key")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler(w, r, key)
	}))
	t.Cleanup(upstream.Close)
	guard, err := netguard.NewWithDependencies([]string{"10.0.0.0/8"}, []int{80}, "", browseResolver{}, func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != "10.1.1.1:80" {
			t.Error("unexpected upstream destination")
		}
		return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(upstream.URL, "http://"))
	})
	if err != nil {
		t.Fatal(err)
	}
	s.Providers = providers.New(guard, "")
	return s, admin, keyFile
}

func createManagedAuditorIntegration(t *testing.T, s *Server, admin apiIdentity, name, prefix string) model.Integration {
	t.Helper()
	input := model.Integration{Name: name, Kind: "fileauditor", URL: "http://auditor.example" + prefix, Enabled: true, SecretRef: "file:auditor.key", PollSeconds: 60, TimeoutSeconds: 10, Concurrency: 1, Config: map[string]string{}}
	return apiDecode[model.Integration](t, apiCall(s, admin, http.MethodPost, "/api/v1/integrations", input, nil), 201)
}

func TestManagedAuditorUsesPersistedIntegrationAndLiveUserIdentity(t *testing.T) {
	var calls atomic.Int32
	captured := make(chan gatewayIdentity, 8)
	s, admin, _ := managedAuditorFixture(t, func(w http.ResponseWriter, r *http.Request, key []byte) {
		calls.Add(1)
		claims := decodeDirectoryAssertion(t, r, key)
		if claims.URI != r.URL.RequestURI() || claims.Method != r.Method || claims.Audience != "auditor" || claims.Version != 2 || claims.CSRFVerified {
			t.Error("request identity or target not bound to assertion")
		}
		if r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" || r.Header.Get("Proxy-Authorization") != "" || r.Header.Get("X-PL-Forged") != "" {
			t.Error("browser credentials or forged identity reached source")
		}
		captured <- claims
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"machineName":"FILES-LAB","roots":[]}`))
	})
	viewer := apiUser(t, s, "managed-auditor-viewer", false)
	integration := createManagedAuditorIntegration(t, s, admin, "Auditor lab", "/audit")
	for _, identity := range []struct {
		who  apiIdentity
		id   string
		role bool
	}{{viewer, "managed-auditor-viewer", false}, {admin, "managed-auditor-admin", true}} {
		response := apiCall(s, identity.who, http.MethodGet, "/audit/api/instance?q=a%2Fb", nil, map[string]string{"Proxy-Authorization": "Basic browser-fixture", "X-PL-Forged": "browser-fixture"})
		if response.Code != 200 || !strings.Contains(response.Body.String(), "FILES-LAB") || strings.Contains(response.Body.String(), "auditor.example") {
			t.Fatalf("managed Auditor read failed or exposed upstream URL: status=%d", response.Code)
		}
		claims := <-captured
		if claims.Subject != identity.id || claims.Name != identity.id || claims.Admin != identity.role || claims.URI != "/audit/api/instance?q=a%2Fb" || claims.Subject == "system:modules:fileauditor" {
			t.Fatal("gateway replaced live Platform identity with service credentials")
		}
		wantScopes := []string{"auditor:read"}
		if identity.role {
			wantScopes = append(wantScopes, "auditor:scan")
		}
		if !reflect.DeepEqual(claims.Scopes, wantScopes) {
			t.Fatal("gateway changed the existing v2 per-user capability contract")
		}
	}
	integration.Enabled = false
	integration = apiDecode[model.Integration](t, apiCall(s, admin, http.MethodPut, "/api/v1/integrations/"+integration.ID, integration, nil), 200)
	before := calls.Load()
	response := apiCall(s, viewer, http.MethodGet, "/audit/api/instance", nil, nil)
	if response.Code != 503 || calls.Load() != before || strings.Contains(response.Body.String(), integration.URL) {
		t.Fatal("disabled persisted integration remained accessible")
	}
	integration.Enabled = true
	_ = apiDecode[model.Integration](t, apiCall(s, admin, http.MethodPut, "/api/v1/integrations/"+integration.ID, integration, nil), 200)
	if response := apiCall(s, viewer, http.MethodGet, "/audit/api/instance", nil, nil); response.Code != 200 || calls.Load() != before+1 {
		t.Fatal("reenabled persisted integration did not restore access")
	}
	<-captured
}

func TestManagedAuditorRejectsAnonymousWritesAndUnknownRoutesBeforeUpstream(t *testing.T) {
	var calls atomic.Int32
	s, admin, _ := managedAuditorFixture(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
	})
	viewer := apiUser(t, s, "managed-auditor-reader", false)
	_ = createManagedAuditorIntegration(t, s, admin, "Auditor lab", "/audit")
	for _, test := range []struct {
		who          apiIdentity
		method, path string
		status       int
	}{
		{apiIdentity{}, http.MethodGet, "/audit/api/instance", 401},
		{viewer, http.MethodPost, "/audit/api/scans", 405},
		{admin, http.MethodPost, "/audit/api/scans", 405},
		{admin, http.MethodDelete, "/audit/api/findings", 405},
		{viewer, http.MethodGet, "/audit/api/config", 404},
	} {
		response := apiCall(s, test.who, test.method, test.path, nil, nil)
		if response.Code != test.status || strings.Contains(response.Body.String(), "auditor.example") {
			t.Fatalf("unexpected %s %s status=%d expected=%d", test.method, test.path, response.Code, test.status)
		}
	}
	// Machine Authorization must not be combined with a browser session. The
	// valid cookie cannot override this existing Platform authentication boundary.
	if response := apiCall(s, viewer, http.MethodGet, "/audit/api/instance", nil, map[string]string{"Authorization": "Basic browser-fixture"}); response.Code != 401 {
		t.Fatal("machine Authorization was accepted as a browser session")
	}
	if calls.Load() != 0 {
		t.Fatal("denied operation reached Windows Auditor")
	}
	if response := apiCall(s, viewer, http.MethodHead, "/audit/api/instance", nil, nil); response.Code != 200 || calls.Load() != 1 {
		t.Fatal("read-only HEAD was not preserved")
	}
}

func TestManagedAuditorSelectsUniquePrefixAndFailsClosedOnAmbiguity(t *testing.T) {
	var calls atomic.Int32
	s, admin, _ := managedAuditorFixture(t, func(w http.ResponseWriter, r *http.Request, key []byte) {
		calls.Add(1)
		claims := decodeDirectoryAssertion(t, r, key)
		if claims.URI != r.URL.RequestURI() {
			t.Error("prefix missing from signed target")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"machineName":"FILES-LAB","roots":[]}`))
	})
	_ = createManagedAuditorIntegration(t, s, admin, "Auditor A", "/audit")
	_ = createManagedAuditorIntegration(t, s, admin, "Auditor B", "/audit-arch")
	if response := apiCall(s, admin, http.MethodGet, "/audit/api/instance", nil, nil); response.Code != 200 {
		t.Fatal("another prefix incorrectly made selection ambiguous")
	}
	_ = createManagedAuditorIntegration(t, s, admin, "Auditor duplicate", "/audit")
	before := calls.Load()
	response := apiCall(s, admin, http.MethodGet, "/audit/api/instance", nil, nil)
	if response.Code != 503 || calls.Load() != before || strings.Contains(response.Body.String(), "auditor.example") {
		t.Fatal("ambiguous source was selected or exposed")
	}
	if response := apiCall(s, admin, http.MethodGet, "/audit-arch/api/instance", nil, nil); response.Code != 200 || calls.Load() != before+1 {
		t.Fatal("ambiguity leaked to independent prefix")
	}
}

func TestManagedAuditorMissingGatewayKeyFailsClosed(t *testing.T) {
	var calls atomic.Int32
	s, admin, keyFile := managedAuditorFixture(t, func(w http.ResponseWriter, r *http.Request, _ []byte) { calls.Add(1) })
	_ = createManagedAuditorIntegration(t, s, admin, "Auditor lab", "/audit")
	if err := os.Remove(keyFile); err != nil {
		t.Fatal(err)
	}
	response := apiCall(s, admin, http.MethodGet, "/audit/api/instance", nil, nil)
	if response.Code != 503 || calls.Load() != 0 || strings.Contains(response.Body.String(), keyFile) || strings.Contains(response.Body.String(), "auditor.example") || strings.Contains(response.Body.String(), "auditor.key") {
		t.Fatal("missing key reached source or exposed private configuration")
	}
}

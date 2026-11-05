package server

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pl/portal/internal/model"
	"pl/portal/internal/modules"
	"pl/portal/internal/netguard"
	"pl/portal/internal/store"
)

func TestNetMapExternalEncryptedRegistrationSignedGatewayLifecycleAndNewEndpoint(t *testing.T) {
	s, admin := localUsersFixture(t)
	s.Config.PortableRelease = true
	s.Config.PublicURL = "https://portal.example.test"
	s.Modules = modules.New(s.Store, nil)
	s.Modules.PublicURL = s.Config.PublicURL
	key := bytes.Repeat([]byte{7}, 32)
	requests := 0
	var browserClaims gatewayIdentity
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		assertion := r.Header.Get(gatewayAssertionHeader)
		signature, _ := base64.RawURLEncoding.DecodeString(r.Header.Get(gatewaySignatureHeader))
		mac := hmac.New(sha256.New, key)
		mac.Write([]byte("pl-gateway-v2\n" + assertion))
		if !hmac.Equal(signature, mac.Sum(nil)) {
			w.WriteHeader(401)
			return
		}
		if r.Header.Get("Authorization") != "" || strings.Contains(r.Header.Get("Cookie"), "portal_session") {
			t.Error("Pl credentials leaked to remote adapter")
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/netmap/api/instance":
			json.NewEncoder(w).Encode(map[string]string{"module": "netmap", "protocol": "pl-gateway-v2", "version": "1.0.0", "platform_origin": s.Config.PublicURL})
		case "/netmap/api/health":
			io.WriteString(w, `{"status":"ok","sources_ok":1,"sources_total":1}`)
		case "/netmap/api/topology":
			browserClaims = decodeDirectoryAssertion(t, r, key)
			io.WriteString(w, `{"nodes":[],"edges":[]}`)
		case "/netmap/netbox/login/", "/netmap/gitea/user/login", "/netmap/oxidized/":
			claims := decodeDirectoryAssertion(t, r, key)
			if !claims.Admin || len(claims.Scopes) != 1 || claims.Scopes[0] != "netmap:admin" {
				t.Error("native route lost admin gateway scope")
			}
			w.Header().Set("Content-Type", "text/html")
			io.WriteString(w, "<html><body>Native application fixture</body></html>")
		default:
			t.Error("unexpected scan/poll/native request during registration", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer upstream.Close()
	ca := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: upstream.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	guard, err := netguard.NewWithDependencies(nil, nil, ca, credentialTestDNS{}, func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != "10.20.30.40:18443" && address != "10.20.30.40:18444" {
			t.Error("NetMap dial escaped persisted approval", address)
		}
		return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(upstream.URL, "https://"))
	})
	if err != nil {
		t.Fatal(err)
	}
	keyFile := filepath.Join(t.TempDir(), "connector-key")
	if err = os.WriteFile(keyFile, bytes.Repeat([]byte{11}, 32), 0600); err != nil {
		t.Fatal(err)
	}
	if err = s.InitConnectorCredentials(keyFile, guard); err != nil {
		t.Fatal(err)
	}
	body := map[string]any{"module_id": "netmap", "name": "Remote NetMap", "mode": "external", "endpoint": "https://example.com:18443", "gateway_key": hex.EncodeToString(key), "idempotency_key": "netmap:external:register"}
	viewer := apiUser(t, s, "netmap-credential-viewer", false)
	if w := apiCall(s, viewer, "POST", "/api/v1/modules", body, nil); w.Code != 403 {
		t.Fatal("viewer stored key", w.Code)
	}
	if w := apiCall(s, admin, "POST", "/api/v1/modules", body, map[string]string{"X-CSRF-Token": "wrong"}); w.Code != 403 {
		t.Fatal("CSRF bypass", w.Code)
	}
	if requests != 0 {
		t.Fatal("rejected credentials reached upstream")
	}
	w := apiCall(s, admin, "POST", "/api/v1/modules", body, nil)
	created := apiDecode[struct {
		Instance model.ModuleInstance `json:"instance"`
		Job      model.Job            `json:"job"`
	}](t, w, 202)
	if strings.Contains(w.Body.String(), body["gateway_key"].(string)) || requests != 2 {
		t.Fatal("registration leaked key or skipped identity/health", requests)
	}
	stored, err := s.Store.IntegrationCredential(context.Background(), created.Instance.IntegrationID)
	if err != nil || bytes.Contains(stored.Envelope, []byte(body["gateway_key"].(string))) {
		t.Fatal("key not stored as isolated encrypted credential", err)
	}
	if retry := apiCall(s, admin, "POST", "/api/v1/modules", body, nil); retry.Code != 202 || !strings.Contains(retry.Body.String(), created.Job.ID) {
		t.Fatal("idempotent request duplicated registration", retry.Code)
	}
	instance, err := finishModuleFixture(t, s)
	if err != nil || instance.Mode != "external" || instance.ObservedState != "running" || s.Modules.Controller != nil {
		t.Fatal("remote module depends on local controller", err, instance.ObservedState)
	}
	selected, err := s.Modules.FindApplication(context.Background(), "netmap")
	actual, decodeErr := s.Modules.ApplicationKey(context.Background(), instance.ID)
	if err != nil || decodeErr != nil || selected.ID != instance.ID || !bytes.Equal(actual, key) {
		t.Fatal("canonical external application/key resolution failed", err, decodeErr)
	}
	clear(actual)
	before := requests
	for _, who := range []apiIdentity{{}, viewer} {
		if denied := apiCall(s, who, "GET", "/netmap/api/topology", nil, nil); denied.Code != 401 && denied.Code != 403 {
			t.Fatal("external gateway bypassed role/session", denied.Code)
		}
	}
	if requests != before {
		t.Fatal("unauthorized browser request reached remote")
	}
	if got := apiCall(s, admin, "GET", "/netmap/api/topology", nil, nil); got.Code != 200 || !browserClaims.Admin || browserClaims.Subject != "local-admin" || browserClaims.Audience != "netmap" || browserClaims.Version != 2 {
		t.Fatal("remote browser signature lost identity", got.Code, browserClaims.Subject)
	}
	for _, path := range []string{"/netmap/netbox/login/", "/netmap/gitea/user/login", "/netmap/oxidized/"} {
		if got := apiCall(s, admin, "GET", path, nil, nil); got.Code != 200 {
			t.Fatal("external native subpath failed", path, got.Code)
		}
	}
	before = requests
	if got := apiCall(s, admin, "POST", "/api/v1/modules/"+instance.ID+"/netmap/profiles", map[string]string{"id": "fixture"}, map[string]string{"X-CSRF-Token": "forged"}); got.Code != 403 || requests != before {
		t.Fatal("external mutation bypassed CSRF", got.Code)
	}
	if got := apiCall(s, admin, "POST", "/api/v1/modules/"+instance.ID+"/initial-login", map[string]string{"service": "netbox"}, nil); got.Code != 409 {
		t.Fatal("external connection disclosed a local initial login", got.Code)
	}
	transition := func(action string) {
		t.Helper()
		before := requests
		if response := apiCall(s, admin, "POST", "/api/v1/modules/"+instance.ID+"/actions", map[string]string{"action": action, "idempotency_key": "netmap:external:" + action, "confirm_name": instance.Name}, nil); response.Code != 202 {
			t.Fatal(action, response.Code)
		}
		if _, err := finishModuleFixture(t, s); err != nil {
			t.Fatal(action, err)
		}
		if action != "enable" && requests != before {
			t.Fatal("disconnect mutated or probed remote service", action)
		}
	}
	transition("disable")
	before = requests
	if got := apiCall(s, admin, "GET", "/netmap/api/topology", nil, nil); got.Code != 503 || requests != before {
		t.Fatal("disabled connection retained transport access", got.Code)
	}
	retained, err := s.Store.IntegrationCredential(context.Background(), instance.IntegrationID)
	if err != nil || !bytes.Equal(retained.Envelope, stored.Envelope) {
		t.Fatal("disable changed credentials", err)
	}
	transition("enable")
	transition("remove")
	if _, err := s.Store.IntegrationCredential(context.Background(), instance.IntegrationID); err != store.ErrNotFound {
		t.Fatal("remove retained credential", err)
	}
	before = requests
	if got := apiCall(s, admin, "GET", "/netmap/api/topology", nil, nil); got.Code != 503 || requests != before {
		t.Fatal("removed connection called old endpoint", got.Code)
	}
	key = bytes.Repeat([]byte{8}, 32)
	body["endpoint"], body["gateway_key"], body["idempotency_key"] = "https://example.com:18444", hex.EncodeToString(key), "netmap:external:new-endpoint"
	replacement := apiDecode[struct {
		Instance model.ModuleInstance `json:"instance"`
	}](t, apiCall(s, admin, "POST", "/api/v1/modules", body, nil), 202)
	if replacement.Instance.ID == instance.ID || replacement.Instance.Endpoint == instance.Endpoint {
		t.Fatal("old deployment identity prevented replacement")
	}
	reconnected, err := finishModuleFixture(t, s)
	if err != nil || reconnected.Endpoint != body["endpoint"] || reconnected.ObservedState != "running" {
		t.Fatal("replacement did not use fresh endpoint/key", err)
	}
	if got := apiCall(s, admin, "GET", "/netmap/api/topology", nil, nil); got.Code != 200 {
		t.Fatal("new connection reused removed application identity", got.Code)
	}
	before = requests
	if _, err = s.Store.Pool.Exec(context.Background(), "DELETE FROM sessions WHERE token_hash=$1", hash(admin.cookie.Value)); err != nil {
		t.Fatal(err)
	}
	if got := apiCall(s, admin, "GET", "/netmap/api/topology", nil, nil); got.Code != 401 || requests != before {
		t.Fatal("revoked session reached remote adapter", got.Code)
	}
}

func TestNetMapExternalAliasRejectsLegacyDuplicateEvenWhenLocalIsDisabled(t *testing.T) {
	s, _ := localUsersFixture(t)
	s.Modules = modules.New(s.Store, nil)
	for _, instance := range []model.ModuleInstance{
		{ID: "11111111-1111-4111-8111-111111111111", ModuleID: "netmap", Mode: "external", DesiredState: "enabled", ObservedState: "running"},
		{ID: "22222222-2222-4222-8222-222222222222", ModuleID: "netmap", Mode: "local", DesiredState: "disabled", ObservedState: "disabled"},
	} {
		if _, err := s.Store.Save(context.Background(), "module_instance", instance.ID, 0, instance, "test"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.Modules.FindApplication(context.Background(), "netmap"); err != modules.ErrApplicationUnavailable {
		t.Fatal("ambiguous legacy alias selected a running instance", err)
	}
}

func TestNetMapExternalCatalogueAndInputAreCapabilityGated(t *testing.T) {
	s, admin := localUsersFixture(t)
	s.Config.PortableRelease = true
	s.Modules = modules.New(s.Store, nil)
	catalogue := apiCall(s, admin, "GET", "/api/v1/modules/catalog", nil, nil)
	// Decode generically: catalogue definitions have no credential-bearing fields.
	var body map[string]json.RawMessage
	if json.Unmarshal(catalogue.Body.Bytes(), &body) != nil {
		t.Fatal("invalid catalogue")
	}
	var items []struct {
		ID    string   `json:"id"`
		Modes []string `json:"modes"`
	}
	if json.Unmarshal(body["items"], &items) != nil {
		t.Fatal("invalid catalogue items")
	}
	for _, item := range items {
		if item.ID == "netmap" {
			for _, mode := range item.Modes {
				if mode == "external" {
					t.Fatal("catalogue promised external without decoder")
				}
			}
		}
	}
	input := map[string]any{"module_id": "netmap", "name": "Remote", "mode": "external", "endpoint": "https://netmap.example", "gateway_key": strings.Repeat("07", 32), "idempotency_key": "netmap:external:no-decoder"}
	if got := apiCall(s, admin, "POST", "/api/v1/modules", input, nil); got.Code != 409 {
		t.Fatal("credential storage absence not reported", got.Code)
	}
	input["gateway_key"] = "invalid"
	if got := apiCall(s, admin, "POST", "/api/v1/modules", input, nil); got.Code != 400 {
		t.Fatal("invalid key accepted", got.Code)
	}
	input["gateway_key"] = strings.Repeat("07", 32)
	input["config"] = map[string]string{"gateway_key": input["gateway_key"].(string)}
	if got := apiCall(s, admin, "POST", "/api/v1/modules", input, nil); got.Code != 400 {
		t.Fatal("plaintext key accepted in public config", got.Code)
	}
	delete(input, "config")
	input["mode"] = "local"
	if got := apiCall(s, admin, "POST", "/api/v1/modules", input, nil); got.Code != 400 {
		t.Fatal("gateway key accepted for local module", got.Code)
	}
}

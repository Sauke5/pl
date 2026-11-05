package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pl/portal/internal/model"
)

func bootstrapGateFixture(t *testing.T) (*Server, apiIdentity) {
	t.Helper()
	s, admin := localUsersFixture(t)
	if err := os.WriteFile(s.passwordChangeMarker(), nil, 0600); err != nil {
		t.Fatal(err)
	}
	return s, admin
}

func TestBootstrapPasswordRequiredBlocksProtectedHTTP(t *testing.T) {
	s, admin := bootstrapGateFixture(t)
	for _, tc := range []struct {
		method, path string
		body         any
	}{
		{http.MethodGet, "/api/v1/resources", nil},
		{http.MethodHead, "/api/v1/resources", nil},
		{http.MethodGet, "/api/v1/settings", nil},
		{http.MethodGet, "/api/v1/local-users", nil},
		{http.MethodGet, "/api/v1/help-state", nil},
		{http.MethodPost, "/api/v1/resources", model.Resource{Name: "Bootstrap bypass", URL: "https://bypass.example.test"}},
		// These routes read the session directly instead of using s.auth.
		{http.MethodGet, "/internal/auth/dozzle", nil},
		{http.MethodGet, "/api/v1/board", nil},
	} {
		t.Run(tc.method+tc.path, func(t *testing.T) {
			w := apiCall(s, admin, tc.method, tc.path, tc.body, nil)
			var problem struct {
				Code string `json:"error"`
			}
			_ = json.Unmarshal(w.Body.Bytes(), &problem)
			if w.Code != http.StatusForbidden || problem.Code != "password_change_required" {
				t.Fatalf("bootstrap session bypassed password gate: %s %s: %d %s", tc.method, tc.path, w.Code, w.Body.String())
			}
		})
	}
}

func TestBootstrapPasswordHeaderCannotBypassDirectSessionGateways(t *testing.T) {
	s, admin := bootstrapGateFixture(t)
	for _, path := range []string{"/api/v1/board", "/internal/auth/dozzle"} {
		for _, value := range []string{"", "Basic ZmFrZTpmYWtl", "Bearer forged-token"} {
			w := apiCall(s, admin, http.MethodGet, path, nil, map[string]string{"Authorization": value})
			if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "password_change_required") {
				t.Fatalf("header bypassed bootstrap gate on a direct session route: %s %d %s", path, w.Code, w.Body.String())
			}
		}
	}
}

func TestBootstrapPasswordRequiredKeepsSessionHealthPasswordAndLogoutFlow(t *testing.T) {
	s, admin := bootstrapGateFixture(t)
	info := apiDecode[map[string]any](t, apiCall(s, admin, http.MethodGet, "/api/v1/session", nil, nil), http.StatusOK)
	if info["authenticated"] != true || info["local_password_change_required"] != true || info["csrf_token"] != admin.csrf {
		t.Fatal("bootstrap session cannot render the existing password prompt")
	}
	for _, path := range []string{"/health/live", "/health/ready"} {
		if w := apiCall(s, admin, http.MethodGet, path, nil, nil); w.Code != http.StatusOK {
			t.Fatalf("public health was restricted: %s: %d %s", path, w.Code, w.Body.String())
		}
	}
	body := map[string]string{"current_password": "admin", "new_password": "fixture changed admin password"}
	for _, path := range []string{"/api/v1/local-admin/password", "/auth/logout"} {
		for _, headers := range []map[string]string{{"X-CSRF-Token": "wrong"}, {"Origin": "https://other.invalid"}} {
			w := apiCall(s, admin, http.MethodPost, path, body, headers)
			if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), `"error":"csrf"`) {
				t.Fatalf("password/logout lost CSRF or origin enforcement: %s: %d %s", path, w.Code, w.Body.String())
			}
		}
	}
	if w := apiCall(s, admin, http.MethodPost, "/api/v1/local-admin/password", body, nil); w.Code != http.StatusNoContent {
		t.Fatalf("required password change failed: %d %s", w.Code, w.Body.String())
	}
	if s.localPasswordChangeRequired() {
		t.Fatal("successful password change did not clear the marker")
	}
	if w := apiCall(s, admin, http.MethodGet, "/api/v1/resources", nil, nil); w.Code != http.StatusUnauthorized {
		t.Fatal("password change retained an old privileged session")
	}
	changed := localUserIdentity(t, s, "admin", body["new_password"])
	if w := apiCall(s, changed, http.MethodGet, "/api/v1/resources", nil, nil); w.Code != http.StatusOK {
		t.Fatalf("changed administrator stayed restricted: %d %s", w.Code, w.Body.String())
	}
	if w := apiCall(s, changed, http.MethodPost, "/auth/logout", nil, nil); w.Code != http.StatusNoContent {
		t.Fatalf("changed administrator cannot log out: %d", w.Code)
	}
}

func TestBootstrapPasswordRequiredAllowsInitialRandomSeedLoginAndRestrictedLogout(t *testing.T) {
	s, _ := bootstrapGateFixture(t)
	password := "fixture random initial password"
	if err := os.WriteFile(s.Config.LocalAdminHashFile, []byte(localTestHash(password)), 0600); err != nil {
		t.Fatal(err)
	}
	response := apiCall(s, apiIdentity{}, http.MethodPost, "/auth/local", map[string]string{"username": "admin", "password": password}, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("initial browser login failed: %d %s", response.Code, response.Body.String())
	}
	var login apiIdentity
	for _, cookie := range response.Result().Cookies() {
		if cookie.Name == "portal_session" {
			login.cookie = cookie
		}
	}
	if login.cookie == nil {
		t.Fatal("initial login did not create its restricted browser session")
	}
	info := apiDecode[map[string]any](t, apiCall(s, login, http.MethodGet, "/api/v1/session", nil, nil), http.StatusOK)
	if info["authenticated"] != true || info["local_password_change_required"] != true {
		t.Fatal("fresh initial login lost the change-password session")
	}
	login.csrf, _ = info["csrf_token"].(string)
	if w := apiCall(s, login, http.MethodPost, "/auth/logout", nil, nil); w.Code != http.StatusNoContent {
		t.Fatalf("restricted administrator cannot log out: %d %s", w.Code, w.Body.String())
	}
	if !s.localPasswordChangeRequired() {
		t.Fatal("logout cleared the password-change requirement")
	}
	info = apiDecode[map[string]any](t, apiCall(s, login, http.MethodGet, "/api/v1/session", nil, nil), http.StatusOK)
	if info["authenticated"] != false {
		t.Fatal("logout retained the bootstrap session")
	}
}

func TestBootstrapPasswordRequiredAllowlistIsMethodAndCanonicalPathBound(t *testing.T) {
	s, admin := bootstrapGateFixture(t)
	for _, tc := range []struct{ method, path string }{
		{http.MethodPost, "/api/v1/session"},
		{http.MethodGet, "/api/v1/local-admin/password"},
		{http.MethodPost, "/api/v1/local-admin/password/extra"},
		{http.MethodGet, "/auth/logout"},
		{http.MethodPost, "/auth/logout/extra"},
		{http.MethodPost, "/api/v1/local-admin/%70assword"},
		{http.MethodGet, "/api/v1/session/../resources"},
	} {
		w := apiCall(s, admin, tc.method, tc.path, nil, nil)
		if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), `"error":"password_change_required"`) {
			t.Fatalf("allowlist admitted a different request: %s %s: %d %s", tc.method, tc.path, w.Code, w.Body.String())
		}
	}
}

func TestBootstrapPasswordRequiredDoesNotRestrictOtherUsersOrMachines(t *testing.T) {
	s, admin := localUsersFixture(t)
	createFixtureLocalUser(t, s, admin, "gate-admin", true)
	createFixtureLocalUser(t, s, admin, "gate-viewer", false)
	localAdmin := localUserIdentity(t, s, "gate-admin", localUserFixturePassword)
	localViewer := localUserIdentity(t, s, "gate-viewer", localUserFixturePassword)
	adAdmin := apiUser(t, s, "ad:fixture-admin", true)
	if err := os.WriteFile(s.passwordChangeMarker(), nil, 0600); err != nil {
		t.Fatal(err)
	}
	for _, who := range []apiIdentity{localAdmin, adAdmin} {
		if w := apiCall(s, who, http.MethodGet, "/api/v1/resources", nil, nil); w.Code != http.StatusOK {
			t.Fatalf("unrelated administrator restricted: %d %s", w.Code, w.Body.String())
		}
	}
	if w := apiCall(s, localViewer, http.MethodGet, "/api/v1/help-state", nil, nil); w.Code != http.StatusOK {
		t.Fatalf("ordinary local user restricted: %d %s", w.Code, w.Body.String())
	}
	if w := apiCall(s, localViewer, http.MethodGet, "/api/v1/resources", nil, nil); w.Code != http.StatusForbidden || strings.Contains(w.Body.String(), "password_change_required") {
		t.Fatal("ordinary local user lost the existing admin boundary")
	}
	token := strings.Repeat("bootstrap-scope-fixture-", 3)
	principal := machinePrincipal{ID: "fixture", TokenSHA256: hash(token), Scopes: []string{"catalog:read"}, ExpiresAt: time.Now().Add(time.Hour)}
	data, _ := json.Marshal(map[string]any{"principals": []machinePrincipal{principal}})
	s.Config.MachineCredentialsFile = filepath.Join(t.TempDir(), "machine.json")
	if err := os.WriteFile(s.Config.MachineCredentialsFile, data, 0600); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodGet, s.Config.PublicURL+"/api/v1/resources", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("scoped machine request affected by bootstrap marker: %d %s", w.Code, w.Body.String())
	}
	s.Config.LocalAdminPasswordChange = false
	if w := apiCall(s, admin, http.MethodGet, "/api/v1/resources", nil, nil); w.Code != http.StatusOK {
		t.Fatal("opt-out profile acquired a new password policy")
	}
}

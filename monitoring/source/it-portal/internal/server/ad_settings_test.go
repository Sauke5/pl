package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"pl/portal/internal/connectorcredentials"
	"pl/portal/internal/store"
)

func managedADFixture(t *testing.T, f *adFixture) (*Server, apiIdentity, adSettingsInput) {
	t.Helper()
	s := apiFixture(t)
	c := adServer(t, f)
	ca, err := os.ReadFile(c.CAFile)
	if err != nil {
		t.Fatal(err)
	}
	codec, err := connectorcredentials.New(bytes.Repeat([]byte{42}, 32))
	if err != nil {
		t.Fatal(err)
	}
	s.connectorCredentials = &connectorCredentialService{codec: codec}
	return s, apiUser(t, s, "local-admin", true), adSettingsInput{adLoginConfiguration: adLoginConfiguration{
		URL: c.ADURL, BaseDN: c.ADBaseDN, UserSuffix: c.ADUserSuffix,
		AdminGroupDN: "CN=Portal Admins,OU=Groups,DC=example,DC=test", BindUsername: "pl-reader@example.test", CAPEM: string(ca),
	}, Password: "fixture-password"}
}

func adSettingsCall(s *Server, who apiIdentity, method, path string, body any, headers map[string]string) *httptest.ResponseRecorder {
	var encoded bytes.Buffer
	if body != nil {
		_ = json.NewEncoder(&encoded).Encode(body)
	}
	r := httptest.NewRequest(method, s.Config.PublicURL+path, &encoded)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", s.Config.PublicURL)
	if who.cookie != nil {
		r.AddCookie(who.cookie)
	}
	if who.csrf != "" {
		r.Header.Set("X-CSRF-Token", who.csrf)
	}
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	m := http.NewServeMux()
	s.RegisterADSettingsRoutes(m)
	w := httptest.NewRecorder()
	m.ServeHTTP(w, r)
	return w
}

func TestManagedADSettingsRoundTripAndRecovery(t *testing.T) {
	s, admin, input := managedADFixture(t, &adFixture{admin: true})
	oldAD := apiUser(t, s, "ad:previous-session", true)
	test := adSettingsCall(s, admin, "POST", "/api/v1/settings/ad/test", input, nil)
	if test.Code != 200 {
		t.Fatalf("test: %d %s", test.Code, test.Body.String())
	}
	if _, err := s.Store.ADLoginSettings(context.Background()); !errors.Is(err, store.ErrNotFound) {
		t.Fatal("test request persisted configuration", err)
	}
	response := adSettingsCall(s, admin, "PUT", "/api/v1/settings/ad", input, nil)
	state := apiDecode[adSettingsResponse](t, response, 200)
	if state.Revision != 1 || !state.Configured || !state.PasswordSet || !state.Writable || state.TestedAt == nil {
		t.Fatalf("bad response %+v", state)
	}
	if strings.Contains(response.Body.String(), input.Password) || strings.Contains(response.Body.String(), "envelope") {
		t.Fatal("secret returned to browser")
	}
	record, err := s.Store.ADLoginSettings(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(record.PasswordEnvelope, []byte(input.Password)) {
		t.Fatal("plaintext password in storage")
	}
	password, err := s.adStoredPassword(input.adLoginConfiguration, record)
	if err != nil || password != input.Password {
		t.Fatal("encrypted password roundtrip failed", err)
	}
	r := httptest.NewRequest("GET", s.Config.PublicURL+"/", nil)
	r.AddCookie(oldAD.cookie)
	if _, err := s.readSession(r); err == nil {
		t.Fatal("old AD session not revoked")
	}
	r = httptest.NewRequest("GET", s.Config.PublicURL+"/", nil)
	r.AddCookie(admin.cookie)
	if user, err := s.readSession(r); err != nil || user.User.ID != "local-admin" || !user.User.Admin {
		t.Fatal("recovery administrator was affected", err)
	}
	// The retained secret is re-sealed against the complete new configuration.
	input.Revision = 1
	input.Password = ""
	input.UserSuffix = "new.example.test"
	if w := adSettingsCall(s, admin, "PUT", "/api/v1/settings/ad", input, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := adSettingsCall(s, admin, "PUT", "/api/v1/settings/ad", input, nil); w.Code != 409 {
		t.Fatal("stale revision accepted", w.Code)
	}
	input.Revision = 2
	input.URL = "ldaps://other.example.test:636"
	if w := adSettingsCall(s, admin, "PUT", "/api/v1/settings/ad", input, nil); w.Code != 400 {
		t.Fatal("stored secret would be sent to a different host", w.Code)
	}
}

func TestManagedADSettingsPermissionsTLSAndNoFailedWrites(t *testing.T) {
	s, admin, input := managedADFixture(t, &adFixture{admin: true})
	viewer := apiUser(t, s, "viewer", false)
	for _, tc := range []struct {
		name    string
		who     apiIdentity
		headers map[string]string
		want    int
	}{
		{"anonymous", apiIdentity{}, nil, 401}, {"viewer", viewer, nil, 403},
		{"machine", admin, map[string]string{"Authorization": "Bearer cannot-admin"}, 403},
		{"csrf", apiIdentity{cookie: admin.cookie}, nil, 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := adSettingsCall(s, tc.who, "PUT", "/api/v1/settings/ad", input, tc.headers)
			if w.Code != tc.want {
				t.Fatal(w.Code, w.Body.String())
			}
		})
	}
	for _, tc := range []struct {
		name   string
		change func(*adSettingsInput)
		want   int
	}{
		{"untrusted TLS", func(v *adSettingsInput) { v.CAPEM = "" }, 503},
		{"wrong bind password", func(v *adSettingsInput) { v.Password = "not-the-password" }, 503},
		{"wrong group", func(v *adSettingsInput) { v.AdminGroupDN = "CN=Other,DC=example,DC=test" }, 503},
		{"empty settings", func(v *adSettingsInput) { v.URL = "" }, 400},
		{"URL credentials", func(v *adSettingsInput) { v.URL = "ldaps://reader:password@dc.example.test" }, 400},
		{"query marker", func(v *adSettingsInput) { v.URL += "?" }, 400},
		{"CA garbage", func(v *adSettingsInput) { v.CAPEM = "garbage\n" + v.CAPEM }, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v := input
			tc.change(&v)
			w := adSettingsCall(s, admin, "PUT", "/api/v1/settings/ad", v, nil)
			if w.Code != tc.want {
				t.Fatal(w.Code, w.Body.String())
			}
			if strings.Contains(w.Body.String(), v.Password) && v.Password != "" {
				t.Fatal("secret in error")
			}
		})
	}
	if _, err := s.Store.ADLoginSettings(context.Background()); !errors.Is(err, store.ErrNotFound) {
		t.Fatal("failed requests changed persisted AD", err)
	}
}

func TestManagedADRevalidatesAccountAndRole(t *testing.T) {
	f := &adFixture{admin: true}
	s, admin, input := managedADFixture(t, f)
	if w := adSettingsCall(s, admin, "PUT", "/api/v1/settings/ad", input, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	c, record, err := s.adConfiguration(context.Background())
	if err != nil || record == nil {
		t.Fatal(err)
	}
	u, err := authenticateAD(context.Background(), c, "test.user", "fixture-password")
	if err != nil || !u.Admin {
		t.Fatal("managed login", u, err)
	}
	identity := apiUser(t, s, u.ID, true)
	request := func(who apiIdentity) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", s.Config.PublicURL+"/admin", nil)
		r.AddCookie(who.cookie)
		w := httptest.NewRecorder()
		s.auth(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }, true)(w, r)
		return w
	}
	if w := request(identity); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	f.mu.Lock()
	f.admin = false
	f.mu.Unlock()
	if w := request(identity); w.Code != 403 {
		t.Fatal("directory group removal retained administrator role", w.Code, w.Body.String())
	}
	f.mu.Lock()
	f.disabled = true
	f.mu.Unlock()
	if w := request(identity); w.Code != 401 {
		t.Fatal("disabled AD account retained session", w.Code, w.Body.String())
	}
	f.mu.Lock()
	f.badPassword = true
	f.mu.Unlock()
	if w := request(identity); w.Code != 503 {
		t.Fatal("directory outage did not fail closed", w.Code, w.Body.String())
	}
	if w := request(admin); w.Code != 200 {
		t.Fatal("AD outage blocked local recovery", w.Code, w.Body.String())
	}
	// No stored password is accepted under a changed configuration binding.
	changed := input.adLoginConfiguration
	changed.AdminGroupDN = "CN=Different,DC=example,DC=test"
	if _, err := s.adStoredPassword(changed, *record); err == nil {
		t.Fatal("ciphertext not bound to AD configuration")
	}
}

func TestManagedADUnicodeCredentialAndEnvironmentFallback(t *testing.T) {
	c := Config{ADURL: "ldaps://dc.example.test", ADBaseDN: "DC=example,DC=test", ADUserSuffix: "example.test", ADGroupDN: "CN=Admins,DC=example,DC=test"}
	s := &Server{Config: c}
	if cfg, record, err := s.adConfiguration(context.Background()); err != nil || record != nil || cfg.ADURL != c.ADURL {
		t.Fatal("environment fallback changed", err)
	}
	codec, _ := connectorcredentials.New(bytes.Repeat([]byte{11}, 32))
	s.connectorCredentials = &connectorCredentialService{codec: codec}
	v := adLoginConfiguration{URL: c.ADURL, BaseDN: c.ADBaseDN, UserSuffix: c.ADUserSuffix, AdminGroupDN: c.ADGroupDN, BindUsername: "reader@example.test"}
	password := "пароль с пробелом"
	if !validADBindPassword(password) {
		t.Fatal("valid bind credential rejected")
	}
	// prepareADSettings uses base64 before the existing ASCII credential codec.
	encoded := base64.RawStdEncoding.EncodeToString([]byte(password))
	envelope, err := codec.Seal(v.binding(), adCredentialOrigin, encoded)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := s.adStoredPassword(v, store.ADLoginSettings{PasswordEnvelope: envelope, TestedAt: time.Now()}); err != nil || got != password {
		t.Fatal("unicode credential roundtrip", err)
	}
}

func TestManagedADRevocationDuringDirectoryCheck(t *testing.T) {
	f := &adFixture{admin: true}
	s, admin, input := managedADFixture(t, f)
	if w := adSettingsCall(s, admin, "PUT", "/api/v1/settings/ad", input, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	c, _, err := s.adConfiguration(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	u, err := authenticateAD(context.Background(), c, "test.user", "fixture-password")
	if err != nil {
		t.Fatal(err)
	}
	identity := apiUser(t, s, u.ID, true)
	gate, entered := make(chan struct{}), make(chan struct{}, 1)
	f.mu.Lock()
	f.searchGate = gate
	f.searchEntered = entered
	f.mu.Unlock()
	result := make(chan error, 1)
	go func() {
		r := httptest.NewRequest("GET", s.Config.PublicURL+"/admin", nil)
		r.AddCookie(identity.cookie)
		_, err := s.readSession(r)
		result <- err
	}()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		close(gate)
		t.Fatal("directory check did not start")
	}
	if _, err := s.Store.Pool.Exec(context.Background(), "DELETE FROM sessions WHERE user_id=$1", u.ID); err != nil {
		close(gate)
		t.Fatal(err)
	}
	close(gate)
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("revoked session survived directory check")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("directory check did not finish")
	}
}

func TestManagedADDoesNotApplyAfterAdministratorSessionRevocation(t *testing.T) {
	f := &adFixture{admin: true}
	s, _, input := managedADFixture(t, f)
	admin := apiUser(t, s, "fixture-temporary-admin", true)
	gate, entered := make(chan struct{}), make(chan struct{}, 1)
	f.mu.Lock()
	f.searchGate = gate
	f.searchEntered = entered
	f.mu.Unlock()
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() { result <- adSettingsCall(s, admin, "PUT", "/api/v1/settings/ad", input, nil) }()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		close(gate)
		t.Fatal("directory test did not start")
	}
	if _, err := s.Store.Pool.Exec(context.Background(), "DELETE FROM sessions WHERE user_id=$1", "fixture-temporary-admin"); err != nil {
		close(gate)
		t.Fatal(err)
	}
	close(gate)
	select {
	case w := <-result:
		if w.Code != 401 {
			t.Fatal("revoked administrator changed AD policy", w.Code, w.Body.String())
		}
	case <-time.After(3 * time.Second):
		t.Fatal("apply did not finish")
	}
	if _, err := s.Store.ADLoginSettings(context.Background()); !errors.Is(err, store.ErrNotFound) {
		t.Fatal("revoked administrator persisted AD configuration", err)
	}
}

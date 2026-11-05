package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"pl/portal/internal/modules"
	"testing"
)

type installationControllerFixture struct {
	deliveryControllerFixture
	changes int
}

func (c *installationControllerFixture) Installation(_ context.Context, change *modules.InstallationChange) (modules.InstallationStatus, error) {
	if change != nil {
		c.changes++
	}
	return modules.InstallationStatus{CoreAPI: 1, InstallationSettings: modules.InstallationSettings{PublicURL: "https://pl.example.test", BindAddress: "0.0.0.0"}}, nil
}
func installationFixtureChange() modules.InstallationChange {
	return modules.InstallationChange{OperationID: "727b18f8-99da-410f-b94f-e677f2967731", InstallationSettings: modules.InstallationSettings{PublicURL: "https://pl.example.test", BindAddress: "0.0.0.0", AllowedCIDRs: []string{"10.20.0.0/16"}, AllowedPorts: []int{443, 9090}}}
}
func TestInstallationSettingsRequiresCurrentAdminAndCSRF(t *testing.T) {
	s, admin := localUsersFixture(t)
	s.Config.PortableRelease = true
	c := &installationControllerFixture{}
	s.Modules = modules.New(s.Store, c)
	viewer := apiUser(t, s, "installation-viewer", false)
	for _, who := range []apiIdentity{viewer, {}} {
		for _, method := range []string{"GET", "PUT"} {
			w := apiCall(s, who, method, "/api/v1/installation", installationFixtureChange(), nil)
			if w.Code != 401 && w.Code != 403 {
				t.Fatal(w.Code, w.Body.String())
			}
		}
	}
	for _, headers := range []map[string]string{{"X-CSRF-Token": "forged"}, {"Origin": "https://other.example.test"}, {"Authorization": "Bearer fixture"}} {
		w := apiCall(s, admin, "PUT", "/api/v1/installation", installationFixtureChange(), headers)
		if w.Code != 403 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if c.changes != 0 {
		t.Fatal("unauthorized installation change")
	}
	w := apiCall(s, admin, "PUT", "/api/v1/installation", installationFixtureChange(), nil)
	if w.Code != http.StatusOK || c.changes != 1 {
		t.Fatal(w.Code, w.Body.String())
	}
}
func TestInstallationSettingsRejectsDestinationsAndPartialSecrets(t *testing.T) {
	for _, modify := range []func(*modules.InstallationChange){
		func(v *modules.InstallationChange) { v.PublicURL = "http://pl.example.test" },
		func(v *modules.InstallationChange) { v.PublicURL = "https://user:password@pl.example.test" },
		func(v *modules.InstallationChange) { v.PublicURL = "https://pl.example.test/path" },
		func(v *modules.InstallationChange) { v.OperationID = "../host" },
		func(v *modules.InstallationChange) { v.AllowedCIDRs = []string{"10.20.0.1/16"} },
		func(v *modules.InstallationChange) { v.AllowedPorts = []int{0} },
		func(v *modules.InstallationChange) { v.TLSKeyPEM = "private-fixture-key" },
	} {
		value := installationFixtureChange()
		modify(&value)
		if validInstallationChange(value) {
			t.Fatal("unsafe configuration accepted")
		}
	}
	if !validInstallationChange(installationFixtureChange()) {
		t.Fatal("valid configuration rejected")
	}
}

func TestInstallationSettingsRechecksSessionAfterReadingCertificateBody(t *testing.T) {
	s, _ := localUsersFixture(t)
	s.Config.PortableRelease = true
	c := &installationControllerFixture{}
	s.Modules = modules.New(s.Store, c)
	admin := apiUser(t, s, "installation-revoked-admin", true)
	body, _ := json.Marshal(installationFixtureChange())
	reader := &installationRevokingBody{reader: bytes.NewReader(body), revoke: func() {
		if _, err := s.Store.Pool.Exec(context.Background(), "DELETE FROM sessions WHERE user_id='installation-revoked-admin'"); err != nil {
			t.Fatal(err)
		}
	}}
	r := httptest.NewRequest("PUT", s.Config.PublicURL+"/api/v1/installation", reader)
	r.AddCookie(admin.cookie)
	r.Header.Set("Origin", s.Config.PublicURL)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-CSRF-Token", admin.csrf)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != 403 || c.changes != 0 {
		t.Fatal("revoked administrator changed installation", w.Code, c.changes)
	}
}

type installationRevokingBody struct {
	reader io.Reader
	revoke func()
}

func (b *installationRevokingBody) Read(p []byte) (int, error) {
	if b.revoke != nil {
		revoke := b.revoke
		b.revoke = nil
		revoke()
	}
	return b.reader.Read(p)
}

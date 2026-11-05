package server

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"pl/portal/internal/organization"
	"strings"
	"testing"
	"time"
)

func TestDoskaIntegrationActualRouterAndLogout(t *testing.T) {
	s := apiFixture(t)
	if err := s.InitDoska(); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	guid := make([]byte, 16)
	guid[15] = 9
	sub, _ := organization.ADSubject("dc=doska,dc=test", guid)
	org := organization.NewStore(s.Store.Pool)
	_, err := org.SaveEmployee(context.Background(), organization.EmployeeRecord{Identity: organization.Identity{Subject: sub, Name: "Employee", AccountState: organization.Active, LastSuccessAt: now}, Provider: "ad", ProviderNamespace: strings.Split(sub, ":")[1], ObjectGUID: guid}, 0, "fixture", now)
	if err != nil {
		t.Fatal(err)
	}
	user := apiUser(t, s, sub, false)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()
	s.Config.Doska = &DoskaGatewayConfig{APIUpstream: upstream.URL, WebUpstream: upstream.URL, Key: bytes.Repeat([]byte("x"), 32), Manifest: doskaGatewayTestManifest(), Transport: http.DefaultTransport}
	dir := t.TempDir()
	s.Config.DoskaAD = &DoskaADSourceConfig{URL: "ldaps://dc.example.invalid:636", BaseDN: "dc=doska,dc=test", BindDNFile: filepath.Join(dir, "bind.dn"), BindPasswordFile: filepath.Join(dir, "bind.password")}
	if err = s.InitDoska(); err != nil {
		t.Fatal(err)
	}
	if r := apiCall(s, apiIdentity{}, "GET", "/doska/api/doska/context", nil, nil); r.Code != 401 {
		t.Fatal("anonymous", r.Code)
	}
	if r := apiCall(s, user, "GET", "/doska/api/doska/context", nil, nil); r.Code != 200 {
		t.Fatal("employee", r.Code, r.Body.String())
	}
	if r := apiCall(s, user, "POST", "/auth/logout", nil, nil); r.Code != 200 && r.Code != 204 {
		t.Fatal("logout", r.Code)
	}
	if r := apiCall(s, user, "GET", "/doska/api/doska/context", nil, nil); r.Code != 401 {
		t.Fatal("revoked session", r.Code)
	}
}

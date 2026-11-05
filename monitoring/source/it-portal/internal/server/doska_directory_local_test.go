package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/organization"
)

func localDirectoryRequest(s *Server, principal, path string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodGet, path, nil)
	request = request.WithContext(context.WithValue(request.Context(), sessionKey, session{User: model.User{ID: principal, Admin: true}}))
	response := httptest.NewRecorder()
	s.doskaDirectory(response, request)
	return response
}

func TestDoskaGatewayLocalIdentityUsesCurrentDirectoryLease(t *testing.T) {
	s := apiFixture(t)
	s.Config.LocalUsersEnabled = true
	s.Config.LocalAdminHashFile = "configured-test-hash-file"
	ctx := context.Background()
	actor := model.User{ID: "local-admin", Admin: true}
	u, err := s.Store.CreateLocalUser(ctx, actor, "gateway-user", "Gateway local user", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	g := &doskaGateway{server: s}
	now := time.Now().UTC()
	p, err := g.identity(ctx, u.ID, now)
	if err != nil || !p.AccessAllowed || !p.Fresh || !p.DepartmentEligible || len(p.HeadDepartmentIDs) != 0 || p.Subject != u.ID {
		t.Fatal("local gateway identity unavailable or elevated", p, err)
	}
	directory, err := s.Store.LocalDirectoryIdentity(ctx, s.localDoskaDirectorySource(), u.ID, now)
	if err != nil || p.Revision != uint64(directory.Revision) || !p.ValidUntil.Equal(directory.ValidUntil) || !p.LastSuccessAt.Equal(directory.ObservedAt) || p.Department.PrimaryDepartmentID == nil || directory.PrimaryDepartmentID == nil || *p.Department.PrimaryDepartmentID != *directory.PrimaryDepartmentID {
		t.Fatal("gateway assertion diverges from native Directory", p, directory, err)
	}
	u, err = s.Store.UpdateLocalUser(ctx, actor, u.ID, "Disabled administrator", true, true, u.Revision)
	if err != nil {
		t.Fatal(err)
	}
	revoked, err := g.identity(ctx, u.ID, now.Add(time.Second))
	if !errors.Is(err, errDoskaIdentityDenied) || revoked.AccessAllowed || revoked.AccountState != organization.Disabled || revoked.Revision <= p.Revision || len(revoked.HeadDepartmentIDs) != 0 {
		t.Fatal("fresh disabled admin retained gateway access", revoked, err)
	}
	s.Config.LocalUsersEnabled = false
	if _, err = g.identity(ctx, u.ID, now.Add(2*time.Second)); !errors.Is(err, errDoskaIdentityDenied) {
		t.Fatal("disabled local provider accepted", err)
	}
	builtin, err := g.identity(ctx, "local-admin", now)
	if err != nil || !builtin.AccessAllowed || len(builtin.HeadDepartmentIDs) != 0 {
		t.Fatal("configured builtin unavailable or elevated", builtin, err)
	}
	s.Config.LocalAdminHashFile = ""
	if _, err = g.identity(ctx, "local-admin", now.Add(time.Second)); !errors.Is(err, errDoskaIdentityDenied) {
		t.Fatal("removed builtin retained gateway access", err)
	}
	if _, err = g.identity(ctx, "local:not-a-uuid", now); !errors.Is(err, organization.ErrNotFound) {
		t.Fatal("malformed local identity escaped into AD", err)
	}
}
func TestLocalDoskaDirectoryRejectsBrowserHeaders(t *testing.T) {
	for _, header := range []string{"Cookie", "Origin"} {
		request := httptest.NewRequest(http.MethodGet, "/api/v1/doska-directory/employees", nil)
		request.Header.Set(header, "browser-context")
		request = request.WithContext(context.WithValue(request.Context(), sessionKey, session{User: model.User{ID: "machine:doska-directory-local"}}))
		response := httptest.NewRecorder()
		(&Server{}).doskaDirectory(response, request)
		if response.Code != http.StatusForbidden {
			t.Fatal("browser header accepted", header, response.Code)
		}
	}
}
func TestLocalDoskaDirectoryDedicatedPrincipalAndFreshRealAccount(t *testing.T) {
	s := apiFixture(t)
	s.Config.LocalUsersEnabled = true
	s.Config.LocalAdminHashFile = "configured-test-hash-file"
	user, err := s.Store.CreateLocalUser(context.Background(), model.User{ID: "local-admin", Admin: true}, "directory-user", "Local directory user", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	target := "/api/v1/doska-directory/identity?sub=" + user.ID
	for _, principal := range []string{"local-admin", "machine:other"} {
		if response := localDirectoryRequest(s, principal, target); response.Code != 403 {
			t.Fatal("non-directory principal accepted", response.Code)
		}
	}
	if response := localDirectoryRequest(s, "machine:doska-directory", target); response.Code != 404 {
		t.Fatal("local identity leaked into AD provider", response.Code)
	}
	response := localDirectoryRequest(s, "machine:doska-directory-local", target)
	if response.Code != 200 {
		t.Fatal("configured local directory unavailable", response.Code, response.Body.String())
	}
	var identity map[string]any
	if json.Unmarshal(response.Body.Bytes(), &identity) != nil || identity["sub"] != user.ID || identity["state"] != "active" || identity["name"] != user.Name {
		t.Fatal("local identity is not current Pl user", identity)
	}
	if _, exists := identity["admin"]; exists {
		t.Fatal("Portal admin role became implicit native project authority")
	}
	if strings.Contains(response.Body.String(), "fixture-hash") {
		t.Fatal("password material leaked")
	}
	if _, err = s.Store.UpdateLocalUser(context.Background(), model.User{ID: "local-admin", Admin: true}, user.ID, "Disabled local user", true, true, user.Revision); err != nil {
		t.Fatal(err)
	}
	response = localDirectoryRequest(s, "machine:doska-directory-local", target)
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"state":"disabled"`) || !strings.Contains(response.Body.String(), "Disabled local user") {
		t.Fatal("disabled rights were not refreshed", response.Code, response.Body.String())
	}
	response = localDirectoryRequest(s, "machine:doska-directory-local", "/api/v1/doska-directory/departments")
	if response.Code != 200 || !strings.Contains(response.Body.String(), "Личное пространство") {
		t.Fatal("local workspace snapshot unavailable", response.Code, response.Body.String())
	}
}

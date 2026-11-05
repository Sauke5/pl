package server

import (
	"context"
	"testing"
)

func TestDozzleUsesPortalSessionAndRejectsForgedIdentity(t *testing.T) {
	s := apiFixture(t)
	admin := apiUser(t, s, "ad:dozzle-admin", true)
	viewer := apiUser(t, s, "ad:board", false)
	path := "/internal/auth/dozzle"
	headers := map[string]string{"X-Original-Method": "GET", "Remote-User": "forged", "X-Auth-User": "forged"}
	if w := apiCall(s, apiIdentity{}, "GET", path, nil, headers); w.Code != 401 {
		t.Fatal(w.Code)
	}
	if w := apiCall(s, viewer, "GET", path, nil, headers); w.Code != 403 {
		t.Fatal(w.Code)
	}
	w := apiCall(s, admin, "GET", path, nil, headers)
	if w.Code != 204 || w.Header().Get("X-Auth-User") != "portal-"+hash("ad:dozzle-admin")[:32] {
		t.Fatal(w.Code, w.Header())
	}
	headers["X-Original-Method"] = "POST"
	if w := apiCall(s, admin, "GET", path, nil, headers); w.Code != 403 {
		t.Fatal(w.Code)
	}
	headers["X-Original-Method"] = "GET"
	headers["X-Original-Upgrade"] = "websocket"
	headers["Origin"] = "https://foreign.example"
	if w := apiCall(s, admin, "GET", path, nil, headers); w.Code != 403 {
		t.Fatal(w.Code)
	}
	headers["Origin"] = s.Config.PublicURL
	if w := apiCall(s, admin, "GET", path, nil, headers); w.Code != 204 {
		t.Fatal(w.Code)
	}
	if _, err := s.Store.Pool.Exec(context.Background(), "DELETE FROM sessions WHERE token_hash=$1", hash(admin.cookie.Value)); err != nil {
		t.Fatal(err)
	}
	if w := apiCall(s, admin, "GET", path, nil, headers); w.Code != 401 {
		t.Fatal("deleted session retained", w.Code)
	}
}

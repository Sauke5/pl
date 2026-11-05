package server

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/store"
)

func TestRuntimeSettingsBoundsAndLegacyDefaults(t *testing.T) {
	base := model.Settings{Timezone: "UTC", StaleAfterSeconds: 180}
	for _, value := range []int{0, 15, 10080} {
		v := base
		v.SessionLifetimeMinutes = value
		if err := validateSettings(v); err != nil {
			t.Fatal(value, err)
		}
	}
	for _, value := range []int{-1, 1, 14, 10081} {
		v := base
		v.SessionLifetimeMinutes = value
		if validateSettings(v) == nil {
			t.Fatal("accepted session boundary", value)
		}
	}
	for _, value := range []int{0, 8, 128} {
		v := base
		v.LocalPasswordMinLength = value
		if err := validateSettings(v); err != nil {
			t.Fatal(value, err)
		}
	}
	for _, value := range []int{-1, 1, 7, 129} {
		v := base
		v.LocalPasswordMinLength = value
		if validateSettings(v) == nil {
			t.Fatal("accepted password boundary", value)
		}
	}
	s := &Server{Config: Config{SessionLifetime: time.Hour}}
	if d, err := s.sessionLifetime(context.Background()); err != nil || d != time.Hour {
		t.Fatal("legacy configured lifetime lost", d, err)
	}
	if s.validPasswordForRequest(httptest.NewRequest("POST", "/", nil), "12345678") {
		t.Fatal("legacy password minimum weakened")
	}
}

func TestRuntimeSettingsPermissionsCASAndEffectivePolicy(t *testing.T) {
	s := apiFixture(t)
	admin := apiUser(t, s, "admin", true)
	viewer := apiUser(t, s, "viewer", false)
	v, err := store.Get[model.Settings](context.Background(), s.Store, "settings", "global")
	if err != nil {
		t.Fatal(err)
	}
	v.SessionLifetimeMinutes = 15
	v.LocalPasswordMinLength = 8
	if w := apiCall(s, viewer, "PUT", "/api/v1/settings", v, nil); w.Code != 403 {
		t.Fatal("viewer changed policy", w.Code)
	}
	if w := apiCall(s, apiIdentity{}, "PUT", "/api/v1/settings", v, nil); w.Code != 401 {
		t.Fatal("anonymous changed policy", w.Code)
	}
	noCSRF := admin
	noCSRF.csrf = ""
	if w := apiCall(s, noCSRF, "PUT", "/api/v1/settings", v, nil); w.Code != 403 {
		t.Fatal("missing CSRF changed policy", w.Code)
	}
	saved := apiDecode[model.Settings](t, apiCall(s, admin, "PUT", "/api/v1/settings", v, nil), 200)
	if w := apiCall(s, admin, "PUT", "/api/v1/settings", v, nil); w.Code != 409 {
		t.Fatal("stale revision accepted", w.Code)
	}
	if w := apiCall(s, admin, "PUT", "/api/v1/settings", map[string]any{"revision": saved.Revision, "disable_auth": true}, nil); w.Code != 400 {
		t.Fatal("unknown operation accepted", w.Code)
	}
	request := httptest.NewRequest("POST", "/", nil)
	if !s.validPasswordForRequest(request, "12345678") || s.validPasswordForRequest(request, "1234567") || s.validPasswordForRequest(request, "1234567\n") {
		t.Fatal("relaxed password policy not effective")
	}
	d, err := s.sessionLifetime(context.Background())
	if err != nil || d != 15*time.Minute {
		t.Fatal("new lifetime not effective", d, err)
	}
	w := httptest.NewRecorder()
	start := time.Now()
	if err := s.newSession(w, request, model.User{ID: "new-session", Name: "new"}, time.Time{}); err != nil {
		t.Fatal(err)
	}
	request.AddCookie(w.Result().Cookies()[0])
	se, err := s.readSession(request)
	if err != nil || se.ExpiresAt.Before(start.Add(14*time.Minute)) || se.ExpiresAt.After(start.Add(16*time.Minute)) {
		t.Fatal("session persistence ignores policy", se.ExpiresAt, err)
	}
	oldRequest := httptest.NewRequest("GET", "/", nil)
	oldRequest.AddCookie(admin.cookie)
	if old, err := s.readSession(oldRequest); err != nil || old.ExpiresAt.Before(start.Add(50*time.Minute)) {
		t.Fatal("existing session changed", err)
	}
	saved.LocalPasswordMinLength = 24
	saved.SessionLifetimeMinutes = 10080
	apiDecode[model.Settings](t, apiCall(s, admin, "PUT", "/api/v1/settings", saved, nil), 200)
	if s.validPasswordForRequest(request, "12345678") || !s.validPasswordForRequest(request, strings.Repeat("я", 24)) {
		t.Fatal("tightened password policy not effective")
	}
	if d, err := s.sessionLifetime(context.Background()); err != nil || d != 7*24*time.Hour {
		t.Fatal("longer session policy not effective", d, err)
	}
	// A provider token still caps a newly created Platform session.
	providerExpiry := time.Now().Add(20 * time.Minute)
	w = httptest.NewRecorder()
	if err := s.newSession(w, httptest.NewRequest("GET", "/", nil), model.User{ID: "oidc-user", Name: "OIDC"}, providerExpiry); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("GET", "/", nil)
	r.AddCookie(w.Result().Cookies()[0])
	se, err = s.readSession(r)
	if err != nil || se.ExpiresAt.After(providerExpiry.Add(time.Second)) {
		t.Fatal("provider token expiry extended", err)
	}
}

func TestRuntimeSettingsDoesNotInventHostResources(t *testing.T) {
	s := apiFixture(t)
	admin := apiUser(t, s, "admin", true)
	value := apiDecode[map[string]any](t, apiCall(s, admin, "GET", "/api/v1/runtime", nil, nil), 200)
	if _, present := value["host"]; present {
		t.Fatal("missing controller fabricated host values")
	}
	if message, ok := value["host_error"].(string); !ok || message == "" {
		t.Fatal("missing controller not explained")
	}
	if value["process_memory_bytes"] == nil || value["go_version"] == nil {
		t.Fatal("real process facts absent")
	}
	viewer := apiUser(t, s, "viewer", false)
	if w := apiCall(s, viewer, "GET", "/api/v1/runtime", nil, nil); w.Code != 403 {
		t.Fatal("host diagnostics exposed to viewer", w.Code)
	}
}

package server

import (
	"context"
	"github.com/google/uuid"
	"net/http"
	"net/http/httptest"
	"pl/portal/internal/model"
	"testing"
)

func TestConfigurationHistoryAdminRoutesAndEmptyCache(t *testing.T) {
	s := apiFixture(t)
	admin := apiUser(t, s, "configuration-admin", true)
	viewer := apiUser(t, s, "configuration-viewer", false)
	id, rid := uuid.NewString(), uuid.NewString()
	if _, err := s.Store.Save(context.Background(), "integration", id, 0, model.Integration{ID: id, Kind: "oxidized", Enabled: true, URL: "https://upstream.invalid", Config: map[string]string{"gitea_repository_url": "https://git.example/ops/configs"}}, "admin"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Store.Save(context.Background(), "resource", rid, 0, model.Resource{ID: rid, Name: "Router"}, "admin"); err != nil {
		t.Fatal(err)
	}
	mux := s.Handler()
	call := func(who apiIdentity, path string, headers map[string]string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, s.Config.PublicURL+path, nil)
		if who.cookie != nil {
			r.AddCookie(who.cookie)
		}
		for key, value := range headers {
			r.Header.Set(key, value)
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	paths := []string{"/api/v1/integrations/" + id + "/configuration-history", "/api/v1/resources/" + rid + "/configuration-history"}
	for _, path := range paths {
		if got := call(apiIdentity{}, path, nil); got.Code != 401 {
			t.Fatalf("anonymous %d %s", got.Code, got.Body)
		}
		if got := call(viewer, path, nil); got.Code != 403 {
			t.Fatalf("viewer %d %s", got.Code, got.Body)
		}
		if got := call(admin, path, map[string]string{"Authorization": "Bearer machine-test"}); got.Code != 401 {
			t.Fatalf("machine %d %s", got.Code, got.Body)
		}
	}
	got := apiDecode[model.ConfigurationHistory](t, call(admin, paths[0], nil), 200)
	if got.SourceStatus != "unavailable" || !got.Stale || got.ObservedAt != nil || got.Nodes == nil || len(got.Nodes) != 0 {
		t.Fatal("fabricated evidence", got)
	}
	linked := apiDecode[[]model.ConfigurationHistory](t, call(admin, paths[1], nil), 200)
	if linked == nil || len(linked) != 0 {
		t.Fatal(linked)
	}
	if response := call(admin, "/api/v1/integrations/"+uuid.NewString()+"/configuration-history", nil); response.Code != 404 {
		t.Fatal(response.Code, response.Body)
	}
}

package server

import (
	"net/http"
	"testing"

	"pl/portal/internal/model"
)

// Exercise the shared production mux, rather than the subject-only test muxes.
func TestWorkspaceSettingsSharedRouterAndPersistence(t *testing.T) {
	s := apiFixture(t)
	admin := apiUser(t, s, "workspace-settings-admin", true)
	viewer := apiUser(t, s, "workspace-settings-viewer", false)
	initial := apiDecode[model.Settings](t, apiCall(s, admin, "GET", "/api/v1/settings", nil, nil), http.StatusOK)
	system := apiDecode[model.System](t, apiCall(s, admin, "POST", "/api/v1/systems", model.System{Name: "Общая интеграция", Profile: "rds", ResourceIDs: []string{}, Metrics: []model.SystemMetricBinding{}}, nil), http.StatusCreated)
	changed := apiDecode[model.Settings](t, apiCall(s, admin, "PUT", "/api/v1/settings-workspace/general", map[string]any{"revision": initial.Revision, "timezone": "UTC", "stale_after_seconds": 300}, nil), http.StatusOK)
	if changed.Timezone != "UTC" || changed.BoardTitle != initial.BoardTitle || changed.BoardEnabled != initial.BoardEnabled {
		t.Fatalf("settings group did not preserve publication: %#v", changed)
	}
	current := apiDecode[model.System](t, apiCall(s, admin, "GET", "/api/v1/systems/"+system.ID, nil, nil), http.StatusOK)
	if current.Name != system.Name || current.Revision != system.Revision {
		t.Fatalf("settings save changed system definition: %#v", current)
	}
	if w := apiCall(s, viewer, "GET", "/api/v1/systems", nil, nil); w.Code != http.StatusForbidden {
		t.Fatalf("workspace route lost admin boundary: %d", w.Code)
	}
	if w := apiCall(s, apiIdentity{}, "GET", "/api/v1/settings-workspace/history?kind=settings&group=general", nil, nil); w.Code != http.StatusUnauthorized {
		t.Fatalf("settings route lost anonymous boundary: %d", w.Code)
	}
	if w := apiCall(s, apiIdentity{}, "POST", "/api/v1/settings-workspace/probe", map[string]any{}, nil); w.Code != http.StatusUnauthorized {
		t.Fatalf("settings probe route missing or unauthenticated: %d", w.Code)
	}
}

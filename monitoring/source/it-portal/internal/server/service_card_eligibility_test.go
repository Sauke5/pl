package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"pl/portal/internal/model"
	"pl/portal/internal/store"
)

func TestServiceCardEligibilityTypeAndNavigation(t *testing.T) {
	for _, kind := range []string{"сервер", "виртуальная машина", "устройство", "сетевое устройство", "хранилище", "server", "virtual machine", "vm", "device", "network device", "storage", " Server "} {
		if isServiceCardResource(model.Resource{Type: kind, URL: "https://bmc.example"}, "https://portal.example") {
			t.Fatal("infrastructure accepted", kind)
		}
	}
	for _, url := range []string{"https://service.example/", "http://service.example/", "/reports/", "/#modules?instance=11111111-1111-4111-8111-111111111111&view=monitoring"} {
		if !isServiceCardResource(model.Resource{Type: "Приложение", URL: url}, "https://portal.example") {
			t.Fatal("web application rejected", url)
		}
	}
	for _, url := range []string{"", "javascript:alert(1)", "//other.example", "/api/admin", "https://user:password@example/", "https://example/?token=test", "/\\other.example"} {
		if isServiceCardResource(model.Resource{Type: "Приложение", URL: url}, "https://portal.example") {
			t.Fatal("invalid navigation accepted", url)
		}
	}

	id := "11111111-1111-4111-8111-111111111111"
	legacy := model.Resource{ID: "legacy-prometheus", Type: "Приложение", Source: "module", ManagedModuleID: id, URL: "/api/v1/modules/" + id + "/prometheus/"}
	want := "/#modules?instance=" + id + "&view=monitoring"
	if !isServiceCardResource(legacy, "https://portal.example") || serviceCardNavigationURL(legacy, "https://portal.example") != want {
		t.Fatal("existing managed Prometheus resource cannot be pinned")
	}
	if got := projectBoardResource(legacy, "unknown", true, "https://portal.example")["url"]; got != want {
		t.Fatal("published managed Prometheus did not resolve to Pl", got)
	}
	if _, exists := projectBoardResource(legacy, "unknown", false, "https://portal.example")["url"]; exists {
		t.Fatal("anonymous board exposed application navigation")
	}
	if legacy.URL != "/api/v1/modules/"+id+"/prometheus/" {
		t.Fatal("navigation projection mutated stored legacy resource")
	}
	for _, value := range []string{
		"/api/v1/modules/22222222-2222-4222-8222-222222222222/prometheus/",
		"/api/v1/modules/" + id + "/prometheus/api/v1/query",
		"/api/v1/modules/" + id + "/prometheus/?query=up",
		"https://portal.example/api/v1/modules/" + id + "/prometheus/",
		"http://127.0.0.1:9090/api/v1/modules/" + id + "/prometheus/",
	} {
		resource := legacy
		resource.URL = value
		// An external URL retains the existing catalog policy; it must never be
		// rewritten as an owned module route or gain an exception to /api denial.
		if serviceCardNavigationURL(resource, "https://portal.example") == want {
			t.Fatal("noncanonical URL gained managed navigation", value)
		}
		if strings.HasPrefix(value, "/api/") && isServiceCardResource(resource, "https://portal.example") {
			t.Fatal("arbitrary API path accepted", value)
		}
	}
	for _, source := range []string{"manual", "fixture", ""} {
		resource := legacy
		resource.Source = source
		if isServiceCardResource(resource, "https://portal.example") {
			t.Fatal("unowned API resource accepted", source)
		}
	}
	resource := legacy
	resource.ManagedModuleID = ""
	if isServiceCardResource(resource, "https://portal.example") {
		t.Fatal("API resource without managed owner accepted")
	}
}

func TestServiceCardSelectionsAPIPreserveLegacyAndRejectNewInfrastructure(t *testing.T) {
	s := apiFixture(t)
	admin := apiUser(t, s, "service-card-owner", true)
	app := apiResource(t, s, admin, "Service")
	infra := apiDecode[model.Resource](t, apiCall(s, admin, "POST", "/api/v1/resources", model.Resource{Name: "Host with BMC", Type: "server", URL: "https://bmc.example"}, nil), 201)
	other := apiDecode[model.Resource](t, apiCall(s, admin, "POST", "/api/v1/resources", model.Resource{Name: "Other host", Type: "vm", URL: "https://other-bmc.example"}, nil), 201)
	ctx := context.Background()
	// Favorites: legacy document endpoint is authoritative.
	prefs := apiDecode[model.Preferences](t, apiCall(s, admin, "GET", "/api/v1/preferences", nil, nil), 200)
	prefs.Favorites = []string{infra.ID}
	apiDecode[map[string]any](t, apiCall(s, admin, "PUT", "/api/v1/preferences", prefs, nil), 400)
	prefs.Favorites = []string{app.ID}
	prefs = apiDecode[model.Preferences](t, apiCall(s, admin, "PUT", "/api/v1/preferences", prefs, nil), 200)
	prefs.Favorites = []string{infra.ID, app.ID}
	raw, err := s.Store.Save(ctx, "preferences", "service-card-owner", prefs.Revision, prefs, "fixture")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, &prefs); err != nil {
		t.Fatal(err)
	}
	prefs.HiddenSections = []string{"reports"}
	prefs = apiDecode[model.Preferences](t, apiCall(s, admin, "PUT", "/api/v1/preferences", prefs, nil), 200)
	if !store.Contains(prefs.Favorites, infra.ID) {
		t.Fatal("legacy favorite removed")
	}
	prefs.Favorites = append(prefs.Favorites, other.ID)
	apiDecode[map[string]any](t, apiCall(s, admin, "PUT", "/api/v1/preferences", prefs, nil), 400)
	// Personal groups grandfather only within the same group UUID.
	groupID := uuid.NewString()
	groups := model.WorkspacePreferences{Groups: []model.FavoriteGroup{{ID: groupID, Name: "Services", ResourceIDs: []string{infra.ID}}}}
	apiDecode[map[string]any](t, workspaceCall(s, admin, "PUT", "/api/v1/workspace-preferences", groups), 400)
	groups.Groups[0].ResourceIDs = []string{app.ID}
	groups = apiDecode[model.WorkspacePreferences](t, workspaceCall(s, admin, "PUT", "/api/v1/workspace-preferences", groups), 200)
	groups.Groups[0].ResourceIDs = append(groups.Groups[0].ResourceIDs, infra.ID)
	raw, err = s.Store.Save(ctx, "workspace_preferences", "service-card-owner", groups.Revision, groups, "fixture")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, &groups); err != nil {
		t.Fatal(err)
	}
	groups.Groups[0].Name = "Renamed"
	groups = apiDecode[model.WorkspacePreferences](t, workspaceCall(s, admin, "PUT", "/api/v1/workspace-preferences", groups), 200)
	if !store.Contains(groups.Groups[0].ResourceIDs, infra.ID) {
		t.Fatal("legacy group choice removed")
	}
	groups.Groups = append(groups.Groups, model.FavoriteGroup{ID: uuid.NewString(), Name: "Copied", ResourceIDs: []string{infra.ID}})
	apiDecode[map[string]any](t, workspaceCall(s, admin, "PUT", "/api/v1/workspace-preferences", groups), 400)
	// Both settings mutation routes enforce the same publication policy.
	settings := apiDecode[model.Settings](t, apiCall(s, admin, "GET", "/api/v1/settings", nil, nil), 200)
	settings.BoardEnabled = true
	settings.BoardResourceIDs = []string{infra.ID}
	apiDecode[map[string]any](t, apiCall(s, admin, "PUT", "/api/v1/settings", settings, nil), 400)
	publication := func(ids []string, title string) *httptest.ResponseRecorder {
		return apiCall(s, admin, "PUT", "/api/v1/settings-workspace/publication", map[string]any{"revision": settings.Revision, "board_enabled": true, "board_title": title, "board_resource_ids": ids}, nil)
	}
	apiDecode[map[string]any](t, publication([]string{infra.ID}, "Rejected"), 400)
	settings.BoardResourceIDs = []string{app.ID}
	settings = apiDecode[model.Settings](t, apiCall(s, admin, "PUT", "/api/v1/settings", settings, nil), 200)
	settings = apiDecode[model.Settings](t, publication([]string{app.ID}, "Accepted"), 200)
	settings.BoardResourceIDs = append(settings.BoardResourceIDs, infra.ID)
	raw, err = s.Store.Save(ctx, "settings", "global", settings.Revision, settings, "fixture")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, &settings); err != nil {
		t.Fatal(err)
	}
	settings = apiDecode[model.Settings](t, publication(settings.BoardResourceIDs, "Renamed"), 200)
	if !store.Contains(settings.BoardResourceIDs, infra.ID) {
		t.Fatal("legacy publication removed")
	}
	settings.BoardTitle = "Legacy full-route edit"
	settings = apiDecode[model.Settings](t, apiCall(s, admin, "PUT", "/api/v1/settings", settings, nil), 200)
	settings.BoardResourceIDs = append(settings.BoardResourceIDs, other.ID)
	apiDecode[map[string]any](t, apiCall(s, admin, "PUT", "/api/v1/settings", settings, nil), 400)
	apiDecode[map[string]any](t, publication(settings.BoardResourceIDs, "Rejected"), 400)
	// Legacy publication stays persisted but infrastructure never enters the DTO.
	board := apiDecode[struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}](t, apiCall(s, admin, "GET", "/api/v1/board", nil, nil), 200)
	if len(board.Items) != 1 || board.Items[0].ID != app.ID {
		t.Fatal("infrastructure leaked through board", board)
	}
	// Systems retain infrastructure relations and metrics.
	integrationID := uuid.NewString()
	if _, err := s.Store.Save(ctx, "integration", integrationID, 0, model.Integration{ID: integrationID, Kind: "prometheus", Enabled: true, URL: "https://monitoring.example"}, "fixture"); err != nil {
		t.Fatal(err)
	}
	system := model.System{Name: "Infrastructure", Profile: "custom", ResourceIDs: []string{infra.ID}, Metrics: []model.SystemMetricBinding{{ID: uuid.NewString(), ResourceID: infra.ID, IntegrationID: integrationID, Metric: "target.up", Labels: map[string]string{"instance": "host"}}}}
	saved := apiDecode[model.System](t, workspaceCall(s, admin, http.MethodPost, "/api/v1/systems", system), 201)
	if len(saved.ResourceIDs) != 1 || saved.ResourceIDs[0] != infra.ID || len(saved.Metrics) != 1 {
		t.Fatal(saved)
	}
}

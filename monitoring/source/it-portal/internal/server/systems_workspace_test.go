package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"pl/portal/internal/providers"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"pl/portal/internal/model"
)

func workspaceCall(s *Server, who apiIdentity, method, path string, value any) *httptest.ResponseRecorder {
	var body bytes.Buffer
	if value != nil {
		_ = json.NewEncoder(&body).Encode(value)
	}
	r := httptest.NewRequest(method, s.Config.PublicURL+path, &body)
	r.Header.Set("Origin", s.Config.PublicURL)
	r.Header.Set("Content-Type", "application/json")
	if who.cookie != nil {
		r.AddCookie(who.cookie)
	}
	r.Header.Set("X-CSRF-Token", who.csrf)
	m := http.NewServeMux()
	s.registerWorkspaceRoutes(m)
	w := httptest.NewRecorder()
	m.ServeHTTP(w, r)
	return w
}

func TestWorkspaceSystemPersistenceIsolationAndRevision(t *testing.T) {
	s := apiFixture(t)
	alice := apiUser(t, s, "alice", true)
	bob := apiUser(t, s, "bob", true)
	viewer := apiUser(t, s, "employee", false)
	resource := apiResource(t, s, alice, "SQL")
	system := apiDecode[model.System](t, workspaceCall(s, alice, "POST", "/api/v1/systems", model.System{Name: "SQL", Profile: "sql", ResourceIDs: []string{resource.ID}, Metrics: []model.SystemMetricBinding{}}), 201)
	if system.ID == "" || system.Revision != 1 {
		t.Fatal(system)
	}
	apiDecode[[]model.System](t, workspaceCall(s, bob, "GET", "/api/v1/systems", nil), 200)
	for _, tc := range []struct {
		who  apiIdentity
		code int
	}{{viewer, 403}, {apiIdentity{}, 401}} {
		if got := workspaceCall(s, tc.who, "GET", "/api/v1/systems", nil); got.Code != tc.code {
			t.Fatal(got.Code)
		}
	}
	withoutCSRF := alice
	withoutCSRF.csrf = ""
	if got := workspaceCall(s, withoutCSRF, "POST", "/api/v1/systems", system); got.Code != 403 {
		t.Fatal("CSRF bypass", got.Code)
	}
	prefs := model.WorkspacePreferences{SystemIDs: []string{system.ID}, Groups: []model.FavoriteGroup{{ID: uuid.NewString(), Name: "Мои серверы", ResourceIDs: []string{resource.ID}}}}
	savedPrefs := workspaceCall(s, alice, "PUT", "/api/v1/workspace-preferences", prefs)
	apiDecode[model.WorkspacePreferences](t, savedPrefs, 200)
	var roundTrip map[string]any
	if err := json.Unmarshal(savedPrefs.Body.Bytes(), &roundTrip); err != nil {
		t.Fatal(err)
	}
	if _, leaked := roundTrip["id"]; leaked {
		t.Fatal("storage ID leaked into preferences contract")
	}
	apiDecode[model.WorkspacePreferences](t, workspaceCall(s, alice, "PUT", "/api/v1/workspace-preferences", roundTrip), 200)
	other := apiDecode[model.WorkspacePreferences](t, workspaceCall(s, bob, "GET", "/api/v1/workspace-preferences", nil), 200)
	if len(other.SystemIDs) != 0 || len(other.Groups) != 0 {
		t.Fatal("preferences crossed users", other)
	}
	if got := workspaceCall(s, alice, "PUT", "/api/v1/workspace-preferences", prefs); got.Code != 409 {
		t.Fatal("stale preference overwrote saved state", got.Code)
	}
	system.Description = "Changed by Bob"
	updated := apiDecode[model.System](t, workspaceCall(s, bob, "PUT", "/api/v1/systems/"+system.ID, system), 200)
	if updated.Revision != 2 {
		t.Fatal(updated)
	}
	if got := workspaceCall(s, alice, "PUT", "/api/v1/systems/"+system.ID, system); got.Code != 409 {
		t.Fatal("stale system overwrote definition", got.Code)
	}
	snapshot := apiDecode[systemWorkspaceSnapshot](t, workspaceCall(s, alice, "GET", "/api/v1/systems/"+system.ID+"/snapshot", nil), 200)
	if snapshot.State != "no_data" || len(snapshot.Resources) != 1 {
		t.Fatal(snapshot)
	}
	updated.Planned = true
	apiDecode[model.System](t, workspaceCall(s, alice, "PUT", "/api/v1/systems/"+system.ID, updated), 200)
	snapshot = apiDecode[systemWorkspaceSnapshot](t, workspaceCall(s, bob, "GET", "/api/v1/systems/"+system.ID+"/snapshot", nil), 200)
	if snapshot.State != "planned" {
		t.Fatal(snapshot)
	}
}

func TestWorkspaceInvalidDefinitions(t *testing.T) {
	for _, v := range []model.System{{Name: "", Profile: "sql"}, {Name: "x", Profile: "unknown"}, {Name: "x", Profile: "sql", ResourceIDs: []string{"a", "a"}}, {Name: "x", Profile: "sql", Metrics: []model.SystemMetricBinding{{ID: "m", Metric: "select arbitrary"}}}} {
		if validateWorkspaceSystem(v) {
			t.Fatal("accepted invalid system", v)
		}
	}
}

func TestMarketingClassificationUsesExplicitIdentity(t *testing.T) {
	policy := problemPresentation{ResourceIDs: []string{"marketing-resource"}, Targets: []marketingTarget{{IntegrationID: "source", Instance: "https://public.example/"}}}
	cases := []struct {
		p    model.Problem
		want bool
	}{
		{model.Problem{IntegrationID: "source", Labels: map[string]string{"instance": "https://public.example", "alertname": "WebsiteDown"}}, true},
		{model.Problem{IntegrationID: "source", Labels: map[string]string{"instance": "https://PUBLIC.EXAMPLE:443/"}}, true},
		{model.Problem{IntegrationID: "other", Labels: map[string]string{"instance": "https://public.example/"}}, false},
		{model.Problem{IntegrationID: "source", Labels: map[string]string{"instance": "https://internal.example/", "alertname": "WebsiteDown"}}, false},
		{model.Problem{ResourceIDs: []string{"marketing-resource"}}, true},
		{model.Problem{Labels: map[string]string{"instance": "https://public.example.evil/"}}, false},
	}
	for _, tc := range cases {
		if got := marketingProblem(tc.p, policy); got != tc.want {
			t.Fatal(tc.p, got)
		}
	}
}

func TestWorkspaceLayoutPreservesGeometryAndSupportsOptionalBlocks(t *testing.T) {
	s := apiFixture(t)
	who := apiUser(t, s, "layout-owner", true)
	id := "favorite-group_" + uuid.NewString()
	rows := 29
	value := dashboardLayoutState{Tiles: []dashboardTile{{ID: "favorites", Width: 8, HeightRows: &rows, Pinned: true}, {ID: id, Width: 4}}, Hidden: []string{"systems", "grafana"}}
	saved := apiDecode[dashboardLayoutState](t, apiCall(s, who, "PUT", "/api/v1/dashboard-layout?view=admin", value, nil), 200)
	if !saved.Tiles[0].Pinned || saved.Tiles[0].Width != 8 || *saved.Tiles[0].HeightRows != 29 || saved.Tiles[1].ID != id {
		t.Fatal(saved)
	}
	if validWorkspaceGroupTile("favorite-group_invalid") || !validDashboardID("admin", "systems") {
		t.Fatal("group validation")
	}
}

func TestWorkspaceCoverageDoesNotHideMissingBranchesOrFailedChecks(t *testing.T) {
	system := model.System{ResourceIDs: []string{"branch-a", "branch-b", "branch-c"}}
	failed := model.SystemMetricResult{ResourceID: "branch-a", State: "fresh", Unit: "state", Samples: []model.SystemMetricSample{{Value: 0}}}
	fresh := model.SystemMetricResult{ResourceID: "branch-a", State: "fresh", Unit: "seconds", Samples: []model.SystemMetricSample{{Value: 0.02}}}
	stale := model.SystemMetricResult{ResourceID: "branch-b", State: "stale"}
	for _, metrics := range [][]model.SystemMetricResult{{failed, fresh, stale}, {fresh, stale, failed}} {
		coverage := workspaceResourceCoverage(system, metrics, nil)
		if coverage[0].State != "attention" || coverage[1].State != "stale" || coverage[2].State != "unconfigured" {
			t.Fatal(coverage)
		}
	}
}

func TestProblemPresentationRoundTrip(t *testing.T) {
	s := apiFixture(t)
	who := apiUser(t, s, "policy-owner", true)
	saved := workspaceCall(s, who, "PUT", "/api/v1/problem-presentation", problemPresentation{Targets: []marketingTarget{{IntegrationID: "alerts", Instance: "https://public.example"}}})
	apiDecode[problemPresentation](t, saved, 200)
	var body map[string]any
	if err := json.Unmarshal(saved.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	apiDecode[problemPresentation](t, workspaceCall(s, who, "PUT", "/api/v1/problem-presentation", body), 200)
}

func TestWorkspaceCurrentMetricFaults(t *testing.T) {
	for _, metric := range []model.SystemMetricResult{
		{Metric: "proxy.path", State: "fresh", Unit: "state", Samples: []model.SystemMetricSample{{Value: 0}}},
		{Metric: "backup.result", State: "fresh", Unit: "enum", Samples: []model.SystemMetricSample{{Value: 1, Labels: map[string]string{"result": "Failed"}}}},
	} {
		if !workspaceMetricRequiresAttention(metric) {
			t.Fatal("fault concealed", metric)
		}
		metric.State = "stale"
		if workspaceMetricRequiresAttention(metric) {
			t.Fatal("stale telemetry treated as current fault")
		}
	}
}

func TestWorkspaceInitialDataContracts(t *testing.T) {
	raw, err := os.ReadFile("testdata/workspace/initial-systems.json")
	if err != nil {
		t.Fatal(err)
	}
	var systems []model.System
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&systems); err != nil {
		t.Fatal(err)
	}
	for _, system := range systems {
		if system.ID != "" || system.Revision != 0 || !validateWorkspaceSystem(system) {
			t.Fatal("invalid initial definition", system.Name)
		}
		for _, binding := range system.Metrics {
			if err := providers.ValidateSystemMetric(binding); err != nil {
				t.Fatal(system.Name, binding.Metric, err)
			}
		}
	}
	raw, err = os.ReadFile("testdata/workspace/marketing-presentation.json")
	if err != nil {
		t.Fatal(err)
	}
	var policy problemPresentation
	decoder = json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&policy); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, target := range policy.Targets {
		normalized := canonicalProblemTarget(target.Instance)
		if normalized == "" || target.IntegrationID == "" || seen[normalized] {
			t.Fatal("invalid marketing target", target)
		}
		seen[normalized] = true
	}
	if marketingProblem(model.Problem{IntegrationID: policy.Targets[0].IntegrationID, Labels: map[string]string{"instance": "https://website.example.test/", "alertname": "WebsiteDown"}}, policy) {
		t.Fatal("internal app classified as marketing")
	}
}

func TestWorkspaceProblemsPreserveVisibilityAndFreshness(t *testing.T) {
	s := apiFixture(t)
	who := apiUser(t, s, "operator", true)
	resource := apiResource(t, s, who, "InternalApp")
	now := time.Now().UTC()
	source := model.Integration{ID: "alerts", Kind: "alertmanager", Enabled: true, Status: "connected", LastSuccess: &now}
	if _, err := s.Store.Save(context.Background(), "integration", source.ID, 0, source, "fixture"); err != nil {
		t.Fatal(err)
	}
	p := model.Problem{ID: "test-problem", IntegrationID: source.ID, Status: "firing", StartedAt: now.Add(-time.Hour), LastSeen: now, Labels: map[string]string{"portal_resource_id": resource.ID}}
	if _, err := s.Store.Save(context.Background(), "problem", p.ID, 0, p, "fixture"); err != nil {
		t.Fatal(err)
	}
	actor := model.User{ID: "operator", Name: "Operator"}
	if err := s.Store.SetProblemVisibility(context.Background(), p.ID, true, actor, &p.StartedAt); err != nil {
		t.Fatal(err)
	}
	got := apiDecode[[]presentedProblem](t, workspaceCall(s, who, "GET", "/api/v1/workspace-problems", nil), 200)
	if len(got) != 1 || !got[0].Hidden || got[0].Stale || got[0].ResourceID != resource.ID {
		t.Fatal(got)
	}
	p.LastSeen = now.Add(-24 * time.Hour)
	if _, err := s.Store.Save(context.Background(), "problem", p.ID, 1, p, "fixture"); err != nil {
		t.Fatal(err)
	}
	got = apiDecode[[]presentedProblem](t, workspaceCall(s, who, "GET", "/api/v1/workspace-problems", nil), 200)
	if !got[0].Stale || !got[0].Hidden {
		t.Fatal(got)
	}
}

func TestWorkspacePartialMetricsAreNotReportedUpdated(t *testing.T) {
	for _, state := range []string{"error", "stale", "no_data", "unsupported", "unconfigured"} {
		for _, states := range [][]string{{"fresh", state}, {state, "fresh"}} {
			metrics := []model.SystemMetricResult{{State: states[0]}, {State: states[1]}}
			if got := workspaceMetricState(metrics); got != "incomplete" {
				t.Fatalf("%v: %s", states, got)
			}
		}
		if got := workspaceMetricState([]model.SystemMetricResult{{State: state}}); got != "no_data" {
			t.Fatalf("%s: %s", state, got)
		}
	}
	if workspaceMetricState(nil) != "no_data" || workspaceMetricState([]model.SystemMetricResult{{State: "fresh"}, {State: "fresh"}}) != "observed" {
		t.Fatal("freshness aggregate changed")
	}
}

func TestWorkspaceSystemIncompleteBindingsCanBeSavedAndPreviewed(t *testing.T) {
	s := apiFixture(t)
	who := apiUser(t, s, "systems-drafts", true)
	source := model.Integration{ID: "workspace-source", Name: "Source", Kind: "prometheus", Enabled: true}
	if _, err := s.Store.Save(context.Background(), "integration", source.ID, 0, source, "test"); err != nil {
		t.Fatal(err)
	}
	for _, labels := range []map[string]string{nil, {"instance": ""}} {
		draft := model.System{Name: "Моя инфраструктура", Profile: "custom", Metrics: []model.SystemMetricBinding{{ID: "memory", Metric: "linux.memory", IntegrationID: source.ID, Labels: labels}}}
		saved := apiDecode[model.System](t, workspaceCall(s, who, "POST", "/api/v1/systems", draft), 201)
		preview := apiDecode[[]model.SystemMetricResult](t, workspaceCall(s, who, "POST", "/api/v1/systems/preview", saved), 200)
		if len(preview) != 1 || preview[0].State != "unconfigured" || len(preview[0].Samples) != 0 {
			t.Fatal("incomplete binding became an error or fake data", preview)
		}
		loaded := apiDecode[model.System](t, workspaceCall(s, who, "GET", "/api/v1/systems/"+saved.ID, nil), 200)
		if loaded.Metrics[0].IntegrationID != source.ID || loaded.Metrics[0].Labels == nil {
			t.Fatal("incomplete binding lost selected source", loaded)
		}
	}
	resource := apiResource(t, s, who, "FreeResource")
	apiDecode[model.System](t, workspaceCall(s, who, "POST", "/api/v1/systems", model.System{Name: "Только ресурсы", Profile: "custom", ResourceIDs: []string{resource.ID}}), 201)
}

func TestWorkspaceSystemValidationSupportsUnicodeAndExplainsErrors(t *testing.T) {
	valid := model.System{Name: strings.Repeat("С", 160), Description: strings.Repeat("Д", 4000), Profile: "custom", Metrics: []model.SystemMetricBinding{{ID: "cpu", Metric: "linux.cpu", Title: strings.Repeat("П", 160)}}}
	if message := workspaceSystemValidationMessage(valid); message != "" {
		t.Fatal("UI-compatible Unicode text rejected", message)
	}
	for _, tc := range []struct {
		system  model.System
		message string
	}{
		{model.System{Profile: "custom"}, "Укажите название"},
		{model.System{Name: "S", Profile: "custom", Metrics: []model.SystemMetricBinding{{ID: "bad", Metric: "linux.cpu", Labels: map[string]string{"__name__": "up"}}}}, "Показатель №1"},
		{model.System{Name: "S", Profile: "custom", Metrics: []model.SystemMetricBinding{{ID: "bad", Metric: "linux.cpu", ResourceID: "outside"}}}, "привязанный ресурс"},
	} {
		if got := workspaceSystemValidationMessage(tc.system); !strings.Contains(got, tc.message) {
			t.Fatal("validation lacks actionable detail", got, tc.message)
		}
	}
}

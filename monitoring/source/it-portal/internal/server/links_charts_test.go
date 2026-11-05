package server

import (
	"context"
	"pl/portal/internal/model"
	"testing"
)

func TestLinksAndChartsAuthorizationValidationAndPersonalStorage(t *testing.T) {
	s := apiFixture(t)
	ctx := context.Background()
	a := apiUser(t, s, "ad:charts-a", true)
	b := apiUser(t, s, "ad:charts-b", true)
	viewer := apiUser(t, s, "ad:charts-viewer", false)
	for _, entry := range []struct {
		kind, id string
		value    any
	}{
		{"problem", "p", model.Problem{ID: "p", IntegrationID: "am", Labels: map[string]string{"instance": "host:9100"}}},
		{"resource", "r", model.Resource{ID: "r", Name: "Host", URL: "https://host", Lifecycle: "active"}},
		{"integration", "graf", model.Integration{ID: "graf", Kind: "grafana", Enabled: true}},
	} {
		if _, e := s.Store.Save(ctx, entry.kind, entry.id, 0, entry.value, "test"); e != nil {
			t.Fatal(e)
		}
	}
	for _, path := range []string{"/api/v1/problems/p/links", "/api/v1/chart-settings"} {
		for _, method := range []string{"GET", "PUT"} {
			if w := apiCall(s, viewer, method, path, map[string]any{}, nil); w.Code != 403 {
				t.Fatal(path, w.Code)
			}
			if w := apiCall(s, apiIdentity{}, method, path, map[string]any{}, nil); w.Code != 401 {
				t.Fatal(path, w.Code)
			}
		}
		if w := apiCall(s, a, "PUT", path, map[string]any{}, map[string]string{"X-CSRF-Token": ""}); w.Code != 403 {
			t.Fatal(path, w.Code)
		}
	}
	path := "/api/v1/problems/p/links"
	links := apiDecode[model.ProblemLinks](t, apiCall(s, a, "GET", path, nil, nil), 200)
	body := model.ProblemLinkUpdate{Revision: links.Revision, Mode: "manual", Scope: "target", Label: "instance", Value: "not-the-target", ResourceIDs: []string{"r"}}
	if w := apiCall(s, a, "PUT", path, body, nil); w.Code != 400 {
		t.Fatal(w.Code)
	}
	body.Value = "host:9100"
	links = apiDecode[model.ProblemLinks](t, apiCall(s, a, "PUT", path, body, nil), 200)
	if links.Rule == nil || links.Revision != 1 || len(links.ResourceIDs) != 1 {
		t.Fatal(links)
	}
	if w := apiCall(s, b, "PUT", path, body, nil); w.Code != 409 {
		t.Fatal("stale overwrite", w.Code)
	}
	chartsPath := "/api/v1/chart-settings"
	initial := apiDecode[model.ChartSettings](t, apiCall(s, a, "GET", chartsPath, nil, nil), 200)
	if initial.Revision != 0 || initial.Charts == nil || len(initial.Charts) != 0 {
		t.Fatal(initial)
	}
	selection := model.ChartSettings{Charts: []model.ChartSelection{{ID: "one", IntegrationID: "graf", DashboardUID: "infra", PanelID: 1, Range: "6h"}}}
	saved := apiDecode[model.ChartSettings](t, apiCall(s, a, "PUT", chartsPath, selection, nil), 200)
	if saved.Revision != 1 || len(saved.Charts) != 1 {
		t.Fatal(saved)
	}
	other := apiDecode[model.ChartSettings](t, apiCall(s, b, "GET", chartsPath+"?user_id=ad:charts-a", nil, nil), 200)
	if len(other.Charts) != 0 {
		t.Fatal("personal chart selection leaked")
	}
	if w := apiCall(s, a, "PUT", chartsPath, selection, nil); w.Code != 409 {
		t.Fatal("stale charts write", w.Code)
	}
	for _, bad := range []any{map[string]any{}, map[string]any{"revision": 1, "charts": nil}, map[string]any{"revision": 1, "charts": []any{}, "user_id": "other"}} {
		if w := apiCall(s, a, "PUT", chartsPath, bad, nil); w.Code != 400 {
			t.Fatal(w.Code)
		}
	}
}

func TestPersonalSectionOrderValidatesAndPersists(t *testing.T) {
	s := apiFixture(t)
	a := apiUser(t, s, "order-a", true)
	b := apiUser(t, s, "order-b", true)
	path := "/api/v1/preferences"
	saved := apiDecode[model.Preferences](t, apiCall(s, a, "PUT", path, model.Preferences{SectionOrder: []string{"directions", "grafana", "wayline", "problems"}}, nil), 200)
	if len(saved.SectionOrder) != 4 || saved.SectionOrder[0] != "directions" {
		t.Fatal(saved)
	}
	other := apiDecode[model.Preferences](t, apiCall(s, b, "GET", path, nil, nil), 200)
	if len(other.SectionOrder) != 0 {
		t.Fatal("personal order leaked")
	}
	for _, order := range [][]string{{"directions", "directions"}, {"arbitrary-section"}} {
		saved.SectionOrder = order
		if w := apiCall(s, a, "PUT", path, saved, nil); w.Code != 400 {
			t.Fatal(w.Code)
		}
	}
}

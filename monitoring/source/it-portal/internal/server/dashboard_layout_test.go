package server

import "testing"

func TestDashboardLayoutIDs(t *testing.T) {
	for _, id := range []string{"favorites", "problems", "directions", "reports", "events", "tools", "integrations", "wayline", "grafana"} {
		if !validDashboardID("admin", id) {
			t.Fatal(id)
		}
	}
	for _, id := range []string{"../resource", ""} {
		if validDashboardID("admin", id) || validDashboardID("employee", id) {
			t.Fatal(id)
		}
	}
	if validDashboardID("admin", "unknown") {
		t.Fatal("unknown admin section")
	}
}

func TestDashboardLayoutPersonalStorageAndRoleBoundary(t *testing.T) {
	shortHeight, longHeight := 4, 101
	manualHeight := 16
	s := apiFixture(t)
	a := apiUser(t, s, "layout-a", true)
	b := apiUser(t, s, "layout-b", false)
	path := "/api/v1/dashboard-layout?view=employee"
	if w := apiCall(s, apiIdentity{}, "GET", path, nil, nil); w.Code != 401 {
		t.Fatal(w.Code)
	}
	if w := apiCall(s, b, "GET", "/api/v1/dashboard-layout?view=admin", nil, nil); w.Code != 403 {
		t.Fatal(w.Code)
	}
	if w := apiCall(s, b, "PUT", "/api/v1/dashboard-layout?view=admin", dashboardLayoutState{}, nil); w.Code != 403 {
		t.Fatal(w.Code)
	}
	if w := apiCall(s, b, "PUT", path, dashboardLayoutState{}, map[string]string{"X-CSRF-Token": ""}); w.Code != 403 {
		t.Fatal("missing CSRF", w.Code)
	}
	initial := apiDecode[dashboardLayoutState](t, apiCall(s, b, "GET", path, nil, nil), 200)
	if initial.Revision != 0 {
		t.Fatal(initial)
	}
	for _, bad := range []dashboardLayoutState{
		{Tiles: []dashboardTile{{ID: "one", Width: 9, Height: 1}}},
		{Tiles: []dashboardTile{{ID: "one", Width: 4, Height: 13}}},
		{Tiles: []dashboardTile{{ID: "one", Width: 4, HeightRows: &shortHeight}}},
		{Tiles: []dashboardTile{{ID: "one", Width: 4, HeightRows: &longHeight}}},
		{Tiles: []dashboardTile{{ID: "one", Width: 1, Height: 1}, {ID: "one", Width: 1, Height: 1}}},
		{Hidden: []string{"../other"}},
	} {
		if w := apiCall(s, b, "PUT", path, bad, nil); w.Code != 400 {
			t.Fatal(w.Code)
		}
	}
	if w := apiCall(s, a, "PUT", "/api/v1/dashboard-layout?view=admin", dashboardLayoutState{Hidden: []string{"unknown-admin-block"}}, nil); w.Code != 400 {
		t.Fatal("unknown block accepted", w.Code)
	}
	layout := dashboardLayoutState{Tiles: []dashboardTile{{ID: "published", Width: 4, Height: 0, HeightRows: &manualHeight, Pinned: true}}, Hidden: []string{"other"}}
	saved := apiDecode[dashboardLayoutState](t, apiCall(s, b, "PUT", path, layout, nil), 200)
	if saved.Revision != 1 || !saved.Tiles[0].Pinned || saved.Tiles[0].HeightRows == nil || *saved.Tiles[0].HeightRows != manualHeight {
		t.Fatal(saved)
	}
	if w := apiCall(s, b, "PUT", path, layout, nil); w.Code != 409 {
		t.Fatal(w.Code)
	}
	other := apiDecode[dashboardLayoutState](t, apiCall(s, a, "GET", path, nil, nil), 200)
	if len(other.Tiles) != 0 {
		t.Fatal("employee layout leaked across users")
	}
	admin := apiDecode[dashboardLayoutState](t, apiCall(s, a, "GET", "/api/v1/dashboard-layout?view=admin", nil, nil), 200)
	if len(admin.Tiles) != 0 {
		t.Fatal("employee layout leaked to admin view")
	}
}

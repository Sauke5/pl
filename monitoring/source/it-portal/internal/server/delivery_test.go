package server

import (
	"context"
	"encoding/json"
	"pl/portal/internal/modules"
	"reflect"
	"strings"
	"testing"
)

type deliveryControllerFixture struct {
	calls         int
	lastAction    string
	lastOperation *modules.DeliveryUpgrade
	notes         *modules.DeliveryReleaseNotes
}

func (c *deliveryControllerFixture) Apply(context.Context, modules.Operation) (modules.Observation, error) {
	return modules.Observation{}, nil
}
func (c *deliveryControllerFixture) Delivery(_ context.Context, action string, op *modules.DeliveryUpgrade) (modules.DeliveryStatus, error) {
	c.calls++
	c.lastAction = action
	if op != nil {
		value := *op
		c.lastOperation = &value
	}
	return modules.DeliveryStatus{CoreAPI: 1, CurrentVersion: "0.3.0", LatestVersion: "0.3.1", UpdateAvailable: true, Modules: []modules.DeliveryModule{{ModuleID: "forms", Version: "1.0.0"}, {ModuleID: "doska", Version: "2.46.2", ArtifactSHA256: strings.Repeat("a", 64)}}, ReleaseNotes: c.notes}, nil
}

func TestDeliveryForwardsOptionalReleaseNotesAndPreservesLegacyStatus(t *testing.T) {
	s, admin := localUsersFixture(t)
	s.Config.PortableRelease = true
	notes := &modules.DeliveryReleaseNotes{
		Version: "0.3.1", Title: "Новая версия PL", Summary: "Описание доступно до обновления.",
		Sections: []modules.DeliveryReleaseSection{
			{Kind: modules.DeliveryReleaseNew, Items: []modules.DeliveryReleaseItem{{Title: "Описание обновления", Description: "Новые возможности показаны в карточке."}}},
			{Kind: modules.DeliveryReleaseFixed, Items: []modules.DeliveryReleaseItem{{Title: "Проверка состояния", Description: "Сохраняются данные текущей установки."}}},
		},
	}
	controller := &deliveryControllerFixture{}
	s.Modules = modules.New(s.Store, controller)
	for _, withNotes := range []bool{false, true} {
		if withNotes {
			controller.notes = notes
		}
		for _, route := range []struct{ method, path string }{{"GET", "/api/v1/delivery"}, {"POST", "/api/v1/delivery/check"}} {
			var payload any
			if route.method == "POST" {
				payload = map[string]any{}
			}
			response := apiCall(s, admin, route.method, route.path, payload, nil)
			status := apiDecode[modules.DeliveryStatus](t, response, 200)
			if status.CurrentVersion != "0.3.0" || status.LatestVersion != "0.3.1" || !status.UpdateAvailable || len(status.Modules) != 2 {
				t.Fatalf("existing status fields changed: %#v", status)
			}
			var raw map[string]json.RawMessage
			if err := json.Unmarshal(response.Body.Bytes(), &raw); err != nil {
				t.Fatal(err)
			}
			if withNotes {
				if !reflect.DeepEqual(status.ReleaseNotes, notes) || len(raw["release_notes"]) == 0 {
					t.Fatal("HTTP response lost typed release_notes metadata")
				}
			} else if status.ReleaseNotes != nil || raw["release_notes"] != nil {
				t.Fatal("legacy status unexpectedly contains release_notes")
			}
		}
	}
}
func TestDeliveryRequiresCurrentAdminBrowserSessionAndFiniteInput(t *testing.T) {
	s, admin := localUsersFixture(t)
	s.Config.PortableRelease = true
	controller := &deliveryControllerFixture{}
	s.Modules = modules.New(s.Store, controller)
	viewer := apiUser(t, s, "delivery-viewer", false)
	for _, route := range []struct{ method, path string }{
		{"GET", "/api/v1/delivery"}, {"POST", "/api/v1/delivery/check"}, {"POST", "/api/v1/delivery/upgrade"}, {"POST", "/api/v1/delivery/module-upgrade"},
	} {
		for _, test := range []struct {
			who    apiIdentity
			status int
		}{{viewer, 403}, {apiIdentity{}, 401}} {
			if got := apiCall(s, test.who, route.method, route.path, map[string]any{}, nil); got.Code != test.status {
				t.Fatalf("%s %s: %d", route.method, route.path, got.Code)
			}
		}
		if got := apiCall(s, admin, route.method, route.path, map[string]any{}, map[string]string{"Authorization": "Bearer fixture"}); got.Code != 403 {
			t.Fatal("machine delivery grant")
		}
	}
	if controller.calls != 0 {
		t.Fatal("unauthorized controller execution")
	}
	if got := apiCall(s, admin, "POST", "/api/v1/delivery/check", map[string]any{}, map[string]string{"X-CSRF-Token": "forged"}); got.Code != 403 {
		t.Fatal("csrf grant")
	}
	for _, body := range []map[string]any{
		{"version": "0.3.1", "operation_id": "../x"},
		{"version": "latest", "operation_id": "727b18f8-99da-410f-b94f-e677f2967731"},
		{"version": "0.3.1", "operation_id": "727b18f8-99da-410f-b94f-e677f2967731", "url": "https://other.test/a"},
	} {
		if got := apiCall(s, admin, "POST", "/api/v1/delivery/upgrade", body, nil); got.Code != 400 {
			t.Fatal("unbounded upgrade request", got.Code)
		}
	}
	if controller.calls != 0 {
		t.Fatal("invalid controller execution")
	}
	if got := apiCall(s, admin, "POST", "/api/v1/delivery/check", map[string]any{}, nil); got.Code != 200 {
		t.Fatal(got.Code, got.Body.String())
	}
	if got := apiCall(s, admin, "POST", "/api/v1/delivery/upgrade", map[string]any{"version": "0.3.1", "operation_id": "727b18f8-99da-410f-b94f-e677f2967731"}, nil); got.Code != 200 {
		t.Fatal(got.Code, got.Body.String())
	}
}

func TestDeliveryModuleUpgradeRequiresSelectedArtifactAndAdmin(t *testing.T) {
	s, admin := localUsersFixture(t)
	s.Config.PortableRelease = true
	controller := &deliveryControllerFixture{}
	s.Modules = modules.New(s.Store, controller)
	valid := map[string]any{"operation_id": "727b18f8-99da-410f-b94f-e677f2967731", "module_id": "doska", "artifact_sha256": strings.Repeat("a", 64)}
	for _, change := range []map[string]any{
		{"module_id": "mailcow"}, {"module_id": "../doska"}, {"artifact_sha256": "latest"},
		{"artifact_sha256": strings.Repeat("A", 64)}, {"operation_id": "../operation"},
		{"url": "https://other.test/module.tar.gz"}, {"version": "2.46.2"},
	} {
		body := map[string]any{}
		for key, value := range valid {
			body[key] = value
		}
		for key, value := range change {
			body[key] = value
		}
		if got := apiCall(s, admin, "POST", "/api/v1/delivery/module-upgrade", body, nil); got.Code != 400 {
			t.Fatalf("invalid module request reached controller: %d %s", got.Code, got.Body.String())
		}
	}
	if controller.calls != 0 {
		t.Fatal("invalid module request executed")
	}
	if got := apiCall(s, admin, "POST", "/api/v1/delivery/module-upgrade", valid, map[string]string{"X-CSRF-Token": "forged"}); got.Code != 403 {
		t.Fatal("module update accepted forged CSRF")
	}
	if got := apiCall(s, admin, "POST", "/api/v1/delivery/module-upgrade", valid, nil); got.Code != 200 {
		t.Fatal(got.Code, got.Body.String())
	}
	if controller.calls != 2 || controller.lastAction != "module-upgrade" || controller.lastOperation.ModuleID != "doska" || controller.lastOperation.ArtifactSHA256 != strings.Repeat("a", 64) || controller.lastOperation.Version != "" {
		t.Fatal("selected module artifact changed in the API projection")
	}
}
func TestOnDemandCatalogUsesTrustedAvailableVersions(t *testing.T) {
	s, admin := localUsersFixture(t)
	s.Config.PortableRelease = true
	s.Config.OnDemandModules = true
	s.Config.ModuleVersions = map[string]string{"grafana": "99.0.0"}
	s.Modules = modules.New(s.Store, &deliveryControllerFixture{})
	got := apiCall(s, admin, "GET", "/api/v1/modules/catalog", nil, nil)
	if got.Code != 200 {
		t.Fatal(got.Code, got.Body.String())
	}
	var catalog struct {
		Items []struct {
			ID, Version string
			Modes       []string
		}
	}
	if err := json.Unmarshal(got.Body.Bytes(), &catalog); err != nil {
		t.Fatal(err)
	}
	for _, item := range catalog.Items {
		if item.ID == "forms" && (item.Version != "1.0.0" || len(item.Modes) == 0) {
			t.Fatal("on-demand module hidden")
		}
		if item.ID == "grafana" && item.Version != "" {
			t.Fatal("stale bundled metadata overrides signed catalog")
		}
	}
}

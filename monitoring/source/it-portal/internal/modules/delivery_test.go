package modules

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

func TestDeliveryTransportBindsExactFiniteOperation(t *testing.T) {
	var client *HostController
	client = controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mac := hmac.New(sha256.New, client.key)
		mac.Write([]byte(r.Header.Get("X-Pl-Timestamp") + "\nPOST\n" + r.URL.Path + "\n"))
		mac.Write(body)
		if r.Method != "POST" || r.Header.Get("X-Pl-Signature") != hex.EncodeToString(mac.Sum(nil)) {
			t.Error("unsigned delivery operation")
		}
		if !strings.HasPrefix(r.URL.Path, "/v1/delivery/") {
			t.Error("unexpected path")
		}
		json.NewEncoder(w).Encode(DeliveryStatus{CoreAPI: 1, CurrentVersion: "0.3.0", LatestVersion: "0.3.1", UpdateAvailable: true, Modules: []DeliveryModule{{ModuleID: "prometheus", Version: "3.15.0"}}})
	})
	for _, action := range []string{"status", "check", "upgrade"} {
		var op *DeliveryUpgrade
		if action == "upgrade" {
			op = &DeliveryUpgrade{Version: "0.3.1", OperationID: "727b18f8-99da-410f-b94f-e677f2967731"}
		}
		got, err := client.Delivery(context.Background(), action, op)
		if err != nil || got.CurrentVersion != "0.3.0" || !got.UpdateAvailable {
			t.Fatalf("%s: %#v %v", action, got, err)
		}
		if got.ReleaseNotes != nil {
			t.Fatal("legacy status acquired release notes")
		}
		encoded, err := json.Marshal(got)
		if err != nil || strings.Contains(string(encoded), `"release_notes"`) {
			t.Fatal("absent notes changed the legacy JSON projection", err)
		}
	}
	for _, action := range []string{"shell", "/operations", "check?url=other"} {
		if _, err := client.Delivery(context.Background(), action, nil); err == nil {
			t.Fatal("arbitrary action accepted")
		}
	}
	if _, err := client.Delivery(context.Background(), "upgrade", &DeliveryUpgrade{Version: "0.3.1", OperationID: "../x"}); err == nil {
		t.Fatal("noncanonical operation accepted")
	}
}

func TestDeliveryAuthenticatedStatusProjectsNestedReleaseNotes(t *testing.T) {
	// Raw host JSON is independent of the Go struct tags: a tag or nesting
	// regression must not silently drop release metadata on its way to the web.
	wire := `{"core_api":1,"current_version":"0.3.3","latest_version":"0.4.0","update_available":true,"modules":[{"module_id":"forms","version":"1.0.0"}],"release_notes":{"version":"0.4.0","title":"Что нового в PL","summary":"Новые возможности и исправления.\nДанные установки сохраняются.","sections":[{"kind":"new","items":[{"title":"Описание обновления","description":"Изменения видны перед установкой."}]},{"kind":"improved","items":[{"title":"Управление установкой","description":"Параметры доступны в web PL."}]},{"kind":"fixed","items":[{"title":"Повторное подключение","description":"Статус перечитывается после восстановления связи."}]}],"private_host_debug":"must-not-reach-browser"}}`
	want := &DeliveryReleaseNotes{
		Version: "0.4.0", Title: "Что нового в PL", Summary: "Новые возможности и исправления.\nДанные установки сохраняются.",
		Sections: []DeliveryReleaseSection{
			{Kind: DeliveryReleaseNew, Items: []DeliveryReleaseItem{{Title: "Описание обновления", Description: "Изменения видны перед установкой."}}},
			{Kind: DeliveryReleaseImproved, Items: []DeliveryReleaseItem{{Title: "Управление установкой", Description: "Параметры доступны в web PL."}}},
			{Kind: DeliveryReleaseFixed, Items: []DeliveryReleaseItem{{Title: "Повторное подключение", Description: "Статус перечитывается после восстановления связи."}}},
		},
	}
	var client *HostController
	client = controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.Method != http.MethodPost || r.URL.Path != "/v1/delivery/check" || string(body) != "{}" || r.Header.Get("X-Pl-Timestamp") == "" {
			t.Error("release metadata request escaped the finite status protocol")
		}
		mac := hmac.New(sha256.New, client.key)
		mac.Write([]byte(r.Header.Get("X-Pl-Timestamp") + "\nPOST\n/v1/delivery/check\n"))
		mac.Write(body)
		if r.Header.Get("X-Pl-Signature") != hex.EncodeToString(mac.Sum(nil)) {
			t.Error("release metadata request signature does not bind timestamp/method/path/body")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, wire)
	})
	got, err := client.Delivery(context.Background(), "check", nil)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got.ReleaseNotes, want) || got.LatestVersion != want.Version || !got.UpdateAvailable || len(got.Modules) != 1 {
		t.Fatalf("nested release notes or existing status fields were lost: %#v", got)
	}
	encoded, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var browser map[string]json.RawMessage
	if err = json.Unmarshal(encoded, &browser); err != nil || len(browser["release_notes"]) == 0 {
		t.Fatal("release_notes snake_case field missing from browser projection", err)
	}
	if strings.Contains(string(encoded), "private_host_debug") || strings.Contains(string(encoded), "must-not-reach-browser") {
		t.Fatal("typed projection forwarded an unknown host-only metadata field")
	}
}
func TestDeliveryTransportRejectsUnconfirmedOrOversizedResponse(t *testing.T) {
	for _, scenario := range []string{"error", "protocol", "oversized", "invalid"} {
		t.Run(scenario, func(t *testing.T) {
			client := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
				switch scenario {
				case "error":
					w.WriteHeader(400)
					io.WriteString(w, `{"error":"private-host-details"}`)
				case "protocol":
					io.WriteString(w, `{"core_api":2}`)
				case "oversized":
					io.WriteString(w, strings.Repeat(" ", 65537))
				default:
					io.WriteString(w, `{`)
				}
			})
			_, err := client.Delivery(context.Background(), "status", nil)
			if err == nil || strings.Contains(err.Error(), "private-host-details") {
				t.Fatal("invalid response accepted or leaked")
			}
		})
	}
}

func TestDeliveryModuleUpdateSignsExactArtifactAndProjectsKind(t *testing.T) {
	var client *HostController
	calls := 0
	selected := strings.Repeat("b", 64)
	client = controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		body, _ := io.ReadAll(r.Body)
		mac := hmac.New(sha256.New, client.key)
		mac.Write([]byte(r.Header.Get("X-Pl-Timestamp") + "\nPOST\n/v1/delivery/module-upgrade\n"))
		mac.Write(body)
		var input map[string]string
		if json.Unmarshal(body, &input) != nil || len(input) != 3 || input["artifact_sha256"] != selected || input["module_id"] != "doska" || r.URL.Path != "/v1/delivery/module-upgrade" || r.Header.Get("X-Pl-Signature") != hex.EncodeToString(mac.Sum(nil)) {
			t.Fatal("module update did not bind its finite target and artifact")
		}
		io.WriteString(w, `{"core_api":1,"current_version":"0.4.5","modules":[{"module_id":"doska","version":"2.46.2","installed":true,"installed_version":"2.46.2","update_available":true,"upgrade_supported":true,"artifact_sha256":"`+selected+`"}],"operation":{"kind":"module_upgrade","module_id":"doska","operation_id":"727b18f8-99da-410f-b94f-e677f2967731","version":"0.4.5","phase":"queued"}}`)
	})
	op := &DeliveryUpgrade{ModuleID: "doska", ArtifactSHA256: selected, OperationID: "727b18f8-99da-410f-b94f-e677f2967731"}
	got, err := client.Delivery(context.Background(), "module-upgrade", op)
	if err != nil || got.Operation == nil || got.Operation.Kind != "module_upgrade" || got.Operation.ModuleID != "doska" || len(got.Modules) != 1 || !got.Modules[0].UpgradeSupported || got.Modules[0].ArtifactSHA256 != selected {
		t.Fatal("module update projection lost target or compatibility", err)
	}
	for _, invalid := range []DeliveryUpgrade{
		{ModuleID: "mailcow", ArtifactSHA256: selected, OperationID: op.OperationID},
		{ModuleID: "doska", ArtifactSHA256: strings.Repeat("B", 64), OperationID: op.OperationID},
		{ModuleID: "doska", ArtifactSHA256: selected, OperationID: op.OperationID, Version: "2.46.2"},
	} {
		if _, err := client.Delivery(context.Background(), "module-upgrade", &invalid); err == nil {
			t.Fatal("invalid artifact accepted")
		}
	}
	if calls != 1 {
		t.Fatal("invalid module update reached the transport")
	}
}

package modules

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
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

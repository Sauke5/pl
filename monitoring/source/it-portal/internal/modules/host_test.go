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
	"time"
)

func TestHostDiagnosticsAuthenticatedFiniteAndRedacted(t *testing.T) {
	payload := map[string]any{"schema": 1, "installation": "pl-0123456789ab", "hostname": "lab", "kernel": "test", "cpus": 6, "load_average": []float64{0.1, 0.2, 0.3}, "uptime_seconds": 10, "observed_at": time.Now().UTC(), "memory": map[string]uint64{"total_bytes": 1000, "available_bytes": 500}, "storage": map[string]uint64{"total_bytes": 2000, "used_bytes": 1000, "free_bytes": 1000}}
	var client *HostController
	client = controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		mac := hmac.New(sha256.New, client.key)
		mac.Write([]byte(r.Header.Get("X-Pl-Timestamp") + "\nPOST\n/v1/host/status\n"))
		mac.Write(raw)
		if r.Header.Get("X-Pl-Signature") != hex.EncodeToString(mac.Sum(nil)) {
			t.Error("host status signature is not bound to request")
		}
		if r.Method != "POST" || r.URL.Path != "/v1/host/status" || string(raw) != "{}" || r.Header.Get("X-Pl-Signature") == "" {
			t.Error("unbounded or unauthenticated host diagnostic")
		}
		if _, err := hex.DecodeString(r.Header.Get("X-Pl-Signature")); err != nil {
			t.Error("invalid signature encoding")
		}
		json.NewEncoder(w).Encode(payload)
	})
	status, err := client.HostStatus(context.Background())
	if err != nil || status.CPUs != 6 || status.Memory.AvailableBytes != 500 {
		t.Fatal("host diagnostic failed", err)
	}
	for _, scenario := range []string{"backend-error", "invalid-memory", "stale"} {
		t.Run(scenario, func(t *testing.T) {
			testClient := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
				if scenario == "backend-error" {
					w.WriteHeader(400)
					io.WriteString(w, `{"error":"fixture-private-host-details"}`)
					return
				}
				body := map[string]any{}
				for key, value := range payload {
					body[key] = value
				}
				if scenario == "invalid-memory" {
					body["memory"] = map[string]uint64{"total_bytes": 1, "available_bytes": 2}
				} else {
					body["observed_at"] = time.Now().Add(-time.Minute)
				}
				json.NewEncoder(w).Encode(body)
			})
			_, err := testClient.HostStatus(context.Background())
			if err == nil || strings.Contains(err.Error(), "fixture-private-host-details") {
				t.Fatal("invalid host status accepted or leaked")
			}
		})
	}
}

package server

import (
	"fmt"
	"pl/portal/internal/model"
	"testing"
)

func TestAPIIperfEnqueueParameters(t *testing.T) {
	s := apiFixture(t)
	admin := apiUser(t, s, "iperf-operator", true)
	for i, duration := range []int{5, 10, 15} {
		request := model.Job{Kind: "check", IdempotencyKey: fmt.Sprintf("iperf-enqueue-%d", i), Parameters: map[string]any{"kind": "iperf", "target": "branch.example:5201", "direction": "download", "duration_seconds": duration}}
		saved := apiDecode[model.Job](t, apiCall(s, admin, "POST", "/api/v1/jobs", request, nil), 202)
		loaded := apiDecode[model.Job](t, apiCall(s, admin, "GET", "/api/v1/jobs/"+saved.ID, nil, nil), 200)
		if loaded.Parameters["duration_seconds"] != float64(duration) || loaded.Parameters["direction"] != "download" || loaded.Parameters["kind"] != "iperf" || loaded.Actor != "iperf-operator" {
			t.Fatal(loaded)
		}
	}
	defaultJob := model.Job{Kind: "check", IdempotencyKey: "iperf-enqueue-defaults", Parameters: map[string]any{"kind": "iperf", "target": "branch.example:5201"}}
	apiDecode[model.Job](t, apiCall(s, admin, "POST", "/api/v1/jobs", defaultJob, nil), 202)
	for _, port := range []int{443, 65201} {
		target := fmt.Sprintf("branch.example:%d", port)
		request := model.Job{Kind: "check", IdempotencyKey: fmt.Sprintf("iperf-custom-port-%d", port), Parameters: map[string]any{"kind": "iperf", "target": target, "duration_seconds": 5}}
		saved := apiDecode[model.Job](t, apiCall(s, admin, "POST", "/api/v1/jobs", request, nil), 202)
		loaded := apiDecode[model.Job](t, apiCall(s, admin, "GET", "/api/v1/jobs/"+saved.ID, nil, nil), 200)
		if loaded.Parameters["target"] != target {
			t.Fatal("custom iperf port changed", loaded.Parameters)
		}
	}
	invalid := []map[string]any{
		{"kind": "iperf", "target": "branch:5201", "duration_seconds": "5"},
		{"kind": "iperf", "target": "branch:5201", "duration_seconds": 5.5},
		{"kind": "iperf", "target": "branch:5201", "duration_seconds": 30},
		{"kind": "iperf", "target": "branch:5201", "direction": "both"},
		{"kind": "iperf", "target": "branch:5201", "arguments": "--udp"},
		{"kind": "iperf", "target": "branch:0", "duration_seconds": 5},
		{"kind": "iperf", "target": "branch:65536", "duration_seconds": 5},
		{"kind": "iperf", "target": "branch:5201,5202", "duration_seconds": 5},
		{"kind": "tcp", "target": "branch:5201", "duration_seconds": 5},
		{"kind": "tcp", "target": "branch:5201", "direction": "download"},
	}
	for i, parameters := range invalid {
		request := model.Job{Kind: "check", IdempotencyKey: fmt.Sprintf("iperf-invalid-%d", i), Parameters: parameters}
		w := apiCall(s, admin, "POST", "/api/v1/jobs", request, nil)
		if w.Code != 400 {
			t.Fatalf("accepted %#v: %d %s", parameters, w.Code, w.Body.String())
		}
	}
	request := model.Job{Kind: "enrich", IdempotencyKey: "iperf-unrelated-job", Parameters: map[string]any{"target": "https://example.com", "duration_seconds": 5}}
	if w := apiCall(s, admin, "POST", "/api/v1/jobs", request, nil); w.Code != 400 {
		t.Fatal(w.Code, w.Body.String())
	}
}

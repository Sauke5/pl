package server

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
)

func TestProxyObservabilityRejectsNonAdminsAndClientQueries(t *testing.T) {
	s := &Server{}
	h := s.proxyObservabilityHandler()
	for _, test := range []struct {
		query string
		admin bool
		want  int
	}{{"", false, 403}, {"?query=up", true, 400}, {"?source=elsewhere", true, 400}, {"", true, 200}} {
		w := httptest.NewRecorder()
		h(w, proxyRequest("GET", "/api/v1/proxy-control/observability"+test.query, "", test.admin))
		if w.Code != test.want {
			t.Fatal(w.Code, w.Body.String())
		}
	}
}
func TestProxyAutomationAbsentAndInvalidAreIndependentOfStatus(t *testing.T) {
	var raw map[string]any
	if json.Unmarshal(proxyFixture(t, "status"), &raw) != nil {
		t.Fatal("fixture")
	}
	for _, value := range []any{nil, "bad shape", map[string]any{"observed_at": "not a time"}} {
		raw["automation"] = value
		body, _ := json.Marshal(raw)
		out, err := proxyControlProjection("/api/v1/status", body)
		if err != nil || out.(proxyStatus).Automation != nil {
			t.Fatal(out, err)
		}
	}
	raw["automation"] = map[string]any{
		"observed_at":   "2026-10-15T12:00:00Z",
		"gating_path":   "final185",
		"failed_cycles": map[string]any{"relay": map[string]int{"current": 1, "threshold": 3}, "final185": map[string]int{"current": 0, "threshold": 3}, "final2": map[string]int{"current": 0, "threshold": 3}},
		"edge_return":   map[string]any{"enabled": true, "healthy_since": "2026-10-15T11:59:20Z", "elapsed_seconds": 40, "required_seconds": 180, "remaining_seconds": 140},
		"last_decision": map[string]any{"at": "2026-10-15T12:00:00Z", "reason": "waiting_edge_hold_down", "selected_path": "final185"},
	}
	body, _ := json.Marshal(raw)
	out, err := proxyControlProjection("/api/v1/status", body)
	if err != nil || out.(proxyStatus).Automation == nil || *out.(proxyStatus).Automation.EdgeReturn.Remaining != 140 {
		t.Fatal(out, err)
	}
}

func TestProxyAutomationManualRetainsHealthButDropsOldDecision(t *testing.T) {
	body := proxyFixture(t, "status")
	var raw map[string]any
	_ = json.Unmarshal(body, &raw)
	raw["mode"] = "final185"
	raw["automation"] = map[string]any{
		"gating_path": "final185", "observed_at": "2026-10-15T12:00:00Z",
		"failed_cycles": map[string]any{"relay": map[string]int{"current": 0, "threshold": 3}, "final185": map[string]int{"current": 0, "threshold": 3}, "final2": map[string]int{"current": 0, "threshold": 3}},
		"edge_return":   map[string]any{"enabled": false, "elapsed_seconds": 500, "required_seconds": 180, "remaining_seconds": nil},
		"last_decision": map[string]any{"at": "2026-10-15T11:59:00Z", "reason": "waiting_edge_hold_down", "selected_path": "final185"},
	}
	body, _ = json.Marshal(raw)
	out, err := proxyControlProjection("/api/v1/status", body)
	if err != nil {
		t.Fatal(err)
	}
	a := out.(proxyStatus).Automation
	if a == nil || *a.EdgeReturn.Elapsed != 500 || a.LastDecision != nil {
		t.Fatal(a)
	}
}

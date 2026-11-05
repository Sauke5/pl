package server

import (
	"context"
	"strings"
	"testing"

	"pl/portal/internal/model"
)

func TestICMPFixedParametersAndAuthorization(t *testing.T) {
	s := apiFixture(t)
	s.Config.ICMPExecutorURL = "unix:///tmp/icmp-fixture.sock"
	admin := apiUser(t, s, "icmp-admin", true)
	viewer := apiUser(t, s, "icmp-viewer", false)
	base := func() map[string]any {
		return map[string]any{"kind": "check", "idempotency_key": "icmp-fixture-request", "parameters": map[string]any{"kind": "icmp", "target": "192.0.2.10"}}
	}
	for _, key := range []string{"count", "interval_us", "duration_seconds", "rate", "args", "source"} {
		body := base()
		body["parameters"].(map[string]any)[key] = "2000"
		if w := apiCall(s, admin, "POST", "/api/v1/jobs", body, nil); w.Code != 400 {
			t.Fatalf("accepted %s: %d %s", key, w.Code, w.Body.String())
		}
	}
	for _, who := range []struct {
		identity apiIdentity
		code     int
	}{{viewer, 403}, {apiIdentity{}, 401}} {
		if w := apiCall(s, who.identity, "POST", "/api/v1/jobs", base(), nil); w.Code != who.code {
			t.Fatal(w.Code)
		}
	}
	for _, target := range []string{"--flood", "host:80", "https://host", "10.0.0.1; id", "::1"} {
		body := base()
		body["parameters"].(map[string]any)["target"] = target
		if w := apiCall(s, admin, "POST", "/api/v1/jobs", body, nil); w.Code != 400 {
			t.Fatalf("accepted target %s: %d", target, w.Code)
		}
	}
	if w := apiCall(s, admin, "POST", "/api/v1/jobs", base(), nil); w.Code != 202 {
		t.Fatalf("valid: %d %s", w.Code, w.Body.String())
	}
}

func TestICMPOutputRequiresAdminAndIsLazy(t *testing.T) {
	s := apiFixture(t)
	admin := apiUser(t, s, "icmp-output-admin", true)
	viewer := apiUser(t, s, "icmp-output-viewer", false)
	ctx := context.Background()
	job, err := s.Store.Enqueue(ctx, model.Job{Kind: "check", Actor: "icmp-output-admin", IdempotencyKey: "icmp-output-fixture", Parameters: map[string]any{"kind": "icmp", "target": "192.0.2.10"}})
	if err != nil {
		t.Fatal(err)
	}
	raw := strings.Repeat("icmp reply\n", 2000)
	job.Status, job.Result = "succeeded", map[string]any{"raw_output": raw, "received": 2000}
	if err = s.Store.Finish(ctx, job); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/v1/jobs", "/api/v1/jobs/" + job.ID} {
		w := apiCall(s, admin, "GET", path, nil, nil)
		if w.Code != 200 || strings.Contains(w.Body.String(), "raw_output") || strings.Contains(w.Body.String(), "icmp reply") {
			t.Fatalf("output leaked from %s: %d", path, w.Code)
		}
	}
	path := "/api/v1/jobs/" + job.ID + "/output"
	for _, pair := range []struct {
		identity apiIdentity
		code     int
	}{{viewer, 403}, {apiIdentity{}, 401}} {
		if w := apiCall(s, pair.identity, "GET", path, nil, nil); w.Code != pair.code {
			t.Fatalf("unexpected access: %d", w.Code)
		}
	}
	got := apiDecode[map[string]string](t, apiCall(s, admin, "GET", path, nil, nil), 200)
	if got["raw_output"] != raw {
		t.Fatal("full output differs")
	}
}

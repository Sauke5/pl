package server

import (
	"context"
	"fmt"
	"net/http"
	"testing"

	"pl/portal/internal/model"
)

func TestAPIScheduledChecksRejectInvalidTargetsButAllowDisabledDraft(t *testing.T) {
	s := apiFixture(t)
	admin := apiUser(t, s, "check-target-operator", true)
	for _, target := range []string{"", "server-without-port", "server:invalid", "[2001:db8::1]"} {
		r := model.Resource{Name: "Host", Type: "Сервер", Hostname: "server.example.test", Check: model.Check{Kind: "tcp", Target: target, IntervalSeconds: 50}}
		if w := apiCall(s, admin, "POST", "/api/v1/resources", r, nil); w.Code != http.StatusBadRequest {
			t.Fatalf("invalid scheduled target %q accepted: %d %s", target, w.Code, w.Body.String())
		}
	}
	draft := model.Resource{Name: "Disabled host check", Type: "Сервер", Hostname: "server.example.test", Check: model.Check{Kind: "tcp", IntervalSeconds: 0}}
	saved := apiDecode[model.Resource](t, apiCall(s, admin, "POST", "/api/v1/resources", draft, nil), http.StatusCreated)
	if saved.Check.IntervalSeconds != 0 || saved.Check.Target != "" {
		t.Fatalf("disabled draft changed: %+v", saved.Check)
	}
	saved.Check.IntervalSeconds = 50
	if w := apiCall(s, admin, "PUT", "/api/v1/resources/"+saved.ID, saved, nil); w.Code != http.StatusBadRequest {
		t.Fatalf("invalid schedule enabled through update: %d %s", w.Code, w.Body.String())
	}
}

func TestAPIManualCheckRejectsMalformedTargetBeforePersistingJob(t *testing.T) {
	s := apiFixture(t)
	admin := apiUser(t, s, "check-target-operator", true)
	for i, target := range []string{"", "server-without-port", "server:invalid", "[2001:db8::1]", "server:70000"} {
		request := model.Job{Kind: "check", IdempotencyKey: fmt.Sprintf("invalid-target-%d", i), Parameters: map[string]any{"kind": "tcp", "target": target}}
		if w := apiCall(s, admin, "POST", "/api/v1/jobs", request, nil); w.Code != http.StatusBadRequest {
			t.Fatalf("invalid TCP target %q accepted: %d %s", target, w.Code, w.Body.String())
		}
	}
	jobs, err := s.Store.Jobs(context.Background())
	if err != nil || len(jobs) != 0 {
		t.Fatalf("rejected checks left durable jobs: %+v, %v", jobs, err)
	}
}

func TestAPIManualHTTPCheckUsesResourceURLWithoutExecuting(t *testing.T) {
	s := apiFixture(t)
	admin := apiUser(t, s, "check-target-operator", true)
	r := model.Resource{Name: "Service", URL: "https://service.example.test/status", Check: model.Check{Kind: "http", IntervalSeconds: 50}}
	r = apiDecode[model.Resource](t, apiCall(s, admin, "POST", "/api/v1/resources", r, nil), http.StatusCreated)
	request := model.Job{Kind: "check", ResourceID: r.ID, IdempotencyKey: "valid-http-fallback"}
	j := apiDecode[model.Job](t, apiCall(s, admin, "POST", "/api/v1/jobs", request, nil), http.StatusAccepted)
	if j.Parameters["kind"] != "http" || j.Parameters["target"] != r.URL {
		t.Fatalf("manual check lost resource URL fallback: %+v", j)
	}
	jobs, err := s.Store.Jobs(context.Background())
	if err != nil || len(jobs) != 1 || jobs[0].ID != j.ID {
		t.Fatalf("valid check was not persisted exactly once: %+v, %v", jobs, err)
	}
}

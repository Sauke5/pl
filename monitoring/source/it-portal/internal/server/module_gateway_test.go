package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"pl/portal/internal/model"
	"pl/portal/internal/modules"
	"pl/portal/internal/store"
)

type gatewayController struct{ reads []string }

func (c *gatewayController) Apply(context.Context, modules.Operation) (modules.Observation, error) {
	return modules.Observation{State: "running"}, nil
}
func (c *gatewayController) Read(ctx context.Context, instanceID, path, query string) (*http.Response, error) {
	c.reads = append(c.reads, instanceID+":"+path+"?"+query)
	body, ct := `<html><script type="module" src="./assets/index-fixture.js"></script></html>`, "text/html"
	if strings.HasPrefix(path, "/api/") {
		body, ct = `{"status":"success","data":{"resultType":"vector","result":[]}}`, "application/json"
	}
	return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{ct}, "Set-Cookie": []string{"upstream=secret"}}, Body: io.NopCloser(strings.NewReader(body))}, nil
}

func gatewayModule(t *testing.T, s *Server, admin apiIdentity, mode, endpoint string) model.ModuleInstance {
	t.Helper()
	w := apiCall(s, admin, "POST", "/api/v1/modules", map[string]any{"module_id": "prometheus", "name": "Native metrics", "mode": mode, "endpoint": endpoint, "idempotency_key": "gateway:" + mode}, nil)
	if w.Code != 202 {
		t.Fatalf("create module: %d %s", w.Code, w.Body.String())
	}
	var out struct {
		Instance model.ModuleInstance `json:"instance"`
	}
	if json.Unmarshal(w.Body.Bytes(), &out) != nil {
		t.Fatal("invalid module response")
	}
	return out.Instance
}

func TestModuleNativeGatewayChecksSessionOwnershipAndFiniteRoutes(t *testing.T) {
	s, admin := localUsersFixture(t)
	controller := &gatewayController{}
	s.Modules = modules.New(s.Store, controller)
	instance := gatewayModule(t, s, admin, "local", "")
	prefix := "/api/v1/modules/" + instance.ID + "/prometheus/"
	for _, tc := range []struct {
		who     apiIdentity
		headers map[string]string
		status  int
	}{
		{apiIdentity{}, nil, 401}, {apiUser(t, s, "viewer", false), nil, 403}, {admin, map[string]string{"Authorization": "Bearer forged"}, 403},
	} {
		w := apiCall(s, tc.who, "GET", prefix+"query", nil, tc.headers)
		if w.Code != tc.status {
			t.Fatalf("gateway auth: %d %s", w.Code, w.Body.String())
		}
	}
	if len(controller.reads) != 0 {
		t.Fatal("unauthorized request reached module")
	}
	w := apiCall(s, admin, "GET", prefix, nil, nil)
	if w.Code != 302 || w.Header().Get("Location") != prefix+"query" {
		t.Fatalf("native root redirect: %d %s", w.Code, w.Header().Get("Location"))
	}
	w = apiCall(s, admin, "GET", prefix+"query", nil, nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "./assets/index-fixture.js") || w.Header().Get("Set-Cookie") != "" || w.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("native UI envelope: %d %s", w.Code, w.Body.String())
	}
	w = apiCall(s, admin, "HEAD", prefix+"query", nil, nil)
	if w.Code != 200 || w.Body.Len() != 0 || w.Header().Get("Content-Length") == "0" {
		t.Fatal("HEAD gateway did not preserve read contract")
	}
	w = apiCall(s, admin, "GET", prefix+"api/v1/query?query=up", nil, nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "resultType") {
		t.Fatalf("actual API response not proxied: %d %s", w.Code, w.Body.String())
	}
	before := len(controller.reads)
	for _, path := range []string{"-/reload", "debug/pprof", "api/v1/admin/tsdb/delete_series", "assets/private%2fsecret.js"} {
		w = apiCall(s, admin, "GET", prefix+path, nil, nil)
		if w.Code < 400 {
			t.Fatalf("forbidden route %s: %d", path, w.Code)
		}
	}
	w = apiCall(s, admin, "POST", prefix+"query", map[string]string{"query": "up"}, nil)
	if w.Code != 405 {
		t.Fatalf("write gateway accepted: %d", w.Code)
	}
	w = apiCall(s, admin, "GET", prefix+"api/v1/notifications/live", nil, nil)
	if w.Code != 204 || len(controller.reads) != before {
		t.Fatal("SSE fallback or finite route guard bypassed")
	}

	integration, err := store.Get[model.Integration](context.Background(), s.Store, "integration", instance.IntegrationID)
	if err != nil {
		t.Fatal(err)
	}
	forged := integration
	forged.URL = "http://127.0.0.1/secret"
	response, err := s.Modules.ReadIntegration(context.Background(), forged, "/api/v1/targets", "")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if !strings.HasPrefix(controller.reads[len(controller.reads)-1], instance.ID+":") {
		t.Fatal("integration URL became transport authority")
	}
	forged.ID = "foreign"
	if _, err := s.Modules.ReadIntegration(context.Background(), forged, "/api/v1/targets", ""); err == nil {
		t.Fatal("foreign ownership edge accepted")
	}
	// Finish the queued installation before requesting a conflicting lifecycle
	// operation; otherwise disable is correctly rejected as busy.
	job, err := s.Store.Claim(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	instance.ObservedState = "running"
	job.Status = "succeeded"
	job.Result = map[string]any{"instance": instance}
	if err = s.Store.Finish(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	w = apiCall(s, admin, "POST", "/api/v1/modules/"+instance.ID+"/actions", map[string]string{"action": "disable", "idempotency_key": "gateway:disable"}, nil)
	if w.Code != 202 {
		t.Fatalf("disable: %d %s", w.Code, w.Body.String())
	}
	w = apiCall(s, admin, "GET", prefix+"query", nil, nil)
	if w.Code != 409 {
		t.Fatalf("disabled module UI still reachable: %d", w.Code)
	}
}

type externalGatewayReader struct {
	endpoint, path, query, body, contentType string
	status                                   int
	calls                                    int
}

func (p *externalGatewayReader) Probe(context.Context, string) (modules.Observation, error) {
	return modules.Observation{State: "running"}, nil
}
func (p *externalGatewayReader) Read(ctx context.Context, endpoint, path, query string) (*http.Response, error) {
	p.calls++
	p.endpoint, p.path, p.query = endpoint, path, query
	return &http.Response{StatusCode: p.status, Header: http.Header{"Content-Type": []string{p.contentType}, "Location": []string{"https://external.example.test/"}, "Set-Cookie": []string{"upstream=secret"}}, Body: io.NopCloser(strings.NewReader(p.body))}, nil
}

func TestExternalModuleStaysOnPlatformAndProxiesCanonicalJSON(t *testing.T) {
	s, admin := localUsersFixture(t)
	s.Config.PublicURL = "https://192.168.1.10:8447"
	reader := &externalGatewayReader{body: `{"status":"success","data":{"activeTargets":[]}}`, contentType: "application/json; charset=utf-8", status: 200}
	s.Modules = modules.New(s.Store, nil)
	s.Modules.Probe = reader
	instance := gatewayModule(t, s, admin, "external", "https://192.168.1.10:9090/prom")
	prefix := "/api/v1/modules/" + instance.ID + "/prometheus/"
	for _, path := range []string{"", "query", "query?query=up"} {
		w := apiCall(s, admin, "GET", prefix+path, nil, nil)
		if w.Code != 302 || w.Header().Get("Location") != "/#modules?instance="+instance.ID+"&view=monitoring" {
			t.Fatalf("external UI left Pl: %d %+v", w.Code, w.Header())
		}
	}
	if reader.calls != 0 {
		t.Fatal("external native UI was fetched")
	}
	// Corrupting the projection URL must not change the transport destination.
	integration, err := store.Get[model.Integration](context.Background(), s.Store, "integration", instance.IntegrationID)
	if err != nil {
		t.Fatal(err)
	}
	integration.URL = "https://foreign.example.test/untrusted"
	if _, err = s.Store.Save(context.Background(), "integration", integration.ID, integration.Revision, integration, "test"); err != nil {
		t.Fatal(err)
	}
	w := apiCall(s, admin, "GET", prefix+"api/v1/targets?state=active", nil, nil)
	if w.Code != 200 || w.Header().Get("Content-Type") != "application/json" || !json.Valid(w.Body.Bytes()) || reader.endpoint != instance.Endpoint || reader.path != "/api/v1/targets" || reader.query != "state=active" || reader.calls != 1 {
		t.Fatalf("canonical JSON gateway failed: %d %s %+v", w.Code, w.Body.String(), reader)
	}
	if w.Header().Get("Location") != "" || w.Header().Get("Set-Cookie") != "" || w.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("external response authority escaped gateway")
	}
	for _, path := range []string{"targets", "config", "assets/index-fixture.js", "api/v1/admin/tsdb/delete_series", "-/reload", "api/v1/notifications/live"} {
		w = apiCall(s, admin, "GET", prefix+path, nil, nil)
		if w.Code != 404 || w.Header().Get("Location") != "" {
			t.Fatalf("external HTML or forbidden route exposed: %s %d", path, w.Code)
		}
	}
	if reader.calls != 1 {
		t.Fatal("external native route reached upstream")
	}
}

func TestExternalModuleJSONGatewayRefusesHTMLMalformedJSONAndOversize(t *testing.T) {
	s, admin := localUsersFixture(t)
	reader := &externalGatewayReader{status: 200}
	s.Modules = modules.New(s.Store, nil)
	s.Modules.Probe = reader
	instance := gatewayModule(t, s, admin, "external", "http://192.168.1.10:9090")
	prefix := "/api/v1/modules/" + instance.ID + "/prometheus/api/v1/query?query=up"
	for _, tc := range []struct {
		name, body, contentType string
		status                  int
	}{
		{"html", `<script>fetch('/api/v1/session')</script>`, "text/html", 200},
		{"html-disguised-as-json", `<script>alert(1)</script>`, "application/json", 200},
		{"json-disguised-as-html", `{"status":"success"}`, "text/html", 200},
		{"malformed-json", `{"status":`, "application/json", 200},
		{"redirect", `{"status":"success"}`, "application/json", 302},
		{"oversize", strings.Repeat(" ", modules.ReadLimit) + `{}`, "application/json", 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reader.body, reader.contentType, reader.status = tc.body, tc.contentType, tc.status
			w := apiCall(s, admin, "GET", prefix, nil, nil)
			if w.Code != 502 || w.Header().Get("Location") != "" || strings.Contains(w.Body.String(), "<script>") {
				t.Fatalf("unsafe external response accepted: %d %s", w.Code, w.Body.String())
			}
		})
	}
}

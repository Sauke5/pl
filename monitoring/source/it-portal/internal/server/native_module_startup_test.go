package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"pl/portal/internal/model"
	"pl/portal/internal/modules"
)

func nativeStartupFixture(t *testing.T, kind string) (*Server, apiIdentity, model.ModuleInstance, model.Job, *int) {
	t.Helper()
	s, admin := localUsersFixture(t)
	s.Config.PortableRelease = true
	calls := new(int)
	s.Modules = modules.New(s.Store, moduleControllerFunc(func(context.Context, modules.Operation) (modules.Observation, error) {
		*calls++
		return modules.Observation{}, nil
	}))
	instance, job, err := s.Store.QueueModule(context.Background(), "startup-admin", "native-startup-"+kind, "", "install", model.ModuleRequest{ModuleID: kind, Mode: "local", Name: "private administrator instance name"})
	if err != nil {
		t.Fatal(err)
	}
	return s, admin, instance, job, calls
}

func nativeStartupCall(s *Server, who apiIdentity, kind, method, uri string, extra map[string]string) *httptest.ResponseRecorder {
	headers := map[string]string{"X-Original-Method": method, "X-Original-URI": uri, "Accept": "text/html", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate"}
	for name, value := range extra {
		headers[name] = value
	}
	return apiCall(s, who, http.MethodGet, "/internal/startup/"+kind, nil, headers)
}

func TestNativeStartupGrafanaStaysAnonymousAndUsesOnlyGenericName(t *testing.T) {
	s, _, instance, job, calls := nativeStartupFixture(t, "grafana")
	for _, status := range []string{"queued", "running", "failed", "succeeded"} {
		if _, err := s.Store.Pool.Exec(context.Background(), `UPDATE jobs SET status=$2,body=jsonb_set(body,'{status}',to_jsonb($2::text)) WHERE id=$1`, job.ID, status); err != nil {
			t.Fatal(err)
		}
		w := nativeStartupCall(s, apiIdentity{}, "grafana", "GET", "/grafana/", nil)
		if w.Code != 503 || w.Header().Get("Content-Type") != "text/html; charset=utf-8" || !strings.Contains(w.Body.String(), "Grafana · PL") {
			t.Fatalf("%s: %d %s", status, w.Code, w.Body.String())
		}
		automatic := status == "queued" || status == "running"
		if strings.Contains(w.Body.String(), moduleStartupReloadJS) != automatic {
			t.Fatalf("%s: false startup progress", status)
		}
		for _, private := range []string{instance.Name, instance.ID, job.ID, "private controller error"} {
			if strings.Contains(w.Body.String(), private) {
				t.Fatal("anonymous Grafana fallback exposed private state")
			}
		}
		if w.Header().Get("Location") != "" || w.Header().Get("Set-Cookie") != "" {
			t.Fatal("native Grafana fallback added a Platform authentication flow")
		}
	}
	if *calls != 0 {
		t.Fatal("startup page called the host controller")
	}
}

func TestNativeStartupBookstackPreservesPlatformAdminGate(t *testing.T) {
	s, admin, _, _, calls := nativeStartupFixture(t, "bookstack")
	viewer := apiUser(t, s, "startup-viewer", false)
	for _, tc := range []struct {
		who    apiIdentity
		status int
	}{{apiIdentity{}, 401}, {viewer, 403}, {admin, 503}} {
		w := nativeStartupCall(s, tc.who, "bookstack", "GET", "/wiki/", nil)
		if w.Code != tc.status {
			t.Fatalf("got %d want %d: %s", w.Code, tc.status, w.Body.String())
		}
		if tc.status != 503 && strings.Contains(w.Body.String(), "private administrator") {
			t.Fatal("BookStack state leaked before module authorization")
		}
		if tc.status == 503 && (!strings.Contains(w.Body.String(), "Модуль ожидает запуска") || !strings.Contains(w.Body.String(), moduleStartupReloadJS)) {
			t.Fatal("authorized BookStack startup document missing")
		}
	}
	if *calls != 0 {
		t.Fatal("BookStack startup called the host controller")
	}
}

func TestNativeStartupAPIAssetsAndNonDocumentsKeepJSON503(t *testing.T) {
	for _, kind := range []string{"grafana", "bookstack"} {
		s, admin, _, _, _ := nativeStartupFixture(t, kind)
		root := "/grafana/"
		if kind == "bookstack" {
			root = "/wiki/"
		}
		for _, tc := range []struct {
			method, uri string
			headers     map[string]string
		}{{"GET", root + "api/health", nil}, {"GET", root + "public/build/app.js", nil}, {"GET", root, map[string]string{"Accept": "application/json"}}, {"POST", root + "login", nil}, {"GET", root, map[string]string{"X-Original-Upgrade": "websocket"}}, {"GET", root, map[string]string{"Sec-Fetch-Dest": "script"}}, {"GET", root + "?token=private", nil}, {"GET", root + "%2e%2e/auth", nil}} {
			w := nativeStartupCall(s, admin, kind, tc.method, tc.uri, tc.headers)
			if w.Code != 503 || !strings.HasPrefix(w.Header().Get("Content-Type"), "application/json") || strings.Contains(w.Body.String(), "<!doctype") {
				t.Fatalf("%s %s %s got %d: %s", kind, tc.method, tc.uri, w.Code, w.Body.String())
			}
		}
	}
}

func TestNativeStartupUniqueLocalSelectionRejectsAmbiguityForeignAndDisabled(t *testing.T) {
	for _, scenario := range []string{"absent", "disabled", "external", "ambiguous", "foreign-integration", "missing-job", "foreign-job"} {
		t.Run(scenario, func(t *testing.T) {
			s, _, instance, job, _ := nativeStartupFixture(t, "grafana")
			wantHTML := false
			switch scenario {
			case "absent":
				_, _ = s.Store.Pool.Exec(context.Background(), `DELETE FROM documents WHERE kind='module_instance' AND id=$1`, instance.ID)
			case "disabled":
				instance.DesiredState = "disabled"
			case "external":
				instance.Mode = "external"
			case "ambiguous":
				other := instance
				other.ID = uuid.NewString()
				if _, err := s.Store.Save(context.Background(), "module_instance", other.ID, 0, other, "test"); err != nil {
					t.Fatal(err)
				}
			case "foreign-integration":
				integration := model.Integration{ID: uuid.NewString(), Kind: "grafana", Enabled: true, ManagedModuleID: uuid.NewString()}
				if _, err := s.Store.Save(context.Background(), "integration", integration.ID, 0, integration, "test"); err != nil {
					t.Fatal(err)
				}
			case "missing-job":
				instance.LastJobID = uuid.NewString()
				wantHTML = true
			case "foreign-job":
				if _, err := s.Store.Pool.Exec(context.Background(), `UPDATE jobs SET body=jsonb_set(body,'{parameters,instance_id}','"foreign"') WHERE id=$1`, job.ID); err != nil {
					t.Fatal(err)
				}
				wantHTML = true
			}
			if scenario != "absent" {
				if _, err := s.Store.Save(context.Background(), "module_instance", instance.ID, instance.Revision, instance, "test"); err != nil {
					t.Fatal(err)
				}
			}
			w := nativeStartupCall(s, apiIdentity{}, "grafana", "GET", "/grafana/", nil)
			if w.Code != 503 || strings.HasPrefix(w.Header().Get("Content-Type"), "text/html") != wantHTML || strings.Contains(w.Body.String(), moduleStartupReloadJS) {
				t.Fatalf("%s: invented progress or wrong unavailable state: %d %s", scenario, w.Code, w.Body.String())
			}
		})
	}
}

func TestNativeStartupHEADAndPortableRouting(t *testing.T) {
	s, _, _, _, _ := nativeStartupFixture(t, "grafana")
	w := nativeStartupCall(s, apiIdentity{}, "grafana", "HEAD", "/grafana/login", nil)
	if w.Code != 503 || w.Body.Len() != 0 || w.Header().Get("Retry-After") != "2" {
		t.Fatalf("HEAD: %d %s", w.Code, w.Body.String())
	}
	s.Config.PortableRelease = false
	w = nativeStartupCall(s, apiIdentity{}, "grafana", "GET", "/grafana/", nil)
	if w.Code != 404 {
		t.Fatalf("legacy route opened: %d", w.Code)
	}
}

func TestNativeStartupDocumentRejectsUntrustedOriginalMetadata(t *testing.T) {
	for _, change := range []func(*http.Request){
		func(r *http.Request) { r.Header.Del("X-Original-URI") },
		func(r *http.Request) { r.Header.Add("X-Original-URI", "/grafana/") },
		func(r *http.Request) { r.Header.Set("X-Original-URI", "https://evil.invalid/grafana/") },
		func(r *http.Request) { r.Header.Set("X-Original-URI", "//evil.invalid/grafana/") },
		func(r *http.Request) { r.Header.Set("X-Original-URI", "/grafana/?") },
		func(r *http.Request) { r.Header.Set("X-Original-Method", "POST") },
	} {
		r := httptest.NewRequest("GET", "/internal/startup/grafana", nil)
		r.Header.Set("X-Original-URI", "/grafana/")
		r.Header.Set("X-Original-Method", "GET")
		r.Header.Set("Accept", "text/html")
		change(r)
		if _, ok := nativeStartupDocument(r, "grafana"); ok {
			t.Fatal("untrusted document metadata admitted")
		}
	}
}

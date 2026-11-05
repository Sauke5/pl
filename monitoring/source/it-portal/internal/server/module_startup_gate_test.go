package server

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"pl/portal/internal/model"
	"pl/portal/internal/modules"
	"strings"
	"sync/atomic"
	"testing"
)

func TestModuleStartupDocumentFiniteRoutes(t *testing.T) {
	for _, tc := range []struct {
		kind, method, path, accept, header string
		want                               bool
	}{
		{"forms", "GET", "/forms/", "text/html", "", true}, {"forms", "HEAD", "/forms/index.html", "text/html", "", true},
		{"doska", "GET", "/doska/", "text/html,application/xhtml+xml", "", true}, {"wayline", "HEAD", "/wayline/", "text/html", "", true},
		{"forms", "GET", "/forms/app.js", "text/html", "", false}, {"forms", "GET", "/forms/api/v1/context", "text/html", "", false},
		{"forms", "GET", "/forms/unknown", "text/html", "", false}, {"forms", "GET", "/forms/?token=secret", "text/html", "", false},
		{"doska", "GET", "/doska/assets/app.js", "text/html", "", false}, {"doska", "GET", "/doska/api/doska/context", "text/html", "", false},
		{"doska", "GET", "/doska/unknown", "text/html", "", false}, {"doska", "GET", "/doska/projects/a%2fb", "text/html", "", false},
		{"doska", "POST", "/doska/", "text/html", "", false}, {"doska", "GET", "/doska/", "application/json", "", false},
		{"doska", "GET", "/doska/", "text/html", "Authorization", false}, {"forms", "GET", "/forms/", "text/html", "Upgrade", false},
		{"wayline", "GET", "/wayline/assets/app.js", "text/html", "", false}, {"wayline", "GET", "/wayline/api/v1/targets", "text/html", "", false},
		{"wayline", "GET", "/wayline/unknown", "text/html", "", false},
	} {
		r := httptest.NewRequest(tc.method, tc.path, nil)
		r.Header.Set("Accept", tc.accept)
		if tc.header != "" {
			r.Header[tc.header] = []string{""}
		}
		if got := moduleStartupDocument(r, tc.kind); got != tc.want {
			t.Errorf("%s %s %s %s: got%v want%v", tc.kind, tc.method, tc.path, tc.header, got, tc.want)
		}
	}
}
func TestModuleStartupStageRequiresBoundLiveJob(t *testing.T) {
	v := model.ModuleInstance{ID: "instance", LastJobID: "job"}
	for _, tc := range []struct {
		action, status, id, kind string
		want                     moduleStartupStage
	}{
		{"install", "queued", "instance", "module", moduleStartupQueued}, {"install", "running", "instance", "module", moduleStartupInstalling},
		{"enable", "running", "instance", "module", moduleStartupStarting}, {"install", "failed", "instance", "module", moduleStartupFailed},
		{"install", "succeeded", "instance", "module", moduleStartupFailed}, {"install", "unknown", "instance", "module", moduleStartupFailed},
		{"refresh", "running", "instance", "module", moduleStartupFailed}, {"install", "running", "foreign", "module", moduleStartupFailed},
		{"install", "running", "instance", "check", moduleStartupFailed},
	} {
		j := model.Job{ID: "job", Kind: tc.kind, Status: tc.status, Parameters: map[string]any{"instance_id": tc.id, "action": tc.action}}
		if got := moduleStartupStageForJob(v, j); got != tc.want {
			t.Errorf("%+v got%s", tc, got)
		}
	}
}
func TestModuleStartupManagedHTTPTransitions(t *testing.T) {
	for _, kind := range []string{"forms", "doska"} {
		t.Run(kind, func(t *testing.T) {
			f := newFormsHTTPFixture(t, formsOK)
			ctx := context.Background()
			v, j, err := f.s.Store.QueueModule(ctx, "startup-admin", "startup:install", "", "install", model.ModuleRequest{ModuleID: kind, Mode: "local", Name: kind + " <startup>"})
			if err != nil {
				t.Fatal(err)
			}
			var controllerCalls atomic.Int32
			f.s.Modules = modules.New(f.s.Store, moduleControllerFunc(func(context.Context, modules.Operation) (modules.Observation, error) {
				controllerCalls.Add(1)
				return modules.Observation{}, errors.New("unexpected controller RPC")
			}))
			path := "/" + kind + "/"
			check := func(who apiIdentity, title string, automatic bool) {
				t.Helper()
				w := apiCall(f.s, who, "GET", path, nil, map[string]string{"Accept": "text/html"})
				if w.Code != 503 || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/html") || !strings.Contains(w.Body.String(), title) || !strings.Contains(w.Body.String(), "&lt;startup&gt;") || (w.Header().Get("Retry-After") == "2") != automatic {
					t.Fatalf("startup stage: %d %v %s", w.Code, w.Header(), w.Body.String())
				}
			}
			check(f.admin, "Модуль ожидает запуска", true)
			check(f.employee, "Модуль ожидает запуска", true)
			if w := apiCall(f.s, apiIdentity{}, "GET", path, nil, map[string]string{"Accept": "text/html"}); w.Code != 303 || !strings.HasPrefix(w.Header().Get("Location"), "/401?return_to=") {
				t.Fatalf("login changed: %d %s", w.Code, w.Body.String())
			}
			for _, suffix := range []string{"api/v1/context", "api/doska/context", "app.js", "assets/app.js", "unknown"} {
				w := apiCall(f.s, f.employee, "GET", path+suffix, nil, map[string]string{"Accept": "text/html"})
				if w.Code != 503 || strings.Contains(w.Header().Get("Content-Type"), "text/html") {
					t.Fatal("API/static/unknown changed", suffix, w.Code)
				}
			}
			claimed, err := f.s.Store.Claim(ctx)
			if err != nil || claimed.ID != j.ID {
				t.Fatal("claim", err)
			}
			check(f.employee, "Устанавливаем модуль", true)
			claimed.Status, claimed.Error = "failed", "private controller error"
			if err = f.s.Store.Finish(ctx, claimed); err != nil {
				t.Fatal(err)
			}
			check(f.employee, "Не удалось запустить модуль", false)
			v, j, err = f.s.Store.QueueModule(ctx, "startup-admin", "startup:enable", v.ID, "enable", model.ModuleRequest{})
			if err != nil {
				t.Fatal(err)
			}
			check(f.employee, "Модуль ожидает запуска", true)
			claimed, err = f.s.Store.Claim(ctx)
			if err != nil || claimed.ID != j.ID {
				t.Fatal("enable claim", err)
			}
			check(f.employee, "Модуль запускается", true)
			v.ObservedState, v.Version = "running", "startup-v1"
			claimed.Status, claimed.Result = "succeeded", map[string]any{"instance": v}
			if err = f.s.Store.Finish(ctx, claimed); err != nil {
				t.Fatal(err)
			}
			if kind == "forms" {
				f.s.applications.handlers = map[string]*managedApplicationHandler{v.ID + "/" + v.Version: newManagedApplicationHandler(f.g)}
				defer f.s.revokeManagedApplication(v.ID)
				w := apiCall(f.s, f.employee, "GET", path, nil, map[string]string{"Accept": "text/html"})
				if w.Code != 200 || w.Body.String() != "test asset" || f.calls.Load() != 1 {
					t.Fatalf("ready Forms did not regain native gateway %d %s", w.Code, w.Body.String())
				}
			} else {
				// A completed install with missing native manifest/key is failed, not progress.
				check(f.employee, "Не удалось запустить модуль", false)
				gateway, e := f.s.newDoskaGateway(DoskaGatewayConfig{APIUpstream: "http://api.test:1337", WebUpstream: "http://web.test:8080", Key: f.key, Manifest: doskaGatewayTestManifest(), Transport: directoryRoundTrip(func(*http.Request) (*http.Response, error) {
					return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"text/html"}}, Body: io.NopCloser(strings.NewReader("ready Doska"))}, nil
				})})
				if e != nil {
					t.Fatal(e)
				}
				f.s.applications.handlers = map[string]*managedApplicationHandler{v.ID + "/" + v.Version: newManagedApplicationHandler(gateway)}
				defer f.s.revokeManagedApplication(v.ID)
				f.s.Config.LocalAdminHashFile = "/fixture/builtin-enabled"
				localAdmin := apiUser(t, f.s, "local-admin", true)
				if w := apiCall(f.s, localAdmin, "GET", path, nil, map[string]string{"Accept": "text/html"}); w.Code != 200 || w.Body.String() != "ready Doska" {
					t.Fatalf("ready Doska did not regain gateway %d %s", w.Code, w.Body.String())
				}
				if w := apiCall(f.s, apiIdentity{}, "GET", path+"api/doska/context", nil, map[string]string{"Accept": "text/html"}); w.Code != 401 || strings.Contains(w.Header().Get("Content-Type"), "text/html") {
					t.Fatalf("Doska API auth changed %d %s", w.Code, w.Body.String())
				}
			}
			// Inconsistent persisted duplicates are not presented as progress.
			duplicate := v
			duplicate.ID, duplicate.ObservedState = "duplicate-startup-instance", "pending"
			if _, err = f.s.Store.Save(ctx, "module_instance", duplicate.ID, 0, duplicate, "fixture"); err != nil {
				t.Fatal(err)
			}
			r := httptest.NewRequest("GET", f.s.Config.PublicURL+path, nil)
			r.Header.Set("Accept", "text/html")
			r.AddCookie(f.employee.cookie)
			if f.s.tryModuleStartupPage(httptest.NewRecorder(), r, kind, "", true) {
				t.Fatal("ambiguous module instances became startup HTML")
			}
			if controllerCalls.Load() != 0 {
				t.Fatal("startup performed host-controller RPC")
			}
		})
	}
}
func TestModuleStartupWaylineHTTPTransitions(t *testing.T) {
	s := apiFixture(t)
	ctx := context.Background()
	admin, viewer := apiUser(t, s, "startup-admin", true), apiUser(t, s, "startup-viewer", false)
	v, j, err := s.Store.QueueModule(ctx, "startup-admin", "startup:wayline", "", "install", model.ModuleRequest{ModuleID: "wayline", Mode: "local", Name: "Wayline QA"})
	if err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	handler := s.WaylineProxy("", func(model.Integration) (http.RoundTripper, error) {
		return directoryRoundTrip(func(*http.Request) (*http.Response, error) {
			calls.Add(1)
			return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"text/html"}}, Body: io.NopCloser(strings.NewReader("ready Wayline"))}, nil
		}), nil
	})
	call := func(who apiIdentity, path string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", s.Config.PublicURL+path, nil)
		r.Header.Set("Accept", "text/html")
		if who.cookie != nil {
			r.AddCookie(who.cookie)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	check := func(title string, automatic bool) {
		t.Helper()
		w := call(admin, "/wayline/")
		if w.Code != 503 || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/html") || !strings.Contains(w.Body.String(), title) || (w.Header().Get("Retry-After") == "2") != automatic {
			t.Fatalf("Wayline stage %d %s", w.Code, w.Body.String())
		}
	}
	check("Модуль ожидает запуска", true)
	if w := call(viewer, "/wayline/"); w.Code != 403 || strings.Contains(w.Header().Get("Content-Type"), "text/html") {
		t.Fatal("viewer boundary changed", w.Code)
	}
	if w := call(apiIdentity{}, "/wayline/"); w.Code != 303 || w.Header().Get("Location") != "/" {
		t.Fatal("anonymous boundary changed", w.Code)
	}
	for _, path := range []string{"/wayline/assets/app.js", "/wayline/api/v1/targets", "/wayline/unknown"} {
		w := call(admin, path)
		if w.Code == 200 || strings.Contains(w.Header().Get("Content-Type"), "text/html") {
			t.Fatal("Wayline non-document changed", path, w.Code)
		}
	}
	claimed, err := s.Store.Claim(ctx)
	if err != nil || claimed.ID != j.ID {
		t.Fatal("claim", err)
	}
	check("Устанавливаем модуль", true)
	claimed.Status, claimed.Error = "failed", "private controller error"
	if err = s.Store.Finish(ctx, claimed); err != nil {
		t.Fatal(err)
	}
	check("Не удалось запустить модуль", false)
	v, j, err = s.Store.QueueModule(ctx, "startup-admin", "startup:wayline-enable", v.ID, "enable", model.ModuleRequest{})
	if err != nil {
		t.Fatal(err)
	}
	claimed, err = s.Store.Claim(ctx)
	if err != nil || claimed.ID != j.ID {
		t.Fatal("enable claim", err)
	}
	check("Модуль запускается", true)
	v.Endpoint, v.ObservedState, v.Version = "http://wayline.test:8080", "running", "0.1.0"
	claimed.Status, claimed.Result = "succeeded", map[string]any{"instance": v}
	if err = s.Store.Finish(ctx, claimed); err != nil {
		t.Fatal(err)
	}
	if w := call(admin, "/wayline/"); w.Code != 200 || w.Body.String() != "ready Wayline" || calls.Load() != 1 {
		t.Fatalf("ready Wayline did not regain gateway %d %s", w.Code, w.Body.String())
	}
	_, err = s.Store.Save(ctx, "integration", "other-wayline", 0, model.Integration{ID: "other-wayline", Kind: "wayline", Enabled: true, URL: "http://other.test"}, "fixture")
	if err != nil {
		t.Fatal(err)
	}
	if w := call(admin, "/wayline/"); w.Code != 503 || strings.Contains(w.Header().Get("Content-Type"), "text/html") {
		t.Fatal("ambiguous source became progress", w.Code)
	}
}

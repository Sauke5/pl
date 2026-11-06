package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pl/portal/internal/modules"
)

func scopedMaintenanceStatus(t *testing.T, folder string, active bool, operation modules.DeliveryOperation) {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"active": active, "ready": false, "current_version": "0.5.6", "operation": operation})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(folder, "status.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
}

func scopedMaintenanceOperation(kind string) modules.DeliveryOperation {
	return modules.DeliveryOperation{Kind: "module_upgrade", Scope: "module", ModuleID: kind,
		OperationID: "727b18f8-99da-410f-b94f-e677f2967731", Version: "0.5.6", Phase: "applying", Error: "private failure must not be rendered"}
}

func TestScopedModuleMaintenanceUsesRealGatewayAndPublicProductNames(t *testing.T) {
	folder := t.TempDir()
	s := &Server{Config: Config{PortableRelease: true, MaintenanceDir: folder}}
	calls := 0
	h := s.maintenanceGate(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(204) }))
	for _, tc := range []struct{ kind, path, name string }{
		{"doska", "/doska/projects/project_1?taskId=task_1", "Doska"},
		{"forms", "/forms/", "Forms"}, {"wayline", "/wayline/", "Wayline"},
		{"netmap", "/netmap/?scope=network", "NetMap"}, {"grafana", "/grafana/d/fixture", "Grafana"},
		{"bookstack", "/wiki/books/fixture/page/one", "Wiki"},
	} {
		scopedMaintenanceStatus(t, folder, true, scopedMaintenanceOperation(tc.kind))
		for _, method := range []string{http.MethodGet, http.MethodHead} {
			r := httptest.NewRequest(method, tc.path, nil)
			r.Header.Set("Accept", "text/html")
			r.Header.Set("Sec-Fetch-Dest", "document")
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != 503 || w.Header().Get("Content-Type") != "text/html; charset=utf-8" || w.Header().Get("Retry-After") != "2" || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("missing update document for %s: %d %v", tc.path, w.Code, w.Header())
			}
			if method == http.MethodHead {
				if w.Body.Len() != 0 {
					t.Fatal("HEAD update document has a body")
				}
			} else if !strings.Contains(w.Body.String(), "Модуль обновляется") || !strings.Contains(w.Body.String(), tc.name+" · PL") || !strings.Contains(w.Body.String(), moduleStartupReloadJS) || strings.Contains(w.Body.String(), "private failure") {
				t.Fatalf("incorrect public update document: %s", w.Body.String())
			}
		}
	}
	if calls != 0 {
		t.Fatal("an updating request was forwarded to the application")
	}
}

func TestScopedModuleMaintenanceKeepsCoreNeighboursAndAuthHandlers(t *testing.T) {
	folder := t.TempDir()
	scopedMaintenanceStatus(t, folder, true, scopedMaintenanceOperation("doska"))
	s := &Server{Config: Config{PortableRelease: true, MaintenanceDir: folder}}
	h := s.maintenanceGate(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusUnauthorized) }))
	for _, path := range []string{"/", "/api/v1/session", "/api/v1/resources", "/auth/logout", "/forms/", "/forms/api/v1/surveys", "/doska-other/", "/sftpgo", "/grafana/", "/wiki/", "/ecosystem/ui-v1.css"} {
		for _, method := range []string{http.MethodGet, http.MethodPost} {
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest(method, path, nil))
			if w.Code != http.StatusUnauthorized {
				t.Fatalf("neighbour/core/auth handling changed: %s %s %d", method, path, w.Code)
			}
		}
	}
	scopedMaintenanceStatus(t, folder, false, scopedMaintenanceOperation("doska"))
	r := httptest.NewRequest(http.MethodGet, "/doska/", nil)
	r.Header.Set("Accept", "text/html")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatal("normal gateway auth did not resume after maintenance")
	}
}

func TestScopedModuleMaintenanceKeepsAPIAssetsAndWritesAsJSON(t *testing.T) {
	folder := t.TempDir()
	s := &Server{Config: Config{PortableRelease: true, MaintenanceDir: folder}}
	calls := 0
	h := s.maintenanceGate(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(204) }))
	for _, tc := range []struct{ kind, method, path, destination string }{
		{"doska", "GET", "/doska/api/doska/context", "document"},
		{"doska", "GET", "/doska/api/doska/events", "empty"},
		{"doska", "POST", "/doska/api/doska/projects", ""},
		{"doska", "GET", "/doska/assets/app.js", "script"},
		{"forms", "POST", "/forms/api/v1/surveys/a/responses", ""},
		{"wayline", "GET", "/wayline/assets/app.js", "script"},
		{"netmap", "GET", "/netmap/app.js", "script"},
		{"grafana", "GET", "/grafana/api/user", "document"},
		{"bookstack", "GET", "/wiki/api/books", "document"},
	} {
		scopedMaintenanceStatus(t, folder, true, scopedMaintenanceOperation(tc.kind))
		r := httptest.NewRequest(tc.method, tc.path, nil)
		r.Header.Set("Accept", "text/html")
		r.Header.Set("Sec-Fetch-Dest", tc.destination)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 503 || !strings.Contains(w.Header().Get("Content-Type"), "application/json") || !strings.Contains(w.Body.String(), "module_updating") || strings.Contains(w.Body.String(), "<!doctype") {
			t.Fatalf("machine/write route received an HTML document or forwarding: %s %d %s", tc.path, w.Code, w.Body.String())
		}
	}
	if calls != 0 {
		t.Fatal("a blocked module API or write reached its handler")
	}
}

func TestScopedModuleMaintenanceNativeNginxRoutingAndFallback(t *testing.T) {
	folder := t.TempDir()
	s := &Server{Config: Config{PortableRelease: true, MaintenanceDir: folder}}
	h := s.maintenanceGate(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	for _, tc := range []struct{ kind, uri string }{{"grafana", "/grafana/d/fixture?orgId=1"}, {"bookstack", "/wiki/books/fixture"}} {
		scopedMaintenanceStatus(t, folder, true, scopedMaintenanceOperation(tc.kind))
		r := httptest.NewRequest(http.MethodGet, "/internal/routing/"+tc.kind, nil)
		r.Header.Set("Accept", "text/html")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 503 || !strings.Contains(w.Body.String(), "module_updating") {
			t.Fatal("Nginx routing lookup did not reject the updating native upstream")
		}
		r = httptest.NewRequest(http.MethodGet, "/internal/startup/"+tc.kind, nil)
		r.Header.Set("X-Original-URI", tc.uri)
		r.Header.Set("X-Original-Method", "GET")
		r.Header.Set("Accept", "text/html")
		r.Header.Set("Sec-Fetch-Dest", "document")
		r.Header.Set("Sec-Fetch-Mode", "navigate")
		w = httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 503 || !strings.Contains(w.Body.String(), "Модуль обновляется") {
			t.Fatal("Nginx fallback did not render the native update document")
		}
		r.Header.Set("X-Original-URI", "/doska/")
		w = httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 204 {
			t.Fatal("unrelated original metadata selected a native update page")
		}
	}
}

func TestScopedModuleMaintenanceRejectsMalformedAndLegacyStatus(t *testing.T) {
	folder := t.TempDir()
	s := &Server{Config: Config{PortableRelease: true, MaintenanceDir: folder}}
	h := s.maintenanceGate(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	for _, change := range []func(*modules.DeliveryOperation){
		func(op *modules.DeliveryOperation) { op.Scope = "" },
		func(op *modules.DeliveryOperation) { op.Scope = "installation" },
		func(op *modules.DeliveryOperation) { op.Kind = "upgrade" },
		func(op *modules.DeliveryOperation) { op.ModuleID = "unknown" },
		func(op *modules.DeliveryOperation) { op.OperationID = "bad" },
		func(op *modules.DeliveryOperation) { op.Phase = "complete" },
		func(op *modules.DeliveryOperation) { op.Phase = "unknown" },
	} {
		op := scopedMaintenanceOperation("doska")
		change(&op)
		scopedMaintenanceStatus(t, folder, true, op)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("POST", "/doska/api/doska/projects", nil))
		if w.Code != 204 {
			t.Fatalf("malformed/legacy operation changed scoped routing: %#v", op)
		}
	}
	for _, raw := range []string{"{", "{} {}", "null", strings.Repeat(" ", scopedModuleStatusLimit+1)} {
		if err := os.WriteFile(filepath.Join(folder, "status.json"), []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("POST", "/doska/api/doska/projects", nil))
		if w.Code != 204 {
			t.Fatal("invalid/oversized status changed scoped routing")
		}
	}
	if err := os.Remove(filepath.Join(folder, "status.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("missing-private-file", filepath.Join(folder, "status.json")); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("POST", "/doska/api/doska/projects", nil))
	if w.Code != 204 {
		t.Fatal("symlink selected a scoped update")
	}
}

func TestScopedModuleMaintenancePreservesFullMarkerAndPortableBoundary(t *testing.T) {
	folder := t.TempDir()
	scopedMaintenanceStatus(t, folder, true, scopedMaintenanceOperation("doska"))
	s := &Server{Config: Config{PortableRelease: true, MaintenanceDir: folder}}
	h := s.maintenanceGate(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	if err := os.WriteFile(filepath.Join(folder, "active"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("GET", "/doska/", nil)
	r.Header.Set("Accept", "text/html")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 204 {
		t.Fatal("scoped status replaced legacy full-marker read behaviour")
	}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("POST", "/doska/api/doska/projects", nil))
	if w.Code != 503 || !strings.Contains(w.Body.String(), "installation_maintenance") {
		t.Fatal("scoped status weakened the full installation write marker")
	}
	s.Config.PortableRelease = false
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("POST", "/doska/api/doska/projects", nil))
	if w.Code != 204 {
		t.Fatal("non-portable application acquired maintenance routing")
	}
}

func TestScopedModuleMaintenanceBrowserThemeAndRealAutomaticReturn(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is required for native maintenance document browser checks")
	}
	assets, err := filepath.Abs("../../frontend/public/ecosystem")
	if err != nil {
		t.Fatal(err)
	}
	playwright, err := filepath.Abs("../../frontend/node_modules/playwright/index.mjs")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(playwright); err != nil {
		t.Skip("the existing frontend Playwright dependency is required")
	}
	folder := t.TempDir()
	s := &Server{Config: Config{PortableRelease: true, MaintenanceDir: folder}}
	static := http.StripPrefix("/ecosystem/", http.FileServer(http.Dir(assets)))
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/ecosystem/") {
			static.ServeHTTP(w, r)
			return
		}
		if r.Method == http.MethodPost && (r.URL.Path == "/__fixture/updating" || r.URL.Path == "/__fixture/ready") {
			raw, _ := json.Marshal(map[string]any{"active": r.URL.Path == "/__fixture/updating", "ready": r.URL.Path == "/__fixture/ready", "current_version": "0.5.6", "operation": scopedMaintenanceOperation("doska")})
			path := filepath.Join(folder, "status.json")
			if err := os.WriteFile(path+".tmp", raw, 0600); err != nil {
				http.Error(w, "fixture write failed", 500)
				return
			}
			if err := os.Rename(path+".tmp", path); err != nil {
				http.Error(w, "fixture rename failed", 500)
				return
			}
			w.WriteHeader(204)
			return
		}
		if r.URL.Path == "/doska/projects/project_1" {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Write([]byte("<!doctype html><h1>Native fixture ready</h1>"))
			return
		}
		w.WriteHeader(204)
	})
	backend := httptest.NewServer(s.maintenanceGate(next))
	defer backend.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	script := `import assert from 'node:assert/strict'; import {pathToFileURL} from 'node:url';
const {chromium,webkit}=await import(pathToFileURL(process.argv[2]).href); const origin=process.argv[1];
for(const [name,engine,options] of [['chromium',chromium,{channel:'chrome',timeout:10000}],['webkit',webkit,{timeout:10000}]]){
 const browser=await engine.launch(options);
 try{
  for(const theme of ['light','dark','night']){
   const active=await fetch(origin+'/__fixture/updating',{method:'POST'});assert.equal(active.status,204);
   const page=await browser.newPage({viewport:{width:1920,height:1080}});page.setDefaultTimeout(6000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
   try{
    await page.addInitScript(value=>localStorage.setItem('pl-ui-theme',value),theme);
    const response=await page.goto(origin+'/doska/projects/project_1?taskId=task_1');assert.equal(response.status(),503);
    await page.getByRole('heading',{name:'Модуль обновляется',exact:true}).waitFor();
    const palette=await page.evaluate(()=>({theme:window.PLTheme.get(),body:getComputedStyle(document.body).backgroundColor,root:getComputedStyle(document.documentElement).backgroundColor,overflow:document.documentElement.scrollWidth>innerWidth}));
    assert.equal(palette.theme,theme);assert.equal(palette.body,palette.root);assert.equal(palette.overflow,false);
    await page.setViewportSize({width:3440,height:1440});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    const api=await page.request.get(origin+'/doska/api/doska/context',{headers:{Accept:'application/json'}});assert.equal(api.status(),503);assert.equal((await api.json()).error,'module_updating');
    const neighbour=await page.request.post(origin+'/forms/api/v1/surveys');assert.equal(neighbour.status(),204);
    assert.equal((await fetch(origin+'/__fixture/ready',{method:'POST'})).status,204);
    await page.getByRole('heading',{name:'Native fixture ready',exact:true}).waitFor();
    assert.match(page.url(),/\/doska\/projects\/project_1\?taskId=task_1$/);assert.deepEqual(errors,[]);
   }finally{await page.close();}
  }
  console.log(name+': three themes, two desktop widths, JSON isolation and real automatic return passed');
 }finally{await browser.close();}
}`
	command := exec.CommandContext(ctx, node, "--input-type=module", "-e", script, backend.URL, playwright)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("native maintenance browser checks failed: %v\n%s", err, output)
	} else {
		t.Log(string(output))
	}
}

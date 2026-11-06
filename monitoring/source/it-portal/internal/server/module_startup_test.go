package server

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"pl/portal/internal/model"
)

func TestModuleStartupPageStages(t *testing.T) {
	for _, tc := range []struct {
		stage     moduleStartupStage
		title     string
		automatic bool
	}{
		{moduleStartupQueued, "Модуль ожидает запуска", true},
		{moduleStartupInstalling, "Устанавливаем модуль", true},
		{moduleStartupStarting, "Модуль запускается", true},
		{moduleStartupUpdating, "Модуль обновляется", true},
		{moduleStartupFailed, "Не удалось запустить модуль", false},
		{"unexpected", "Не удалось запустить модуль", false},
	} {
		t.Run(string(tc.stage), func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/forms/?view=all", nil)
			w := httptest.NewRecorder()
			renderModuleStartupPage(w, r, model.ModuleInstance{Name: "Forms", Error: "private controller failure"}, tc.stage)
			body := w.Body.String()
			if w.Code != http.StatusServiceUnavailable || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Content-Type") != "text/html; charset=utf-8" {
				t.Fatalf("wrong status or cache/content contract: %d %v", w.Code, w.Header())
			}
			if !strings.Contains(body, tc.title) || !strings.Contains(body, "Forms · PL") || !strings.Contains(body, `href="/forms/?view=all"`) || !strings.Contains(body, `href="/#modules"`) {
				t.Fatalf("missing stage, name or actions: %s", body)
			}
			if strings.Contains(body, "private controller failure") || strings.Contains(body, "aria-valuenow") {
				t.Fatal("raw controller error or fake percentage in user copy")
			}
			if got := strings.Contains(body, moduleStartupReloadJS); got != tc.automatic {
				t.Fatalf("automatic retry = %v, want %v", got, tc.automatic)
			}
			if tc.automatic {
				if w.Header().Get("Retry-After") != "2" || !strings.Contains(body, `role="status"`) {
					t.Fatal("starting page must explain and pace the automatic retry")
				}
			} else if w.Header().Get("Retry-After") != "" || strings.Contains(body, "откроется автоматически") {
				t.Fatal("failed page must not promise automatic progress")
			}
		})
	}
}

func TestModuleStartupPageEscapesUntrustedText(t *testing.T) {
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/doska/?q=%22%3E%3Cscript%3Eevil%3C/script%3E", nil)
	renderModuleStartupPage(w, r, model.ModuleInstance{Name: `</title><script>alert("name")</script>`, Error: `<script>alert("error")</script>`}, moduleStartupStarting)
	body := w.Body.String()
	if strings.Contains(body, `<script>alert(`) || strings.Contains(body, `</title><script>`) || strings.Contains(body, `alert("error")`) {
		t.Fatal("untrusted name/error was emitted as executable markup")
	}
	if !strings.Contains(body, "&lt;/title&gt;&lt;script&gt;") {
		t.Fatal("instance name must be escaped as visible text")
	}
	if strings.Count(body, "<script>") != 1 || !strings.Contains(body, "<script>"+moduleStartupReloadJS+"</script>") {
		t.Fatal("only fixed trusted reload code may appear in an inline script")
	}
}

func TestModuleStartupPageThemeCSPAndMotion(t *testing.T) {
	for _, stage := range []moduleStartupStage{moduleStartupStarting, moduleStartupFailed} {
		w := httptest.NewRecorder()
		renderModuleStartupPage(w, httptest.NewRequest(http.MethodGet, "/wayline/", nil), model.ModuleInstance{Name: "Wayline"}, stage)
		body, policy := w.Body.String(), w.Header().Get("Content-Security-Policy")
		for _, path := range []string{"/ecosystem/theme-catalog.js", "/ecosystem/theme-runtime.js", "/ecosystem/theme-menu.css", "/ecosystem/ui-v1.css"} {
			if !strings.Contains(body, `"`+path+`"`) {
				t.Fatalf("missing central asset %s", path)
			}
		}
		if strings.Index(body, "/ecosystem/theme-catalog.js") > strings.Index(body, "/ecosystem/theme-runtime.js") || strings.Index(body, "/ecosystem/theme-runtime.js") > strings.Index(body, "<style>") {
			t.Fatal("central catalog/runtime must apply stored theme before page styles")
		}
		for _, required := range []string{"default-src 'none'", "script-src 'self'", "style-src 'self' " + moduleStartupHash(moduleStartupCSS), "base-uri 'none'", "form-action 'none'", "frame-ancestors 'self'"} {
			if !strings.Contains(policy, required) {
				t.Fatalf("missing CSP protection %s", required)
			}
		}
		if strings.Contains(policy, "unsafe-inline") || strings.Contains(body, "http://") || strings.Contains(body, "https://") || strings.Contains(body, "onload=") || strings.Contains(body, "onclick=") {
			t.Fatal("page must use same-origin assets, CSP hashes and no inline event handlers")
		}
		if got := strings.Contains(policy, moduleStartupHash(moduleStartupReloadJS)); got != (stage == moduleStartupStarting) {
			t.Fatal("reload script hash must be allowed exactly when automatic retry is present")
		}
		for _, required := range []string{"var(--pl-ui-bg", "var(--pl-ui-text", "prefers-reduced-motion:reduce", "animation:none", ":focus-visible", `aria-labelledby="module-startup-title"`} {
			if !strings.Contains(body, required) {
				t.Fatalf("missing theme/accessibility behavior %s", required)
			}
		}
	}
}

func TestModuleStartupRetryURLStaysOnOrigin(t *testing.T) {
	for _, tc := range []struct{ path, rawPath, query, want string }{
		{"/doska/projects/p-1", "", "view=all&label=a%20b", "/doska/projects/p-1?view=all&label=a%20b"},
		{"/forms/", "", "next=https://elsewhere.test/", "/forms/?next=https://elsewhere.test/"},
		{"//elsewhere.test/", "", "", "/#modules"},
		{"//elsewhere.test/", "/%2Felsewhere.test/", "", "/#modules"},
		{"/\\elsewhere.test/", "", "", "/#modules"},
		{"/doska/\nwrong", "", "", "/#modules"},
		{"javascript:alert(1)", "", "", "/#modules"},
		{"", "", "", "/#modules"},
	} {
		r := &http.Request{URL: &url.URL{Path: tc.path, RawPath: tc.rawPath, RawQuery: tc.query}}
		if got := moduleStartupRetryURL(r); got != tc.want {
			t.Errorf("retry %q: got %q, want %q", tc.path, got, tc.want)
		}
	}
	if got := moduleStartupRetryURL(&http.Request{}); got != "/#modules" {
		t.Fatalf("nil URL retry: %q", got)
	}
}

func TestModuleStartupPageHeadAndUnnamed(t *testing.T) {
	w := httptest.NewRecorder()
	renderModuleStartupPage(w, httptest.NewRequest(http.MethodHead, "/forms/", nil), model.ModuleInstance{}, moduleStartupInstalling)
	if w.Code != 503 || w.Body.Len() != 0 || w.Header().Get("Retry-After") != "2" {
		t.Fatal("HEAD must have startup status/headers and no document body")
	}
	w = httptest.NewRecorder()
	renderModuleStartupPage(w, httptest.NewRequest(http.MethodGet, "/forms/", nil), model.ModuleInstance{Name: "  "}, moduleStartupStarting)
	if !strings.Contains(w.Body.String(), "Модуль · PL") {
		t.Fatal("empty display name must remain understandable")
	}
}

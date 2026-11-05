package server

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
	"pl/portal/internal/model"
	"pl/portal/internal/modules"
)

type netmapStartupBackend struct {
	*modules.Manager
	calls atomic.Int32
}

func (b *netmapStartupBackend) ApplicationKey(context.Context, string) ([]byte, error) {
	return bytes.Repeat([]byte{7}, 32), nil
}
func (b *netmapStartupBackend) NetMapRequest(context.Context, string, string, string, string, string, http.Header, []byte) (*http.Response, error) {
	b.calls.Add(1)
	return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"text/html"}}, Body: io.NopCloser(strings.NewReader("ready NetMap"))}, nil
}

func TestNetmapStartupPostgreSQLHTTP(t *testing.T) {
	s := apiFixture(t)
	ctx := context.Background()
	admin, viewer := apiUser(t, s, "netmap-startup-admin", true), apiUser(t, s, "netmap-startup-viewer", false)
	v, j, err := s.Store.QueueModule(ctx, "netmap-startup-admin", "netmap-startup:install", "", "install", model.ModuleRequest{ModuleID: "netmap", Mode: "local", Name: "NetMap <QA>"})
	if err != nil {
		t.Fatal(err)
	}
	backend := &netmapStartupBackend{Manager: modules.New(s.Store, nil)}
	g := &netmapHandler{server: s, backend: backend, session: s.readSession, slots: make(chan struct{}, 2), waiting: make(chan struct{}, 16)}
	call := func(who apiIdentity, method, path string, headers map[string]string, mapped bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, s.Config.PublicURL+path, nil)
		r.Header.Set("Accept", "text/html")
		r.RemoteAddr = "192.0.2.10:1234"
		if who.cookie != nil {
			r.AddCookie(who.cookie)
		}
		for k, v := range headers {
			r.Header.Set(k, v)
		}
		id := ""
		if mapped {
			id = v.ID
			r.SetPathValue("path", "networks")
		}
		w := httptest.NewRecorder()
		g.serve(w, r, id, mapped)
		return w
	}
	page := func(title string, automatic bool) {
		t.Helper()
		for _, path := range []string{"/netmap/", "/netmap/index.html"} {
			w := call(admin, "GET", path, nil, false)
			if w.Code != 503 || w.Header().Get("Content-Type") != "text/html; charset=utf-8" || !strings.Contains(w.Body.String(), title) || !strings.Contains(w.Body.String(), "NetMap &lt;QA&gt;") || (w.Header().Get("Retry-After") == "2") != automatic {
				t.Fatalf("%s startup stage %d %v %s", path, w.Code, w.Header(), w.Body.String())
			}
		}
	}
	page("Модуль ожидает запуска", true)
	if w := call(admin, "HEAD", "/netmap/", nil, false); w.Code != 503 || w.Body.Len() != 0 || w.Header().Get("Retry-After") != "2" {
		t.Fatal("HEAD startup contract", w.Code)
	}
	if w := call(viewer, "GET", "/netmap/", nil, false); w.Code != 403 || strings.Contains(w.Header().Get("Content-Type"), "text/html") {
		t.Fatal("viewer gained startup access", w.Code)
	}
	if w := call(apiIdentity{}, "GET", "/netmap/", nil, false); w.Code != 303 || w.Header().Get("Location") != "/401?return_to=%2Fnetmap%2F" {
		t.Fatal("login redirect changed", w.Code)
	}
	if w := call(apiIdentity{}, "GET", "/netmap/api/health", nil, false); w.Code != 401 || strings.Contains(w.Header().Get("Content-Type"), "text/html") {
		t.Fatal("anonymous API changed", w.Code)
	}
	for _, path := range []string{"/netmap/api/health", "/netmap/app.js", "/netmap/style.css", "/netmap/unknown", "/netmap/?scope=network", "/netmap/index.html?scope=network", "/netmap/netbox/", "/netmap/gitea/", "/netmap/oxidized/"} {
		w := call(admin, "GET", path, nil, false)
		if strings.Contains(w.Header().Get("Content-Type"), "text/html") || w.Code == 200 {
			t.Fatal("non-entry request got startup HTML", path, w.Code)
		}
	}
	for _, headers := range []map[string]string{{"Accept": "application/json"}, {"Sec-Fetch-Dest": "script"}, {"Sec-Fetch-Mode": "cors"}, {"Authorization": "Bearer fixture"}} {
		w := call(admin, "GET", "/netmap/", headers, false)
		if strings.Contains(w.Header().Get("Content-Type"), "text/html") {
			t.Fatal("non-navigation got startup HTML", headers)
		}
	}
	if w := call(admin, "GET", "/api/v1/modules/"+v.ID+"/netmap/networks", nil, true); w.Code != 503 || strings.Contains(w.Header().Get("Content-Type"), "text/html") {
		t.Fatal("mapped API changed", w.Code)
	}
	claimed, err := s.Store.Claim(ctx)
	if err != nil || claimed.ID != j.ID {
		t.Fatal("claim", err)
	}
	page("Устанавливаем модуль", true)
	claimed.Status, claimed.Error = "failed", "private controller detail"
	if err = s.Store.Finish(ctx, claimed); err != nil {
		t.Fatal(err)
	}
	page("Не удалось запустить модуль", false)
	v, j, err = s.Store.QueueModule(ctx, "netmap-startup-admin", "netmap-startup:enable", v.ID, "enable", model.ModuleRequest{})
	if err != nil {
		t.Fatal(err)
	}
	page("Модуль ожидает запуска", true)
	claimed, err = s.Store.Claim(ctx)
	if err != nil || claimed.ID != j.ID {
		t.Fatal("enable claim", err)
	}
	page("Модуль запускается", true)
	v.ObservedState, v.Version = "running", "1.0.0"
	claimed.Status, claimed.Result = "succeeded", map[string]any{"instance": v}
	if err = s.Store.Finish(ctx, claimed); err != nil {
		t.Fatal(err)
	}
	if w := call(admin, "GET", "/netmap/", nil, false); w.Code != 200 || w.Body.String() != "ready NetMap" || backend.calls.Load() != 1 {
		t.Fatalf("ready native route did not regain ownership %d %s", w.Code, w.Body.String())
	}
	// An additional persisted external alias makes selection ambiguous, not busy.
	duplicate := v
	duplicate.ID, duplicate.Mode = uuid.NewString(), "external"
	if _, err = s.Store.Save(ctx, "module_instance", duplicate.ID, 0, duplicate, "fixture"); err != nil {
		t.Fatal(err)
	}
	if w := call(admin, "GET", "/netmap/", nil, false); w.Code != 503 || strings.Contains(w.Header().Get("Content-Type"), "text/html") {
		t.Fatal("ambiguous alias became startup progress", w.Code)
	}
}

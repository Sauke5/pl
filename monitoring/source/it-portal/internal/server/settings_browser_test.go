//go:build browser_fixture

package server

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"syscall"
	"testing"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/store"
)

// Opt-in UI -> real Go API -> disposable PostgreSQL fixture. All provider reads
// terminate at a local httptest server; no worker, scans or notifications start.
func TestSettingsBrowserFixture(t *testing.T) {
	if os.Getenv("PORTAL_SETTINGS_BROWSER") != "true" {
		t.Fatal("opt-in local settings browser fixture")
	}
	origin := os.Getenv("PORTAL_SETTINGS_BROWSER_ORIGIN")
	if origin == "" {
		origin = "http://localhost:8139"
	}
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "http" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" || (u.Hostname() != "localhost" && u.Hostname() != "127.0.0.1" && u.Hostname() != "::1") {
		t.Fatal("PORTAL_SETTINGS_BROWSER_ORIGIN must be an HTTP loopback origin")
	}
	s := apiFixture(t)
	s.Config.PublicURL, s.Config.Demo = origin, true
	s.Providers = settingsProbeProvider(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/draft/api/v1/targets" || r.Host != "draft.example.test" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"success","data":{"activeTargets":[{"labels":{"job":"linux","instance":"fixture-host:9100"},"scrapeUrl":"http://fixture-host.example.test:9100/metrics","health":"up"}]}}`))
	})
	ctx := context.Background()
	observed := time.Now().UTC()
	if _, err = s.Store.Save(ctx, "integration", "settings-browser-source", 0, model.Integration{
		ID: "settings-browser-source", Name: "Локальный Prometheus", Kind: "prometheus", URL: "http://draft.example.test/draft", Enabled: true,
		PollSeconds: 60, TimeoutSeconds: 10, Concurrency: 2, Status: "connected", LastSuccess: &observed, LastAttempt: &observed,
		Capabilities: []string{"discovery"}, Config: map[string]string{"discovery_enabled": "true"},
	}, "fixture"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Store.Save(ctx, "resource", "settings-browser-resource", 0, model.Resource{
		ID: "settings-browser-resource", Name: "Локальный ресурс", Type: "Приложение", URL: "https://resource.example.test", Lifecycle: "active", Directions: []string{"Мониторинг"},
	}, "fixture"); err != nil {
		t.Fatal(err)
	}
	settings, err := store.Get[model.Settings](ctx, s.Store, "settings", "global")
	if err != nil {
		t.Fatal(err)
	}
	settings.BoardEnabled, settings.BoardAnonymous = true, false
	settings.BoardTitle, settings.BoardResourceIDs = "Локальная публикация", []string{"settings-browser-resource"}
	if _, err = s.Store.Save(ctx, "settings", "global", settings.Revision, settings, "fixture"); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	s.RegisterSettingsWorkspace(mux)
	s.RegisterSettingsProbe(mux)
	mux.Handle("/", s.Handler())
	listener, err := net.Listen("tcp", "127.0.0.1:8140")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	t.Cleanup(func() { _ = srv.Close() })
	signals, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	lifetime, cancel := context.WithTimeout(signals, 30*time.Minute)
	defer cancel()
	go func() {
		<-lifetime.Done()
		shutdown, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = srv.Shutdown(shutdown)
	}()
	t.Log("Isolated settings browser fixture listening on 127.0.0.1:8140; origin", origin)
	if err = srv.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		t.Fatal(err)
	}
}

//go:build browser_fixture

package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"pl/portal/internal/model"
	"pl/portal/internal/netguard"
	"pl/portal/internal/providers"
	"pl/portal/internal/store"
)

type workspaceFixtureProblem struct {
	model.Problem
	Revision int64 `json:"revision"`
}

type workspaceFixtureDNS struct{}

func (workspaceFixtureDNS) LookupIPAddr(context.Context, string) ([]net.IPAddr, error) {
	return []net.IPAddr{{IP: net.ParseIP("10.0.0.5")}}, nil
}

// Opt-in only, disposable PG schema, loopback listener and fake provider dialer.
// No worker, production credentials, provider polling or real checks are started.
func TestWorkspaceBrowserFixture(t *testing.T) {
	if os.Getenv("PORTAL_WORKSPACE_BROWSER") != "true" {
		t.Fatal("opt-in isolated browser fixture")
	}
	s := apiFixture(t)
	s.Config.PublicURL = "http://localhost:18199"
	s.Config.Demo = true
	var unavailable atomic.Bool
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if unavailable.Load() {
			http.Error(w, "fixture source unavailable", 503)
			return
		}
		if r.URL.Path == "/api/v1/targets" {
			_, _ = w.Write([]byte(`{"status":"success","data":{"activeTargets":[{"labels":{"job":"windows","instance":"RDSH-test:9182","service":"rds"}}]}}`))
			return
		}
		value := "4294967296"
		if strings.Contains(r.URL.Query().Get("query"), "timestamp(") {
			value = fmt.Sprint(time.Now().Unix())
		}
		_, _ = fmt.Fprintf(w, `{"status":"success","data":{"resultType":"vector","result":[{"metric":{"instance":"RDSH-test:9182"},"value":[%d,%q]}]}}`, time.Now().Unix(), value)
	}))
	t.Cleanup(fake.Close)
	address := strings.TrimPrefix(fake.URL, "http://")
	guard, err := netguard.NewWithDependencies([]string{"10.0.0.0/8"}, []int{80, 443}, "", workspaceFixtureDNS{}, func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, address)
	})
	if err != nil {
		t.Fatal(err)
	}
	s.Providers = providers.New(guard, "")
	now := time.Now().UTC()
	ctx := context.Background()
	source := model.Integration{ID: "workspace-prom", Name: "Локальный Prometheus", Kind: "prometheus", URL: "http://workspace-source.test", Enabled: true, Status: "connected", LastSuccess: &now}
	if _, err = s.Store.Save(ctx, "integration", source.ID, 0, source, "fixture"); err != nil {
		t.Fatal(err)
	}
	alert := model.Integration{ID: "workspace-alerts", Name: "Локальный Alertmanager", Kind: "alertmanager", Enabled: true, Status: "connected", LastSuccess: &now}
	if _, err = s.Store.Save(ctx, "integration", alert.ID, 0, alert, "fixture"); err != nil {
		t.Fatal(err)
	}
	resource := model.Resource{ID: "workspace-rds", Name: "RDSH-проверка", Type: "Сервер", Hostname: "RDSH-test", Lifecycle: "active", URL: "https://rds.example.test", Directions: []string{"Инфраструктура"}, Check: model.Check{Kind: "tcp", Target: "rds.example.test:3389"}}
	if _, err = s.Store.Save(ctx, "resource", resource.ID, 0, resource, "fixture"); err != nil {
		t.Fatal(err)
	}
	// Personal shortcut groups contain applications; the server remains a
	// separate infrastructure object used by the system editor and metrics.
	application := model.Resource{ID: "workspace-rds-app", Name: "RDS — панель", Type: "Приложение", Lifecycle: "active", URL: "https://rds-panel.example.test", Directions: []string{"Управление"}}
	if _, err = s.Store.Save(ctx, "resource", application.ID, 0, application, "fixture"); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"ARCH-проверка", "SFTP-проверка"} {
		r := model.Resource{ID: uuid.NewString(), Name: name, Type: "Сервер", Hostname: "file.example.test", Lifecycle: "active", Directions: []string{"Инфраструктура"}}
		if _, err = s.Store.Save(ctx, "resource", r.ID, 0, r, "fixture"); err != nil {
			t.Fatal(err)
		}
	}
	for _, p := range []model.Problem{
		{ID: "fixture-internal", IntegrationID: alert.ID, ExternalID: "internal", ResourceID: resource.ID, Title: "Внутреннее приложение недоступно", Severity: "critical", Status: "firing", StartedAt: now.Add(-time.Hour), LastSeen: now, Labels: map[string]string{"alertname": "WebsiteDown", "instance": "https://internal.example.test/", "portal_resource_id": resource.ID}},
		{ID: "fixture-marketing", IntegrationID: alert.ID, ExternalID: "marketing", Title: "Публичный сайт недоступен", Severity: "critical", Status: "firing", StartedAt: now.Add(-time.Hour), LastSeen: now, Labels: map[string]string{"alertname": "WebsiteDown", "instance": "https://marketing.example.test/"}},
	} {
		if _, err = s.Store.Save(ctx, "problem", p.ID, 0, p, "fixture"); err != nil {
			t.Fatal(err)
		}
	}
	policy := problemPresentation{ResourceIDs: []string{}, Targets: []marketingTarget{{IntegrationID: alert.ID, Instance: "https://marketing.example.test/"}}}
	if _, err = s.Store.Save(ctx, "problem_presentation", "global", 0, policy, "fixture"); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /fixture/login", func(w http.ResponseWriter, r *http.Request) {
		// A fixture login represents a fresh mocked source poll. No provider or worker is run.
		fresh := time.Now().UTC()
		for _, sourceID := range []string{"workspace-prom", "workspace-alerts"} {
			saved, err := store.Get[model.Integration](r.Context(), s.Store, "integration", sourceID)
			if err != nil {
				s.fail(w, err)
				return
			}
			saved.LastSuccess = &fresh
			if _, err = s.Store.Save(r.Context(), "integration", sourceID, saved.Revision, saved, "fixture"); err != nil {
				s.fail(w, err)
				return
			}
		}
		for _, problemID := range []string{"fixture-internal", "fixture-marketing"} {
			saved, err := store.Get[workspaceFixtureProblem](r.Context(), s.Store, "problem", problemID)
			if err != nil {
				s.fail(w, err)
				return
			}
			saved.LastSeen = fresh
			if _, err = s.Store.Save(r.Context(), "problem", problemID, saved.Revision, saved.Problem, "fixture"); err != nil {
				s.fail(w, err)
				return
			}
		}
		id, name := "alice", "Алексей"
		if r.URL.Query().Get("user") == "bob" {
			id, name = "bob", "Иван"
		}
		if err := s.newSession(w, r, model.User{ID: id, Name: name, Admin: true}, time.Now().Add(time.Hour)); err != nil {
			s.fail(w, err)
			return
		}
		respond(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("POST /fixture/source", func(w http.ResponseWriter, r *http.Request) {
		unavailable.Store(r.URL.Query().Get("state") == "down")
		w.WriteHeader(204)
	})
	mux.HandleFunc("POST /fixture/complete", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			ID string `json:"id"`
		}
		if json.NewDecoder(r.Body).Decode(&input) != nil {
			w.WriteHeader(400)
			return
		}
		job, err := s.Store.Job(r.Context(), input.ID)
		if err != nil {
			s.fail(w, err)
			return
		}
		job.Status = "succeeded"
		job.Result = map[string]any{"kind": job.Parameters["kind"], "target": job.Parameters["target"], "observed_at": time.Now().UTC().Format(time.RFC3339), "latency_ms": 4.0}
		if err = s.Store.Finish(r.Context(), job); err != nil {
			s.fail(w, err)
			return
		}
		w.WriteHeader(204)
	})
	workspace := http.NewServeMux()
	s.registerWorkspaceRoutes(workspace)
	workspace.Handle("/", s.Handler())
	mux.Handle("/", workspace)
	listener, err := net.Listen("tcp", "127.0.0.1:18182")
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	t.Cleanup(func() { server.Close() })
	t.Log("Workspace fixture on 127.0.0.1:18182; provider is isolated and worker disabled")
	if err = server.Serve(listener); err != nil && err != http.ErrServerClosed {
		t.Fatal(err)
	}
}

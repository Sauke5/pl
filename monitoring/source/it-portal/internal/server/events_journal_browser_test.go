//go:build browser_fixture

package server

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"testing"
	"time"
)

// Opt-in browser fixture backed by an isolated PostgreSQL schema. No worker or
// outbound provider polling is started. Closing the test removes only its schema.
func TestEventJournalBrowserFixture(t *testing.T) {
	if os.Getenv("PORTAL_EVENTS_BROWSER") != "true" {
		t.Fatal("opt-in local browser fixture")
	}
	s := apiFixture(t)
	s.Config.PublicURL = "http://localhost:8099"
	s.Config.Demo = true
	if e := s.Store.SeedDemo(context.Background()); e != nil {
		t.Fatal(e)
	}
	for n := 0; n < 75; n++ {
		source, kind := "platform", "job.succeeded"
		if n%3 == 0 {
			source, kind = "prometheus", "target.down"
		}
		if n%3 == 1 {
			source, kind = "alertmanager", "problem.firing"
		}
		if e := s.Store.Event(context.Background(), kind, fmt.Sprintf("Локальная проверка журнала · %02d", n), "", "system", map[string]any{"source_kind": source, "time_basis": "source", "occurred_at": time.Now().Add(-time.Duration(n) * time.Minute).UTC().Format(time.RFC3339Nano), "description": "Изолированные данные для проверки интерфейса и PostgreSQL API"}, false); e != nil {
			t.Fatal(e)
		}
	}
	listener, e := net.Listen("tcp", "127.0.0.1:8082")
	if e != nil {
		t.Fatal(e)
	}
	srv := &http.Server{Handler: s.Handler(), ReadHeaderTimeout: 5 * time.Second}
	t.Cleanup(func() { srv.Close() })
	t.Log("Isolated journal browser fixture listening on loopback port 8082")
	if e = srv.Serve(listener); e != nil && e != http.ErrServerClosed {
		t.Fatal(e)
	}
}

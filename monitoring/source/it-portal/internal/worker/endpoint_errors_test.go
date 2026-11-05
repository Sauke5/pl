package worker

import (
	"context"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"pl/portal/internal/model"
	"pl/portal/internal/netguard"
	"pl/portal/internal/providers"
)

func TestWorkerPersistsSafeCertificateCauseAndPreservesUnknownReport(t *testing.T) {
	s := workerStore(t)
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("untrusted TLS request reached application") }))
	srv.Config.ErrorLog = log.New(io.Discard, "", 0)
	srv.StartTLS()
	defer srv.Close()
	guard, e := netguard.NewWithDependencies([]string{"10.0.0.0/8"}, []int{80, 443}, "", testResolver{}, func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(srv.URL, "https://"))
	})
	if e != nil {
		t.Fatal(e)
	}
	w := New(s, providers.New(guard, ""), func(string) {})
	for _, kind := range []string{"enrich", "check"} {
		job, e := s.Enqueue(context.Background(), model.Job{Kind: kind, Actor: "test", IdempotencyKey: kind, Parameters: map[string]any{"kind": "http", "target": "https://example.com/private?token=do-not-expose"}})
		if e != nil {
			t.Fatal(e)
		}
		w.execute(context.Background(), job)
		got, e := s.Job(context.Background(), job.ID)
		if e != nil || got.Status != "failed" || got.Error != "Портал не доверяет сертификату этого сайта." {
			t.Fatal(got.Status, got.Error, e)
		}
		if strings.Contains(got.Error, "do-not-expose") || strings.Contains(got.Error, "example.com") {
			t.Fatal("unsafe error persisted")
		}
	}
	integration := workerIntegration(t, s, "reports")
	integration.URL = "https://example.com"
	if _, e = s.Save(context.Background(), "integration", integration.ID, integration.Revision, integration, "test"); e != nil {
		t.Fatal(e)
	}
	job, e := s.Enqueue(context.Background(), model.Job{Kind: "report", Actor: "test", IntegrationID: integration.ID, IdempotencyKey: "report-uncertain", Parameters: map[string]any{}})
	if e != nil {
		t.Fatal(e)
	}
	w.execute(context.Background(), job)
	got, e := s.Job(context.Background(), job.ID)
	if e != nil || got.Status != "unknown" || !strings.Contains(got.Error, "Автоматический повтор запрещён") {
		t.Fatal("changed report outcome semantics", got.Status, got.Error, e)
	}
}

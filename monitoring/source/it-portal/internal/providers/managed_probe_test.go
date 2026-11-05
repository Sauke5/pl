package providers

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"pl/portal/internal/model"
)

func TestSettingsProbeUsesInstalledModuleTransportWithoutDraftCredentials(t *testing.T) {
	for _, kind := range []string{"prometheus", "alertmanager", "grafana", "wayline", "fileauditor"} {
		t.Run(kind, func(t *testing.T) {
			registry := New(nil, "")
			integration := model.Integration{ID: "installed-source", ManagedModuleID: "owned-module", Kind: kind, Enabled: true, URL: "not-an-authoritative-origin", SecretRef: "not-allowlisted", Config: map[string]string{"module_mode": "local", "basic_username": "ignored"}}
			calls := 0
			read := func(_ context.Context, got model.Integration, path, query string) (*http.Response, error) {
				calls++
				if got.ID != integration.ID || got.ManagedModuleID != integration.ManagedModuleID {
					t.Fatal("managed identity was replaced")
				}
				var body string
				switch path {
				case "/api/v1/targets":
					body = `{"status":"success","data":{"activeTargets":[]}}`
					if kind == "wayline" {
						body = `{"targets":[]}`
					}
				case "/api/v2/alerts":
					body = `[]`
				case "/api/health":
					body = `{"database":"ok"}`
				case "/api/v1/checks/latest":
					if query != "kind=path" && query != "kind=iperf" {
						t.Fatal("unexpected Wayline route")
					}
					body = `{"checks":[]}`
				default:
					t.Fatal("unbounded module route", path)
				}
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body))}, nil
			}
			registry.ManagedRead = read
			registry.ManagedRequest = func(ctx context.Context, got model.Integration, method, path, query, contentType string, body []byte) (*http.Response, error) {
				if method != http.MethodGet || contentType != "" || len(body) != 0 {
					t.Fatal("probe attempted a managed mutation")
				}
				return read(ctx, got, path, query)
			}
			registry.FileAuditorProbe = func(context.Context, model.Integration) error { calls++; return nil }
			out := registry.ProbeIntegration(context.Background(), integration)
			wanted := 1
			if kind == "wayline" {
				wanted = 3
			}
			if out.Status != "connected" || calls != wanted || out.CheckedAt.IsZero() {
				t.Fatalf("managed probe=%+v calls=%d", out, calls)
			}
			registry.ManagedRead = nil
			registry.ManagedRequest = nil
			registry.FileAuditorProbe = func(context.Context, model.Integration) error { return errors.New("unavailable") }
			if failed := registry.ProbeIntegration(context.Background(), integration); failed.Status == "connected" {
				t.Fatal("managed source failure hidden")
			}
		})
	}
}

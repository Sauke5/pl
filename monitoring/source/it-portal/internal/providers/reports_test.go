package providers

import (
	"context"
	"net/http"
	"os"
	"pl/portal/internal/model"
	"strings"
	"testing"
)

func TestReportManifestExistingDailyWeeklyContract(t *testing.T) {
	fixture, e := os.ReadFile("testdata/reports.json")
	if e != nil {
		t.Fatal(e)
	}
	t.Setenv("PORTAL_SECRET_REFS", "env:PORTAL_SECRET_REPORT_TEST")
	t.Setenv("PORTAL_SECRET_REPORT_TEST", "test-only-token")
	health, manifest := 0, 0
	r := registry(t, func(w http.ResponseWriter, q *http.Request) {
		switch q.URL.Path {
		case "/health":
			health++
			if q.Header.Get("Authorization") == "" {
				t.Error("health lost configured auth")
			}
			_, _ = w.Write([]byte(`{"ok":true}`))
		case "/internal/reports/manifest":
			manifest++
			if q.Host != "generator" || q.Header.Get("Authorization") != "" {
				t.Error("internal manifest credential isolation failed")
			}
			_, _ = w.Write(fixture)
		default:
			t.Error("unexpected request", q.URL.Path)
			w.WriteHeader(404)
		}
	})
	i := model.Integration{Kind: "reports", URL: "http://generator", SecretRef: "env:PORTAL_SECRET_REPORT_TEST", Config: map[string]string{"reports_base_url": "http://archive"}}
	s, e := r.Poll(context.Background(), i)
	if e != nil || len(s.Reports) != 87 || health != 1 || manifest != 1 {
		t.Fatalf("reports=%d health=%d manifest=%d err=%v", len(s.Reports), health, manifest, e)
	}
	daily, weekly := 0, 0
	for _, v := range s.Reports {
		if !v.CreatedAt.IsZero() || v.JobID != "" || v.Status != "succeeded" || !strings.HasPrefix(v.URL, "http://archive/reports/infrastructure-") {
			t.Fatal(v)
		}
		switch v.ReportType {
		case "daily":
			daily++
		case "weekly":
			weekly++
			if !strings.Contains(v.Period, " — ") {
				t.Fatal(v)
			}
		}
	}
	if daily != 76 || weekly != 11 {
		t.Fatal(daily, weekly)
	}
}

func TestReportManifestRejectsMalformedUnsafeAndRedirect(t *testing.T) {
	valid := `[{"report_type":"daily","file":"infrastructure-2026-09-24-run-93.html","date":"2026-09-24","run":93}]`
	for _, body := range []string{"null", `{}`, `[{}]`, strings.Replace(valid, "infrastructure-2026-09-24-run-93.html", "../private", 1), strings.Replace(valid, "infrastructure-2026-09-24-run-93.html", "https://evil.test/report.html", 1), strings.Replace(valid, "infrastructure-2026-09-24-run-93.html", "infrastructure-2026-09-24-run-93.html?token=x", 1), strings.Replace(valid, `"run":93`, `"run":1`, 1), strings.Replace(valid, `"date":"2026-09-24"`, `"date":"2026-02-30"`, 1), `[{"report_type":"weekly","file":"infrastructure-weekly-2026-W38-run-1.html","iso_year":2026,"iso_week":38,"period_start":"2026-09-14","period_end":"2026-09-21","run":1}]`} {
		t.Run(body, func(t *testing.T) {
			r := registry(t, func(w http.ResponseWriter, q *http.Request) {
				if q.URL.Path == "/health" {
					_, _ = w.Write([]byte(`{"ok":true}`))
					return
				}
				_, _ = w.Write([]byte(body))
			})
			if _, e := r.Poll(context.Background(), model.Integration{Kind: "reports", URL: "http://test"}); e == nil {
				t.Fatal("accepted invalid manifest")
			}
		})
	}
	t.Run("redirect not followed", func(t *testing.T) {
		calls := 0
		r := registry(t, func(w http.ResponseWriter, q *http.Request) {
			calls++
			if q.URL.Path == "/health" {
				_, _ = w.Write([]byte(`{"ok":true}`))
				return
			}
			http.Redirect(w, q, "http://elsewhere/private", 302)
		})
		if _, e := r.Poll(context.Background(), model.Integration{Kind: "reports", URL: "http://test"}); e == nil || calls != 2 {
			t.Fatal("redirect followed", calls, e)
		}
	})
}

//go:build optional_module_acceptance

package providers

import (
	"context"
	"os"
	"testing"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/netguard"
)

// Opt-in read-only acceptance against an existing configured Grafana account.
// Credentials remain in the normal allowlisted secret resolver, never test output.
func TestGrafanaLiveSavedPanel(t *testing.T) {
	base := os.Getenv("PORTAL_GRAFANA_LIVE_URL")
	if base == "" {
		t.Fatal("PORTAL_GRAFANA_LIVE_URL required for read-only live acceptance")
	}
	g, e := netguard.New([]string{"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"}, []int{80, 443, 3000}, os.Getenv("PORTAL_GRAFANA_LIVE_CA"))
	if e != nil {
		t.Fatal("guard configuration failed")
	}
	r := New(g, "")
	i := model.Integration{Kind: "grafana", Enabled: true, URL: base, SecretRef: os.Getenv("PORTAL_GRAFANA_LIVE_SECRET_REF")}
	dashboards, e := r.GrafanaDashboards(context.Background(), i)
	if e != nil {
		t.Fatal(e)
	}
	if len(dashboards.Dashboards) == 0 {
		t.Fatal("no dashboards")
	}
	panels, e := r.GrafanaPanels(context.Background(), i, "infra-overview")
	if e != nil {
		t.Fatal(e)
	}
	found := false
	for _, p := range panels.Panels {
		if p.ID == 19 && p.Supported {
			found = true
		}
	}
	if !found {
		t.Fatal("reference panel unsupported")
	}
	now := time.Now().UTC()
	chart, e := r.GrafanaQuery(context.Background(), i, GrafanaQuery{DashboardUID: "infra-overview", PanelID: 19, From: now.Add(-time.Hour), To: now})
	if e != nil {
		t.Fatal(e)
	}
	points := 0
	for _, series := range chart.Series {
		points += len(series.Points)
	}
	if len(chart.Series) == 0 || points == 0 {
		t.Fatal("live reference chart returned no data")
	}
	t.Logf("read-only guarded Grafana acceptance: dashboards=%d panels=%d series=%d points=%d", len(dashboards.Dashboards), len(panels.Panels), len(chart.Series), points)
}

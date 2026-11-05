//go:build external_ad_integration

package server

import (
	"context"
	"net/url"
	"os"
	"testing"
	"time"

	"pl/portal/internal/organization"
)

// Explicit opt-in acceptance against the approved read-only AD account. Secrets
// are read by DoskaADSource directly from protected files; this test never reads,
// copies or prints their values. All persistence uses a disposable local schema.
func TestDoskaADSourceLivePilot(t *testing.T) {
	if os.Getenv("PORTAL_DOSKA_AD_LIVE_TEST") != "1" {
		t.Fatal("PORTAL_DOSKA_AD_LIVE_TEST=1 is required for the external AD acceptance gate")
	}
	u, err := url.Parse(os.Getenv("PORTAL_TEST_DATABASE_URL"))
	if err != nil || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost") || u.Port() == "" {
		t.Fatal("live gate requires an explicit loopback disposable PostgreSQL endpoint")
	}
	base := localAuthTestStore(t)
	store := organization.NewStore(base.Pool)
	source, err := NewDoskaADSource(DoskaADSourceConfig{
		URL:                   os.Getenv("PORTAL_TEST_AD_URL"),
		BaseDN:                os.Getenv("PORTAL_TEST_AD_BASE_DN"),
		CAFile:                os.Getenv("PORTAL_TEST_AD_CA_FILE"),
		BindDNFile:            os.Getenv("PORTAL_TEST_AD_BIND_DN_FILE"),
		BindPasswordFile:      os.Getenv("PORTAL_TEST_AD_BIND_PASSWORD_FILE"),
		ScopeGroupGUIDs:       []string{os.Getenv("PORTAL_TEST_AD_GROUP_GUID")},
		MaxDiscoveryEmployees: 1000,
	})
	if err != nil {
		t.Fatal("live gate source configuration failed")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	now := time.Now().UTC()
	_, err = store.SaveDepartment(ctx, organization.Department{
		ID: "it", Name: "ИТ", Active: true,
		ADGroups: []organization.ADGroupMapping{{
			ProviderNamespace: source.Namespace(), ObjectGUID: os.Getenv("PORTAL_TEST_AD_GROUP_GUID"),
			DN: os.Getenv("PORTAL_TEST_AD_GROUP_DN"),
		}},
		HeadSubjects: []string{},
	}, 0, "live-read-only-gate", now)
	if err != nil {
		t.Fatal("live gate isolated department persistence failed")
	}
	syncer, err := NewDoskaDirectorySync(store, source)
	if err != nil {
		t.Fatal("live gate sync construction failed")
	}
	result, err := syncer.RefreshOnce(ctx, now)
	if err != nil {
		t.Fatal("live gate complete AD read failed; no partial result is accepted")
	}
	if result.Refreshed != 0 || result.Discovered == 0 {
		t.Fatal("live gate did not discover the expected nonempty approved scope")
	}
	active, denied, total := 0, 0, 0
	cursor := ""
	for {
		page, readErr := store.ListEmployees(ctx, cursor, 100, time.Now().UTC())
		if readErr != nil {
			t.Fatal("live gate isolated employee projection failed")
		}
		for _, identity := range page.Items {
			total++
			if !identity.Fresh || identity.Department.State != organization.Resolved || identity.Department.PrimaryDepartmentID == nil || *identity.Department.PrimaryDepartmentID != "it" || len(identity.HeadDepartmentIDs) != 0 {
				t.Fatal("live gate membership resolution/freshness/head assertion failed")
			}
			if identity.AccountState == organization.Active {
				active++
				if !identity.AccessAllowed || !identity.DepartmentEligible {
					t.Fatal("live gate active member projection denied expected access")
				}
			} else {
				denied++
				if identity.AccessAllowed || identity.DepartmentEligible {
					t.Fatal("live gate inactive member projection incorrectly grants access")
				}
			}
		}
		if page.NextCursor == "" {
			break
		}
		cursor = page.NextCursor
	}
	if total != result.Discovered || active == 0 {
		t.Fatal("live gate discovered/persisted member counts do not prove active scope acceptance")
	}
	t.Logf("approved_scope_members=%d active=%d denied=%d resolved_it=%d heads=0", total, active, denied, total)
}

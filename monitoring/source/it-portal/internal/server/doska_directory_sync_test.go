package server

import (
	"context"
	"encoding/hex"
	"errors"
	"os"
	"testing"
	"time"

	"pl/portal/internal/organization"
)

func doskaSyncFixture(t *testing.T, f *doskaADFixture, discovery bool) (*organization.Store, *DoskaDirectorySync, DoskaADSourceConfig) {
	t.Helper()
	base := localAuthTestStore(t)
	store := organization.NewStore(base.Pool)
	config := doskaADServer(t, f)
	if discovery {
		config.ScopeGroupGUIDs = []string{hex.EncodeToString(doskaTestGroupGUID[:])}
	}
	source, err := NewDoskaADSource(config)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if _, err = store.SaveDepartment(context.Background(), organization.Department{ID: "it", Name: "ИТ", Active: true, ADGroups: []organization.ADGroupMapping{{ProviderNamespace: source.Namespace(), ObjectGUID: hex.EncodeToString(doskaTestGroupGUID[:]), DN: doskaTestGroupDN}}}, 0, "fixture-admin", now); err != nil {
		t.Fatal(err)
	}
	syncer, err := NewDoskaDirectorySync(store, source)
	if err != nil {
		t.Fatal(err)
	}
	return store, syncer, config
}

func TestDoskaDirectorySyncLoginRefreshAndOutageDeadline(t *testing.T) {
	store, syncer, config := doskaSyncFixture(t, &doskaADFixture{member: true}, false)
	ctx := context.Background()
	now := time.Now().UTC()
	sub := "ad:" + syncer.source.Namespace() + ":" + hex.EncodeToString(doskaTestUserGUID[:])
	registered, err := store.RegisterADLogin(ctx, sub, "Login Name", syncer.source.Namespace(), now)
	if err != nil || registered.AccountState != organization.Unknown {
		t.Fatal(registered, err)
	}
	p, err := syncer.RefreshSubject(ctx, sub, now)
	if err != nil || !p.AccessAllowed || !p.DepartmentEligible || p.Department.PrimaryDepartmentID == nil || *p.Department.PrimaryDepartmentID != "it" || len(p.HeadDepartmentIDs) != 0 {
		t.Fatal(p, err)
	}
	lastSuccess := p.LastSuccessAt
	if err = os.Chmod(config.BindPasswordFile, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err = syncer.RefreshOnce(ctx, now.Add(time.Hour)); err == nil {
		t.Fatal("outage reported success")
	}
	p, err = store.Lookup(ctx, sub, now.Add(time.Hour))
	if err != nil || p.AccountState != organization.Active || !p.LastSuccessAt.Equal(lastSuccess) {
		t.Fatal("outage changed last-good status", p, err)
	}
	p, err = store.Lookup(ctx, sub, now.Add(organization.DefaultMaxFreshness))
	if !errors.Is(err, organization.ErrStale) || p.AccessAllowed || p.AccountState != organization.Active {
		t.Fatal("stale active identity retained access", p, err)
	}
	if err = os.Chmod(config.BindPasswordFile, 0600); err != nil {
		t.Fatal(err)
	}
	result, err := syncer.RefreshOnce(ctx, now.Add(organization.DefaultMaxFreshness))
	if err != nil || result.Refreshed != 1 {
		t.Fatal(result, err)
	}
	p, err = store.Lookup(ctx, sub, now.Add(organization.DefaultMaxFreshness))
	if err != nil || !p.AccessAllowed {
		t.Fatal(p, err)
	}
}

func TestDoskaDirectorySyncScopedDiscoveryAndDisabledState(t *testing.T) {
	store, syncer, _ := doskaSyncFixture(t, &doskaADFixture{member: true, disabled: true}, true)
	ctx := context.Background()
	now := time.Now().UTC()
	result, err := syncer.RefreshOnce(ctx, now)
	if err != nil || result.Refreshed != 0 || result.Discovered != 1 {
		t.Fatal(result, err)
	}
	sub := "ad:" + syncer.source.Namespace() + ":" + hex.EncodeToString(doskaTestUserGUID[:])
	p, err := store.Lookup(ctx, sub, now)
	if err != nil || p.AccountState != organization.Disabled || p.AccessAllowed || len(p.HeadDepartmentIDs) != 0 {
		t.Fatal(p, err)
	}
	// Repeated discovery binds the same rawGUID identity; it does not create an
	// alternate account or override revisions captured by the refresh plan.
	result, err = syncer.RefreshOnce(ctx, now.Add(time.Minute))
	if err != nil || result.Refreshed != 1 || result.Discovered != 1 {
		t.Fatal(result, err)
	}
	page, err := store.ListEmployees(ctx, "", 100, now.Add(time.Minute))
	if err != nil || len(page.Items) != 1 {
		t.Fatal(page, err)
	}
}

func TestDoskaDirectorySyncReferralsDoNotRefreshKnownIdentity(t *testing.T) {
	store, syncer, _ := doskaSyncFixture(t, &doskaADFixture{member: true, referral: true}, false)
	ctx := context.Background()
	now := time.Now().UTC()
	sub := "ad:" + syncer.source.Namespace() + ":" + hex.EncodeToString(doskaTestUserGUID[:])
	if _, err := store.RegisterADLogin(ctx, sub, "Known", syncer.source.Namespace(), now); err != nil {
		t.Fatal(err)
	}
	if _, err := syncer.RefreshOnce(ctx, now); err == nil {
		t.Fatal("referrals counted as complete success")
	}
	p, err := store.Lookup(ctx, sub, now)
	if !errors.Is(err, organization.ErrStale) || !p.LastSuccessAt.IsZero() || p.AccountState != organization.Unknown {
		t.Fatal(p, err)
	}
}

func TestDoskaDirectorySyncRunStopsOnCancellation(t *testing.T) {
	_, syncer, _ := doskaSyncFixture(t, &doskaADFixture{}, false)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	done := make(chan struct{})
	go func() { syncer.Run(ctx); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("canceled worker did not stop")
	}
}

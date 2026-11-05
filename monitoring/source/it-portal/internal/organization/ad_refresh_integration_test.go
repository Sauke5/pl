package organization

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestADRefreshRegistrationAndCompleteBatch(t *testing.T) {
	s := organizationTestStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	d := saveDepartmentFixture(t, s, "it", now)
	d.ADGroups = []ADGroupMapping{{ProviderNamespace: "0123456789abcdef", ObjectGUID: "00000000000000000000000000000010", DN: "CN=IT,DC=test"}}
	if _, err := s.SaveDepartment(ctx, d, d.Revision, "admin", now); err != nil {
		t.Fatal(err)
	}
	r := employeeFixture(1, nil, now)
	i, err := s.RegisterADLogin(ctx, r.Identity.Subject, r.Identity.Name, r.ProviderNamespace, now)
	if err != nil || i.AccountState != Unknown || !i.LastSuccessAt.IsZero() {
		t.Fatal(i, err)
	}
	if p, err := s.Lookup(ctx, i.Subject, now); !errors.Is(err, ErrStale) || p.AccessAllowed {
		t.Fatal(p, err)
	}
	p, err := s.ADPlan(ctx, r.ProviderNamespace, i.Subject, "", 1)
	if err != nil || len(p.Identities) != 1 || len(p.Groups) != 1 {
		t.Fatal(p, err)
	}
	observations := []ADObservation{{Subject: i.Subject, Name: "Confirmed", AccountState: Active, ObservedAt: now, CandidateDepartmentIDs: []string{"it"}}}
	updated, err := s.ApplyADObservations(ctx, p, observations, "sync", now)
	if err != nil || len(updated) != 1 || updated[0].Revision != 2 || *updated[0].Department.PrimaryDepartmentID != "it" {
		t.Fatal(updated, err)
	}
	// A password login proves identity, not fresh group membership. It may rename
	// the presentation but cannot extend the successful service-read timestamp.
	renamed, err := s.RegisterADLogin(ctx, i.Subject, "Renamed", r.ProviderNamespace, now.Add(time.Hour))
	if err != nil || !renamed.LastSuccessAt.Equal(now) {
		t.Fatal(renamed, err)
	}
	if _, err = s.RegisterADLogin(ctx, i.Subject, "Wrong namespace", "ffffffffffffffff", now); !errors.Is(err, ErrInvalid) {
		t.Fatal(err)
	}
	p, err = s.ADPlan(ctx, r.ProviderNamespace, i.Subject, "", 1)
	if err != nil {
		t.Fatal(err)
	}
	observations[0].AccountState = Missing
	observations[0].Name = ""
	observations[0].ObservedAt = now.Add(time.Hour)
	observations[0].CandidateDepartmentIDs = nil
	updated, err = s.ApplyADObservations(ctx, p, observations, "sync", now.Add(time.Hour))
	if err != nil || updated[0].AccountState != Missing || updated[0].Name != "Renamed" || *updated[0].Department.PrimaryDepartmentID != "it" {
		t.Fatal(updated, err)
	}
	if current, err := s.Lookup(ctx, i.Subject, now.Add(time.Hour)); err != nil || current.AccessAllowed {
		t.Fatal(current, err)
	}
}

func TestADRefreshRejectsMappingAndIdentityRacesAtomically(t *testing.T) {
	s := organizationTestStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	d := saveDepartmentFixture(t, s, "it", now)
	d.ADGroups = []ADGroupMapping{{ProviderNamespace: "0123456789abcdef", ObjectGUID: "00000000000000000000000000000010", DN: "CN=IT,DC=test"}}
	d, err := s.SaveDepartment(ctx, d, d.Revision, "admin", now)
	if err != nil {
		t.Fatal(err)
	}
	one := saveEmployeeFixture(t, s, 1, []string{"it"}, now)
	two := saveEmployeeFixture(t, s, 2, []string{"it"}, now)
	p, err := s.ADPlan(ctx, "0123456789abcdef", "", "", 25)
	if err != nil {
		t.Fatal(err)
	}
	observations := []ADObservation{{Subject: one.Subject, Name: "One", AccountState: Active, ObservedAt: now.Add(time.Minute), CandidateDepartmentIDs: []string{"it"}}, {Subject: two.Subject, Name: "Two", AccountState: Active, ObservedAt: now.Add(time.Minute), CandidateDepartmentIDs: []string{"it"}}}
	d.ADGroups[0].ObjectGUID = "00000000000000000000000000000020"
	if _, err = s.SaveDepartment(ctx, d, d.Revision, "admin", now); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ApplyADObservations(ctx, p, observations, "sync", now.Add(time.Minute)); !errors.Is(err, ErrConflict) {
		t.Fatal("mapping race restored old grant", err)
	}
	current, err := s.Lookup(ctx, one.Subject, now)
	if err != nil || current.DepartmentEligible || !current.LastSuccessAt.Equal(now) {
		t.Fatal(current, err)
	}
	p, err = s.ADPlan(ctx, "0123456789abcdef", "", "", 25)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.RegisterADLogin(ctx, two.Subject, "Concurrent login rename", "0123456789abcdef", now); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ApplyADObservations(ctx, p, observations, "sync", now.Add(time.Minute)); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	current, err = s.Lookup(ctx, one.Subject, now)
	if err != nil || current.Name != "Сотрудник" || !current.LastSuccessAt.Equal(now) {
		t.Fatal("earlier row in failed batch committed", current, err)
	}
	if _, err = s.ApplyADObservations(ctx, p, observations[:1], "sync", now.Add(time.Minute)); !errors.Is(err, ErrInvalid) {
		t.Fatal("partial batch accepted", err)
	}
	observations[1].AccountState = Unknown
	if _, err = s.ApplyADObservations(ctx, p, observations, "sync", now.Add(time.Minute)); !errors.Is(err, ErrInvalid) {
		t.Fatal(err)
	}
}

func TestADRefreshDiscoveryIdentityAndPagination(t *testing.T) {
	s := organizationTestStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	saveDepartmentFixture(t, s, "it", now)
	for n := byte(1); n <= 3; n++ {
		saveEmployeeFixture(t, s, n, nil, now)
	}
	first, err := s.ADPlan(ctx, "0123456789abcdef", "", "", 2)
	if err != nil || len(first.Identities) != 2 || first.NextSubject == "" {
		t.Fatal(first, err)
	}
	tail, err := s.ADPlan(ctx, "0123456789abcdef", "", first.NextSubject, 2)
	if err != nil || len(tail.Identities) != 1 || tail.NextSubject != "" {
		t.Fatal(tail, err)
	}
	newRecord := employeeFixture(4, nil, now)
	var guid [16]byte
	copy(guid[:], newRecord.ObjectGUID)
	p := first
	p.Identities = []ADIdentity{{Subject: newRecord.Identity.Subject, ObjectGUID: guid}}
	observations := []ADObservation{{Subject: newRecord.Identity.Subject, Name: "Discovered", AccountState: Active, ObservedAt: now}}
	created, err := s.ApplyADObservations(ctx, p, observations, "ad-discovery", now)
	if err != nil || created[0].Revision != 1 {
		t.Fatal(created, err)
	}
	if _, err = s.ApplyADObservations(ctx, p, observations, "ad-discovery", now); !errors.Is(err, ErrConflict) {
		t.Fatal("existing identity silently rebound", err)
	}
	if _, err = s.ADPlan(ctx, "0123456789abcdef", "unknown", "", 1); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
}

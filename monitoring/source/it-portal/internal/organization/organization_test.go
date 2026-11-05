package organization

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestDepartmentResolution(t *testing.T) {
	for _, tc := range []struct {
		name      string
		ids       []string
		selection *Selection
		state     DepartmentState
		primary   string
		explicit  bool
	}{
		{"no membership", nil, nil, Unassigned, "", false},
		{"deduplicate groups", []string{"it", "it", ""}, nil, Resolved, "it", false},
		{"ambiguous", []string{"finance", "it"}, nil, Ambiguous, "", false},
		{"preserve confirmed choice", []string{"finance", "it"}, &Selection{"it", "admin-sub"}, Resolved, "it", true},
		{"invalidate former membership", []string{"finance", "hr"}, &Selection{"it", "admin-sub"}, Ambiguous, "", false},
		{"transfer to sole candidate", []string{"finance"}, &Selection{"it", "admin-sub"}, Resolved, "finance", false},
		{"no actor is not explicit choice", []string{"finance", "it"}, &Selection{"it", ""}, Ambiguous, "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := ResolveDepartment(tc.ids, tc.selection)
			if got.State != tc.state || (got.ExplicitSelection != nil) != tc.explicit {
				t.Fatalf("unexpected resolution: %+v", got)
			}
			if tc.primary == "" && got.PrimaryDepartmentID != nil || tc.primary != "" && (got.PrimaryDepartmentID == nil || *got.PrimaryDepartmentID != tc.primary) {
				t.Fatalf("unexpected primary: %+v", got)
			}
			encoded, err := json.Marshal(got)
			if err != nil {
				t.Fatal(err)
			}
			if tc.primary == "" && !strings.Contains(string(encoded), `"primary_department_id":null`) {
				t.Fatalf("missing explicit null: %s", encoded)
			}
		})
	}
	if _, err := SelectPrimary([]string{"it"}, "finance", "admin"); err == nil {
		t.Fatal("selected unconfirmed department")
	}
	if _, err := SelectPrimary([]string{"it"}, "it", ""); err == nil {
		t.Fatal("selected without actor")
	}
	if _, err := SelectPrimary([]string{"it", "finance"}, "it", "admin"); err != nil {
		t.Fatal(err)
	}
}

func TestADSubjectPreservesRawByteFormat(t *testing.T) {
	guid := []byte{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}
	a, err := ADSubject("DC=example,DC=test", guid)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := ADSubject("dc=EXAMPLE,dc=TEST", guid)
	if a != b || !strings.HasSuffix(a, ":000102030405060708090a0b0c0d0e0f") {
		t.Fatal(a, b)
	}
	if _, err := ADSubject("DC=example", guid[:15]); err == nil {
		t.Fatal("short GUID accepted")
	}
	if _, err := ADSubject("", guid); err == nil {
		t.Fatal("empty namespace accepted")
	}
}

func fixtureIdentity(now time.Time) Identity {
	return Identity{Subject: "ad:existing:subject", Name: "Сотрудник", Revision: 7, AccountState: Active, Department: ResolveDepartment([]string{"it"}, nil), HeadDepartmentIDs: []string{"it"}, LastSuccessAt: now}
}

func TestFreshnessIsIndependentOfAccountAndHeadMetadata(t *testing.T) {
	now := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name          string
		state         AccountState
		observed      time.Time
		maxAge        time.Duration
		fresh, access bool
	}{
		{"active fresh", Active, now.Add(-time.Hour), DefaultMaxFreshness, true, true},
		{"at deadline", Active, now.Add(-2 * time.Hour), DefaultMaxFreshness, false, false},
		{"disabled fresh", Disabled, now, DefaultMaxFreshness, true, false},
		{"unknown fresh", Unknown, now, DefaultMaxFreshness, true, false},
		{"future clock", Active, now.Add(time.Second), DefaultMaxFreshness, false, false},
		{"never observed", Active, time.Time{}, DefaultMaxFreshness, false, false},
		{"invalid policy", Active, now, 0, false, false},
		{"policy beyond agreed maximum", Active, now, DefaultMaxFreshness + time.Second, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			identity := fixtureIdentity(tc.observed)
			identity.AccountState = tc.state
			p := Project(identity, now, tc.maxAge)
			if p.Fresh != tc.fresh || p.AccessAllowed != tc.access || p.DepartmentEligible != tc.access || p.AccountState != tc.state {
				t.Fatalf("unexpected projection: %+v", p)
			}
			if len(p.HeadDepartmentIDs) != 1 {
				t.Fatal("head metadata changed by access evaluation")
			}
		})
	}
	identity := fixtureIdentity(now)
	identity.Department = ResolveDepartment([]string{"it", "hr"}, nil)
	if p := Project(identity, now, DefaultMaxFreshness); !p.AccessAllowed || p.DepartmentEligible {
		t.Fatal("ambiguous department must retain service access only")
	}
	// A stored derived state cannot override the current candidate membership.
	identity.Department.State = Resolved
	former := "former"
	identity.Department.PrimaryDepartmentID = &former
	if p := Project(identity, now, DefaultMaxFreshness); p.DepartmentEligible || p.Department.PrimaryDepartmentID != nil {
		t.Fatal("projection trusted inconsistent stored resolution")
	}
}

func TestProjectionRejectsInvalidIdentity(t *testing.T) {
	now := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name   string
		mutate func(*Identity)
		now    time.Time
	}{
		{"empty subject", func(i *Identity) { i.Subject = "" }, now},
		{"blank subject", func(i *Identity) { i.Subject = " " }, now},
		{"empty name", func(i *Identity) { i.Name = "" }, now},
		{"blank name", func(i *Identity) { i.Name = "\t" }, now},
		{"zero revision", func(i *Identity) { i.Revision = 0 }, now},
		{"zero evaluation time", func(*Identity) {}, time.Time{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			identity := fixtureIdentity(now)
			tc.mutate(&identity)
			p := Project(identity, tc.now, DefaultMaxFreshness)
			if p.AccessAllowed || p.DepartmentEligible {
				t.Fatalf("invalid identity received access: %+v", p)
			}
			if p.Subject != identity.Subject || p.Name != identity.Name || p.Revision != identity.Revision || p.AccountState != Active || !p.LastSuccessAt.Equal(identity.LastSuccessAt) {
				t.Fatal("diagnostic identity fields lost")
			}
		})
	}
}

func TestChangePlanRevisionAndEvents(t *testing.T) {
	now := time.Now().UTC()
	old := fixtureIdentity(now.Add(-time.Minute))
	next := old
	next.LastSuccessAt = now
	refreshed, event, err := PrepareChange(&old, next, "", now)
	if err != nil || event != nil || refreshed.Revision != 7 || !refreshed.LastSuccessAt.Equal(now) {
		t.Fatal(refreshed, event, err)
	}
	next.Department = ResolveDepartment([]string{"hr"}, nil)
	changed, event, err := PrepareChange(&old, next, "event-1", now)
	if err != nil || event == nil || changed.Revision != 8 || event.PreviousDepartmentID == nil || *event.PreviousDepartmentID != "it" || *event.Identity.Department.PrimaryDepartmentID != "hr" {
		t.Fatal(changed, event, err)
	}
	if _, _, err := PrepareChange(&old, next, "", now); err == nil {
		t.Fatal("changed identity without durable event ID")
	}
	next = old
	next.AccountState = Disabled
	changed, event, err = PrepareChange(&old, next, "event-2", now)
	if err != nil || changed.Revision != 8 || event == nil || changed.AccountState != Disabled {
		t.Fatal(changed, event, err)
	}
	next = old
	next.HeadDepartmentIDs = []string{"hr", "it", "it"}
	changed, event, err = PrepareChange(&old, next, "event-3", now)
	if err != nil || event == nil || changed.Revision != 8 || len(changed.HeadDepartmentIDs) != 2 {
		t.Fatal(changed, event, err)
	}
	next = old
	next.Subject = "different"
	if _, _, err := PrepareChange(&old, next, "event-4", now); err == nil {
		t.Fatal("subject changed")
	}
	created, event, err := PrepareChange(nil, old, "created", now)
	if err != nil || event == nil || created.Revision != 1 {
		t.Fatal(created, event, err)
	}
}

type fakeADSource func(context.Context, []ADIdentity) ([]ADObservation, error)

func (f fakeADSource) ReadIdentities(ctx context.Context, ids []ADIdentity) ([]ADObservation, error) {
	return f(ctx, ids)
}

func TestBoundedReadOnlySource(t *testing.T) {
	request := []ADIdentity{{Subject: "existing", ObjectGUID: [16]byte{1}}}
	for _, tc := range []struct {
		name      string
		response  []ADObservation
		sourceErr error
		wantErr   bool
	}{
		{"success", []ADObservation{{Subject: "existing", AccountState: Active, ObservedAt: time.Now()}}, nil, false},
		{"confirmed missing", []ADObservation{{Subject: "existing", AccountState: Missing, ObservedAt: time.Now()}}, nil, false},
		{"search failure", nil, errors.New("search unavailable"), true},
		{"incomplete", nil, nil, true},
		{"foreign", []ADObservation{{Subject: "foreign", AccountState: Active, ObservedAt: time.Now()}}, nil, true},
		{"unknown is not observed", []ADObservation{{Subject: "existing", AccountState: Unknown, ObservedAt: time.Now()}}, nil, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			source := fakeADSource(func(ctx context.Context, ids []ADIdentity) ([]ADObservation, error) {
				deadline, ok := ctx.Deadline()
				if !ok || time.Until(deadline) > ADReadTimeout {
					t.Fatal("unbounded source call")
				}
				ids[0].Subject = "adapter mutation"
				return tc.response, tc.sourceErr
			})
			_, err := ReadADBatch(context.Background(), source, request)
			if (err != nil) != tc.wantErr {
				t.Fatal(err)
			}
			if request[0].Subject != "existing" {
				t.Fatal("request mutated")
			}
		})
	}
	called := false
	source := fakeADSource(func(context.Context, []ADIdentity) ([]ADObservation, error) { called = true; return nil, nil })
	if _, err := ReadADBatch(context.Background(), source, []ADIdentity{request[0], request[0]}); err == nil || called {
		t.Fatal("duplicate identities reached source")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := ReadADBatch(ctx, fakeADSource(func(ctx context.Context, _ []ADIdentity) ([]ADObservation, error) { return nil, ctx.Err() }), request); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

package store

import (
	"context"
	"errors"
	"pl/portal/internal/model"
	"testing"
	"time"
)

func TestInventoryMatchingConservative(t *testing.T) {
	r := model.Resource{ID: "r1", Type: "Сервер", Lifecycle: "active"}
	c := model.Candidate{IntegrationID: "nb", ExternalID: "device:1", State: "linked", ResourceID: "r1", Inventory: &model.InventoryObject{Hostname: "server.example.org", Addresses: []model.InventoryAddress{{Address: "10.0.0.1/24"}}}}
	p := model.Candidate{Labels: map[string]string{"instance": "10.0.0.1:9182"}}
	check := func(cs []model.Candidate, want string) {
		t.Helper()
		if got := MatchInventoryTarget(p, cs, []model.Resource{r}); got != want {
			t.Fatalf("got %q want %q", got, want)
		}
	}
	check([]model.Candidate{c}, "r1")
	d := c
	d.ExternalID = "vm:2"
	d.State = "pending"
	d.ResourceID = ""
	v := int64(9)
	d.Inventory = &model.InventoryObject{Addresses: []model.InventoryAddress{{Address: "10.0.0.1/24", VRFID: &v}}}
	check([]model.Candidate{c, d}, "")
	d = c
	d.Inventory = &model.InventoryObject{Addresses: []model.InventoryAddress{{Address: "10.0.0.1", ManagementOnly: true}}}
	check([]model.Candidate{d}, "")
	d.Inventory.Addresses[0].ManagementOnly = false
	d.Inventory.Addresses[0].ObservedOnly = true
	check([]model.Candidate{d}, "")
	p.Labels["instance"] = "server.example.org:9182"
	check([]model.Candidate{c}, "r1")
	p.Labels["instance"] = "server:9182"
	check([]model.Candidate{c}, "")
	p.Labels["instance"] = "10.0.0.1:9182"
	r.Lifecycle = "archived"
	check([]model.Candidate{c}, "")
}
func TestInitializeInventoryResource(t *testing.T) {
	for _, job := range []string{"windows", "linux"} {
		r := model.Resource{Type: "Приложение"}
		initializeCandidateResource(&r, model.Candidate{Labels: map[string]string{"job": job, "instance": "host.example.org:9182"}})
		if r.Type != "Сервер" || r.Hostname != "host.example.org" {
			t.Fatalf("bad host %+v", r)
		}
	}
	r := model.Resource{Type: "Приложение"}
	initializeCandidateResource(&r, model.Candidate{Labels: map[string]string{"job": "blackbox-http", "instance": "https://service.example.org"}})
	if r.Type != "Приложение" || r.Hostname != "" {
		t.Fatal("probe became host")
	}
	r = model.Resource{}
	initializeCandidateResource(&r, model.Candidate{Inventory: &model.InventoryObject{Kind: "virtual_machine", Hostname: "vm.example.org", PrimaryIP: "10.0.0.1/24", Site: "Site", Addresses: []model.InventoryAddress{{Address: "10.0.0.1/24"}}}})
	if r.Type != "Виртуальная машина" || r.IP != "10.0.0.1" || r.Site != "Site" {
		t.Fatalf("bad VM %+v", r)
	}
}

func TestCandidateIdentitiesLinkSecondaryIPWithoutMutation(t *testing.T) {
	resources := []model.Resource{{ID: "r1", Type: "Сервер", IP: "10.0.0.1", Aliases: []string{"manual.example.org"}}}
	candidates := []model.Candidate{{State: "linked", ResourceID: "r1", Labels: map[string]string{"instance": "10.0.0.2:9182"}}}
	projected := withCandidateIdentities(resources, candidates)
	p := model.Problem{Labels: map[string]string{"instance": "10.0.0.2:9182"}}
	result := ResolveProblemLinks(p, projected, emptyLinkConfig())
	if len(result.ResourceIDs) != 1 || result.ResourceIDs[0] != "r1" {
		t.Fatalf("secondary target unlinked: %+v", result)
	}
	if len(resources[0].Aliases) != 1 || resources[0].Aliases[0] != "manual.example.org" {
		t.Fatal("manual fields mutated")
	}
	candidates[0].State = "ignored"
	result = ResolveProblemLinks(p, withCandidateIdentities(resources, candidates), emptyLinkConfig())
	if len(result.ResourceIDs) != 0 {
		t.Fatal("ignored candidate provided an identity")
	}
}

func TestInventoryAcceptanceAttachesTargetsAndPreservesManualFields(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	nb := putIntegration(t, s, "netbox")
	prom := putIntegration(t, s, "prometheus")
	candidate := model.Candidate{ExternalID: "dcim.device:1", Name: "Server", URL: "https://netbox.example/dcim/devices/1/", Inventory: &model.InventoryObject{Kind: "device", Role: "Server", Hostname: "server.example.org", PrimaryIP: "10.0.0.1", Addresses: []model.InventoryAddress{{Address: "10.0.0.1"}, {Address: "10.0.0.2"}}}}
	if err := s.ApplySnapshot(ctx, nb, model.Snapshot{Candidates: []model.Candidate{candidate}}, nil); err != nil {
		t.Fatal(err)
	}
	target := model.Candidate{ExternalID: "target", Name: "10.0.0.2:9182", URL: "http://10.0.0.2:9182/metrics", Labels: map[string]string{"job": "windows", "instance": "10.0.0.2:9182"}}
	if err := s.ApplySnapshot(ctx, prom, model.Snapshot{Candidates: []model.Candidate{target}}, nil); err != nil {
		t.Fatal(err)
	}
	accepted, err := s.ResolveCandidates(ctx, []string{SourceID(nb.ID, candidate.ExternalID)}, "add", "", "admin")
	if err != nil {
		t.Fatal(err)
	}
	id := accepted[0].ResourceID
	linked, err := Get[model.Candidate](ctx, s, "candidate", SourceID(prom.ID, "target"))
	if err != nil || linked.ResourceID != id || linked.State != "linked" {
		t.Fatalf("target not attached %+v %v", linked, err)
	}
	before, err := Get[model.Resource](ctx, s, "resource", id)
	if err != nil {
		t.Fatal(err)
	}
	candidate.Inventory.Hostname = "renamed.example.org"
	candidate.Name = "Changed upstream"
	if err := s.ApplySnapshot(ctx, nb, model.Snapshot{Candidates: []model.Candidate{candidate}}, nil); err != nil {
		t.Fatal(err)
	}
	after, err := Get[model.Resource](ctx, s, "resource", id)
	if err != nil {
		t.Fatal(err)
	}
	if after.Name != before.Name || after.Hostname != before.Hostname || after.Revision != before.Revision {
		t.Fatal("poll rewrote resource fields")
	}
	inv, err := s.ResourceInventory(ctx, id)
	if err != nil || len(inv.Sources) != 2 {
		t.Fatalf("projection %+v %v", inv, err)
	}
}

func TestInventoryFreshnessRequiresLatestCompleteSnapshot(t *testing.T) {
	now := time.Now().UTC()
	i := model.Integration{Enabled: true, Status: "connected", LastSuccess: &now, PollSeconds: 60}
	if !inventorySourceFresh(i, now) {
		t.Fatal("current snapshot stale")
	}
	if inventorySourceFresh(i, now.Add(-time.Second)) {
		t.Fatal("missing object considered current")
	}
	i.Enabled = false
	if inventorySourceFresh(i, now) {
		t.Fatal("disabled source current")
	}
	i.Enabled = true
	i.Status = "error"
	if inventorySourceFresh(i, now) {
		t.Fatal("failed source current")
	}
	i.Status = "connected"
	old := now.Add(-time.Hour)
	i.LastSuccess = &old
	if inventorySourceFresh(i, old) {
		t.Fatal("expired snapshot current")
	}
}

func TestAcceptedPromHostsAreNotMetricWebPages(t *testing.T) {
	for _, job := range []string{"windows", "linux"} {
		r := model.Resource{Name: "SERVER.example.org:9182", URL: "http://SERVER.example.org:9182/metrics"}
		initializeCandidateResource(&r, model.Candidate{Labels: map[string]string{"job": job, "instance": "SERVER.example.org:9182"}})
		if r.URL != "" || r.Name != "server.example.org" || r.Hostname != "server.example.org" || r.Type != "Сервер" {
			t.Fatalf("bad host %+v", r)
		}
		if job == "windows" && !Contains(r.Directions, "AD / Windows") {
			t.Fatal("windows direction absent")
		}
		if job == "linux" && len(r.Directions) != 0 {
			t.Fatal("invented linux direction")
		}
	}
	r := model.Resource{URL: "https://netbox.example/dcim/devices/1/"}
	initializeCandidateResource(&r, model.Candidate{Inventory: &model.InventoryObject{Name: "Host", NetBoxURL: r.URL}})
	if r.URL != "" || r.Hostname != "Host" || len(r.Links) != 1 || r.Links[0].Name != "NetBox" {
		t.Fatalf("NetBox web link is not ancillary %+v", r)
	}
}
func TestRepeatedPromHostAttachesWithoutOverwriting(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	p := putIntegration(t, s, "prometheus")
	cs := []model.Candidate{{ExternalID: "one", Name: "same:9182", Labels: map[string]string{"job": "windows", "instance": "same:9182"}}, {ExternalID: "two", Name: "same:9100", Labels: map[string]string{"job": "linux", "instance": "same:9100"}}, {ExternalID: "three", Name: "other:9100", Labels: map[string]string{"job": "linux", "instance": "other:9100"}}}
	if e := s.ApplySnapshot(ctx, p, model.Snapshot{Candidates: cs}, nil); e != nil {
		t.Fatal(e)
	}
	accepted, e := s.ResolveCandidates(ctx, []string{SourceID(p.ID, "one"), SourceID(p.ID, "two"), SourceID(p.ID, "three")}, "add", "", "admin")
	if e != nil {
		t.Fatal(e)
	}
	if accepted[0].ResourceID != accepted[1].ResourceID || accepted[1].ResourceID == accepted[2].ResourceID {
		t.Fatal("host identity collapsed or duplicated")
	}
	r, e := Get[model.Resource](ctx, s, "resource", accepted[0].ResourceID)
	if e != nil {
		t.Fatal(e)
	}
	if r.URL != "" || r.Name != "same" || len(r.ExternalIDs) != 2 || !Contains(r.Directions, "AD / Windows") {
		t.Fatalf("bad linked host %+v", r)
	}
}

func TestExistingHostIdentityRespectsNamespaceAndConflictingIPs(t *testing.T) {
	c := model.Candidate{IntegrationID: "prom", ExternalID: "new"}
	proposed := model.Resource{Type: "Сервер", Hostname: "ai-01"}
	existing := model.Resource{ID: "nb-host", Type: "Сервер", Hostname: "AI-01", ExternalIDs: []string{"netbox:device:1"}}
	check := func(wantID string, wantConflict bool) {
		t.Helper()
		got, conflict := existingCandidateHost(proposed, c, []model.Resource{existing})
		id := ""
		if got != nil {
			id = got.ID
		}
		if id != wantID || conflict != wantConflict {
			t.Fatalf("got %q/conflict=%v want %q/%v", id, conflict, wantID, wantConflict)
		}
	}
	check("", false)
	existing.ExternalIDs = append(existing.ExternalIDs, "prom:old")
	check("nb-host", false)
	proposed.IP = "192.168.4.149"
	existing.IP = "10.200.20.30"
	check("", true)
	existing.ExternalIDs = []string{"netbox:device:1"}
	check("", true)
	proposed.IP = "10.200.20.30"
	check("nb-host", false)
	proposed.IP = ""
	existing.IP = ""
	proposed.Hostname = "ai-01.example.org"
	existing.Hostname = "AI-01.example.org"
	check("nb-host", false)
	proposed.IP = "192.168.4.149"
	existing.IP = "10.200.20.30"
	check("", true)
	// A known external object remains the same object after an upstream address change.
	existing.ExternalIDs = append(existing.ExternalIDs, "prom:new")
	check("nb-host", false)
}

func TestExplicitPromTargetLinkAppliesToExistingServiceCard(t *testing.T) {
	resources := []model.Resource{{ID: "service", Type: "Web-сервис", URL: "https://vega.example"}}
	candidates := []model.Candidate{{State: "linked", ResourceID: "service", Labels: map[string]string{"job": "windows", "instance": "Vega-01:9182"}}}
	p := model.Problem{Labels: map[string]string{"job": "windows", "instance": "Vega-01:9182"}}
	got := ResolveProblemLinks(p, withCandidateIdentities(resources, candidates), emptyLinkConfig())
	if len(got.ResourceIDs) != 1 || got.ResourceIDs[0] != "service" {
		t.Fatalf("explicit target link ignored: %+v", got)
	}
	p.Labels["job"] = "other"
	got = ResolveProblemLinks(p, withCandidateIdentities(resources, candidates), emptyLinkConfig())
	if len(got.ResourceIDs) != 0 {
		t.Fatal("unrelated job acquired ownership")
	}
	if len(resources[0].LinkedTargets) != 0 {
		t.Fatal("stored resource mutated")
	}
}

func TestRefreshInventoryIPOwnership(t *testing.T) {
	c := model.Candidate{IntegrationID: "nb", ExternalID: "dcim.device:91", State: "linked", ResourceID: "same", Inventory: &model.InventoryObject{PrimaryIP: "192.168.25.124/24", Addresses: []model.InventoryAddress{{Address: "192.168.25.124/24"}}}}
	for _, tt := range []struct {
		name, ip, source string
		want             bool
	}{
		{"managed", "192.168.25.123", iExternal(c), true},
		{"empty legacy", "", "", true},
		{"legacy nonempty", "192.168.25.123", "", false},
		{"manual override", "192.168.25.125", "manual", false},
		{"manual clear", "", "manual", false},
		{"other source", "192.168.25.123", "nb:dcim.device:111", false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			r := model.Resource{ID: "same", Source: "discovery", Type: "Устройство", IP: tt.ip, IPSource: tt.source, URL: "http://192.168.25.123/", Name: "Manual", Hostname: "Manual host", ExternalIDs: []string{iExternal(c)}}
			if got := refreshInventoryIP(&r, c); got != tt.want {
				t.Fatalf("changed=%v want %v", got, tt.want)
			}
			if tt.want && r.IP != "192.168.25.124" {
				t.Fatalf("IP=%s", r.IP)
			}
			if r.ID != "same" || r.URL != "http://192.168.25.123/" || r.Name != "Manual" || r.Hostname != "Manual host" {
				t.Fatal("manual content changed")
			}
		})
	}
	r := model.Resource{ID: "same", IP: "192.168.25.123", IPSource: iExternal(c), ExternalIDs: []string{iExternal(c)}}
	c.Inventory.PrimaryIP = ""
	if refreshInventoryIP(&r, c) || r.IP != "192.168.25.123" {
		t.Fatal("empty source removed last good IP")
	}
	c.Inventory.PrimaryIP = "192.168.25.124"
	c.Inventory.Addresses[0].ManagementOnly = true
	if refreshInventoryIP(&r, c) {
		t.Fatal("management-only address became host identity")
	}
	c.Inventory.Addresses[0].ManagementOnly = false
	c.State = "ignored"
	if refreshInventoryIP(&r, c) {
		t.Fatal("ignored source updated card")
	}
	c.State = "linked"
	r = model.Resource{ID: "same", Source: "manual", Type: "Web-сервис", ExternalIDs: []string{iExternal(c)}}
	if refreshInventoryIP(&r, c) {
		t.Fatal("linked observation acquired manual service IP")
	}
}

func TestNetBoxIPRefreshAndManualOverride(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	nb := putIntegration(t, s, "netbox")
	c := model.Candidate{ExternalID: "dcim.device:91", Name: "Device", Inventory: &model.InventoryObject{Kind: "device", Hostname: "original", PrimaryIP: "192.168.25.123", Addresses: []model.InventoryAddress{{Address: "192.168.25.123"}}}}
	poll := func(err error) {
		t.Helper()
		if e := s.ApplySnapshot(ctx, nb, model.Snapshot{Candidates: []model.Candidate{c}}, err); e != nil {
			t.Fatal(e)
		}
	}
	poll(nil)
	accepted, e := s.ResolveCandidates(ctx, []string{SourceID(nb.ID, c.ExternalID)}, "add", "", "admin")
	if e != nil {
		t.Fatal(e)
	}
	id := accepted[0].ResourceID
	get := func() model.Resource {
		t.Helper()
		r, e := Get[model.Resource](ctx, s, "resource", id)
		if e != nil {
			t.Fatal(e)
		}
		return r
	}
	r := get()
	r.URL = "http://192.168.25.123/"
	r.Name = "Manual device"
	r.Description = "Manual description"
	r = putResource(t, s, r)
	c.Name = "Changed source name"
	c.Inventory.PrimaryIP = "192.168.25.124"
	c.Inventory.Addresses = []model.InventoryAddress{{Address: "192.168.25.124"}}
	poll(nil)
	r = get()
	if r.IP != "192.168.25.124" || r.URL != "http://192.168.25.123/" || r.Name != "Manual device" || r.Hostname != "original" || r.Description != "Manual description" {
		t.Fatalf("bad refresh %+v", r)
	}
	all, e := List[model.Resource](ctx, s, "resource")
	if e != nil || len(all) != 1 {
		t.Fatal("resource duplicated", e, len(all))
	}
	// Error keeps last good candidate and IP; inventory exposes source error/staleness.
	poll(errors.New("timeout"))
	after := get()
	if after.Revision != r.Revision || after.IP != r.IP {
		t.Fatal("error rewrote resource")
	}
	inv, e := s.ResourceInventory(ctx, id)
	if e != nil || len(inv.Sources) != 1 || !inv.Sources[0].Stale || inv.Sources[0].Status != "error" {
		t.Fatal("error freshness hidden", e, inv)
	}
	c.Inventory.PrimaryIP = ""
	c.Inventory.Addresses = nil
	poll(nil)
	if get().IP != r.IP {
		t.Fatal("empty removed last good IP")
	}
	// An older editor omitting ip_source must preserve it on unrelated edits.
	r = get()
	r.IPSource = ""
	r.Description = "Updated description"
	r = putResource(t, s, r)
	if r.IPSource == "" {
		t.Fatal("older editor dropped ownership")
	}
	r.IP = "192.168.25.125"
	r = putResource(t, s, r)
	if r.IPSource != "manual" {
		t.Fatal("manual edit did not override")
	}
	c.Inventory.PrimaryIP = "192.168.25.126"
	c.Inventory.Addresses = []model.InventoryAddress{{Address: "192.168.25.126"}}
	poll(nil)
	if get().IP != "192.168.25.125" {
		t.Fatal("poll replaced manual IP")
	}
	// Explicit opt-in is validated against the existing linked stable identity.
	r = get()
	r.IPSource = nb.ID + ":" + c.ExternalID
	r = putResource(t, s, r)
	poll(nil)
	if get().IP != "192.168.25.126" {
		t.Fatal("explicit opt-in ignored")
	}
	r = get()
	r.IP = ""
	r = putResource(t, s, r)
	poll(nil)
	if get().IP != "" {
		t.Fatal("manual clear lost")
	}
	r = get()
	r.IPSource = "foreign:dcim.device:91"
	if _, e := s.Save(ctx, "resource", id, r.Revision, r, "admin"); !errors.Is(e, ErrInvalid) {
		t.Fatalf("unlinked ownership allowed: %v", e)
	}
}

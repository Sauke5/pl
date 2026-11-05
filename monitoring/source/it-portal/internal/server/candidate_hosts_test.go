package server

import (
	"context"
	"github.com/google/uuid"
	"pl/portal/internal/model"
	"pl/portal/internal/store"
	"testing"
)

func TestCandidateAPIAddsHostsWithoutWebURLs(t *testing.T) {
	s := apiFixture(t)
	who := apiUser(t, s, "admin", true)
	ctx := context.Background()
	integration := model.Integration{ID: uuid.NewString(), Name: "Prometheus", Kind: "prometheus", Enabled: true, URL: "https://prom.example.org", PollSeconds: 60}
	b, e := s.Store.Save(ctx, "integration", integration.ID, 0, integration, "admin")
	if e != nil {
		t.Fatal(e)
	}
	integration, e = store.Decode[model.Integration](b)
	if e != nil {
		t.Fatal(e)
	}
	cs := []model.Candidate{
		{ExternalID: "windows", Name: "windows.example.org", Labels: map[string]string{"job": "windows", "instance": "windows.example.org:9182"}},
		{ExternalID: "linux", Name: "linux.example.org", Labels: map[string]string{"job": "linux", "instance": "linux.example.org:9100"}},
		{ExternalID: "bad", Name: "Bad", Labels: map[string]string{"job": "windows", "instance": "https://not-a-host.example.org"}},
	}
	if e = s.Store.ApplySnapshot(ctx, integration, model.Snapshot{Candidates: cs}, nil); e != nil {
		t.Fatal(e)
	}
	for _, external := range []string{"windows", "linux"} {
		out := apiDecode[[]model.Candidate](t, apiCall(s, who, "POST", "/api/v1/candidates/resolve", map[string]any{"action": "add", "ids": []string{store.SourceID(integration.ID, external)}}, nil), 200)
		resource := apiDecode[model.Resource](t, apiCall(s, who, "GET", "/api/v1/resources/"+out[0].ResourceID, nil, nil), 200)
		if resource.URL != "" || resource.Type != "Сервер" || resource.Hostname != external+".example.org" {
			t.Fatalf("invalid resource %+v", resource)
		}
	}
	if w := apiCall(s, who, "POST", "/api/v1/candidates/resolve", map[string]any{"action": "add", "ids": []string{store.SourceID(integration.ID, "bad")}}, nil); w.Code != 400 {
		t.Fatalf("malformed candidate accepted: %d %s", w.Code, w.Body.String())
	}
	// NetBox creates a host and retains its UI URL as an ancillary link.
	nb := model.Candidate{ID: uuid.NewString(), IntegrationID: integration.ID, ExternalID: "nb-device", Name: "Inventory host", State: "pending", URL: "https://netbox.example.org/dcim/devices/1/", Inventory: &model.InventoryObject{Kind: "device", Name: "inventory.example.org", Hostname: "inventory.example.org", NetBoxURL: "https://netbox.example.org/dcim/devices/1/"}}
	if _, e = s.Store.Save(ctx, "candidate", nb.ID, 0, nb, "admin"); e != nil {
		t.Fatal(e)
	}
	out := apiDecode[[]model.Candidate](t, apiCall(s, who, "POST", "/api/v1/candidates/resolve", map[string]any{"action": "add", "ids": []string{nb.ID}}, nil), 200)
	resource := apiDecode[model.Resource](t, apiCall(s, who, "GET", "/api/v1/resources/"+out[0].ResourceID, nil, nil), 200)
	if resource.URL != "" || len(resource.Links) != 1 || resource.Links[0].Name != "NetBox" {
		t.Fatalf("invalid NetBox host %+v", resource)
	}
}

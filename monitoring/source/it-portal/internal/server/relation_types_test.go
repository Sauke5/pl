package server

import (
	"context"
	"testing"

	"pl/portal/internal/model"
	"pl/portal/internal/store"
)

func TestRelationTypesDictionaryCompatibilityAndHistory(t *testing.T) {
	s := apiFixture(t)
	admin := apiUser(t, s, "admin", true)

	dictionaries := apiDecode[model.Dictionaries](t, apiCall(s, admin, "GET", "/api/v1/dictionaries", nil, nil), 200)
	wantDefaults := []string{"Размещено на", "Использует БД", "Зависит от", "Резервируется на"}
	if !equalStrings(dictionaries.RelationTypes, wantDefaults) {
		t.Fatalf("unexpected relation type defaults: %#v", dictionaries.RelationTypes)
	}

	peer, err := s.Store.Save(context.Background(), "resource", "relation-peer", 0, model.Resource{ID: "relation-peer", Name: "Peer", Relations: []model.Relation{}}, "admin")
	if err != nil || len(peer) == 0 {
		t.Fatalf("save peer resource: %v", err)
	}
	_, err = s.Store.Save(context.Background(), "resource", "relation-source", 0, model.Resource{ID: "relation-source", Name: "Source", Relations: []model.Relation{{ResourceID: "relation-peer", Label: "Старая произвольная связь"}}}, "admin")
	if err != nil {
		t.Fatalf("save related resource: %v", err)
	}

	dictionaries.RelationTypes = []string{"Обслуживается через"}
	dictionaries = apiDecode[model.Dictionaries](t, settingsWorkspaceCall(s, admin, "PUT", "/api/v1/settings-workspace/dictionaries", dictionaries, nil), 200)

	legacyDraft := map[string]any{
		"revision":     dictionaries.Revision,
		"directions":   dictionaries.Directions,
		"sites":        []string{"Москва"},
		"environments": dictionaries.Environments,
		"types":        dictionaries.Types,
	}
	dictionaries = apiDecode[model.Dictionaries](t, settingsWorkspaceCall(s, admin, "PUT", "/api/v1/settings-workspace/dictionaries", legacyDraft, nil), 200)
	if !equalStrings(dictionaries.RelationTypes, []string{"Обслуживается через"}) {
		t.Fatalf("legacy draft erased relation types: %#v", dictionaries.RelationTypes)
	}

	dictionaries.RelationTypes = []string{}
	dictionaries = apiDecode[model.Dictionaries](t, settingsWorkspaceCall(s, admin, "PUT", "/api/v1/settings-workspace/dictionaries", dictionaries, nil), 200)
	if dictionaries.RelationTypes == nil || len(dictionaries.RelationTypes) != 0 {
		t.Fatalf("explicit empty relation types were not preserved: %#v", dictionaries.RelationTypes)
	}

	resource, err := store.Get[model.Resource](context.Background(), s.Store, "resource", "relation-source")
	if err != nil || len(resource.Relations) != 1 || resource.Relations[0].Label != "Старая произвольная связь" {
		t.Fatalf("dictionary edits mutated existing resource relation: %#v, %v", resource.Relations, err)
	}

	history := apiDecode[store.SettingsHistoryPage](t, settingsWorkspaceCall(s, admin, "GET", "/api/v1/settings-workspace/history?kind=dictionaries", nil, nil), 200)
	found := false
	for _, item := range history.Items {
		for _, change := range item.Changes {
			if change.Field == "relation_types" && change.Label == "Типы связей" {
				found = true
			}
		}
	}
	if !found {
		t.Fatalf("relation_types missing from dictionary history: %#v", history.Items)
	}
}

func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

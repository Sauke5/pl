package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"pl/portal/internal/model"
)

func TestSettingsWorkspaceDeltaProjection(t *testing.T) {
	before := []byte(`{"name":"Before","url":"https://user:password@source.test/api?token=private#private","secret_ref":"file:old-private-path","status":"connected","error":"private error","config":{"basic_username":"old-private-user","unknown_secret":"private"}}`)
	after := []byte(`{"name":"After","url":"https://source.test/new?access_token=other#other","secret_ref":"file:new-private-path","status":"failed","config":{"basic_username":"new-private-user","unknown_secret":"other"}}`)
	changes := settingsDelta("integration", before, after)
	serialized := string(encode(changes))
	for _, denied := range []string{"password", "private", "other", "status", "error", "unknown_secret"} {
		if strings.Contains(serialized, denied) {
			t.Fatalf("history exposed %s: %s", denied, serialized)
		}
	}
	if !strings.Contains(serialized, "https://source.test/api") || !strings.Contains(serialized, "https://source.test/new") || !strings.Contains(serialized, "Изменено") {
		t.Fatalf("missing readable projected values: %s", serialized)
	}
	if changes := settingsDelta("integration", []byte(`{"status":"failed"}`), []byte(`{"status":"connected"}`)); len(changes) != 0 {
		t.Fatalf("operational observations became configuration changes: %#v", changes)
	}
}

func TestSettingsWorkspaceIntegrationRuntime(t *testing.T) {
	observedAt := time.Now().UTC()
	previous := model.Integration{Name: "Before", URL: "https://source.test", Kind: "prometheus", Enabled: true, Status: "connected", LastSuccess: &observedAt, LastAttempt: &observedAt, Config: map[string]string{}}
	next := previous
	next.Name, next.Status, next.LastSuccess, next.Error = "After", "forged", nil, "forged"
	saved, err := settingsIntegrationRuntime(next, encode(previous))
	if err != nil || saved.Status != "connected" || saved.LastSuccess == nil || saved.Error != "" {
		t.Fatalf("draft replaced observed state: %#v %v", saved, err)
	}
	next.URL = "https://another-source.test"
	saved, err = settingsIntegrationRuntime(next, encode(previous))
	if err != nil || saved.Status != "unconfigured" || saved.LastSuccess != nil || saved.LastAttempt != nil {
		t.Fatalf("old observation used for new endpoint: %#v %v", saved, err)
	}
	next.Enabled = false
	saved, err = settingsIntegrationRuntime(next, encode(previous))
	if err != nil || saved.Status != "disabled" {
		t.Fatalf("disabled integration status incorrect: %#v %v", saved, err)
	}
}

func TestSettingsWorkspaceHistoryAtomicityConflictAndPagination(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	if err := s.Defaults(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Pool.Exec(ctx, `INSERT INTO sessions(token_hash,user_id,user_name,admin,csrf,expires_at) VALUES('settings-history-actor','actor','Администратор',true,'csrf',now()+interval '1 hour')`); err != nil {
		t.Fatal(err)
	}
	initial, err := Get[model.Settings](ctx, s, "settings", "global")
	if err != nil {
		t.Fatal(err)
	}
	draft := initial
	draft.Timezone = "UTC"
	firstRaw, err := s.SaveSettingsWorkspace(ctx, "settings", "global", initial.Revision, draft, "actor")
	if err != nil {
		t.Fatal(err)
	}
	first, _ := Decode[model.Settings](firstRaw)
	if _, err = s.SaveSettingsWorkspace(ctx, "settings", "global", initial.Revision, initial, "actor"); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale write accepted: %v", err)
	}
	page, err := s.SettingsHistory(ctx, SettingsHistoryFilter{Kind: "settings", ID: "global", Group: "general", Limit: 30})
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("conflict created history or save missing: %#v %v", page, err)
	}
	entry := page.Items[0]
	if !entry.Detailed || entry.ActorName != "Администратор" || len(entry.Changes) != 1 || entry.Changes[0].Field != "timezone" || entry.Changes[0].Before != "Europe/Moscow" || entry.Changes[0].After != "UTC" {
		t.Fatalf("incorrect history: %#v", entry)
	}
	// A failed audit insert must also roll back the document update.
	if _, err = s.Pool.Exec(ctx, `CREATE FUNCTION reject_settings_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture audit unavailable'; END; $$; CREATE TRIGGER reject_settings_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_settings_audit()`); err != nil {
		t.Fatal(err)
	}
	failed := first
	failed.StaleAfterSeconds = 240
	if _, err = s.SaveSettingsWorkspace(ctx, "settings", "global", first.Revision, failed, "actor"); err == nil {
		t.Fatal("audit failure accepted")
	}
	current, err := Get[model.Settings](ctx, s, "settings", "global")
	if err != nil || current.Revision != first.Revision || current.StaleAfterSeconds != initial.StaleAfterSeconds {
		t.Fatalf("failed transaction changed settings: %#v %v", current, err)
	}
	if _, err = s.Pool.Exec(ctx, `DROP TRIGGER reject_settings_audit ON audit_events; DROP FUNCTION reject_settings_audit()`); err != nil {
		t.Fatal(err)
	}
	// Interleaving another group cannot consume a page slot or hide older rows.
	draft = first
	draft.BoardTitle = "Обновлённый Board"
	secondRaw, err := s.SaveSettingsWorkspace(ctx, "settings", "global", first.Revision, draft, "actor")
	if err != nil {
		t.Fatal(err)
	}
	second, _ := Decode[model.Settings](secondRaw)
	draft = second
	draft.StaleAfterSeconds = 300
	if _, err = s.SaveSettingsWorkspace(ctx, "settings", "global", second.Revision, draft, "actor"); err != nil {
		t.Fatal(err)
	}
	page, err = s.SettingsHistory(ctx, SettingsHistoryFilter{Kind: "settings", ID: "global", Group: "general", Limit: 1})
	if err != nil || len(page.Items) != 1 || page.NextCursor == "" || page.Items[0].Changes[0].Field != "stale_after_seconds" {
		t.Fatalf("first page invalid: %#v %v", page, err)
	}
	older, err := s.SettingsHistory(ctx, SettingsHistoryFilter{Kind: "settings", ID: "global", Group: "general", Cursor: page.NextCursor, Limit: 1})
	if err != nil || len(older.Items) != 1 || older.NextCursor != "" || older.Items[0].ID != entry.ID {
		t.Fatalf("keyset page skipped older group entry: %#v %v", older, err)
	}
	if _, err = s.SettingsHistory(ctx, SettingsHistoryFilter{Kind: "settings", ID: "global", Group: "publication", Cursor: page.NextCursor, Limit: 1}); !errors.Is(err, ErrInvalid) {
		t.Fatal("cursor crossed groups")
	}
	// Older generic records stay generic; detailed values are not reconstructed.
	if err = s.Event(ctx, "settings.saved", "Изменена запись", "global", "actor", map[string]any{"kind": "settings", "revision": 1}, true); err != nil {
		t.Fatal(err)
	}
	page, err = s.SettingsHistory(ctx, SettingsHistoryFilter{Kind: "settings", ID: "global", Limit: 30})
	if err != nil || len(page.Items) != 4 || page.Items[0].Detailed || len(page.Items[0].Changes) != 0 {
		t.Fatalf("legacy history fabricated a delta: %#v %v", page, err)
	}
	if _, err = s.Pool.Exec(ctx, "DELETE FROM sessions WHERE user_id='actor'"); err != nil {
		t.Fatal(err)
	}
	page, err = s.SettingsHistory(ctx, SettingsHistoryFilter{Kind: "settings", ID: "global", Group: "general", Limit: 30})
	if err != nil || page.Items[len(page.Items)-1].ActorName != "Администратор" {
		t.Fatal("actor snapshot lost with session")
	}
}

func TestSettingsWorkspaceIntegrationCreateUpdateDeleteHistory(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	value := model.Integration{Name: "Source", Kind: "prometheus", URL: "https://source.test", Enabled: true, PollSeconds: 60, TimeoutSeconds: 10, Concurrency: 2, SecretRef: "file:private-one", Config: map[string]string{"public_url": "https://source.test/?token=private"}, Status: "forged"}
	raw, err := s.SaveSettingsWorkspace(ctx, "integration", "source", 0, value, "actor")
	if err != nil {
		t.Fatal(err)
	}
	created, _ := Decode[model.Integration](raw)
	if created.Status != "unconfigured" || created.Revision != 1 {
		t.Fatalf("draft set runtime state: %#v", created)
	}
	observed := time.Now().UTC()
	created.Status, created.LastSuccess = "connected", &observed
	if _, err = s.Pool.Exec(ctx, "UPDATE documents SET body=$1 WHERE kind='integration' AND id='source'", encode(created)); err != nil {
		t.Fatal(err)
	}
	created.Name = "Source revised"
	created.Status, created.LastSuccess, created.Error = "forged", nil, "forged"
	raw, err = s.SaveSettingsWorkspace(ctx, "integration", "source", created.Revision, created, "actor")
	if err != nil {
		t.Fatal(err)
	}
	updated, _ := Decode[model.Integration](raw)
	if updated.Status != "connected" || updated.LastSuccess == nil || updated.Error != "" {
		t.Fatalf("new runtime observation replaced: %#v", updated)
	}
	if err = s.DeleteSettingsWorkspace(ctx, "integration", "source", created.Revision, "actor"); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale deletion accepted: %v", err)
	}
	if err = s.DeleteSettingsWorkspace(ctx, "integration", "source", updated.Revision, "actor"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Get(ctx, "integration", "source"); !errors.Is(err, ErrNotFound) {
		t.Fatal("deleted integration remains")
	}
	page, err := s.SettingsHistory(ctx, SettingsHistoryFilter{Kind: "integration", ID: "source", Limit: 30})
	if err != nil || len(page.Items) != 3 || page.Items[0].Action != "deleted" || page.Items[1].Action != "saved" || page.Items[2].Action != "created" || page.Items[0].ObjectName != "Source revised" {
		t.Fatalf("history lifecycle incomplete: %#v %v", page, err)
	}
	encoded, _ := json.Marshal(page)
	if strings.Contains(string(encoded), "private") || strings.Contains(string(encoded), "forged") {
		t.Fatalf("unsafe history: %s", encoded)
	}
}

func TestSettingsWorkspaceLegacyHistoryKeepsLowLevelSaveSemantics(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	observed := time.Now().UTC()
	value := model.Integration{Name: "Source", Kind: "prometheus", URL: "https://source.test", Enabled: true, Status: "connected", LastSuccess: &observed, Error: "existing observation", Config: map[string]string{}}
	raw, err := s.SaveSettingsWithHistory(ctx, "integration", "legacy", 0, value, "actor")
	if err != nil {
		t.Fatal(err)
	}
	saved, _ := Decode[model.Integration](raw)
	if saved.Status != value.Status || saved.LastSuccess == nil || saved.Error != value.Error {
		t.Fatalf("history hook changed low-level input: %#v", saved)
	}
	page, err := s.SettingsHistory(ctx, SettingsHistoryFilter{Kind: "integration", ID: "legacy", Limit: 30})
	if err != nil || len(page.Items) != 1 || !page.Items[0].Detailed {
		t.Fatalf("legacy hook missing history: %#v %v", page, err)
	}
	if strings.Contains(string(encode(page)), "existing observation") {
		t.Fatal("legacy hook recorded runtime error")
	}
}

func TestSettingsWorkspacePreservesManagedModuleOwnership(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	value := model.Integration{ID: "managed-source", Name: "Managed fixture", Kind: "prometheus", URL: "http://metrics.example.test", Enabled: true, ManagedModuleID: "22222222-2222-4222-8222-222222222222", Config: map[string]string{}}
	raw, err := s.Save(ctx, "integration", value.ID, 0, value, "module-worker")
	if err != nil {
		t.Fatal(err)
	}
	current, err := Decode[model.Integration](raw)
	if err != nil {
		t.Fatal(err)
	}
	draft := current
	draft.ManagedModuleID = ""
	draft.Name = "Detached fixture"
	if _, err = s.SaveSettingsWorkspace(ctx, "integration", current.ID, current.Revision, draft, "admin"); !errors.Is(err, ErrManagedModule) {
		t.Fatal("managed integration detached by settings draft", err)
	}
	if err = s.DeleteSettingsWorkspace(ctx, "integration", current.ID, current.Revision, "admin"); !errors.Is(err, ErrManagedModule) {
		t.Fatal("managed integration deleted through settings", err)
	}
	forged := draft
	forged.ID = "forged-source"
	forged.ManagedModuleID = value.ManagedModuleID
	if _, err = s.SaveSettingsWorkspace(ctx, "integration", forged.ID, 0, forged, "admin"); !errors.Is(err, ErrManagedModule) {
		t.Fatal("forged managed ownership accepted", err)
	}
	saved, err := Get[model.Integration](ctx, s, "integration", value.ID)
	if err != nil || saved.ManagedModuleID != value.ManagedModuleID || saved.Name != value.Name || saved.Revision != current.Revision {
		t.Fatal("rejected draft changed managed integration", err)
	}
	// Module observation writes are intentionally not administrative drafts.
	saved.Status = "connected"
	if _, err = s.Save(ctx, "integration", saved.ID, saved.Revision, saved, "module-worker"); err != nil {
		t.Fatal("managed observation update denied", err)
	}
}

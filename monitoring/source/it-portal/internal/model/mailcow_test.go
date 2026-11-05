package model

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestMailcowSettingsFixedGroupsAndStrictIntervals(t *testing.T) {
	expected := []string{"inventory", "mailboxes", "queue", "services", "storage", "rspamd"}
	if !reflect.DeepEqual(MailcowGroups(), expected) {
		t.Fatalf("native read capabilities changed: %v", MailcowGroups())
	}
	defaults := MailcowGroupConfig(nil)
	for _, group := range expected {
		if defaults[group].Enabled || defaults[group].IntervalSeconds != 60 {
			t.Fatalf("collector enabled without opt-in: %s %+v", group, defaults[group])
		}
	}
	for _, interval := range []int{5, 60, 86400} {
		settings := MailcowSettings{Revision: 1, Groups: MailcowGroupConfig(nil)}
		settings.Groups["queue"] = MailcowGroupSettings{Enabled: true, IntervalSeconds: interval}
		if err := settings.Validate(); err != nil {
			t.Fatalf("valid interval %d rejected: %v", interval, err)
		}
	}
	for _, tc := range []struct {
		name   string
		change func(*MailcowSettings)
	}{
		{"zero revision", func(s *MailcowSettings) { s.Revision = 0 }},
		{"negative revision", func(s *MailcowSettings) { s.Revision = -1 }},
		{"missing group", func(s *MailcowSettings) { delete(s.Groups, "rspamd") }},
		{"unknown added", func(s *MailcowSettings) { s.Groups["unknown"] = MailcowGroupSettings{IntervalSeconds: 60} }},
		{"unknown replaces known", func(s *MailcowSettings) {
			delete(s.Groups, "queue")
			s.Groups["unknown"] = MailcowGroupSettings{IntervalSeconds: 60}
		}},
		{"below minimum", func(s *MailcowSettings) { s.Groups["queue"] = MailcowGroupSettings{IntervalSeconds: 4} }},
		{"above maximum", func(s *MailcowSettings) { s.Groups["queue"] = MailcowGroupSettings{IntervalSeconds: 86401} }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			settings := MailcowSettings{Revision: 1, Groups: MailcowGroupConfig(nil)}
			tc.change(&settings)
			if settings.Validate() == nil {
				t.Fatal("invalid full settings accepted")
			}
		})
	}
	// Legacy malformed config cannot create an unbounded or implicitly enabled poll.
	config := map[string]string{"mailcow_queue_enabled": "TRUE", "mailcow_queue_interval": "4", "mailcow_storage_interval": "86401", "mailcow_rspamd_interval": "NaN", "mailcow_services_interval": "5", "mailcow_services_enabled": "true"}
	groups := MailcowGroupConfig(config)
	if groups["queue"].Enabled || groups["queue"].IntervalSeconds != 60 || groups["storage"].IntervalSeconds != 60 || groups["rspamd"].IntervalSeconds != 60 || !groups["services"].Enabled || groups["services"].IntervalSeconds != 5 {
		t.Fatalf("unsafe legacy configuration: %+v", groups)
	}
}

func TestMailcowSnapshotDerivesFreshnessWithoutInventingData(t *testing.T) {
	now := time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)
	recent, old := now.Add(-time.Minute), now.Add(-4*time.Minute)
	instance := ModuleInstance{ID: "mail", Name: "Mail", DesiredState: "enabled", ObservedState: "running"}
	source := Integration{ID: "source", Enabled: true, Revision: 7, URL: "https://mail.example.test", SecretRef: "file:private-key-reference", Config: map[string]string{"mailcow_queue_enabled": "true"}}
	tests := []struct {
		name   string
		value  MailcowGroupSnapshot
		status string
		stale  bool
	}{
		{"pending", MailcowGroupSnapshot{}, "pending", false},
		{"error before success", MailcowGroupSnapshot{ErrorCode: "auth", LastAttemptStatus: "error"}, "error", false},
		{"unsupported before success", MailcowGroupSnapshot{ErrorCode: "unsupported", LastAttemptStatus: "error"}, "unsupported", false},
		{"successful actual zero", MailcowGroupSnapshot{LastSuccess: &recent, Data: json.RawMessage(`{"messages_observed":0,"empty_ambiguous":true}`)}, "ok", false},
		{"fresh failure retains data", MailcowGroupSnapshot{LastSuccess: &recent, ErrorCode: "network", Data: json.RawMessage(`{"messages_observed":3}`)}, "error", false},
		{"expired success", MailcowGroupSnapshot{LastSuccess: &old, Data: json.RawMessage(`{"messages_observed":3}`)}, "stale", true},
		{"expired error", MailcowGroupSnapshot{LastSuccess: &old, ErrorCode: "timeout", Data: json.RawMessage(`{"messages_observed":3}`)}, "stale", true},
		{"unsupported retained", MailcowGroupSnapshot{LastSuccess: &old, ErrorCode: "unsupported", Data: json.RawMessage(`{"messages_observed":3}`)}, "unsupported", true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			snapshot := MailcowSnapshot{Groups: map[string]MailcowGroupSnapshot{"queue": tc.value}}
			snapshot.ApplySource(instance, source, now)
			value := snapshot.Groups["queue"]
			if value.Status != tc.status || value.Stale != tc.stale || string(value.Data) != string(tc.value.Data) {
				t.Fatalf("incorrect derived state: %+v", value)
			}
			if tc.value.LastSuccess == nil && (value.LastSuccess != nil || value.Data != nil) {
				t.Fatal("missing data replaced with a success or business zero")
			}
			encoded, err := json.Marshal(snapshot)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(encoded), source.SecretRef) || strings.Contains(string(encoded), "secret_ref") {
				t.Fatal("snapshot exposes secret reference")
			}
		})
	}
}

func TestMailcowSnapshotDisabledCacheAndIntervalTTL(t *testing.T) {
	now := time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)
	success := now.Add(-4 * time.Minute)
	instance := ModuleInstance{DesiredState: "enabled", ObservedState: "running"}
	source := Integration{Enabled: true, Config: map[string]string{"mailcow_queue_enabled": "true", "mailcow_queue_interval": "100"}}
	original := MailcowGroupSnapshot{LastSuccess: &success, LastAttemptStatus: "success", Data: json.RawMessage(`{"messages_observed":2}`)}
	snapshot := MailcowSnapshot{Groups: map[string]MailcowGroupSnapshot{"queue": original}}
	snapshot.ApplySource(instance, source, now)
	if value := snapshot.Groups["queue"]; value.Status != "ok" || value.Stale {
		t.Fatalf("interval TTL ignored: %+v", value)
	}
	snapshot.ApplySource(instance, source, success.Add(300*time.Second))
	if snapshot.Groups["queue"].Stale {
		t.Fatal("TTL boundary prematurely stale")
	}
	snapshot.ApplySource(instance, source, success.Add(301*time.Second))
	if snapshot.Groups["queue"].Status != "stale" {
		t.Fatal("expired interval TTL not reflected")
	}
	for _, tc := range []struct {
		name     string
		instance ModuleInstance
		source   Integration
	}{
		{"group disabled", instance, Integration{Enabled: true}},
		{"integration disabled", instance, Integration{Config: source.Config}},
		{"module disabled", ModuleInstance{DesiredState: "disabled", ObservedState: "running"}, source},
	} {
		t.Run(tc.name, func(t *testing.T) {
			value := MailcowSnapshot{Groups: map[string]MailcowGroupSnapshot{"queue": original}}
			value.ApplySource(tc.instance, tc.source, now)
			group := value.Groups["queue"]
			if group.Status != "disabled" || string(group.Data) != string(original.Data) || group.LastSuccess == nil || !group.LastSuccess.Equal(success) {
				t.Fatalf("disable lost cache: %+v", group)
			}
		})
	}
}

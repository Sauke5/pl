package model

import (
	"encoding/json"
	"errors"
	"strconv"
	"time"
)

func MailcowGroups() []string {
	return []string{"inventory", "mailboxes", "queue", "services", "storage", "rspamd"}
}

type MailcowGroupSettings struct {
	Enabled         bool `json:"enabled"`
	IntervalSeconds int  `json:"interval_seconds"`
}

type MailcowSettings struct {
	Revision int64                           `json:"revision"`
	Groups   map[string]MailcowGroupSettings `json:"groups"`
}

func (s MailcowSettings) Validate() error {
	if s.Revision < 1 || len(s.Groups) != len(MailcowGroups()) {
		return errors.New("invalid Mailcow settings")
	}
	for _, group := range MailcowGroups() {
		value, ok := s.Groups[group]
		if !ok || value.IntervalSeconds < 5 || value.IntervalSeconds > 86400 {
			return errors.New("invalid Mailcow group")
		}
	}
	return nil
}

func MailcowGroupConfig(config map[string]string) map[string]MailcowGroupSettings {
	groups := make(map[string]MailcowGroupSettings)
	for _, group := range MailcowGroups() {
		interval, err := strconv.Atoi(config["mailcow_"+group+"_interval"])
		if err != nil || interval < 5 || interval > 86400 {
			interval = 60
		}
		groups[group] = MailcowGroupSettings{Enabled: config["mailcow_"+group+"_enabled"] == "true", IntervalSeconds: interval}
	}
	return groups
}

type MailcowGroupSnapshot struct {
	Enabled           bool            `json:"enabled"`
	IntervalSeconds   int             `json:"interval_seconds"`
	LastAttempt       *time.Time      `json:"last_attempt_at"`
	LastAttemptStatus string          `json:"last_attempt_status"`
	LastSuccess       *time.Time      `json:"last_success_at"`
	ErrorCode         string          `json:"error_code"`
	Status            string          `json:"status"`
	Stale             bool            `json:"stale"`
	Data              json.RawMessage `json:"data"`
}

type MailcowSnapshot struct {
	InstanceID    string                          `json:"instance_id"`
	IntegrationID string                          `json:"integration_id"`
	Name          string                          `json:"name"`
	URL           string                          `json:"url"`
	Revision      int64                           `json:"revision"`
	Enabled       bool                            `json:"enabled"`
	Groups        map[string]MailcowGroupSnapshot `json:"groups"`
}

func (s *MailcowSnapshot) ApplySource(instance ModuleInstance, integration Integration, now time.Time) {
	s.InstanceID, s.IntegrationID = instance.ID, integration.ID
	s.Name, s.URL, s.Revision = instance.Name, integration.URL, integration.Revision
	s.Enabled = integration.Enabled && instance.DesiredState == "enabled" && instance.ObservedState == "running"
	if s.Groups == nil {
		s.Groups = make(map[string]MailcowGroupSnapshot)
	}
	for group, config := range MailcowGroupConfig(integration.Config) {
		value := s.Groups[group]
		value.Enabled, value.IntervalSeconds = config.Enabled, config.IntervalSeconds
		value.Stale = value.LastSuccess != nil && now.Sub(*value.LastSuccess) > max(180*time.Second, time.Duration(config.IntervalSeconds)*3*time.Second)
		switch {
		case !s.Enabled || !config.Enabled:
			value.Status = "disabled"
		case value.ErrorCode == "unsupported":
			value.Status = "unsupported"
		case value.Stale:
			value.Status = "stale"
		case value.ErrorCode != "":
			value.Status = "error"
		case value.LastSuccess == nil:
			value.Status = "pending"
		default:
			value.Status = "ok"
		}
		s.Groups[group] = value
	}
}

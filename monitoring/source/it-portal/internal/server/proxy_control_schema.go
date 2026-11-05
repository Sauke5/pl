package server

import (
	"encoding/json"
	"errors"
	"strings"
	"time"
)

type proxyObservation struct {
	Health      string     `json:"health"`
	LastChecked *time.Time `json:"last_checked"`
	LastSuccess *time.Time `json:"last_success"`
	Latency     *float64   `json:"latency_ms"`
	ErrorCode   *string    `json:"error_code"`
}
type proxyEvent struct {
	At        time.Time `json:"at"`
	From      *string   `json:"from,omitempty"`
	To        *string   `json:"to,omitempty"`
	Event     string    `json:"event,omitempty"`
	Mode      string    `json:"mode,omitempty"`
	Revision  *int64    `json:"revision,omitempty"`
	Actor     string    `json:"actor"`
	ActorName string    `json:"actor_name,omitempty"`
	Reason    string    `json:"reason"`
}
type proxyCounters struct {
	Source     string           `json:"source"`
	ObservedAt time.Time        `json:"observed_at"`
	Values     map[string]int64 `json:"values"`
}
type proxyHistory struct {
	SchemaVersion int          `json:"schema_version"`
	History       []proxyEvent `json:"history"`
}
type proxySockets struct {
	Source     string    `json:"source"`
	ObservedAt time.Time `json:"observed_at"`
	Summary    string    `json:"summary"`
}
type proxyStatus struct {
	Automation        *proxyAutomation            `json:"automation,omitempty"`
	SchemaVersion     int                         `json:"schema_version"`
	Revision          *int64                      `json:"revision"`
	Mode              string                      `json:"mode"`
	ActivePath        *string                     `json:"active_path"`
	Paths             map[string]proxyObservation `json:"paths"`
	ObservedAt        *time.Time                  `json:"observed_at"`
	StaleAfterSeconds int                         `json:"stale_after_seconds"`
	ControllerError   *string                     `json:"controller_error"`
	Counters          *proxyCounters              `json:"counters"`
	Sockets           *proxySockets               `json:"sockets"`
	LastSwitch        *proxyEvent                 `json:"last_switch"`
}

func proxyPathValid(path *string) bool {
	return path == nil || *path == "relay" || *path == "final185" || *path == "final2"
}
func proxyEventValid(event proxyEvent) bool {
	if event.At.IsZero() || !gatewayString(event.Actor, 256, false) || !gatewayString(event.Reason, 256, false) {
		return false
	}
	if event.Event == "mode" {
		return proxyModeValid(event.Mode) && event.Revision != nil && *event.Revision >= 0
	}
	return event.Event == "" && event.From != nil && event.To != nil && proxyPathValid(event.From) && proxyPathValid(event.To)
}

// Decode into the public model, so controller additions cannot accidentally expose
// credentials/configuration through the Portal. Missing observations remain null.
func proxyControlProjection(uri string, payload []byte) (any, error) {
	invalid := errors.New("invalid proxy-control schema")
	if strings.HasPrefix(uri, "/api/v1/history?") {
		var history proxyHistory
		if json.Unmarshal(payload, &history) != nil || history.SchemaVersion != 1 || history.History == nil || len(history.History) > 50 {
			return nil, invalid
		}
		for index, event := range history.History {
			if !proxyEventValid(event) {
				return nil, invalid
			}
			history.History[index].ActorName = ""
		}
		return history, nil
	}
	var status proxyStatus
	if json.Unmarshal(payload, &status) != nil || status.SchemaVersion != 1 || status.Revision == nil || *status.Revision < 0 || !proxyModeValid(status.Mode) || !proxyPathValid(status.ActivePath) || status.StaleAfterSeconds < 1 || status.StaleAfterSeconds > 300 || len(status.Paths) != 3 {
		return nil, invalid
	}
	for _, path := range []string{"relay", "final185", "final2"} {
		p, ok := status.Paths[path]
		if !ok || (p.Health != "healthy" && p.Health != "unhealthy" && p.Health != "unknown") || (p.Latency != nil && *p.Latency < 0) {
			return nil, invalid
		}
	}
	if status.LastSwitch != nil && !proxyEventValid(*status.LastSwitch) {
		return nil, invalid
	}
	if status.LastSwitch != nil {
		status.LastSwitch.ActorName = ""
	}
	if c := status.Counters; c != nil {
		if c.Source != "xray_stats_api" || c.ObservedAt.IsZero() || c.Values == nil || len(c.Values) > 100 {
			return nil, invalid
		}
		for name, value := range c.Values {
			if !gatewayString(name, 256, true) || value < 0 {
				return nil, invalid
			}
		}
	}
	if s := status.Sockets; s != nil && (s.Source != "host_ss_summary" || s.ObservedAt.IsZero() || len(s.Summary) > 7200) {
		return nil, invalid
	}
	if status.Automation != nil && status.Mode != "auto" {
		status.Automation.LastDecision = nil
	}
	if !validProxyAutomation(status.Automation) || (status.Automation != nil && (status.ActivePath == nil || *status.Automation.GatingPath != *status.ActivePath)) {
		status.Automation = nil
	}
	return status, nil
}

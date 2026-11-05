package server

import (
	"encoding/json"
	"math"
	"time"
)

type proxyAutomation struct {
	GatingPath   *string   `json:"gating_path"`
	ObservedAt   time.Time `json:"observed_at"`
	FailedCycles map[string]struct {
		Current   *int `json:"current"`
		Threshold *int `json:"threshold"`
	} `json:"failed_cycles"`
	EdgeReturn struct {
		Enabled      *bool      `json:"enabled"`
		HealthySince *time.Time `json:"healthy_since"`
		Elapsed      *float64   `json:"elapsed_seconds"`
		Required     *float64   `json:"required_seconds"`
		Remaining    *float64   `json:"remaining_seconds"`
	} `json:"edge_return"`
	LastDecision *struct {
		At           time.Time `json:"at"`
		Reason       string    `json:"reason"`
		SelectedPath *string   `json:"selected_path"`
	} `json:"last_decision"`
}

func (a *proxyAutomation) UnmarshalJSON(data []byte) error {
	type plain proxyAutomation
	var decoded plain
	if json.Unmarshal(data, &decoded) != nil {
		*a = proxyAutomation{}
		return nil
	}
	*a = proxyAutomation(decoded)
	return nil
}
func validProxyAutomation(a *proxyAutomation) bool {
	if a == nil {
		return true
	}
	if a.ObservedAt.IsZero() || a.GatingPath == nil || !proxyPathValid(a.GatingPath) || len(a.FailedCycles) != 3 || a.EdgeReturn.Enabled == nil || a.EdgeReturn.Required == nil || *a.EdgeReturn.Required < 0 || *a.EdgeReturn.Required > 86400 {
		return false
	}
	for _, path := range []string{"relay", "final185", "final2"} {
		p, ok := a.FailedCycles[path]
		if !ok || p.Current == nil || p.Threshold == nil || *p.Current < 0 || *p.Threshold < 1 {
			return false
		}
	}
	e := a.EdgeReturn
	if e.Elapsed != nil && (*e.Elapsed < 0) {
		return false
	}
	if e.Remaining != nil && (*e.Remaining < 0 || *e.Remaining > *e.Required || e.Elapsed == nil || math.Abs(math.Max(*e.Required-*e.Elapsed, 0)-*e.Remaining) > 0.01) {
		return false
	}
	if a.LastDecision != nil && (a.LastDecision.At.IsZero() || !gatewayString(a.LastDecision.Reason, 128, true) || !proxyPathValid(a.LastDecision.SelectedPath)) {
		return false
	}
	return true
}

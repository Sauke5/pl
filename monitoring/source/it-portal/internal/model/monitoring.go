package model

import "time"

// MonitoringTarget is independent of optional catalog discovery. LastScrape is
// an observation timestamp, not the exact time a health transition occurred.
type MonitoringTarget struct {
	ExternalID string            `json:"external_id"`
	Name       string            `json:"name"`
	Health     string            `json:"health"`
	Labels     map[string]string `json:"labels"`
	LastScrape time.Time         `json:"last_scrape"`
}

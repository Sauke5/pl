package model

import "time"

// System groups existing catalogue objects; membership never grants access.
type System struct {
	ID          string                `json:"id"`
	Revision    int64                 `json:"revision"`
	Name        string                `json:"name"`
	Description string                `json:"description"`
	Profile     string                `json:"profile"`
	Planned     bool                  `json:"planned"`
	ResourceIDs []string              `json:"resource_ids"`
	Metrics     []SystemMetricBinding `json:"metrics"`
}

type SystemMetricBinding struct {
	ID            string            `json:"id"`
	Metric        string            `json:"metric"`
	Title         string            `json:"title"`
	IntegrationID string            `json:"integration_id"`
	Labels        map[string]string `json:"labels"`
	ResourceID    string            `json:"resource_id,omitempty"`
}

type FavoriteGroup struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	ResourceIDs []string `json:"resource_ids"`
	Collapsed   bool     `json:"collapsed"`
}

// Separate from legacy preferences so unrelated settings forms cannot discard it.
type WorkspacePreferences struct {
	Revision  int64           `json:"revision"`
	SystemIDs []string        `json:"system_ids"`
	Groups    []FavoriteGroup `json:"groups"`
}

type SystemMetricDefinition struct {
	Key         string   `json:"key"`
	Title       string   `json:"title"`
	Unit        string   `json:"unit"`
	Profiles    []string `json:"profiles"`
	Description string   `json:"description"`
}

type SystemProfile struct {
	Key         string   `json:"key"`
	Title       string   `json:"title"`
	Description string   `json:"description"`
	Metrics     []string `json:"metrics"`
}

type SystemMetricSample struct {
	Labels     map[string]string `json:"labels"`
	Value      float64           `json:"value"`
	ObservedAt time.Time         `json:"observed_at"`
}

type SystemMetricResult struct {
	ID         string               `json:"id"`
	Metric     string               `json:"metric"`
	Title      string               `json:"title"`
	Unit       string               `json:"unit"`
	State      string               `json:"state"`
	Source     string               `json:"source"`
	Error      string               `json:"error,omitempty"`
	Samples    []SystemMetricSample `json:"samples"`
	ResourceID string               `json:"resource_id,omitempty"`
}

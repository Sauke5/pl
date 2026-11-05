package model

import "time"

type Endpoint struct {
	Name string `json:"name"`
	URL  string `json:"url"`
}
type Relation struct {
	ResourceID string `json:"resource_id"`
	Label      string `json:"label"`
}
type Check struct {
	Kind            string `json:"kind"`
	Target          string `json:"target"`
	IntervalSeconds int    `json:"interval_seconds"`
}

// EmployeeMetadata is explicitly prepared for the published employee view.
// Internal resource descriptions and provider metadata never enter that projection.
type EmployeeMetadata struct {
	DisplayName string `json:"display_name"`
	Description string `json:"description"`
	Category    string `json:"category"`
	Icon        string `json:"icon"`
	Support     bool   `json:"support"`
}
type Resource struct {
	Icon           string            `json:"icon,omitempty"`
	Employee       *EmployeeMetadata `json:"employee,omitempty"`
	LinkedTargets  []string          `json:"-"` // Matching projection from explicitly linked source candidates.
	ID             string            `json:"id"`
	Revision       int64             `json:"revision"`
	Name           string            `json:"name"`
	Description    string            `json:"description"`
	Type           string            `json:"type"`
	URL            string            `json:"url"`
	Endpoints      []Endpoint        `json:"endpoints"`
	IP             string            `json:"ip"`
	IPSource       string            `json:"ip_source,omitempty"` // Empty: legacy/unmanaged; manual: override; otherwise exact linked source identity.
	Hostname       string            `json:"hostname"`
	Aliases        []string          `json:"aliases"`
	Directions     []string          `json:"directions"`
	Site           string            `json:"site"`
	Environment    string            `json:"environment"`
	Tags           []string          `json:"tags"`
	Relations      []Relation        `json:"relations"`
	Links          []Endpoint        `json:"links"`
	Source         string            `json:"source"`
	ExternalIDs    []string          `json:"external_ids"`
	Check          Check             `json:"check"`
	Operations     []string          `json:"operations"`
	ExecutorTarget string            `json:"executor_target"`
	Lifecycle      string            `json:"lifecycle"`
	CreatedAt      time.Time         `json:"created_at"`
	UpdatedAt      time.Time         `json:"updated_at"`

	ManagedModuleID string `json:"managed_module_id,omitempty"`
}
type Filter struct {
	Q           string `json:"q"`
	Direction   string `json:"direction"`
	Site        string `json:"site"`
	Environment string `json:"environment"`
	Tag         string `json:"tag"`
	Collection  string `json:"collection,omitempty"`
	Lifecycle   string `json:"lifecycle,omitempty"`
	Sort        string `json:"sort,omitempty"`
}
type Collection struct {
	Mode        string   `json:"mode"`
	ID          string   `json:"id"`
	Revision    int64    `json:"revision"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	ResourceIDs []string `json:"resource_ids"`
	Filter      Filter   `json:"filter"`
}
type Preferences struct {
	SectionOrder     []string      `json:"section_order"`
	WaylineCards     []WaylineCard `json:"wayline_cards"`
	Revision         int64         `json:"revision"`
	Favorites        []string      `json:"favorites"`
	HiddenSections   []string      `json:"hidden_sections"`
	SidebarCollapsed bool          `json:"sidebar_collapsed"`
}
type WaylineCard struct {
	IntegrationID string `json:"integration_id"`
	TargetID      int64  `json:"target_id"`
}
type Dictionaries struct {
	Revision      int64    `json:"revision"`
	Directions    []string `json:"directions"`
	Sites         []string `json:"sites"`
	Environments  []string `json:"environments"`
	Types         []string `json:"types"`
	RelationTypes []string `json:"relation_types"`
}
type Settings struct {
	SessionLifetimeMinutes int      `json:"session_lifetime_minutes"`
	LocalPasswordMinLength int      `json:"local_password_min_length"`
	Revision               int64    `json:"revision"`
	BoardEnabled           bool     `json:"board_enabled"`
	BoardAnonymous         bool     `json:"board_anonymous"`
	BoardTitle             string   `json:"board_title"`
	BoardResourceIDs       []string `json:"board_resource_ids"`
	Timezone               string   `json:"timezone"`
	StaleAfterSeconds      int      `json:"stale_after_seconds"`
}
type Integration struct {
	ID             string            `json:"id"`
	Revision       int64             `json:"revision"`
	Name           string            `json:"name"`
	Kind           string            `json:"kind"`
	URL            string            `json:"url"`
	Enabled        bool              `json:"enabled"`
	PollSeconds    int               `json:"poll_seconds"`
	TimeoutSeconds int               `json:"timeout_seconds"`
	Concurrency    int               `json:"concurrency"`
	SecretRef      string            `json:"secret_ref"`
	Config         map[string]string `json:"config"`
	Status         string            `json:"status"`
	LastSuccess    *time.Time        `json:"last_success"`
	LastAttempt    *time.Time        `json:"last_attempt"`
	Error          string            `json:"error"`
	Capabilities   []string          `json:"capabilities"`

	ManagedModuleID string `json:"managed_module_id,omitempty"`
}
type Candidate struct {
	Observation   *TargetObservation `json:"observation,omitempty"`
	Inventory     *InventoryObject   `json:"inventory,omitempty"`
	ID            string             `json:"id"`
	IntegrationID string             `json:"integration_id"`
	ExternalID    string             `json:"external_id"`
	Name          string             `json:"name"`
	URL           string             `json:"url"`
	Labels        map[string]string  `json:"labels"`
	State         string             `json:"state"`
	ResourceID    string             `json:"resource_id"`
	LastSeen      time.Time          `json:"last_seen"`
}
type Problem struct {
	ResourceIDs    []string          `json:"resource_ids"`
	LinkMode       string            `json:"link_mode"`
	LinkReason     string            `json:"link_reason"`
	LinkCandidates []string          `json:"link_candidates"`
	Hidden         bool              `json:"hidden"`
	HiddenBy       string            `json:"hidden_by,omitempty"`
	HiddenByName   string            `json:"hidden_by_name,omitempty"`
	HiddenAt       *time.Time        `json:"hidden_at,omitempty"`
	ID             string            `json:"id"`
	IntegrationID  string            `json:"integration_id"`
	ExternalID     string            `json:"external_id"`
	Severity       string            `json:"severity"`
	Title          string            `json:"title"`
	Description    string            `json:"description"`
	ResourceID     string            `json:"resource_id"`
	StartedAt      time.Time         `json:"started_at"`
	LastSeen       time.Time         `json:"last_seen"`
	ResolvedAt     *time.Time        `json:"resolved_at"`
	Status         string            `json:"status"`
	Stale          bool              `json:"stale"`
	SourceURL      string            `json:"source_url"`
	Labels         map[string]string `json:"labels"`
}
type Event struct {
	ID         string         `json:"id"`
	Kind       string         `json:"kind"`
	Title      string         `json:"title"`
	ResourceID string         `json:"resource_id"`
	Actor      string         `json:"actor"`
	ActorName  string         `json:"actor_name,omitempty"`
	CreatedAt  time.Time      `json:"created_at"`
	Details    map[string]any `json:"details"`
}
type Job struct {
	ResourceName    string         `json:"resource_name,omitempty"`
	IntegrationName string         `json:"integration_name,omitempty"`
	ID              string         `json:"id"`
	Kind            string         `json:"kind"`
	ResourceID      string         `json:"resource_id"`
	IntegrationID   string         `json:"integration_id"`
	Parameters      map[string]any `json:"parameters"`
	IdempotencyKey  string         `json:"idempotency_key"`
	Confirmed       bool           `json:"confirmed"`
	Status          string         `json:"status"`
	Actor           string         `json:"actor"`
	CreatedAt       time.Time      `json:"created_at"`
	StartedAt       *time.Time     `json:"started_at"`
	FinishedAt      *time.Time     `json:"finished_at"`
	Result          map[string]any `json:"result"`
	Error           string         `json:"error"`
}
type Report struct {
	Run        int       `json:"run,omitempty"`
	ReportType string    `json:"report_type,omitempty"`
	ID         string    `json:"id"`
	JobID      string    `json:"job_id"`
	Title      string    `json:"title"`
	Period     string    `json:"period"`
	Status     string    `json:"status"`
	CreatedAt  time.Time `json:"created_at"`
	URL        string    `json:"url"`
	Error      string    `json:"error"`
}

type Snapshot struct {
	Targets       []MonitoringTarget     `json:"targets,omitempty"`
	Configuration *ConfigurationSnapshot `json:"configuration,omitempty"`
	Reports       []Report
	Candidates    []Candidate
	Problems      []Problem
}
type User struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Admin bool   `json:"admin"`
}

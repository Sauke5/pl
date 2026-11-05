package model

// Mapping is portal metadata; it never modifies the alert source.
type ProblemLinkOverride struct {
	Mode        string   `json:"mode"`
	ResourceIDs []string `json:"resource_ids"`
}
type ProblemLinkRule struct {
	ID            string   `json:"id"`
	IntegrationID string   `json:"integration_id"`
	Label         string   `json:"label"`
	Value         string   `json:"value"`
	Job           string   `json:"job"`
	ResourceIDs   []string `json:"resource_ids"`
}
type ProblemLinkConfig struct {
	Revision  int64                          `json:"revision"`
	Overrides map[string]ProblemLinkOverride `json:"overrides"`
	Rules     []ProblemLinkRule              `json:"rules"`
}
type ProblemLinkCandidate struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Reason string `json:"reason"`
}
type ProblemLinks struct {
	Revision    int64                  `json:"revision"`
	Mode        string                 `json:"mode"`
	ResourceIDs []string               `json:"resource_ids"`
	Reason      string                 `json:"reason"`
	Candidates  []ProblemLinkCandidate `json:"candidates"`
	Rule        *ProblemLinkRule       `json:"rule,omitempty"`
}
type ProblemLinkUpdate struct {
	Revision     int64    `json:"revision"`
	Mode         string   `json:"mode"`
	ResourceIDs  []string `json:"resource_ids"`
	Scope        string   `json:"scope"`
	Label        string   `json:"label,omitempty"`
	Value        string   `json:"value,omitempty"`
	Job          string   `json:"job,omitempty"`
	RemoveRuleID string   `json:"remove_rule_id,omitempty"`
}

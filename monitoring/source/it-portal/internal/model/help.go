package model

// HelpState is private to a signed-in user and separate from layout preferences.
type HelpState struct {
	Disabled bool     `json:"disabled"`
	Seen     []string `json:"seen"`
}

// IDs are a versioned UI/API contract, bounded below 64 topics.
func ValidHelpTopic(topic string) bool {
	if len(topic) == 0 || len(topic) > 80 {
		return false
	}
	switch topic {
	case "home", "catalog", "modules", "collections", "problems", "reports", "events", "audit", "tools", "settings", "settings-board", "candidates", "viewer-board", "resource-create", "resource-edit", "resource-details", "problem-details", "preferences", "collection-editor", "import", "operation-check", "operation-report", "operation-restart", "integration-editor", "command-palette", "job-result", "candidate-link":
		return true
	case "systems", "system-editor", "system-details", "favorite-group-editor", "operations", "module-catalog":
		return true
	default:
		return false
	}
}

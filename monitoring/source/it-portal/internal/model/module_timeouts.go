package model

import "time"

// ModuleStartupControllerTimeout covers signed cold delivery before native
// startup: 30 minutes download, 15 minutes Docker load, and 5 minutes for
// unpacking, hashes, image verification and registry publication. Both install
// and enable can enter delivery (for example after an interrupted first install).
// This fixed allowlist is not a browser/request-supplied timeout. Zero keeps the
// existing short RPC budget; the caller's earlier deadline still takes priority.
func ModuleStartupControllerTimeout(moduleID, action string) time.Duration {
	if action != "install" && action != "enable" {
		return 0
	}
	const delivery = 50 * time.Minute
	switch moduleID {
	case "netmap":
		return delivery + 22*time.Minute // Existing first-schema-migration budget.
	case "prometheus", "xray", "alertmanager", "wayline", "grafana", "forms", "doska", "sftpgo", "bookstack":
		return delivery + 310*time.Second // Existing native lifecycle RPC budget.
	}
	return 0
}

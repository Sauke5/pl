package model

import "time"

// ModuleStartupControllerTimeout grants only the local NetBox stack enough
// time for its first schema migration. Zero keeps the existing RPC budget.
// This is not a browser/request-supplied timeout.
func ModuleStartupControllerTimeout(moduleID, action string) time.Duration {
	if moduleID == "netmap" && (action == "install" || action == "enable") {
		return 22 * time.Minute
	}
	return 0
}

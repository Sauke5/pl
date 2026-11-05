package model

import (
	"testing"
	"time"
)

func TestModuleStartupControllerTimeout(t *testing.T) {
	for _, module := range []string{"netmap", "prometheus", "bookstack", "grafana", "", "NETMAP"} {
		for _, action := range []string{"install", "enable", "refresh", "disable", "remove", "configure", "", "INSTALL"} {
			want := time.Duration(0)
			if module == "netmap" && (action == "install" || action == "enable") {
				want = 22 * time.Minute
			}
			if got := ModuleStartupControllerTimeout(module, action); got != want {
				t.Errorf("%s/%s: got %v want %v", module, action, got, want)
			}
		}
	}
}

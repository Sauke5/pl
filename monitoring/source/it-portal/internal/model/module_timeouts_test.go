package model

import (
	"testing"
	"time"
)

func TestModuleStartupControllerTimeout(t *testing.T) {
	for _, module := range []string{"netmap", "prometheus", "xray", "alertmanager", "wayline", "grafana", "forms", "doska", "sftpgo", "bookstack", "", "NETMAP", "mailcow", "unknown"} {
		for _, action := range []string{"install", "enable", "refresh", "disable", "remove", "configure", "observe", "read", "", "INSTALL"} {
			want := time.Duration(0)
			if action == "install" || action == "enable" {
				switch module {
				case "netmap":
					want = 72 * time.Minute
				case "prometheus", "xray", "alertmanager", "wayline", "grafana", "forms", "doska", "sftpgo", "bookstack":
					want = 55*time.Minute + 10*time.Second
				}
			}
			if got := ModuleStartupControllerTimeout(module, action); got != want {
				t.Errorf("%s/%s: got %v want %v", module, action, got, want)
			}
		}
	}
}

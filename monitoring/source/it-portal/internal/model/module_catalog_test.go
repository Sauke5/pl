package model

import "testing"

func TestModuleCatalogDefinesAdmissionWithoutRuntimeVersions(t *testing.T) {
	ids := map[string]bool{}
	for _, item := range ModuleCatalog() {
		if item.ID == "" || ids[item.ID] || item.Name == "" || len(item.Modes) == 0 || item.Description == "" {
			t.Fatal("invalid module definition")
		}
		ids[item.ID] = true
		if item.Version != "" {
			t.Fatal("runtime version hardcoded in module catalog")
		}
		for _, mode := range item.Modes {
			if !ModuleModeSupported(item.ID, mode) {
				t.Fatal("catalog and admission differ")
			}
		}
	}
	if !ModuleModeSupported("wayline", "local") || !ModuleModeSupported("wayline", "external") || !ModuleModeSupported("fileauditor", "external") || ModuleModeSupported("fileauditor", "local") || ModuleModeSupported("unknown", "local") {
		t.Fatal("connector modes are inconsistent")
	}
	catalog := ModuleCatalog()
	catalog[0].Name = "mutated"
	if ModuleCatalog()[0].Name == "mutated" {
		t.Fatal("catalog mutation leaked")
	}
}

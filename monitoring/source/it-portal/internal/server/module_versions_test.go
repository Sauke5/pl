package server

import "testing"

func TestModuleVersionsLoadedFromPackageMetadata(t *testing.T) {
	t.Setenv("PORTAL_DATABASE_URL", "postgres://fixture")
	t.Setenv("PORTAL_DEMO", "true")
	t.Setenv("PORTAL_MODULE_VERSIONS", `{"xray":"27.1.1","prometheus":"4.0.0","alertmanager":"1.2.3"}`)
	c, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if c.ModuleVersions["xray"] != "27.1.1" || c.ModuleVersions["prometheus"] != "4.0.0" || c.ModuleVersions["alertmanager"] != "1.2.3" {
		t.Fatal("module versions did not come from metadata")
	}
}

func TestModuleVersionsRejectInvalidCatalogMetadata(t *testing.T) {
	for _, raw := range []string{`null`, `[]`, `{"xray":"latest"}`, `{"other":"1.2.3"}`, `{"xray":42}`} {
		t.Run(raw, func(t *testing.T) {
			t.Setenv("PORTAL_MODULE_VERSIONS", raw)
			if _, err := LoadConfig(); err == nil {
				t.Fatal("invalid metadata accepted")
			}
		})
	}
}

package model

import (
	"embed"
	"encoding/json"
)

//go:embed module-catalog.json
var moduleCatalogFiles embed.FS

type ModuleDescriptor struct {
	PublicPath       string   `json:"public_path,omitempty"`
	ExternalAuth     string   `json:"external_auth,omitempty"`
	ID               string   `json:"id"`
	Name             string   `json:"name"`
	Description      string   `json:"description"`
	Version          string   `json:"version"`
	Modes            []string `json:"modes"`
	Actions          []string `json:"actions"`
	IntegrationKind  string   `json:"integration_kind"`
	Capabilities     []string `json:"capabilities"`
	Direction        string   `json:"direction"`
	View             string   `json:"view"`
	DataPreservation string   `json:"data_preservation"`
}

// ModuleCatalog returns an independent copy of the compiled release manifest.
// Runtime versions come from the installed package, never from UI constants.
func ModuleCatalog() []ModuleDescriptor {
	raw, err := moduleCatalogFiles.ReadFile("module-catalog.json")
	if err != nil {
		panic("missing module catalog")
	}
	var catalog struct {
		Schema int                `json:"schema"`
		Items  []ModuleDescriptor `json:"items"`
	}
	if json.Unmarshal(raw, &catalog) != nil || catalog.Schema != 1 {
		panic("invalid module catalog")
	}
	return catalog.Items
}
func ModuleDefinition(id string) (ModuleDescriptor, bool) {
	for _, item := range ModuleCatalog() {
		if item.ID == id {
			return item, true
		}
	}
	return ModuleDescriptor{}, false
}
func ModuleModeSupported(id, mode string) bool {
	item, found := ModuleDefinition(id)
	if !found {
		return false
	}
	for _, allowed := range item.Modes {
		if mode == allowed {
			return true
		}
	}
	return false
}

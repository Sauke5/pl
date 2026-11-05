package store

import (
	"context"
	"testing"

	"pl/portal/internal/model"
)

func TestConnectorModuleProjectionsRetainConfigurationAndUsePlatformLinks(t *testing.T) {
	for _, kind := range []string{"wayline", "fileauditor"} {
		t.Run(kind, func(t *testing.T) {
			ctx := context.Background()
			database := testStore(t)
			input := model.ModuleRequest{ModuleID: kind, Name: "Connector", Mode: "external", Endpoint: "https://connector.example/audit", SecretRef: "file:fixture-key", Config: map[string]string{}}
			if kind == "wayline" {
				input.Endpoint = "https://connector.example"
				input.Config["basic_username"] = "service"
			}
			instance, _, err := database.QueueModule(ctx, "local-admin", "connector-create", "", "install", input)
			if err != nil {
				t.Fatal(err)
			}
			integration, err := Get[model.Integration](ctx, database, "integration", instance.IntegrationID)
			if err != nil || integration.Kind != kind || integration.ManagedModuleID != instance.ID || integration.SecretRef != input.SecretRef || !integration.Enabled {
				t.Fatal("connector projection mismatch", err)
			}
			resource, err := Get[model.Resource](ctx, database, "resource", instance.ResourceID)
			if err != nil || resource.URL == "" || resource.URL[0] != '/' || resource.ManagedModuleID != instance.ID {
				t.Fatal("resource is not routed through Platform", err)
			}
			if kind == "wayline" && (integration.Config["basic_username"] != "service" || integration.Config["module_mode"] != "external") {
				t.Fatal("Wayline configuration lost")
			}
			if err := database.ReconcileModules(ctx); err != nil {
				t.Fatal(err)
			}
			after, err := Get[model.Integration](ctx, database, "integration", instance.IntegrationID)
			if err != nil || after.SecretRef != input.SecretRef || after.Config["basic_username"] != integration.Config["basic_username"] {
				t.Fatal("reconciliation lost connector settings", err)
			}
		})
	}
}

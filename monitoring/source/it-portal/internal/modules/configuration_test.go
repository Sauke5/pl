package modules

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"pl/portal/internal/model"
	"strings"
	"testing"
)

func sampleConfiguration() model.PrometheusConfiguration {
	c := model.DefaultPrometheusConfiguration()
	c.Jobs = []model.PrometheusScrapeJob{{Name: "node", Enabled: true, ScrapeInterval: "30s", ScrapeTimeout: "10s", MetricsPath: "/metrics", Scheme: "http", Targets: []model.PrometheusScrapeTarget{{Address: "node.example:9100", Labels: map[string]string{"site": "lab"}}}}}
	return c
}
func TestConfigurationRejectsUnsafeAndAmbiguousFields(t *testing.T) {
	for name, change := range map[string]func(*model.PrometheusConfiguration){
		"self":           func(c *model.PrometheusConfiguration) { c.Jobs[0].Name = "prometheus" },
		"duplicate":      func(c *model.PrometheusConfiguration) { c.Jobs = append(c.Jobs, c.Jobs[0]) },
		"timeout":        func(c *model.PrometheusConfiguration) { c.Jobs[0].ScrapeTimeout = "31s" },
		"duration":       func(c *model.PrometheusConfiguration) { c.Global.ScrapeInterval = "0s" },
		"url":            func(c *model.PrometheusConfiguration) { c.Jobs[0].Targets[0].Address = "http://node:9100" },
		"label":          func(c *model.PrometheusConfiguration) { c.Jobs[0].Targets[0].Labels["job"] = "override" },
		"internal-label": func(c *model.PrometheusConfiguration) { c.Jobs[0].Targets[0].Labels["__address__"] = "evil:80" },
		"path":           func(c *model.PrometheusConfiguration) { c.Jobs[0].MetricsPath = "/metrics?token=secret" },
		"empty":          func(c *model.PrometheusConfiguration) { c.Jobs[0].Targets = nil },
		"large": func(c *model.PrometheusConfiguration) {
			c.Jobs[0].Targets[0].Labels["site"] = strings.Repeat("x", 1025)
		},
	} {
		t.Run(name, func(t *testing.T) {
			c := sampleConfiguration()
			change(&c)
			if ValidateConfiguration(c) == nil {
				t.Fatal("accepted unsafe configuration")
			}
		})
	}
	c := sampleConfiguration()
	c.Jobs[0].Targets = append(c.Jobs[0].Targets, model.PrometheusScrapeTarget{Address: "[fd00::1]:9100", Labels: map[string]string{}})
	if err := ValidateConfiguration(c); err != nil {
		t.Fatal(err)
	}
}
func TestConfigurationValidationRejectsWrongHostDigest(t *testing.T) {
	for _, validHash := range []bool{true, false} {
		client := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/v1/configuration/validate" {
				t.Error("wrong controller route")
			}
			yaml := "global:\n  scrape_interval: 15s\n"
			sum := sha256.Sum256([]byte(yaml))
			hash := hex.EncodeToString(sum[:])
			if !validHash {
				hash = strings.Repeat("0", 64)
			}
			json.NewEncoder(w).Encode(ConfigurationValidation{InstanceID: "123e4567-e89b-42d3-a456-426614174000", Valid: true, YAML: yaml, Hash: hash})
		})
		_, err := client.ValidateConfiguration(context.Background(), "123e4567-e89b-42d3-a456-426614174000", sampleConfiguration())
		if (err == nil) != validHash {
			t.Fatalf("digest verification %v", err)
		}
	}
}

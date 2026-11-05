package server

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestGatewayConfigurationRequiresExactRawKeyAndFixedPrefix(t *testing.T) {
	t.Setenv("PORTAL_DATABASE_URL", "postgres://test.invalid/test")
	t.Setenv("PORTAL_DEMO", "true")
	t.Setenv("PORTAL_PUBLIC_URL", "http://localhost:8199")
	t.Setenv("PORTAL_LOCAL_ADMIN_HASH_FILE", "")
	t.Setenv("PORTAL_AD_URL", "")
	t.Setenv("PORTAL_MONITORING_ADMIN_URL", "http://monitoring-admin:8080/admin/")
	t.Setenv("PORTAL_WEBSITES_ADMIN_URL", "")
	t.Setenv("PORTAL_WEBSITES_ADMIN_KEY_FILE", "")
	p := filepath.Join(t.TempDir(), "test-only-key")
	t.Setenv("PORTAL_MONITORING_ADMIN_KEY_FILE", p)
	for _, size := range []int{0, 31, 33, 64} {
		if err := os.WriteFile(p, bytes.Repeat([]byte{1}, size), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadConfig(); err == nil {
			t.Fatalf("accepted key size %d", size)
		}
	}
	if err := os.WriteFile(p, bytes.Repeat([]byte{1}, 32), 0600); err != nil {
		t.Fatal(err)
	}
	c, err := LoadConfig()
	if err != nil || len(c.ServiceGateways) != 1 {
		t.Fatal(err)
	}
	if len(c.ServiceGateways[0].Key) != 32 || c.ServiceGateways[0].Audience != "monitoring-admin" {
		t.Fatal("wrong gateway configuration")
	}
	for _, u := range []string{"http://monitoring-admin:8080/", "http://user:password@monitoring-admin:8080/admin/", "http://monitoring-admin:8080/admin/?target=other"} {
		t.Setenv("PORTAL_MONITORING_ADMIN_URL", u)
		if _, err := LoadConfig(); err == nil {
			t.Fatal("accepted invalid gateway URL")
		}
	}
}

func TestGatewayConfigurationRejectsSameKeyAcrossApplications(t *testing.T) {
	t.Setenv("PORTAL_DATABASE_URL", "postgres://test.invalid/test")
	t.Setenv("PORTAL_DEMO", "true")
	t.Setenv("PORTAL_PUBLIC_URL", "http://localhost:8199")
	t.Setenv("PORTAL_LOCAL_ADMIN_HASH_FILE", "")
	t.Setenv("PORTAL_AD_URL", "")
	t.Setenv("PORTAL_MONITORING_ADMIN_URL", "http://monitoring-admin:8080/admin")
	t.Setenv("PORTAL_WEBSITES_ADMIN_URL", "http://websites-admin:8080/websites")
	dir := t.TempDir()
	monitoringKey, websitesKey := filepath.Join(dir, "monitoring-key"), filepath.Join(dir, "websites-key")
	t.Setenv("PORTAL_MONITORING_ADMIN_KEY_FILE", monitoringKey)
	t.Setenv("PORTAL_WEBSITES_ADMIN_KEY_FILE", websitesKey)
	for _, path := range []string{monitoringKey, websitesKey} {
		if err := os.WriteFile(path, bytes.Repeat([]byte{1}, 32), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := LoadConfig(); err == nil || err.Error() != "gateway applications require independent keys" {
		t.Fatalf("duplicate key accepted: %v", err)
	}
	// Different filenames do not establish key independence; distinct raw bytes do.
	if err := os.WriteFile(websitesKey, bytes.Repeat([]byte{2}, 32), 0600); err != nil {
		t.Fatal(err)
	}
	config, err := LoadConfig()
	if err != nil || len(config.ServiceGateways) != 2 {
		t.Fatalf("independent keys rejected: %v", err)
	}
}

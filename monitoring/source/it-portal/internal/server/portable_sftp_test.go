package server

import (
	"context"
	"strings"
	"testing"
)

func TestPortableReleaseDoesNotExposeSpecializedSFTPExchange(t *testing.T) {
	s := apiFixture(t)
	s.Config.PortableRelease = true
	admin := apiUser(t, s, "portable-admin", true)
	for _, path := range []string{"/api/v1/sftp-server", "/api/v1/sftp-exchange"} {
		if response := apiCall(s, admin, "GET", path, nil, nil); response.Code != 404 {
			t.Fatalf("specialized exchange route exposed: %s status %d", path, response.Code)
		}
	}
	if response := apiCall(s, admin, "POST", "/api/v1/sftp-server/collections", map[string]any{"branch": "not-a-portable-feature"}, nil); response.Code != 404 {
		t.Fatalf("specialized collection mutation exposed: %d", response.Code)
	}
	features, err := s.applicationFeatures(context.Background())
	if err != nil || features["sftp_exchange"] || features["sftp"] {
		t.Fatalf("specialized exchange advertised: %v %v", features, err)
	}
}

func TestPortableConfigRefusesSpecializedExchangeSettings(t *testing.T) {
	t.Setenv("PORTAL_PORTABLE_RELEASE", "true")
	t.Setenv("PORTAL_DEMO", "true")
	t.Setenv("PORTAL_DATABASE_URL", "postgres://test.invalid/test")
	t.Setenv("PORTAL_PUBLIC_URL", "http://localhost:8199")
	t.Setenv("PORTAL_LOCAL_ADMIN_HASH_FILE", "")
	t.Setenv("PORTAL_AD_URL", "")
	t.Setenv("PORTAL_SFTP_URL", "https://specialized.example.test")
	if _, err := LoadConfig(); err == nil || !strings.Contains(err.Error(), "specialized SFTP exchange") {
		t.Fatalf("portable deployment accepted specialized exchange: %v", err)
	}
}

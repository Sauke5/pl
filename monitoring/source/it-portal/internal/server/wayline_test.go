package server

import (
	"pl/portal/internal/model"
	"testing"
)

func TestWaylineIntegrationConfiguration(t *testing.T) {
	for _, tc := range []struct {
		name    string
		config  map[string]string
		secret  string
		invalid bool
	}{
		{"anonymous", nil, "", false},
		{"basic", map[string]string{"basic_username": "portal", "public_url": "https://wayline.example.test", "stale_after_seconds": "300"}, "env:PORTAL_SECRET_WAYLINE", false},
		{"password missing", map[string]string{"basic_username": "portal"}, "", true},
		{"username missing", nil, "env:PORTAL_SECRET_WAYLINE", true},
		{"bad username", map[string]string{"basic_username": "user:pass"}, "env:PORTAL_SECRET_WAYLINE", true},
		{"bad stale", map[string]string{"stale_after_seconds": "0"}, "", true},
		{"bad url", map[string]string{"public_url": "javascript:alert(1)"}, "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			i := model.Integration{Name: "Wayline", Kind: "wayline", URL: "http://wayline:8585", Config: tc.config, SecretRef: tc.secret}
			if err := validateIntegration(&i); (err != nil) != tc.invalid {
				t.Fatalf("error=%v", err)
			}
		})
	}
}

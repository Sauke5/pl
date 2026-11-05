package server

import (
	"pl/portal/internal/model"
	"testing"
)

func TestSessionAnonymousBoardFlagMatchesActualAccess(t *testing.T) {
	s := apiFixture(t)
	admin := apiUser(t, s, "admin", true)
	for _, flags := range []struct{ enabled, anonymous bool }{{true, false}, {true, true}, {false, true}, {false, false}} {
		settings := apiDecode[model.Settings](t, apiCall(s, admin, "GET", "/api/v1/settings", nil, nil), 200)
		settings.BoardEnabled, settings.BoardAnonymous = flags.enabled, flags.anonymous
		if !flags.enabled && flags.anonymous {
			if response := apiCall(s, admin, "PUT", "/api/v1/settings", settings, nil); response.Code != 400 {
				t.Fatalf("disabled public board should be rejected: %d", response.Code)
			}
			continue
		}
		apiDecode[model.Settings](t, apiCall(s, admin, "PUT", "/api/v1/settings", settings, nil), 200)
		for _, who := range []apiIdentity{{}, admin} {
			session := apiDecode[map[string]any](t, apiCall(s, who, "GET", "/api/v1/session", nil, nil), 200)
			if session["board_anonymous_enabled"] != (flags.enabled && flags.anonymous) {
				t.Fatalf("incorrect public board flag: %v", flags)
			}
		}
		code := apiCall(s, apiIdentity{}, "GET", "/api/v1/board", nil, nil).Code
		if (code == 200) != (flags.enabled && flags.anonymous) {
			t.Fatalf("board access disagrees: %v code=%d", flags, code)
		}
	}
}

func TestDiscoverySwitchValidation(t *testing.T) {
	for _, value := range []string{"true", "false", "", "off", "FALSE"} {
		integration := model.Integration{Name: "Prometheus", Kind: "prometheus", URL: "https://metrics.example.test", Config: map[string]string{"discovery_enabled": value}}
		err := validateIntegration(&integration)
		if (err == nil) != (value == "true" || value == "false") {
			t.Fatalf("discovery_enabled=%q err=%v", value, err)
		}
	}
}

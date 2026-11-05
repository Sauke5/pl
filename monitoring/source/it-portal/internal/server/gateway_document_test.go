package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestGatewayDocumentRequestKeepsMachineFlows(t *testing.T) {
	for _, tc := range []struct {
		method, path, accept, authorization string
		want                                bool
	}{
		{"GET", "/audit-arch/departments/12", "text/html,application/xhtml+xml", "", true},
		{"HEAD", "/directory/", "text/html", "", true},
		{"GET", "/audit-arch/api/findings", "text/html", "", false},
		{"GET", "/audit-arch/departments/12", "application/json", "", false},
		{"GET", "/audit-arch/departments/12", "text/html", "Bearer machine", false},
		{"POST", "/audit-arch/departments/12", "text/html", "", false},
	} {
		r := httptest.NewRequest(tc.method, "https://monitoring.example"+tc.path, nil)
		r.Header.Set("Accept", tc.accept)
		if tc.authorization != "" {
			r.Header.Set("Authorization", tc.authorization)
		}
		if got := gatewayDocumentRequest(r); got != tc.want {
			t.Fatalf("%s %s accept=%q auth=%q: got %v want %v", tc.method, tc.path, tc.accept, tc.authorization, got, tc.want)
		}
	}
}

func TestGatewayLoginTargetStaysInKnownService(t *testing.T) {
	for _, tc := range []struct{ request, want string }{
		{"/audit-arch/departments/12?sort=name", "/audit-arch/departments/12"},
		{"/audit-arch/api/findings", "/audit-arch/"},
		{"/audit-arch/unknown", "/audit-arch/"},
		{"/audit-arch/%2e%2e/admin", "/audit-arch/"},
	} {
		r := httptest.NewRequest(http.MethodGet, "https://monitoring.example"+tc.request, nil)
		if got := gatewayLoginTarget(r, "auditor", "/audit-arch"); got != tc.want {
			t.Fatalf("%s: got %q want %q", tc.request, got, tc.want)
		}
	}
}

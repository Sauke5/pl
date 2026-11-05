package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestLegacyProxyRouteBoundaries(t *testing.T) {
	for _, tc := range [][2]string{
		{"GET", "/audit/"}, {"HEAD", "/audit/assets/app.js"},
		{"POST", "/audit/api/scans?path=C%3A%5Cfiles"}, {"OPTIONS", "/audit/hubs/scan-progress"},
		{"GET", "/netmap/?site=1"}, {"GET", "/netmap/app.js"},
		{"GET", "/netmap/api/sites/site-a"}, {"HEAD", "/netmap/api/sites/site-a"},
		{"GET", "/netmap/api/sites/branch-west"}, {"HEAD", "/netmap/api/sites/branch-west"},
		{"GET", "/netmap/api/wan"}, {"GET", "/audit/assets/app.css"},
	} {
		if !legacyProxyRoute(tc[0], tc[1]) {
			t.Fatal("valid route rejected", tc)
		}
	}
	for _, tc := range [][2]string{
		{"POST", "/netmap/api/run"}, {"POST", "/netmap/api/sites/site-a"},
		{"OPTIONS", "/netmap/api/sites/site-a"}, {"GET", "/netmap/api/sites/site-a/"},
		{"GET", "/netmap/api/sites/SITE-A"}, {"GET", "/netmap/api/sites/a_b"},
		{"GET", "/netmap/api/sites/" + strings.Repeat("a", 65)},
		{"OPTIONS", "/netmap/"}, {"DELETE", "/audit/api/file"},
		{"GET", "/audit"}, {"GET", "/audit-other/"}, {"GET", "/admin/"},
		{"GET", "https://evil/audit/"}, {"GET", "//evil/audit/"},
		{"GET", "/audit/../admin/"}, {"GET", "/audit/%2e%2e/admin/"},
		{"GET", "/audit/%252e%252e/admin/"}, {"GET", "/audit//api"},
		{"GET", "/audit/a\\b"}, {"TRACE", "/audit/"},
		{"GET", "/audit/api/unknown"}, {"HEAD", "/netmap/"},
		{"GET", "/netmap/api/unknown"}, {"GET", "/audit/\n"},
	} {
		if legacyProxyRoute(tc[0], tc[1]) {
			t.Fatal("unsafe route allowed", tc)
		}
	}
}

func TestLegacyProxyAuthSessionCSRFAndMachineBoundary(t *testing.T) {
	s := apiFixture(t)
	admin := apiUser(t, s, "legacy-admin", true)
	viewer := apiUser(t, s, "legacy-viewer", false)
	call := func(who apiIdentity, originalMethod, uri string, extra http.Header) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", s.Config.PublicURL+"/api/v1/legacy-proxy-auth", nil)
		if who.cookie != nil {
			r.AddCookie(who.cookie)
		}
		r.Header.Set("X-Original-Method", originalMethod)
		r.Header.Set("X-Original-URI", uri)
		for k, v := range extra {
			r.Header.Del(k)
			for _, value := range v {
				r.Header.Add(k, value)
			}
		}
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		return w
	}
	for _, tc := range []struct {
		who         apiIdentity
		method, uri string
		headers     http.Header
		status      int
	}{
		{apiIdentity{}, "GET", "/audit/", nil, 401}, {viewer, "GET", "/audit/", nil, 403},
		{admin, "GET", "/audit/", nil, 204}, {admin, "GET", "/netmap/api/sites/site-a", nil, 204}, {admin, "HEAD", "/netmap/api/sites/site-a", nil, 204}, {apiIdentity{}, "GET", "/netmap/api/sites/site-a", nil, 401}, {viewer, "GET", "/netmap/api/sites/site-a", nil, 403}, {admin, "POST", "/netmap/api/sites/site-a", nil, 403}, {admin, "GET", "/netmap/api/sites/site-b", nil, 204}, {apiIdentity{}, "GET", "/netmap/api/sites/site-b", nil, 401}, {viewer, "GET", "/netmap/api/sites/site-b", nil, 403}, {admin, "GET", "/netmap/api/sites/site-c", nil, 204}, {apiIdentity{}, "GET", "/netmap/api/sites/site-c", nil, 401}, {viewer, "GET", "/netmap/api/sites/site-c", nil, 403}, {admin, "POST", "/netmap/api/sites/site-c", nil, 403}, {admin, "HEAD", "/netmap/api/sites/site-c", nil, 204}, {admin, "HEAD", "/netmap/", nil, 403}, {admin, "OPTIONS", "/audit/hubs/scan-progress", nil, 204},
		{admin, "GET", "/audit/", http.Header{"Authorization": []string{"Bearer forged"}}, 401},
		{admin, "GET", "/audit/", http.Header{"X-Original-URI": []string{"/audit/", "/admin/"}}, 403},
		{admin, "POST", "/netmap/", nil, 403}, {admin, "POST", "/audit/api/scans", nil, 403},
		{admin, "POST", "/audit/api/scans", http.Header{"Origin": []string{s.Config.PublicURL}, "X-Csrf-Token": []string{admin.csrf}}, 204},
		{admin, "POST", "/audit/api/scans", http.Header{"Origin": []string{"https://evil.test"}, "X-Csrf-Token": []string{admin.csrf}}, 403},
		{admin, "POST", "/audit/api/scans", http.Header{"Origin": []string{s.Config.PublicURL}, "X-Csrf-Token": []string{admin.csrf, admin.csrf}}, 403},
		{admin, "GET", "/audit/hubs/scan-progress", http.Header{"X-Original-Upgrade": []string{"websocket"}, "Origin": []string{s.Config.PublicURL}}, 204},
		{admin, "GET", "/audit/hubs/scan-progress", http.Header{"X-Original-Upgrade": []string{"websocket"}, "Origin": []string{"https://evil.test"}}, 403},
		{admin, "GET", "/netmap/", http.Header{"X-Original-Upgrade": []string{"websocket"}, "Origin": []string{s.Config.PublicURL}}, 403},
	} {
		w := call(tc.who, tc.method, tc.uri, tc.headers)
		if w.Code != tc.status {
			t.Fatalf("%s %s got%d want%d %s", tc.method, tc.uri, w.Code, tc.status, w.Body.String())
		}
		if w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("cacheable auth")
		}
		if w.Body.Len() != 0 {
			t.Fatal("unexpected auth payload")
		}
	}
}

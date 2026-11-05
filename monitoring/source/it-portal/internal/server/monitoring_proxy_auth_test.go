package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestMonitoringProxyRoute(t *testing.T) {
	for _, tc := range [][2]string{{"GET", "/alertmanager/"}, {"GET", "/alertmanager/api/v2/alerts"}, {"GET", "/prometheus/api/v1/query?query=up"}, {"POST", "/prometheus/api/v1/query"}, {"POST", "/alertmanager/api/v2/silences"}, {"GET", "/reports/reports.json?ts=1"}, {"GET", "/reports/infrastructure-weekly-2026-W40-run-3.html"}, {"POST", "/api/reports/run"}, {"GET", "/loki/metrics"}, {"GET", "/health/proxy-relay"}} {
		if !monitoringProxyRoute(tc[0], tc[1]) {
			t.Fatal("valid route rejected", tc)
		}
	}
	for _, tc := range [][2]string{{"POST", "/prometheus/-/reload"}, {"POST", "/prometheus/api/v1/admin/tsdb/delete_series"}, {"POST", "/alertmanager/api/v2/alerts"}, {"POST", "/loki/api/v1/push"}, {"POST", "/api/reports/run?x=1"}, {"GET", "/reports/private.txt"}, {"GET", "/loki/api/v1/query"}, {"GET", "/prometheus/%2e%2e/admin"}, {"GET", "/alertmanager//api/v2/alerts"}, {"GET", "//evil/alertmanager/"}, {"TRACE", "/grafana/"}, {"GET", "/health/unknown"}} {
		if monitoringProxyRoute(tc[0], tc[1]) {
			t.Fatal("unsafe route allowed", tc)
		}
	}
}

func TestMonitoringProxyAuth(t *testing.T) {
	s := apiFixture(t)
	admin := apiUser(t, s, "monitoring-admin", true)
	viewer := apiUser(t, s, "monitoring-viewer", false)
	call := func(who apiIdentity, method, uri string, extra http.Header) int {
		r := httptest.NewRequest("GET", s.Config.PublicURL+"/api/v1/monitoring-proxy-auth", nil)
		if who.cookie != nil {
			r.AddCookie(who.cookie)
		}
		r.Header.Set("X-Original-Method", method)
		r.Header.Set("X-Original-URI", uri)
		for key, values := range extra {
			r.Header.Del(key)
			for _, value := range values {
				r.Header.Add(key, value)
			}
		}
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Header().Get("Cache-Control") != "no-store" || w.Body.Len() != 0 {
			t.Fatal("unsafe auth response")
		}
		return w.Code
	}
	for _, tc := range []struct {
		who         apiIdentity
		method, uri string
		header      http.Header
		want        int
	}{
		{apiIdentity{}, "GET", "/alertmanager/", nil, 401},
		{viewer, "GET", "/alertmanager/", nil, 403},
		{admin, "GET", "/alertmanager/", nil, 204},
		{admin, "GET", "/alertmanager/", http.Header{"Authorization": []string{"Bearer forged"}}, 401},
		{admin, "GET", "/alertmanager/", http.Header{"X-Original-URI": []string{"/alertmanager/", "/admin/"}}, 403},
		{admin, "POST", "/prometheus/-/reload", nil, 403},
		{admin, "POST", "/api/reports/run", nil, 403},
		{admin, "POST", "/api/reports/run", http.Header{"Origin": []string{s.Config.PublicURL}, "X-Csrf-Token": []string{admin.csrf}}, 204},
		{admin, "POST", "/api/reports/run", http.Header{"Origin": []string{s.Config.PublicURL}, "X-Csrf-Token": []string{"forged"}}, 403},
		{admin, "POST", "/alertmanager/api/v2/silences", http.Header{"Origin": []string{"https://evil.test"}}, 403},
		{admin, "POST", "/alertmanager/api/v2/silences", http.Header{"Origin": []string{s.Config.PublicURL}}, 204},
	} {
		if got := call(tc.who, tc.method, tc.uri, tc.header); got != tc.want {
			t.Fatalf("%s %s got %d want %d", tc.method, tc.uri, got, tc.want)
		}
	}
}

func TestMonitoringProxyNativeGrafanaToken(t *testing.T) {
	s := apiFixture(t)
	verify := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "Bearer redirect" {
			http.Redirect(w, r, "/grafana/api/user", http.StatusFound)
			return
		}
		if r.Header.Get("Authorization") == "Bearer error" {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		if r.Header.Get("Authorization") == "Bearer slow" {
			time.Sleep(50 * time.Millisecond)
		}
		if r.URL.Path != "/grafana/api/user" || r.Header.Get("Authorization") != "Bearer valid-service-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":0,"orgId":1,"login":"sa-codex","uid":"sa-uid"}`))
	}))
	defer verify.Close()
	s.Config.GrafanaTokenVerifyURL = verify.URL + "/grafana/api/user"
	s.Config.GrafanaNative = GrafanaNativeConfig{Login: "krasnodar-admin", UserID: 6, OrgID: 2}
	call := func(uri, token, cookie string, duplicate bool) int {
		r := httptest.NewRequest("GET", s.Config.PublicURL+"/api/v1/monitoring-proxy-auth", nil)
		r.Header.Set("X-Original-Method", "GET")
		r.Header.Set("X-Original-URI", uri)
		r.Header.Set("Authorization", token)
		if duplicate {
			r.Header.Add("Authorization", token)
		}
		if cookie != "" {
			r.Header.Set("Cookie", cookie)
		}
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		return w.Code
	}
	for _, tc := range []struct {
		uri, token, cookie string
		duplicate          bool
		want               int
	}{
		{"/grafana/api/search", "Bearer valid-service-token", "", false, 204},
		{"/grafana/api/search", "Bearer forged", "", false, 401},
		{"/grafana/api/search", "Bearer redirect", "", false, 401},
		{"/grafana/api/search", "Bearer error", "", false, 401},
		{"/grafana/api/search", "Bearer valid-service-token", "", true, 401},
		{"/grafana/api/search", "Bearer valid-service-token", "portal_session=forged", false, 401},
		{"/grafana/", "Bearer valid-service-token", "", false, 401},
		{"/prometheus/api/v1/query", "Bearer valid-service-token", "", false, 401},
	} {
		if got := call(tc.uri, tc.token, tc.cookie, tc.duplicate); got != tc.want {
			t.Fatalf("%s got %d want %d", tc.uri, got, tc.want)
		}
	}
	request := httptest.NewRequest(http.MethodGet, s.Config.PublicURL+"/api/v1/monitoring-proxy-auth", nil)
	ctx, cancel := context.WithTimeout(request.Context(), 10*time.Millisecond)
	defer cancel()
	if s.grafanaBearerValid(request.WithContext(ctx), "Bearer slow") {
		t.Fatal("timed-out verifier accepted")
	}
	s.Config.GrafanaTokenVerifyURL = ""
	if got := call("/grafana/api/search", "Bearer valid-service-token", "", false); got != http.StatusUnauthorized {
		t.Fatal("missing verifier configuration accepted", got)
	}
}

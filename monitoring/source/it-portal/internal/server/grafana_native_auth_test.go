package server

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestGrafanaNativeSessionGate(t *testing.T) {
	s := apiFixture(t)
	verify := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" || r.Header.Get("X-Grafana-Org-Id") != "" || r.Header.Get("X-WEBAUTH-USER") != "" || strings.Contains(r.Header.Get("Cookie"), "portal_session") {
			t.Error("client headers crossed verifier boundary")
		}
		c, _ := r.Cookie("grafana_session")
		if c == nil {
			w.WriteHeader(401)
			return
		}
		if c.Value == "redirect" {
			http.Redirect(w, r, "/elsewhere", 302)
			return
		}
		if c.Value == "error" {
			w.WriteHeader(503)
			return
		}
		if c.Value == "slow" {
			time.Sleep(100 * time.Millisecond)
		}
		if r.URL.Path == "/grafana/api/user/orgs" {
			switch c.Value {
			case "extraorg":
				fmt.Fprint(w, `[{"orgId":2,"role":"Viewer"},{"orgId":1,"role":"Viewer"}]`)
			case "editor":
				fmt.Fprint(w, `[{"orgId":2,"role":"Editor"}]`)
			default:
				fmt.Fprint(w, `[{"orgId":2,"role":"Viewer"}]`)
			}
			return
		}
		switch c.Value {
		case "otheruser":
			fmt.Fprint(w, `{"id":7,"orgId":2,"login":"krasnodar-admin","isGrafanaAdmin":false}`)
		case "mainorg":
			fmt.Fprint(w, `{"id":6,"orgId":1,"login":"krasnodar-admin","isGrafanaAdmin":false}`)
		case "pluban":
			fmt.Fprint(w, `{"id":1,"orgId":1,"login":"pluban","isGrafanaAdmin":true}`)
		case "admin":
			fmt.Fprint(w, `{"id":6,"orgId":2,"login":"krasnodar-admin","isGrafanaAdmin":true}`)
		case "missingflag":
			fmt.Fprint(w, `{"id":6,"orgId":2,"login":"krasnodar-admin"}`)
		case "wronglogin":
			fmt.Fprint(w, `{"id":6,"orgId":2,"login":"other","isGrafanaAdmin":false}`)
		default:
			fmt.Fprint(w, `{"id":6,"orgId":2,"login":"krasnodar-admin","isGrafanaAdmin":false}`)
		}
	}))
	defer verify.Close()
	s.Config.GrafanaTokenVerifyURL = verify.URL + "/grafana/api/user"
	s.Config.GrafanaNative = GrafanaNativeConfig{Login: "krasnodar-admin", UserID: 6, OrgID: 2}
	call := func(method, path, cookie, origin string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", s.Config.PublicURL+"/api/v1/monitoring-proxy-auth", nil)
		r.Header.Set("X-Original-Method", method)
		r.Header.Set("X-Original-URI", path)
		r.Header.Set("Cookie", cookie)
		r.Header.Set("X-Grafana-Org-Id", "1")
		r.Header.Set("X-WEBAUTH-USER", "admin")
		r.Header.Set("X-PL-Grafana-Mode", "native")
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		return w
	}
	admin := apiUser(t, s, "existing-admin", true)
	adminCookie := admin.cookie.Name + "=" + admin.cookie.Value + "; grafana_session=pluban"
	for _, method := range []string{"GET", "POST"} {
		w := call(method, "/grafana/api/dashboards/db", adminCookie, s.Config.PublicURL)
		if w.Code != 204 || w.Header().Get("X-PL-Grafana-Mode") != "" {
			t.Fatal("existing admin behavior changed", w.Code)
		}
	}
	viewer := apiUser(t, s, "existing-viewer", false)
	if w := call("GET", "/prometheus/api/v1/query", viewer.cookie.Name+"="+viewer.cookie.Value+"; grafana_session=valid", ""); w.Code != 403 {
		t.Fatal("native session opened non-Grafana prefix", w.Code)
	}
	for _, bad := range []string{"otheruser", "mainorg", "pluban", "admin", "missingflag", "wronglogin", "extraorg", "editor", "redirect", "error"} {
		if w := call("GET", "/grafana/api/search", "grafana_session="+bad, ""); w.Code != 401 {
			t.Fatalf("%s accepted: %d", bad, w.Code)
		}
	}
	for _, tc := range []struct {
		method, path, origin string
		want                 int
	}{
		{"GET", "/grafana/d/krasnodar-overview", "", 204}, {"GET", "/grafana/api/datasources", "", 204},
		{"POST", "/grafana/api/ds/query", s.Config.PublicURL, 204}, {"POST", "/grafana/api/ds/query", "https://evil.test", 403},
		{"POST", "/grafana/api/dashboards/db", s.Config.PublicURL, 403}, {"POST", "/grafana/api/user/using/1", s.Config.PublicURL, 403},
		{"GET", "/prometheus/api/v1/query", "", 401}, {"GET", "/loki/ready", "", 401},
	} {
		w := call(tc.method, tc.path, "portal_session=forged; grafana_session=valid; grafana_session_expiry=123", tc.origin)
		if w.Code != tc.want {
			t.Fatalf("%s %s: %d want%d", tc.method, tc.path, w.Code, tc.want)
		}
		if tc.want == 204 && (w.Header().Get("X-PL-Grafana-Org") != "2" || w.Header().Get("X-PL-Grafana-Cookie") != "grafana_session=valid") {
			t.Fatal("missing pinned context")
		}
	}
	if w := call("GET", "/grafana/api/search", "grafana_session=a; grafana_session=b", ""); w.Code != 401 {
		t.Fatal("duplicate session accepted")
	}
	request := httptest.NewRequest("GET", "http://localhost", nil)
	ctx, cancel := context.WithTimeout(request.Context(), 5*time.Millisecond)
	defer cancel()
	if s.grafanaNativeSessionValid(request.WithContext(ctx), "grafana_session=slow") {
		t.Fatal("timeout accepted")
	}
	s.Config.GrafanaNative = GrafanaNativeConfig{}
	if w := call("GET", "/grafana/api/search", "grafana_session=valid", ""); w.Code != 401 {
		t.Fatal("fallback not disabled by default")
	}
	if w := call("GET", "/grafana/login", "", ""); w.Code != 401 {
		t.Fatal("disabled bootstrap exposed")
	}
}

func TestGrafanaNativePublicLoginBoundary(t *testing.T) {
	s := apiFixture(t)
	s.Config.GrafanaTokenVerifyURL = "http://grafana:3000/grafana/api/user"
	s.Config.GrafanaNative = GrafanaNativeConfig{Login: "krasnodar-admin", UserID: 6, OrgID: 2}
	for _, tc := range []struct {
		method, path, origin string
		want                 int
	}{
		{"GET", "/grafana/login", "", 204}, {"GET", "/grafana/login?redirectTo=%2Fgrafana%2Fd%2Fkrasnodar-overview", "", 204},
		{"GET", "/grafana/public/build/app.123.js", "", 204}, {"GET", "/grafana/public/img/grafana_icon.svg", "", 204},
		{"POST", "/grafana/login", s.Config.PublicURL, 204}, {"POST", "/grafana/login", "https://evil.test", 403},
		{"GET", "/grafana/api/frontend/settings", "", 401}, {"GET", "/grafana/api/search", "", 401}, {"GET", "/grafana/", "", 401},
		{"GET", "/grafana/public/../api/search", "", 403}, {"GET", "/grafana/public/secrets.txt", "", 401},
	} {
		r := httptest.NewRequest("GET", s.Config.PublicURL+"/api/v1/monitoring-proxy-auth", nil)
		r.Header.Set("X-Original-Method", tc.method)
		r.Header.Set("X-Original-URI", tc.path)
		if tc.origin != "" {
			r.Header.Set("Origin", tc.origin)
		}
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Code != tc.want {
			t.Fatalf("%s %s: %d want%d", tc.method, tc.path, w.Code, tc.want)
		}
		if tc.want == 204 && (w.Header().Get("X-PL-Grafana-Mode") != "public" || w.Header().Get("X-PL-Grafana-Cookie") != "") {
			t.Fatal("public login forwarded cookie")
		}
	}
}

func TestGrafanaNativeLoadConfigFailsClosed(t *testing.T) {
	t.Setenv("PORTAL_DEMO", "true")
	t.Setenv("PORTAL_DATABASE_URL", "postgres://fixture")
	t.Setenv("PORTAL_PUBLIC_URL", "https://portal.example.test")
	t.Setenv("PORTAL_GRAFANA_TOKEN_VERIFY_URL", "http://grafana:3000/grafana/api/user")
	for _, key := range []string{"PORTAL_GRAFANA_NATIVE_LOGIN", "PORTAL_GRAFANA_NATIVE_USER_ID", "PORTAL_GRAFANA_NATIVE_ORG_ID"} {
		t.Setenv(key, "")
	}
	c, err := LoadConfig()
	if err != nil || c.grafanaNativeConfigured() {
		t.Fatal("default native fallback enabled", err)
	}
	t.Setenv("PORTAL_GRAFANA_NATIVE_LOGIN", "krasnodar-admin")
	if _, err = LoadConfig(); err == nil {
		t.Fatal("partial native configuration accepted")
	}
	t.Setenv("PORTAL_GRAFANA_NATIVE_USER_ID", "6")
	t.Setenv("PORTAL_GRAFANA_NATIVE_ORG_ID", "2")
	c, err = LoadConfig()
	if err != nil || !c.grafanaNativeConfigured() {
		t.Fatal("exact config rejected", err)
	}
	t.Setenv("PORTAL_GRAFANA_NATIVE_ORG_ID", "0")
	if _, err = LoadConfig(); err == nil {
		t.Fatal("invalid organization accepted")
	}
}

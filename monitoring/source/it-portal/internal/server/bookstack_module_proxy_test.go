package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/modules"
)

func bookstackNativePair() (model.Integration, model.ModuleInstance) {
	instance := model.ModuleInstance{ID: "22222222-2222-4222-8222-222222222222", IntegrationID: "33333333-3333-4333-8333-333333333333", ModuleID: "bookstack", Mode: "local", DesiredState: "enabled", ObservedState: "running"}
	return model.Integration{ID: instance.IntegrationID, ManagedModuleID: instance.ID, Kind: "bookstack", Enabled: true}, instance
}

func bookstackRoutingFixture(t *testing.T) (*Server, apiIdentity, *int, model.Integration, model.ModuleInstance) {
	t.Helper()
	s, admin := localUsersFixture(t)
	s.Config.PortableRelease = true
	calls := new(int)
	s.Modules = modules.New(s.Store, moduleControllerFunc(func(context.Context, modules.Operation) (modules.Observation, error) {
		*calls++
		return modules.Observation{}, nil
	}))
	integration, instance := bookstackNativePair()
	for kind, entry := range map[string]struct {
		id    string
		value any
	}{"integration": {integration.ID, integration}, "module_instance": {instance.ID, instance}} {
		if _, err := s.Store.Save(context.Background(), kind, entry.id, 0, entry.value, "test"); err != nil {
			t.Fatal(err)
		}
	}
	return s, admin, calls, integration, instance
}

func bookstackRoutingCall(s *Server, who apiIdentity, method, uri string, extra http.Header) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodGet, s.Config.PublicURL+"/internal/routing/bookstack", nil)
	if who.cookie != nil {
		r.AddCookie(who.cookie)
	}
	r.Header.Set("X-Original-Method", method)
	r.Header.Set("X-Original-URI", uri)
	for name, values := range extra {
		r.Header.Del(name)
		for _, value := range values {
			r.Header.Add(name, value)
		}
	}
	w := httptest.NewRecorder()
	s.moduleAuth(s.bookstackNativeUpstream).ServeHTTP(w, r)
	return w
}

func TestBookstackNativeRouteBoundsMethodsPrefixAndEncodedTraversal(t *testing.T) {
	for _, pair := range [][2]string{{"GET", "/wiki/"}, {"HEAD", "/wiki/dist/app.js"}, {"POST", "/wiki/login"}, {"PUT", "/wiki/pages/1"}, {"PATCH", "/wiki/api/pages/1"}, {"DELETE", "/wiki/attachments/1"}, {"GET", "/wiki/books/%D0%98%D0%A2/page?search=a%2Fb&return=%2Fwiki%2F"}} {
		if !bookstackNativeRoute(pair[0], pair[1]) {
			t.Fatal("native route rejected", pair)
		}
	}
	for _, pair := range [][2]string{{"GET", "/wiki"}, {"GET", "/wikievil/"}, {"GET", "/grafana/"}, {"GET", "//evil/wiki/"}, {"GET", "http://evil/wiki/"}, {"GET", "/wiki/../auth/logout"}, {"GET", "/wiki/%2e%2E/auth/logout"}, {"GET", "/wiki/%252e%252e/auth/logout"}, {"GET", "/wiki/x%2f..%2fauth"}, {"GET", "/wiki/x%5c..%5cauth"}, {"GET", "/wiki//pages"}, {"GET", "/wiki/a%00b"}, {"GET", "/wiki/a%0ab"}, {"GET", "/wiki/a?x=%0d%0aInjected"}, {"GET", "/wiki/a?x=%QQ"}, {"GET", "/wiki/a#fragment"}, {"GET", "/wiki/a b"}, {"OPTIONS", "/wiki/"}, {"TRACE", "/wiki/"}, {"CONNECT", "/wiki/"}, {"post", "/wiki/login"}} {
		if bookstackNativeRoute(pair[0], pair[1]) {
			t.Fatal("unsafe route admitted", pair)
		}
	}
}

func TestBookstackNativeContainerUpstreamRequiresRunningBoundCanonicalOwner(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*model.Integration, *model.ModuleInstance)
		valid  bool
	}{
		{"local", func(*model.Integration, *model.ModuleInstance) {}, true},
		{"untrusted-url-ignored", func(i *model.Integration, m *model.ModuleInstance) {
			i.URL = "http://attacker.invalid/"
			m.Endpoint = "http://169.254.169.254/"
		}, true},
		{"wrong-kind", func(i *model.Integration, _ *model.ModuleInstance) { i.Kind = "grafana" }, false},
		{"disabled-integration", func(i *model.Integration, _ *model.ModuleInstance) { i.Enabled = false }, false},
		{"disabled-module", func(_ *model.Integration, m *model.ModuleInstance) { m.DesiredState = "disabled" }, false},
		{"unavailable-module", func(_ *model.Integration, m *model.ModuleInstance) { m.ObservedState = "unavailable" }, false},
		{"external", func(_ *model.Integration, m *model.ModuleInstance) { m.Mode = "external" }, false},
		{"foreign-module", func(_ *model.Integration, m *model.ModuleInstance) { m.ModuleID = "grafana" }, false},
		{"foreign-owner", func(_ *model.Integration, m *model.ModuleInstance) { m.IntegrationID = "foreign" }, false},
		{"foreign-instance", func(i *model.Integration, _ *model.ModuleInstance) { i.ManagedModuleID = "foreign" }, false},
		{"empty-owner", func(i *model.Integration, m *model.ModuleInstance) { i.ID = ""; m.IntegrationID = "" }, false},
		{"target-id", func(i *model.Integration, m *model.ModuleInstance) { m.ID = "evil:80/"; i.ManagedModuleID = m.ID }, false},
		{"uppercase-id", func(i *model.Integration, m *model.ModuleInstance) {
			m.ID = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"
			i.ManagedModuleID = m.ID
		}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			i, m := bookstackNativePair()
			tc.mutate(&i, &m)
			got, valid := bookstackNativeContainerUpstream(i, m)
			if valid != tc.valid || !valid && got != "" {
				t.Fatalf("upstream=%q valid=%v want=%v", got, valid, tc.valid)
			}
			if valid && got != "http://pl-bookstack-22222222-2222-4222-8222-222222222222:80" {
				t.Fatal("upstream used untrusted endpoint", got)
			}
		})
	}
}

func TestBookstackNativeCookieIsolationPreservesNativeCSRFAndRememberMe(t *testing.T) {
	for _, tc := range []struct {
		values []string
		want   string
		valid  bool
	}{
		{nil, "", true},
		{[]string{"portal_session=private"}, "", true},
		{[]string{"portal_session=private; pl_bookstack_session=native; XSRF-TOKEN=csrf%3D; remember_web_hash=remember"}, "pl_bookstack_session=native; XSRF-TOKEN=csrf%3D; remember_web_hash=remember", true},
		{[]string{"portal_session = one; pl_bookstack_session=native", "portal_session=two; native_extension=opaque=="}, "pl_bookstack_session=native; native_extension=opaque==", true},
		{[]string{"portal_session_extra=native; Portal_session=case-sensitive"}, "portal_session_extra=native; Portal_session=case-sensitive", true},
		{[]string{"pl_bookstack_session=native\r\nInjected: x"}, "", false},
		{[]string{strings.Repeat("x", 16385)}, "", false},
	} {
		got, valid := bookstackNativeCookies(tc.values)
		if valid != tc.valid || got != tc.want {
			t.Fatalf("cookie isolation got=%q valid=%v want=%q valid=%v", got, valid, tc.want, tc.valid)
		}
	}
}

func TestBookstackNativeGateRequiresCurrentPlatformAdminSessionOnEveryRequest(t *testing.T) {
	s, admin, calls, _, _ := bookstackRoutingFixture(t)
	viewer := apiUser(t, s, "wiki-viewer", false)
	for _, tc := range []struct {
		who  apiIdentity
		head http.Header
		want int
	}{
		{apiIdentity{}, nil, http.StatusUnauthorized},
		{viewer, nil, http.StatusForbidden},
		{admin, http.Header{"Authorization": {"Bearer native-token"}}, http.StatusForbidden},
		{apiIdentity{}, http.Header{"Cookie": {"pl_bookstack_session=native"}, "X-WEBAUTH-USER": {"admin"}, "X-PL-User": {"admin"}}, http.StatusUnauthorized},
		{admin, nil, http.StatusNoContent},
	} {
		w := bookstackRoutingCall(s, tc.who, "GET", "/wiki/login", tc.head)
		if w.Code != tc.want {
			t.Fatalf("gate status=%d want=%d", w.Code, tc.want)
		}
	}
	if _, err := s.Store.Pool.Exec(context.Background(), "DELETE FROM sessions WHERE token_hash=$1", hash(admin.cookie.Value)); err != nil {
		t.Fatal(err)
	}
	if w := bookstackRoutingCall(s, admin, "GET", "/wiki/", nil); w.Code != http.StatusUnauthorized {
		t.Fatal("revoked session reused routing metadata", w.Code)
	}
	if *calls != 0 {
		t.Fatal("routing polled root controller")
	}
}

func TestBookstackNativeWritesRequireOriginalSameOriginAndNativeCSRFIsNotReplaced(t *testing.T) {
	s, admin, calls, _, _ := bookstackRoutingFixture(t)
	for _, tc := range []struct {
		method string
		head   http.Header
		want   int
	}{
		{"POST", nil, 403},
		{"POST", http.Header{"Origin": {s.Config.PublicURL}}, 403},
		{"POST", http.Header{"X-Original-Origin": {"https://evil.invalid"}}, 403},
		{"POST", http.Header{"X-Original-Origin": {s.Config.PublicURL + "/"}}, 403},
		{"POST", http.Header{"X-Original-Origin": {s.Config.PublicURL, s.Config.PublicURL}}, 403},
		{"POST", http.Header{"X-Original-Origin": {s.Config.PublicURL}, "X-Original-Sec-Fetch-Site": {"cross-site"}}, 403},
		{"POST", http.Header{"X-Original-Origin": {s.Config.PublicURL}, "X-Csrf-Token": {"native-bookstack-csrf"}, "X-Xsrf-Token": {"native-xsrf"}}, 204},
		{"PUT", http.Header{"X-Original-Origin": {s.Config.PublicURL}}, 204},
		{"PATCH", http.Header{"X-Original-Origin": {s.Config.PublicURL}}, 204},
		{"DELETE", http.Header{"X-Original-Origin": {s.Config.PublicURL}}, 204},
		{"GET", http.Header{"X-Original-Origin": {"https://evil.invalid"}}, 403},
		{"GET", http.Header{"X-Original-Upgrade": {"websocket"}}, 403},
		{"GET", http.Header{"X-Original-URI": {"/wiki/", "/admin/"}}, 403},
		{"GET", http.Header{"X-Original-Method": {"GET", "POST"}}, 403},
	} {
		w := bookstackRoutingCall(s, admin, tc.method, "/wiki/pages/1", tc.head)
		if w.Code != tc.want {
			t.Fatalf("method=%s headers=%v status=%d want=%d", tc.method, tc.head, w.Code, tc.want)
		}
		if w.Code != 204 && (w.Header().Get("X-Pl-Bookstack-Upstream") != "" || w.Header().Get("X-Pl-Bookstack-Cookie") != "") {
			t.Fatal("rejected request returned routing metadata")
		}
	}
	if *calls != 0 {
		t.Fatal("native write gate contacted a provider/controller")
	}
}

func TestBookstackNativeSelectionRejectsUnavailableAmbiguousAndForeignSources(t *testing.T) {
	for _, scenario := range []string{"disabled-integration", "disabled-module", "unavailable-module", "external", "foreign-owner", "ambiguous-integration", "ambiguous-running-instance"} {
		t.Run(scenario, func(t *testing.T) {
			s, admin, _, integration, instance := bookstackRoutingFixture(t)
			switch scenario {
			case "disabled-integration":
				integration.Enabled = false
			case "disabled-module":
				instance.DesiredState = "disabled"
			case "unavailable-module":
				instance.ObservedState = "unavailable"
			case "external":
				instance.Mode = "external"
			case "foreign-owner":
				instance.IntegrationID = "foreign"
			case "ambiguous-integration":
				other := integration
				other.ID = "44444444-4444-4444-8444-444444444444"
				if _, err := s.Store.Save(context.Background(), "integration", other.ID, 0, other, "test"); err != nil {
					t.Fatal(err)
				}
			case "ambiguous-running-instance":
				other := instance
				other.ID = "44444444-4444-4444-8444-444444444444"
				if _, err := s.Store.Save(context.Background(), "module_instance", other.ID, 0, other, "test"); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := s.Store.Save(context.Background(), "integration", integration.ID, 1, integration, "test"); err != nil {
				t.Fatal(err)
			}
			if _, err := s.Store.Save(context.Background(), "module_instance", instance.ID, 1, instance, "test"); err != nil {
				t.Fatal(err)
			}
			w := bookstackRoutingCall(s, admin, "GET", "/wiki/", nil)
			if w.Code != 503 || w.Header().Get("X-Pl-Bookstack-Upstream") != "" {
				t.Fatalf("foreign/unavailable source selected: %d", w.Code)
			}
		})
	}
}

func TestBookstackNativeMetadataReturnsOnlyFixedAliasAndFilteredCookies(t *testing.T) {
	s, admin, calls, integration, instance := bookstackRoutingFixture(t)
	integration.URL = "http://attacker.invalid/"
	instance.Endpoint = "http://169.254.169.254/"
	if _, err := s.Store.Save(context.Background(), "integration", integration.ID, 1, integration, "test"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Store.Save(context.Background(), "module_instance", instance.ID, 1, instance, "test"); err != nil {
		t.Fatal(err)
	}
	w := bookstackRoutingCall(s, admin, "GET", "/wiki/login?redirect=%2Fwiki%2F", http.Header{
		"Cookie":         {"portal_session=" + admin.cookie.Value + "; pl_bookstack_session=native; XSRF-TOKEN=native-csrf"},
		"X-WEBAUTH-USER": {"forged"}, "X-PL-Gateway-Assertion": {"forged"}, "X-Pl-Bookstack-Upstream": {"http://attacker.invalid/"},
	})
	if w.Code != 204 || w.Header().Get("X-Pl-Bookstack-Upstream") != "http://pl-bookstack-"+instance.ID+":80" || w.Header().Get("X-Pl-Bookstack-Cookie") != "pl_bookstack_session=native; XSRF-TOKEN=native-csrf" {
		t.Fatalf("metadata mismatch: %d %v", w.Code, w.Header())
	}
	for _, header := range []string{"Set-Cookie", "Authorization", "X-WEBAUTH-USER", "X-PL-Gateway-Assertion", "X-PL-User"} {
		if w.Header().Get(header) != "" {
			t.Fatal("metadata leaked identity or created a session", header)
		}
	}
	if w.Header().Get("Cache-Control") != "no-store" || w.Body.Len() != 0 || *calls != 0 {
		t.Fatal("routing metadata was cached, carried a body or polled runtime")
	}
}

func TestBookstackNativeHandlerRejectsMissingExpiredContextAndRoutingParameters(t *testing.T) {
	s := &Server{Config: Config{PortableRelease: true, PublicURL: "https://pl.example"}}
	for _, sess := range []session{{}, {User: model.User{ID: "admin", Admin: true}, ExpiresAt: time.Now().Add(-time.Minute)}} {
		r := httptest.NewRequest(http.MethodGet, "/internal/routing/bookstack", nil)
		r = r.WithContext(context.WithValue(r.Context(), sessionKey, sess))
		w := httptest.NewRecorder()
		s.bookstackNativeUpstream(w, r)
		if w.Code != 401 {
			t.Fatal("missing/expired context accepted", w.Code)
		}
	}
	for _, target := range []string{"/internal/routing/bookstack?upstream=http://evil/", "/internal/routing/bookstack?instance_id=arbitrary"} {
		w := httptest.NewRecorder()
		s.bookstackNativeUpstream(w, httptest.NewRequest(http.MethodGet, target, nil))
		if w.Code != 400 || w.Header().Get("X-Pl-Bookstack-Upstream") != "" {
			t.Fatal("routing query accepted", w.Code)
		}
	}
	s.Config.PortableRelease = false
	w := httptest.NewRecorder()
	s.bookstackNativeUpstream(w, httptest.NewRequest(http.MethodGet, "/internal/routing/bookstack", nil))
	if w.Code != 404 {
		t.Fatal("native Wiki route active outside portable mode", w.Code)
	}
}

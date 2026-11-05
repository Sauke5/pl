package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"pl/portal/internal/modules"
)

type deliveryProxyControllerFixture struct {
	deliveryControllerFixture
	proxyCalls int
}

func (c *deliveryProxyControllerFixture) DeliveryProxyStatus(context.Context) (modules.DeliveryProxyStatus, error) {
	c.proxyCalls++
	return modules.DeliveryProxyStatus{CoreAPI: 1, Revision: 3, Configuration: modules.DeliveryProxyPublicConfiguration{Mode: modules.DeliveryProxyDirect}, XrayInbounds: []modules.DeliveryProxyInbound{}}, nil
}
func (c *deliveryProxyControllerFixture) ConfigureDeliveryProxy(ctx context.Context, v modules.DeliveryProxyChange) (modules.DeliveryProxyStatus, error) {
	return c.DeliveryProxyStatus(ctx)
}
func (c *deliveryProxyControllerFixture) TestDeliveryProxy(context.Context, modules.DeliveryProxyTestRequest) (modules.DeliveryProxyTestResult, error) {
	c.proxyCalls++
	return modules.DeliveryProxyTestResult{OK: true, Mode: modules.DeliveryProxyDirect, LatestVersion: "0.4.0", CheckedAt: "2026-11-05T12:00:00Z"}, nil
}
func proxyHTTPPayload(test bool) map[string]any {
	value := map[string]any{"revision": 3, "configuration": map[string]any{"mode": "direct"}}
	if !test {
		value["operation_id"] = "727b18f8-99da-410f-b94f-e677f2967731"
	}
	return value
}

func TestDeliveryProxyRoutesRequireCurrentAdminBrowserAndCSRF(t *testing.T) {
	s, admin := localUsersFixture(t)
	s.Config.PortableRelease = true
	c := &deliveryProxyControllerFixture{}
	s.Modules = modules.New(s.Store, c)
	viewer := apiUser(t, s, "proxy-viewer", false)
	for _, route := range []struct {
		method, path string
		body         any
	}{{"GET", "/api/v1/delivery/proxy", nil}, {"PUT", "/api/v1/delivery/proxy", proxyHTTPPayload(false)}, {"POST", "/api/v1/delivery/proxy/test", proxyHTTPPayload(true)}} {
		for _, who := range []apiIdentity{viewer, {}} {
			w := apiCall(s, who, route.method, route.path, route.body, nil)
			if w.Code != 401 && w.Code != 403 {
				t.Fatal("proxy route lacked administrator authorization")
			}
		}
		w := apiCall(s, admin, route.method, route.path, route.body, map[string]string{"Authorization": "Bearer proxy-machine-fixture"})
		if w.Code != 403 {
			t.Fatal("machine credential reached proxy configuration")
		}
		if route.method != "GET" {
			for _, headers := range []map[string]string{{"Origin": "https://other.example.test"}, {"X-CSRF-Token": "forged"}} {
				w = apiCall(s, admin, route.method, route.path, route.body, headers)
				if w.Code != 403 {
					t.Fatal("proxy unsafe request lacked Origin/CSRF validation")
				}
			}
		}
	}
	if c.proxyCalls != 0 {
		t.Fatal("unauthorized proxy request reached controller")
	}
	for _, route := range []struct {
		method, path string
		body         any
	}{{"GET", "/api/v1/delivery/proxy", nil}, {"PUT", "/api/v1/delivery/proxy", proxyHTTPPayload(false)}, {"POST", "/api/v1/delivery/proxy/test", proxyHTTPPayload(true)}} {
		w := apiCall(s, admin, route.method, route.path, route.body, nil)
		if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("finite proxy route failed or response was cacheable")
		}
	}
	if c.proxyCalls != 3 {
		t.Fatal("finite proxy forwarding changed")
	}
}

func TestDeliveryProxyRoutesRejectUnknownFieldsInactiveModesAndBodyOverLimit(t *testing.T) {
	s, admin := localUsersFixture(t)
	s.Config.PortableRelease = true
	c := &deliveryProxyControllerFixture{}
	s.Modules = modules.New(s.Store, c)
	for _, body := range []map[string]any{
		{"revision": 3, "configuration": map[string]any{"mode": "direct"}, "url": "https://arbitrary.example.test"},
		{"revision": 3, "configuration": map[string]any{"mode": "direct", "password": "proxy-never-echo"}},
		{"revision": 3, "configuration": map[string]any{"mode": "direct", "ca_pem": nil}},
		{"revision": 3, "configuration": map[string]any{"mode": "direct", "external": nil}},
		{"configuration": map[string]any{"mode": "direct"}},
		{"revision": 3, "configuration": map[string]any{"mode": "direct", "external": map[string]any{"protocol": "http", "host": "proxy.example.test", "port": 3128}}},
		{"revision": 3, "configuration": map[string]any{"mode": "external", "external": map[string]any{"protocol": "http", "host": "proxy.example.test", "port": 3128, "auth": "none", "username": "", "password_action": "clear", "url": "arbitrary"}}},
	} {
		w := apiCall(s, admin, "POST", "/api/v1/delivery/proxy/test", body, nil)
		if w.Code != 400 || strings.Contains(w.Body.String(), "proxy-never-echo") {
			t.Fatal("invalid proxy body accepted or exposed")
		}
	}
	good, _ := json.Marshal(proxyHTTPPayload(true))
	r := httptest.NewRequest("POST", s.Config.PublicURL+"/api/v1/delivery/proxy/test", strings.NewReader(string(good)+strings.Repeat(" ", modules.DeliveryProxyRequestLimit)))
	r.AddCookie(admin.cookie)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", s.Config.PublicURL)
	r.Header.Set("X-CSRF-Token", admin.csrf)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != 400 || c.proxyCalls != 0 {
		t.Fatal("oversized request reached proxy controller")
	}
}

func TestDeliveryProxyRechecksAdminAfterReadingCredentialBody(t *testing.T) {
	for _, test := range []bool{false, true} {
		s, _ := localUsersFixture(t)
		s.Config.PortableRelease = true
		c := &deliveryProxyControllerFixture{}
		s.Modules = modules.New(s.Store, c)
		admin := apiUser(t, s, "proxy-revoked-admin", true)
		body, _ := json.Marshal(proxyHTTPPayload(test))
		reader := &installationRevokingBody{reader: bytes.NewReader(body), revoke: func() {
			if _, err := s.Store.Pool.Exec(context.Background(), "DELETE FROM sessions WHERE user_id='proxy-revoked-admin'"); err != nil {
				t.Fatal("fixture session revocation failed")
			}
		}}
		method, path := "PUT", "/api/v1/delivery/proxy"
		if test {
			method, path = "POST", "/api/v1/delivery/proxy/test"
		}
		r := httptest.NewRequest(method, s.Config.PublicURL+path, reader)
		r.AddCookie(admin.cookie)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", s.Config.PublicURL)
		r.Header.Set("X-CSRF-Token", admin.csrf)
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Code != 403 || c.proxyCalls != 0 {
			t.Fatal("revoked administrator sent proxy credentials to controller")
		}
	}
}

func TestDeliveryProxyUnavailableControllerDoesNotExposeInternalErrors(t *testing.T) {
	s, admin := localUsersFixture(t)
	s.Config.PortableRelease = true
	s.Modules = modules.New(s.Store, &deliveryControllerFixture{})
	w := apiCall(s, admin, "GET", "/api/v1/delivery/proxy", nil, nil)
	if w.Code != 503 || !strings.Contains(w.Body.String(), "delivery_proxy_unavailable") {
		t.Fatal("missing optional proxy capability did not fail closed")
	}
}

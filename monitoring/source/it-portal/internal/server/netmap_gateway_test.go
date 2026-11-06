package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"pl/portal/internal/model"
)

const netmapGatewayID = "123e4567-e89b-42d3-a456-426614174000"

type netmapFakeBackend struct {
	call func(context.Context, string, string, string, string, string, http.Header, []byte) (*http.Response, error)
	find func() (model.ModuleInstance, error)
}

func (f *netmapFakeBackend) FindApplication(context.Context, string) (model.ModuleInstance, error) {
	if f.find != nil {
		return f.find()
	}
	return model.ModuleInstance{ID: netmapGatewayID, Version: "1.0.0"}, nil
}
func (f *netmapFakeBackend) ApplicationKey(context.Context, string) ([]byte, error) {
	return bytes.Repeat([]byte{7}, 32), nil
}
func (f *netmapFakeBackend) NetMapRequest(c context.Context, id, m, p, q, ct string, h http.Header, b []byte) (*http.Response, error) {
	return f.call(c, id, m, p, q, ct, h, b)
}
func netmapSession() session {
	return session{User: model.User{ID: "local:netmap-admin", Name: "Администратор", Admin: true}, CSRF: "fixture-current-platform-csrf"}
}
func netmapFixture(t *testing.T, callback func(*http.Request, []byte) *http.Response) *netmapHandler {
	t.Helper()
	g := &netmapHandler{server: &Server{Config: Config{PublicURL: "https://portal.example.test"}}, slots: make(chan struct{}, 2), waiting: make(chan struct{}, 16), session: func(*http.Request) (session, error) { return netmapSession(), nil }}
	g.backend = &netmapFakeBackend{call: func(ctx context.Context, id, m, p, q, ct string, h http.Header, body []byte) (*http.Response, error) {
		request := httptest.NewRequest(m, "https://portal.example.test"+p+func() string {
			if q != "" {
				return "?" + q
			}
			return ""
		}(), bytes.NewReader(body))
		request.Header = h.Clone()
		if ct != "" {
			request.Header.Set("Content-Type", ct)
		}
		claims := decodeDirectoryAssertion(t, request, bytes.Repeat([]byte{7}, 32))
		sum := sha256.Sum256(body)
		if id != netmapGatewayID || claims.Audience != "netmap" || claims.Version != 2 || !claims.Admin || claims.URI != request.URL.RequestURI() || claims.BodySHA256 != hex.EncodeToString(sum[:]) || claims.Method != m {
			t.Error("identity/target/body not bound")
		}
		return callback(request, body), nil
	}}
	return g
}
func netmapResponse(contentType, body string) *http.Response {
	return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{contentType}}, Body: io.NopCloser(strings.NewReader(body))}
}
func netmapCall(g *netmapHandler, method, path, body string, headers http.Header, mapped bool) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "https://portal.example.test"+path, strings.NewReader(body))
	r.RemoteAddr = "192.0.2.10:1234"
	r.Header = headers.Clone()
	if r.Header == nil {
		r.Header = http.Header{}
	}
	r.SetPathValue("id", netmapGatewayID)
	if mapped {
		tail := strings.TrimPrefix(path, "/api/v1/modules/"+netmapGatewayID+"/netmap/")
		r.SetPathValue("path", tail)
	}
	w := httptest.NewRecorder()
	id := ""
	if mapped {
		id = netmapGatewayID
	}
	g.serve(w, r, id, mapped)
	return w
}

func TestNetmapFiniteRoutesAndSignedURI(t *testing.T) {
	for _, item := range [][2]string{{"POST", "/netmap/api/networks/1234567890abcdef/observations"}, {"GET", "/netmap/?scope=network-1234567890abcdef"}, {"GET", "/netmap/api/sites/network-1234567890abcdef"}, {"HEAD", "/netmap/office-view.js"}, {"GET", "/netmap/netbox/dcim/devices/?q=router"}, {"POST", "/netmap/gitea/user/login"}, {"PATCH", "/netmap/netbox/api/dcim/devices/7/"}} {
		r := httptest.NewRequest(item[0], "https://portal.example.test"+item[1], nil)
		if _, ok := netmapMatchRoute(r); !ok {
			t.Fatal("route rejected", item)
		}
	}
	for _, item := range [][2]string{{"GET", "/netmap/api/networks/1234567890abcdef/observations"}, {"POST", "/netmap/api/networks/1234567890abcdef/observations?source=x"}, {"POST", "/netmap/api/networks/not-an-id/observations"}, {"GET", "/netmap/.env"}, {"GET", "/netmap/fixture.json"}, {"GET", "/netmap/api/sites/unknown"}, {"GET", "/netmap/?scope=network&scope=network"}, {"GET", "/netmap/?upstream=http://foreign"}, {"GET", "/netmap/netbox/../gitea/"}, {"GET", "/netmap/netbox/%2e%2e/private"}, {"GET", "/netmap/gitea/user?q=%0d%0aInjected"}, {"OPTIONS", "/netmap/netbox/"}, {"DELETE", "/netmap/api/networks"}} {
		r := httptest.NewRequest(item[0], "https://portal.example.test"+item[1], nil)
		if _, ok := netmapMatchRoute(r); ok {
			t.Fatal("unsafe route admitted", item)
		}
	}
}

func TestNetmapDeviceRoutesKeepFiniteIDsQueriesAndAdminScopes(t *testing.T) {
	for _, item := range [][2]string{
		{"GET", "/netmap/api/devices?network=0123456789abcdef"},
		{"HEAD", "/netmap/api/devices/42"},
		{"POST", "/netmap/api/devices/42/ssh-binding"},
		{"POST", "/netmap/api/devices/42/collect"},
	} {
		route, ok := netmapMatchRoute(httptest.NewRequest(item[0], "https://portal.example.test"+item[1], nil))
		if !ok || route.scope != "netmap:admin" || route.media != "application/json" {
			t.Fatal("finite device route rejected or scope weakened", item, route)
		}
	}
	for _, item := range [][2]string{
		{"GET", "/netmap/api/devices"}, {"GET", "/netmap/api/devices?network=0123456789abcdef&network=0123456789abcdef"},
		{"GET", "/netmap/api/devices?network=0123456789abcdef&url=http://foreign"},
		{"GET", "/netmap/api/devices?network=not-a-network"},
		{"GET", "/netmap/api/devices/0"}, {"GET", "/netmap/api/devices/01"},
		{"GET", "/netmap/api/devices/1000000000000000"},
		{"GET", "/netmap/api/devices/42?network=0123456789abcdef"},
		{"GET", "/netmap/api/devices/42/collect"}, {"PUT", "/netmap/api/devices/42/ssh-binding"},
		{"POST", "/netmap/api/devices/42/collect?force=true"},
	} {
		if _, ok := netmapMatchRoute(httptest.NewRequest(item[0], "https://portal.example.test"+item[1], nil)); ok {
			t.Fatal("non-contract device route admitted", item)
		}
	}
}

func TestNetmapDeviceWriteAuthenticatesExactVersionBodyAndRejectsViewerAndCSRF(t *testing.T) {
	body := `{"version":"W/\"2026-11-06T00:00:00+00:00\""}`
	calls := 0
	g := netmapFixture(t, func(r *http.Request, raw []byte) *http.Response {
		calls++
		if r.Method != "POST" || r.URL.Path != "/netmap/api/devices/42/collect" || string(raw) != body {
			t.Fatal("device collection target/version/body changed")
		}
		return netmapResponse("application/json", `{"state":"queued","device_id":42}`)
	})
	headers := http.Header{"Origin": {g.server.Config.PublicURL}, "Content-Type": {"application/json"}, "X-Csrf-Token": {netmapSession().CSRF}, "Idempotency-Key": {netmapGatewayID}}
	path := "/api/v1/modules/" + netmapGatewayID + "/netmap/devices/42/collect"
	if w := netmapCall(g, "POST", path, body, headers, true); w.Code != 200 {
		t.Fatal("authenticated collection rejected", w.Code)
	}
	invalid := headers.Clone()
	invalid.Set("X-Csrf-Token", "forged")
	if w := netmapCall(g, "POST", path, body, invalid, true); w.Code != 403 {
		t.Fatal("forged CSRF admitted", w.Code)
	}
	g.session = func(*http.Request) (session, error) {
		value := netmapSession()
		value.User.Admin = false
		return value, nil
	}
	if w := netmapCall(g, "POST", path, body, headers, true); w.Code != 403 {
		t.Fatal("viewer collection admitted", w.Code)
	}
	if calls != 1 {
		t.Fatal("rejected request reached adapter", calls)
	}
}

func TestNetmapExpiredSessionRedirectsOnlyKnownDocuments(t *testing.T) {
	g := netmapFixture(t, func(*http.Request, []byte) *http.Response {
		t.Fatal("anonymous request reached adapter")
		return nil
	})
	g.session = func(*http.Request) (session, error) { return session{}, errors.New("expired") }
	for _, tc := range []struct {
		method, path string
		mapped       bool
		want         int
	}{
		{"GET", "/netmap/", false, 303},
		{"GET", "/netmap/netbox/login/", false, 303},
		{"GET", "/netmap/api/networks", false, 401},
		{"GET", "/netmap/app.js", false, 401},
		{"POST", "/netmap/gitea/user/login", false, 401},
		{"GET", "/api/v1/modules/" + netmapGatewayID + "/netmap/networks", true, 401},
		{"GET", "/netmap/.env", false, 401},
	} {
		w := netmapCall(g, tc.method, tc.path, "", http.Header{"Accept": {"text/html"}}, tc.mapped)
		if w.Code != tc.want || (tc.want == 303 && w.Header().Get("Location") != "/401?return_to=%2Fnetmap%2F") || (tc.want == 401 && w.Header().Get("Location") != "") {
			t.Fatal(tc, w.Code, w.Header())
		}
	}
}

func TestNetmapMappedManagementUsesCurrentPlCSRFAndRewrittenSignature(t *testing.T) {
	calls := 0
	g := netmapFixture(t, func(r *http.Request, body []byte) *http.Response {
		calls++
		if r.URL.Path != "/netmap/api/profiles" || r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" || r.Header.Get("X-Auth-User") != "" || r.Header.Get("X-CSRF-Token") != gatewayServiceCSRF(netmapSession().CSRF, "netmap") {
			t.Error("management request not isolated/rewritten")
		}
		return netmapResponse("application/json", `{"id":"fixture"}`)
	})
	headers := http.Header{"Origin": []string{g.server.Config.PublicURL}, "Content-Type": []string{"application/json"}, "X-Csrf-Token": []string{netmapSession().CSRF}, "Idempotency-Key": []string{netmapGatewayID}, "Cookie": []string{"portal_session=secret"}, "X-Auth-User": []string{"forged"}}
	path := "/api/v1/modules/" + netmapGatewayID + "/netmap/profiles"
	if w := netmapCall(g, "POST", path, `{"id":"fixture"}`, headers, true); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	for _, mutation := range []func(http.Header){func(h http.Header) { h.Set("Origin", "https://foreign.test") }, func(h http.Header) { h.Set("X-CSRF-Token", "forged") }, func(h http.Header) { h.Del("Idempotency-Key") }, func(h http.Header) { h.Set("Content-Type", "text/plain") }, func(h http.Header) { h.Add("Origin", g.server.Config.PublicURL) }} {
		h := headers.Clone()
		mutation(h)
		if w := netmapCall(g, "POST", path, `{}`, h, true); w.Code == 200 {
			t.Fatal("unsafe management request passed")
		}
	}
	if calls != 1 {
		t.Fatal("rejected request reached adapter", calls)
	}
}

func TestNetmapManagementValidationReturnsFiniteRussianProblems(t *testing.T) {
	for _, tc := range []struct {
		name, body, code, message string
		status                    int
	}{
		{"snmp", `{"error":"netmap_snmp_required"}`, "netmap_snmp_required", "укажите SNMP community", 400},
		{"observations", `{"error":"netmap_invalid_observations"}`, "netmap_invalid_observations", "записи наблюдений", 400},
		{"profile", `{"error":"netmap_profile_missing"}`, "netmap_profile_missing", "не найден профиль", 400},
		{"legacy", `{"error":"invalid NetMap request"}`, "netmap_invalid_request", "Проверьте настройки", 400},
		{"private", `{"error":"private-password","detail":"private-host"}`, "netmap_invalid_request", "Проверьте настройки", 400},
		{"busy", `{"error":"netmap_poll_running"}`, "netmap_poll_running", "Дождитесь", 409},
		{"device-stale", `{"error":"netmap_device_changed"}`, "netmap_device_changed", "изменились в NetBox", 409},
		{"snmp-order", `{"error":"netmap_invalid_snmp_profiles"}`, "netmap_invalid_snmp_profiles", "до четырёх", 400},
		{"collector-pending", `{"error":"netmap_collector_not_ready"}`, "netmap_collector_not_ready", "ещё не загрузил", 409},
		{"unknown-conflict", `{"error":"private-password"}`, "netmap_conflict", "конфликтует", 409},
		{"failure", `{"error":"private-password"}`, "netmap_request_failed", "не подтверждён", 502},
	} {
		t.Run(tc.name, func(t *testing.T) {
			g := netmapFixture(t, func(r *http.Request, body []byte) *http.Response {
				if r.URL.Path != "/netmap/api/networks/1234567890abcdef/poll" || string(body) != `{}` {
					t.Error("poll request changed")
				}
				response := netmapResponse("application/json", tc.body)
				response.StatusCode = tc.status
				return response
			})
			headers := http.Header{"Origin": {g.server.Config.PublicURL}, "Content-Type": {"application/json"}, "X-Csrf-Token": {netmapSession().CSRF}, "Idempotency-Key": {netmapGatewayID}}
			w := netmapCall(g, "POST", "/api/v1/modules/"+netmapGatewayID+"/netmap/networks/1234567890abcdef/poll", `{}`, headers, true)
			var problem struct {
				Code    string `json:"error"`
				Message string `json:"message"`
			}
			if w.Code != tc.status || json.Unmarshal(w.Body.Bytes(), &problem) != nil || problem.Code != tc.code || !strings.Contains(problem.Message, tc.message) || strings.Contains(w.Body.String(), "private-") {
				t.Fatal("unsafe or untranslated NetMap problem", w.Code, w.Body.String())
			}
		})
	}
}

func TestNetmapValidationStillRechecksSessionAndRejectsResponsePolicyViolations(t *testing.T) {
	for _, scenario := range []string{"revoked", "disabled", "cookie", "malformed"} {
		t.Run(scenario, func(t *testing.T) {
			revoked, disabled := false, false
			g := netmapFixture(t, func(*http.Request, []byte) *http.Response {
				response := netmapResponse("application/json", `{"error":"netmap_snmp_required"}`)
				response.StatusCode = 400
				switch scenario {
				case "revoked":
					revoked = true
				case "disabled":
					disabled = true
				case "cookie":
					response.Header.Set("Set-Cookie", "portal_session=private; Path=/")
				case "malformed":
					response.Body = io.NopCloser(strings.NewReader("private-password"))
				}
				return response
			})
			g.backend.(*netmapFakeBackend).find = func() (model.ModuleInstance, error) {
				if disabled {
					return model.ModuleInstance{}, errors.New("disabled")
				}
				return model.ModuleInstance{ID: netmapGatewayID, Version: "1.0.0"}, nil
			}
			g.session = func(*http.Request) (session, error) {
				if revoked {
					return session{}, errors.New("revoked")
				}
				return netmapSession(), nil
			}
			w := netmapCall(g, "GET", "/netmap/api/networks", "", nil, false)
			want := 502
			if scenario == "revoked" {
				want = 401
			} else if scenario == "disabled" {
				want = 503
			}
			if w.Code != want || strings.Contains(w.Body.String(), "netmap_snmp_required") || strings.Contains(w.Body.String(), "private-") {
				t.Fatal("validation normalization bypassed a security guard", w.Code)
			}
		})
	}
}

func TestNetmapNativeAndHeadErrorsKeepTheirStatusAndBody(t *testing.T) {
	for _, tc := range []struct{ method, path, body string }{
		{"GET", "/netmap/netbox/", `{"error":"native validation"}`},
		{"HEAD", "/netmap/api/networks", ""},
	} {
		g := netmapFixture(t, func(*http.Request, []byte) *http.Response {
			response := netmapResponse("application/json", tc.body)
			response.StatusCode = 400
			return response
		})
		w := netmapCall(g, tc.method, tc.path, "", nil, false)
		if w.Code != 400 || w.Body.String() != tc.body {
			t.Fatal("native/HEAD error passthrough changed")
		}
	}
}

func TestNetmapNativeCookieCSRFAndBodyArePreservedWithoutPortalIdentity(t *testing.T) {
	g := netmapFixture(t, func(r *http.Request, body []byte) *http.Response {
		if r.Header.Get("Cookie") != "pl_gitea_session=native; _csrf=native-csrf" || r.Header.Get("X-Pl-Native-CSRF-Token") != "native-csrf" || r.Header.Get("X-CSRF-Token") != gatewayServiceCSRF(netmapSession().CSRF, "netmap") || string(body) != "user_name=fixture&password=fixture&_csrf=native-csrf" || r.Header.Get("X-PL-Forged") != "" || r.Header.Get("Authorization") != "" {
			t.Error("native identity/CSRF boundary")
		}
		claims := decodeDirectoryAssertion(t, r, bytes.Repeat([]byte{7}, 32))
		if !claims.CSRFVerified || !formsIdempotency.MatchString(claims.IdempotencyKey) {
			t.Error("native request lacked fresh verified nonce/idempotency")
		}
		response := netmapResponse("text/html", "native")
		response.Header.Add("Set-Cookie", "pl_gitea_session=new; Path=/netmap/gitea; HttpOnly")
		return response
	})
	headers := http.Header{"Origin": []string{g.server.Config.PublicURL}, "Content-Type": []string{"application/x-www-form-urlencoded"}, "X-Csrf-Token": []string{"native-csrf"}, "Cookie": []string{"portal_session=private; pl_gitea_session=native; _csrf=native-csrf; other_app=private"}, "X-Pl-Forged": []string{"forged"}, "Authorization": []string{"forged"}}
	if w := netmapCall(g, "POST", "/netmap/gitea/user/login", "user_name=fixture&password=fixture&_csrf=native-csrf", headers, false); w.Code != 200 || !strings.Contains(w.Header().Get("Set-Cookie"), "Secure") {
		t.Fatal(w.Code, w.Body.String(), w.Header())
	}
}

func TestNetmapNetboxMessagesKeepNativeValueWithinTheirOwnCookieNamespace(t *testing.T) {
	g := netmapFixture(t, func(r *http.Request, body []byte) *http.Response {
		if r.Header.Get("Cookie") != "pl_netbox_csrftoken=csrf; messages=signed-old" || string(body) != "username=fixture&password=fixture&csrfmiddlewaretoken=csrf" {
			t.Error("NetBox flash cookie lost its value or leaked another browser identity")
		}
		response := netmapResponse("text/html", "")
		response.StatusCode = http.StatusFound
		response.Header.Set("Location", "/netmap/netbox/")
		response.Header.Add("Set-Cookie", "messages=signed-new; Path=/; HttpOnly; SameSite=Lax")
		response.Header.Add("Set-Cookie", "pl_netbox_sessionid=native; Path=/netmap/netbox/; HttpOnly; SameSite=Lax")
		return response
	})
	headers := http.Header{
		"Origin":       []string{g.server.Config.PublicURL},
		"Content-Type": []string{"application/x-www-form-urlencoded"},
		"Cookie":       []string{"portal_session=private; messages=foreign; pl_netbox_csrftoken=csrf; pl_netbox_messages=signed-old; other_app=private"},
	}
	w := netmapCall(g, "POST", "/netmap/netbox/login/", "username=fixture&password=fixture&csrfmiddlewaretoken=csrf", headers, false)
	if w.Code != http.StatusFound || w.Header().Get("Location") != "/netmap/netbox/" {
		t.Fatal("Native login redirect was rejected", w.Code)
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 2 || cookies[0].Name != "pl_netbox_messages" || cookies[0].Value != "signed-new" || cookies[0].Path != "/netmap/netbox/" || !cookies[0].HttpOnly || !cookies[0].Secure || cookies[0].SameSite != http.SameSiteLaxMode || cookies[1].Name != "pl_netbox_sessionid" {
		t.Fatal("Native cookies lost isolation or attributes")
	}
}

func TestNetmapNetboxMessageDeletionAndCookieContainment(t *testing.T) {
	for _, tc := range []struct {
		name, path string
		cookies    []string
		want       int
	}{
		{"delete", "/netmap/netbox/", []string{"messages=; Max-Age=0; Path=/; SameSite=Lax"}, 200},
		{"delete-expires", "/netmap/netbox/", []string{"messages=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=/; SameSite=Lax"}, 200},
		{"other-wide", "/netmap/netbox/", []string{"other=n; Path=/"}, 502},
		{"foreign-domain", "/netmap/netbox/", []string{"messages=n; Path=/; Domain=foreign.test"}, 502},
		{"other-path", "/netmap/netbox/", []string{"messages=n; Path=/grafana/"}, 502},
		{"other-service", "/netmap/gitea/", []string{"messages=n; Path=/"}, 502},
		{"alias-collision", "/netmap/netbox/", []string{"messages=one; Path=/", "pl_netbox_messages=two; Path=/netmap/netbox/"}, 502},
	} {
		t.Run(tc.name, func(t *testing.T) {
			g := netmapFixture(t, func(*http.Request, []byte) *http.Response {
				response := netmapResponse("text/html", "native")
				for _, cookie := range tc.cookies {
					response.Header.Add("Set-Cookie", cookie)
				}
				return response
			})
			w := netmapCall(g, "GET", tc.path, "", nil, false)
			if w.Code != tc.want {
				t.Fatal("Unexpected cookie containment status", w.Code)
			}
			if strings.HasPrefix(tc.name, "delete") {
				cookies := w.Result().Cookies()
				if len(cookies) != 1 || cookies[0].Name != "pl_netbox_messages" || cookies[0].Path != "/netmap/netbox/" || cookies[0].MaxAge != -1 || !cookies[0].Secure {
					t.Fatal("Native message cookie was not removed within its namespace")
				}
				if tc.name == "delete-expires" && cookies[0].Expires.Unix() != 0 {
					t.Fatal("Native message expiry was changed")
				}
			}
		})
	}
}

func TestNetmapDuplicateMessageAliasDoesNotReachNativeBackend(t *testing.T) {
	calls := 0
	g := netmapFixture(t, func(*http.Request, []byte) *http.Response {
		calls++
		return netmapResponse("text/html", "native")
	})
	headers := http.Header{"Cookie": []string{"pl_netbox_messages=one; pl_netbox_messages=two"}}
	if w := netmapCall(g, "GET", "/netmap/netbox/", "", headers, false); w.Code != http.StatusBadRequest || calls != 0 {
		t.Fatal("Ambiguous browser message cookies reached the native backend", w.Code, calls)
	}
}

func TestNetmapFreshAdminRevocationAndResponseContainment(t *testing.T) {
	for _, tc := range []struct {
		name     string
		cookies  string
		location string
		want     int
	}{
		{"valid-native", "pl_netbox_sessionid=n; Path=/netmap/netbox/", "", 200},
		{"portal-cookie", "portal_session=evil; Path=/netmap/netbox/", "", 502},
		{"wide-cookie", "pl_netbox_sessionid=n; Path=/", "", 502},
		{"foreign-domain", "pl_netbox_sessionid=n; Path=/netmap/netbox/; Domain=portal.example.test", "", 502},
		{"foreign-redirect", "", "https://foreign.test/netmap/netbox/", 502},
		{"other-product", "", "/netmap/gitea/", 502},
	} {
		t.Run(tc.name, func(t *testing.T) {
			g := netmapFixture(t, func(*http.Request, []byte) *http.Response {
				response := netmapResponse("text/html", "native-private")
				if tc.cookies != "" {
					response.Header.Set("Set-Cookie", tc.cookies)
				}
				if tc.location != "" {
					response.StatusCode = 302
					response.Header.Set("Location", tc.location)
				}
				return response
			})
			if w := netmapCall(g, "GET", "/netmap/netbox/", "", nil, false); w.Code != tc.want {
				t.Fatal(w.Code, w.Body.String())
			}
		})
	}
	for _, admin := range []bool{false, true} {
		g := netmapFixture(t, func(*http.Request, []byte) *http.Response {
			return netmapResponse("application/json", `{"private":true}`)
		})
		reads := 0
		g.session = func(*http.Request) (session, error) {
			reads++
			s := netmapSession()
			if reads == 1 {
				s.User.Admin = admin
				return s, nil
			}
			return session{}, errors.New("revoked")
		}
		w := netmapCall(g, "GET", "/netmap/api/networks", "", nil, false)
		want := 401
		if !admin {
			want = 403
		}
		if w.Code != want || strings.Contains(w.Body.String(), `"private"`) {
			t.Fatal("session revocation leaked data", w.Code, w.Body.String())
		}
	}
}

func TestNetmapSignerRejectsForgedIdentityAndUnsafeProof(t *testing.T) {
	for _, admin := range []bool{false, true} {
		r := httptest.NewRequest("POST", "https://portal.example.test/netmap/api/networks", nil)
		r.Header.Set("Idempotency-Key", netmapGatewayID)
		s := netmapSession()
		s.User.Admin = admin
		for _, verified := range []bool{false, true} {
			err := signNetmapRequest(r, []byte(`{}`), s, bytes.Repeat([]byte{7}, 32), time.Now(), verified, "192.0.2.10")
			if (err == nil) != (admin && verified) {
				t.Fatal("unsafe/employee assertion signed")
			}
		}
	}
}

// A counted reader proves admission happens before body buffering, even when
// initial navigation requests arrive while both active requests are occupied.
type netmapCountedBody struct{ reads atomic.Int32 }

func (b *netmapCountedBody) Read([]byte) (int, error) { b.reads.Add(1); return 0, io.EOF }
func (*netmapCountedBody) Close() error               { return nil }
func waitNetmapQueue(t *testing.T, g *netmapHandler, count int) {
	t.Helper()
	deadline := time.NewTimer(2 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for len(g.waiting) != count {
		select {
		case <-tick.C:
		case <-deadline.C:
			t.Fatalf("queue count %d, want %d", len(g.waiting), count)
		}
	}
}
func TestNetmapThirdInitialAssetWaitsBeforeReadingBody(t *testing.T) {
	g := netmapFixture(t, func(*http.Request, []byte) *http.Response { return netmapResponse("application/javascript", "asset") })
	g.slots <- struct{}{}
	g.slots <- struct{}{}
	body := &netmapCountedBody{}
	request := httptest.NewRequest("GET", "https://portal.example.test/netmap/app.js", nil)
	request.RemoteAddr = "192.0.2.10:1234"
	request.Body = body
	recorder := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { defer close(done); g.serve(recorder, request, "", false) }()
	waitNetmapQueue(t, g, 1)
	select {
	case <-done:
		t.Fatal("third asset rejected while active slots were occupied")
	default:
	}
	if body.reads.Load() != 0 {
		t.Fatal("queued request body read before admission")
	}
	<-g.slots
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("queued asset was not admitted after release")
	}
	if recorder.Code != 200 || recorder.Body.String() != "asset" || body.reads.Load() == 0 {
		t.Fatal("queued asset failed", recorder.Code, recorder.Body.String())
	}
	if len(g.waiting) != 0 || len(g.slots) != 1 {
		t.Fatal("admission capacity leaked")
	}
	<-g.slots
}
func TestNetmapWaitingQueueIsBoundedAndCancellationReclaimsCapacity(t *testing.T) {
	g := netmapFixture(t, func(*http.Request, []byte) *http.Response {
		t.Error("overflow/cancelled request reached adapter")
		return netmapResponse("text/html", "unexpected")
	})
	g.slots <- struct{}{}
	g.slots <- struct{}{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	completed := make(chan bool, 16)
	for index := 0; index < 16; index++ {
		go func() {
			release, ok := g.acquire(ctx)
			if ok {
				release()
			}
			completed <- ok
		}()
	}
	waitNetmapQueue(t, g, 16)
	body := &netmapCountedBody{}
	request := httptest.NewRequest("GET", "https://portal.example.test/netmap/app.js", nil)
	request.Body = body
	recorder := httptest.NewRecorder()
	g.serve(recorder, request, "", false)
	if recorder.Code != 503 || body.reads.Load() != 0 || len(g.waiting) != 16 {
		t.Fatal("queue overflow was not rejected before body buffering", recorder.Code)
	}
	cancel()
	for index := 0; index < 16; index++ {
		select {
		case ok := <-completed:
			if ok {
				t.Fatal("cancelled waiter admitted")
			}
		case <-time.After(2 * time.Second):
			t.Fatal("cancelled waiter retained capacity")
		}
	}
	if len(g.waiting) != 0 || len(g.slots) != 2 {
		t.Fatal("cancelled queue leaked capacity")
	}
}
func TestNetmapAdmissionTimeoutIsFinite(t *testing.T) {
	g := netmapFixture(t, func(*http.Request, []byte) *http.Response { return netmapResponse("text/html", "unexpected") })
	g.slots <- struct{}{}
	g.slots <- struct{}{}
	g.waitTimeout = 5 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan bool, 1)
	go func() {
		release, ok := g.acquire(ctx)
		if ok {
			release()
		}
		done <- ok
	}()
	select {
	case ok := <-done:
		if ok {
			t.Fatal("occupied slots admitted request")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("admission ignored finite wait timeout")
	}
	if len(g.waiting) != 0 || len(g.slots) != 2 {
		t.Fatal("timed out waiter leaked capacity")
	}
}

func TestNetmapObservationImportRemainsAdminCSRFBound(t *testing.T) {
	calls := 0
	g := netmapFixture(t, func(r *http.Request, body []byte) *http.Response {
		calls++
		if r.URL.Path != "/netmap/api/networks/1234567890abcdef/observations" || string(body) != `{"source":"router","records":[]}` {
			t.Error("import binding changed")
		}
		return netmapResponse("application/json", `{"imported":0}`)
	})
	path := "/api/v1/modules/" + netmapGatewayID + "/netmap/networks/1234567890abcdef/observations"
	headers := http.Header{"Origin": {g.server.Config.PublicURL}, "Content-Type": {"application/json"}, "X-Csrf-Token": {netmapSession().CSRF}, "Idempotency-Key": {netmapGatewayID}}
	if w := netmapCall(g, "POST", path, `{"source":"router","records":[]}`, headers, true); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	bad := headers.Clone()
	bad.Del("X-Csrf-Token")
	if w := netmapCall(g, "POST", path, `{}`, bad, true); w.Code != 403 {
		t.Fatal("missing CSRF", w.Code)
	}
	g.session = func(*http.Request) (session, error) { s := netmapSession(); s.User.Admin = false; return s, nil }
	if w := netmapCall(g, "POST", path, `{}`, headers, true); w.Code != 403 {
		t.Fatal("non-admin import", w.Code)
	}
	if calls != 1 {
		t.Fatal("rejected import reached adapter", calls)
	}
}

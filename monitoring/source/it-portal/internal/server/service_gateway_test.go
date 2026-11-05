package server

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"pl/portal/internal/netguard"
	"pl/portal/internal/providers"
)

func TestServiceGatewayRouteAndRedirectBoundaries(t *testing.T) {
	for _, tc := range [][3]string{{"monitoring-admin", "GET", "/"}, {"monitoring-admin", "GET", "/api/v1/jobs/job_1"}, {"monitoring-admin", "POST", "/api/v1/containers/source/restart"}, {"websites-admin", "GET", "/targets/site_1/update"}, {"websites-admin", "POST", "/add/apply"}, {"websites-admin", "POST", "/targets/site_1/delete"}} {
		if !gatewayRoute(tc[0], tc[1], tc[2]) {
			t.Fatal("legitimate route rejected", tc)
		}
	}
	for _, tc := range [][3]string{{"unknown", "GET", "/static/app.js"}, {"monitoring-admin", "GET", "/jobs/job_1"}, {"monitoring-admin", "POST", "/containers/source/restart"}, {"monitoring-admin", "GET", "/logs/"}, {"monitoring-admin", "POST", "/api/v1/containers/source/logs"}, {"websites-admin", "GET", "/targets/../secret"}, {"websites-admin", "POST", "/login"}, {"websites-admin", "DELETE", "/targets/site"}} {
		if gatewayRoute(tc[0], tc[1], tc[2]) {
			t.Fatal("unlisted route accepted", tc)
		}
	}
	base, _ := url.Parse("http://source/websites/add/apply")
	for _, loc := range []string{"https://evil.test/websites/", "//evil.test/websites/", "/admin/", "/websites/%2e%2e/admin", "/websites/a/../history", "/websites/%2fadmin", "/websites/\\evil"} {
		if _, ok := gatewayRedirect(base, "/websites", loc); ok {
			t.Fatal("unsafe redirect accepted", loc)
		}
	}
	if next, ok := gatewayRedirect(base, "/websites", "/websites/history?done=1"); !ok || next != "/websites/history?done=1" {
		t.Fatal("same-prefix redirect failed")
	}
}

func TestServiceGatewayRedirectPreservesSectionFragment(t *testing.T) {
	base, _ := url.Parse("http://monitoring-admin:8080/admin/containers")
	for _, section := range []string{"containers", "telegram", "diagnostics", "operations"} {
		location := "/admin/#" + section
		got, ok := gatewayRedirect(base, "/admin", location)
		if !ok || got != location {
			t.Fatalf("section redirect: got %q, want %q", got, location)
		}
	}
	if got, ok := gatewayRedirect(base, "/admin", "/admin/?q=1#контейнеры"); !ok || got != "/admin/?q=1#%D0%BA%D0%BE%D0%BD%D1%82%D0%B5%D0%B9%D0%BD%D0%B5%D1%80%D1%8B" {
		t.Fatal("fragment must remain safe ASCII", got, ok)
	}
}

func TestServiceGatewaySessionCSRFSigningAndHeaderIsolation(t *testing.T) {
	s := apiFixture(t)
	s.Config.TrustedProxyCIDRs = []string{"10.22.0.0/24"}
	admin := apiUser(t, s, "gateway-admin", true)
	viewer := apiUser(t, s, "gateway-viewer", false)
	key := []byte("0123456789abcdef0123456789abcdef")
	type captured struct {
		claims gatewayIdentity
		body   string
		header http.Header
		host   string
	}
	received := make(chan captured, 20)
	var calls, mode atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		data, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
		}
		encoded := r.Header.Get(gatewayAssertionHeader)
		if gatewayMAC(key, "pl-gateway-v1\n"+encoded) != r.Header.Get(gatewaySignatureHeader) {
			t.Error("invalid HMAC")
		}
		payload, err := base64.RawURLEncoding.DecodeString(encoded)
		if err != nil {
			t.Error("invalid assertion encoding")
		}
		var claims gatewayIdentity
		if json.Unmarshal(payload, &claims) != nil {
			t.Error("invalid claims")
		}
		digest := sha256.Sum256(data)
		if claims.BodySHA256 != hex.EncodeToString(digest[:]) || claims.URI != r.RequestURI || claims.Method != r.Method || claims.ContentType != r.Header.Get("Content-Type") || claims.IdempotencyKey != r.Header.Get("Idempotency-Key") || !claims.Admin {
			t.Error("assertion differs from actual request")
		}
		for _, h := range []string{"Cookie", "Authorization", "Proxy-Authorization", "Remote-User", "X-Auth-User", "X-PL-Forged", "Forwarded", "Accept-Language"} {
			if r.Header.Get(h) != "" {
				t.Errorf("forbidden/hop header leaked: %s", h)
			}
		}
		if claims.CSRFVerified && r.Header.Get("X-CSRF-Token") != claims.CSRFToken {
			t.Error("upstream CSRF not normalized")
		}
		received <- captured{claims, string(data), r.Header.Clone(), r.Host}
		w.Header().Set("Set-Cookie", "local_auth=source-secret")
		w.Header().Set("X-PL-Gateway-Assertion", "source-secret")
		w.Header().Set("WWW-Authenticate", "Basic source-secret")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		switch mode.Load() {
		case 1:
			w.Header().Set("Location", "/websites/history")
			w.WriteHeader(303)
		case 2:
			w.Header().Set("HX-Redirect", "https://evil.test/steal")
		case 3:
			w.Header().Set("HX-Redirect", s.Config.PublicURL+"/websites/history")
		case 4:
			w.Header().Set("Location", "/websites/%2e%2e/admin")
		case 5:
			if _, err := s.Store.Pool.Exec(context.Background(), "DELETE FROM sessions WHERE token_hash=$1", hash(admin.cookie.Value)); err != nil {
				t.Error(err)
			}
		}
		_, _ = w.Write([]byte("fixture result"))
	}))
	defer upstream.Close()
	guard, err := netguard.NewWithDependencies([]string{"10.0.0.0/8"}, []int{80}, "", browseResolver{}, func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(upstream.URL, "http://"))
	})
	if err != nil {
		t.Fatal(err)
	}
	registry := providers.New(guard, "")
	handlers := map[string]http.Handler{}
	for _, aud := range []string{"monitoring-admin", "websites-admin"} {
		base := "http://source" + gatewayPrefix(aud)
		transport, err := registry.ServiceGatewayTransport(base)
		if err != nil {
			t.Fatal(err)
		}
		handlers[aud] = s.ServiceGateway(ServiceGatewayConfig{Audience: aud, Upstream: base, Key: key, Transport: transport})
	}
	call := func(aud string, who apiIdentity, method, path, body, media string, headers http.Header) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, s.Config.PublicURL+path, strings.NewReader(body))
		r.RemoteAddr = "10.22.0.5:12345"
		if who.cookie != nil {
			r.AddCookie(who.cookie)
		}
		r.Header.Set("Content-Type", media)
		r.Header.Set("Origin", s.Config.PublicURL)
		r.Header.Set("X-CSRF-Token", who.csrf)
		r.Header.Set("X-Real-IP", "192.0.2.10")
		r.Header.Set("X-Forwarded-For", "203.0.113.99")
		r.Header.Set("X-Forwarded-Host", "evil.test")
		r.Header.Set("X-PL-Gateway-Assertion", "forged")
		r.Header.Set("X-PL-Gateway-Signature", "forged")
		r.Header.Set("X-PL-Forged", "browser-secret")
		r.Header.Set("X-Auth-User", "forged-admin")
		r.Header.Set("Remote-User", "forged-admin")
		r.Header.Set("Connection", "Accept-Language")
		r.Header.Set("Accept-Language", "ru")
		for h, v := range headers {
			if v == nil {
				r.Header.Del(h)
			} else {
				r.Header[h] = v
			}
		}
		w := httptest.NewRecorder()
		handlers[aud].ServeHTTP(w, r)
		return w
	}
	if w := call("websites-admin", admin, "GET", "/websites/api/v1/session", "", "", http.Header{"Authorization": []string{"Bearer browser-secret"}}); w.Code != 401 {
		t.Fatal("Authorization browser boundary", w.Code)
	}
	for _, who := range []apiIdentity{{}, viewer} {
		want := 401
		if who.cookie != nil {
			want = 403
		}
		if w := call("monitoring-admin", who, "GET", "/admin/api/v1/overview", "", "", nil); w.Code != want {
			t.Fatal("auth failed", w.Code)
		}
	}
	restart := "/admin/api/v1/containers/example/restart?x=a%2Fb&x=c"
	for _, headers := range []http.Header{{"Origin": nil}, {"Origin": []string{"https://evil.test"}}, {"Sec-Fetch-Site": []string{"cross-site"}}, {"X-Csrf-Token": nil}, {"X-Csrf-Token": []string{admin.csrf, admin.csrf}}, {"Origin": []string{s.Config.PublicURL, s.Config.PublicURL}}} {
		if w := call("monitoring-admin", admin, "POST", restart, "{}", "application/json", headers); w.Code != 403 {
			t.Fatal("CSRF fail-open", w.Code)
		}
	}
	if calls.Load() != 0 {
		t.Fatal("unauthorized request reached source")
	}
	body := "{\n  \"idempotency_key\": \"client-key\"\n}"
	if w := call("monitoring-admin", admin, "POST", restart, body, "application/json; charset=utf-8", nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	got := <-received
	if got.body != body || got.claims.IdempotencyKey != "client-key" || got.claims.SourceIP != "192.0.2.10" || got.claims.Subject != "gateway-admin" || got.host != "portal.example.test" || got.header.Get("X-Forwarded-Host") != "portal.example.test" || got.header.Get("X-Forwarded-For") != "192.0.2.10" || got.claims.CSRFToken == admin.csrf {
		t.Fatal("incorrect signed request")
	}
	if w := call("monitoring-admin", admin, "POST", restart, "{}", "application/json", http.Header{"Origin": nil, "Referer": []string{s.Config.PublicURL + "/admin/"}}); w.Code != 200 {
		t.Fatal("same-origin Referer denied", w.Code)
	}
	got = <-received
	if got.claims.IdempotencyKey != "gw-"+got.claims.Nonce {
		t.Fatal("restart lacks durable fallback")
	}
	for _, tc := range []struct {
		body    string
		headers http.Header
	}{{`{"idempotency_key":"one"}`, http.Header{"Idempotency-Key": []string{"two"}}}, {`{"idempotency_key":"one","idempotency_key":"two"}`, nil}, {`{"idempotency_key":null}`, nil}, {`{}`, http.Header{"Idempotency-Key": []string{"a", "a"}}}, {`{}`, http.Header{"Idempotency-Key": []string{strings.Repeat("a", 129)}}}} {
		if w := call("monitoring-admin", admin, "POST", restart, tc.body, "application/json", tc.headers); w.Code != 400 {
			t.Fatal("invalid idempotency accepted", w.Code)
		}
	}
	derived := gatewayServiceCSRF(admin.csrf, "websites-admin")
	form := "csrf_token=" + url.QueryEscape(derived) + "&name=site%2Fexample&operation_token=fixture-op"
	w := call("websites-admin", admin, "POST", "/websites/add/preview", form, "application/x-www-form-urlencoded", http.Header{"X-Csrf-Token": nil})
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	got = <-received
	if got.body != form || !got.claims.CSRFVerified || len(got.claims.Scopes) != 2 || got.claims.Scopes[0] != "websites:read" || got.claims.Scopes[1] != "websites:write" {
		t.Fatal("form/scopes changed")
	}
	for _, name := range []string{"Set-Cookie", "WWW-Authenticate", gatewayAssertionHeader} {
		if w.Header().Get(name) != "" {
			t.Fatal("upstream auth header leaked", name)
		}
	}
	for _, invalid := range []string{form + "&csrf_token=" + derived, "csrf_token=" + admin.csrf, "csrf_token=wrong"} {
		if w := call("websites-admin", admin, "POST", "/websites/add/preview", invalid, "application/x-www-form-urlencoded", nil); w.Code != 403 {
			t.Fatal("duplicate/raw/conflicting form CSRF accepted", w.Code)
		}
	}
	before := calls.Load()
	for _, path := range []string{"/websites/targets/%2e%2e/admin", "/websites/static/%2Fsecret", "/websites/static/%252e%252e/secret", "/websites/../admin", "/websites//history"} {
		if w := call("websites-admin", admin, "GET", path, "", "", nil); w.Code != 404 {
			t.Fatal("path bypass", w.Code, path)
		}
	}
	if calls.Load() != before {
		t.Fatal("rejected path forwarded")
	}
	if w := call("websites-admin", admin, "POST", "/websites/add/preview", strings.Repeat("a", (2<<20)+1), "application/json", nil); w.Code != 413 {
		t.Fatal("body limit", w.Code)
	}
	if w := call("websites-admin", admin, "POST", "/websites/add/preview", "{}", "application/json", http.Header{"Content-Encoding": []string{"gzip"}}); w.Code != 415 {
		t.Fatal("encoding accepted", w.Code)
	}
	for _, tc := range []struct {
		mode          int32
		status        int
		header, value string
	}{{1, 303, "Location", "/websites/history"}, {2, 502, "HX-Redirect", ""}, {3, 200, "HX-Redirect", "/websites/history"}, {4, 502, "Location", ""}} {
		mode.Store(tc.mode)
		w := call("websites-admin", admin, "GET", "/websites/", "", "", nil)
		<-received
		if w.Code != tc.status || w.Header().Get(tc.header) != tc.value {
			t.Fatal("redirect policy", tc.mode, w.Code, w.Header())
		}
	}
	mode.Store(0)
	// An untrusted immediate peer cannot promote forged X-Real-IP/X-Forwarded-For.
	s.Config.TrustedProxyCIDRs = nil
	if w := call("websites-admin", admin, "GET", "/websites/", "", "", nil); w.Code != 200 {
		t.Fatal(w.Code)
	}
	got = <-received
	if got.claims.SourceIP != "10.22.0.5" || got.claims.CSRFVerified {
		t.Fatal("untrusted source IP or GET CSRF")
	}
	mode.Store(5)
	if w := call("websites-admin", admin, "GET", "/websites/", "", "", nil); w.Code != 401 {
		t.Fatal("revoked session got result", w.Code)
	}
	<-received
	if w := call("monitoring-admin", admin, "GET", "/admin/api/v1/session", "", "", nil); w.Code != 401 {
		t.Fatal("logout not honored", w.Code)
	}
}

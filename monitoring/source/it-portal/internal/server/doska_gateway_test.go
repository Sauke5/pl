package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"pl/portal/internal/organization"
)

func doskaGatewayTestManifest() DoskaGatewayManifest {
	return DoskaGatewayManifest{Version: "test-v1", Routes: []DoskaGatewayRoute{
		{Method: "GET", Path: "/doska/", Kind: "page"},
		{Method: "GET", Path: "/doska/projects/{projectId}", Kind: "page"},
		{Method: "GET", Path: "/doska/assets/test-123456.js", Kind: "asset"},
		{Method: "GET", Path: "/doska/api/doska/context", Kind: "read"},
		{Method: "GET", Path: "/doska/api/doska/projects", Kind: "read", Query: map[string]DoskaGatewayQuery{"q": {Kind: "text", Multiple: true, MaxBytes: 128}}},
		{Method: "POST", Path: "/doska/api/doska/projects", Kind: "write"},
	}}
}
func TestDoskaGatewayManifestReleaseVersionDoesNotRelaxRouteIDs(t *testing.T) {
	for _, version := range []string{"pl-doska-2.46.2", "test-v1", strings.Repeat("a", 128)} {
		manifest := doskaGatewayTestManifest()
		manifest.Version = version
		routes, err := compileDoskaManifest(manifest)
		if err != nil {
			t.Fatalf("valid release version %q rejected: %v", version, err)
		}
		for _, tc := range []struct {
			path    string
			allowed bool
		}{{"/doska/projects/project-1", true}, {"/doska/projects/project.1", false}} {
			request := httptest.NewRequest(http.MethodGet, "http://portal.test"+tc.path, nil)
			if _, allowed := doskaMatchRoute(routes, request); allowed != tc.allowed {
				t.Fatalf("release version %q changed route ID policy: %s allowed=%v", version, tc.path, allowed)
			}
		}
	}
	for _, version := range []string{"", ".2.46.2", "pl-doska-2.46.2.", "pl-doska-2..46.2", "../2.46.2", "pl/doska-2.46.2", "pl-doska-2.46.2?x=1", "pl-doska-2.46.2#fragment", "pl-doska-2.46.2%00", "pl-doska-2.46.2\n", "pl doska", "версия-2.46.2", strings.Repeat("a", 129)} {
		manifest := doskaGatewayTestManifest()
		manifest.Version = version
		if _, err := compileDoskaManifest(manifest); err == nil {
			t.Fatalf("invalid release version %q accepted", version)
		}
	}
}

func TestDoskaGatewayManifestBoundaries(t *testing.T) {
	routes, err := compileDoskaManifest(doskaGatewayTestManifest())
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		method, path string
		allowed      bool
	}{
		{"GET", "/doska/", true}, {"GET", "/doska/projects/p-1", true}, {"GET", "/doska/assets/test-123456.js", true},
		{"GET", "/doska/assets/other.js", false}, {"HEAD", "/doska/api/doska/context", false}, {"GET", "/doska/api/doska/context?token=secret", false},
		{"GET", "/doska/api/doska/projects?q=a%2Fb&q=%D0%98", true}, {"GET", "/doska/api/doska/projects?q=", false},
		{"GET", "/doska/api/doska/projects?upstream=http://evil", false}, {"GET", "/doska/api/doska/projects?q=%ZZ", false},
		{"GET", "/doska/api/auth/get-session", false}, {"GET", "/doska/api/admin/users", false}, {"POST", "/doska/api/import/projects", false},
		{"GET", "/doska/api/ws/user", false}, {"POST", "/doska/api/task/draft-upload/p1", false}, {"GET", "/healthz", false},
		{"GET", "/doska/projects/a%2Fb", false}, {"GET", "/doska/projects/../secret", false}, {"GET", "/doska//", false},
	} {
		t.Run(tc.method+tc.path, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, "http://portal.test"+tc.path, nil)
			_, ok := doskaMatchRoute(routes, r)
			if ok != tc.allowed {
				t.Fatalf("allowed=%v want%v", ok, tc.allowed)
			}
		})
	}
	for _, route := range []DoskaGatewayRoute{
		{Method: "GET", Path: "/doska/api/*", Kind: "read"}, {Method: "GET", Path: "/doska/api/ws/user", Kind: "websocket"},
		{Method: "GET", Path: "/doska/api/auth/get-session", Kind: "read"}, {Method: "GET", Path: "/doska/api/admin/users", Kind: "read"},
		{Method: "POST", Path: "/doska/api/doska/upload", Kind: "write"}, {Method: "POST", Path: "/doska/", Kind: "page"},
		{Method: "TRACE", Path: "/doska/api/doska/context", Kind: "read"},
	} {
		if _, err := compileDoskaManifest(DoskaGatewayManifest{Version: "test", Routes: []DoskaGatewayRoute{route}}); err == nil {
			t.Fatalf("invalid route accepted %+v", route)
		}
	}
}

func TestDoskaGatewayQuerySchemaBounds(t *testing.T) {
	min, max := int64(1), int64(100)
	m := DoskaGatewayManifest{Version: "query-v1", Routes: []DoskaGatewayRoute{
		{Method: "GET", Path: "/doska/api/doska/{id}", Kind: "read", Query: map[string]DoskaGatewayQuery{"q": {Kind: "text", MaxChars: 200, MaxBytes: 800, AllowEmpty: true}}},
		{Method: "GET", Path: "/doska/api/doska/context", Kind: "read"},
		{Method: "GET", Path: "/doska/api/doska/options", Kind: "read", Query: map[string]DoskaGatewayQuery{"purpose": {Kind: "text", Required: true, Enum: []string{"invitation", "ownership"}}, "limit": {Kind: "integer", Minimum: &min, Maximum: &max}}},
	}}
	routes, err := compileDoskaManifest(m)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		path string
		ok   bool
	}{
		{"/doska/api/doska/known?q=", true}, {"/doska/api/doska/known?q=" + strings.Repeat("%D0%98", 200), true}, {"/doska/api/doska/known?q=" + strings.Repeat("%D0%98", 201), false},
		{"/doska/api/doska/context?q=search", false}, {"/doska/api/doska/options?purpose=invitation&limit=100", true}, {"/doska/api/doska/options?purpose=ownership&limit=1", true},
		{"/doska/api/doska/options?purpose=invitation&limit=101", false}, {"/doska/api/doska/options?purpose=invitation&limit=0", false},
		{"/doska/api/doska/options?purpose=unknown", false}, {"/doska/api/doska/options", false}, {"/doska/api/doska/options?purpose=invitation&purpose=ownership", false},
	} {
		r := httptest.NewRequest("GET", "http://portal.test"+tc.path, nil)
		_, ok := doskaMatchRoute(routes, r)
		if ok != tc.ok {
			t.Fatalf("%s allowed%v want%v", tc.path, ok, tc.ok)
		}
	}
}
func TestDoskaGatewayConfigurationAndRedirects(t *testing.T) {
	s := &Server{Config: Config{PublicURL: "https://portal.example.test"}}
	cfg := DoskaGatewayConfig{APIUpstream: "http://api.test:1337", WebUpstream: "http://web.test:8080", Key: []byte("0123456789abcdef0123456789abcdef"), Manifest: doskaGatewayTestManifest(), Transport: directoryRoundTrip(func(*http.Request) (*http.Response, error) { t.Fatal("unexpected transport"); return nil, nil })}
	g, err := s.newDoskaGateway(cfg)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		location string
		allowed  bool
	}{
		{"/api/doska/context", true}, {"https://portal.example.test/doska/projects/p1#task", true},
		{"http://evil.test/doska/", false}, {"/api/auth/get-session", false}, {"/doska/assets/unknown.js", false}, {"/doska/../auth/login", false},
	} {
		base := *g.apiUpstream
		base.Path = "/api/doska/context"
		_, err := g.redirect(&base, tc.location)
		if (err == nil) != tc.allowed {
			t.Fatalf("redirect %s error=%v", tc.location, err)
		}
	}
	for _, mutate := range []func(*DoskaGatewayConfig){
		func(c *DoskaGatewayConfig) { c.APIUpstream = "http://user:password@api.test" }, func(c *DoskaGatewayConfig) { c.APIUpstream = "http://api.test/api/" },
		func(c *DoskaGatewayConfig) { c.WebUpstream = "http://web.test?target=evil" }, func(c *DoskaGatewayConfig) { c.Key = c.Key[:31] },
		func(c *DoskaGatewayConfig) { c.Transport = nil }, func(c *DoskaGatewayConfig) { c.Manifest.Routes = nil },
	} {
		copy := cfg
		mutate(&copy)
		if _, err := s.DoskaGateway(copy); err == nil {
			t.Fatal("invalid config accepted")
		}
	}
}

func TestDoskaGatewayPostgreSQLHTTP(t *testing.T) {
	s := apiFixture(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	guid := make([]byte, 16)
	guid[15] = 1
	sub, _ := organization.ADSubject("dc=doska-fixture,dc=test", guid)
	org := organization.NewStore(s.Store.Pool)
	record := organization.EmployeeRecord{Identity: organization.Identity{Subject: sub, Name: "Сотрудник", AccountState: organization.Active, LastSuccessAt: now}, Provider: "ad", ProviderNamespace: strings.Split(sub, ":")[1], ObjectGUID: guid}
	identity, err := org.SaveEmployee(ctx, record, 0, "test-sync", now)
	if err != nil {
		t.Fatal(err)
	}
	user := apiUser(t, s, sub, false)
	apiCalls, webCalls := 0, 0
	mode := "normal"
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		apiCalls++
		if r.URL.Path != "/api/doska/context" && r.URL.Path != "/api/doska/projects" {
			t.Errorf("wrong upstream path %s", r.URL.Path)
		}
		for _, name := range []string{"Cookie", "Authorization", "Remote-User", "X-Auth-User", "X-Original-URI"} {
			if r.Header.Get(name) != "" {
				t.Errorf("credential/header leaked: %s", name)
			}
		}
		data, e := base64.RawURLEncoding.DecodeString(r.Header.Get(gatewayAssertionHeader))
		if e != nil {
			t.Error(e)
		}
		var claims gatewayIdentity
		if e := json.Unmarshal(data, &claims); e != nil {
			t.Error(e)
		}
		if claims.URI != "/doska"+r.URL.RequestURI() || claims.Admin || claims.Subject != sub || claims.Audience != "doska" || r.Header.Get(gatewaySignatureHeader) != gatewayMAC([]byte("0123456789abcdef0123456789abcdef"), "pl-gateway-v2\n"+r.Header.Get(gatewayAssertionHeader)) {
			t.Error("identity binding/signature mismatch")
		}
		if r.Method == "POST" && (r.Header.Get("X-CSRF-Token") == user.csrf || r.Header.Get("X-CSRF-Token") != claims.CSRFToken || !claims.CSRFVerified) {
			t.Error("unsafe CSRF leaked/mismatch")
		}
		if mode == "logout" {
			_, e := s.Store.Pool.Exec(ctx, "DELETE FROM sessions WHERE user_id=$1", sub)
			if e != nil {
				t.Error(e)
			}
		}
		if mode == "html" {
			w.Header().Set("Content-Type", "text/html")
			_, _ = io.WriteString(w, "<html>SPA</html>")
			return
		}
		if mode == "foreign-redirect" {
			w.Header().Set("Location", "https://evil.test/")
			w.WriteHeader(302)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Set-Cookie", "native_session=should-not-escape")
		w.Header().Set("WWW-Authenticate", "Basic")
		w.Header().Set("X-PL-Private", "spoof")
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer api.Close()
	web := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		webCalls++
		if r.URL.Path != "/doska/" && r.URL.Path != "/doska/assets/test-123456.js" {
			t.Error("web prefix lost")
		}
		if r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" || r.Header.Get(gatewayAssertionHeader) != "" {
			t.Error("web credential leaked")
		}
		w.Header().Set("ETag", `W/"fixture-asset"`)
		w.Header().Set("Last-Modified", "Wed, 21 Oct 2015 07:28:00 GMT")
		w.Header().Set("Set-Cookie", "native_web=must-not-escape")
		w.Header().Set("WWW-Authenticate", "Basic")
		w.Header().Set("X-PL-Private", "private")
		if r.URL.Path == "/doska/assets/test-123456.js" {
			w.Header().Set("Content-Type", "application/javascript")
			if r.Header.Get("If-None-Match") == `W/"fixture-asset"` {
				w.WriteHeader(http.StatusNotModified)
				return
			}
			_, _ = io.WriteString(w, "window.doskaFixture=true;")
			return
		}
		w.Header().Set("Content-Type", "text/html")
		_, _ = io.WriteString(w, "<html>Doska</html>")
	}))
	defer web.Close()
	g, err := s.DoskaGateway(DoskaGatewayConfig{APIUpstream: api.URL, WebUpstream: web.URL, Key: []byte("0123456789abcdef0123456789abcdef"), Manifest: doskaGatewayTestManifest(), Transport: http.DefaultTransport})
	if err != nil {
		t.Fatal(err)
	}
	call := func(method, path, body string, headers http.Header, want int) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, "https://portal.example.test"+path, strings.NewReader(body))
		r.AddCookie(user.cookie)
		for name, values := range headers {
			r.Header[name] = values
		}
		w := httptest.NewRecorder()
		g.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("%s %s got%d want%d: %s", method, path, w.Code, want, w.Body.String())
		}
		for _, name := range []string{"Set-Cookie", "WWW-Authenticate", "X-PL-Private"} {
			if w.Header().Get(name) != "" {
				t.Errorf("upstream header escaped: %s", name)
			}
		}
		return w
	}
	call("GET", "/doska/api/doska/projects?q=a%2Fb&q=%D0%98", "", http.Header{"Remote-User": {"forged"}, "X-Pl-Gateway-Assertion": {"forged"}, "X-Original-Uri": {"/evil"}}, 200)
	page := call("GET", "/doska/", "", nil, 200)
	if page.Header().Get("ETag") != "" || page.Header().Get("Last-Modified") != "" {
		t.Fatal("page validators escaped")
	}
	asset := call("GET", "/doska/assets/test-123456.js", "", nil, 200)
	if asset.Body.Len() == 0 || asset.Header().Get("ETag") != `W/"fixture-asset"` || asset.Header().Get("Last-Modified") != "Wed, 21 Oct 2015 07:28:00 GMT" {
		t.Fatal("asset validators missing")
	}
	if apiCalls != 1 || webCalls != 2 {
		t.Fatal("wrong fixed upstream selection")
	}
	conditional := call("GET", "/doska/assets/test-123456.js", "", http.Header{"If-None-Match": {asset.Header().Get("ETag")}}, 304)
	if conditional.Body.Len() != 0 || conditional.Header().Get("ETag") != asset.Header().Get("ETag") || conditional.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("conditional asset response lost validators or no-store")
	}
	headers := http.Header{"Content-Type": {"application/json"}, "Origin": {s.Config.PublicURL}, "X-Csrf-Token": {user.csrf}, "Idempotency-Key": {"test-doska-create"}}
	call("POST", "/doska/api/doska/projects", `{"name":"Проект"}`, headers, 200)
	before := apiCalls
	call("GET", "/doska/api/ws/user", "", http.Header{"Upgrade": {"websocket"}}, 404)
	call("GET", "/doska/api/auth/get-session", "", nil, 404)
	call("GET", "/doska/api/doska/context?token=secret", "", nil, 404)
	call("GET", "/doska/api/doska/context", "", http.Header{"Authorization": {"Bearer opaque"}}, 401)
	call("POST", "/doska/api/doska/projects", `{}`, http.Header{"Content-Type": {"application/json"}}, 403)
	call("POST", "/doska/api/doska/projects", `{}`, http.Header{"Content-Type": {"application/json"}, "Origin": {"https://evil.test"}, "X-Csrf-Token": {user.csrf}}, 403)
	call("POST", "/doska/api/doska/projects", string(bytes.Repeat([]byte("x"), (128<<10)+1)), headers, 413)
	call("POST", "/doska/api/doska/projects", `not json`, headers, 415)
	if apiCalls != before {
		t.Fatal("rejected request reached upstream")
	}
	knownUser := user
	user = apiUser(t, s, "ad:unknown-test-subject", false)
	call("GET", "/doska/api/doska/context", "", nil, 403)
	staleGUID := make([]byte, 16)
	staleGUID[15] = 2
	staleSub, _ := organization.ADSubject("dc=doska-fixture,dc=test", staleGUID)
	stale := record
	stale.Identity.Subject = staleSub
	stale.Identity.LastSuccessAt = now.Add(-3 * time.Hour)
	stale.ObjectGUID = staleGUID
	if _, err := org.SaveEmployee(ctx, stale, 0, "test-sync", now); err != nil {
		t.Fatal(err)
	}
	user = apiUser(t, s, staleSub, false)
	call("GET", "/doska/api/doska/context", "", nil, 503)
	user = knownUser
	mode = "html"
	call("GET", "/doska/api/doska/context", "", nil, 502)
	mode = "foreign-redirect"
	call("GET", "/doska/api/doska/context", "", nil, 502)
	mode = "normal"
	record.Identity.AccountState = organization.Disabled
	identity, err = org.SaveEmployee(ctx, record, identity.Revision, "test-sync", now)
	if err != nil {
		t.Fatal(err)
	}
	call("GET", "/doska/api/doska/context", "", nil, 403)
	record.Identity.AccountState = organization.Active
	_, err = org.SaveEmployee(ctx, record, identity.Revision, "test-sync", now)
	if err != nil {
		t.Fatal(err)
	}
	mode = "logout"
	call("GET", "/doska/api/doska/context", "", nil, 401)
}

func TestDoskaAssetResponseValidatorBoundaries(t *testing.T) {
	date := "Wed, 21 Oct 2015 07:28:00 GMT"
	for _, tc := range []struct {
		name  string
		asset bool
		etag  []string
		date  []string
		want  bool
	}{
		{"strong", true, []string{`"strong"`}, []string{date}, true},
		{"weak", true, []string{`W/"weak"`}, []string{date}, true},
		{"empty-opaque", true, []string{`""`}, []string{date}, true},
		{"bounded", true, []string{`"` + strings.Repeat("x", 254) + `"`}, []string{date}, true},
		{"page-api-attachment", false, []string{`"strong"`}, []string{date}, false},
		{"duplicate", true, []string{`"one"`, `"two"`}, []string{date, date}, false},
		{"unquoted", true, []string{"unquoted"}, []string{"yesterday"}, false},
		{"list", true, []string{`"one", "two"`}, []string{date + ", " + date}, false},
		{"oversized", true, []string{`"` + strings.Repeat("x", 255) + `"`}, []string{strings.Repeat("x", 129)}, false},
		{"embedded-quote", true, []string{`"a"b"`}, []string{"invalid"}, false},
		{"space", true, []string{`"a b"`}, []string{"invalid"}, false},
		{"lowercase-weak", true, []string{`w/"tag"`}, []string{"invalid"}, false},
		{"ctl", true, []string{"\"a\tb\""}, []string{date + "\r\nInjected: yes"}, false},
		{"del", true, []string{"\"a\x7fb\""}, []string{"invalid"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			response := &http.Response{Header: http.Header{
				"Etag": tc.etag, "Last-Modified": tc.date,
				"Set-Cookie": {"native=secret"}, "Authorization": {"Bearer secret"},
				"Www-Authenticate": {"Basic"}, "X-Pl-Private": {"secret"},
				"Cache-Control": {"public, max-age=31536000"},
			}}
			(&doskaGateway{}).filterResponse(response, tc.asset)
			if got := response.Header.Get("ETag"); (got != "") != tc.want || tc.want && got != tc.etag[0] {
				t.Fatalf("ETag=%q, want preserved=%v", got, tc.want)
			}
			if got := response.Header.Get("Last-Modified"); (got != "") != tc.want || tc.want && got != tc.date[0] {
				t.Fatalf("Last-Modified=%q, want preserved=%v", got, tc.want)
			}
			for _, name := range []string{"Set-Cookie", "Authorization", "WWW-Authenticate", "X-PL-Private", "Cache-Control"} {
				if response.Header.Get(name) != "" {
					t.Errorf("upstream private/policy header escaped: %s", name)
				}
			}
		})
	}
}

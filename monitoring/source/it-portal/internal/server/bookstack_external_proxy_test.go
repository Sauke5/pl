package server

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"pl/portal/internal/model"
	"pl/portal/internal/modules"
	"pl/portal/internal/netguard"
	"pl/portal/internal/store"
)

type externalWikiDNS struct{}

func (externalWikiDNS) LookupIPAddr(context.Context, string) ([]net.IPAddr, error) {
	return []net.IPAddr{{IP: net.ParseIP("10.20.30.40")}}, nil
}

func externalWikiFixture(t *testing.T, upstream http.HandlerFunc) (*Server, apiIdentity, *int, model.Integration, model.ModuleInstance, *atomic.Int32) {
	t.Helper()
	s, admin, controllerCalls, integration, instance := bookstackRoutingFixture(t)
	native := httptest.NewServer(upstream)
	t.Cleanup(native.Close)
	dials := new(atomic.Int32)
	guard, err := netguard.NewWithDependencies(nil, nil, "", externalWikiDNS{}, func(ctx context.Context, network, address string) (net.Conn, error) {
		dials.Add(1)
		if address != "10.20.30.40:8444" {
			t.Error("external Wiki dial escaped approved endpoint", address)
		}
		return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(native.URL, "http://"))
	})
	if err != nil {
		t.Fatal(err)
	}
	s.Modules.BookStack = modules.NewBookStackConnector(guard)
	s.Modules.PublicURL = s.Config.PublicURL
	origin, config, err := s.Modules.BookStack.Approve(context.Background(), "http://wiki.external.example:8444", s.Config.PublicURL)
	if err != nil {
		t.Fatal(err)
	}
	config["module_mode"] = "external"
	integration.URL, integration.Config = origin, config
	instance.Mode, instance.Endpoint, instance.Name = "external", origin, "Remote Wiki"
	if _, err := s.Store.Save(context.Background(), "integration", integration.ID, 1, integration, "test"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Store.Save(context.Background(), "module_instance", instance.ID, 1, instance, "test"); err != nil {
		t.Fatal(err)
	}
	return s, admin, controllerCalls, integration, instance, dials
}

func externalWikiCall(s *Server, who apiIdentity, method, nativeURI, body string, headers http.Header) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, s.Config.PublicURL+bookstackExternalPrefix+nativeURI, strings.NewReader(body))
	if who.cookie != nil {
		r.AddCookie(who.cookie)
	}
	if method != http.MethodGet && method != http.MethodHead {
		r.Header.Set("Origin", s.Config.PublicURL)
	}
	for name, values := range headers {
		if !strings.EqualFold(name, "Cookie") {
			r.Header.Del(name)
		}
		for _, value := range values {
			r.Header.Add(name, value)
		}
	}
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	return w
}

func TestBookStackExternalMetadataReturnsOnlyFixedAPIHopAndAPIAuthenticatesAgain(t *testing.T) {
	s, admin, controllers, _, _, dials := externalWikiFixture(t, func(http.ResponseWriter, *http.Request) {
		t.Error("metadata contacted external BookStack")
	})
	w := bookstackRoutingCall(s, admin, "GET", "/wiki/login", nil)
	if w.Code != 204 || w.Header().Get("X-Pl-Bookstack-Upstream") != "http://api:8080"+bookstackExternalPrefix || !strings.Contains(w.Header().Get("X-Pl-Bookstack-Cookie"), "portal_session=") || dials.Load() != 0 || *controllers != 0 {
		t.Fatal("external routing exposed the remote address, dropped reauthentication or probed a service", w.Code)
	}
	viewer := apiUser(t, s, "external-wiki-viewer", false)
	for _, tc := range []struct {
		who     apiIdentity
		headers http.Header
		method  string
		want    int
	}{
		{apiIdentity{}, nil, "GET", 401},
		{apiIdentity{}, http.Header{"Authorization": {"Bearer native"}, "Cookie": {"pl_bookstack_session=native"}}, "GET", 401},
		{viewer, nil, "GET", 403},
		{admin, http.Header{"Origin": {"https://foreign.example"}}, "POST", 403},
		{admin, http.Header{"Origin": {""}}, "POST", 403},
		{admin, http.Header{"Origin": {s.Config.PublicURL, s.Config.PublicURL}}, "POST", 403},
		{admin, http.Header{"Sec-Fetch-Site": {"cross-site"}}, "GET", 403},
		{admin, http.Header{"Upgrade": {"websocket"}}, "GET", 403},
		{admin, nil, "TRACE", 403},
	} {
		if got := externalWikiCall(s, tc.who, tc.method, "/login", "", tc.headers); got.Code != tc.want {
			t.Fatalf("external gate status=%d want=%d", got.Code, tc.want)
		}
	}
	if _, err := s.Store.Pool.Exec(context.Background(), "DELETE FROM sessions WHERE token_hash=$1", hash(admin.cookie.Value)); err != nil {
		t.Fatal(err)
	}
	if got := externalWikiCall(s, admin, "GET", "/login", "", nil); got.Code != 401 || dials.Load() != 0 || *controllers != 0 {
		t.Fatal("revoked Pl session reached external BookStack", got.Code)
	}
}

func TestBookStackExternalPreservesNativeBodyCookieAndCSRFWithoutPlatformCredentials(t *testing.T) {
	var s *Server
	captured := make(chan *http.Request, 1)
	bodies := make(chan string, 1)
	fixture, admin, controllers, _, _, _ := externalWikiFixture(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		captured <- r.Clone(context.Background())
		bodies <- string(body)
		w.Header().Set("Location", s.Config.PublicURL+"/wiki/books")
		w.Header().Add("Set-Cookie", "pl_bookstack_session=updated; Path=/wiki; Secure; HttpOnly; SameSite=Lax")
		w.Header().Add("Set-Cookie", "portal_session=forged; Path=/")
		w.Header().Set("X-Accel-Redirect", "/auth/logout")
		w.Header().Set("X-PL-User", "forged")
		w.WriteHeader(302)
	})
	s = fixture
	const nativeBody = "email=writer%40example.test&password=native&_token=native-csrf"
	headers := http.Header{
		"Cookie":       {"pl_bookstack_session=native; XSRF-TOKEN=native-xsrf"},
		"Content-Type": {"application/x-www-form-urlencoded"}, "Authorization": {"Bearer native-bookstack-token"},
		"X-Csrf-Token": {"native-csrf"}, "X-Xsrf-Token": {"native-xsrf"}, "X-Requested-With": {"XMLHttpRequest"},
		"X-PL-User": {"forged"}, "X-Auth-User": {"forged"}, "X-WEBAUTH-USER": {"forged"}, "Remote-User": {"forged"},
		"Proxy-Authorization": {"private-proxy"}, "X-Pl-Signature": {"private"}, "X-Pl-Bookstack-Upstream": {"https://169.254.169.254"},
		"X-Forwarded-Host": {"evil.example"}, "X-Forwarded-For": {"169.254.169.254"},
	}
	w := externalWikiCall(s, admin, "POST", "/login?return=%2Fwiki%2Fbooks&tag=a%2Fb", nativeBody, headers)
	if w.Code != 302 {
		t.Fatal("native form incorrectly required Pl JSON CSRF or failed proxying", w.Code, w.Body.String())
	}
	r := <-captured
	if body := <-bodies; body != nativeBody || r.URL.RequestURI() != "/login?return=%2Fwiki%2Fbooks&tag=a%2Fb" || r.Header.Get("Authorization") != "Bearer native-bookstack-token" || r.Header.Get("X-Csrf-Token") != "native-csrf" || r.Header.Get("X-Xsrf-Token") != "native-xsrf" || r.Header.Get("Cookie") != "pl_bookstack_session=native; XSRF-TOKEN=native-xsrf" {
		t.Fatal("native request was changed", r.URL.RequestURI())
	}
	public, _ := url.Parse(s.Config.PublicURL)
	if r.Host != public.Host || r.Header.Get("X-Forwarded-Host") != public.Host || r.Header.Get("X-Forwarded-Proto") != public.Scheme {
		t.Fatal("browser forwarding data replaced configured Pl origin")
	}
	for _, name := range []string{"X-PL-User", "X-Auth-User", "X-WEBAUTH-USER", "Remote-User", "Proxy-Authorization", "X-Pl-Signature", "X-Pl-Bookstack-Upstream", "X-Forwarded-For"} {
		if r.Header.Get(name) != "" {
			t.Error("identity or transport header reached BookStack", name)
		}
	}
	if len(w.Result().Cookies()) != 1 || w.Result().Cookies()[0].Name != "pl_bookstack_session" || w.Header().Get("X-Accel-Redirect") != "" || w.Header().Get("X-PL-User") != "" || *controllers != 0 {
		t.Fatal("external response overwrote Pl cookie or issued routing identity")
	}
}

func TestBookStackExternalDisableStopsNextNativeRequestWithoutContactingServer(t *testing.T) {
	s, admin, controllers, _, instance, dials := externalWikiFixture(t, func(http.ResponseWriter, *http.Request) {
		t.Error("disabled connection contacted external BookStack")
	})
	w := apiCall(s, admin, "POST", "/api/v1/modules/"+instance.ID+"/actions", map[string]string{"action": "disable", "idempotency_key": "wiki:disable:external"}, nil)
	if w.Code != 202 {
		t.Fatal("disable not queued", w.Code, w.Body.String())
	}
	if got := externalWikiCall(s, admin, "GET", "/login", "", nil); got.Code != 503 {
		t.Fatal("pending disable left native access enabled", got.Code)
	}
	after, err := finishModuleFixture(t, s)
	if err != nil || after.ObservedState != "disabled" || *controllers != 0 || dials.Load() != 0 {
		t.Fatal("disable affected external server or depended on controller", err, *controllers, dials.Load())
	}
}

func TestBookStackExternalResponseRequiresWikiCookiePathAndSameOriginRedirect(t *testing.T) {
	public, _ := url.Parse("https://pl.example:8443")
	native, _ := url.Parse("/wiki/books/one")
	for _, tc := range []struct {
		location, cookie string
		valid            bool
	}{
		{"https://pl.example:8443/wiki/login?return=%2Fwiki%2F", "pl_bookstack_session=native; Path=/wiki; Secure", true},
		{"/wiki/", "XSRF-TOKEN=native; Path=/wiki/", true},
		{"../login", "remember=native; Path=/wiki; Domain=pl.example", true},
		{"/wiki", "", true},
		{"https://old.example/wiki/login", "", false},
		{"http://pl.example:8443/wiki/login", "", false},
		{"//evil.example/wiki/", "", false},
		{"/auth/logout", "", false},
		{"/wiki/%2e%2e/auth/logout", "", false},
		{"/wiki/", "pl_bookstack_session=native; Path=/", false},
		{"/wiki/", "pl_bookstack_session=native; Path=/wiki; Domain=evil.example", false},
	} {
		response := &http.Response{Header: http.Header{}}
		if tc.location != "" {
			response.Header.Set("Location", tc.location)
		}
		if tc.cookie != "" {
			response.Header.Set("Set-Cookie", tc.cookie)
		}
		if err := bookstackExternalResponse(response, public, native); (err == nil) != tc.valid {
			t.Fatalf("location=%q cookie=%q result=%v want valid=%v", tc.location, tc.cookie, err, tc.valid)
		}
	}
}

func TestBookStackExternalLargeMultipartAndBodyLimitBeforeEgress(t *testing.T) {
	const fileSize = 21 << 20
	received := new(atomic.Int64)
	s, admin, _, _, _, dials := externalWikiFixture(t, func(w http.ResponseWriter, r *http.Request) {
		parts, err := r.MultipartReader()
		if err != nil {
			t.Error("native multipart content type changed")
			w.WriteHeader(400)
			return
		}
		part, err := parts.NextPart()
		if err != nil || part.FileName() != "owned-large.txt" {
			t.Error("native multipart file identity changed")
			w.WriteHeader(400)
			return
		}
		count, err := io.Copy(io.Discard, part)
		if err != nil {
			t.Error("native file stream was truncated")
			w.WriteHeader(400)
			return
		}
		received.Store(count)
		w.WriteHeader(204)
	})
	body := "--wiki-large\r\nContent-Disposition: form-data; name=\"file\"; filename=\"owned-large.txt\"\r\nContent-Type: text/plain\r\n\r\n" + strings.Repeat("a", fileSize) + "\r\n--wiki-large--\r\n"
	w := externalWikiCall(s, admin, "POST", "/attachments/upload", body, http.Header{"Content-Type": {"multipart/form-data; boundary=wiki-large"}})
	if w.Code != 204 || received.Load() != fileSize || dials.Load() != 1 {
		t.Fatal("file above the former 20 MiB cap did not reach native multipart intact", w.Code, received.Load(), dials.Load())
	}
	r := httptest.NewRequest("POST", s.Config.PublicURL+bookstackExternalPrefix+"/attachments/upload", nil)
	r.AddCookie(admin.cookie)
	r.Header.Set("Origin", s.Config.PublicURL)
	r.ContentLength = bookstackNativeBodyLimit + 1
	w = httptest.NewRecorder()
	s.bookstackExternalProxy(w, r)
	if w.Code != http.StatusRequestEntityTooLarge || dials.Load() != 1 {
		t.Fatal("oversized native request passed its limit or reached the external server", w.Code, dials.Load())
	}
}

func TestBookStackExternalAdminRegistrationReconnectAndRemovalWithoutLocalInstallation(t *testing.T) {
	var s *Server
	nativeRequests := new(atomic.Int32)
	seed, _, controllerCalls, _, _, _ := externalWikiFixture(t, func(w http.ResponseWriter, r *http.Request) {
		nativeRequests.Add(1)
		if r.URL.Path == "/status" {
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, `{"database":true,"cache":true,"session":true}`)
			return
		}
		w.Header().Set("Content-Type", "text/html")
		io.WriteString(w, `<form method="POST" action="`+s.Config.PublicURL+`/wiki/login"></form>`)
	})
	var admin apiIdentity
	s, admin = localUsersFixture(t)
	s.Config.PortableRelease = true
	s.Config.ModuleVersions = map[string]string{}
	s.Modules = modules.New(s.Store, seed.Modules.Controller)
	s.Modules.BookStack, s.Modules.PublicURL = seed.Modules.BookStack, s.Config.PublicURL
	input := map[string]any{"module_id": "bookstack", "name": "My Wiki", "mode": "external", "endpoint": "http://wiki.external.example:8444", "idempotency_key": "wiki:external:create"}
	input["config"] = map[string]string{"connection_ips": `["169.254.169.254"]`}
	if got := apiCall(s, admin, "POST", "/api/v1/modules", input, nil); got.Code != 400 {
		t.Fatal("caller-supplied network approval was accepted", got.Code)
	}
	delete(input, "config")
	w := apiCall(s, admin, "POST", "/api/v1/modules", input, nil)
	if w.Code != 202 {
		t.Fatal("fresh external connection requires a local installation", w.Code, w.Body.String())
	}
	var created struct {
		Instance model.ModuleInstance `json:"instance"`
		Job      model.Job            `json:"job"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if got := apiCall(s, admin, "POST", "/api/v1/modules", input, nil); got.Code != 202 || !strings.Contains(got.Body.String(), created.Job.ID) {
		t.Fatal("creation retry was not idempotent", got.Code)
	}
	installed, err := finishModuleFixture(t, s)
	if err != nil || installed.ObservedState != "running" || nativeRequests.Load() != 2 {
		t.Fatal("external connection did not verify native status and APP_URL", err, nativeRequests.Load())
	}
	s.Config.ModuleVersions["bookstack"] = "fixture-version"
	if got := apiCall(s, admin, "POST", "/api/v1/modules", map[string]string{"module_id": "bookstack", "name": "Local Wiki", "mode": "local", "idempotency_key": "wiki:local:conflict"}, nil); got.Code != 409 {
		t.Fatal("local mode bypassed the external alias owner", got.Code)
	}
	if got := apiCall(s, admin, "POST", "/api/v1/modules/"+created.Instance.ID+"/initial-login", map[string]string{"service": "bookstack"}, nil); got.Code == 200 {
		t.Fatal("external connection returned an initial-login password")
	}
	instance, err := store.Get[model.ModuleInstance](context.Background(), s.Store, "module_instance", created.Instance.ID)
	if err != nil {
		t.Fatal(err)
	}
	reconnect := map[string]any{"action": "reconnect", "endpoint": "http://replacement.example:8444", "revision": instance.Revision, "idempotency_key": "wiki:external:replace"}
	if got := apiCall(s, admin, "POST", "/api/v1/modules/"+instance.ID+"/actions", reconnect, nil); got.Code != 202 {
		t.Fatal("external endpoint replacement failed", got.Code, got.Body.String())
	}
	if got := externalWikiCall(s, admin, "GET", "/login", "", nil); got.Code != 503 || nativeRequests.Load() != 2 {
		t.Fatal("pending reconnect used an unconfirmed endpoint", got.Code)
	}
	updated, err := finishModuleFixture(t, s)
	if err != nil || updated.Endpoint != "http://replacement.example:8444" || updated.ObservedState != "running" || nativeRequests.Load() != 4 {
		t.Fatal("replacement endpoint not independently observed", updated, err)
	}
	for _, action := range []string{"disable", "remove"} {
		payload := map[string]string{"action": action, "idempotency_key": "wiki:external:" + action}
		if action == "remove" {
			payload["confirm_name"] = "My Wiki"
		}
		if got := apiCall(s, admin, "POST", "/api/v1/modules/"+instance.ID+"/actions", payload, nil); got.Code != 202 {
			t.Fatal("lifecycle action failed", action, got.Code, got.Body.String())
		}
		if _, err := finishModuleFixture(t, s); err != nil {
			t.Fatal("external lifecycle depended on controller", action, err)
		}
	}
	if nativeRequests.Load() != 4 || *controllerCalls != 0 {
		t.Fatal("disable/remove contacted or changed external BookStack", nativeRequests.Load(), *controllerCalls)
	}
	if got := externalWikiCall(s, admin, "GET", "/login", "", nil); got.Code != 503 || nativeRequests.Load() != 4 {
		t.Fatal("removed source still reached previous endpoint", got.Code)
	}
}

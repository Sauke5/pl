package server

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"pl/portal/internal/model"
	"strings"
	"sync"
	"testing"
	"time"
)

func sftpAdminTestGateway(t *testing.T, handler http.HandlerFunc) *sftpAdminGateway {
	t.Helper()
	upstream := httptest.NewTLSServer(handler)
	t.Cleanup(upstream.Close)
	dir := t.TempDir()
	cafile := filepath.Join(dir, "ca.pem")
	keyfile := filepath.Join(dir, "api.key")
	if e := os.WriteFile(cafile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: upstream.Certificate().Raw}), 0600); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(keyfile, []byte(strings.Repeat("K", 48)), 0600); e != nil {
		t.Fatal(e)
	}
	s := &Server{Config: Config{PublicURL: "https://platform.example"}}
	fixtureURL, e := url.Parse(upstream.URL)
	if e != nil {
		t.Fatal(e)
	}
	logicalURL := "https://" + net.JoinHostPort("192.0.2.10", fixtureURL.Port())
	g, e := newSFTPAdminGateway(s, SFTPAdminConfig{UpstreamURL: logicalURL, CAFile: cafile, AdminKeyFile: keyfile, DataRoot: "/srv/sftpgo-files/data", AllowedCIDRs: []string{"192.0.2.10/32"}}, nil)
	if e != nil {
		t.Fatal(e)
	}
	// Exercise cookie/route/CSRF boundaries against a pinned local TLS fixture.
	// The production guard continues to reject loopback destinations.
	transport := g.client.Transport.(*http.Transport)
	transport.TLSClientConfig.ServerName = fixtureURL.Hostname()
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != net.JoinHostPort("192.0.2.10", fixtureURL.Port()) {
			return nil, errors.New("unexpected fixture destination")
		}
		return (&net.Dialer{}).DialContext(ctx, network, upstream.Listener.Addr().String())
	}
	g.readSession = func(r *http.Request) (session, error) {
		if r.Header.Get("Authorization") != "" {
			return session{}, errors.New("machine")
		}
		c, e := r.Cookie("portal_session")
		if e != nil {
			return session{}, e
		}
		return session{User: model.User{ID: c.Value, Name: "Person", Admin: strings.HasPrefix(c.Value, "admin")}, CSRF: "csrf-" + c.Value, ExpiresAt: time.Now().Add(time.Hour)}, nil
	}
	return g
}
func sftpAdminTestRequest(method, path, identity string) *http.Request {
	r := httptest.NewRequest(method, "https://platform.example"+path, nil)
	if identity != "" {
		r.AddCookie(&http.Cookie{Name: "portal_session", Value: identity})
	}
	return r
}
func TestSFTPAdminNativeRouteBoundary(t *testing.T) {
	for _, tc := range []struct {
		method, path, mode string
		ok                 bool
	}{
		{"GET", "/sftp-adm/web/admin/users/json", "admin", true},
		{"DELETE", "/sftp-adm/web/admin/folder/my-folder", "admin", true},
		{"POST", "/sftp-adm/web/admin/quotas/scanuser/person", "admin", true},
		{"POST", "/sftp-adm/web/client/file-actions/move", "files", true},
		{"GET", "/sftp-adm/web/client/tasks/id-1", "files", true},
		{"GET", "/sftp-adm/static/assets/a.js", "", true},
		{"GET", "/sftp-adm/web/oidc/redirect", "callback", true},
		{"POST", "/sftp-adm/web/admin/login", "", false},
		{"POST", "/sftp-adm/web/admin/setup", "", false},
		{"GET", "/sftp-adm/web/admin/manager/alice", "", false},
		{"POST", "/sftp-adm/web/admin/restore", "", false},
		{"POST", "/sftp-adm/web/admin/configs", "", false},
		{"GET", "/sftp-adm/web/client/pubshares/id", "", false},
		{"GET", "/sftp-adm/api/v2/users", "", false},
		{"GET", "/api/v2/users", "", false},
		{"GET", "/sftp-adm/static/../../secret", "", false},
		{"GET", "/sftp-adm/web/admin/user/a%2fb", "", false},
		{"GET", "/sftp-adm/web/admin//users", "", false},
		{"PUT", "/sftp-adm/web/admin/user/a", "", false},
	} {
		mode, ok := sftpAdminRoute(tc.method, tc.path)
		if ok != tc.ok || ok && mode != tc.mode {
			t.Errorf("%s %s = %q,%v", tc.method, tc.path, mode, ok)
		}
	}
}
func TestSFTPAdminCapabilityIsBrowserOnly(t *testing.T) {
	g := sftpAdminTestGateway(t, func(w http.ResponseWriter, r *http.Request) { t.Error("capability touched native API") })
	for _, tc := range []struct {
		id      string
		machine bool
		want    int
		admin   bool
	}{{"", false, 401, false}, {"person", true, 401, false}, {"person", false, 200, false}, {"admin-a", false, 200, true}} {
		r := sftpAdminTestRequest("GET", "/api/v1/sftp-adm", tc.id)
		if tc.machine {
			r.Header.Set("Authorization", "Bearer forged")
		}
		w := httptest.NewRecorder()
		g.capabilities(w, r)
		if w.Code != tc.want {
			t.Fatalf("status=%d want%d", w.Code, tc.want)
		}
		if tc.want == 200 {
			var data map[string]any
			if e := json.Unmarshal(w.Body.Bytes(), &data); e != nil {
				t.Fatal(e)
			}
			if data["configured"] != true || data["can_admin"] != tc.admin || data["can_access_files"] != true || data["native_username"] != sftpAdminNativeUsername(tc.id) {
				t.Fatal(data)
			}
		}
	}
}
func TestSFTPAdminGatewayRejectsUnsafeAndForeignRoutes(t *testing.T) {
	g := sftpAdminTestGateway(t, func(w http.ResponseWriter, r *http.Request) { t.Error("denied request reached native server") })
	for _, tc := range []struct {
		method, path, id, origin string
		status                   int
	}{
		{"GET", "/sftp-adm/web/admin/users", "viewer", "", 403}, {"GET", "/sftp-adm/web/client/files", "", "", 401},
		{"POST", "/sftp-adm/web/client/dirs", "viewer", "", 403}, {"POST", "/sftp-adm/web/client/dirs", "viewer", "https://evil.example", 403},
		{"GET", "/sftp-adm/web/admin/user/a%2fb", "admin", "", 404}, {"GET", "/sftp-adm/api/v2/users", "admin", "", 404},
		{"POST", "/sftp-adm/web/admin/login", "admin", "https://platform.example", 404}, {"GET", "/sftp-adm/web/oidc/redirect?state=unbound", "admin", "", 403},
	} {
		r := sftpAdminTestRequest(tc.method, tc.path, tc.id)
		r.Header.Set("Origin", tc.origin)
		w := httptest.NewRecorder()
		g.proxy(w, r)
		if w.Code != tc.status {
			t.Errorf("%s %s:%d want%d", tc.method, tc.path, w.Code, tc.status)
		}
	}
}
func TestSFTPAdminNativeCookiesBoundToPortalSessionAndView(t *testing.T) {
	var mu sync.Mutex
	received := make(map[string]string)
	g := sftpAdminTestGateway(t, func(w http.ResponseWriter, r *http.Request) {
		id := r.URL.Query().Get("id")
		mu.Lock()
		received[id] = r.Header.Get("Cookie")
		mu.Unlock()
		for _, h := range []string{"Authorization", "Proxy-Authorization", "X-PL-Gateway-Assertion", "Remote-User", "X-Auth-User", "X-SFTPGO-API-KEY"} {
			if r.Header.Get(h) != "" {
				t.Errorf("forwarded secret header %s", h)
			}
		}
		if r.Header.Get("X-Forwarded-Host") != "platform.example" || r.Header.Get("X-Forwarded-Proto") != "https" {
			t.Error("untrusted forwarded authority")
		}
		if id == "one" {
			http.SetCookie(w, &http.Cookie{Name: "oidc", Value: "native-one", Path: "/", HttpOnly: true, Secure: true})
		}
		w.Write([]byte("ok"))
	})
	send := func(id, identity, path string) {
		t.Helper()
		r := sftpAdminTestRequest("GET", path+"?id="+id, identity)
		r.AddCookie(&http.Cookie{Name: "oidc", Value: "browser-forged"})
		r.Header.Set("Remote-User", "spoof")
		r.Header.Set("X-PL-Gateway-Assertion", "spoof")
		r.Header.Set("X-Auth-User", "spoof")
		r.Header.Set("X-SFTPGO-API-KEY", "spoof")
		r.Header.Set("X-Forwarded-Host", "evil.example")
		w := httptest.NewRecorder()
		g.proxy(w, r)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		if len(w.Result().Cookies()) != 0 {
			t.Fatal("native cookie escaped to browser")
		}
	}
	send("one", "admin-a", "/sftp-adm/web/admin/users")
	send("same", "admin-a", "/sftp-adm/web/admin/users")
	send("other-view", "admin-a", "/sftp-adm/web/client/files")
	send("other-login", "admin-b", "/sftp-adm/web/admin/users")
	if received["one"] != "" || received["same"] != "oidc=native-one" || received["other-view"] != "" || received["other-login"] != "" {
		t.Fatal(received)
	}
}
func TestSFTPAdminProxyPreservesNativeCSRFAndBody(t *testing.T) {
	const body = "{\"path\":\"/a b\",\"operation\":\"move\"}"
	g := sftpAdminTestGateway(t, func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		if string(b) != body || r.Header.Get("X-CSRF-TOKEN") != "signed-native-csrf" {
			t.Error("native request rewritten")
		}
		w.WriteHeader(204)
	})
	r := sftpAdminTestRequest("POST", "/sftp-adm/web/client/file-actions/move", "person")
	r.Body = io.NopCloser(strings.NewReader(body))
	r.ContentLength = int64(len(body))
	r.Header.Set("Origin", "https://platform.example")
	r.Header.Set("X-CSRF-TOKEN", "signed-native-csrf")
	w := httptest.NewRecorder()
	g.proxy(w, r)
	if w.Code != 204 {
		t.Fatal(w.Code, w.Body.String())
	}
}
func TestSFTPAdminNativeRedirectBoundary(t *testing.T) {
	g := sftpAdminTestGateway(t, func(w http.ResponseWriter, r *http.Request) {})
	for _, loc := range []string{"https://evil.example/sftp-adm/web/client/files", "//evil.example/sftp-adm/web/client/files", "/api/v1/session", "/sftp-adm/web/admin/setup", "/sftp-adm/web/client/../admin/users", "/sftp-adm/web/admin/users#fragment"} {
		if _, _, e := g.safeLocation(loc); e == nil {
			t.Errorf("accepted %s", loc)
		}
	}
	for _, loc := range []string{"/sftp-adm/web/client/files", "https://platform.example/sftp-adm/web/admin/users", "https://platform.example/auth/sftp-adm/oidc/authorize?state=a"} {
		if _, _, e := g.safeLocation(loc); e != nil {
			t.Errorf("rejected %s: %v", loc, e)
		}
	}
}
func TestSFTPAdminCallbackStateCannotCrossSessionsOrViews(t *testing.T) {
	calls := 0
	g := sftpAdminTestGateway(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		c, _ := r.Cookie("oidc")
		if c == nil || c.Value != "admin-cookie" {
			t.Errorf("wrong role cookie: %v", c)
		}
		w.Write([]byte("callback accepted"))
	})
	r := sftpAdminTestRequest("GET", "/sftp-adm/web/oidc/redirect?state=state-native", "admin-a")
	v, _ := g.readSession(r)
	b, _ := g.browser(r, v)
	b.Pending["state-native"] = sftpAdminPending{Mode: "admin", Expires: time.Now().Add(time.Minute)}
	b.Jars["admin"].SetCookies(g.upstream, []*http.Cookie{{Name: "oidc", Value: "admin-cookie", Path: "/", Secure: true}})
	forged := sftpAdminTestRequest("GET", r.URL.RequestURI(), "admin-b")
	w := httptest.NewRecorder()
	g.proxy(w, forged)
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
	w = httptest.NewRecorder()
	g.proxy(w, r)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	g.proxy(w, r)
	if w.Code != 403 || calls != 1 {
		t.Fatal("callback replay accepted")
	}
}
func TestSFTPAdminNativeProvisioningIsCreateOnly(t *testing.T) {
	var got map[string]any
	posts := 0
	gets := 0
	g := sftpAdminTestGateway(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-SFTPGO-API-KEY") != strings.Repeat("K", 48) {
			t.Error("missing private native key")
		}
		switch r.Method {
		case "GET":
			gets++
			if got == nil {
				http.NotFound(w, r)
				return
			}
			json.NewEncoder(w).Encode(got)
		case "POST":
			posts++
			if e := json.NewDecoder(r.Body).Decode(&got); e != nil {
				t.Error(e)
			}
			w.WriteHeader(201)
		default:
			t.Errorf("existing permissions overwritten: %s", r.Method)
		}
	})
	v := session{User: model.User{ID: "person"}}
	if e := g.ensureIdentity(context.Background(), v, "files"); e != nil {
		t.Fatal(e)
	}
	if posts != 1 || gets != 2 {
		t.Fatal(posts, gets)
	}
	home, _ := got["home_dir"].(string)
	if home != "/srv/sftpgo-files/data/users/"+sftpAdminNativeUsername("person") {
		t.Fatal(home)
	}
	perms := got["permissions"].(map[string]any)["/"].([]any)
	if len(perms) != 2 || perms[0] != "list" || perms[1] != "download" {
		t.Fatal(perms)
	}
	got["permissions"] = map[string]any{"/": []string{"list", "download", "upload"}}
	got["quota_size"] = float64(1024)
	if e := g.ensureIdentity(context.Background(), v, "files"); e != nil {
		t.Fatal(e)
	}
	if posts != 1 || got["quota_size"] != float64(1024) {
		t.Fatal("overwrote native rights")
	}
	got["status"] = float64(0)
	if e := g.ensureIdentity(context.Background(), v, "files"); e == nil {
		t.Fatal("reenabled disabled native account")
	}
	got["status"] = float64(1)
	got["additional_info"] = "not ours"
	if e := g.ensureIdentity(context.Background(), v, "files"); e == nil {
		t.Fatal("adopted foreign account")
	}
}
func TestSFTPAdminProvisionAdminCannotGrantStarOrAPIKeys(t *testing.T) {
	var got map[string]any
	g := sftpAdminTestGateway(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			if got == nil {
				http.NotFound(w, r)
				return
			}
			json.NewEncoder(w).Encode(got)
			return
		}
		json.NewDecoder(r.Body).Decode(&got)
		w.WriteHeader(201)
	})
	if e := g.ensureIdentity(context.Background(), session{User: model.User{ID: "viewer"}}, "admin"); e == nil {
		t.Fatal("viewer became native admin")
	}
	if e := g.ensureIdentity(context.Background(), session{User: model.User{ID: "administrator", Admin: true}}, "admin"); e != nil {
		t.Fatal(e)
	}
	for _, p := range got["permissions"].([]any) {
		if p == "*" {
			t.Fatal("unbounded native superuser")
		}
	}
	if got["filters"].(map[string]any)["allow_api_key_auth"] != false {
		t.Fatal("native admin API key enabled")
	}
}
func TestSFTPAdminNativeTLSAndRedirectsFailClosed(t *testing.T) {
	g := sftpAdminTestGateway(t, func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "https://evil.example", 302) })
	w := httptest.NewRecorder()
	g.proxy(w, sftpAdminTestRequest("GET", "/sftp-adm/web/client/files", "person"))
	if w.Code != 502 || w.Header().Get("Location") != "" {
		t.Fatal(w.Code, w.Header())
	}
	u, _ := url.Parse(g.upstream.String())
	u.Scheme = "http"
	g.cfg.UpstreamURL = u.String()
	if _, e := newSFTPAdminGateway(g.server, g.cfg, nil); e == nil {
		t.Fatal("plain HTTP native upstream accepted")
	}
}

func TestSFTPAdminLaunchKeepsNativeBrowserBindingServerSide(t *testing.T) {
	const state = "native-state-0123456789"
	var identity map[string]any
	g := sftpAdminTestGateway(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/api/v2/"):
			if r.Method == "POST" {
				json.NewDecoder(r.Body).Decode(&identity)
				w.WriteHeader(201)
				return
			}
			if identity == nil {
				http.NotFound(w, r)
				return
			}
			json.NewEncoder(w).Encode(identity)
		case r.URL.Path == "/sftp-adm/web/admin/oidclogin":
			if r.Header.Get("X-SFTPGO-API-KEY") != "" {
				t.Error("provisioner credential leaked into native UI")
			}
			http.SetCookie(w, &http.Cookie{Name: "oidc_browser", Value: "browser-binding", Path: "/", Secure: true, HttpOnly: true})
			http.Redirect(w, r, "https://platform.example/auth/sftp-adm/oidc/authorize?state="+state+"&nonce=native-nonce", 302)
		case r.URL.Path == "/sftp-adm/web/oidc/redirect":
			c, _ := r.Cookie("oidc_browser")
			if c == nil || c.Value != "browser-binding" {
				t.Errorf("native browser binding lost: %v", c)
			}
			http.SetCookie(w, &http.Cookie{Name: "oidc", Value: "native-auth", Path: "/", Secure: true, HttpOnly: true})
			http.Redirect(w, r, "/sftp-adm/web/admin/users", 302)
		default:
			t.Errorf("unexpected native path %s", r.URL.Path)
		}
	})
	g.beginFlow = func(w http.ResponseWriter, r *http.Request, mode, username string) error {
		if mode != "admin" || username != sftpAdminNativeUsername("admin-a") {
			t.Fatal("wrong native launch identity")
		}
		http.SetCookie(w, &http.Cookie{Name: "pl_sftp_flow", Value: "issuer-flow", Path: "/auth/sftp-adm/oidc", Secure: true, HttpOnly: true})
		return nil
	}
	r := sftpAdminTestRequest("GET", "/sftp-adm/open/admin", "admin-a")
	w := httptest.NewRecorder()
	g.open(w, r)
	if w.Code != 302 || !strings.HasPrefix(w.Header().Get("Location"), "/auth/sftp-adm/oidc/authorize?") {
		t.Fatal(w.Code, w.Body.String(), w.Header())
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != "pl_sftp_flow" {
		t.Fatal("native cookie escaped or issuer cookie lost", cookies)
	}
	if identity["description"] != "Person" {
		t.Fatal("native identity lacks human description", identity["description"])
	}
	callback := sftpAdminTestRequest("GET", "/sftp-adm/web/oidc/redirect?state="+state+"&code=one-time", "admin-a")
	w = httptest.NewRecorder()
	g.proxy(w, callback)
	if w.Code != 302 || w.Header().Get("Location") != "/sftp-adm/web/admin/users" || len(w.Result().Cookies()) != 0 {
		t.Fatal(w.Code, w.Body.String(), w.Header())
	}
}

func TestSFTPAdminNativeStorageFormsCannotExposeOwnSecrets(t *testing.T) {
	calls := 0
	g := sftpAdminTestGateway(t, func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(204) })
	for _, tc := range []struct {
		object, field, value, provider string
		allowed                        bool
	}{
		{"folder", "mapped_path", "/etc/sftpgo-files", "0", false},
		{"user", "home_dir", "/etc/sftpgo-files/tls", "0", false},
		{"group", "home_dir", "/srv/sftpgo-files/state", "0", false},
		{"folder", "mapped_path", "/srv/sftpgo/data", "0", false},
		{"folder", "mapped_path", "/srv/sftpgo-files/data-other", "0", false},
		{"folder", "mapped_path", "/srv/sftpgo-files/data/../state", "0", false},
		{"folder", "mapped_path", "/srv/sftpgo-files/data/%name%", "0", false},
		{"folder", "mapped_path", "/srv/sftpgo-files/data/shared", "5", false},
		{"folder", "mapped_path", "/srv/sftpgo-files/data/shared", "0", true},
		{"user", "home_dir", "/srv/sftpgo-files/data/users/person", "0", true},
		{"user", "home_dir", "", "0", true},
		{"group", "home_dir", "", "", true},
	} {
		var data bytes.Buffer
		form := multipart.NewWriter(&data)
		form.WriteField("_form_token", "signed-native-csrf")
		form.WriteField(tc.field, tc.value)
		form.WriteField("fs_provider", tc.provider)
		form.Close()
		r := sftpAdminTestRequest("POST", "/sftp-adm/web/admin/"+tc.object, "admin-a")
		r.Body = io.NopCloser(bytes.NewReader(data.Bytes()))
		r.Header.Set("Content-Type", form.FormDataContentType())
		r.Header.Set("Origin", "https://platform.example")
		w := httptest.NewRecorder()
		before := calls
		g.proxy(w, r)
		if tc.allowed {
			if w.Code != 204 || calls != before+1 {
				t.Errorf("valid form rejected %v: %d %s", tc, w.Code, w.Body.String())
			}
		} else if w.Code != 403 || calls != before {
			t.Errorf("unsafe form passed %v: %d", tc, w.Code)
		}
	}
}
func TestSFTPAdminNativeStorageFormPreservesBytesAndRejectsAmbiguity(t *testing.T) {
	g := sftpAdminTestGateway(t, func(w http.ResponseWriter, r *http.Request) {})
	var data bytes.Buffer
	form := multipart.NewWriter(&data)
	form.WriteField("home_dir", "/srv/sftpgo-files/data/users/person")
	form.WriteField("fs_provider", "0")
	form.Close()
	r := sftpAdminTestRequest("POST", "/sftp-adm/web/admin/user", "admin-a")
	r.Header.Set("Content-Type", form.FormDataContentType())
	r.Body = io.NopCloser(bytes.NewReader(data.Bytes()))
	if e := g.validateStorageForm(r); e != nil {
		t.Fatal(e)
	}
	body, _ := io.ReadAll(r.Body)
	if !bytes.Equal(body, data.Bytes()) {
		t.Fatal("native CSRF/form bytes changed")
	}
	r.URL.RawQuery = "home_dir=/etc"
	r.Body = io.NopCloser(bytes.NewReader(data.Bytes()))
	if e := g.validateStorageForm(r); e == nil {
		t.Fatal("query override accepted")
	}
	data.Reset()
	form = multipart.NewWriter(&data)
	form.WriteField("home_dir", "/srv/sftpgo-files/data")
	form.WriteField("home_dir", "/etc")
	form.Close()
	r.URL.RawQuery = ""
	r.Header.Set("Content-Type", form.FormDataContentType())
	r.Body = io.NopCloser(bytes.NewReader(data.Bytes()))
	if e := g.validateStorageForm(r); e == nil {
		t.Fatal("duplicate storage field accepted")
	}
}

func TestSFTPAdminUnicodeObjectRoutesAndEncodedBoundaries(t *testing.T) {
	for _, method := range []string{"GET", "POST", "DELETE"} {
		for _, object := range []string{"folder", "group", "user"} {
			p := "/sftp-adm/web/admin/" + object + "/Папка 1"
			mode, ok := sftpAdminRoute(method, p)
			if !ok || mode != "admin" {
				t.Fatalf("native Unicode object denied: %s %s", method, p)
			}
		}
	}
	nativeCalls := 0
	g := sftpAdminTestGateway(t, func(w http.ResponseWriter, r *http.Request) {
		nativeCalls++
		if r.URL.Path != "/sftp-adm/web/admin/folder/Папка 1" {
			t.Errorf("Unicode route changed: %s", r.URL.Path)
		}
		w.WriteHeader(204)
	})
	for _, p := range []string{"/sftp-adm/web/admin/folder/Папка 1", "/sftp-adm/web/admin/folder/%D0%9F%D0%B0%D0%BF%D0%BA%D0%B0%201"} {
		r := sftpAdminTestRequest("DELETE", strings.ReplaceAll(p, " ", "%20"), "admin-a")
		r.Header.Set("Origin", "https://platform.example")
		w := httptest.NewRecorder()
		g.proxy(w, r)
		if w.Code != 204 {
			t.Fatal(p, w.Code, w.Body.String())
		}
	}
	if nativeCalls != 2 {
		t.Fatal(nativeCalls)
	}
	for _, p := range []string{"/sftp-adm/web/admin/folder/a%2fb", "/sftp-adm/web/admin/folder/a%5cb", "/sftp-adm/web/admin/folder/%252e%252e", "/sftp-adm/web/admin/folder/%2e%2e", "/sftp-adm/web/admin/folder/a%00b", "/sftp-adm/web/admin/folder/a%0Ab", "/sftp-adm/web/admin/folder/a%7Fb"} {
		r := sftpAdminTestRequest("GET", p, "admin-a")
		w := httptest.NewRecorder()
		g.proxy(w, r)
		if w.Code != 404 {
			t.Errorf("encoded boundary bypass %s: %d", p, w.Code)
		}
	}
	if nativeCalls != 2 {
		t.Fatal("encoded unsafe path reached native server")
	}
}

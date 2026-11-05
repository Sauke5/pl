package server

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/netguard"
	"pl/portal/internal/providers"
	"pl/portal/internal/store"
)

func TestWaylineRouteAllowlist(t *testing.T) {
	valid := [][2]string{{"GET", "/wayline/"}, {"GET", "/wayline/assets/index-AbC.js"}, {"HEAD", "/wayline/favicon.svg"}, {"GET", "/wayline/api/v1/targets"}, {"POST", "/wayline/api/v1/targets"}, {"PUT", "/wayline/api/v1/targets/7"}, {"DELETE", "/wayline/api/v1/targets/7"}, {"GET", "/wayline/api/v1/checks/latest?kind=path"}, {"GET", "/wayline/api/v1/checks/latest?kind=iperf"}, {"GET", "/wayline/api/v1/checks?target_id=7&limit=50"}, {"GET", "/wayline/api/v1/checks/7"}, {"POST", "/wayline/api/v1/targets/7/checks"}}
	invalid := [][2]string{{"GET", "/wayline/metrics"}, {"GET", "/wayline/health"}, {"GET", "/wayline/api/v1/secrets"}, {"GET", "/wayline/api/v1/targets?url=http://evil"}, {"GET", "/wayline/?token=secret"}, {"GET", "/wayline/api/v1/checks/latest?kind=path&kind=iperf"}, {"GET", "/wayline/api/v1/checks/latest?kind=unknown"}, {"GET", "/wayline/api/v1/checks?target_id=1&limit=500"}, {"GET", "/wayline/api/v1/targets/1"}, {"POST", "/wayline/assets/run.js"}, {"GET", "/wayline/assets/../../metrics"}, {"GET", "/wayline/%2e%2e/metrics"}, {"GET", "/wayline/assets/%2Fmetrics"}, {"GET", "/wayline/assets/%252e%252e/x"}, {"GET", "/wayline//api/v1/targets"}, {"GET", "/wayline/api/v1/targets/../checks"}, {"GET", "/wayline/assets/a%5cb.js"}, {"CONNECT", "/wayline/"}, {"OPTIONS", "/wayline/api/v1/targets"}}
	for _, tc := range valid {
		if _, _, ok := waylineRoute(httptest.NewRequest(tc[0], tc[1], nil)); !ok {
			t.Errorf("valid route rejected: %v", tc)
		}
	}
	for _, tc := range invalid {
		if _, _, ok := waylineRoute(httptest.NewRequest(tc[0], tc[1], nil)); ok {
			t.Errorf("unsafe route accepted: %v", tc)
		}
	}
}

func TestWaylineProxySessionBoundaryAndFixedUpstream(t *testing.T) {
	s := apiFixture(t)
	admin := apiUser(t, s, "wayline-admin", true)
	viewer := apiUser(t, s, "wayline-board", false)
	t.Setenv("PORTAL_SECRET_REFS", "env:PORTAL_SECRET_WAYLINE_TEST")
	t.Setenv("PORTAL_SECRET_WAYLINE_TEST", "fixture-source-password")
	var calls atomic.Int32
	var mode atomic.Int32
	started, release := make(chan struct{}, 4), make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		user, password, ok := r.BasicAuth()
		if !ok || user != "fixture-gateway" || password != "fixture-source-password" {
			t.Error("missing server Basic")
		}
		for _, h := range []string{"Cookie", "X-CSRF-Token", "X-Forwarded-For", "X-Forwarded-Host", "Forwarded", "Proxy-Authorization", "X-Portal-User"} {
			if r.Header.Get(h) != "" {
				t.Errorf("browser header leaked: %s", h)
			}
		}
		if strings.HasPrefix(r.URL.Path, "/wayline") || strings.Contains(r.URL.RawQuery, "secret") {
			t.Error("invalid upstream path")
		}
		switch mode.Load() {
		case 1:
			w.Header().Set("Location", "https://evil.test/stolen")
			w.WriteHeader(302)
			return
		case 2:
			started <- struct{}{}
			<-release
		}
		w.Header().Set("Set-Cookie", "portal_session=source; Path=/")
		w.Header().Set("WWW-Authenticate", `Basic realm="source"`)
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()
	g, err := netguard.NewWithDependencies([]string{"10.0.0.0/8"}, []int{80}, "", browseResolver{}, func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(upstream.URL, "http://"))
	})
	if err != nil {
		t.Fatal(err)
	}
	reg := providers.New(g, "")
	source := model.Integration{ID: "wayline-fixed", Kind: "wayline", Enabled: true, URL: "http://source", SecretRef: "env:PORTAL_SECRET_WAYLINE_TEST", Config: map[string]string{"basic_username": "fixture-gateway"}}
	if _, err = s.Store.Save(context.Background(), "integration", source.ID, 0, source, "test"); err != nil {
		t.Fatal(err)
	}
	h := s.WaylineProxy(source.ID, reg.WaylineProxyTransport)
	call := func(who apiIdentity, method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, s.Config.PublicURL+path, strings.NewReader(body))
		if who.cookie != nil {
			r.AddCookie(who.cookie)
		}
		r.Header.Set("X-CSRF-Token", who.csrf)
		r.Header.Set("Origin", s.Config.PublicURL)
		r.Header.Set("Content-Type", "application/json")
		for k, v := range headers {
			r.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	for _, tc := range []struct {
		who          apiIdentity
		method, path string
		status       int
	}{{apiIdentity{}, "GET", "/wayline/", 303}, {apiIdentity{}, "GET", "/wayline/api/v1/targets", 401}, {viewer, "GET", "/wayline/", 403}, {viewer, "GET", "/wayline/api/v1/targets", 403}} {
		w := call(tc.who, tc.method, tc.path, "", nil)
		if w.Code != tc.status {
			t.Fatalf("auth got %d want %d", w.Code, tc.status)
		}
		if w.Code == 303 && w.Header().Get("Location") != "/" {
			t.Fatal("unsafe login redirect")
		}
	}
	for _, headers := range []map[string]string{{"X-CSRF-Token": ""}, {"Origin": "https://evil.test"}, {"Sec-Fetch-Site": "cross-site"}} {
		if w := call(admin, "POST", "/wayline/api/v1/targets/1/checks", `{"kind":"path"}`, headers); w.Code != 403 {
			t.Fatal("CSRF accepted", w.Code)
		}
	}
	if calls.Load() != 0 {
		t.Fatal("unauthorized request reached upstream")
	}
	if w := call(admin, "GET", "/wayline/api/v1/targets", "", map[string]string{"Authorization": "Bearer browser-secret"}); w.Code != 401 {
		t.Fatal("Authorization browser boundary", w.Code)
	}
	headers := map[string]string{"Cookie": "portal_session=" + admin.cookie.Value + "; extra=browser-secret", "X-Forwarded-For": "evil", "X-Forwarded-Host": "evil", "Forwarded": "for=evil", "Proxy-Authorization": "browser-secret", "X-Portal-User": "administrator"}
	for _, tc := range [][3]string{{"GET", "/wayline/", ""}, {"GET", "/wayline/assets/app.js", ""}, {"GET", "/wayline/api/v1/checks/latest?kind=path", ""}, {"POST", "/wayline/api/v1/targets/1/checks", `{"kind":"path","direction":"upload"}`}} {
		w := call(admin, tc[0], tc[1], tc[2], headers)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		for _, key := range []string{"Set-Cookie", "WWW-Authenticate", "Access-Control-Allow-Origin"} {
			if w.Header().Get(key) != "" {
				t.Error("unsafe response header", key)
			}
		}
		if w.Header().Get("Cache-Control") != "no-store" {
			t.Error("session content may be cached")
		}
	}
	for _, path := range []string{"/wayline/metrics", "/wayline/%2e%2e/metrics", "/wayline/assets/%2fmetrics", "/wayline/api/v1/targets?token=secret"} {
		before := calls.Load()
		if w := call(admin, "GET", path, "", nil); w.Code != 404 {
			t.Fatal("bypass accepted", path, w.Code)
		}
		if calls.Load() != before {
			t.Fatal("rejected path forwarded")
		}
	}
	mode.Store(1)
	if w := call(admin, "GET", "/wayline/", "", nil); w.Code != 502 || strings.Contains(w.Body.String(), "evil") || w.Header().Get("Location") != "" {
		t.Fatal("upstream redirect exposed", w.Code)
	}
	mode.Store(0)
	if w := call(admin, "POST", "/wayline/api/v1/targets", strings.Repeat("x", (1<<20)+1), nil); w.Code != 413 {
		t.Fatal("body not bounded", w.Code)
	}
	// Every new request rereads enabled state instead of retaining stale source config.
	source, err = store.Get[model.Integration](context.Background(), s.Store, "integration", source.ID)
	if err != nil {
		t.Fatal(err)
	}
	source.Enabled = false
	if _, err = s.Store.Save(context.Background(), "integration", source.ID, source.Revision, source, "test"); err != nil {
		t.Fatal(err)
	}
	before := calls.Load()
	if w := call(admin, "GET", "/wayline/", "", nil); w.Code != 503 {
		t.Fatal("disabled source forwarded", w.Code)
	}
	if calls.Load() != before {
		t.Fatal("disabled source called")
	}
	source, err = store.Get[model.Integration](context.Background(), s.Store, "integration", source.ID)
	if err != nil {
		t.Fatal(err)
	}
	source.Enabled = true
	if _, err = s.Store.Save(context.Background(), "integration", source.ID, source.Revision, source, "test"); err != nil {
		t.Fatal(err)
	}
	// Four active synchronous checks have no extra queued 220-second requests.
	mode.Store(2)
	results := make(chan *httptest.ResponseRecorder, 4)
	for n := 0; n < 4; n++ {
		go func() { results <- call(admin, "POST", "/wayline/api/v1/targets/1/checks", `{"kind":"path"}`, nil) }()
	}
	for n := 0; n < 4; n++ {
		select {
		case <-started:
		case <-time.After(5 * time.Second):
			t.Fatal("source did not start")
		}
	}
	if w := call(admin, "GET", "/wayline/api/v1/targets", "", nil); w.Code != 503 || !strings.Contains(w.Body.String(), "wayline_busy") {
		t.Fatal("concurrency unbounded", w.Code)
	}
	if _, err = s.Store.Pool.Exec(context.Background(), "DELETE FROM sessions WHERE token_hash=$1", hash(admin.cookie.Value)); err != nil {
		t.Fatal(err)
	}
	close(release)
	for n := 0; n < 4; n++ {
		select {
		case w := <-results:
			if w.Code != 401 {
				t.Fatal("revoked session received response", w.Code)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("request did not finish")
		}
	}
	mode.Store(0)
	if w := call(admin, "GET", "/wayline/api/v1/targets", "", nil); w.Code != 401 {
		t.Fatal("logout not honored", w.Code)
	}
	expired := apiUser(t, s, "expired", true)
	if _, err = s.Store.Pool.Exec(context.Background(), "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1", hash(expired.cookie.Value)); err != nil {
		t.Fatal(err)
	}
	if w := call(expired, "GET", "/wayline/api/v1/targets", "", nil); w.Code != 401 {
		t.Fatal("expiry not honored", w.Code)
	}
}

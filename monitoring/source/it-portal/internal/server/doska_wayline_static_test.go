package server

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/netguard"
	"pl/portal/internal/organization"
	"pl/portal/internal/providers"
)

func TestDoskaStaticFanoutPreservesNormalQueue(t *testing.T) {
	s := apiFixture(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	guid := make([]byte, 16)
	guid[15] = 8
	sub, err := organization.ADSubject("dc=doska-static-fixture,dc=test", guid)
	if err != nil {
		t.Fatal(err)
	}
	_, err = organization.NewStore(s.Store.Pool).SaveEmployee(ctx, organization.EmployeeRecord{
		Identity: organization.Identity{Subject: sub, Name: "Static fixture", AccountState: organization.Active, LastSuccessAt: now},
		Provider: "ad", ProviderNamespace: strings.Split(sub, ":")[1], ObjectGUID: guid,
	}, 0, "test-sync", now)
	if err != nil {
		t.Fatal(err)
	}
	user := apiUser(t, s, sub, false)
	entered := make(chan string, 12)
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		entered <- r.URL.Path
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"ok":true}`)
		} else {
			w.Header().Set("Content-Type", "application/javascript")
			_, _ = io.WriteString(w, "fixture asset")
		}
	}))
	defer upstream.Close()
	defer close(release)
	g, err := s.newDoskaGateway(DoskaGatewayConfig{APIUpstream: upstream.URL, WebUpstream: upstream.URL, Key: []byte("0123456789abcdef0123456789abcdef"), Manifest: doskaGatewayTestManifest(), Transport: http.DefaultTransport})
	if err != nil {
		t.Fatal(err)
	}
	request := func(who apiIdentity, path string, requestCtx context.Context) int {
		r := httptest.NewRequest("GET", s.Config.PublicURL+path, nil).WithContext(requestCtx)
		if who.cookie != nil {
			r.AddCookie(who.cookie)
		}
		w := httptest.NewRecorder()
		g.ServeHTTP(w, r)
		return w.Code
	}
	done := make(chan int, 12)
	for i := 0; i < 8; i++ {
		go func() { done <- request(user, "/doska/assets/test-123456.js", ctx) }()
	}
	awaitStaticGatewayRequests(t, entered, done, 8)
	for i := 0; i < 4; i++ {
		go func() { done <- request(user, "/doska/api/doska/context", ctx) }()
	}
	awaitStaticGatewayRequests(t, entered, done, 4)
	if cap(g.slots) != 4 || cap(g.pending) != 16 || g.queueTimeout != 5*time.Second {
		t.Fatal("existing normal four-active/sixteen-pending queue contract changed")
	}
	if code := request(apiIdentity{}, "/doska/assets/test-123456.js", ctx); code != 401 {
		t.Fatalf("anonymous static=%d, want401", code)
	}
	for _, path := range []string{"/doska/assets/other.js", "/doska/assets/test-123456.js?token=secret"} {
		if code := request(user, path, ctx); code != 404 {
			t.Fatalf("unlisted static %s=%d, want404", path, code)
		}
	}
	// The fifth normal request still waits instead of bypassing its four active slots.
	wait, cancel := context.WithCancel(ctx)
	defer cancel()
	cancelled := make(chan int, 1)
	go func() { cancelled <- request(user, "/doska/api/doska/context", wait) }()
	doskaWaitPending(t, g, 1)
	select {
	case path := <-entered:
		t.Fatalf("fifth normal request bypassed capacity: %s", path)
	default:
	}
	cancel()
	select {
	case code := <-cancelled:
		if code == 200 {
			t.Fatal("cancelled normal queue waiter succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("normal queue cancellation did not finish")
	}
	if len(g.pending) != 0 || len(g.slots) != 4 {
		t.Fatal("normal queue cancellation leaked capacity")
	}
	for i := 0; i < 12; i++ {
		release <- struct{}{}
	}
	assertStaticGatewaySuccess(t, done, 12)
}

func TestWaylineStaticFanoutPreservesCheckCapacity(t *testing.T) {
	s := apiFixture(t)
	admin := apiUser(t, s, "wayline-static-admin", true)
	viewer := apiUser(t, s, "wayline-static-viewer", false)
	t.Setenv("PORTAL_SECRET_REFS", "env:PORTAL_SECRET_WAYLINE_STATIC_TEST")
	t.Setenv("PORTAL_SECRET_WAYLINE_STATIC_TEST", "fixture-static-source-password")
	entered := make(chan string, 12)
	release := make(chan struct{})
	staticRelease := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		username, password, ok := r.BasicAuth()
		if !ok || username != "fixture-gateway" || password != "fixture-static-source-password" {
			t.Error("missing fixed server-side Basic credentials")
		}
		if r.Header.Get("Cookie") != "" || r.Header.Get("X-CSRF-Token") != "" {
			t.Error("browser credentials leaked to Wayline")
		}
		entered <- r.Method + " " + r.URL.Path
		waitRelease := release
		if strings.HasPrefix(r.URL.Path, "/assets/") {
			waitRelease = staticRelease
		}
		select {
		case <-waitRelease:
		case <-r.Context().Done():
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"ok":true}`)
		} else {
			w.Header().Set("Content-Type", "application/javascript")
			_, _ = io.WriteString(w, "fixture asset")
		}
	}))
	defer upstream.Close()
	defer close(release)
	defer close(staticRelease)
	guard, err := netguard.NewWithDependencies([]string{"10.0.0.0/8"}, []int{80}, "", browseResolver{}, func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(upstream.URL, "http://"))
	})
	if err != nil {
		t.Fatal(err)
	}
	registry := providers.New(guard, "")
	source := model.Integration{ID: "wayline-static-fixed", Kind: "wayline", Enabled: true, URL: "http://source", SecretRef: "env:PORTAL_SECRET_WAYLINE_STATIC_TEST", Config: map[string]string{"basic_username": "fixture-gateway"}}
	if _, err = s.Store.Save(context.Background(), "integration", source.ID, 0, source, "test"); err != nil {
		t.Fatal(err)
	}
	h := s.WaylineProxy(source.ID, registry.WaylineProxyTransport)
	request := func(who apiIdentity, method, path, body string) int {
		r := httptest.NewRequest(method, s.Config.PublicURL+path, strings.NewReader(body))
		if who.cookie != nil {
			r.AddCookie(who.cookie)
		}
		r.Header.Set("Origin", s.Config.PublicURL)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-CSRF-Token", who.csrf)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	done := make(chan int, 13)
	for i := 0; i < 8; i++ {
		method := "GET"
		if i%2 == 1 {
			method = "HEAD"
		}
		go func() { done <- request(admin, method, "/wayline/assets/app.js", "") }()
	}
	awaitStaticGatewayRequests(t, entered, done, 8)
	for i := 0; i < 4; i++ {
		go func() { done <- request(admin, "POST", "/wayline/api/v1/targets/1/checks", `{"kind":"path"}`) }()
	}
	awaitStaticGatewayRequests(t, entered, done, 4)
	if code := request(admin, "POST", "/wayline/api/v1/targets/1/checks", `{"kind":"path"}`); code != 503 {
		t.Fatalf("fifth expensive check=%d, want503", code)
	}
	go func() { done <- request(admin, "GET", "/wayline/api/v1/targets", "") }()
	select {
	case path := <-entered:
		t.Fatalf("queued read bypassed four active checks: %s", path)
	case code := <-done:
		t.Fatalf("queued read rejected before a check finished: %d", code)
	case <-time.After(20 * time.Millisecond):
	}
	release <- struct{}{}
	assertStaticGatewaySuccess(t, done, 1)
	awaitStaticGatewayRequests(t, entered, done, 1)
	for _, tc := range []struct {
		who    apiIdentity
		path   string
		status int
	}{
		{apiIdentity{}, "/wayline/assets/app.js", 401},
		{viewer, "/wayline/assets/app.js", 403},
		{admin, "/wayline/assets/app.js?token=secret", 404},
		{admin, "/wayline/assets/../../metrics", 404},
	} {
		if code := request(tc.who, "GET", tc.path, ""); code != tc.status {
			t.Fatalf("static auth/route %s=%d, want%d", tc.path, code, tc.status)
		}
	}
	for i := 0; i < 8; i++ {
		staticRelease <- struct{}{}
	}
	for i := 0; i < 4; i++ {
		release <- struct{}{}
	}
	assertStaticGatewaySuccess(t, done, 12)
}

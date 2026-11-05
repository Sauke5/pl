package server

import (
	"context"
	"net/http"
	"testing"
	"time"
)

func awaitStaticGatewayRequests(t *testing.T, entered <-chan string, done <-chan int, count int) {
	t.Helper()
	for i := 0; i < count; i++ {
		select {
		case <-entered:
		case code := <-done:
			t.Fatalf("parallel request finished before delayed upstream release: HTTP %d", code)
		case <-time.After(2 * time.Second):
			t.Fatal("parallel request blocked before reaching upstream; check lane and transport capacity")
		}
	}
}

func awaitStaticGatewayPending(t *testing.T, pending chan struct{}) {
	t.Helper()
	deadline := time.After(time.Second)
	for len(pending) != 1 {
		select {
		case <-deadline:
			t.Fatalf("static pending=%d, want 1", len(pending))
		case <-time.After(time.Millisecond):
		}
	}
}

func assertStaticGatewaySuccess(t *testing.T, done <-chan int, count int) {
	t.Helper()
	for i := 0; i < count; i++ {
		select {
		case code := <-done:
			if code != 200 {
				t.Fatalf("parallel request returned HTTP %d", code)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("released parallel request did not finish")
		}
	}
}

func TestFormsStaticFanoutPreservesNormalCapacity(t *testing.T) {
	entered := make(chan string, 12)
	release := make(chan struct{})
	defer close(release)
	staticRelease := make(chan struct{})
	defer close(staticRelease)
	f := newFormsHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		entered <- r.URL.Path
		waitRelease := release
		route, _ := formsMatchRoute(r)
		if route.media != "application/json" {
			waitRelease = staticRelease
		}
		select {
		case <-waitRelease:
		case <-r.Context().Done():
			return
		}
		formsOK(w, r)
	})
	tr := f.g.transport.(*http.Transport)
	done := make(chan int, 13)
	assets := []string{"/forms/app.js", "/forms/theme.js", "/forms/styles.css"}
	for i := 0; i < 8; i++ {
		method, path := "GET", assets[i%len(assets)]
		if i%2 == 1 {
			method = "HEAD"
		}
		go func() { done <- f.call(t, f.employee, method, path, "", nil).Code }()
	}
	awaitStaticGatewayRequests(t, entered, done, 8)
	for i := 0; i < 4; i++ {
		go func() { done <- f.call(t, f.employee, "GET", "/forms/api/v1/context", "", nil).Code }()
	}
	awaitStaticGatewayRequests(t, entered, done, 4)
	if tr.MaxConnsPerHost != 12 {
		t.Fatalf("transport total=%d, want static8+normal4", tr.MaxConnsPerHost)
	}
	go func() { done <- f.call(t, f.employee, "GET", "/forms/api/v1/context", "", nil).Code }()
	awaitStaticGatewayPending(t, f.g.reads.pending)
	select {
	case path := <-entered:
		t.Fatalf("fifth read bypassed normal capacity: %s", path)
	default:
	}
	release <- struct{}{}
	assertStaticGatewaySuccess(t, done, 1)
	awaitStaticGatewayRequests(t, entered, done, 1)
	for _, tc := range []struct {
		who    apiIdentity
		path   string
		status int
	}{
		{apiIdentity{}, "/forms/app.js", 401},
		{f.employee, "/forms/app.js?cache=1", 404},
		{f.employee, "/forms/unknown.js", 404},
	} {
		if w := f.call(t, tc.who, "GET", tc.path, "", nil); w.Code != tc.status {
			t.Fatalf("auth/route before static queue %s: got %d want %d", tc.path, w.Code, tc.status)
		}
	}
	calls := f.calls.Load()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cancelled := make(chan int, 1)
	go func() {
		cancelled <- f.call(t, f.employee, "GET", "/forms/app.js", "", func(r *http.Request) { *r = *r.WithContext(ctx) }).Code
	}()
	awaitStaticGatewayPending(t, f.g.static.pending)
	cancel()
	select {
	case code := <-cancelled:
		if code == 200 {
			t.Fatal("cancelled queued static request succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("static queue ignored cancellation")
	}
	if f.calls.Load() != calls || len(f.g.static.pending) != 0 {
		t.Fatal("cancelled waiter reached upstream or leaked pending capacity")
	}
	// Release every backend request while preserving the deferred cleanup on failure.
	for i := 0; i < 8; i++ {
		staticRelease <- struct{}{}
	}
	for i := 0; i < 4; i++ {
		release <- struct{}{}
	}
	assertStaticGatewaySuccess(t, done, 12)
}

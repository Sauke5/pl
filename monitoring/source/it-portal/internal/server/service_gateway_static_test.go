package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestServiceGatewayStaticClassification(t *testing.T) {
	for _, aud := range []string{"monitoring-admin", "websites-admin"} {
		for _, method := range []string{"GET", "HEAD"} {
			if !gatewayStaticRequest(aud, method, "/static/app.js") {
				t.Fatal(aud, method)
			}
		}
	}
	if !gatewayStaticRequest("auditor", "GET", "/assets/index-abcdef.js") {
		t.Fatal("auditor asset rejected")
	}
	for _, tc := range [][3]string{{"directory", "GET", "/static/app.js"}, {"auditor", "GET", "/static/app.js"}, {"auditor", "GET", "/api/instance"}, {"websites-admin", "POST", "/static/app.js"}, {"unknown", "GET", "/static/app.js"}} {
		if gatewayStaticRequest(tc[0], tc[1], tc[2]) {
			t.Fatal("non-static lane", tc)
		}
	}
}

func waitServicePending(t *testing.T, lane *gatewayCapacity, want int) {
	t.Helper()
	deadline := time.After(time.Second)
	for len(lane.pending) != want {
		select {
		case <-deadline:
			t.Fatalf("pending=%d want=%d", len(lane.pending), want)
		case <-time.After(time.Millisecond):
		}
	}
}

func TestServiceGatewayStaticQueueBoundsAndCancellation(t *testing.T) {
	lane := &gatewayCapacity{slots: make(chan struct{}, 8), pending: make(chan struct{}, 32), queueTimeout: time.Second}
	for i := 0; i < 8; i++ {
		lane.slots <- struct{}{}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	results := make(chan bool, 32)
	for i := 0; i < 32; i++ {
		go func() { results <- lane.acquire(ctx) }()
	}
	waitServicePending(t, lane, 32)
	if lane.acquire(context.Background()) {
		t.Fatal("unbounded queue admission")
	}
	cancel()
	for i := 0; i < 32; i++ {
		select {
		case ok := <-results:
			if ok {
				t.Fatal("cancelled waiter admitted")
			}
		case <-time.After(time.Second):
			t.Fatal("waiter blocked")
		}
	}
	if len(lane.pending) != 0 || len(lane.slots) != 8 {
		t.Fatal("cancellation leaked capacity")
	}
	<-lane.slots
	if lane.acquire(ctx) || len(lane.slots) != 7 {
		t.Fatal("cancelled request consumed a free slot")
	}
	lane.slots <- struct{}{}
	lane.queueTimeout = 10 * time.Millisecond
	if lane.acquire(context.Background()) || len(lane.pending) != 0 || len(lane.slots) != 8 {
		t.Fatal("timeout leaked capacity")
	}
	done := make(chan bool, 1)
	go func() { done <- lane.acquire(context.Background()) }()
	waitServicePending(t, lane, 1)
	<-lane.slots
	if !<-done {
		t.Fatal("queued request did not use released slot")
	}
	if len(lane.pending) != 0 || len(lane.slots) != 8 {
		t.Fatal("queued success capacity mismatch")
	}
}

func TestServiceGatewayStaticFanoutAndOperationIsolation(t *testing.T) {
	for _, aud := range []string{"websites-admin", "monitoring-admin", "auditor"} {
		t.Run(aud, func(t *testing.T) {
			s := apiFixture(t)
			admin := apiUser(t, s, "static-admin", true)
			viewer := apiUser(t, s, "static-viewer", false)
			prefix := gatewayPrefix(aud)
			asset := "/static/app.js"
			normal := "/"
			version := 1
			if aud == "auditor" {
				prefix = "/audit"
				asset = "/assets/index-abcdef.js"
				normal = "/api/instance"
				version = 2
			}
			entered := make(chan string, 16)
			release := make(chan struct{})
			operationRelease := make(chan struct{})
			defer close(operationRelease)
			defer close(release)
			transport := directoryRoundTrip(func(r *http.Request) (*http.Response, error) {
				entered <- r.URL.Path
				block := release
				if r.URL.Path == prefix+normal {
					block = operationRelease
				}
				select {
				case <-block:
				case <-r.Context().Done():
					return nil, r.Context().Err()
				}
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/javascript"}}, Body: io.NopCloser(strings.NewReader("fixture"))}, nil
			})
			handler := s.ServiceGateway(ServiceGatewayConfig{Audience: aud, Prefix: prefix, AssertionVersion: version, Upstream: "http://source" + prefix, Key: []byte("0123456789abcdef0123456789abcdef"), Transport: transport})
			call := func(who apiIdentity, path string) *httptest.ResponseRecorder {
				r := httptest.NewRequest("GET", s.Config.PublicURL+prefix+path, nil)
				if who.cookie != nil {
					r.AddCookie(who.cookie)
				}
				w := httptest.NewRecorder()
				handler.ServeHTTP(w, r)
				return w
			}
			statuses := make(chan int, 13)
			for i := 0; i < 8; i++ {
				go func() { statuses <- call(admin, asset).Code }()
			}
			for i := 0; i < 8; i++ {
				select {
				case <-entered:
				case code := <-statuses:
					t.Fatalf("static fanout rejected: %d", code)
				case <-time.After(2 * time.Second):
					t.Fatal("static fanout blocked")
				}
			}
			if w := call(apiIdentity{}, asset); w.Code != 401 {
				t.Fatalf("anonymous=%d", w.Code)
			}
			if aud != "auditor" {
				if w := call(viewer, asset); w.Code != 403 {
					t.Fatalf("viewer=%d", w.Code)
				}
			}
			if w := call(admin, "/static/../secret"); w.Code != 404 {
				t.Fatalf("invalid route=%d", w.Code)
			}
			for i := 0; i < 4; i++ {
				go func() { statuses <- call(admin, normal).Code }()
			}
			for i := 0; i < 4; i++ {
				select {
				case <-entered:
				case code := <-statuses:
					t.Fatalf("static stole operation capacity: %d", code)
				case <-time.After(2 * time.Second):
					t.Fatal("operation blocked")
				}
			}
			go func() { statuses <- call(admin, normal).Code }()
			select {
			case code := <-statuses:
				t.Fatalf("fifth read did not queue: %d", code)
			case <-entered:
				t.Fatal("fifth read exceeded shared operation limit")
			case <-time.After(20 * time.Millisecond):
			}
			// Queued static requests obey caller cancellation and never reach upstream.
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			r := httptest.NewRequest("GET", s.Config.PublicURL+prefix+asset, nil).WithContext(ctx)
			r.AddCookie(admin.cookie)
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code == 200 {
				t.Fatal("cancelled request accepted")
			}
			// The queued read follows a released operation, retaining four active normal requests.
			operationRelease <- struct{}{}
			select {
			case <-entered:
			case <-time.After(time.Second):
				t.Fatal("queued read did not reach upstream")
			}
			for i := 0; i < 8; i++ {
				release <- struct{}{}
			}
			for i := 0; i < 4; i++ {
				operationRelease <- struct{}{}
			}
			for i := 0; i < 13; i++ {
				select {
				case code := <-statuses:
					if code != 200 {
						t.Fatalf("parallel response=%d", code)
					}
				case <-time.After(2 * time.Second):
					t.Fatal("parallel response blocked")
				}
			}
		})
	}
}

package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"pl/portal/internal/organization"
)

func doskaWaitPending(t *testing.T, g *doskaGateway, want int) {
	t.Helper()
	deadline := time.NewTimer(time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for len(g.pending) != want {
		select {
		case <-deadline.C:
			t.Fatalf("pending=%d want%d", len(g.pending), want)
		case <-tick.C:
		}
	}
}

func TestDoskaGatewayQueueCancellationTimeoutAndCapacity(t *testing.T) {
	newQueue := func(timeout time.Duration) *doskaGateway {
		g := &doskaGateway{slots: make(chan struct{}, 4), pending: make(chan struct{}, 16), queueTimeout: timeout}
		for i := 0; i < 4; i++ {
			g.slots <- struct{}{}
		}
		return g
	}
	t.Run("cancellation", func(t *testing.T) {
		g := newQueue(time.Second)
		ctx, cancel := context.WithCancel(context.Background())
		result := make(chan bool, 1)
		var upstreamCalls atomic.Int32
		go func() {
			ok := g.acquireSlot(ctx)
			if ok {
				upstreamCalls.Add(1)
				<-g.slots
			}
			result <- ok
		}()
		doskaWaitPending(t, g, 1)
		cancel()
		select {
		case ok := <-result:
			if ok {
				t.Fatal("cancelled request admitted")
			}
		case <-time.After(time.Second):
			t.Fatal("cancelled queue waiter remained blocked")
		}
		if len(g.pending) != 0 || len(g.slots) != 4 || upstreamCalls.Load() != 0 {
			t.Fatal("cancelled request leaked slot or reached upstream")
		}
		// Even a free active slot cannot admit an already cancelled request.
		<-g.slots
		if g.acquireSlot(ctx) || len(g.slots) != 3 {
			t.Fatal("already cancelled request admitted")
		}
	})
	t.Run("timeout", func(t *testing.T) {
		g := newQueue(20 * time.Millisecond)
		result := make(chan bool, 1)
		go func() { result <- g.acquireSlot(context.Background()) }()
		select {
		case ok := <-result:
			if ok {
				t.Fatal("timed out request admitted")
			}
		case <-time.After(time.Second):
			t.Fatal("queue timeout did not terminate waiter")
		}
		if len(g.pending) != 0 || len(g.slots) != 4 {
			t.Fatal("timeout leaked a pending or active slot")
		}
	})
	t.Run("pending-capacity", func(t *testing.T) {
		g := newQueue(time.Second)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		results := make(chan bool, 16)
		for i := 0; i < 16; i++ {
			go func() { results <- g.acquireSlot(ctx) }()
		}
		doskaWaitPending(t, g, 16)
		overflow := make(chan bool, 1)
		go func() { overflow <- g.acquireSlot(context.Background()) }()
		select {
		case ok := <-overflow:
			if ok {
				t.Fatal("overflow admitted")
			}
		case <-time.After(100 * time.Millisecond):
			t.Fatal("overflow added an unbounded waiter")
		}
		cancel()
		for i := 0; i < 16; i++ {
			select {
			case ok := <-results:
				if ok {
					t.Fatal("cancelled waiter admitted")
				}
			case <-time.After(time.Second):
				t.Fatal("pending cancellation blocked")
			}
		}
		if len(g.pending) != 0 || len(g.slots) != 4 {
			t.Fatal("pending capacity cleanup failed")
		}
	})
}

func TestDoskaGatewayFiveRequestFanoutPostgreSQL(t *testing.T) {
	s := apiFixture(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	guid := make([]byte, 16)
	guid[15] = 7
	sub, _ := organization.ADSubject("dc=doska-queue-fixture,dc=test", guid)
	_, err := organization.NewStore(s.Store.Pool).SaveEmployee(ctx, organization.EmployeeRecord{
		Identity: organization.Identity{Subject: sub, Name: "Queue fixture", AccountState: organization.Active, LastSuccessAt: now},
		Provider: "ad", ProviderNamespace: strings.Split(sub, ":")[1], ObjectGUID: guid,
	}, 0, "test-sync", now)
	if err != nil {
		t.Fatal(err)
	}
	user := apiUser(t, s, sub, false)
	entered := make(chan struct{}, 5)
	release := make(chan struct{}, 5)
	var active, maximum, calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := active.Add(1)
		defer active.Add(-1)
		calls.Add(1)
		for old := maximum.Load(); n > old; old = maximum.Load() {
			if maximum.CompareAndSwap(old, n) {
				break
			}
		}
		entered <- struct{}{}
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer upstream.Close()
	// Release private delayed requests even when an assertion aborts the test.
	defer func() {
		for i := 0; i < 5; i++ {
			select {
			case release <- struct{}{}:
			default:
			}
		}
	}()
	g, err := s.newDoskaGateway(DoskaGatewayConfig{APIUpstream: upstream.URL, WebUpstream: upstream.URL, Key: []byte("0123456789abcdef0123456789abcdef"), Manifest: doskaGatewayTestManifest(), Transport: http.DefaultTransport})
	if err != nil {
		t.Fatal(err)
	}
	if cap(g.slots) != 4 || cap(g.pending) != 16 || g.queueTimeout != 5*time.Second {
		t.Fatal("production admission bounds changed")
	}
	statuses := make(chan int, 5)
	request := func() {
		r := httptest.NewRequest("GET", s.Config.PublicURL+"/doska/api/doska/context", nil)
		r.AddCookie(user.cookie)
		w := httptest.NewRecorder()
		g.ServeHTTP(w, r)
		statuses <- w.Code
	}
	for i := 0; i < 4; i++ {
		go request()
	}
	for i := 0; i < 4; i++ {
		select {
		case <-entered:
		case <-time.After(time.Second):
			t.Fatal("first four requests did not reach upstream")
		}
	}
	go request()
	doskaWaitPending(t, g, 1)
	if calls.Load() != 4 || active.Load() != 4 {
		t.Fatal("fifth request bypassed active bound")
	}
	release <- struct{}{}
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("fifth request did not follow a released slot")
	}
	for i := 0; i < 4; i++ {
		release <- struct{}{}
	}
	for i := 0; i < 5; i++ {
		select {
		case status := <-statuses:
			if status != 200 {
				t.Fatalf("fanout request failed with HTTP%d", status)
			}
		case <-time.After(time.Second):
			t.Fatal("fanout request did not complete")
		}
	}
	if calls.Load() != 5 || maximum.Load() != 4 || len(g.pending) != 0 || len(g.slots) != 0 {
		t.Fatalf("calls=%d maxactive=%d pending=%d slots=%d", calls.Load(), maximum.Load(), len(g.pending), len(g.slots))
	}
}

//go:build optional_module_acceptance

package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"testing"
	"time"
)

// Finite opt-in real Gateway -> owner-started disposable Doska -> PostgreSQL.
// Uses the same test-only subject/key fixture as attachment external acceptance.
// No real AD login, production cookies, credentials or production writes.
func TestDoskaEventsGatewayExternal(t *testing.T) {
	if os.Getenv("DOSKA_EVENTS_TEST_ENABLE") != "1" {
		t.Fatal("DOSKA_EVENTS_TEST_ENABLE=1 and owner-started disposable Doska fixture required")
	}
	origin := func(raw string) *url.URL {
		t.Helper()
		u, err := url.Parse(raw)
		if err != nil || u.Scheme != "http" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Port() == "" || !net.ParseIP(u.Hostname()).IsLoopback() {
			t.Fatal("explicit loopback HTTP fixture origin required")
		}
		return u
	}
	api := origin(os.Getenv("DOSKA_TEST_API_URL"))
	public := origin(os.Getenv("DOSKA_TEST_PUBLIC_URL"))
	dsn, err := url.Parse(os.Getenv("PORTAL_TEST_DATABASE_URL"))
	if err != nil || (dsn.Scheme != "postgres" && dsn.Scheme != "postgresql") || !net.ParseIP(dsn.Hostname()).IsLoopback() || dsn.Path == "" {
		t.Fatal("separate disposable loopback Platform PostgreSQL required")
	}
	key, err := doskaReadFile(os.Getenv("DOSKA_TEST_KEY_FILE"), 32)
	if err != nil || len(key) != 32 {
		t.Fatal("test-only raw32 key file required")
	}
	s := apiFixture(t)
	s.Config.PublicURL = public.String()
	user, _ := attachmentIdentity(t, s)
	g, err := s.newDoskaGateway(DoskaGatewayConfig{APIUpstream: api.String(), WebUpstream: api.String(), Key: key, Manifest: eventsManifest(), Events: true, Transport: &http.Transport{Proxy: nil, DisableCompression: true, ResponseHeaderTimeout: 5 * time.Second}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { g.Close() })
	s.doskaHandler = g
	listener, err := net.Listen("tcp", public.Host)
	if err != nil {
		t.Fatal(err)
	}
	gateway := httptest.NewUnstartedServer(s.Handler())
	gateway.Listener.Close()
	gateway.Listener = listener
	gateway.Start()
	t.Cleanup(gateway.Close)

	controlClient := &http.Client{Timeout: 5 * time.Second}
	control := func(path string) []byte {
		t.Helper()
		response, err := controlClient.Post(api.String()+"/__fixture/"+path, "application/json", nil)
		if err != nil {
			t.Fatal(path, err)
		}
		defer response.Body.Close()
		body, err := io.ReadAll(io.LimitReader(response.Body, 8192))
		if err != nil || response.StatusCode != 200 {
			t.Fatalf("control %s status%d %v", path, response.StatusCode, err)
		}
		return body
	}
	t.Cleanup(func() { control("restore-access"); control("restore-identity"); control("listener-start") })
	control("restore-access")
	control("restore-identity")
	type event struct {
		kind  string
		frame []byte
		err   error
	}
	type stream struct {
		response *http.Response
		events   chan event
		cancel   context.CancelFunc
	}
	open := func() stream {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		request, err := http.NewRequestWithContext(ctx, "GET", public.String()+doskaEventsPath, nil)
		if err != nil {
			t.Fatal(err)
		}
		request.AddCookie(user.cookie)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		if response.StatusCode != 200 {
			body, _ := io.ReadAll(io.LimitReader(response.Body, 1024))
			response.Body.Close()
			cancel()
			t.Fatalf("actual backend events status%d %s", response.StatusCode, body)
		}
		ch := make(chan event, 16)
		go func() {
			defer close(ch)
			reader := bufio.NewReader(response.Body)
			for {
				frame, err := doskaReadEvent(reader)
				kind, valid := doskaValidEvent(frame)
				if err == nil && !valid {
					err = fmt.Errorf("invalid backend frame")
				}
				select {
				case ch <- event{kind, frame, err}:
				case <-ctx.Done():
					return
				}
				if err != nil {
					return
				}
			}
		}()
		st := stream{response, ch, cancel}
		t.Cleanup(func() { cancel(); response.Body.Close() })
		select {
		case e := <-ch:
			if e.err != nil || e.kind != "ready" {
				t.Fatalf("actual ready %q %v", e.frame, e.err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("backend ready timeout")
		}
		return st
	}
	expect := func(st stream, kind string, timeout time.Duration) event {
		t.Helper()
		timer := time.NewTimer(timeout)
		defer timer.Stop()
		for {
			select {
			case e, ok := <-st.events:
				if !ok || e.err != nil {
					t.Fatalf("expected%s gotclose %v", kind, e.err)
				}
				if e.kind == "heartbeat" {
					continue
				}
				if e.kind != kind {
					t.Fatalf("expected%s got%s %s", kind, e.kind, e.frame)
				}
				return e
			case <-timer.C:
				t.Fatal("event timeout", kind)
			}
		}
	}
	closed := func(st stream) {
		t.Helper()
		start := time.Now()
		select {
		case e, ok := <-st.events:
			if ok && e.err == nil {
				t.Fatalf("expectedclose got%s", e.frame)
			}
		case <-time.After(5200 * time.Millisecond):
			t.Fatal("backend stream survived5s lease")
		}
		t.Logf("streamclosed in%s", time.Since(start))
		st.cancel()
		st.response.Body.Close()
	}
	st := open()
	t.Log("actual ready PASS")
	created := control("create-event")
	var createdEvent struct {
		ProjectID string `json:"projectId"`
		TaskID    string `json:"taskId"`
	}
	if err = json.Unmarshal(created, &createdEvent); err != nil {
		t.Fatal(err)
	}
	changed := expect(st, "changed", 5*time.Second)
	if !bytes.Contains(changed.frame, []byte(createdEvent.ProjectID)) {
		t.Fatal("changed wrongproject")
	}
	t.Log("actual commit changed PASS")
	hidden := control("private-event")
	var privateEvent struct {
		ProjectID string `json:"projectId"`
	}
	json.Unmarshal(hidden, &privateEvent)
	select {
	case e := <-st.events:
		t.Fatalf("hiddenproject created observable frame %q %v", e.frame, e.err)
	case <-time.After(800 * time.Millisecond):
	}
	t.Log("hiddenproject silence PASS")
	control("revoke-access")
	reset := expect(st, "reset", 5200*time.Millisecond)
	if bytes.Contains(reset.frame, []byte(createdEvent.ProjectID)) || bytes.Contains(reset.frame, []byte(privateEvent.ProjectID)) || bytes.Contains(reset.frame, []byte("projectId")) {
		t.Fatal("revoked reset leakedIDs")
	}
	t.Log("revoke resetwithoutIDs PASS")
	st.cancel()
	st.response.Body.Close()
	control("restore-access")
	st = open()
	control("block-identity")
	closed(st)
	control("restore-identity")
	t.Log("blockidentity idletermination PASS")
	st = open()
	control("listener-stop")
	closed(st)
	control("listener-start")
	// Wait for a confirmed new listener generation before reconnecting.
	for deadline := time.Now().Add(5 * time.Second); ; {
		response, e := controlClient.Get(api.String() + "/__fixture/state")
		if e != nil {
			t.Fatal(e)
		}
		var state struct {
			Listener struct {
				Ready      bool `json:"ready"`
				Generation int  `json:"generation"`
			} `json:"listener"`
		}
		e = json.NewDecoder(response.Body).Decode(&state)
		response.Body.Close()
		if e != nil {
			t.Fatal(e)
		}
		if state.Listener.Ready {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("listenerrestarttimeout")
		}
		time.Sleep(25 * time.Millisecond)
	}
	st = open()
	t.Log("listenerrestart ready PASS")
	if _, err = s.Store.Pool.Exec(context.Background(), "DELETE FROM sessions WHERE token_hash=$1", hash(user.cookie.Value)); err != nil {
		t.Fatal(err)
	}
	closed(st)
	retry, _ := http.NewRequest("GET", public.String()+doskaEventsPath, nil)
	retry.AddCookie(user.cookie)
	response, err := controlClient.Do(retry)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 401 {
		t.Fatalf("revokedreconnect status%d", response.StatusCode)
	}
	t.Log("Platformlogout/reconnect401 PASS")
}

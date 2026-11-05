package server

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func eventsManifest() DoskaGatewayManifest {
	m := doskaGatewayTestManifest()
	m.Routes = append(m.Routes, DoskaGatewayRoute{Method: "GET", Path: doskaEventsPath, Kind: "events", Schema: "events-v1"})
	return m
}
func TestDoskaEventsWire(t *testing.T) {
	for _, payload := range []string{`event: ready|{"version":1}`, `event: reset|{"version":1,"reason":"resync"}`, `event: changed|{"version":1,"projectId":"p","taskIds":[],"scopes":["tasks","labels"]}`, `event: personal|{"version":1,"scopes":["notifications"]}`} {
		frame := []byte(strings.Replace(payload, "|", "\ndata: ", 1) + "\n\n")
		if _, ok := doskaValidEvent(frame); !ok {
			t.Fatal(payload)
		}
	}
	for _, payload := range []string{`ready|{"version":1}`, `event: ready|{"version":1,"x":1}`, `event: ready|{"Version":1}`, `event: ready|{"version":1,"Version":1}`, `event: changed|{"version":1,"PROJECTID":"p","scopes":["tasks"]}`, `event: ready|{"version":1,"version":1}`, `event: reset|{"reason":"resync"}`, `event: personal|{"version":1,"scopes":["tasks"]}`, `event: changed|{"version":1,"projectId":"p","taskIds":null,"scopes":["tasks"]}`, `event: changed|{"version":1,"projectId":"p","taskIds":["x","x"],"scopes":["tasks"]}`, `event: changed|{"version":1,"projectId":"p","scopes":[]}`, `event: personal|{"version":1,"scopes":["notifications"],"projectId":"p"}`, `id: 1|{"version":1}`} {
		frame := []byte(strings.Replace(payload, "|", "\ndata: ", 1) + "\n\n")
		if _, ok := doskaValidEvent(frame); ok {
			t.Fatal(payload)
		}
	}
	for _, n := range []int{4095, 4096, 4097} {
		input := strings.Repeat("a", n-2) + "\n\n"
		frame, err := doskaReadEvent(bufio.NewReaderSize(strings.NewReader(input), 16))
		if (err == nil) != (n <= 4096) || err == nil && len(frame) != n {
			t.Fatalf("bound %d %v", n, err)
		}
	}
	for _, input := range [][]byte{[]byte("event: ready\ndata: \xff\n\n"), []byte("truncated")} {
		if _, err := doskaReadEvent(bufio.NewReader(bytes.NewReader(input))); err == nil {
			t.Fatal("invalid accepted")
		}
	}
}
func TestDoskaEventsManifestAndAdmission(t *testing.T) {
	for _, route := range []DoskaGatewayRoute{{Method: "HEAD", Path: doskaEventsPath, Kind: "events", Schema: "events-v1"}, {Method: "GET", Path: doskaEventsPath, Kind: "read"}, {Method: "GET", Path: "/doska/api/doska/other", Kind: "events", Schema: "events-v1"}, {Method: "GET", Path: doskaEventsPath, Kind: "events", Schema: "events-v1", Query: map[string]DoskaGatewayQuery{"q": {Kind: "text"}}}} {
		if _, err := compileDoskaManifest(DoskaGatewayManifest{Version: "events", Routes: []DoskaGatewayRoute{route}}); err == nil {
			t.Fatal(route)
		}
	}
	a := doskaEventAdmission{}
	for i := 0; i < 32; i++ {
		if !a.acquire(fmt.Sprint(i / 4)) {
			t.Fatal(i)
		}
	}
	if a.acquire("new") || a.acquire("0") {
		t.Fatal("limit")
	}
	a.release("0")
	if !a.acquire("0") {
		t.Fatal("release")
	}
}
func eventFixture(t *testing.T, upstream http.Handler) (*Server, *doskaGateway, apiIdentity, *httptest.Server) {
	t.Helper()
	s := apiFixture(t)
	user, _ := attachmentIdentity(t, s)
	source := httptest.NewServer(upstream)
	t.Cleanup(source.Close)
	g, err := s.newDoskaGateway(DoskaGatewayConfig{APIUpstream: source.URL, WebUpstream: source.URL, Key: attachmentTestKey, Manifest: eventsManifest(), Events: true, Transport: http.DefaultTransport})
	if err != nil {
		t.Fatal(err)
	}
	s.doskaHandler = g
	server := httptest.NewServer(s.Handler())
	t.Cleanup(server.Close)
	return s, g, user, server
}
func readyUpstream(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	fmt.Fprint(w, "event: ready\ndata: {\"version\":1}\n\n")
	w.(http.Flusher).Flush()
	<-r.Context().Done()
}
func TestDoskaEventsHTTPRevocation(t *testing.T) {
	for _, mode := range []string{"logout", "rotation", "expiry", "stale", "blocked", "hung"} {
		t.Run(mode, func(t *testing.T) {
			s, g, user, server := eventFixture(t, http.HandlerFunc(readyUpstream))
			request := attachmentRequest(t, server, s, user, "GET", doskaEventsPath, nil)
			response, err := http.DefaultClient.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			reader := bufio.NewReader(response.Body)
			if frame, err := doskaReadEvent(reader); err != nil || !bytes.Contains(frame, []byte("ready")) {
				t.Fatalf("ready %q %v", frame, err)
			}
			start := time.Now()
			var release func()
			switch mode {
			case "logout":
				_, err = s.Store.Pool.Exec(context.Background(), "DELETE FROM sessions WHERE token_hash=$1", hash(user.cookie.Value))
			case "rotation":
				_, err = s.Store.Pool.Exec(context.Background(), "UPDATE sessions SET csrf='rotated' WHERE token_hash=$1", hash(user.cookie.Value))
			case "expiry":
				_, err = s.Store.Pool.Exec(context.Background(), "UPDATE sessions SET expires_at=now() WHERE token_hash=$1", hash(user.cookie.Value))
			case "stale":
				_, err = s.Store.Pool.Exec(context.Background(), "UPDATE org_employees SET body=jsonb_set(body, '{last_success_at}', to_jsonb('2000-01-01T00:00:00Z'::text))")
			case "blocked":
				_, err = s.Store.Pool.Exec(context.Background(), "UPDATE org_employees SET body=jsonb_set(body, '{account_state}', to_jsonb('disabled'::text))")
			case "hung":
				tx, e := s.Store.Pool.Begin(context.Background())
				if e != nil {
					t.Fatal(e)
				}
				_, err = tx.Exec(context.Background(), "LOCK TABLE sessions IN ACCESS EXCLUSIVE MODE")
				release = func() { tx.Rollback(context.Background()) }
				defer release()
			}
			if err != nil {
				t.Fatal(err)
			}
			end := make(chan error, 1)
			go func() { _, err := reader.ReadByte(); end <- err }()
			select {
			case err := <-end:
				if err == nil {
					t.Fatal("stream remains")
				}
			case <-time.After(5200 * time.Millisecond):
				t.Fatal("lease exceeded 5s")
			}
			if elapsed := time.Since(start); elapsed > 5200*time.Millisecond {
				t.Fatal(elapsed)
			}
			deadline := time.Now().Add(time.Second)
			for {
				g.events.mu.Lock()
				n := g.events.total
				g.events.mu.Unlock()
				if n == 0 {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("slot leaked")
				}
				time.Sleep(time.Millisecond)
			}
		})
	}
}
func TestDoskaEventsHTTPIsolationAndHeaders(t *testing.T) {
	s, g, user, server := eventFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/doska/events" {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"ok":true}`)
			return
		}
		if r.Header.Get("Cookie") != "" || r.Header.Get("Last-Event-ID") != "" || r.Header.Get(gatewayAssertionHeader) == "" {
			t.Error("forwarded secrets or missing signature")
		}
		raw, err := base64.RawURLEncoding.DecodeString(r.Header.Get(gatewayAssertionHeader))
		var claims gatewayIdentity
		if err != nil || json.Unmarshal(raw, &claims) != nil || claims.Version != 2 || claims.Audience != "doska" || len(claims.Scopes) != 1 || claims.Scopes[0] != "doska:read" || claims.URI != doskaEventsPath {
			t.Error("events assertion contract")
		}
		if r.Host != "portal.example.test" || r.Header.Get("X-Forwarded-Prefix") != "/doska" || r.Header.Get("X-Forwarded-Host") != "portal.example.test" {
			t.Error("forwarded metadata")
		}
		readyUpstream(w, r)
	}))
	streams := []*http.Response{}
	defer func() {
		for _, r := range streams {
			r.Body.Close()
		}
	}()
	for i := 0; i < 4; i++ {
		resp, e := http.DefaultClient.Do(attachmentRequest(t, server, s, user, "GET", doskaEventsPath, nil))
		if e != nil || resp.StatusCode != 200 {
			t.Fatalf("stream %v", e)
		}
		streams = append(streams, resp)
	}
	originalSession, err := s.readSession(attachmentRequest(t, server, s, user, "GET", doskaEventsPath, nil))
	if err != nil {
		t.Fatal(err)
	}
	otherSession := apiUser(t, s, originalSession.User.ID, false)
	resp, e := http.DefaultClient.Do(attachmentRequest(t, server, s, otherSession, "GET", doskaEventsPath, nil))
	if e != nil || resp.StatusCode != 503 {
		t.Fatalf("limit %v", e)
	}
	resp.Body.Close()
	resp, e = http.DefaultClient.Do(attachmentRequest(t, server, s, user, "GET", "/doska/api/doska/context", nil))
	if e != nil || resp.StatusCode != 200 {
		t.Fatalf("JSON blocked %v", e)
	}
	resp.Body.Close()
	if len(g.slots) != 0 {
		t.Fatal("events consumed JSON slots")
	}
	for _, header := range []string{"Last-Event-ID", "Upgrade"} {
		req := attachmentRequest(t, server, s, user, "GET", doskaEventsPath, nil)
		req.Header.Set(header, "x")
		resp, e = http.DefaultClient.Do(req)
		if e != nil || resp.StatusCode == 200 {
			t.Fatal(header, e)
		}
		resp.Body.Close()
	}
}
func TestDoskaEventsHTTPRejectsUpstream(t *testing.T) {
	for _, mode := range []string{"redirect", "json", "encoding", "duplicate", "badframe"} {
		t.Run(mode, func(t *testing.T) {
			s, _, user, server := eventFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				switch mode {
				case "redirect":
					w.Header().Set("Location", "/elsewhere")
					w.WriteHeader(302)
				case "json":
					w.Header().Set("Content-Type", "application/json")
				case "encoding":
					w.Header().Set("Content-Encoding", "gzip")
				case "duplicate":
					w.Header().Add("Content-Type", "text/event-stream")
				case "badframe":
					fmt.Fprint(w, "event: changed\ndata: {}\n\n")
				}
			}))
			resp, err := http.DefaultClient.Do(attachmentRequest(t, server, s, user, "GET", doskaEventsPath, nil))
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			data, _ := io.ReadAll(resp.Body)
			if bytes.Contains(data, []byte("event:")) {
				t.Fatalf("bad upstream forwarded: %q", data)
			}
		})
	}
}

func TestDoskaEventsHTTPSlowClientLeaseAndClose(t *testing.T) {
	for _, mode := range []string{"hung", "close"} {
		t.Run(mode, func(t *testing.T) {
			active := make(chan struct{})
			s, g, user, server := eventFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, "event: ready\ndata: {\"version\":1}\n\n")
				w.(http.Flusher).Flush()
				close(active)
				ids := make([]string, 30)
				for i := range ids {
					ids[i] = fmt.Sprintf("%03d", i) + strings.Repeat("x", 120)
				}
				frame := fmt.Sprintf("event: changed\ndata: {\"version\":1,\"projectId\":\"p\",\"taskIds\":[\"%s\"],\"scopes\":[\"tasks\"]}\n\n", strings.Join(ids, "\",\""))
				if len(frame) > 4096 {
					t.Error("fixture oversized")
					return
				}
				for {
					select {
					case <-r.Context().Done():
						return
					default:
					}
					if _, err := io.WriteString(w, frame); err != nil {
						return
					}
					w.(http.Flusher).Flush()
				}
			}))
			address, _ := url.Parse(server.URL)
			conn, err := net.Dial("tcp", address.Host)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			conn.(*net.TCPConn).SetReadBuffer(1024)
			fmt.Fprintf(conn, "GET %s HTTP/1.1\r\nHost: %s\r\nCookie: %s=%s\r\n\r\n", doskaEventsPath, address.Host, user.cookie.Name, user.cookie.Value)
			select {
			case <-active:
			case <-time.After(time.Second):
				t.Fatal("upstream not active")
			}
			time.Sleep(100 * time.Millisecond)
			start := time.Now()
			if mode == "hung" {
				tx, e := s.Store.Pool.Begin(context.Background())
				if e != nil {
					t.Fatal(e)
				}
				defer tx.Rollback(context.Background())
				if _, e = tx.Exec(context.Background(), "LOCK TABLE sessions IN ACCESS EXCLUSIVE MODE"); e != nil {
					t.Fatal(e)
				}
			} else {
				g.Close()
			}
			for {
				g.events.mu.Lock()
				n := g.events.total
				g.events.mu.Unlock()
				if n == 0 {
					break
				}
				if time.Since(start) > 5200*time.Millisecond {
					t.Fatal("slow client retained admission beyond lease")
				}
				time.Sleep(10 * time.Millisecond)
			}
		})
	}
}
func TestDoskaEventsHTTPDisconnectAndReconnect(t *testing.T) {
	var calls atomic.Int32
	s, g, user, server := eventFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "event: ready\ndata: {\"version\":1}\n\n")
	}))
	for i := 0; i < 2; i++ {
		resp, err := http.DefaultClient.Do(attachmentRequest(t, server, s, user, "GET", doskaEventsPath, nil))
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) || string(data) != "event: ready\ndata: {\"version\":1}\n\n" {
			t.Fatalf("reconnect %q %v", data, err)
		}
	}
	if calls.Load() != 2 {
		t.Fatalf("implicit upstream replay: %d", calls.Load())
	}
	_ = g
}

func TestDoskaEventsHTTPGlobalAdmission(t *testing.T) {
	s, g, user, server := eventFixture(t, http.HandlerFunc(readyUpstream))
	streams := []*http.Response{}
	defer func() {
		for _, response := range streams {
			response.Body.Close()
		}
	}()
	for subject := 0; subject < 8; subject++ {
		if subject > 0 {
			user, _ = attachmentIdentityGUID(t, s, byte(subject+1))
		}
		for tab := 0; tab < 4; tab++ {
			response, err := http.DefaultClient.Do(attachmentRequest(t, server, s, user, "GET", doskaEventsPath, nil))
			if err != nil || response.StatusCode != 200 {
				t.Fatalf("subject%d tab%d %v", subject, tab, err)
			}
			streams = append(streams, response)
		}
	}
	other, _ := attachmentIdentityGUID(t, s, 99)
	response, err := http.DefaultClient.Do(attachmentRequest(t, server, s, other, "GET", doskaEventsPath, nil))
	if err != nil || response.StatusCode != 503 {
		t.Fatal("global admission", err)
	}
	response.Body.Close()
	if len(g.slots) != 0 {
		t.Fatal("stream consumed JSON slot")
	}
}

func TestDoskaEventsSharedFixture(t *testing.T) {
	data, err := os.ReadFile("testdata/doska-live-events-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprintf("%x", sha256.Sum256(data)) != "2618703dc880b802547c8a64424b585194c12711075ad60d9bc73511558a314b" {
		t.Fatal("shared fixture changed; review owner contract")
	}
	var fixture struct {
		Valid, Invalid []struct {
			Event string
			Data  json.RawMessage
		}
		ProjectScopes, PersonalScopes []string
	}
	if err = json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, group := range []struct {
		items []struct {
			Event string
			Data  json.RawMessage
		}
		valid bool
	}{{fixture.Valid, true}, {fixture.Invalid, false}} {
		for _, item := range group.items {
			var compact bytes.Buffer
			json.Compact(&compact, item.Data)
			frame := []byte(fmt.Sprintf("event: %s\ndata: %s\n\n", item.Event, compact.Bytes()))
			if _, ok := doskaValidEvent(frame); ok != group.valid {
				t.Fatalf("fixture %s %s valid=%v", item.Event, item.Data, ok)
			}
		}
	}
	for _, scope := range fixture.ProjectScopes {
		if !doskaProjectScopes[scope] {
			t.Fatal(scope)
		}
	}
	for _, scope := range fixture.PersonalScopes {
		if !doskaPersonalScopes[scope] {
			t.Fatal(scope)
		}
	}
	if len(fixture.ProjectScopes) != len(doskaProjectScopes) || len(fixture.PersonalScopes) != len(doskaPersonalScopes) {
		t.Fatal("scope drift")
	}
}

func TestDoskaEventsExactFrameBoundAndSplitUTF8(t *testing.T) {
	prefix := "event: ready\ndata: "
	for _, size := range []int{4096, 4097} {
		frame := []byte(prefix + strings.Repeat(" ", size-len(prefix)-len("{\"version\":1}\n\n")) + "{\"version\":1}\n\n")
		_, valid := doskaValidEvent(frame)
		if valid != (size == 4096) {
			t.Fatal("schema frame bound", size)
		}
		if _, err := doskaReadEvent(bufio.NewReaderSize(bytes.NewReader(frame), 16)); (err == nil) != (size == 4096) {
			t.Fatal("parser bound", size, err)
		}
	}
	frame := []byte("event: changed\ndata: {\"version\":1,\"projectId\":\"p\",\"scopes\":[\"tasks\"],\"text\":\"Привет\"}\n\n")
	parsed, err := doskaReadEvent(bufio.NewReaderSize(bytes.NewReader(frame), 16))
	if err != nil || !bytes.Equal(parsed, frame) {
		t.Fatal("split UTF8", err)
	}
	if _, valid := doskaValidEvent(parsed); valid {
		t.Fatal("content field accepted")
	}
}

func TestDoskaEventsHTTPAbsoluteSessionExpiry(t *testing.T) {
	s, g, user, server := eventFixture(t, http.HandlerFunc(readyUpstream))
	if _, err := s.Store.Pool.Exec(context.Background(), "UPDATE sessions SET expires_at=now()+interval '500 milliseconds' WHERE token_hash=$1", hash(user.cookie.Value)); err != nil {
		t.Fatal(err)
	}
	response, err := http.DefaultClient.Do(attachmentRequest(t, server, s, user, "GET", doskaEventsPath, nil))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	start := time.Now()
	io.Copy(io.Discard, response.Body)
	if elapsed := time.Since(start); elapsed > 1500*time.Millisecond {
		t.Fatal("absolute expiry ignored", elapsed)
	}
	g.events.mu.Lock()
	defer g.events.mu.Unlock()
	if g.events.total != 0 {
		t.Fatal("slot survives absolute expiry")
	}
}

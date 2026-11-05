package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"mime"
	"net"
	"net/http"
	"net/url"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"pl/portal/internal/organization"
)

const doskaEventsPath = "/doska/api/doska/events"
const doskaEventMaxFrame = 4096
const doskaEventHeartbeat = ": heartbeat\n\n"

type doskaEventAdmission struct {
	mu       sync.Mutex
	total    int
	subjects map[string]int
	stopped  chan struct{}
	closed   bool
}

func (a *doskaEventAdmission) acquire(subject string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed || a.total >= 32 || a.subjects[subject] >= 4 {
		return false
	}
	if a.subjects == nil {
		a.subjects = make(map[string]int)
		a.stopped = make(chan struct{})
	}
	a.total++
	a.subjects[subject]++
	return true
}
func (a *doskaEventAdmission) release(subject string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.total--
	a.subjects[subject]--
	if a.subjects[subject] == 0 {
		delete(a.subjects, subject)
	}
}

func (a *doskaEventAdmission) close() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.closed {
		a.closed = true
		if a.stopped != nil {
			close(a.stopped)
		}
	}
}

// Reads one bounded frame, retaining framing bytes and accepting split UTF-8
// only after the complete frame has arrived. No scanner or whole-stream buffer.
func doskaReadEvent(reader *bufio.Reader) ([]byte, error) {
	frame := make([]byte, 0, 256)
	for len(frame) < doskaEventMaxFrame {
		b, err := reader.ReadByte()
		if err != nil {
			return nil, err
		}
		frame = append(frame, b)
		if bytes.HasSuffix(frame, []byte("\n\n")) {
			if !utf8.Valid(frame) {
				return nil, errors.New("invalid event UTF-8")
			}
			return frame, nil
		}
	}
	return nil, errors.New("event frame exceeds bound")
}

var doskaProjectScopes = map[string]bool{}
var doskaPersonalScopes = map[string]bool{}

func init() {
	for _, scope := range []string{"tasks", "columns", "checklists", "comments", "history", "relations", "subtasks", "attachments", "project", "access", "members", "template-selection", "invitations", "join-requests", "fields", "labels"} {
		doskaProjectScopes[scope] = true
	}
	for _, scope := range []string{"projects", "templates", "invitations", "notifications", "preferences", "notification-preferences"} {
		doskaPersonalScopes[scope] = true
	}
}

// encoding/json matches struct fields case-insensitively; the wire does not.
func doskaEventJSON(payload []byte, out any, required []string, optional ...string) bool {
	if doskaStrictJSON(payload, out) != nil {
		return false
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(payload, &fields) != nil || fields == nil {
		return false
	}
	allowed := make(map[string]bool, len(required)+len(optional))
	for _, key := range required {
		allowed[key] = true
		if _, ok := fields[key]; !ok {
			return false
		}
	}
	for _, key := range optional {
		allowed[key] = true
	}
	for key := range fields {
		if !allowed[key] {
			return false
		}
	}
	return true
}

func doskaValidEvent(frame []byte) (string, bool) {
	if len(frame) > doskaEventMaxFrame || !utf8.Valid(frame) {
		return "", false
	}
	if bytes.Equal(frame, []byte(doskaEventHeartbeat)) {
		return "heartbeat", true
	}
	lines := bytes.Split(frame, []byte("\n"))
	if !bytes.HasPrefix(lines[0], []byte("event: ")) || len(lines) != 4 || len(lines[2]) != 0 || len(lines[3]) != 0 || !bytes.HasPrefix(lines[1], []byte("data: ")) {
		return "", false
	}
	payload := lines[1][6:]
	kind := string(bytes.TrimPrefix(lines[0], []byte("event: ")))
	switch kind {
	case "ready":
		var body struct {
			Version int `json:"version"`
		}
		return kind, doskaEventJSON(payload, &body, []string{"version"}) && body.Version == 1
	case "reset":
		var body struct {
			Version int    `json:"version"`
			Reason  string `json:"reason"`
		}
		return kind, doskaEventJSON(payload, &body, []string{"version", "reason"}) && body.Version == 1 && body.Reason == "resync"
	case "changed", "personal":
		// Distinct structs ensure project/task fields are forbidden for personal.
		var scopes []string
		if kind == "changed" {
			var body struct {
				Version   int      `json:"version"`
				ProjectID string   `json:"projectId"`
				TaskIDs   []string `json:"taskIds,omitempty"`
				Scopes    []string `json:"scopes"`
			}
			if !doskaEventJSON(payload, &body, []string{"version", "projectId", "scopes"}, "taskIds") || body.Version != 1 || !gatewaySafeID.MatchString(body.ProjectID) || len(body.TaskIDs) > 32 {
				return "", false
			}
			seen := map[string]bool{}
			for _, id := range body.TaskIDs {
				if !gatewaySafeID.MatchString(id) || seen[id] {
					return "", false
				}
				seen[id] = true
			}
			// Explicit null is not an optional list.
			var raw map[string]json.RawMessage
			if json.Unmarshal(payload, &raw) != nil || bytes.Equal(raw["taskIds"], []byte("null")) {
				return "", false
			}
			scopes = body.Scopes
		} else {
			var body struct {
				Version int      `json:"version"`
				Scopes  []string `json:"scopes"`
			}
			if !doskaEventJSON(payload, &body, []string{"version", "scopes"}) || body.Version != 1 {
				return "", false
			}
			scopes = body.Scopes
		}
		allowed := doskaProjectScopes
		if kind == "personal" {
			allowed = doskaPersonalScopes
		}
		if len(scopes) == 0 || len(scopes) > len(allowed) {
			return "", false
		}
		seen := map[string]bool{}
		for _, scope := range scopes {
			if !allowed[scope] || seen[scope] {
				return "", false
			}
			seen[scope] = true
		}
		return kind, true
	}
	return "", false
}

func doskaLeaseEnd(start time.Time, sess session, p organization.Projection, hard time.Time) time.Time {
	end := start.Add(5 * time.Second)
	for _, v := range []time.Time{sess.ExpiresAt, p.ValidUntil, hard} {
		if v.Before(end) {
			end = v
		}
	}
	return end
}

func (g *doskaGateway) serveEvents(w http.ResponseWriter, r *http.Request, sess session, p organization.Projection, checkedAt time.Time) {
	if r.Method != "GET" || r.URL.Path != doskaEventsPath || r.URL.RawQuery != "" || r.ContentLength != 0 || len(r.TransferEncoding) != 0 || len(r.Header.Values("Last-Event-ID")) != 0 || len(r.Header.Values("Upgrade")) != 0 || len(r.Header.Values("Content-Encoding")) != 0 {
		problem(w, 400, "gateway_events_request", "Некорректный запрос канала")
		return
	}
	if !g.events.acquire(sess.User.ID) {
		problem(w, 503, "gateway_busy", "Лимит подключений Doska")
		return
	}
	defer g.events.release(sess.User.ID)
	// Require deadline support before admitting any upstream stream. This is
	// needed to interrupt a blocked write even when no further events arrive.
	controller := http.NewResponseController(w)
	now := time.Now()
	hard := now.Add(300 * time.Second)
	for _, end := range []time.Time{sess.ExpiresAt, p.ValidUntil} {
		if end.Before(hard) {
			hard = end
		}
	}
	initial := doskaLeaseEnd(checkedAt, sess, p, hard)
	if err := controller.SetWriteDeadline(initial); err != nil {
		problem(w, 503, "gateway_events_transport", "Канал недоступен")
		return
	}
	ready := false
	defer func() {
		if ready {
			// Abort net/http final buffering after an expired or failed stream.
			// Clearing deadlines must never re-enable a partially blocked frame.
			panic(http.ErrAbortHandler)
		}
		_ = controller.SetWriteDeadline(time.Time{})
	}()
	ctx, cancel := context.WithDeadline(r.Context(), hard)
	defer cancel()
	var lease atomic.Int64
	lease.Store(initial.UnixNano())
	renewed := make(chan struct{}, 1)
	// Independent expiry watchdog: a hung refresh cannot extend authorization or
	// prevent upstream cancellation / a blocked client write from terminating.
	done := make(chan struct{})
	go func() {
		defer close(done)
		timer := time.NewTimer(time.Until(initial))
		defer timer.Stop()
		for {
			select {
			case <-g.events.stopped:
				cancel()
				controller.SetWriteDeadline(time.Now())
				return
			case <-ctx.Done():
				controller.SetWriteDeadline(time.Now())
				return
			case <-renewed:
			case <-timer.C:
			}
			end := time.Unix(0, lease.Load())
			if !time.Now().Before(end) {
				cancel()
				controller.SetWriteDeadline(time.Now())
				return
			}
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(time.Until(end))
		}
	}()
	defer func() { cancel(); <-done }()
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			start := time.Now()
			checkCtx, stop := context.WithTimeout(ctx, 2*time.Second)
			latest, err := g.server.readSession(r.Clone(checkCtx))
			var projection organization.Projection
			if err == nil && latest.User.ID == sess.User.ID && latest.CSRF == sess.CSRF {
				projection, err = g.identity(checkCtx, sess.User.ID, start)
			} else {
				err = errors.New("session changed")
			}
			stop()
			if err != nil {
				cancel()
				return
			}
			end := doskaLeaseEnd(start, latest, projection, hard)
			// Expired leases cannot be revived by late successful checks.
			if !time.Now().Before(time.Unix(0, lease.Load())) || !time.Now().Before(end) {
				cancel()
				return
			}
			lease.Store(end.UnixNano())
			select {
			case renewed <- struct{}{}:
			default:
			}
		}
	}()
	out := r.Clone(ctx)
	out.Header = make(http.Header)
	out.Body = nil
	out.GetBody = nil
	out.ContentLength = 0
	out.Header.Set("Accept", "text/event-stream")
	out.Header.Set("Accept-Encoding", "identity")
	ip := g.server.loginPeer(r)
	if net.ParseIP(ip) == nil || signDoskaRequest(out, nil, sess, doskaRouteEvents, g.config.Key, now, false, ip) != nil {
		problem(w, 400, "gateway_identity", "Некорректная identity")
		return
	}
	out.URL.Path = "/api/doska/events"
	out.URL.Scheme = g.apiUpstream.Scheme
	out.URL.Host = g.apiUpstream.Host
	public, _ := url.Parse(g.server.Config.PublicURL)
	out.Host = public.Host
	out.Header.Set("X-Forwarded-Host", public.Host)
	out.Header.Set("X-Forwarded-Proto", public.Scheme)
	out.Header.Set("X-Forwarded-Prefix", "/doska")
	out.Header.Set("X-Forwarded-For", ip)
	out.RequestURI = ""
	response, err := g.transport.RoundTrip(out)
	if err != nil {
		problem(w, 502, "gateway_events_source", "Канал Doska недоступен")
		return
	}
	defer response.Body.Close()
	// Closing body is required even for transports whose body ignores context.
	stopBody := context.AfterFunc(ctx, func() { response.Body.Close() })
	defer stopBody()
	media, params, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	encoding := response.Header.Get("Content-Encoding")
	if response.Uncompressed || response.StatusCode != 200 || err != nil || media != "text/event-stream" || len(params) > 1 || len(params) == 1 && params["charset"] != "utf-8" || len(response.Header.Values("Content-Type")) != 1 || len(response.Header.Values("Content-Encoding")) > 1 || encoding != "" && encoding != "identity" || len(response.Header.Values("Location")) != 0 {
		problem(w, 502, "gateway_events_response", "Некорректный ответ канала")
		return
	}
	type result struct {
		frame []byte
		err   error
	}
	frames := make(chan result, 1)
	go func() {
		reader := bufio.NewReaderSize(response.Body, doskaEventMaxFrame)
		for {
			frame, err := doskaReadEvent(reader)
			select {
			case frames <- result{frame, err}:
			case <-ctx.Done():
				return
			}
			if err != nil {
				return
			}
		}
	}()
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	write := func(frame []byte) bool {
		end := time.Unix(0, lease.Load())
		if ctx.Err() != nil || !time.Now().Before(end) {
			return false
		}
		if controller.SetWriteDeadline(end) != nil {
			return false
		}
		// Recheck after installing deadline; watchdog may have expired concurrently.
		if ctx.Err() != nil || !time.Now().Before(end) {
			return false
		}
		if _, err := w.Write(frame); err != nil {
			return false
		}
		return controller.Flush() == nil && ctx.Err() == nil && time.Now().Before(end)
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-heartbeat.C:
			if ready && !write([]byte(doskaEventHeartbeat)) {
				return
			}
		case result := <-frames:
			if result.err != nil {
				if !ready {
					problem(w, 502, "gateway_events_frame", "Некорректный кадр канала")
				}
				return
			}
			kind, valid := doskaValidEvent(result.frame)
			if !valid || !ready && kind != "ready" || ready && kind == "ready" {
				if !ready {
					problem(w, 502, "gateway_events_frame", "Некорректный кадр канала")
				}
				return
			}
			if kind == "heartbeat" {
				continue
			}
			if !ready {
				w.Header().Set("Content-Type", "text/event-stream")
				w.Header().Set("Cache-Control", "no-store")
				w.Header().Set("X-Accel-Buffering", "no")
				ready = true
			}
			if !write(result.frame) {
				return
			}
		}
	}
}

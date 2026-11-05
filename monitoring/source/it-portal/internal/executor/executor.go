// Package executor is a separate least-capability boundary around Docker restart.
// Only this process receives the Docker socket. Never embed it in the API process.
package executor

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
)

type Entry struct {
	RequestID   string    `json:"request_id"`
	Target      string    `json:"target"`
	ContainerID string    `json:"container_id,omitempty"`
	Status      string    `json:"status"`
	Error       string    `json:"error,omitempty"`
	At          time.Time `json:"at"`
}
type Executor struct {
	mu        sync.Mutex
	entries   map[string]Entry
	journal   *os.File
	allowlist string
	client    *http.Client
}
type Allowlist struct {
	Targets map[string]string `json:"targets"`
}

var identifier = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`)

func Open(journalPath, allowlist, dockerSocket string) (*Executor, error) {
	if !filepath.IsAbs(journalPath) || !filepath.IsAbs(allowlist) || !filepath.IsAbs(dockerSocket) {
		return nil, errors.New("executor paths must be absolute")
	}
	if _, e := readAllowlist(allowlist); e != nil {
		return nil, e
	}
	if e := os.MkdirAll(filepath.Dir(journalPath), 0700); e != nil {
		return nil, e
	}
	f, e := os.OpenFile(journalPath, os.O_RDWR|os.O_CREATE|os.O_APPEND, 0600)
	if e != nil {
		return nil, e
	}
	good := false
	defer func() {
		if !good {
			f.Close()
		}
	}()
	if e = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
		return nil, errors.New("executor journal already in use")
	}
	x := &Executor{journal: f, allowlist: allowlist, entries: map[string]Entry{}}
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 4096), 64<<10)
	for scanner.Scan() {
		var v Entry
		if e = json.Unmarshal(scanner.Bytes(), &v); e != nil || !identifier.MatchString(v.RequestID) || v.Target == "" || (v.Status != "started" && v.Status != "succeeded" && v.Status != "failed" && v.Status != "unknown") {
			return nil, errors.New("invalid executor journal: restore or inspect manually")
		}
		if prev, ok := x.entries[v.RequestID]; ok && prev.Target != v.Target {
			return nil, errors.New("conflicting journal identity")
		}
		x.entries[v.RequestID] = v
	}
	if e = scanner.Err(); e != nil {
		return nil, e
	}
	// Persist parent directory creation too; journal cannot disappear after accepted work.
	if e = f.Sync(); e != nil {
		return nil, e
	}
	d, e := os.Open(filepath.Dir(journalPath))
	if e != nil {
		return nil, e
	}
	e = d.Sync()
	d.Close()
	if e != nil {
		return nil, e
	}
	x.client = &http.Client{Timeout: 45 * time.Second, Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", dockerSocket)
	}, DisableKeepAlives: true}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	good = true
	return x, nil
}
func (x *Executor) Close() error { return x.journal.Close() }
func readAllowlist(path string) (Allowlist, error) {
	var a Allowlist
	f, e := os.Open(path)
	if e != nil {
		return a, e
	}
	defer f.Close()
	b, e := io.ReadAll(io.LimitReader(f, 64<<10+1))
	if e != nil || len(b) > 64<<10 {
		return a, errors.New("invalid allowlist size")
	}
	d := json.NewDecoder(strings.NewReader(string(b)))
	d.DisallowUnknownFields()
	if e = d.Decode(&a); e != nil {
		return a, e
	}
	if a.Targets == nil {
		return a, errors.New("allowlist requires targets object")
	}
	for k, v := range a.Targets {
		if !identifier.MatchString(k) || !identifier.MatchString(v) {
			return a, errors.New("allowlist contains invalid target")
		}
	}
	return a, nil
}
func (x *Executor) save(v Entry) error {
	v.At = time.Now().UTC()
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	b = append(b, '\n')
	if _, e = x.journal.Write(b); e != nil {
		return e
	}
	if e = x.journal.Sync(); e != nil {
		return e
	}
	x.entries[v.RequestID] = v
	return nil
}
func (x *Executor) docker(ctx context.Context, method, path string) (*http.Response, error) {
	r, e := http.NewRequestWithContext(ctx, method, "http://docker"+path, nil)
	if e != nil {
		return nil, e
	}
	return x.client.Do(r)
}
func (x *Executor) inspect(ctx context.Context, target string) (string, bool, error) {
	resp, e := x.docker(ctx, "GET", "/containers/"+url.PathEscape(target)+"/json")
	if e != nil {
		return "", false, errors.New("Docker inspect unavailable")
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", false, fmt.Errorf("Docker inspect HTTP %d", resp.StatusCode)
	}
	var v struct {
		ID    string `json:"Id"`
		State struct {
			Running bool `json:"Running"`
		} `json:"State"`
	}
	b, e := io.ReadAll(io.LimitReader(resp.Body, 1<<20+1))
	if e != nil || len(b) > 1<<20 || json.Unmarshal(b, &v) != nil || !identifier.MatchString(v.ID) {
		return "", false, errors.New("invalid Docker inspect result")
	}
	return v.ID, v.State.Running, nil
}
func (x *Executor) restart(ctx context.Context, id, target string) Entry {
	x.mu.Lock()
	defer x.mu.Unlock()
	if prev, ok := x.entries[id]; ok {
		if prev.Target != target {
			return Entry{RequestID: id, Target: target, Status: "failed", Error: "request_id already used for another target"}
		}
		if prev.Status == "started" {
			prev.Status = "unknown"
			prev.Error = "executor interrupted; request will not be repeated"
		}
		return prev
	}
	v := Entry{RequestID: id, Target: target, Status: "failed"}
	a, e := readAllowlist(x.allowlist)
	if e != nil {
		v.Error = "allowlist unavailable"
		return v
	}
	container, ok := a.Targets[target]
	if !ok {
		v.Error = "target is not allowlisted"
		return v
	}
	cid, _, e := x.inspect(ctx, container)
	if e != nil {
		v.Error = e.Error()
		return v
	}
	v.ContainerID = cid
	v.Status = "started"
	if e = x.save(v); e != nil {
		v.Status = "failed"
		v.Error = "cannot durably journal operation"
		return v
	}
	// From here on, any ambiguity is terminal unknown, never an automatic retry.
	resp, e := x.docker(ctx, "POST", "/containers/"+url.PathEscape(cid)+"/restart?t=10")
	v.Status = "unknown"
	v.Error = "restart outcome unknown"
	if e == nil {
		resp.Body.Close()
		if resp.StatusCode == 204 {
			_, running, inspectErr := x.inspect(ctx, cid)
			if inspectErr == nil {
				if running {
					v.Status = "succeeded"
					v.Error = ""
				} else {
					v.Status = "failed"
					v.Error = "restart completed but container is not running"
				}
			}
		} else if resp.StatusCode == 404 || resp.StatusCode == 403 {
			v.Status = "failed"
			v.Error = fmt.Sprintf("Docker restart rejected HTTP %d", resp.StatusCode)
		}
	}
	if e = x.save(v); e != nil {
		v.Status = "unknown"
		v.Error = "cannot persist final result; inspect container manually"
	}
	return v
}
func reply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func (x *Executor) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		resp, e := x.docker(ctx, "GET", "/_ping")
		ok := e == nil
		if resp != nil {
			ok = ok && resp.StatusCode == 200
			resp.Body.Close()
		}
		status := 200
		if !ok {
			status = 503
		}
		reply(w, status, map[string]bool{"ok": ok})
	})
	mux.HandleFunc("POST /v1/restart", func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, 4096)
		defer r.Body.Close()
		var v struct {
			RequestID string `json:"request_id"`
			Target    string `json:"target"`
		}
		d := json.NewDecoder(r.Body)
		d.DisallowUnknownFields()
		if e := d.Decode(&v); e != nil || !identifier.MatchString(v.RequestID) || !identifier.MatchString(v.Target) {
			reply(w, 400, map[string]string{"error": "invalid request"})
			return
		}
		if d.Decode(&struct{}{}) != io.EOF {
			reply(w, 400, map[string]string{"error": "invalid trailing data"})
			return
		}
		ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 60*time.Second)
		defer cancel()
		reply(w, 200, x.restart(ctx, v.RequestID, v.Target))
	})
	return mux
}

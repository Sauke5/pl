package executor

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func fixture(t *testing.T, uncertain bool) (*Executor, string, string, string, *atomic.Int32) {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "pex-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	socket := filepath.Join(dir, "docker.sock")
	l, e := net.Listen("unix", socket)
	if e != nil {
		t.Fatal(e)
	}
	var count atomic.Int32
	s := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/_ping":
			_, _ = w.Write([]byte("OK"))
		case strings.HasSuffix(r.URL.Path, "/json"):
			_ = json.NewEncoder(w).Encode(map[string]any{"Id": "abcdef012345", "State": map[string]bool{"Running": true}})
		case strings.HasSuffix(r.URL.Path, "/restart"):
			count.Add(1)
			if r.URL.Query().Get("t") != "10" {
				t.Error(r.URL.String())
			}
			if uncertain {
				c, _, e := w.(http.Hijacker).Hijack()
				if e == nil {
					c.Close()
				}
				return
			}
			w.WriteHeader(204)
		default:
			t.Error(r.URL.String())
			w.WriteHeader(404)
		}
	})}
	go s.Serve(l)
	t.Cleanup(func() { s.Close() })
	a := filepath.Join(dir, "allow.json")
	if e = os.WriteFile(a, []byte(`{"targets":{"demo":"container"}}`), 0600); e != nil {
		t.Fatal(e)
	}
	journal := filepath.Join(dir, "journal.jsonl")
	x, e := Open(journal, a, socket)
	if e != nil {
		t.Fatal(e)
	}
	return x, journal, a, socket, &count
}
func TestRestartDurableIdempotency(t *testing.T) {
	x, j, a, s, c := fixture(t, false)
	var wg sync.WaitGroup
	for n := 0; n < 5; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			v := x.restart(context.Background(), "request-1", "demo")
			if v.Status != "succeeded" {
				t.Error(v)
			}
		}()
	}
	wg.Wait()
	if c.Load() != 1 {
		t.Fatal(c.Load())
	}
	if v := x.restart(context.Background(), "request-1", "other"); v.Status != "failed" {
		t.Fatal(v)
	}
	x.Close()
	x, e := Open(j, a, s)
	if e != nil {
		t.Fatal(e)
	}
	defer x.Close()
	if v := x.restart(context.Background(), "request-1", "demo"); v.Status != "succeeded" || c.Load() != 1 {
		t.Fatal(v, c.Load())
	}
}
func TestAmbiguousRestartNeverRetries(t *testing.T) {
	x, j, a, s, c := fixture(t, true)
	v := x.restart(context.Background(), "request-1", "demo")
	if v.Status != "unknown" || c.Load() != 1 {
		t.Fatal(v, c.Load())
	}
	x.Close()
	x, e := Open(j, a, s)
	if e != nil {
		t.Fatal(e)
	}
	defer x.Close()
	v = x.restart(context.Background(), "request-1", "demo")
	if v.Status != "unknown" || c.Load() != 1 {
		t.Fatal(v, c.Load())
	}
}
func TestInterruptedStartedNeverRetries(t *testing.T) {
	x, j, a, s, c := fixture(t, false)
	if e := x.save(Entry{RequestID: "started-1", Target: "demo", Status: "started"}); e != nil {
		t.Fatal(e)
	}
	x.Close()
	x, e := Open(j, a, s)
	if e != nil {
		t.Fatal(e)
	}
	defer x.Close()
	v := x.restart(context.Background(), "started-1", "demo")
	if v.Status != "unknown" || c.Load() != 0 {
		t.Fatal(v, c.Load())
	}
}
func TestAllowlistRecheckedAtExecution(t *testing.T) {
	x, _, a, _, c := fixture(t, false)
	defer x.Close()
	if e := os.WriteFile(a, []byte(`{"targets":{}}`), 0600); e != nil {
		t.Fatal(e)
	}
	v := x.restart(context.Background(), "new-id", "demo")
	if v.Status != "failed" || c.Load() != 0 {
		t.Fatal(v, c.Load())
	}
}
func TestCorruptJournalAndMultipleExecutorsRejected(t *testing.T) {
	x, j, a, s, _ := fixture(t, false)
	if y, e := Open(j, a, s); e == nil {
		y.Close()
		t.Fatal("second process took journal")
	}
	x.Close()
	if e := os.WriteFile(j, []byte(`{"request_id":`), 0600); e != nil {
		t.Fatal(e)
	}
	if y, e := Open(j, a, s); e == nil {
		y.Close()
		t.Fatal("accepted corrupt journal")
	}
}

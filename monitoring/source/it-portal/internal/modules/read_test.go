package modules

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestReadContractRefusesWriteDebugAndEscapedRoutes(t *testing.T) {
	for _, tc := range [][2]string{{"/-/reload", ""}, {"/api/v1/admin/tsdb/delete_series", ""}, {"/debug/pprof", ""}, {"/assets/../private.js", ""}, {"/assets/%2fsecret.js", ""}, {"//evil/api/v1/targets", ""}, {"/api/v1/targets", "x=%0afoo"}, {"/api/v1/targets", "x=%zz"}, {"/query", strings.Repeat("x", 8193)}} {
		if err := ValidateRead(tc[0], tc[1]); err == nil {
			t.Errorf("accepted %q %q", tc[0], tc[1])
		}
	}
	for _, path := range []string{"/query", "/targets", "/assets/index-qwerty.js", "/assets/codicon-abcd.ttf", "/api/v1/label/__name__/values", "/api/v1/query_range"} {
		if err := ValidateRead(path, "query=up%7Bjob%3D%22prometheus%22%7D"); err != nil {
			t.Errorf("rejected %s: %v", path, err)
		}
	}
}

func TestControllerReadAuthenticatesAndChecksInstanceBodyEnvelope(t *testing.T) {
	id := "f88e24f3-30ad-4cdb-a48b-72422ba4acd8"
	for _, scenario := range []string{"valid", "wrong-instance", "redirect", "invalid-base64", "oversize", "invalid-type"} {
		t.Run(scenario, func(t *testing.T) {
			client := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
				var request map[string]string
				if r.Method != "POST" || r.URL.Path != "/v1/read" || r.Header.Get("X-Pl-Signature") == "" {
					t.Error("unauthenticated or wrong channel")
				}
				if json.NewDecoder(r.Body).Decode(&request) != nil || request["instance_id"] != id || request["path"] != "/api/v1/targets" || request["query"] != "state=active" {
					t.Error("wrong exact read request")
				}
				body := base64.StdEncoding.EncodeToString([]byte(`{"status":"success","data":{"activeTargets":[]}}`))
				status, ct, returnedID := 200, "application/json", id
				switch scenario {
				case "wrong-instance":
					returnedID = "foreign"
				case "redirect":
					status = 302
				case "invalid-base64":
					body = "?"
				case "oversize":
					body = base64.StdEncoding.EncodeToString(make([]byte, ReadLimit+1))
				case "invalid-type":
					ct = "text/html\nforged:yes"
				}
				json.NewEncoder(w).Encode(map[string]any{"instance_id": returnedID, "status": status, "content_type": ct, "body": body})
			})
			response, err := client.Read(context.Background(), id, "/api/v1/targets", "state=active")
			if scenario != "valid" {
				if err == nil {
					t.Fatal("accepted invalid read envelope")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			body, _ := io.ReadAll(response.Body)
			if response.StatusCode != 200 || !strings.Contains(string(body), "activeTargets") || len(response.Header) != 1 {
				t.Fatalf("bad bounded response %+v %s", response, body)
			}
		})
	}
}

func TestExternalReadPinsCanonicalEndpointAndDropsUpstreamHeaders(t *testing.T) {
	p, calls := probeFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RequestURI() != "/prom/api/v1/query?query=up" || r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" {
			t.Errorf("wrong request %s", r.URL)
		}
		w.Header().Set("Set-Cookie", "upstream=secret")
		w.Header().Set("Location", "http://foreign/")
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[]}}`))
	})
	response, err := p.Read(context.Background(), "http://prom.example:9090/prom", "/api/v1/query", "query=up")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if *calls != 1 || response.Header.Get("Set-Cookie") != "" || response.Header.Get("Location") != "" {
		t.Fatal("upstream authority or headers escaped bounded transport")
	}
}

func TestExternalReadRefusesRedirectAndOversize(t *testing.T) {
	for _, scenario := range []string{"redirect", "oversize"} {
		t.Run(scenario, func(t *testing.T) {
			p, _ := probeFixture(t, func(w http.ResponseWriter, r *http.Request) {
				if scenario == "redirect" {
					http.Redirect(w, r, "http://127.0.0.1/private", 302)
				} else {
					w.Write(make([]byte, ReadLimit+1))
				}
			})
			if _, err := p.Read(context.Background(), "http://prom.example:9090", "/api/v1/targets", ""); err == nil {
				t.Fatal("accepted unsafe upstream response")
			}
		})
	}
}

type readRetryCloseBody struct {
	io.ReadCloser
	closed *atomic.Bool
}

func (b readRetryCloseBody) Close() error {
	b.closed.Store(true)
	return b.ReadCloser.Close()
}

type readRetryTransport struct {
	next   http.RoundTripper
	closed atomic.Bool
	calls  atomic.Int32
	t      *testing.T
}

func (r *readRetryTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if r.calls.Add(1) > 1 && !r.closed.Load() {
		r.t.Error("previous busy response was not closed before retry")
	}
	r.closed.Store(false)
	response, err := r.next.RoundTrip(req)
	if err == nil {
		response.Body = readRetryCloseBody{response.Body, &r.closed}
	}
	return response, err
}

func TestControllerReadRetriesOnlyAuthenticatedTypedBusy(t *testing.T) {
	id := "f88e24f3-30ad-4cdb-a48b-72422ba4acd8"
	var calls atomic.Int32
	client := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mac := hmac.New(sha256.New, make([]byte, 32))
		mac.Write([]byte(r.Header.Get("X-Pl-Timestamp") + "\nPOST\n/v1/read\n"))
		mac.Write(body)
		if r.Method != "POST" || r.URL.Path != "/v1/read" || r.Header.Get("X-Pl-Signature") != hex.EncodeToString(mac.Sum(nil)) {
			t.Error("retry did not preserve freshly authenticated read route")
		}
		var request map[string]string
		if json.Unmarshal(body, &request) != nil || request["instance_id"] != id || request["path"] != "/api/v1/targets" || request["query"] != "state=active" {
			t.Error("read parameters changed during retry")
		}
		if calls.Add(1) == 1 {
			w.WriteHeader(503)
			io.WriteString(w, `{"error":{"code":"controller_busy","message":"retry read"}}`)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"instance_id": id, "status": 200, "content_type": "application/json", "body": base64.StdEncoding.EncodeToString([]byte(`{"status":"success"}`))})
	})
	transport := &readRetryTransport{next: client.client.Transport, t: t}
	client.client.Transport = transport
	response, err := client.Read(context.Background(), id, "/api/v1/targets", "state=active")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 || calls.Load() != 2 || !transport.closed.Load() {
		t.Fatal("typed read contention was not reconciled with a real bounded read")
	}
}

func TestControllerReadDoesNotRetryOtherErrors(t *testing.T) {
	for _, tc := range []struct {
		status int
		body   string
	}{
		{400, `{"error":{"code":"controller_busy"}}`},
		{503, `{"error":{"code":"upstream_unavailable"}}`},
		{503, `{"code":"controller_busy"}`},
		{503, `not-json`},
	} {
		t.Run(tc.body, func(t *testing.T) {
			var calls atomic.Int32
			client := controllerFixture(t, func(w http.ResponseWriter, _ *http.Request) {
				calls.Add(1)
				w.WriteHeader(tc.status)
				io.WriteString(w, tc.body)
			})
			_, err := client.Read(context.Background(), "f88e24f3-30ad-4cdb-a48b-72422ba4acd8", "/api/v1/targets", "")
			if err == nil || calls.Load() != 1 {
				t.Fatal("non-contention failure retried or accepted")
			}
		})
	}
}

func TestControllerReadBusyPreservesDeadlineAndCancellation(t *testing.T) {
	for _, cancelDuringRead := range []bool{false, true} {
		t.Run(map[bool]string{false: "deadline", true: "cancel"}[cancelDuringRead], func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
			defer cancel()
			var calls atomic.Int32
			client := controllerFixture(t, func(w http.ResponseWriter, _ *http.Request) {
				calls.Add(1)
				w.WriteHeader(503)
				io.WriteString(w, `{"error":{"code":"controller_busy"}}`)
				if cancelDuringRead {
					cancel()
				}
			})
			_, err := client.Read(ctx, "f88e24f3-30ad-4cdb-a48b-72422ba4acd8", "/api/v1/targets", "")
			want := context.DeadlineExceeded
			if cancelDuringRead {
				want = context.Canceled
			}
			if !errors.Is(err, want) || calls.Load() != 1 {
				t.Fatalf("lost bounded read cancellation: %v, calls=%d", err, calls.Load())
			}
		})
	}
}

func TestControllerReadBusyRetriesAreFiniteAndNeverReplayApply(t *testing.T) {
	var calls atomic.Int32
	client := controllerFixture(t, func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(503)
		io.WriteString(w, `{"error":{"code":"controller_busy"}}`)
	})
	_, err := client.Read(context.Background(), "f88e24f3-30ad-4cdb-a48b-72422ba4acd8", "/api/v1/targets", "")
	if err == nil || calls.Load() != 6 {
		t.Fatalf("read admission was not bounded: %v, calls=%d", err, calls.Load())
	}
	calls.Store(0)
	_, err = client.Apply(context.Background(), Operation{OperationID: "read-retry-must-not-replay-apply", ModuleID: "prometheus", Action: "refresh"})
	if err == nil || calls.Load() != 1 {
		t.Fatalf("mutation was retried or accepted: %v, calls=%d", err, calls.Load())
	}
}

package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/modules"
)

type managedClosingFixture struct {
	http.Handler
	closed atomic.Int32
}

func TestManagedFormsRefreshAvailabilityAndDesiredStateRevocation(t *testing.T) {
	for _, tc := range []struct {
		name, action string
		failed       bool
	}{{"healthy-refresh", "refresh", false}, {"failed-refresh", "refresh", true}, {"disable", "disable", false}, {"remove", "remove", false}} {
		t.Run(tc.name, func(t *testing.T) {
			// Use the real PostgreSQL queue/claim/finish paths, managed gateway and
			// authenticated Forms HTTP transport; only controller observations vary.
			f := newFormsHTTPFixture(t, formsOK)
			ctx := context.Background()
			instance, install, err := f.s.Store.QueueModule(ctx, "ad:forms-admin", "availability:install", "", "install", model.ModuleRequest{ModuleID: "forms", Name: "Forms", Mode: "local"})
			if err != nil {
				t.Fatal(err)
			}
			now := time.Now().UTC()
			instance.ObservedState, instance.Version, instance.LastSuccess = "running", "0.1.0", &now
			install.Status, install.Result = "succeeded", map[string]any{"instance": instance}
			if err = f.s.Store.Finish(ctx, install); err != nil {
				t.Fatal(err)
			}
			f.s.Modules = modules.New(f.s.Store, moduleControllerFunc(func(_ context.Context, op modules.Operation) (modules.Observation, error) {
				if op.Action != "refresh" {
					t.Fatalf("unexpected controller operation %s", op.Action)
				}
				if tc.failed {
					return modules.Observation{}, errors.New("fixture readiness failed")
				}
				return modules.Observation{State: "running", Version: "0.1.0"}, nil
			}))
			wrapped := newManagedApplicationHandler(f.g)
			f.s.applications.handlers = map[string]*managedApplicationHandler{instance.ID + "/" + instance.Version: wrapped}
			defer f.s.revokeManagedApplication(instance.ID)
			gateway := func(want int) {
				t.Helper()
				before := f.calls.Load()
				response := apiCall(f.s, f.employee, "GET", "/forms/api/v1/context", nil, nil)
				if response.Code != want {
					t.Fatalf("Forms gateway status=%d want=%d: %s", response.Code, want, response.Body.String())
				}
				if want == 200 && f.calls.Load() != before+1 || want != 200 && f.calls.Load() != before {
					t.Fatal("gateway availability did not control native access")
				}
			}
			queue := func(key string) model.Job {
				t.Helper()
				queued := apiDecode[struct {
					Job model.Job `json:"job"`
				}](t, apiCall(f.s, f.admin, "POST", "/api/v1/modules/"+instance.ID+"/actions", map[string]any{"action": tc.action, "idempotency_key": key, "confirm_name": instance.Name}, nil), 202)
				if queued.Job.Status != "queued" {
					t.Fatal("lifecycle operation was not queued")
				}
				return queued.Job
			}
			claim := func(queued model.Job) model.Job {
				t.Helper()
				job, err := f.s.Store.Claim(ctx)
				if err != nil || job.ID != queued.ID || job.Status != "running" {
					t.Fatalf("wrong running lifecycle job: %+v %v", job, err)
				}
				return job
			}
			gateway(200)
			queued := queue("availability:first")
			if tc.action != "refresh" {
				gateway(503)
				if wrapped.lifetime.Err() != context.Canceled {
					t.Fatal("disable/remove did not revoke admitted gateway lifetime immediately")
				}
				claim(queued)
				gateway(503)
				return
			}
			gateway(200) // queued refresh is not evidence that the app stopped.
			job := claim(queued)
			gateway(200) // nor is a running readiness observation.
			job.Result, err = f.s.Modules.Execute(ctx, job)
			if (err != nil) != tc.failed {
				t.Fatalf("unexpected readiness outcome: %v", err)
			}
			job.Status = "succeeded"
			if err != nil {
				job.Status, job.Error = "failed", err.Error()
			}
			if err = f.s.Store.Finish(ctx, job); err != nil {
				t.Fatal(err)
			}
			if tc.failed {
				gateway(503)
				// Rechecking an unavailable app must not manufacture healthy state.
				queued = queue("availability:retry")
				gateway(503)
				claim(queued)
				gateway(503)
			} else {
				gateway(200)
			}
		})
	}
}

func (f *managedClosingFixture) Close() error { f.closed.Add(1); return nil }

func TestManagedApplicationRevokeCancelsPendingStreamsAndRequests(t *testing.T) {
	for _, path := range []string{"/doska/api/doska/events", "/doska/api/doska/projects"} {
		t.Run(path, func(t *testing.T) {
			started, finished := make(chan struct{}), make(chan struct{})
			native := &managedClosingFixture{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				close(started)
				<-r.Context().Done()
			})}
			wrapped := newManagedApplicationHandler(native)
			server := &Server{}
			server.applications.handlers = map[string]*managedApplicationHandler{"instance/v1": wrapped}
			// No controller completion is involved: desired-state queueing must revoke
			// admitted requests even while the lifecycle operation remains pending.
			go func() {
				defer close(finished)
				wrapped.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", path, nil))
			}()
			<-started
			server.revokeManagedApplication("instance")
			select {
			case <-finished:
			case <-time.After(time.Second):
				t.Fatal("request survived module revocation")
			}
			if native.closed.Load() != 1 || len(server.applications.handlers) != 0 {
				t.Fatal("native gateway was not evicted and closed")
			}
			recorder := httptest.NewRecorder()
			wrapped.ServeHTTP(recorder, httptest.NewRequest("GET", path, nil))
			if recorder.Code != 503 {
				t.Fatalf("revoked handler admitted request: %d", recorder.Code)
			}
			server.revokeManagedApplication("instance")
			if native.closed.Load() != 1 {
				t.Fatal("gateway closed twice")
			}
			// Re-enable gets a fresh lifetime; the retired handler is never revived.
			replacement := newManagedApplicationHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
			defer replacement.Close()
			recorder = httptest.NewRecorder()
			replacement.ServeHTTP(recorder, httptest.NewRequest("GET", path, nil))
			if recorder.Code != 204 {
				t.Fatal("fresh gateway did not admit request")
			}
		})
	}
}

func TestManagedApplicationVersionReplacementClosesOwnedSpool(t *testing.T) {
	server := &Server{Config: Config{PublicURL: "https://platform.example.test"}}
	spool := t.TempDir()
	if err := os.Chmod(spool, 0700); err != nil {
		t.Fatal(err)
	}
	config := DoskaGatewayConfig{APIUpstream: "http://module-api", WebUpstream: "http://module-web", Key: make([]byte, 32),
		Manifest:  DoskaGatewayManifest{Version: "test-v1", Routes: []DoskaGatewayRoute{{Method: "GET", Path: "/doska/", Kind: "page"}}},
		Transport: http.DefaultTransport, Events: true, Attachments: &DoskaAttachmentConfig{SpoolDirectory: spool}}
	first, err := server.newDoskaGateway(config)
	if err != nil {
		t.Fatal(err)
	}
	old := newManagedApplicationHandler(first)
	otherNative := &managedClosingFixture{Handler: http.NotFoundHandler()}
	other := newManagedApplicationHandler(otherNative)
	defer other.Close()
	server.applications.handlers = map[string]*managedApplicationHandler{"instance/v1": old, "other/v1": other}
	server.applications.Lock()
	cached := server.cachedManagedApplicationLocked(model.ModuleInstance{ID: "instance", Version: "v2"})
	server.applications.Unlock()
	if cached != nil || old.lifetime.Err() != context.Canceled {
		t.Fatal("old version was retained")
	}
	if otherNative.closed.Load() != 0 {
		t.Fatal("unrelated module was revoked")
	}
	// Native Close must release the real flock, not just cancel browser context.
	second, err := server.newDoskaGateway(config)
	if err != nil {
		t.Fatalf("replacement could not acquire owned spool: %v", err)
	}
	defer second.Close()
	server.applications.handlers["instance/v2"] = newManagedApplicationHandler(second)
	defer server.revokeManagedApplication("instance")
	server.applications.Lock()
	cached = server.cachedManagedApplicationLocked(model.ModuleInstance{ID: "instance", Version: "v2"})
	server.applications.Unlock()
	if cached == nil || cached.lifetime.Err() != nil {
		t.Fatal("unchanged version was not reused")
	}
}

package server

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/modules"
)

func TestManagedColdConstructionDoesNotBlockReadyApplicationHTTP(t *testing.T) {
	f := newFormsHTTPFixture(t, formsOK)
	ctx := context.Background()
	ready := func(kind string) model.ModuleInstance {
		instance, job, err := f.s.Store.QueueModule(ctx, "test", "construction-"+kind, "", "install", model.ModuleRequest{ModuleID: kind, Name: kind, Mode: "local"})
		if err != nil {
			t.Fatal(err)
		}
		now := time.Now().UTC()
		instance.ObservedState = "running"
		instance.Version = "fixture-v1"
		instance.LastSuccess = &now
		job.Status = "succeeded"
		job.Result = map[string]any{"instance": instance}
		if err = f.s.Store.Finish(ctx, job); err != nil {
			t.Fatal(err)
		}
		return instance
	}
	forms, doska := ready("forms"), ready("doska")
	// Use a real HostController HTTP boundary, without an installer/container.
	// Short canonical /private/tmp paths also preserve the Unix socket/spool guards.
	dir, err := os.MkdirTemp("/private/tmp", "pl-construction-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	socket, keyFile := filepath.Join(dir, "controller.sock"), filepath.Join(dir, "key")
	if err = os.WriteFile(keyFile, make([]byte, 32), 0600); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	manifestStarted, releaseManifest := make(chan struct{}, 2), make(chan struct{})
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(releaseManifest) }) }
	defer release()
	var manifests atomic.Int32
	controllerHTTP := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/v1/doska/manifest" {
			http.NotFound(w, r)
			return
		}
		var request struct {
			InstanceID string `json:"instance_id"`
		}
		if json.NewDecoder(r.Body).Decode(&request) != nil || request.InstanceID != doska.ID || r.Header.Get("X-Pl-Signature") == "" {
			http.Error(w, "invalid controller request", 400)
			return
		}
		manifests.Add(1)
		manifestStarted <- struct{}{}
		select {
		case <-releaseManifest:
		case <-r.Context().Done():
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(DoskaGatewayManifest{Version: "fixture-v1", Routes: []DoskaGatewayRoute{{Method: "GET", Path: "/doska/", Kind: "page"}}})
	}), ReadHeaderTimeout: time.Second}
	defer controllerHTTP.Close()
	go func() { _ = controllerHTTP.Serve(listener) }()
	controller, err := modules.NewHostController(socket, keyFile)
	if err != nil {
		t.Fatal(err)
	}
	f.s.Modules = modules.New(f.s.Store, controller)
	f.s.applications.handlers = map[string]*managedApplicationHandler{forms.ID + "/" + forms.Version: newManagedApplicationHandler(f.g)}
	defer f.s.revokeManagedApplication(forms.ID)
	defer func() {
		f.s.revokeManagedApplication(doska.ID)
		_ = os.RemoveAll(filepath.Join(os.TempDir(), "pl-doska-"+doska.ID))
	}()
	// Confirm a ready cached application reaches its authenticated native HTTP API.
	if response := apiCall(f.s, f.employee, "GET", "/forms/api/v1/context", nil, nil); response.Code != 200 {
		t.Fatalf("warm Forms: %d %s", response.Code, response.Body.String())
	}
	type outcome struct {
		handler http.Handler
		err     error
	}
	first, second := make(chan outcome, 1), make(chan outcome, 1)
	constructorCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	go func() { h, e := f.s.applicationHandler(constructorCtx, doska); first <- outcome{h, e} }()
	select {
	case <-manifestStarted:
	case <-time.After(3 * time.Second):
		t.Fatal("cold Doska construction did not reach native manifest")
	}
	go func() { h, e := f.s.applicationHandler(constructorCtx, doska); second <- outcome{h, e} }()
	formsResponse := make(chan *httptest.ResponseRecorder, 1)
	before := f.calls.Load()
	go func() { formsResponse <- apiCall(f.s, f.employee, "GET", "/forms/api/v1/context", nil, nil) }()
	// The manifest remains held throughout this assertion. A global cache lock
	// would stall this independent application's request until release.
	select {
	case response := <-formsResponse:
		if response.Code != 200 || f.calls.Load() != before+1 {
			t.Fatalf("ready Forms lost native access during cold Doska construction: %d %s", response.Code, response.Body.String())
		}
	case <-time.After(2 * time.Second):
		release()
		t.Fatal("cold Doska manifest blocked ready Forms HTTP")
	}
	if manifests.Load() != 1 {
		t.Fatalf("same-instance construction fetched %d concurrent manifests", manifests.Load())
	}
	release()
	var a, b outcome
	select {
	case a = <-first:
	case <-constructorCtx.Done():
		t.Fatal("first construction did not finish")
	}
	select {
	case b = <-second:
	case <-constructorCtx.Done():
		t.Fatal("second construction did not finish")
	}
	if a.err != nil || b.err != nil || a.handler == nil || a.handler != b.handler || manifests.Load() != 1 {
		t.Fatalf("same instance was not constructed once/reused: first=%v second=%v manifests=%d same=%v", a.err, b.err, manifests.Load(), a.handler == b.handler)
	}
}

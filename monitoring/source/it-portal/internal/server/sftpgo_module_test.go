package server

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"pl/portal/internal/model"
	"pl/portal/internal/modules"
	"pl/portal/internal/store"
)

func sftpgoAPIFixture(t *testing.T, native http.HandlerFunc) (*Server, model.ModuleInstance) {
	t.Helper()
	s := apiFixture(t)
	instance, job, err := s.Store.QueueModule(context.Background(), "file-admin", "sftpgo:install", "", "install", model.ModuleRequest{ModuleID: "sftpgo", Name: "Files", Mode: "local"})
	if err != nil {
		t.Fatal(err)
	}
	instance.ObservedState = "running"
	job.Status, job.Result = "succeeded", map[string]any{"instance": instance}
	if err = s.Store.Finish(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	dir, err := os.MkdirTemp("", "pl-sftpgo-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	keyFile, socket := filepath.Join(dir, "key"), filepath.Join(dir, "controller.sock")
	if err = os.WriteFile(keyFile, bytes.Repeat([]byte{7}, 32), 0600); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	host := &http.Server{Handler: native}
	go host.Serve(listener)
	t.Cleanup(func() { host.Close() })
	controller, err := modules.NewHostController(socket, keyFile)
	if err != nil {
		t.Fatal(err)
	}
	s.Modules = modules.New(s.Store, controller)
	return s, instance
}

func sftpgoReadRPC(t *testing.T, r *http.Request) struct {
	InstanceID string              `json:"instance_id"`
	Action     string              `json:"action"`
	Actor      modules.SFTPGoActor `json:"actor"`
	Payload    map[string]any      `json:"payload"`
} {
	t.Helper()
	var out struct {
		InstanceID string              `json:"instance_id"`
		Action     string              `json:"action"`
		Actor      modules.SFTPGoActor `json:"actor"`
		Payload    map[string]any      `json:"payload"`
	}
	body, err := io.ReadAll(r.Body)
	if err != nil || json.Unmarshal(body, &out) != nil {
		t.Fatal("invalid RPC")
	}
	mac := hmac.New(sha256.New, bytes.Repeat([]byte{7}, 32))
	mac.Write([]byte(r.Header.Get("X-Pl-Timestamp") + "\nPOST\n/v1/sftpgo/request\n"))
	mac.Write(body)
	if r.Method != "POST" || r.URL.Path != "/v1/sftpgo/request" || r.Header.Get("X-Pl-Signature") != hex.EncodeToString(mac.Sum(nil)) {
		t.Error("RPC signature/route changed")
	}
	return out
}

func TestSFTPGoRBACSessionBindingAndNativeLoginFailure(t *testing.T) {
	actors := make(chan modules.SFTPGoActor, 8)
	var calls atomic.Int32
	s, instance := sftpgoAPIFixture(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		request := sftpgoReadRPC(t, r)
		actors <- request.Actor
		status, body := 200, any(map[string]any{"state": "running", "client_authenticated": false})
		if request.Action == "client-login" {
			status, body = 401, map[string]any{"error": map[string]string{"code": "authentication_required", "message": "native-secret-must-not-escape"}}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"instance_id": request.InstanceID, "status": status, "body": body})
	})
	viewer := apiUser(t, s, "file-viewer", false)
	second := apiUser(t, s, "file-viewer", false)
	base := "/api/v1/modules/" + instance.ID + "/sftpgo/"
	for _, who := range []apiIdentity{viewer, viewer, second} {
		if w := apiCall(s, who, "GET", base+"status", nil, nil); w.Code != 200 {
			t.Fatalf("status %d: %s", w.Code, w.Body.String())
		}
	}
	a, b, c := <-actors, <-actors, <-actors
	if a.Admin || a.Subject != "file-viewer" || len(a.SessionKey) != 64 || a.SessionKey != b.SessionKey || a.SessionKey == c.SessionKey || a.SessionKey == hash(viewer.cookie.Value) {
		t.Fatal("native credentials are not isolated per Pl session")
	}
	for _, route := range []struct{ method, suffix string }{{"GET", "users"}, {"POST", "users"}, {"GET", "groups"}, {"POST", "folders"}, {"POST", "settings"}} {
		if w := apiCall(s, viewer, route.method, base+route.suffix, map[string]any{}, nil); w.Code != 403 {
			t.Fatalf("viewer management allowed: %s %d", route.suffix, w.Code)
		}
	}
	if w := apiCall(s, viewer, "POST", base+"client/login", map[string]any{"username": "files", "password": "private-fixture"}, map[string]string{"X-CSRF-Token": "wrong", "Idempotency-Key": "login:csrf"}); w.Code != 403 {
		t.Fatal("forged CSRF accepted")
	}
	if calls.Load() != 3 {
		t.Fatal("forbidden request reached native controller")
	}
	w := apiCall(s, viewer, "POST", base+"client/login", map[string]any{"username": "files", "password": "private-fixture"}, map[string]string{"Idempotency-Key": "login:valid"})
	if w.Code != 403 || !strings.Contains(w.Body.String(), "sftpgo_authentication_required") || strings.Contains(w.Body.String(), "native-secret") {
		t.Fatalf("native login error: %d %s", w.Code, w.Body.String())
	}
	<-actors
	if w = apiCall(s, viewer, "GET", "/api/v1/session", nil, nil); w.Code != 200 {
		t.Fatal("native login failure invalidated Pl session")
	}
	if w = apiCall(s, viewer, "POST", base+"client/login", json.RawMessage("null"), map[string]string{"Idempotency-Key": "login:null"}); w.Code != 400 {
		t.Fatalf("null payload %d", w.Code)
	}
	life, err := s.sftpgoTransferLifetime(context.Background(), instance.ID)
	if err != nil {
		t.Fatal(err)
	}
	s.revokeManagedApplication(instance.ID)
	if life.Err() != context.Canceled {
		t.Fatal("module revoke did not cancel file transfer lifetime")
	}
}

func TestSFTPGoSettingsRetriesReusePlanAndFreezeJob(t *testing.T) {
	var calls atomic.Int32
	const ref = "123e4567-e89b-42d3-a456-426614174000"
	s, instance := sftpgoAPIFixture(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		request := sftpgoReadRPC(t, r)
		if request.Action != "settings-prepare" || !request.Actor.Admin {
			t.Error("unprivileged settings preparation")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"instance_id": request.InstanceID, "status": 200, "body": map[string]any{"configuration_ref": ref, "revision": 1, "configuration_hash": strings.Repeat("a", 64), "configuration": map[string]any{"listen_ip": "127.0.0.1", "port": 2222}}})
	})
	admin := apiUser(t, s, "file-admin", true)
	url := "/api/v1/modules/" + instance.ID + "/sftpgo/settings"
	input := map[string]any{"configuration": map[string]any{"listen_ip": "127.0.0.1", "port": 2222}, "expected_revision": 0}
	headers := map[string]string{"Idempotency-Key": "settings:first"}
	first := apiDecode[struct {
		Job model.Job `json:"job"`
	}](t, apiCall(s, admin, "POST", url, input, headers), 202)
	retry := apiDecode[struct {
		Job model.Job `json:"job"`
	}](t, apiCall(s, admin, "POST", url, input, headers), 202)
	if first.Job.ID != retry.Job.ID || calls.Load() != 1 || first.Job.Parameters["configuration_ref"] != ref {
		t.Fatal("retry generated a second plan/job")
	}
	input["expected_revision"] = 1
	if w := apiCall(s, admin, "POST", url, input, headers); w.Code != 409 || calls.Load() != 1 {
		t.Fatal("operation key reused with changed input")
	}
	saved, err := store.Get[model.ModuleInstance](context.Background(), s.Store, "module_instance", instance.ID)
	if err != nil || saved.SFTPGoDraft == nil || saved.SFTPGoApplied != nil || saved.SFTPGoDraft.Ref != ref {
		t.Fatal("queue prematurely applied configuration")
	}
}

func TestSFTPGoFilePathsStayCanonical(t *testing.T) {
	for _, value := range []string{"/", "/folder/имя.txt", "/a.txt"} {
		if !validSFTPGoPath(value) {
			t.Errorf("valid path rejected %q", value)
		}
	}
	for _, value := range []string{"", "relative", "/a/../b", "/a//b", "/a/", "/a\\b", "/a\n", string([]byte{'/', 0xff})} {
		if validSFTPGoPath(value) {
			t.Errorf("unsafe path accepted %q", value)
		}
	}
}

func TestSFTPGoApplyRequiresPreparedConfigurationDigest(t *testing.T) {
	s := apiFixture(t)
	_ = apiUser(t, s, "file-admin", true)
	ctx := context.Background()
	instance, install, err := s.Store.QueueModule(ctx, "file-admin", "sftpgo:hash:install", "", "install", model.ModuleRequest{ModuleID: "sftpgo", Name: "Files", Mode: "local"})
	if err != nil {
		t.Fatal(err)
	}
	instance.ObservedState = "running"
	install.Status, install.Result = "succeeded", map[string]any{"instance": instance}
	if err = s.Store.Finish(ctx, install); err != nil {
		t.Fatal(err)
	}
	plan := model.SFTPGoConfiguration{Ref: "123e4567-e89b-42d3-a456-426614174000", Revision: 1, Hash: strings.Repeat("a", 64), ListenIP: "127.0.0.1", Port: 2022}
	if _, err = s.Store.SaveSFTPGoDraft(ctx, instance.ID, "file-admin", plan); err != nil {
		t.Fatal(err)
	}
	_, job, err := s.Store.QueueModule(ctx, "file-admin", "sftpgo:hash:apply", instance.ID, "configure", model.ModuleRequest{ConfigurationRevision: 1, Config: map[string]string{"configuration_ref": plan.Ref}})
	if err != nil {
		t.Fatal(err)
	}
	for _, digest := range []string{strings.Repeat("b", 64), plan.Hash} {
		calls := 0
		s.Modules = modules.New(s.Store, moduleControllerFunc(func(_ context.Context, op modules.Operation) (modules.Observation, error) {
			calls++
			if op.ConfigurationRef != plan.Ref {
				t.Fatal("controller received another plan")
			}
			return modules.Observation{State: "running", ConfigurationRevision: 1, ConfigurationHash: digest}, nil
		}))
		result, e := s.Modules.Execute(ctx, job)
		if calls != 1 {
			t.Fatal("configuration digest check never reached the controller")
		}
		applied := result["instance"].(model.ModuleInstance)
		if digest != plan.Hash {
			if e == nil || applied.SFTPGoApplied != nil {
				t.Fatal("unexpected configuration was marked applied")
			}
		} else if e != nil || applied.SFTPGoApplied == nil || applied.SFTPGoApplied.Hash != plan.Hash {
			t.Fatalf("matching plan failed: %v", e)
		}
	}
}

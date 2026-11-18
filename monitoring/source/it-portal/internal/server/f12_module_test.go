package server

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
	"pl/portal/internal/model"
	"pl/portal/internal/modules"
)

func TestF12PXEProjection(t *testing.T) {
	library := f12Library{Segments: map[string]string{"a": "Офис", "b": "Склад", "c": "Лаборатория", "d": "Туннель"}}
	library.projectPXE()
	if library.PXE != nil {
		t.Fatal("legacy response gained PXE state")
	}
	library.PXE = map[string]string{"a": "active", "b": "unsupported", "d": "manual", "other": "active"}
	library.projectPXE()
	if len(library.PXE) != 4 || library.PXE["a"] != "active" || library.PXE["b"] != "error" || library.PXE["c"] != "error" || library.PXE["d"] != "manual" {
		t.Fatalf("unexpected public statuses: %v", library.PXE)
	}
}

func TestF12BrowserBoundaryAndChunkSignature(t *testing.T) {
	s, admin := localUsersFixture(t)
	viewer := apiUser(t, s, "f12-viewer", false)
	instance, upload := uuid.NewString(), uuid.NewString()
	original := []byte{0, 34, 0xff, 0, 128}
	sum := sha256.Sum256(original)
	key := bytes.Repeat([]byte{17}, 32)
	dir, err := os.MkdirTemp("", "f12-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	path := filepath.Join(dir, "ctl")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	var finishes atomic.Int32
	host := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		meta := data
		chunk := r.URL.Path == "/v1/f12/stream"
		if chunk {
			meta, _ = base64.StdEncoding.DecodeString(r.Header.Get("X-Pl-Transport-Meta"))
		}
		mac := hmac.New(sha256.New, key)
		mac.Write([]byte(r.Header.Get("X-Pl-Timestamp") + "\nPOST\n" + r.URL.Path + "\n"))
		mac.Write(meta)
		if !hmac.Equal([]byte(hex.EncodeToString(mac.Sum(nil))), []byte(r.Header.Get("X-Pl-Signature"))) {
			t.Error("invalid host signature")
		}
		var req struct {
			Instance      string `json:"instance_id"`
			Actor, Action string
			Length        int    `json:"body_length"`
			Digest        string `json:"body_sha256"`
			Payload       struct {
				ID     string
				Offset int
			}
		}
		if json.Unmarshal(meta, &req) != nil || req.Instance != instance || !f12Digest.MatchString(req.Actor) || strings.Contains(string(meta), admin.cookie.Value) {
			t.Error("invalid actor or instance")
		}
		status := 200
		var body any
		switch req.Action {
		case "library":
			body = map[string]any{"items": []any{}, "segments": map[string]string{}, "secret": "should-stay-private"}
		case "upload-finish":
			if finishes.Add(1) == 1 {
				status = 202
				body = map[string]any{"id": upload, "offset": len(original), "status": "processing"}
			} else {
				body = map[string]any{"id": strings.Repeat("a", 64), "name": "finish.iso", "size": len(original), "segments": []string{}, "recipe": "library"}
			}
		case "upload-chunk":
			if !bytes.Equal(data, original) || !chunk || req.Digest != hex.EncodeToString(sum[:]) || req.Length != len(original) || req.Payload.ID != upload || req.Payload.Offset != 7 {
				t.Error("signed offset, digest, length or file bytes changed")
			}
			body = map[string]any{"id": upload, "offset": 7 + len(original)}
		default:
			t.Errorf("unexpected action %q", req.Action)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"instance_id": instance, "status": status, "body": body})
	}))
	host.Listener.Close()
	host.Listener = listener
	host.Start()
	t.Cleanup(host.Close)
	keyPath := filepath.Join(dir, "key")
	if err = os.WriteFile(keyPath, key, 0600); err != nil {
		t.Fatal(err)
	}
	ctl, err := modules.NewHostController(path, keyPath)
	if err != nil {
		t.Fatal(err)
	}
	s.Modules = modules.New(s.Store, ctl)
	record := model.ModuleInstance{ID: instance, ModuleID: "f12", Mode: "local", DesiredState: "enabled", ObservedState: "running"}
	if _, err = s.Store.Save(context.Background(), "module_instance", instance, 0, record, "test"); err != nil {
		t.Fatal(err)
	}
	base := "/api/v1/modules/" + instance + "/f12/"
	if w := apiCall(s, viewer, "GET", base+"library", nil, nil); w.Code != 403 {
		t.Fatalf("viewer %d", w.Code)
	}
	if w := apiCall(s, admin, "GET", base+"library", nil, nil); w.Code != 200 || strings.Contains(w.Body.String(), "secret") {
		t.Fatalf("library %d %s", w.Code, w.Body)
	}
	if w := apiCall(s, admin, "GET", base+"menu?segment=x&segment=y", nil, nil); w.Code != 400 {
		t.Fatalf("duplicate query %d", w.Code)
	}
	upath := base + "uploads/" + upload
	if w := apiCall(s, admin, "PUT", upath, map[string]any{"name": "../a.iso", "size": 10, "segments": []string{}}, nil); w.Code != 400 {
		t.Fatalf("filename %d", w.Code)
	}
	if w := apiCall(s, admin, "POST", upath+"/complete", map[string]any{}, map[string]string{"X-CSRF-Token": "wrong"}); w.Code != 403 {
		t.Fatalf("CSRF %d", w.Code)
	}
	if w := apiCall(s, admin, "POST", upath+"/complete", map[string]any{}, nil); w.Code != 202 || !strings.Contains(w.Body.String(), "processing") {
		t.Fatalf("finish %d", w.Code)
	}
	for range 2 {
		if w := apiCall(s, admin, "POST", upath+"/complete", map[string]any{}, nil); w.Code != 200 {
			t.Fatalf("complete %d %s", w.Code, w.Body)
		}
	}
	var recorded int
	if err = s.Store.Pool.QueryRow(context.Background(), "select count(*) from audit_events where body->>'kind'='f12.upload'").Scan(&recorded); err != nil || recorded != 1 {
		t.Fatalf("upload audit count %d: %v", recorded, err)
	}
	send := func(offset string, length int64, status int) {
		r := httptest.NewRequest("PUT", s.Config.PublicURL+upath+"/chunks/"+offset, bytes.NewReader(original))
		r.ContentLength = length
		r.AddCookie(admin.cookie)
		r.Header.Set("X-CSRF-Token", admin.csrf)
		r.Header.Set("Content-Type", "application/octet-stream")
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Code != status {
			t.Errorf("chunk at %s: status %d, want %d", offset, w.Code, status)
		}
	}
	send("07", int64(len(original)), 400)
	send("7", modules.F12ChunkLimit+1, 413)
	send("7", int64(len(original)), 200)
	if _, err = s.Store.Pool.Exec(context.Background(), "DELETE FROM sessions WHERE token_hash=$1", hash(admin.cookie.Value)); err != nil {
		t.Fatal(err)
	}
	send("7", int64(len(original)), 401)
}

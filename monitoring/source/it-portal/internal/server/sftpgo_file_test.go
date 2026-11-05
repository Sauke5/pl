package server

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"pl/portal/internal/modules"
)

func sftpgoFileTestHandler(t *testing.T, s *Server) http.Handler {
	t.Helper()
	spool, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Chmod(spool, 0700); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	for _, method := range []string{http.MethodPut, http.MethodGet} {
		mux.HandleFunc(method+" /api/v1/modules/{id}/sftpgo/files/content", s.auth(func(w http.ResponseWriter, r *http.Request) {
			s.sftpgoFileWithSpool(w, r, spool)
		}, false))
	}
	return mux
}

func sftpgoFileTestRequest(s *Server, who apiIdentity, method, target string, body []byte) *http.Request {
	request := httptest.NewRequest(method, s.Config.PublicURL+target, bytes.NewReader(body))
	request.AddCookie(who.cookie)
	request.Header.Set("Origin", s.Config.PublicURL)
	request.Header.Set("X-CSRF-Token", who.csrf)
	request.Header.Set("Idempotency-Key", "file-upload:fixture")
	request.Header.Set("Content-Type", "application/octet-stream")
	return request
}

func TestSFTPGoNonemptyUploadReachesSignedModuleTransport(t *testing.T) {
	payload := bytes.Repeat([]byte("x"), 512)
	var calls atomic.Int32
	var expectedInstance atomic.Value
	s, instance := sftpgoAPIFixture(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		metadata, err := base64.StdEncoding.DecodeString(r.Header.Get("X-Pl-Transport-Meta"))
		var request struct {
			InstanceID string              `json:"instance_id"`
			Action     string              `json:"action"`
			Actor      modules.SFTPGoActor `json:"actor"`
			Payload    map[string]string   `json:"payload"`
			Length     int64               `json:"body_length"`
			Digest     string              `json:"body_sha256"`
		}
		if err != nil || json.Unmarshal(metadata, &request) != nil {
			t.Error("invalid signed stream metadata")
			http.Error(w, "invalid metadata", 400)
			return
		}
		mac := hmac.New(sha256.New, bytes.Repeat([]byte{7}, 32))
		mac.Write([]byte(r.Header.Get("X-Pl-Timestamp") + "\nPOST\n/v1/sftpgo/stream\n"))
		mac.Write(metadata)
		body, err := io.ReadAll(io.LimitReader(r.Body, 513))
		digest := sha256.Sum256(payload)
		if r.Method != "POST" || r.URL.Path != "/v1/sftpgo/stream" ||
			r.Header.Get("X-Pl-Signature") != hex.EncodeToString(mac.Sum(nil)) ||
			r.Header.Get("Content-Type") != "application/octet-stream" ||
			request.Action != "file-upload" || request.InstanceID != expectedInstance.Load() ||
			request.Payload["path"] != "/folder/upload.bin" || request.Length != 512 || r.ContentLength != 512 ||
			request.Digest != hex.EncodeToString(digest[:]) || request.Actor.Subject != "upload-viewer" || request.Actor.Admin ||
			err != nil || !bytes.Equal(body, payload) {
			t.Error("upload did not preserve the signed actor/path/length/digest/body contract")
			http.Error(w, "invalid upload", 400)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	expectedInstance.Store(instance.ID)
	viewer := apiUser(t, s, "upload-viewer", false)
	handler := sftpgoFileTestHandler(t, s)
	request := sftpgoFileTestRequest(s, viewer, "PUT", "/api/v1/modules/"+instance.ID+"/sftpgo/files/content?path=%2Ffolder%2Fupload.bin", payload)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != 204 || calls.Load() != 1 {
		t.Fatalf("nonempty upload rejected before module transport: status=%d calls=%d body=%s", response.Code, calls.Load(), response.Body.String())
	}
}

func TestSFTPGoFileInputRejectionsDoNotReachModuleTransport(t *testing.T) {
	var calls atomic.Int32
	s, instance := sftpgoAPIFixture(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(204)
	})
	viewer := apiUser(t, s, "upload-viewer", false)
	handler := sftpgoFileTestHandler(t, s)
	base := "/api/v1/modules/" + instance.ID + "/sftpgo/files/content"
	for _, tc := range []struct {
		name   string
		method string
		query  string
		status int
		mutate func(*http.Request)
	}{
		{"traversal", "PUT", "path=%2Ffolder%2F..%2Fsecret", 400, nil},
		{"duplicate", "PUT", "path=%2Fa&path=%2Fb", 400, nil},
		{"unknown", "PUT", "path=%2Fa&other=true", 400, nil},
		{"missing", "PUT", "directory=%2Fa", 400, nil},
		{"empty", "PUT", "path=", 400, nil},
		{"utf8", "PUT", "path=%2F%FF", 400, nil},
		{"escape", "PUT", "path=%ZZ", 400, nil},
		{"nul", "PUT", "path=%2Fa%00", 400, nil},
		{"raw-query-limit", "PUT", "path=%2F" + strings.Repeat("a", 8193), 400, nil},
		{"raw-path", "PUT", "path=%2Fa", 400, func(r *http.Request) { r.URL.RawPath = strings.Replace(r.URL.Path, "/content", "/%63ontent", 1) }},
		{"force-query", "PUT", "path=%2Fa", 400, func(r *http.Request) { r.URL.ForceQuery = true }},
		{"get-body", "GET", "path=%2Fa", 400, nil},
		{"head-body", "HEAD", "path=%2Fa", 400, nil},
		{"chunked", "PUT", "path=%2Fa", 400, func(r *http.Request) { r.TransferEncoding = []string{"chunked"} }},
		{"unknown-length", "PUT", "path=%2Fa", 413, func(r *http.Request) { r.ContentLength = -1 }},
		{"oversized", "PUT", "path=%2Fa", 413, func(r *http.Request) { r.ContentLength = (1 << 30) + 1 }},
		{"incomplete", "PUT", "path=%2Fa", 400, func(r *http.Request) { r.ContentLength = 513 }},
		{"encoded", "PUT", "path=%2Fa", 415, func(r *http.Request) { r.Header.Set("Content-Encoding", "gzip") }},
		{"csrf", "PUT", "path=%2Fa", 403, func(r *http.Request) { r.Header.Set("X-CSRF-Token", "wrong") }},
		{"idempotency", "PUT", "path=%2Fa", 400, func(r *http.Request) { r.Header.Del("Idempotency-Key") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := sftpgoFileTestRequest(s, viewer, tc.method, base+"?"+tc.query, bytes.Repeat([]byte("x"), 512))
			if tc.mutate != nil {
				tc.mutate(request)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != tc.status {
				t.Fatalf("invalid transfer input status=%d want=%d: %s", response.Code, tc.status, response.Body.String())
			}
		})
	}
	if calls.Load() != 0 {
		t.Fatal("rejected upload reached module transport")
	}
}

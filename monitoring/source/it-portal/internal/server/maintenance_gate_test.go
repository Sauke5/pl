package server

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestMaintenanceGateProtectsWritesAndLogoutUntilCommit(t *testing.T) {
	folder := t.TempDir()
	s := &Server{Config: Config{PortableRelease: true, MaintenanceDir: folder}}
	var calls atomic.Int32
	h := s.maintenanceGate(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(204) }))
	if err := os.WriteFile(filepath.Join(folder, "active"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/v1/resources", "/forms/api/submit", "/auth/logout", "/api/v1/local-admin/password"} {
		r := httptest.NewRequest(http.MethodPost, path, strings.NewReader("{}"))
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 503 || w.Header().Get("Retry-After") != "2" || !strings.Contains(w.Body.String(), "installation_maintenance") {
			t.Fatalf("write admitted: %s %d", path, w.Code)
		}
	}
	if calls.Load() != 0 {
		t.Fatal("a blocked write reached the application")
	}
	for _, request := range []struct{ method, path string }{{"GET", "/api/v1/session"}, {"POST", "/api/v1/delivery/recover"}, {"POST", "/api/v1/delivery/upgrade"}} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(request.method, request.path, nil))
		if w.Code != 204 {
			t.Fatal("finite control or read path was blocked", request)
		}
	}
	if err := os.Remove(filepath.Join(folder, "active")); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("POST", "/api/v1/resources", nil))
	if w.Code != 204 {
		t.Fatal("application writes did not resume after commit")
	}
	if err := os.Mkdir(filepath.Join(folder, "active"), 0700); err != nil {
		t.Fatal(err)
	}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("POST", "/api/v1/resources", nil))
	if w.Code != 503 {
		t.Fatal("invalid maintenance marker did not fail closed")
	}
}

func TestMaintenanceBackendRejectsRequestBufferedAcrossUpdate(t *testing.T) {
	nginx, err := exec.LookPath("nginx")
	if err != nil {
		t.Skip("native nginx is required for the buffered-request regression")
	}
	folder := t.TempDir()
	s := &Server{Config: Config{PortableRelease: true, MaintenanceDir: folder}}
	var writes atomic.Int32
	backend := httptest.NewServer(s.maintenanceGate(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		writes.Add(1)
		w.WriteHeader(200)
	})))
	defer backend.Close()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	listener.Close()
	configuration := fmt.Sprintf("pid %s; error_log %s; events {} http { access_log off; client_body_temp_path %s; proxy_temp_path %s; fastcgi_temp_path %s; uwsgi_temp_path %s; scgi_temp_path %s; server { listen %s; location /api/ { proxy_request_buffering on; proxy_pass %s; } } }",
		strconv.Quote(filepath.Join(folder, "nginx.pid")), strconv.Quote(filepath.Join(folder, "nginx.log")),
		strconv.Quote(filepath.Join(folder, "body")), strconv.Quote(filepath.Join(folder, "proxy")),
		strconv.Quote(filepath.Join(folder, "fastcgi")), strconv.Quote(filepath.Join(folder, "uwsgi")),
		strconv.Quote(filepath.Join(folder, "scgi")), address, backend.URL)
	config := filepath.Join(folder, "nginx.conf")
	if err = os.WriteFile(config, []byte(configuration), 0600); err != nil {
		t.Fatal(err)
	}
	command := exec.Command(nginx, "-p", folder, "-c", config, "-g", "daemon off;")
	var diagnostics bytes.Buffer
	command.Stderr = &diagnostics
	if err = command.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { command.Process.Signal(os.Interrupt); command.Wait() }()
	var connection net.Conn
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		connection, err = net.DialTimeout("tcp", address, 100*time.Millisecond)
		if err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err != nil {
		output, _ := os.ReadFile(filepath.Join(folder, "nginx.log"))
		t.Fatalf("nginx did not start: %v %s %s", err, output, diagnostics.String())
	}
	defer connection.Close()
	connection.SetDeadline(time.Now().Add(5 * time.Second))
	fmt.Fprintf(connection, "PUT /api/v1/resources HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n%s", strings.Repeat("a", 100))
	if writes.Load() != 0 {
		t.Fatal("Nginx forwarded an incomplete buffered request")
	}
	if err = os.WriteFile(filepath.Join(folder, "active"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = io.WriteString(connection, strings.Repeat("b", 900)); err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(connection), &http.Request{Method: http.MethodPut})
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 503 || writes.Load() != 0 {
		t.Fatalf("buffered pre-update write was accepted after restart: status=%d writes=%d", response.StatusCode, writes.Load())
	}
}

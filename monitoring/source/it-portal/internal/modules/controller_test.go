package modules

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestControllerSignsExactPayloadAndReusesOperationID(t *testing.T) {
	dir, err := os.MkdirTemp("", "plhost-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	socket := filepath.Join(dir, "host.sock")
	keyFile := filepath.Join(dir, "host.key")
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 1)
	}
	if err := os.WriteFile(keyFile, key, 0600); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string][]byte{}
	count := 0
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mac := hmac.New(sha256.New, key)
		mac.Write([]byte(r.Header.Get("X-Pl-Timestamp") + "\n" + r.Method + "\n" + r.URL.RequestURI() + "\n"))
		mac.Write(body)
		if r.Header.Get("X-Pl-Signature") != hex.EncodeToString(mac.Sum(nil)) {
			t.Error("invalid signature")
		}
		if r.URL.Path != "/v1/operations" || r.Method != "POST" {
			t.Error("unexpected request")
		}
		var op Operation
		if json.Unmarshal(body, &op) != nil {
			t.Error("invalid payload")
		}
		if old, ok := seen[op.OperationID]; ok && string(old) != string(body) {
			t.Error("recovery changed operation payload")
		}
		seen[op.OperationID] = body
		count++
		json.NewEncoder(w).Encode(Observation{State: "running", OperationID: op.OperationID, Version: "3.15.0"})
	})}
	go server.Serve(listener)
	t.Cleanup(func() { server.Close() })
	client, err := NewHostController(socket, keyFile)
	if err != nil {
		t.Fatal(err)
	}
	op := Operation{OperationID: "operation", InstanceID: "instance", ModuleID: "prometheus", Action: "install"}
	for range 2 {
		out, e := client.Apply(context.Background(), op)
		if e != nil || out.State != "running" {
			t.Fatalf("controller %+v %v", out, e)
		}
	}
	if len(seen) != 1 || count != 2 {
		t.Fatal("operation identity changed")
	}
}
func TestControllerRejectsPartialConfiguration(t *testing.T) {
	if c, e := NewHostController("", ""); c != nil || e != nil {
		t.Fatalf("disabled %v %v", c, e)
	}
	for _, pair := range [][2]string{{"relative", "/key"}, {"/socket", "relative"}, {"/socket", "/missing-key"}} {
		if _, e := NewHostController(pair[0], pair[1]); e == nil {
			t.Fatal("accepted incomplete controller config")
		}
	}
}

func controllerFixture(t *testing.T, handler http.HandlerFunc) *HostController {
	t.Helper()
	dir, err := os.MkdirTemp("", "plhost-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	keyFile := filepath.Join(dir, "host.key")
	if err = os.WriteFile(keyFile, make([]byte, 32), 0600); err != nil {
		t.Fatal(err)
	}
	socket := filepath.Join(dir, "host.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: handler}
	go server.Serve(listener)
	t.Cleanup(func() { server.Close() })
	client, err := NewHostController(socket, keyFile)
	if err != nil {
		t.Fatal(err)
	}
	return client
}
func TestControllerClientTimeoutPreservesUnknownResult(t *testing.T) {
	for _, phase := range []string{"headers", "body"} {
		t.Run(phase, func(t *testing.T) {
			client := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
				if phase == "body" {
					w.WriteHeader(200)
					w.(http.Flusher).Flush()
				}
				time.Sleep(100 * time.Millisecond)
				json.NewEncoder(w).Encode(Observation{State: "running", OperationID: "operation"})
			})
			client.client.Timeout = 10 * time.Millisecond
			ctx := context.Background()
			_, err := client.Apply(ctx, Operation{OperationID: "operation", Action: "install"})
			if ctx.Err() != nil || !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("client timeout lost unknown result classification: %v", err)
			}
			if strings.Contains(err.Error(), "module-controller") {
				t.Fatal("transport internals leaked")
			}
		})
	}
}

func TestControllerSurfacesBoundedNormalizedPreflightError(t *testing.T) {
	client := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(Observation{State: "error", OperationID: "operation", Error: "  Недостаточно места\nдля установки\x1b\t" + strings.Repeat("я", 300)})
	})
	_, err := client.Apply(context.Background(), Operation{OperationID: "operation", Action: "install"})
	if err == nil || !strings.HasPrefix(err.Error(), "Недостаточно места для установки") || strings.ContainsAny(err.Error(), "\n\r\t\x1b") || len([]rune(err.Error())) > 256 {
		t.Fatalf("invalid normalized error: %v", err)
	}
}

package modules

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

func TestNativeApplicationKeysSeparateInstancesAndPurposes(t *testing.T) {
	c := &HostController{key: bytes.Repeat([]byte{7}, 32)}
	id := "123e4567-e89b-42d3-a456-426614174000"
	forms, err := c.ApplicationKey(id, "forms")
	if err != nil {
		t.Fatal(err)
	}
	doska, err := c.ApplicationKey(id, "doska")
	if err != nil {
		t.Fatal(err)
	}
	other, err := c.ApplicationKey("223e4567-e89b-42d3-a456-426614174000", "doska")
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(forms, doska) || bytes.Equal(doska, other) || bytes.Equal(doska, c.key) {
		t.Fatal("application key domain separation failed")
	}
	for _, kind := range []string{"", "database", "forms\ndoska"} {
		if _, err := c.ApplicationKey(id, kind); err == nil {
			t.Fatal("accepted unknown application")
		}
	}
}

func TestFormsApplicationReaderUsesThreeMiBByteBoundary(t *testing.T) {
	document := []byte("{\n\"title\":\"Анкета 😀\"\n}")
	for _, length := range []int{(128 << 10) + 1, 3 << 20, (3 << 20) + 1} {
		body := append(bytes.Clone(document), bytes.Repeat([]byte("\n"), length-len(document))...)
		read, err := readFormsApplicationBody(bytes.NewReader(body))
		if length > 3<<20 {
			if err == nil || read != nil {
				t.Fatal("accepted more than 3 MiB")
			}
		} else if err != nil || !bytes.Equal(read, body) {
			t.Fatalf("changed/rejected UTF-8 body at %d bytes: %v", length, err)
		}
	}
	if body, err := readFormsApplicationBody(nil); err != nil || len(body) != 0 {
		t.Fatal("empty Forms read rejected", err)
	}
}

func TestFormsThreeMiBBase64RPCRemainsAuthenticatedAndUnchanged(t *testing.T) {
	body := []byte("{\n\"title\":\"Анкета\"\n}")
	body = append(body, bytes.Repeat([]byte("\n"), (3<<20)-len(body))...)
	payload, err := json.Marshal(map[string]any{"instance_id": "123e4567-e89b-42d3-a456-426614174000",
		"method": "POST", "path": "/forms/api/v1/surveys", "query": "", "content_type": "application/json",
		"body": base64.StdEncoding.EncodeToString(body), "headers": map[string]string{"X-CSRF-Token": "derived"}})
	if err != nil || len(payload) <= 4<<20 || len(payload) > 5<<20 {
		t.Fatal("unexpected base64 envelope budget", len(payload), err)
	}
	var calls atomic.Int32
	client := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		actual, err := io.ReadAll(r.Body)
		mac := hmac.New(sha256.New, make([]byte, 32))
		mac.Write([]byte(r.Header.Get("X-Pl-Timestamp") + "\nPOST\n/v1/forms/request\n"))
		mac.Write(payload)
		if err != nil || !bytes.Equal(actual, payload) || r.ContentLength != int64(len(payload)) ||
			r.Header.Get("X-Pl-Signature") != hex.EncodeToString(mac.Sum(nil)) || len(r.TransferEncoding) != 0 {
			t.Error("Forms RPC changed signed envelope or framing")
		}
		w.WriteHeader(http.StatusNoContent)
	})
	response, err := client.applicationRequest(context.Background(), "/v1/forms/request", payload, bytes.NewReader(payload), int64(len(payload)), false)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent || calls.Load() != 1 {
		t.Fatal("Forms RPC failed or replayed")
	}
}

func TestRawApplicationTransportBindsMetadataAndStreamsOriginalBody(t *testing.T) {
	metadata := []byte(`{"body_length":7,"body_sha256":"bound-digest"}`)
	client := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
		decoded, err := base64.StdEncoding.Strict().DecodeString(r.Header.Get("X-Pl-Transport-Meta"))
		if err != nil || !bytes.Equal(decoded, metadata) {
			t.Error("metadata changed")
		}
		mac := hmac.New(sha256.New, make([]byte, 32))
		mac.Write([]byte(r.Header.Get("X-Pl-Timestamp") + "\nPOST\n/v1/doska/transport\n"))
		mac.Write(metadata)
		if r.Header.Get("X-Pl-Signature") != hex.EncodeToString(mac.Sum(nil)) {
			t.Error("metadata not authenticated")
		}
		body, _ := io.ReadAll(r.Body)
		if string(body) != "payload" || r.ContentLength != 7 || r.Header.Get("Content-Length") != "7" || len(r.TransferEncoding) != 0 || r.Header.Get("Content-Type") != "application/octet-stream" {
			t.Error("raw request framing changed")
		}
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":"native ACL"}`))
	})
	res, err := client.applicationRequest(context.Background(), "/v1/doska/transport", metadata, bytes.NewBufferString("payload"), 7, true)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatal("native error status replaced")
	}
}

func TestEmptyApplicationRPCUsesExplicitZeroLengthOnWire(t *testing.T) {
	metadata := []byte(`{"body_length":0,"body_sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}`)
	for _, tc := range []struct {
		name string
		body func() io.Reader
	}{
		{"wrapped-empty", func() io.Reader { return io.NopCloser(strings.NewReader("")) }},
		{"limited-empty", func() io.Reader { return io.LimitReader(strings.NewReader(""), 0) }},
		{"nil", func() io.Reader { return nil }},
		{"no-body", func() io.Reader { return http.NoBody }},
		{"empty-buffer", func() io.Reader { return bytes.NewBuffer(nil) }},
		{"empty-reader", func() io.Reader { return strings.NewReader("") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			client := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				// Exercise actual net/http serialization and server parsing over the
				// fixture Unix socket, including the controller's chunked-body gate.
				if r.Method != "POST" || r.URL.Path != "/v1/doska/transport" ||
					r.ContentLength != 0 || r.Header.Get("Content-Length") != "0" || len(r.TransferEncoding) != 0 {
					t.Error("empty RPC was not framed with explicit Content-Length: 0")
					http.Error(w, "invalid framing", 400)
					return
				}
				decoded, err := base64.StdEncoding.Strict().DecodeString(r.Header.Get("X-Pl-Transport-Meta"))
				mac := hmac.New(sha256.New, make([]byte, 32))
				mac.Write([]byte(r.Header.Get("X-Pl-Timestamp") + "\nPOST\n/v1/doska/transport\n"))
				mac.Write(metadata)
				body, readErr := io.ReadAll(r.Body)
				if err != nil || !bytes.Equal(decoded, metadata) || r.Header.Get("X-Pl-Signature") != hex.EncodeToString(mac.Sum(nil)) ||
					r.Header.Get("Content-Type") != "application/octet-stream" || readErr != nil || len(body) != 0 {
					t.Error("empty RPC changed signed metadata or body")
					http.Error(w, "invalid metadata", 400)
					return
				}
				w.WriteHeader(http.StatusNoContent)
			})
			response, err := client.applicationRequest(context.Background(), "/v1/doska/transport", metadata, tc.body(), 0, true)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode != http.StatusNoContent || calls.Load() != 1 {
				t.Fatalf("empty RPC rejected or replayed: status=%d calls=%d", response.StatusCode, calls.Load())
			}
		})
	}
}

func TestControllerObserveAuthenticatesFreshInstanceRead(t *testing.T) {
	id := "123e4567-e89b-42d3-a456-426614174000"
	client := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/instances/"+id {
			t.Error("wrong readiness route")
		}
		mac := hmac.New(sha256.New, make([]byte, 32))
		mac.Write([]byte(r.Header.Get("X-Pl-Timestamp") + "\nGET\n" + r.URL.Path + "\n"))
		if r.Header.Get("X-Pl-Signature") != hex.EncodeToString(mac.Sum(nil)) {
			t.Error("unsigned readiness read")
		}
		_ = json.NewEncoder(w).Encode(Observation{State: "running", Version: "1", Endpoint: "http://127.0.0.1:31234"})
	})
	if observed, err := client.Observe(context.Background(), id); err != nil || observed.State != "running" {
		t.Fatalf("observe: %+v %v", observed, err)
	}
	if _, err := client.Observe(context.Background(), "../foreign"); err == nil {
		t.Fatal("accepted noncanonical instance")
	}
}

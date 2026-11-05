//go:build optional_module_acceptance

package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

// This opt-in test is a finite real Gateway -> real Doska chain. Doska's owner
// starts a disposable API/DB seeded with the documented fixture subject/project.
// It creates only test sessions in apiFixture's isolated schema, never AD login,
// production cookies, a debug auth route, or a production signer endpoint.
//
// PORTAL_TEST_DATABASE_URL must name a SEPARATE disposable Platform database.
// DOSKA_TEST_API_URL=http://127.0.0.1:<port> (actual Doska HTTP listener)
// DOSKA_TEST_PUBLIC_URL=http://127.0.0.1:18080 (gateway's exact listener/origin)
// DOSKA_TEST_KEY_FILE=/absolute/test-only-raw32-file
// DOSKA_TEST_PROJECT_ID / DOSKA_TEST_TASK_ID (backend fixture, safe IDs)
func TestDoskaAttachmentGatewayExternal(t *testing.T) {
	raw := os.Getenv("DOSKA_TEST_API_URL")
	if raw == "" {
		t.Fatal("DOSKA_TEST_API_URL required for actual disposable Doska chain")
	}
	loopbackOrigin := func(raw string) *url.URL {
		t.Helper()
		u, e := url.Parse(raw)
		if e != nil || u.Scheme != "http" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.Port() == "" || !net.ParseIP(u.Hostname()).IsLoopback() {
			t.Fatal("external fixture requires an explicit loopback HTTP origin")
		}
		return u
	}
	api := loopbackOrigin(raw)
	publicRaw := os.Getenv("DOSKA_TEST_PUBLIC_URL")
	if publicRaw == "" {
		publicRaw = "http://127.0.0.1:18080"
	}
	public := loopbackOrigin(publicRaw)
	// Avoid touching another DB silently: only local PostgreSQL fixture input is
	// accepted. apiFixture creates and drops its OWN unique schema, never public.
	db, e := url.Parse(os.Getenv("PORTAL_TEST_DATABASE_URL"))
	if e != nil || (db.Scheme != "postgres" && db.Scheme != "postgresql") || !net.ParseIP(db.Hostname()).IsLoopback() || db.Path == "" {
		t.Fatal("explicit loopback disposable Platform DB required")
	}
	key, e := doskaReadFile(os.Getenv("DOSKA_TEST_KEY_FILE"), 32)
	if e != nil || len(key) != 32 {
		t.Fatal("test-only raw32 key file required")
	}
	project, task := os.Getenv("DOSKA_TEST_PROJECT_ID"), os.Getenv("DOSKA_TEST_TASK_ID")
	if !gatewaySafeID.MatchString(project) || !gatewaySafeID.MatchString(task) {
		t.Fatal("safe project/task fixture IDs required")
	}
	s := apiFixture(t)
	s.Config.PublicURL = public.String()
	user, sub := attachmentIdentity(t, s)
	g, e := s.newDoskaGateway(DoskaGatewayConfig{APIUpstream: api.String(), WebUpstream: api.String(), Key: key, Manifest: attachmentManifest(), Transport: &http.Transport{Proxy: nil, DisableCompression: true, ResponseHeaderTimeout: 5 * time.Second}, Attachments: &DoskaAttachmentConfig{SpoolDirectory: privateTemp(t)}})
	if e != nil {
		t.Fatal(e)
	}
	// Test-only shortened positive lease, set before any concurrent request.
	g.files.lease = 100 * time.Millisecond
	t.Cleanup(func() { g.Close() })
	listener, e := net.Listen("tcp", public.Host)
	if e != nil {
		t.Fatal("fixture gateway port unavailable: ", e)
	}
	gateway := httptest.NewUnstartedServer(g)
	gateway.Listener.Close()
	gateway.Listener = listener
	gateway.Start()
	t.Cleanup(gateway.Close)
	client := &http.Client{Timeout: 30 * time.Second}
	defer client.CloseIdleConnections()
	base := "/doska/api/doska/projects/" + project + "/tasks/" + task
	call := func(method, path, contentType string, body []byte) []byte {
		t.Helper()
		r, e := http.NewRequest(method, public.String()+base+path, bytes.NewReader(body))
		if e != nil {
			t.Fatal(e)
		}
		r.AddCookie(user.cookie)
		r.Header.Set("Origin", public.String())
		r.Header.Set("X-CSRF-Token", user.csrf)
		if contentType != "" {
			r.Header.Set("Content-Type", contentType)
		}
		response, e := client.Do(r)
		if e != nil {
			t.Fatal(e)
		}
		defer response.Body.Close()
		data, e := io.ReadAll(io.LimitReader(response.Body, doskaFileLimit+1))
		if e != nil {
			t.Fatal(e)
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			t.Fatalf("%s %s: status%d %.4096s", method, path, response.StatusCode, data)
		}
		return data
	}
	payload := bytes.Repeat([]byte("x"), int(doskaFileLimit))
	digest := sha256.Sum256(payload)
	reserve, _ := json.Marshal(map[string]any{"filename": "gateway-fixture.txt", "size": len(payload), "sha256": hex.EncodeToString(digest[:]), "clientRequestId": randomToken()})
	var ticket struct {
		UploadID string `json:"id"`
	}
	if e = json.Unmarshal(call("POST", "/attachment-uploads", "application/json", reserve), &ticket); e != nil || !gatewaySafeID.MatchString(ticket.UploadID) {
		t.Fatal("invalid reserve response: ", e)
	}
	call("PUT", "/attachment-uploads/"+ticket.UploadID+"/content", "application/octet-stream", payload)
	var published struct {
		ID string `json:"id"`
	}
	if e = json.Unmarshal(call("POST", "/attachment-uploads/"+ticket.UploadID+"/finalize", "application/json", []byte(`{}`)), &published); e != nil || !gatewaySafeID.MatchString(published.ID) {
		t.Fatal("invalid finalize response: ", e)
	}

	downloaded := call("GET", "/attachments/"+published.ID+"/content", "", nil)
	if !bytes.Equal(downloaded, payload) {
		t.Fatal("actual gateway/backend bytes changed")
	}

	// A second pending ticket exercises an actual chunked +1 byte browser body.
	// No declared Content-Length shortcut is available to the gateway here.
	reserve, _ = json.Marshal(map[string]any{"filename": "gateway-overlimit.txt", "size": len(payload), "sha256": hex.EncodeToString(digest[:]), "clientRequestId": randomToken()})
	var overflow struct {
		ID string `json:"id"`
	}
	if e = json.Unmarshal(call("POST", "/attachment-uploads", "application/json", reserve), &overflow); e != nil || !gatewaySafeID.MatchString(overflow.ID) {
		t.Fatal("invalid overflow reserve response", e)
	}
	oversized, e := http.NewRequest("PUT", public.String()+base+"/attachment-uploads/"+overflow.ID+"/content", io.MultiReader(bytes.NewReader(payload), strings.NewReader("x")))
	if e != nil {
		t.Fatal(e)
	}
	oversized.ContentLength = -1
	oversized.AddCookie(user.cookie)
	oversized.Header.Set("Origin", public.String())
	oversized.Header.Set("X-CSRF-Token", user.csrf)
	oversized.Header.Set("Content-Type", "application/octet-stream")
	overflowResponse, e := client.Do(oversized)
	if e != nil {
		t.Fatal(e)
	}
	overflowBody, e := io.ReadAll(overflowResponse.Body)
	overflowResponse.Body.Close()
	if e != nil || overflowResponse.StatusCode != 413 || !bytes.Contains(overflowBody, []byte("gateway_body_limit")) {
		t.Fatalf("actual chunked +1 boundary status%d err%v %.1024s", overflowResponse.StatusCode, e, overflowBody)
	}
	call("DELETE", "/attachment-uploads/"+overflow.ID, "", nil)

	// Explicit opt-in only for the disposable owner's loopback fixture controls.
	// These endpoints exist in the external fixture, never in the Portal router.
	if os.Getenv("DOSKA_TEST_ACL_CONTROL") == "true" {
		control := func(action string) {
			t.Helper()
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			request, e := http.NewRequestWithContext(ctx, "POST", api.String()+"/__fixture/"+action, nil)
			if e != nil {
				t.Fatal(e)
			}
			response, e := client.Do(request)
			if e != nil {
				t.Fatal("fixture control failed", action, e)
			}
			io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
			response.Body.Close()
			if response.StatusCode != 200 {
				t.Fatal("fixture control rejected", action, response.StatusCode)
			}
		}
		aclRequest, e := http.NewRequest("GET", public.String()+base+"/attachments/"+published.ID+"/content", nil)
		if e != nil {
			t.Fatal(e)
		}
		aclRequest.AddCookie(user.cookie)
		aclResponse, e := client.Do(aclRequest)
		if e != nil {
			t.Fatal(e)
		}
		if aclResponse.StatusCode != 200 {
			aclResponse.Body.Close()
			t.Fatal("ACL probe did not start download", aclResponse.StatusCode)
		}
		if _, e = io.ReadFull(aclResponse.Body, make([]byte, 8192)); e != nil {
			aclResponse.Body.Close()
			t.Fatal(e)
		}
		// Keep the actual browser socket unread while both sides remain bounded by
		// backpressure. The backend gets its production <=5s ACL lease to expire.
		revoked := true
		defer func() {
			if revoked {
				control("restore-access")
			}
		}()
		control("revoke-access")
		time.Sleep(5500 * time.Millisecond)
		remainder, aclError := io.ReadAll(aclResponse.Body)
		aclResponse.Body.Close()
		control("restore-access")
		revoked = false
		if aclError == nil || int64(len(remainder))+8192 >= doskaFileLimit {
			t.Fatal("backend ACL revoke did not interrupt actual cross-app download", aclError, len(remainder))
		}
		if restored := call("GET", "/attachments/"+published.ID+"/content", "", nil); !bytes.Equal(restored, payload) {
			t.Fatal("restored ACL did not restore download")
		}
		t.Log("actual Gateway -> Doska in-flight backend ACL revoke aborted the stream; restored access and full bytes verified")
	}
	// Shorten ONLY the local test lease. Pause browser body reads so the 25 MiB
	// response remains in flight beyond socket buffers while the DB session is
	// actually deleted. This is a real session revoke, not a verifier stub.
	logoutRequest, e := http.NewRequest("GET", public.String()+base+"/attachments/"+published.ID+"/content", nil)
	if e != nil {
		t.Fatal(e)
	}
	logoutRequest.AddCookie(user.cookie)
	logoutResponse, e := client.Do(logoutRequest)
	if e != nil {
		t.Fatal(e)
	}
	if logoutResponse.StatusCode != 200 {
		t.Fatal("logout probe did not start download", logoutResponse.StatusCode)
	}
	if _, e = io.ReadFull(logoutResponse.Body, make([]byte, 8192)); e != nil {
		logoutResponse.Body.Close()
		t.Fatal(e)
	}
	if _, e = s.Store.Pool.Exec(context.Background(), "DELETE FROM sessions WHERE user_id=$1", sub); e != nil {
		logoutResponse.Body.Close()
		t.Fatal(e)
	}
	time.Sleep(200 * time.Millisecond)
	remainder, e := io.ReadAll(logoutResponse.Body)
	logoutResponse.Body.Close()
	if e == nil || int64(len(remainder))+8192 >= doskaFileLimit {
		t.Fatal("session logout did not interrupt the actual cross-app download", e, len(remainder))
	}
	user = apiUser(t, s, sub, false)
	call("DELETE", "/attachments/"+published.ID, "", nil)
	list := string(call("GET", "/attachments?limit=100&offset=0", "", nil))
	if strings.Contains(list, published.ID) {
		t.Fatal("deleted object remains in list")
	}
	t.Logf("actual loopback Gateway -> Doska exact25MiB upload/download passed, chunked25MiB+1 rejected413, in-flight logout aborted, fixture subject %s, %d bytes, SHA256 %s; separate Platform schema/DB; gateway listener closed on test completion", sub, len(payload), fmt.Sprintf("%x", digest))
}

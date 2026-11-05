package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"pl/portal/internal/organization"
)

func attachmentManifest() DoskaGatewayManifest {
	m := doskaGatewayTestManifest()
	min1, min0, max100, maxOffset := int64(1), int64(0), int64(100), int64(10000000)
	for _, r := range []DoskaGatewayRoute{
		{Method: "GET", Path: doskaAttachmentBase + "/attachments", Kind: "read", Schema: "attachment-list-v1", Query: map[string]DoskaGatewayQuery{"limit": {Kind: "integer", Minimum: &min1, Maximum: &max100}, "offset": {Kind: "integer", Minimum: &min0, Maximum: &maxOffset}}},
		{Method: "POST", Path: doskaAttachmentBase + "/attachment-uploads", Kind: "write", Schema: "attachment-reserve-v1"},
		{Method: "PUT", Path: doskaAttachmentBase + "/attachment-uploads/{uploadId}/content", Kind: "upload", Schema: "attachment-content-v1"},
		{Method: "POST", Path: doskaAttachmentBase + "/attachment-uploads/{uploadId}/finalize", Kind: "write", Schema: "attachment-finalize-v1"},
		{Method: "DELETE", Path: doskaAttachmentBase + "/attachment-uploads/{uploadId}", Kind: "write", Schema: "attachment-empty-v1"},
		{Method: "GET", Path: doskaAttachmentBase + "/attachments/{attachmentId}/content", Kind: "download", Schema: "attachment-download-v1"},
		{Method: "DELETE", Path: doskaAttachmentBase + "/attachments/{attachmentId}", Kind: "write", Schema: "attachment-empty-v1"},
	} {
		m.Routes = append(m.Routes, r)
	}
	return m
}

const attachmentPath = "/doska/api/doska/projects/p1/tasks/t1"

var attachmentTestKey = []byte("0123456789abcdef0123456789abcdef")

func attachmentIdentity(t *testing.T, s *Server) (apiIdentity, string) {
	return attachmentIdentityGUID(t, s, 1)
}
func attachmentIdentityGUID(t *testing.T, s *Server, last byte) (apiIdentity, string) {
	t.Helper()
	now := time.Now().UTC()
	guid := make([]byte, 16)
	guid[15] = last
	sub, _ := organization.ADSubject("dc=doska-fixture,dc=test", guid)
	_, e := organization.NewStore(s.Store.Pool).SaveEmployee(context.Background(), organization.EmployeeRecord{Identity: organization.Identity{Subject: sub, Name: "Сотрудник", AccountState: organization.Active, LastSuccessAt: now}, Provider: "ad", ProviderNamespace: strings.Split(sub, ":")[1], ObjectGUID: guid}, 0, "test-sync", now)
	if e != nil {
		t.Fatal(e)
	}
	return apiUser(t, s, sub, false), sub
}
func attachmentFixture(t *testing.T, upstream http.Handler) (*Server, *doskaGateway, apiIdentity, string, *httptest.Server) {
	t.Helper()
	s := apiFixture(t)
	user, sub := attachmentIdentity(t, s)
	api := httptest.NewServer(upstream)
	t.Cleanup(api.Close)
	g, e := s.newDoskaGateway(DoskaGatewayConfig{APIUpstream: api.URL, WebUpstream: api.URL, Key: attachmentTestKey, Manifest: attachmentManifest(), Transport: http.DefaultTransport, Attachments: &DoskaAttachmentConfig{SpoolDirectory: privateTemp(t)}})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { g.Close() })
	server := httptest.NewUnstartedServer(g)
	server.Config.ReadTimeout = 15 * time.Second
	server.Start()
	t.Cleanup(server.Close)
	return s, g, user, sub, server
}
func attachmentRequest(t *testing.T, server *httptest.Server, s *Server, user apiIdentity, method, path string, body io.Reader) *http.Request {
	t.Helper()
	r, e := http.NewRequest(method, server.URL+path, body)
	if e != nil {
		t.Fatal(e)
	}
	r.AddCookie(user.cookie)
	r.Header.Set("Origin", s.Config.PublicURL)
	r.Header.Set("X-CSRF-Token", user.csrf)
	if method == "PUT" {
		r.Header.Set("Content-Type", "application/octet-stream")
	}
	return r
}
func privateTemp(t *testing.T) string {
	t.Helper()
	p, e := filepath.EvalSymlinks(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	if e := os.Chmod(p, 0700); e != nil {
		t.Fatal(e)
	}
	return p
}
func TestDoskaAttachmentManifestClosedAndSchemas(t *testing.T) {
	m := attachmentManifest()
	routes, e := compileDoskaManifest(m)
	if e != nil {
		t.Fatal(e)
	}
	for _, tc := range []struct {
		method, path string
		ok           bool
	}{
		{"GET", attachmentPath + "/attachments?limit=100&offset=10000000", true}, {"GET", attachmentPath + "/attachments?limit=101", false}, {"GET", attachmentPath + "/attachments?offset=10000001", false}, {"GET", attachmentPath + "/attachments?limit=0", false}, {"GET", attachmentPath + "/attachments?limit=1&limit=2", false},
		{"HEAD", attachmentPath + "/attachments/a/content", false}, {"PUT", attachmentPath + "/attachment-uploads/u/content?sha256=x", false}, {"POST", "/doska/api/task/draft-upload/p1", false},
	} {
		_, ok := doskaMatchRoute(routes, httptest.NewRequest(tc.method, "http://fixture"+tc.path, nil))
		if ok != tc.ok {
			t.Fatalf("%s: %v", tc.path, ok)
		}
	}
	for _, index := range []int{6, 7, 8, 9, 10, 11, 12} {
		bad := attachmentManifest()
		bad.Routes[index].Schema = ""
		if _, e := compileDoskaManifest(bad); e == nil {
			t.Fatalf("route without explicit schema accepted: %d", index)
		}
	}
	for _, r := range []DoskaGatewayRoute{{Method: "PUT", Path: "/doska/api/doska/native/upload", Kind: "upload", Schema: "attachment-content-v1"}, {Method: "GET", Path: doskaAttachmentBase + "/attachments/{attachmentId}/content", Kind: "read", Schema: "attachment-download-v1"}} {
		if _, e := compileDoskaManifest(DoskaGatewayManifest{Version: "bad", Routes: []DoskaGatewayRoute{r}}); e == nil {
			t.Fatal("broad kind accepted")
		}
	}
	for _, body := range []string{`{"filename":"x","size":26214401,"sha256":"` + strings.Repeat("0", 64) + `","clientRequestId":"one"}`, `{"filename":"x","size":1,"size":1,"sha256":"` + strings.Repeat("0", 64) + `","clientRequestId":"one"}`, `{"filename":"x","size":1,"sha256":"bad","clientRequestId":"one"}`} {
		if doskaAttachmentJSON("attachment-reserve-v1", []byte(body)) {
			t.Fatal("invalid reserve accepted")
		}
	}
}
func TestDoskaAttachmentSpoolRecoveryAndAdmission(t *testing.T) {
	dir := privateTemp(t)
	name := "doska-upload-" + randomToken() + ".tmp"
	if e := os.WriteFile(filepath.Join(dir, name), []byte("orphan"), 0600); e != nil {
		t.Fatal(e)
	}
	os.WriteFile(filepath.Join(dir, "unrelated.tmp"), []byte("keep"), 0600)
	f, e := newDoskaFileTransport(DoskaAttachmentConfig{dir})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = os.Stat(filepath.Join(dir, name)); !os.IsNotExist(e) {
		t.Fatal("orphan remains")
	}
	if _, e = os.Stat(filepath.Join(dir, "unrelated.tmp")); e != nil {
		t.Fatal("foreign file touched")
	}
	if _, e = newDoskaFileTransport(DoskaAttachmentConfig{dir}); e == nil {
		t.Fatal("concurrent instance accepted")
	}
	if !f.admit("a", true) || f.admit("a", true) || !f.admit("b", true) || f.admit("c", true) {
		t.Fatal("global/subject admission")
	}
	if !f.admit("a", false) || !f.admit("b", false) || f.admit("c", false) {
		t.Fatal("download separate admission")
	}
	f.release("a", true, nil)
	f.release("b", true, nil)
	f.release("a", false, nil)
	f.release("b", false, nil)
	f.reserved = doskaSpoolBudget - doskaFileLimit + 1
	if f.admit("a", true) {
		t.Fatal("byte budget exceeded")
	}
	f.reserved = 0
	if !f.admit("a", true) {
		t.Fatal("admission")
	}
	sp, e := f.create()
	if e != nil {
		t.Fatal(e)
	}
	// Unlink failure must keep all reserved bytes and the subject permit.
	os.Remove(filepath.Join(dir, sp.name))
	os.Mkdir(filepath.Join(dir, sp.name), 0700)
	os.WriteFile(filepath.Join(dir, sp.name, "blocked"), []byte("x"), 0600)
	f.release("a", true, sp)
	if f.reserved != doskaFileLimit || f.admit("a", true) {
		t.Fatal("failed cleanup freed budget")
	}
	os.RemoveAll(filepath.Join(dir, sp.name))
	f.close()
	f, e = newDoskaFileTransport(DoskaAttachmentConfig{dir})
	if e != nil {
		t.Fatal(e)
	}
	f.close()
	link := filepath.Join(t.TempDir(), "link")
	os.Symlink(dir, link)
	if _, e = newDoskaFileTransport(DoskaAttachmentConfig{link}); e == nil {
		t.Fatal("symlink directory accepted")
	}
	os.Chmod(dir, 0755)
	if _, e = newDoskaFileTransport(DoskaAttachmentConfig{dir}); e == nil {
		t.Fatal("non-private directory accepted")
	}
}

type attachmentRepeatingReader struct{ remaining int64 }

func (r *attachmentRepeatingReader) Read(p []byte) (int, error) {
	if r.remaining == 0 {
		return 0, io.EOF
	}
	n := len(p)
	if int64(n) > r.remaining {
		n = int(r.remaining)
	}
	for i := 0; i < n; i++ {
		p[i] = 'x'
	}
	r.remaining -= int64(n)
	return n, nil
}
func TestDoskaAttachmentPostgreSQLBoundedHTTP(t *testing.T) {
	var calls atomic.Int32
	s, g, user, sub, server := attachmentFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" || r.Header.Get("X-Original-URI") != "" {
			t.Error("credentials leaked")
		}
		raw, e := base64.RawURLEncoding.DecodeString(r.Header.Get(gatewayAssertionHeader))
		if e != nil {
			t.Error(e)
		}
		var claims gatewayIdentity
		if json.Unmarshal(raw, &claims) != nil {
			t.Error("claims")
		}
		if r.Header.Get(gatewaySignatureHeader) != gatewayMAC(attachmentTestKey, "pl-gateway-v2\n"+r.Header.Get(gatewayAssertionHeader)) || claims.URI != "/doska"+r.URL.RequestURI() || claims.ExpiresAt-claims.IssuedAt != 30 {
			t.Error("invalid signature/external URI/TTL")
		}
		h := sha256.New()
		n, e := io.Copy(h, r.Body)
		if e != nil {
			t.Error(e)
		}
		if claims.BodySHA256 != hex.EncodeToString(h.Sum(nil)) || n != doskaFileLimit {
			t.Error("actual body digest/size mismatch")
		}
		if !claims.CSRFVerified || r.Header.Get("X-CSRF-Token") != claims.CSRFToken {
			t.Error("CSRF binding")
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"state":"uploaded"}`)
	}))
	_ = sub
	r := attachmentRequest(t, server, s, user, "PUT", attachmentPath+"/attachment-uploads/u1/content", &attachmentRepeatingReader{doskaFileLimit})
	r.Header.Set("X-PL-Gateway-Assertion", "forged")
	r.Header.Set("X-Original-URI", "/evil")
	resp, e := server.Client().Do(r)
	if e != nil {
		t.Fatal(e)
	}
	data, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("exact boundary %d %s", resp.StatusCode, data)
	}
	r = attachmentRequest(t, server, s, user, "PUT", attachmentPath+"/attachment-uploads/u2/content", &attachmentRepeatingReader{doskaFileLimit + 1})
	resp, e = server.Client().Do(r)
	if e != nil {
		t.Fatal(e)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 413 || calls.Load() != 1 {
		t.Fatalf("+1 limit %d calls%d", resp.StatusCode, calls.Load())
	}
	for _, modify := range []func(*http.Request){func(r *http.Request) { r.Header.Del("X-CSRF-Token") }, func(r *http.Request) { r.Header.Set("Origin", "https://evil.test") }, func(r *http.Request) { r.Header.Add("Idempotency-Key", "a"); r.Header.Add("Idempotency-Key", "b") }} {
		r = attachmentRequest(t, server, s, user, "PUT", attachmentPath+"/attachment-uploads/u2/content", strings.NewReader("x"))
		modify(r)
		resp, e = server.Client().Do(r)
		if e != nil {
			t.Fatal(e)
		}
		resp.Body.Close()
		if resp.StatusCode < 400 {
			t.Fatal("unsafe accepted")
		}
	}
	if calls.Load() != 1 {
		t.Fatal("rejected body forwarded")
	}
	if g.files.reserved != 0 || g.files.upload.active != 0 {
		t.Fatal("spool leak")
	}
	entries, _ := os.ReadDir(g.config.Attachments.SpoolDirectory)
	for _, entry := range entries {
		if doskaSpoolName.MatchString(entry.Name()) {
			t.Fatal("spool file remains")
		}
	}
}
func TestDoskaAttachmentPostgreSQLSlowUploadCancelAndJSON(t *testing.T) {
	var calls atomic.Int32
	s, g, user, _, server := attachmentFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"ok":true}`)
	}))
	g.files.timeout = 100 * time.Millisecond
	parsed, _ := url.Parse(server.URL)
	conn, e := net.Dial("tcp", parsed.Host)
	if e != nil {
		t.Fatal(e)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(2 * time.Second))
	request := "PUT " + attachmentPath + "/attachment-uploads/u/content HTTP/1.1\r\nHost: " + parsed.Host + "\r\nContent-Type: application/octet-stream\r\nContent-Length: 1024\r\nCookie: " + user.cookie.String() + "\r\nOrigin: " + s.Config.PublicURL + "\r\nX-CSRF-Token: " + user.csrf + "\r\n\r\npartial"
	if _, e = io.WriteString(conn, request); e != nil {
		t.Fatal(e)
	}
	finished := make(chan error, 1)
	go func() { _, e := io.ReadAll(conn); finished <- e }()
	// Separate JSON admission stays usable while an actual raw transfer is blocked.
	jsonRequest := attachmentRequest(t, server, s, user, "GET", "/doska/api/doska/context", nil)
	response, e := server.Client().Do(jsonRequest)
	if e != nil {
		t.Fatal(e)
	}
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal("JSON starved")
	}
	select {
	case <-finished:
	case <-time.After(2 * time.Second):
		t.Fatal("absolute deadline did not unblock actual HTTP body")
	}
	deadline := time.Now().Add(time.Second)
	for {
		g.files.mu.Lock()
		active := g.files.upload.active
		g.files.mu.Unlock()
		if active == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("cancel leaked permit")
		}
		time.Sleep(time.Millisecond)
	}
	if calls.Load() != 1 {
		t.Fatalf("incomplete upload reached backend: %d", calls.Load())
	}
}
func TestDoskaAttachmentPostgreSQLDownloadLeaseAndHeaders(t *testing.T) {
	var slow atomic.Bool
	s, g, user, sub, server := attachmentFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Header().Set("Content-Disposition", `attachment; filename="../../safe.txt"`)
		w.Header().Set("Content-Length", "262144")
		w.Header().Set("Set-Cookie", "unsafe=1")
		for i := 0; i < 32; i++ {
			if _, e := w.Write(bytes.Repeat([]byte("x"), 8192)); e != nil {
				return
			}
			w.(http.Flusher).Flush()
			if slow.Load() {
				select {
				case <-r.Context().Done():
					return
				case <-time.After(10 * time.Millisecond):
				}
			}
		}
	}))
	g.files.lease = 80 * time.Millisecond
	call := func() *http.Response {
		t.Helper()
		r := attachmentRequest(t, server, s, user, "GET", attachmentPath+"/attachments/a/content", nil)
		resp, e := server.Client().Do(r)
		if e != nil {
			t.Fatal(e)
		}
		return resp
	}
	resp := call()
	data, e := io.ReadAll(resp.Body)
	resp.Body.Close()
	if e != nil || len(data) != 262144 {
		t.Fatalf("bounded download %d %v", len(data), e)
	}
	if resp.Header.Get("X-Content-Type-Options") != "nosniff" || resp.Header.Get("Cache-Control") != "private, no-store" || resp.Header.Get("Content-Type") != "application/octet-stream" || strings.Contains(resp.Header.Get("Content-Disposition"), "../") || resp.Header.Get("Set-Cookie") != "" {
		t.Fatalf("unsafe file headers %v", resp.Header)
	}
	r := attachmentRequest(t, server, s, user, "GET", attachmentPath+"/attachments/a/content", nil)
	r.Header.Set("Range", "bytes=0-1")
	resp, e = server.Client().Do(r)
	if e != nil {
		t.Fatal(e)
	}
	resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Fatal("range accepted")
	}
	slow.Store(true)
	resp = call()
	first := make([]byte, 8192)
	if _, e = io.ReadFull(resp.Body, first); e != nil {
		t.Fatal(e)
	}
	if _, e = s.Store.Pool.Exec(context.Background(), "DELETE FROM sessions WHERE user_id=$1", sub); e != nil {
		t.Fatal(e)
	}
	started := time.Now()
	_, e = io.ReadAll(resp.Body)
	resp.Body.Close()
	if e == nil || time.Since(started) > time.Second {
		t.Fatalf("logout did not abort download: %v", e)
	}
}
func TestDoskaAttachmentUploadSignerRejectsIncomplete(t *testing.T) {
	r := httptest.NewRequest("PUT", "http://fixture"+attachmentPath+"/attachment-uploads/u/content", nil)
	if signDoskaUpload(r, &doskaSpool{}, session{}, attachmentTestKey, time.Now(), "127.0.0.1") == nil {
		t.Fatal("incomplete spool signed")
	}
	if signDoskaRequest(r, make([]byte, (2<<20)+1), session{}, doskaRouteWrite, attachmentTestKey, time.Now(), true, "127.0.0.1") == nil {
		t.Fatal("JSON signer limit widened")
	}
}

func TestDoskaAttachmentPostgreSQLDownloadTruncation(t *testing.T) {
	s, _, user, _, server := attachmentFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Disposition", `attachment; filename="file.txt"`)
		w.Header().Set("Content-Length", "1024")
		w.WriteHeader(200)
		io.WriteString(w, "short")
	}))
	r := attachmentRequest(t, server, s, user, "GET", attachmentPath+"/attachments/a/content", nil)
	resp, e := server.Client().Do(r)
	if e == nil {
		_, e = io.ReadAll(resp.Body)
		resp.Body.Close()
	}
	if e == nil {
		t.Fatal("truncated upstream became successful download")
	}
}

func TestDoskaAttachmentDefaultDisabledPostgreSQL(t *testing.T) {
	s := apiFixture(t)
	user, _ := attachmentIdentity(t, s)
	g, e := s.newDoskaGateway(DoskaGatewayConfig{APIUpstream: "http://127.0.0.1:1", WebUpstream: "http://127.0.0.1:1", Key: attachmentTestKey, Manifest: attachmentManifest(), Transport: http.DefaultTransport})
	if e != nil {
		t.Fatal(e)
	}
	r := httptest.NewRequest("PUT", s.Config.PublicURL+attachmentPath+"/attachment-uploads/u/content", strings.NewReader("x"))
	r.AddCookie(user.cookie)
	w := httptest.NewRecorder()
	g.ServeHTTP(w, r)
	if w.Code != 404 {
		t.Fatalf("default opened files: %d", w.Code)
	}
}

func TestDoskaAttachmentPostgreSQLBeforeForwardRotationAndNoRetry(t *testing.T) {
	var calls atomic.Int32
	s, g, user, sub, server := attachmentFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		io.Copy(io.Discard, r.Body)
		hijack := w.(http.Hijacker)
		conn, _, e := hijack.Hijack()
		if e == nil {
			conn.Close()
		}
	}))
	// First raw body is valid, but the backend loses its response. Exactly one PUT
	// reaches it even with an idempotency key; checking state is the caller's job.
	r := attachmentRequest(t, server, s, user, "PUT", attachmentPath+"/attachment-uploads/u/content", strings.NewReader("payload"))
	r.Header.Set("Idempotency-Key", "operation-one")
	resp, e := server.Client().Do(r)
	if e != nil {
		t.Fatal(e)
	}
	resp.Body.Close()
	if resp.StatusCode != 502 || calls.Load() != 1 {
		t.Fatal("unsafe retry/result", resp.StatusCode, calls.Load())
	}
	// Revoke the actual DB session while browser -> spool is still in progress.
	parsed, _ := url.Parse(server.URL)
	conn, e := net.Dial("tcp", parsed.Host)
	if e != nil {
		t.Fatal(e)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(time.Second))
	header := "PUT " + attachmentPath + "/attachment-uploads/u2/content HTTP/1.1\r\nHost: " + parsed.Host + "\r\nConnection: close\r\nContent-Type: application/octet-stream\r\nContent-Length: 2\r\nCookie: " + user.cookie.String() + "\r\nOrigin: " + s.Config.PublicURL + "\r\nX-CSRF-Token: " + user.csrf + "\r\n\r\nx"
	io.WriteString(conn, header)
	waitUntil := time.Now().Add(time.Second)
	for {
		g.files.mu.Lock()
		active := g.files.upload.active
		g.files.mu.Unlock()
		if active == 1 {
			break
		}
		if time.Now().After(waitUntil) {
			t.Fatal("upload not admitted")
		}
		time.Sleep(time.Millisecond)
	}
	if _, e = s.Store.Pool.Exec(context.Background(), "UPDATE sessions SET csrf=$2 WHERE user_id=$1", sub, "rotated-session-token"); e != nil {
		t.Fatal(e)
	}
	io.WriteString(conn, "x")
	answer, e := io.ReadAll(conn)
	if e != nil {
		t.Fatal(e)
	}
	if !bytes.Contains(answer, []byte("401 Unauthorized")) || calls.Load() != 1 {
		t.Fatalf("rotated session forwarded: %.512s calls%d", answer, calls.Load())
	}
}
func TestDoskaAttachmentPostgreSQLSlowDownloadAndLifecycleClose(t *testing.T) {
	s, g, user, _, server := attachmentFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Disposition", `attachment; filename="large.txt"`)
		w.Header().Set("Content-Length", "26214400")
		for i := int64(0); i < doskaFileLimit/8192; i++ {
			if _, e := w.Write(bytes.Repeat([]byte("x"), 8192)); e != nil {
				return
			}
		}
	}))
	g.files.timeout = 120 * time.Millisecond
	parsed, _ := url.Parse(server.URL)
	conn, e := net.Dial("tcp", parsed.Host)
	if e != nil {
		t.Fatal(e)
	}
	defer conn.Close()
	io.WriteString(conn, "GET "+attachmentPath+"/attachments/a/content HTTP/1.1\r\nHost: "+parsed.Host+"\r\nCookie: "+user.cookie.String()+"\r\n\r\n")
	until := time.Now().Add(time.Second)
	seen := false
	for {
		g.files.mu.Lock()
		active := g.files.download.active
		g.files.mu.Unlock()
		if active > 0 {
			seen = true
		}
		if seen && active == 0 {
			break
		}
		if time.Now().After(until) {
			t.Fatal("slow consumer retained transfer after absolute deadline")
		}
		time.Sleep(time.Millisecond)
	}
	// Closing a gateway with an active blocked upload cancels it, closes/unlinks
	// the file, waits for cleanup, and releases its directory lock before return.
	g.files.timeout = time.Second
	conn2, e := net.Dial("tcp", parsed.Host)
	if e != nil {
		t.Fatal(e)
	}
	defer conn2.Close()
	io.WriteString(conn2, "PUT "+attachmentPath+"/attachment-uploads/u/content HTTP/1.1\r\nHost: "+parsed.Host+"\r\nContent-Type: application/octet-stream\r\nContent-Length: 100\r\nCookie: "+user.cookie.String()+"\r\nOrigin: "+s.Config.PublicURL+"\r\nX-CSRF-Token: "+user.csrf+"\r\n\r\nx")
	until = time.Now().Add(time.Second)
	for {
		g.files.mu.Lock()
		active := g.files.upload.active
		g.files.mu.Unlock()
		if active == 1 {
			break
		}
		if time.Now().After(until) {
			t.Fatal("upload not admitted")
		}
		time.Sleep(time.Millisecond)
	}
	closed := make(chan struct{})
	go func() { g.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("gateway close hung on active body")
	}
	if g.files.reserved != 0 {
		t.Fatal("close leaked spool reservation")
	}
	replacement, e := newDoskaFileTransport(*g.config.Attachments)
	if e != nil {
		t.Fatal("directory lock remained after Close", e)
	}
	replacement.close()
}

func TestDoskaAttachmentCandidateConverter(t *testing.T) {
	python, e := exec.LookPath("python3")
	if e != nil {
		t.Fatal("python3 required")
	}
	dir := t.TempDir()
	input, output := filepath.Join(dir, "source.json"), filepath.Join(dir, "candidate.json")
	source := map[string]any{"source": strings.Repeat("a", 40), "pages": []string{"/doska/"}, "assets": []any{}, "apiRoutes": []any{}, "requestBodyLimitBytes": 131072, "websockets": false, "uploads": false, "nativeRoutes": false, "queryLimits": map[string]any{"rawBytes": 4096, "duplicateKeys": "reject"}, "pageQuery": map[string]any{}}
	data, _ := json.Marshal(source)
	if e = os.WriteFile(input, data, 0600); e != nil {
		t.Fatal(e)
	}
	command := exec.Command(python, "../../deploy/doska/prepare-gateway-manifest.py", input, output, "--attachments-candidate")
	if data, e = command.CombinedOutput(); e != nil {
		t.Fatalf("candidate converter: %v %s", e, data)
	}
	data, e = os.ReadFile(output)
	if e != nil {
		t.Fatal(e)
	}
	var manifest DoskaGatewayManifest
	if e = doskaStrictJSON(data, &manifest); e != nil {
		t.Fatal(e)
	}
	if len(manifest.Routes) != 8 {
		t.Fatal("unexpected candidate scope")
	}
	if _, e = compileDoskaManifest(manifest); e != nil {
		t.Fatal(e)
	}
	// Default conversion preserves uploads=false and emits no attachment routes.
	output = filepath.Join(dir, "default.json")
	if data, e = exec.Command(python, "../../deploy/doska/prepare-gateway-manifest.py", input, output).CombinedOutput(); e != nil {
		t.Fatalf("default converter %v %s", e, data)
	}
	data, _ = os.ReadFile(output)
	if bytes.Contains(data, []byte("attachment")) {
		t.Fatal("default converter opened uploads")
	}

	// Keep the uploads=true / already enumerated input contract portable in CI;
	// the next test additionally exercises the real owner's current candidate.
	source["uploads"] = true
	declared := []map[string]any{}
	for _, route := range manifest.Routes {
		if route.Schema == "" {
			continue
		}
		query := []map[string]any{}
		for name, rule := range route.Query {
			query = append(query, map[string]any{"name": name, "required": false, "multiplicity": 1, "schema": map[string]any{"type": "integer", "minimum": *rule.Minimum, "maximum": *rule.Maximum}})
		}
		declared = append(declared, map[string]any{"method": route.Method, "external": route.Path, "upstream": strings.TrimPrefix(route.Path, "/doska"), "kind": route.Kind, "schema": route.Schema, "query": query, "unknownQueryKeys": "reject"})
	}
	source["apiRoutes"] = declared
	data, _ = json.Marshal(source)
	if e = os.WriteFile(input, data, 0600); e != nil {
		t.Fatal(e)
	}
	output = filepath.Join(dir, "already-declared.json")
	if data, e = exec.Command(python, "../../deploy/doska/prepare-gateway-manifest.py", input, output, "--attachments-candidate").CombinedOutput(); e != nil {
		t.Fatalf("portable declared candidate: %v %s", e, data)
	}
	data, _ = os.ReadFile(output)
	var declaredManifest DoskaGatewayManifest
	if e = doskaStrictJSON(data, &declaredManifest); e != nil {
		t.Fatal(e)
	}
	if len(declaredManifest.Routes) != 8 {
		t.Fatal("candidate duplicated already declared routes")
	}
	if _, e = compileDoskaManifest(declaredManifest); e != nil {
		t.Fatal(e)
	}
}

func TestDoskaAttachmentPostgreSQLDownloadFreshnessAndHungRecheck(t *testing.T) {
	for _, mode := range []string{"stale", "session-expiry", "hung-session-check"} {
		t.Run(mode, func(t *testing.T) {
			s, g, user, sub, server := attachmentFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Disposition", `attachment; filename="slow.txt"`)
				w.Header().Set("Content-Length", "1048576")
				w.Write(bytes.Repeat([]byte("x"), 8192))
				w.(http.Flusher).Flush()
				<-r.Context().Done()
			}))
			g.files.lease = 100 * time.Millisecond
			g.files.timeout = time.Second
			if mode == "session-expiry" {
				if _, e := s.Store.Pool.Exec(context.Background(), "UPDATE sessions SET expires_at=now()+interval '150 milliseconds' WHERE user_id=$1", sub); e != nil {
					t.Fatal(e)
				}
			}
			r := attachmentRequest(t, server, s, user, "GET", attachmentPath+"/attachments/a/content", nil)
			response, e := server.Client().Do(r)
			if e != nil {
				t.Fatal(e)
			}
			defer response.Body.Close()
			if _, e = io.ReadFull(response.Body, make([]byte, 8192)); e != nil {
				t.Fatal(e)
			}
			switch mode {
			case "stale":
				if _, e = s.Store.Pool.Exec(context.Background(), "UPDATE org_employees SET body=jsonb_set(body,'{last_success_at}',to_jsonb((now()-interval '3 hours')::text)) WHERE subject=$1", sub); e != nil {
					t.Fatal(e)
				}
			case "hung-session-check":
				tx, e := s.Store.Pool.Begin(context.Background())
				if e != nil {
					t.Fatal(e)
				}
				defer tx.Rollback(context.Background())
				if _, e = tx.Exec(context.Background(), "LOCK TABLE sessions IN ACCESS EXCLUSIVE MODE"); e != nil {
					t.Fatal(e)
				}
			}
			started := time.Now()
			_, e = io.ReadAll(response.Body)
			if e == nil || time.Since(started) > 600*time.Millisecond {
				t.Fatalf("%s extended positive lease: %v elapsed%s", mode, e, time.Since(started))
			}
		})
	}
}

func TestDoskaAttachmentPostgreSQLGenericTemplateCannotEnableFiles(t *testing.T) {
	s := apiFixture(t)
	user, _ := attachmentIdentity(t, s)
	manifest := DoskaGatewayManifest{Version: "generic", Routes: []DoskaGatewayRoute{{Method: "GET", Path: "/doska/api/doska/projects/{id}/tasks/{taskId}/{operation}", Kind: "read"}}}
	g, e := s.newDoskaGateway(DoskaGatewayConfig{APIUpstream: "http://127.0.0.1:1", WebUpstream: "http://127.0.0.1:1", Key: attachmentTestKey, Manifest: manifest, Transport: http.DefaultTransport})
	if e != nil {
		t.Fatal(e)
	}
	r := httptest.NewRequest("GET", s.Config.PublicURL+attachmentPath+"/attachments", nil)
	r.AddCookie(user.cookie)
	w := httptest.NewRecorder()
	g.ServeHTTP(w, r)
	if w.Code != 404 {
		t.Fatal("generic template opened reserved file route", w.Code)
	}
}

func TestDoskaAttachmentPostgreSQLTwoUploadsKeepFourJSONSlots(t *testing.T) {
	entered := make(chan struct{}, 4)
	release := make(chan struct{})
	s, g, user, sub, server := attachmentFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		entered <- struct{}{}
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"ok":true}`)
	}))
	defer close(release)
	second, _ := attachmentIdentityGUID(t, s, 2)
	parsed, _ := url.Parse(server.URL)
	start := func(who apiIdentity, id string) net.Conn {
		t.Helper()
		conn, e := net.Dial("tcp", parsed.Host)
		if e != nil {
			t.Fatal(e)
		}
		conn.SetDeadline(time.Now().Add(3 * time.Second))
		io.WriteString(conn, "PUT "+attachmentPath+"/attachment-uploads/"+id+"/content HTTP/1.1\r\nHost: "+parsed.Host+"\r\nContent-Type: application/octet-stream\r\nContent-Length: 100\r\nCookie: "+who.cookie.String()+"\r\nOrigin: "+s.Config.PublicURL+"\r\nX-CSRF-Token: "+who.csrf+"\r\n\r\nx")
		return conn
	}
	one := start(user, "u1")
	defer one.Close()
	waitActive := func(want int) {
		t.Helper()
		until := time.Now().Add(time.Second)
		for {
			g.files.mu.Lock()
			active := g.files.upload.active
			g.files.mu.Unlock()
			if active == want {
				return
			}
			if time.Now().After(until) {
				t.Fatal("actual uploads not admitted", want)
			}
			time.Sleep(time.Millisecond)
		}
	}
	waitActive(1)
	otherSession := apiUser(t, s, sub, false)
	r := attachmentRequest(t, server, s, otherSession, "PUT", attachmentPath+"/attachment-uploads/u3/content", strings.NewReader("x"))
	response, e := server.Client().Do(r)
	if e != nil {
		t.Fatal(e)
	}
	response.Body.Close()
	if response.StatusCode != 429 {
		t.Fatal("second session bypassed verified subject limit", response.StatusCode)
	}
	two := start(second, "u2")
	defer two.Close()
	waitActive(2)
	results := make(chan error, 4)
	for i := 0; i < 4; i++ {
		go func() {
			r := attachmentRequest(t, server, s, user, "GET", "/doska/api/doska/context", nil)
			response, e := server.Client().Do(r)
			if response != nil {
				response.Body.Close()
				if response.StatusCode != 200 {
					e = fmt.Errorf("JSON status %d", response.StatusCode)
				}
			}
			results <- e
		}()
	}
	for i := 0; i < 4; i++ {
		select {
		case <-entered:
		case <-time.After(time.Second):
			t.Fatal("file transfers consumed ordinary JSON slots")
		}
	}
	// All four JSON upstreams have entered while both raw socket bodies are
	// simultaneously blocked. Release the independent JSON barrier now.
	release <- struct{}{}
	release <- struct{}{}
	release <- struct{}{}
	release <- struct{}{}
	for i := 0; i < 4; i++ {
		if e := <-results; e != nil {
			t.Fatal(e)
		}
	}
}

func TestDoskaAttachmentCandidateConverterAcceptedInput(t *testing.T) {
	python, e := exec.LookPath("python3")
	if e != nil {
		t.Fatal("python3 required")
	}
	// Owner candidate 9c5410f16925e8a7aecd850194338b95880a349e,
	// accepted by bcf38228f80b21350d87bb6c9a0cf2fa1cc683e4 with identical
	// source/image pins, API routes and assets. Later mutable candidates include
	// catalog/SSE contracts which this attachment-only converter must reject.
	// The portable copy replaces only upstream and Directory deployment origins
	// with documentation addresses; pin that exact neutralized fixture below.
	inputPath, e := filepath.Abs("testdata/doska-attachments-accepted-9c5410f1.json")
	if e != nil {
		t.Fatal(e)
	}
	raw, e := doskaReadFile(inputPath, 512<<10)
	if e != nil {
		t.Fatal(e)
	}
	digest := sha256.Sum256(raw)
	if hex.EncodeToString(digest[:]) != "854bde40dfb35141087b91f65a18d17e811382703125d3133a0be41ba63e9836" {
		t.Fatal("accepted owner fixture changed")
	}
	var original map[string]any
	if e = json.Unmarshal(raw, &original); e != nil {
		t.Fatal(e)
	}
	upstreams, upstreamsOK := original["upstreams"].(map[string]any)
	directory, directoryOK := original["directory"].(map[string]any)
	if !upstreamsOK || !directoryOK || upstreams["api"] != "http://192.0.2.240:1337" || upstreams["web"] != "http://192.0.2.240:8080" || directory["origin"] != "https://platform.example.test" {
		t.Fatal("portable fixture must use documentation origins")
	}
	convert := func(t *testing.T, source map[string]any, flag bool, want bool) {
		t.Helper()
		dir := t.TempDir()
		input, output := filepath.Join(dir, "source.json"), filepath.Join(dir, "out.json")
		data, e := json.Marshal(source)
		if e != nil {
			t.Fatal(e)
		}
		if e = os.WriteFile(input, data, 0600); e != nil {
			t.Fatal(e)
		}
		args := []string{"../../deploy/doska/prepare-gateway-manifest.py", input, output}
		if flag {
			args = append(args, "--attachments-candidate")
		}
		message, e := exec.Command(python, args...).CombinedOutput()
		if !want {
			if e == nil {
				t.Fatalf("invalid source accepted without candidate contract: %.1024s", message)
			}
			if _, e = os.Stat(output); !os.IsNotExist(e) {
				t.Fatal("failed conversion wrote output")
			}
			return
		}
		if e != nil {
			t.Fatalf("actual candidate conversion: %v %.2048s", e, message)
		}
		data, e = os.ReadFile(output)
		if e != nil {
			t.Fatal(e)
		}
		var manifest DoskaGatewayManifest
		if e = doskaStrictJSON(data, &manifest); e != nil {
			t.Fatal(e)
		}
		if _, e = compileDoskaManifest(manifest); e != nil {
			t.Fatal(e)
		}
		files := 0
		seen := map[string]bool{}
		for _, r := range manifest.Routes {
			if r.Schema != "" {
				files++
				key := r.Method + " " + r.Path
				if seen[key] {
					t.Fatal("duplicated file route")
				}
				seen[key] = true
			}
		}
		if files != 7 {
			t.Fatal("actual candidate did not preserve exactly seven input file routes", files)
		}
	}
	t.Run("accepted-candidate", func(t *testing.T) { convert(t, original, true, true) })
	t.Run("no-explicit-flag", func(t *testing.T) { convert(t, original, false, false) })
	for _, mode := range []string{"unknown-schema", "unknown-route", "unknown-kind", "missing-route", "duplicate-route", "wide-query", "wide-file-budget", "false-with-file-routes", "catalog-metadata"} {
		t.Run(mode, func(t *testing.T) {
			data, _ := json.Marshal(original)
			var source map[string]any
			json.Unmarshal(data, &source)
			routes := source["apiRoutes"].([]any)
			at := -1
			for i, v := range routes {
				if v.(map[string]any)["schema"] == "attachment-list-v1" {
					at = i
					break
				}
			}
			if at < 0 {
				t.Fatal("actual candidate missing list fixture")
			}
			route := routes[at].(map[string]any)
			switch mode {
			case "catalog-metadata":
				source["resourceLinkRoutes"] = []any{}
			case "unknown-schema":
				route["schema"] = "attachment-generic-v99"
			case "unknown-route":
				route["external"] = route["external"].(string) + "/unknown"
				route["upstream"] = route["upstream"].(string) + "/unknown"
			case "unknown-kind":
				route["kind"] = "download"
			case "missing-route":
				source["apiRoutes"] = append(routes[:at], routes[at+1:]...)
			case "duplicate-route":
				source["apiRoutes"] = append(routes, route)
			case "wide-query":
				route["query"].([]any)[0].(map[string]any)["schema"].(map[string]any)["maximum"] = float64(101)
			case "wide-file-budget":
				source["attachments"].(map[string]any)["maxFileBytes"] = float64(26214401)
			case "false-with-file-routes":
				source["uploads"] = false
			}
			convert(t, source, true, false)
		})
	}
}

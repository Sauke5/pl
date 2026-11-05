package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"pl/portal/internal/model"
)

type inventoryRevokingBody struct {
	reader io.Reader
	revoke func()
}

func (b *inventoryRevokingBody) Read(p []byte) (int, error) {
	if b.revoke != nil {
		f := b.revoke
		b.revoke = nil
		f()
	}
	return b.reader.Read(p)
}

func TestInventoryFiniteRoutesAndV2Identity(t *testing.T) {
	key := bytes.Repeat([]byte{42}, 32)
	sess := session{User: model.User{ID: "local-admin", Name: "Администратор", Admin: true}, CSRF: "test-session-csrf"}
	for _, tc := range []struct{ method, path, media string }{
		{"GET", "/inventory/", "text/html"}, {"GET", "/inventory/static/shared-shell.js", "application/javascript"}, {"HEAD", "/inventory/static/platform.css", "text/css"},
		{"GET", "/inventory/api/data?page=1", "application/json"}, {"GET", "/inventory/api/software?search=Office&limit=10", "application/json"},
		{"POST", "/inventory/api/imports/preview", "application/json"}, {"POST", "/inventory/api/imports/12345678-1234-4234-8234-123456789abc/commit", "application/json"},
	} {
		t.Run(tc.method+tc.path, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, "https://module"+tc.path, nil)
			media, ok := inventoryMatchRoute(r)
			if !ok || media != tc.media {
				t.Fatal("route rejected", media)
			}
			var body []byte
			unsafe := tc.method == "POST"
			if unsafe {
				body = []byte("exact uploaded bytes")
				r.Header.Set("Content-Type", "multipart/form-data; boundary=fixture")
				r.Header.Set("Idempotency-Key", "import:fixture")
				if strings.HasSuffix(tc.path, "/commit") {
					body = []byte("{}")
					r.Header.Set("Content-Type", "application/json")
				}
			}
			if err := signInventoryRequest(r, body, sess, key, time.Unix(1790000000, 0), unsafe, "192.0.2.1"); err != nil {
				t.Fatal(err)
			}
			claims := decodeDirectoryAssertion(t, r, key)
			sum := sha256.Sum256(body)
			wantScope := "inventory:read"
			if unsafe {
				wantScope = "inventory:write"
			}
			if claims.Version != 2 || claims.Audience != "inventory" || !claims.Admin || len(claims.Scopes) != 1 || claims.Scopes[0] != wantScope || claims.URI != tc.path || claims.BodySHA256 != hex.EncodeToString(sum[:]) || claims.CSRFVerified != unsafe || claims.CSRFToken != gatewayServiceCSRF(sess.CSRF, "inventory") {
				t.Fatalf("wrong Inventory identity: %+v", claims)
			}
			first := claims.Nonce
			if err := signInventoryRequest(r, body, sess, key, time.Now(), unsafe, "192.0.2.1"); err != nil || decodeDirectoryAssertion(t, r, key).Nonce == first {
				t.Fatal("nonce reuse", err)
			}
			unprivileged := sess
			unprivileged.User.Admin = false
			if signInventoryRequest(r, body, unprivileged, key, time.Now(), unsafe, "192.0.2.1") == nil {
				t.Fatal("employee Inventory assertion")
			}
			if unsafe && signInventoryRequest(r, body, sess, key, time.Now(), false, "192.0.2.1") == nil {
				t.Fatal("unverified write signed")
			}
		})
	}
	for _, path := range []string{"/inventory/healthz", "/inventory/login", "/inventory/../secret", "/inventory/api/data?url=http://outside", "/inventory/api/software?page=1&page=2", "/inventory/static/%72eport.js", "/inventory/api/imports?x=1", "/inventory/?"} {
		if _, ok := inventoryMatchRoute(httptest.NewRequest("GET", "https://module"+path, nil)); ok {
			t.Fatal("opened unknown route", path)
		}
	}
}

func TestInventoryGatewayCurrentAdminCSRFAndOpaqueTransport(t *testing.T) {
	s := apiFixture(t)
	admin := apiUser(t, s, "inventory-admin", true)
	viewer := apiUser(t, s, "inventory-viewer", false)
	key := bytes.Repeat([]byte{21}, 32)
	calls := 0
	var lastClaims gatewayIdentity
	tr := directoryRoundTrip(func(r *http.Request) (*http.Response, error) {
		calls++
		lastClaims = decodeDirectoryAssertion(t, r, key)
		if r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" || r.Header.Get("X-Forwarded-For") != "" {
			t.Fatal("browser identity leaked upstream")
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(body)
		if lastClaims.BodySHA256 != hex.EncodeToString(sum[:]) {
			t.Fatal("body digest changed")
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"dataset":{},"summary":{}}`))}, nil
	})
	g := s.newInventoryGateway(key, tr)
	call := func(who apiIdentity, method, path, body, content, csrf string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, s.Config.PublicURL+path, strings.NewReader(body))
		if who.cookie != nil {
			r.AddCookie(who.cookie)
		}
		r.Header.Set("Origin", s.Config.PublicURL)
		r.Header.Set("X-PL-Gateway-Assertion", "forged-browser-identity")
		r.Header.Set("X-PL-Gateway-Signature", "forged-browser-signature")
		r.Header.Set("X-PL-Admin", "true")
		r.Header.Set("X-Forwarded-For", "203.0.113.7")
		if content != "" {
			r.Header.Set("Content-Type", content)
		}
		if method == "POST" {
			r.Header.Set("X-CSRF-Token", csrf)
			r.Header.Set("Idempotency-Key", "import:fixture")
		}
		w := httptest.NewRecorder()
		g.ServeHTTP(w, r)
		return w
	}
	for _, tc := range []struct {
		who    apiIdentity
		status int
	}{{apiIdentity{}, 401}, {viewer, 403}, {admin, 200}} {
		if got := call(tc.who, "GET", "/inventory/api/data?page=1", "", "", ""); got.Code != tc.status {
			t.Fatalf("read status %d want%d: %s", got.Code, tc.status, got.Body.String())
		}
	}
	if calls != 1 || lastClaims.Subject != "inventory-admin" || lastClaims.Scopes[0] != "inventory:read" || lastClaims.SourceIP != "192.0.2.1" {
		t.Fatal("read identity or admission incorrect")
	}
	if got := call(admin, "POST", "/inventory/api/imports/preview", "multipart bytes", "multipart/form-data; boundary=fixture", "wrong"); got.Code != 403 {
		t.Fatal("wrong CSRF accepted", got.Code)
	}
	if calls != 1 {
		t.Fatal("rejected CSRF reached Inventory")
	}
	if got := call(admin, "POST", "/inventory/api/imports/preview", "multipart bytes", "multipart/form-data; boundary=fixture", admin.csrf); got.Code != 200 {
		t.Fatal(got.Code, got.Body.String())
	}
	if calls != 2 || lastClaims.Scopes[0] != "inventory:write" || !lastClaims.CSRFVerified {
		t.Fatal("write identity incorrect")
	}
	if got := call(admin, "POST", "/inventory/api/imports/12345678-1234-4234-8234-123456789abc/commit", strings.Repeat("x", 4097), "application/json", admin.csrf); got.Code != 413 {
		t.Fatal("oversized commit reached source", got.Code)
	}
	if calls != 2 {
		t.Fatal("oversized body reached source")
	}
	uploadAdmin := apiUser(t, s, "inventory-upload-admin", true)
	lateBody := &inventoryRevokingBody{reader: strings.NewReader("upload bytes"), revoke: func() {
		if _, err := s.Store.Pool.Exec(context.Background(), "DELETE FROM sessions WHERE user_id='inventory-upload-admin'"); err != nil {
			t.Fatal(err)
		}
	}}
	lateRequest := httptest.NewRequest("POST", s.Config.PublicURL+"/inventory/api/imports/preview", lateBody)
	lateRequest.AddCookie(uploadAdmin.cookie)
	lateRequest.Header.Set("Origin", s.Config.PublicURL)
	lateRequest.Header.Set("Content-Type", "multipart/form-data; boundary=fixture")
	lateRequest.Header.Set("X-CSRF-Token", uploadAdmin.csrf)
	lateRequest.Header.Set("Idempotency-Key", "late-upload")
	lateResponse := httptest.NewRecorder()
	g.ServeHTTP(lateResponse, lateRequest)
	if lateResponse.Code != 401 || calls != 2 {
		t.Fatal("revocation during body read reached native mutation", lateResponse.Code, calls)
	}
	// A response admitted before revocation is not released to the old session.
	revoking := s.newInventoryGateway(key, directoryRoundTrip(func(r *http.Request) (*http.Response, error) {
		_, err := s.Store.Pool.Exec(context.Background(), "DELETE FROM sessions WHERE user_id='inventory-admin'")
		if err != nil {
			t.Fatal(err)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"secret_report":true}`))}, nil
	}))
	r := httptest.NewRequest("GET", s.Config.PublicURL+"/inventory/api/data", nil)
	r.AddCookie(admin.cookie)
	w := httptest.NewRecorder()
	revoking.ServeHTTP(w, r)
	if w.Code != 401 || strings.Contains(w.Body.String(), "secret_report") {
		t.Fatal("revoked session received report", w.Code, w.Body.String())
	}
}

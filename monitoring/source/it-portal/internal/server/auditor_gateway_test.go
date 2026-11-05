package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"pl/portal/internal/model"
)

func TestAuditorRouteAllowlist(t *testing.T) {
	for _, path := range []string{"/", "/departments", "/departments/1", "/documents", "/scans", "/service", "/assets/index-Ab_123.js", "/assets/index-Ab_123.css", "/favicon.svg", "/api/instance", "/api/findings", "/api/departments", "/api/departments/1", "/api/intelligence/departments/1", "/api/intelligence/departments/1/simulate", "/api/scans", "/api/scans/current", "/api/dashboard", "/api/intelligence/overview", "/api/scans/latest"} {
		if !gatewayRoute("auditor", "GET", path) || !gatewayRoute("auditor", "HEAD", path) {
			t.Fatalf("read route rejected: %s", path)
		}
	}
	for _, path := range []string{"/health", "/hubs/scan-progress", "/swagger", "/api/unknown", "/api/scans/1", "/departments/0", "/departments/-1", "/departments/1/simulate", "/api/intelligence/departments/1/delete", "/assets/evil.js", "/assets/evil.map", "/assets/../../secret", "//api/scans", "/api/%73cans"} {
		if gatewayRoute("auditor", "GET", path) {
			t.Fatalf("unlisted read route accepted: %s", path)
		}
	}
	if !gatewayRoute("auditor", "POST", "/api/scans") || gatewayRoute("auditor", "POST", "/api/findings") || gatewayRoute("auditor", "OPTIONS", "/api/scans") {
		t.Fatal("unsafe route policy")
	}
}

func TestAuditorV2SignerIdentityAndBinding(t *testing.T) {
	key := bytes.Repeat([]byte{42}, 32)
	archKey := bytes.Repeat([]byte{43}, 32)
	now := time.Unix(1790000000, 0)
	for _, prefix := range []string{"/audit", "/audit-arch"} {
		for _, admin := range []bool{false, true} {
			sess := session{User: model.User{ID: "ad:object-guid", Name: "Иван Иванов", Admin: admin}, CSRF: "portal-session-csrf"}
			req := httptest.NewRequest("GET", "https://monitoring.example"+prefix+"/api/findings?limit=20", nil)
			if err := signAuditorRequest(req, nil, sess, prefix, key, now, false, "192.0.2.1"); err != nil {
				t.Fatal(err)
			}
			claims := decodeDirectoryAssertion(t, req, key)
			want := []string{"auditor:read"}
			if admin {
				want = append(want, "auditor:scan")
			}
			if claims.Version != 2 || claims.Audience != "auditor" || claims.Admin != admin || !reflect.DeepEqual(claims.Scopes, want) || claims.URI != req.URL.RequestURI() || claims.ExpiresAt-claims.IssuedAt != 30 || claims.CSRFVerified || claims.CSRFToken != gatewayServiceCSRF(sess.CSRF, "auditor") {
				t.Fatal(claims)
			}
			if req.Header.Get(gatewaySignatureHeader) == gatewayMAC(archKey, "pl-gateway-v2\n"+req.Header.Get(gatewayAssertionHeader)) {
				t.Fatal("other instance key accepted")
			}
			otherPrefix := "/audit-arch"
			if prefix == otherPrefix {
				otherPrefix = "/audit"
			}
			if err := signAuditorRequest(req, nil, sess, otherPrefix, key, now, false, "192.0.2.1"); err == nil {
				t.Fatal("wrong signed prefix accepted")
			}
			body := []byte(`{"rootNames":["Documents"]}`)
			req = httptest.NewRequest("POST", "https://monitoring.example"+prefix+"/api/scans", bytes.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			if err := signAuditorRequest(req, body, sess, prefix, key, now, true, "192.0.2.1"); admin && err != nil || !admin && err == nil {
				t.Fatalf("scan access admin=%v err=%v", admin, err)
			}
			if admin {
				claims = decodeDirectoryAssertion(t, req, key)
				digest := sha256.Sum256(body)
				if claims.BodySHA256 != hex.EncodeToString(digest[:]) || claims.Method != "POST" || claims.ContentType != "application/json" || !claims.CSRFVerified {
					t.Fatal(claims)
				}
			}
		}
	}
}

func TestAuditorGatewayConfigKeysAndPrefixes(t *testing.T) {
	t.Setenv("PORTAL_DATABASE_URL", "postgres://test.invalid/test")
	t.Setenv("PORTAL_DEMO", "true")
	t.Setenv("PORTAL_PUBLIC_URL", "http://localhost:8199")
	t.Setenv("PORTAL_LOCAL_ADMIN_HASH_FILE", "")
	t.Setenv("PORTAL_AD_URL", "")
	path := filepath.Join(t.TempDir(), "hot.key")
	arch := filepath.Join(t.TempDir(), "arch.key")
	if err := os.WriteFile(path, bytes.Repeat([]byte{1}, 32), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(arch, bytes.Repeat([]byte{2}, 32), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PORTAL_AUDITOR_HOT_URL", "https://audit-primary.example.invalid/audit/")
	t.Setenv("AUDITOR_HOT_GATEWAY_KEY_FILE", path)
	t.Setenv("PORTAL_AUDITOR_ARCH_URL", "https://audit-secondary.example.invalid/audit-arch/")
	t.Setenv("AUDITOR_ARCH_GATEWAY_KEY_FILE", arch)
	c, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if len(c.ServiceGateways) != 2 || c.ServiceGateways[0].Prefix != "/audit" || c.ServiceGateways[1].Prefix != "/audit-arch" || c.ServiceGateways[0].AssertionVersion != 2 || c.ServiceGateways[1].AssertionVersion != 2 {
		t.Fatal("bad auditor config")
	}
	if err := os.WriteFile(arch, bytes.Repeat([]byte{1}, 32), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadConfig(); err == nil {
		t.Fatal("shared HOT/ARCH key accepted")
	}
	t.Setenv("PORTAL_AUDITOR_ARCH_URL", "https://audit-secondary.example.invalid/audit/")
	if _, err := LoadConfig(); err == nil {
		t.Fatal("ARCH URL accepted HOT prefix")
	}
}

func TestAuditorGatewayViewerAdminAndCSRF(t *testing.T) {
	s := apiFixture(t)
	viewer := apiUser(t, s, "auditor-viewer", false)
	admin := apiUser(t, s, "auditor-admin", true)
	key := bytes.Repeat([]byte{42}, 32)
	calls := 0
	var claims gatewayIdentity
	rt := directoryRoundTrip(func(r *http.Request) (*http.Response, error) {
		calls++
		claims = decodeDirectoryAssertion(t, r, key)
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: http.NoBody}, nil
	})
	h := s.ServiceGateway(ServiceGatewayConfig{Audience: "auditor", Prefix: "/audit", AssertionVersion: 2, Upstream: "https://audit-primary.example.invalid/audit/", Key: key, Transport: rt})
	call := func(who apiIdentity, method, path string, csrf bool) int {
		r := httptest.NewRequest(method, s.Config.PublicURL+path, nil)
		r.RemoteAddr = "192.0.2.10:1234"
		if who.cookie != nil {
			r.AddCookie(who.cookie)
		}
		if method == "POST" {
			r.Header.Set("Origin", s.Config.PublicURL)
			if csrf {
				r.Header.Set("X-CSRF-Token", who.csrf)
			}
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	if got := call(viewer, "GET", "/audit/api/findings", false); got != 200 || claims.Admin || !reflect.DeepEqual(claims.Scopes, []string{"auditor:read"}) {
		t.Fatal("viewer read", got, claims)
	}
	if got := call(admin, "POST", "/audit/api/scans", true); got != 200 || !claims.Admin || !claims.CSRFVerified {
		t.Fatal("admin scan", got, claims)
	}
	before := calls
	for _, tc := range []struct {
		who          apiIdentity
		method, path string
		csrf         bool
		status       int
	}{
		{apiIdentity{}, "GET", "/audit/api/findings", false, 401},
		{viewer, "POST", "/audit/api/scans", true, 403},
		{admin, "POST", "/audit/api/scans", false, 403},
		{admin, "GET", "/audit/health", false, 404},
		{admin, "POST", "/audit/api/instance", true, 404},
	} {
		if got := call(tc.who, tc.method, tc.path, tc.csrf); got != tc.status {
			t.Fatalf("%s %s: %d", tc.method, tc.path, got)
		}
	}
	if calls != before {
		t.Fatal("denied request reached Auditor")
	}
}

func TestAuditorPublishedV2Vectors(t *testing.T) {
	var fixture struct {
		TestKeyHex string `json:"test_key_hex"`
		Vectors    []struct {
			Method      string          `json:"method"`
			URI         string          `json:"uri"`
			ContentType string          `json:"content_type"`
			BodyUTF8    string          `json:"body_utf8"`
			Assertion   string          `json:"assertion"`
			Signature   string          `json:"signature"`
			Claims      gatewayIdentity `json:"claims"`
		} `json:"vectors"`
	}
	data, err := os.ReadFile("../../docs/examples/auditor-v2-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	key, err := hex.DecodeString(fixture.TestKeyHex)
	if err != nil || len(key) != 32 || len(fixture.Vectors) != 2 {
		t.Fatal("invalid vector fixture")
	}
	for _, v := range fixture.Vectors {
		request := httptest.NewRequest(v.Method, "https://monitoring.example"+v.URI, strings.NewReader(v.BodyUTF8))
		if v.ContentType != "" {
			request.Header.Set("Content-Type", v.ContentType)
		}
		if err := writeGatewayIdentity(request, v.Claims, key); err != nil {
			t.Fatal(err)
		}
		if request.Header.Get(gatewayAssertionHeader) != v.Assertion || request.Header.Get(gatewaySignatureHeader) != v.Signature || v.Claims.URI != request.URL.RequestURI() || v.Claims.Method != request.Method {
			t.Fatalf("Go issuer disagrees with published %s fixture", v.Method)
		}
		digest := sha256.Sum256([]byte(v.BodyUTF8))
		if v.Claims.BodySHA256 != hex.EncodeToString(digest[:]) || v.Claims.ContentType != request.Header.Get("Content-Type") {
			t.Fatal("fixture request binding")
		}
	}
}

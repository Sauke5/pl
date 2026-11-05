package server

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"pl/portal/internal/model"
)

func doskaTestSession() session {
	return session{User: model.User{ID: "ad:0123456789abcdef:000102030405060708090a0b0c0d0e0f", Name: "Иван Иванов <Doska>"}, CSRF: "test-only-portal-csrf"}
}

func TestDoskaPublishedVectors(t *testing.T) {
	data, err := os.ReadFile("../../docs/examples/doska-gateway-v2-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		TestOnly bool   `json:"test_only"`
		Key      string `json:"key_hex"`
		CSRF     string `json:"portal_csrf_utf8"`
		Vectors  []struct {
			Name     string `json:"name"`
			Now      int64  `json:"now"`
			Kind     string `json:"route_kind"`
			External string `json:"external_uri"`
			Upstream string `json:"upstream_uri"`
			Request  struct {
				Method  string            `json:"method"`
				Body    string            `json:"body_utf8"`
				Headers map[string]string `json:"headers"`
			} `json:"request"`
			Payload   gatewayIdentity `json:"payload"`
			JSON      string          `json:"canonical_json_utf8"`
			JSONHex   string          `json:"canonical_json_hex"`
			Input     string          `json:"hmac_input_ascii"`
			MAC       string          `json:"expected_hmac_hex"`
			Signature string          `json:"expected_signature"`
		} `json:"vectors"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	key, err := hex.DecodeString(fixture.Key)
	if err != nil || !fixture.TestOnly || len(fixture.Vectors) != 2 || fixture.CSRF != doskaTestSession().CSRF {
		t.Fatal("invalid public fixture")
	}
	for _, vector := range fixture.Vectors {
		t.Run(vector.Name, func(t *testing.T) {
			r := httptest.NewRequest(vector.Request.Method, "http://portal.test"+vector.External, nil)
			for key, value := range vector.Request.Headers {
				r.Header.Set(key, value)
			}
			r.Header.Del(gatewayAssertionHeader)
			r.Header.Del(gatewaySignatureHeader)
			kind := doskaRouteRead
			if vector.Kind == "write" {
				kind = doskaRouteWrite
			}
			if err := signDoskaRequestNonce(r, []byte(vector.Request.Body), doskaTestSession(), kind, key, time.Unix(vector.Now, 0), vector.Payload.CSRFVerified, "192.0.2.10", vector.Payload.Nonce); err != nil {
				t.Fatal(err)
			}
			encoded := r.Header.Get(gatewayAssertionHeader)
			raw, err := base64.RawURLEncoding.DecodeString(encoded)
			if err != nil || string(raw) != vector.JSON || hex.EncodeToString(raw) != vector.JSONHex || "pl-gateway-v2\n"+encoded != vector.Input {
				t.Fatal("assertion bytes differ")
			}
			var claims gatewayIdentity
			if err := json.Unmarshal(raw, &claims); err != nil || !reflect.DeepEqual(claims, vector.Payload) || claims.Admin || claims.Audience != "doska" {
				t.Fatal("claims differ")
			}
			mac, err := base64.RawURLEncoding.DecodeString(vector.Signature)
			if err != nil || hex.EncodeToString(mac) != vector.MAC || r.Header.Get(gatewaySignatureHeader) != vector.Signature || gatewayMAC(key, vector.Input) != vector.Signature {
				t.Fatal("signature differs")
			}
			if claims.URI != vector.External || "/doska"+vector.Upstream != vector.External || claims.CSRFToken == fixture.CSRF || claims.CSRFToken == gatewayServiceCSRF(fixture.CSRF, "directory") {
				t.Fatal("external URI or CSRF audience binding differs")
			}
			for _, replacement := range []string{strings.Replace(vector.JSON, `"aud":"doska"`, `"aud":"directory"`, 1), strings.Replace(vector.JSON, `"admin":false`, `"admin":true`, 1), strings.Replace(vector.JSON, vector.External, vector.Upstream, 1)} {
				if gatewayMAC(key, "pl-gateway-v2\n"+base64.RawURLEncoding.EncodeToString([]byte(replacement))) == vector.Signature {
					t.Fatal("tampering retained signature")
				}
			}
		})
	}
}

func TestDoskaSignerBoundaries(t *testing.T) {
	key := []byte("0123456789abcdef0123456789abcdef")
	now := time.Unix(1790000000, 0)
	for _, tc := range []struct {
		name   string
		change func(*http.Request, *[]byte, *session, *doskaRouteKind, *bool, *[]byte)
	}{
		{"key", func(_ *http.Request, _ *[]byte, _ *session, _ *doskaRouteKind, _ *bool, k *[]byte) { *k = (*k)[:31] }},
		{"missing-identity", func(_ *http.Request, _ *[]byte, s *session, _ *doskaRouteKind, _ *bool, _ *[]byte) { s.User.ID = "" }},
		{"oversize-name", func(_ *http.Request, _ *[]byte, s *session, _ *doskaRouteKind, _ *bool, _ *[]byte) {
			s.User.Name = strings.Repeat("x", 513)
		}},
		{"prefix-stripped", func(r *http.Request, _ *[]byte, _ *session, _ *doskaRouteKind, _ *bool, _ *[]byte) {
			r.URL.Path = "/api/task/project-123"
		}},
		{"wrong-prefix", func(r *http.Request, _ *[]byte, _ *session, _ *doskaRouteKind, _ *bool, _ *[]byte) {
			r.URL.Path = "/admin/api/task/project-123"
		}},
		{"traversal", func(r *http.Request, _ *[]byte, _ *session, _ *doskaRouteKind, _ *bool, _ *[]byte) {
			r.URL.Path = "/doska/api/../auth"
		}},
		{"rawpath", func(r *http.Request, _ *[]byte, _ *session, _ *doskaRouteKind, _ *bool, _ *[]byte) {
			r.URL.RawPath = "/doska/api/task/%70roject-123"
		}},
		{"double-slash", func(r *http.Request, _ *[]byte, _ *session, _ *doskaRouteKind, _ *bool, _ *[]byte) {
			r.URL.Path = "/doska/api//task"
		}},
		{"uri-limit", func(r *http.Request, _ *[]byte, _ *session, _ *doskaRouteKind, _ *bool, _ *[]byte) {
			r.URL.RawQuery = strings.Repeat("x", 4096)
		}},
		{"body-limit", func(_ *http.Request, b *[]byte, _ *session, _ *doskaRouteKind, _ *bool, _ *[]byte) {
			*b = make([]byte, (2<<20)+1)
		}},
		{"csrf-unverified", func(_ *http.Request, _ *[]byte, _ *session, _ *doskaRouteKind, v *bool, _ *[]byte) { *v = false }},
		{"csrf-portal", func(r *http.Request, _ *[]byte, s *session, _ *doskaRouteKind, _ *bool, _ *[]byte) {
			r.Header.Set("X-CSRF-Token", s.CSRF)
		}},
		{"csrf-foreign-app", func(r *http.Request, _ *[]byte, s *session, _ *doskaRouteKind, _ *bool, _ *[]byte) {
			r.Header.Set("X-CSRF-Token", gatewayServiceCSRF(s.CSRF, "directory"))
		}},
		{"duplicate-csrf", func(r *http.Request, _ *[]byte, _ *session, _ *doskaRouteKind, _ *bool, _ *[]byte) {
			r.Header.Add("X-CSRF-Token", "foreign")
		}},
		{"duplicate-type", func(r *http.Request, _ *[]byte, _ *session, _ *doskaRouteKind, _ *bool, _ *[]byte) {
			r.Header.Add("Content-Type", "text/plain")
		}},
		{"bad-type", func(r *http.Request, _ *[]byte, _ *session, _ *doskaRouteKind, _ *bool, _ *[]byte) {
			r.Header.Set("Content-Type", "invalid")
		}},
		{"type-limit", func(r *http.Request, _ *[]byte, _ *session, _ *doskaRouteKind, _ *bool, _ *[]byte) {
			r.Header.Set("Content-Type", strings.Repeat("x", 257))
		}},
		{"encoding", func(r *http.Request, _ *[]byte, _ *session, _ *doskaRouteKind, _ *bool, _ *[]byte) {
			r.Header.Set("Content-Encoding", "gzip")
		}},
		{"idem-limit", func(r *http.Request, _ *[]byte, _ *session, _ *doskaRouteKind, _ *bool, _ *[]byte) {
			r.Header.Set("Idempotency-Key", strings.Repeat("x", 129))
		}},
		{"idem-space", func(r *http.Request, _ *[]byte, _ *session, _ *doskaRouteKind, _ *bool, _ *[]byte) {
			r.Header.Set("Idempotency-Key", " key")
		}},
		{"method", func(r *http.Request, _ *[]byte, _ *session, _ *doskaRouteKind, _ *bool, _ *[]byte) {
			r.Method = "TRACE"
		}},
		{"read-kind", func(_ *http.Request, _ *[]byte, _ *session, k *doskaRouteKind, _ *bool, _ *[]byte) {
			*k = doskaRouteRead
		}},
		{"unknown-kind", func(_ *http.Request, _ *[]byte, _ *session, k *doskaRouteKind, _ *bool, _ *[]byte) { *k = 0 }},
		{"upgrade", func(r *http.Request, _ *[]byte, _ *session, _ *doskaRouteKind, _ *bool, _ *[]byte) {
			r.Header.Set("Upgrade", "websocket")
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "http://portal.test/doska/api/task/project-123", nil)
			sess, body, kind, verified, k := doskaTestSession(), []byte("{}"), doskaRouteWrite, true, append([]byte(nil), key...)
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("X-CSRF-Token", gatewayServiceCSRF(sess.CSRF, "doska"))
			tc.change(r, &body, &sess, &kind, &verified, &k)
			if signDoskaRequest(r, body, sess, kind, k, now, verified, "192.0.2.10") == nil || r.Header.Get(gatewayAssertionHeader) != "" {
				t.Fatal("invalid input signed")
			}
		})
	}
	for _, method := range []string{"POST", "PUT", "PATCH", "DELETE"} {
		r := httptest.NewRequest(method, "http://portal.test/doska/api/task/project-123", nil)
		r.Header.Set("X-CSRF-Token", gatewayServiceCSRF(doskaTestSession().CSRF, "doska"))
		if err := signDoskaRequest(r, nil, doskaTestSession(), doskaRouteWrite, key, now, true, "192.0.2.10"); err != nil {
			t.Fatalf("employee mutation %s: %v", method, err)
		}
	}
}

func TestDoskaSafeAndWebSocketGates(t *testing.T) {
	key := []byte("0123456789abcdef0123456789abcdef")
	for _, tc := range []struct {
		method, uri, upgrade string
		kind                 doskaRouteKind
		body                 string
		verified, allowed    bool
	}{
		{"GET", "/doska/api/search?q=a%2Fb&q=c", "", doskaRouteRead, "", false, true},
		{"HEAD", "/doska/api/task/project-123", "", doskaRouteRead, "", false, true},
		{"GET", "/doska/api/task/project-123", "", doskaRouteRead, "{}", false, false},
		{"GET", "/doska/api/task/project-123", "", doskaRouteRead, "", true, false},
		{"GET", "/doska/api/ws/user", "websocket", doskaRouteWebSocket, "", false, true},
		{"GET", "/doska/api/ws/project-123?windowId=window-123", "websocket", doskaRouteWebSocket, "", false, true},
		{"GET", "/doska/api/ws/user", "", doskaRouteRead, "", false, false},
		{"GET", "/doska/api/ws/user", "websocket", doskaRouteRead, "", false, false},
		{"GET", "/doska/api/ws/user", "", doskaRouteWebSocket, "", false, false},
		{"GET", "/doska/api/ws/a/b", "websocket", doskaRouteWebSocket, "", false, false},
		{"GET", "/doska/api/ws/user?token=secret", "websocket", doskaRouteWebSocket, "", false, false},
		{"GET", "/doska/api/ws/user?windowId=a&windowId=b", "websocket", doskaRouteWebSocket, "", false, false},
		{"GET", "/doska/api/ws/user?windowId=", "websocket", doskaRouteWebSocket, "", false, false},
		{"GET", "/doska/api/ws/user?windowId=a%2Fb", "websocket", doskaRouteWebSocket, "", false, false},
		{"POST", "/doska/api/ws/user", "websocket", doskaRouteWebSocket, "", false, false},
		{"GET", "/doska/api/task/user", "websocket", doskaRouteWebSocket, "", false, false},
	} {
		t.Run(tc.method+tc.uri+tc.upgrade+string(rune(tc.kind)), func(t *testing.T) {
			r := httptest.NewRequest(tc.method, "http://portal.test"+tc.uri, nil)
			if tc.upgrade != "" {
				r.Header.Set("Upgrade", tc.upgrade)
			}
			if tc.body != "" {
				r.Header.Set("Content-Type", "application/json")
			}
			err := signDoskaRequest(r, []byte(tc.body), doskaTestSession(), tc.kind, key, time.Unix(1790000000, 0), tc.verified, "192.0.2.10")
			if (err == nil) != tc.allowed {
				t.Fatalf("allowed=%v error=%v", tc.allowed, err)
			}
		})
	}
	r := httptest.NewRequest("GET", "http://portal.test/doska/api/task/user", nil)
	if err := signDoskaRequest(r, nil, doskaTestSession(), doskaRouteRead, key, time.Unix(1790000000, 0), false, "192.0.2.10"); err != nil {
		t.Fatal(err)
	}
	raw, _ := base64.RawURLEncoding.DecodeString(r.Header.Get(gatewayAssertionHeader))
	var claims gatewayIdentity
	if err := json.Unmarshal(raw, &claims); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(nil)
	if claims.BodySHA256 != hex.EncodeToString(digest[:]) || claims.Admin || claims.ExpiresAt-claims.IssuedAt != 30 {
		t.Fatal("safe claims differ")
	}
}

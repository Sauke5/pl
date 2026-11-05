package server

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"pl/portal/internal/model"
)

func TestGatewayIdentityPublishedPythonVector(t *testing.T) {
	doc, err := os.ReadFile("../../docs/platform-sso-contract.md")
	if err != nil {
		t.Fatal(err)
	}
	start := strings.LastIndex(string(doc), "```json\n")
	if start < 0 {
		t.Fatal("vector missing")
	}
	data := strings.SplitN(string(doc)[start+8:], "```", 2)[0]
	var vector struct {
		Claims    gatewayIdentity `json:"claims"`
		Assertion string          `json:"assertion"`
		Signature string          `json:"signature"`
		CSRF      string          `json:"expected_service_csrf"`
	}
	if err = json.Unmarshal([]byte(data), &vector); err != nil {
		t.Fatal(err)
	}
	key := []byte("0123456789abcdef0123456789abcdef") // Published test bytes, not a secret.
	req := httptest.NewRequest("POST", "http://source/admin/", nil)
	if err = writeGatewayIdentity(req, vector.Claims, key); err != nil {
		t.Fatal(err)
	}
	if req.Header.Get(gatewayAssertionHeader) != vector.Assertion || req.Header.Get(gatewaySignatureHeader) != vector.Signature || vector.Signature != "TUhJ6q8-O85ImARF0JqL6ZfwHdqCK8DW1mpGKwbAsWU" {
		t.Fatal("Go/Python assertion bytes differ")
	}
	if actual := gatewayServiceCSRF("test-only-portal-csrf", "monitoring-admin"); actual != vector.CSRF {
		t.Fatal("CSRF vector differs")
	}
	digest := sha256.Sum256([]byte(`{"idempotency_key":"test-restart-001"}`))
	if hex.EncodeToString(digest[:]) != vector.Claims.BodySHA256 {
		t.Fatal("body bytes differ")
	}
}

func TestGatewayIdentityPublishedAdminVectors(t *testing.T) {
	data, err := os.ReadFile("../../docs/examples/admin-v1-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors struct {
		Schema     int    `json:"schema"`
		Key        string `json:"key_raw_ascii"`
		PortalCSRF string `json:"portal_csrf"`
		Cases      []struct {
			Claims    gatewayIdentity `json:"claims"`
			Body      string          `json:"body_utf8"`
			CSRF      string          `json:"expected_service_csrf"`
			Assertion string          `json:"assertion"`
			Signature string          `json:"signature"`
		} `json:"cases"`
	}
	if err = json.Unmarshal(data, &vectors); err != nil || vectors.Schema != 1 || len(vectors.Cases) != 2 {
		t.Fatal("invalid shared admin vectors", err)
	}
	for _, vector := range vectors.Cases {
		t.Run(vector.Claims.Audience, func(t *testing.T) {
			claims := vector.Claims
			if claims.Audience != "monitoring-admin" && claims.Audience != "websites-admin" {
				t.Fatal("unexpected audience")
			}
			r := httptest.NewRequest(claims.Method, "http://source"+claims.URI, nil)
			r.Header.Set("Content-Type", claims.ContentType)
			r.Header.Set("Idempotency-Key", claims.IdempotencyKey)
			sess := session{User: model.User{ID: claims.Subject, Name: claims.Name, Admin: true}, CSRF: vectors.PortalCSRF}
			if err := signGatewayRequest(r, []byte(vector.Body), sess, claims.Audience, claims.Scopes, []byte(vectors.Key), time.Unix(claims.IssuedAt, 0), true, claims.SourceIP); err != nil {
				t.Fatal(err)
			}
			payload, err := base64.RawURLEncoding.DecodeString(r.Header.Get(gatewayAssertionHeader))
			if err != nil {
				t.Fatal(err)
			}
			var actual gatewayIdentity
			if err := json.Unmarshal(payload, &actual); err != nil {
				t.Fatal(err)
			}
			actual.Nonce = claims.Nonce // Production nonce is random; all other signed fields are fixed.
			if !reflect.DeepEqual(actual, claims) || gatewayServiceCSRF(vectors.PortalCSRF, claims.Audience) != vector.CSRF {
				t.Fatal("issuer claims or derived CSRF differ from shared vector")
			}
			if err := writeGatewayIdentity(r, actual, []byte(vectors.Key)); err != nil {
				t.Fatal(err)
			}
			if r.Header.Get(gatewayAssertionHeader) != vector.Assertion || r.Header.Get(gatewaySignatureHeader) != vector.Signature {
				t.Fatal("shared Go/Python vector bytes differ")
			}
		})
	}
}
func TestGatewaySignerRequiredFieldsBoundsAndRestartKey(t *testing.T) {
	sess := session{User: model.User{ID: "ad:user", Name: "Пользователь", Admin: true}, CSRF: "fixture-portal-csrf"}
	now := time.Unix(1790000000, 0)
	key := []byte("0123456789abcdef0123456789abcdef")
	req := httptest.NewRequest("POST", "http://source/admin/api/v1/containers/example/restart?q=a%2Fb&q=c", nil)
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	if err := signGatewayRequest(req, []byte("{}"), sess, "monitoring-admin", []string{"monitoring:read", "audit:read", "monitoring:read", "containers:restart"}, key, now, true, "192.0.2.10"); err != nil {
		t.Fatal(err)
	}
	data, err := base64.RawURLEncoding.DecodeString(req.Header.Get(gatewayAssertionHeader))
	if err != nil {
		t.Fatal(err)
	}
	var claims gatewayIdentity
	if err = json.Unmarshal(data, &claims); err != nil {
		t.Fatal(err)
	}
	if claims.IdempotencyKey != "gw-"+claims.Nonce || claims.IdempotencyKey != req.Header.Get("Idempotency-Key") || !claims.Admin || claims.SourceIP != "192.0.2.10" || claims.URI != "/admin/api/v1/containers/example/restart?q=a%2Fb&q=c" || claims.ExpiresAt-claims.IssuedAt != 30 || len(claims.Scopes) != 3 || claims.CSRFToken == sess.CSRF {
		t.Fatal("required claims differ")
	}
	nonce, err := base64.RawURLEncoding.DecodeString(claims.Nonce)
	if err != nil || len(nonce) != 32 {
		t.Fatal("incorrect nonce")
	}
	for _, n := range []int{0, 31, 33, 64} {
		if signGatewayRequest(req, nil, sess, "monitoring-admin", nil, make([]byte, n), now, true, "192.0.2.10") == nil {
			t.Fatal("invalid key accepted", n)
		}
	}
	bad := sess
	bad.User.ID = strings.Repeat("x", 257)
	if signGatewayRequest(req, nil, bad, "monitoring-admin", nil, key, now, true, "192.0.2.10") == nil {
		t.Fatal("oversized identity accepted")
	}
	if signGatewayRequest(req, nil, sess, "websites-admin", []string{"audit:read"}, key, now, true, "192.0.2.10") == nil {
		t.Fatal("excessive websites scope accepted")
	}
	if signGatewayRequest(req, nil, sess, "unknown", nil, key, now, true, "192.0.2.10") == nil {
		t.Fatal("unknown audience accepted")
	}
}

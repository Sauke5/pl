package server

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const gatewayAssertionHeader = "X-PL-Gateway-Assertion"
const gatewaySignatureHeader = "X-PL-Gateway-Signature"

// Field order is shared with the published deterministic cross-language vector.
// Verifiers authenticate the encoded bytes, never reserialize this structure.
type gatewayIdentity struct {
	Version        int      `json:"v"`
	Audience       string   `json:"aud"`
	IssuedAt       int64    `json:"iat"`
	ExpiresAt      int64    `json:"exp"`
	Nonce          string   `json:"nonce"`
	Subject        string   `json:"sub"`
	Name           string   `json:"name"`
	Admin          bool     `json:"admin"`
	Scopes         []string `json:"scopes"`
	Method         string   `json:"method"`
	URI            string   `json:"uri"`
	ContentType    string   `json:"content_type"`
	BodySHA256     string   `json:"body_sha256"`
	IdempotencyKey string   `json:"idempotency_key"`
	SourceIP       string   `json:"source_ip"`
	CSRFToken      string   `json:"csrf_token"`
	CSRFVerified   bool     `json:"csrf_verified"`
}

func gatewayMAC(key []byte, value string) string {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(value))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
func gatewayServiceCSRF(portalCSRF, audience string) string {
	return gatewayMAC([]byte(portalCSRF), "pl-gateway-csrf-v1\n"+audience)
}
func gatewayString(v string, max int, ascii bool) bool {
	if len(v) > max || !utf8.ValidString(v) {
		return false
	}
	for _, r := range v {
		if unicode.IsControl(r) || ascii && r > 127 {
			return false
		}
	}
	return true
}
func gatewayRestart(r *http.Request, audience string) bool {
	return audience == "monitoring-admin" && r.Method == "POST" && strings.HasPrefix(r.URL.Path, "/admin/api/v1/containers/") && strings.HasSuffix(r.URL.Path, "/restart")
}
func signGatewayRequest(r *http.Request, body []byte, sess session, audience string, scopes []string, key []byte, now time.Time, verified bool, sourceIP string) error {
	if len(key) != 32 || sess.User.ID == "" || sess.CSRF == "" || !sess.User.Admin || !gatewayString(sess.User.ID, 256, false) || !gatewayString(sess.User.Name, 512, false) || net.ParseIP(sourceIP) == nil || !gatewayString(r.URL.RequestURI(), 4096, true) || !gatewayString(r.Header.Get("Content-Type"), 256, true) || !gatewayString(r.Header.Get("Idempotency-Key"), 128, true) {
		return errors.New("invalid gateway identity")
	}
	allowed := map[string]bool{}
	switch audience {
	case "monitoring-admin":
		for _, v := range []string{"audit:read", "containers:restart", "monitoring:read"} {
			allowed[v] = true
		}
	case "proxy-control":
		allowed["proxy:read"] = true
		allowed["proxy:mode"] = true
	case "websites-admin":
		for _, v := range []string{"websites:read", "websites:write"} {
			allowed[v] = true
		}
	default:
		return errors.New("invalid gateway audience")
	}
	ordered := []string{}
	seen := map[string]bool{}
	for _, scope := range scopes {
		if !allowed[scope] {
			return errors.New("invalid gateway scope")
		}
		if !seen[scope] {
			ordered = append(ordered, scope)
			seen[scope] = true
		}
	}
	sort.Strings(ordered)
	nonce := randomToken()
	if gatewayRestart(r, audience) && r.Header.Get("Idempotency-Key") == "" {
		r.Header.Set("Idempotency-Key", "gw-"+nonce)
	}
	digest := sha256.Sum256(body)
	claims := gatewayIdentity{Version: 1, Audience: audience, IssuedAt: now.Unix(), ExpiresAt: now.Unix() + 30, Nonce: nonce, Subject: sess.User.ID, Name: sess.User.Name, Admin: true, Scopes: ordered, Method: r.Method, URI: r.URL.RequestURI(), ContentType: r.Header.Get("Content-Type"), BodySHA256: hex.EncodeToString(digest[:]), IdempotencyKey: r.Header.Get("Idempotency-Key"), SourceIP: sourceIP, CSRFToken: gatewayServiceCSRF(sess.CSRF, audience), CSRFVerified: verified}
	return writeGatewayIdentity(r, claims, key)
}
func writeGatewayIdentity(r *http.Request, claims gatewayIdentity, key []byte) error {
	if len(key) != 32 {
		return errors.New("invalid gateway key")
	}
	var payload bytes.Buffer
	encoder := json.NewEncoder(&payload)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(claims); err != nil {
		return err
	}
	encoded := base64.RawURLEncoding.EncodeToString(bytes.TrimSuffix(payload.Bytes(), []byte("\n")))
	if len(encoded) > 8192 {
		return errors.New("gateway assertion too large")
	}
	r.Header.Set(gatewayAssertionHeader, encoded)
	domain := "pl-gateway-v1\n"
	if claims.Version == 2 {
		domain = "pl-gateway-v2\n"
	} else if claims.Version != 1 {
		return errors.New("unsupported gateway version")
	}
	r.Header.Set(gatewaySignatureHeader, gatewayMAC(key, domain+encoded))
	return nil
}

// Directory v2 derives identity and capabilities only from the Platform session.
// The v1 signer deliberately retains its admin-only contract.
func signDirectoryRequest(r *http.Request, body []byte, sess session, key []byte, now time.Time, verified bool, sourceIP string) error {
	if len(key) != 32 || sess.User.ID == "" || sess.User.Name == "" || sess.CSRF == "" || !gatewayString(sess.User.ID, 256, false) || !gatewayString(sess.User.Name, 512, false) || net.ParseIP(sourceIP) == nil || !gatewayString(r.URL.RequestURI(), 4096, true) || !gatewayString(r.Header.Get("Content-Type"), 256, true) || !gatewayString(r.Header.Get("Idempotency-Key"), 128, true) {
		return errors.New("invalid gateway identity")
	}
	safe := r.Method == "GET" || r.Method == "HEAD" || r.Method == "OPTIONS"
	if !strings.HasPrefix(r.URL.Path, "/directory/") || !gatewayRoute("directory", r.Method, strings.TrimPrefix(r.URL.Path, "/directory")) || (!safe && (!verified || !sess.User.Admin)) || (safe && (len(body) != 0 || verified)) {
		return errors.New("invalid directory request")
	}
	scopes := []string{"directory:read"}
	if sess.User.Admin {
		scopes = []string{"directory:audit:read", "directory:read", "directory:write"}
	}
	digest := sha256.Sum256(body)
	claims := gatewayIdentity{Version: 2, Audience: "directory", IssuedAt: now.Unix(), ExpiresAt: now.Unix() + 30, Nonce: randomToken(), Subject: sess.User.ID, Name: sess.User.Name, Admin: sess.User.Admin, Scopes: scopes, Method: r.Method, URI: r.URL.RequestURI(), ContentType: r.Header.Get("Content-Type"), BodySHA256: hex.EncodeToString(digest[:]), IdempotencyKey: r.Header.Get("Idempotency-Key"), SourceIP: sourceIP, CSRFToken: gatewayServiceCSRF(sess.CSRF, "directory"), CSRFVerified: verified}
	return writeGatewayIdentity(r, claims, key)
}

// Auditor v2 binds one Platform identity and capability set to the exact
// prefixed request. HOT and ARCH use separate keys and signed URI prefixes.
func signAuditorRequest(r *http.Request, body []byte, sess session, prefix string, key []byte, now time.Time, verified bool, sourceIP string) error {
	if len(key) != 32 || sess.User.ID == "" || sess.User.Name == "" || sess.CSRF == "" || !gatewayString(sess.User.ID, 256, false) || !gatewayString(sess.User.Name, 512, false) || net.ParseIP(sourceIP) == nil || !gatewayString(r.URL.RequestURI(), 4096, true) || !gatewayString(r.Header.Get("Content-Type"), 256, true) || !gatewayString(r.Header.Get("Idempotency-Key"), 128, true) {
		return errors.New("invalid gateway identity")
	}
	if prefix != "/audit" && prefix != "/audit-arch" {
		return errors.New("invalid auditor prefix")
	}
	read := r.Method == "GET" || r.Method == "HEAD"
	if !strings.HasPrefix(r.URL.Path, prefix+"/") || !gatewayRoute("auditor", r.Method, strings.TrimPrefix(r.URL.Path, prefix)) || (!read && (!verified || !sess.User.Admin)) || (read && (len(body) != 0 || verified)) {
		return errors.New("invalid auditor request")
	}
	scopes := []string{"auditor:read"}
	if sess.User.Admin {
		scopes = []string{"auditor:read", "auditor:scan"}
	}
	digest := sha256.Sum256(body)
	claims := gatewayIdentity{Version: 2, Audience: "auditor", IssuedAt: now.Unix(), ExpiresAt: now.Unix() + 30, Nonce: randomToken(), Subject: sess.User.ID, Name: sess.User.Name, Admin: sess.User.Admin, Scopes: scopes, Method: r.Method, URI: r.URL.RequestURI(), ContentType: r.Header.Get("Content-Type"), BodySHA256: hex.EncodeToString(digest[:]), IdempotencyKey: r.Header.Get("Idempotency-Key"), SourceIP: sourceIP, CSRFToken: gatewayServiceCSRF(sess.CSRF, "auditor"), CSRFVerified: verified}
	return writeGatewayIdentity(r, claims, key)
}

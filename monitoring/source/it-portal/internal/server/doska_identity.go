package server

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// doskaRouteKind is supplied only after the app-specific finite route registry
// has authorized the route and method. It is not itself a route allowlist.
type doskaRouteKind uint8

const (
	doskaRouteRead doskaRouteKind = iota + 1
	doskaRouteWrite
	doskaRouteWebSocket
	doskaRouteUpload
	doskaRouteEvents
)

// signDoskaRequest signs the external URI BEFORE /doska is stripped for the
// fixed upstream. The backend reconstructs that URI using a constant prefix.
// This candidate is intentionally not registered in the production router.
func signDoskaRequest(r *http.Request, body []byte, sess session, kind doskaRouteKind, key []byte, now time.Time, verified bool, sourceIP string) error {
	return signDoskaRequestNonce(r, body, sess, kind, key, now, verified, sourceIP, randomToken())
}

func signDoskaRequestNonce(r *http.Request, body []byte, sess session, kind doskaRouteKind, key []byte, now time.Time, verified bool, sourceIP, nonce string) error {
	if len(body) > 2<<20 {
		return errors.New("doska JSON signer body limit")
	}
	digest := sha256.Sum256(body)
	return signDoskaDigest(r, digest, int64(len(body)), sess, kind, key, now, verified, sourceIP, nonce)
}

// Only the completed private spool supplies upload digests; client hashes never
// enter this signing path. JSON callers keep their independent 2 MiB bound.
func signDoskaUpload(r *http.Request, spool *doskaSpool, sess session, key []byte, now time.Time, sourceIP string) error {
	if spool == nil || !spool.complete || spool.size > doskaFileLimit {
		return errors.New("incomplete upload spool")
	}
	return signDoskaDigest(r, spool.digest, spool.size, sess, doskaRouteUpload, key, now, true, sourceIP, randomToken())
}

func signDoskaDigest(r *http.Request, digest [32]byte, size int64, sess session, kind doskaRouteKind, key []byte, now time.Time, verified bool, sourceIP, nonce string) error {
	invalid := errors.New("invalid doska gateway request")
	if r == nil || r.URL == nil || len(key) != 32 || sess.User.ID == "" || sess.User.Name == "" || sess.CSRF == "" ||
		!gatewayString(sess.User.ID, 256, false) || !gatewayString(sess.User.Name, 512, false) || net.ParseIP(sourceIP) == nil {
		return invalid
	}
	decoded, err := base64.RawURLEncoding.DecodeString(nonce)
	if err != nil || len(decoded) < 16 || len(decoded) > 64 || base64.RawURLEncoding.EncodeToString(decoded) != nonce {
		return invalid
	}
	path := r.URL.Path
	if !strings.HasPrefix(path, "/doska/api/") || r.URL.RawPath != "" || r.URL.Fragment != "" || r.URL.ForceQuery || strings.ContainsAny(r.URL.EscapedPath(), "%\\") || strings.Contains(path, "..") || strings.Contains(path, "//") || !gatewayString(r.URL.RequestURI(), 4096, true) {
		return invalid
	}
	for _, name := range []string{"Content-Type", "Content-Encoding", "Idempotency-Key", "X-CSRF-Token", "Upgrade"} {
		if len(r.Header.Values(name)) > 1 {
			return invalid
		}
	}
	contentType, idempotency := r.Header.Get("Content-Type"), r.Header.Get("Idempotency-Key")
	if !gatewayString(contentType, 256, true) || !gatewayString(idempotency, 128, true) || strings.TrimSpace(idempotency) != idempotency || (len(r.Header.Values("Idempotency-Key")) > 0 && idempotency == "") {
		return invalid
	}
	if contentType != "" {
		mediaType, _, err := mime.ParseMediaType(contentType)
		if err != nil || !strings.Contains(mediaType, "/") {
			return invalid
		}
	} else if size > 0 {
		return invalid
	}
	if encoding := r.Header.Get("Content-Encoding"); encoding != "" && encoding != "identity" {
		return invalid
	}
	read := r.Method == http.MethodGet || r.Method == http.MethodHead
	derived := gatewayServiceCSRF(sess.CSRF, "doska")
	switch kind {
	case doskaRouteEvents:
		if r.Method != "GET" || path != doskaEventsPath || r.URL.RawQuery != "" || contentType != "" || idempotency != "" || r.Header.Get("Upgrade") != "" {
			return invalid
		}
	case doskaRouteRead:
		if !read || strings.HasPrefix(path, "/doska/api/ws/") || r.Header.Get("Upgrade") != "" {
			return invalid
		}
	case doskaRouteUpload:
		if r.Method != "PUT" || contentType != "application/octet-stream" || !doskaAttachmentUploadPath.MatchString(path) || r.URL.RawQuery != "" || r.Header.Get("Upgrade") != "" || !verified || subtle.ConstantTimeCompare([]byte(r.Header.Get("X-CSRF-Token")), []byte(derived)) != 1 {
			return invalid
		}
	case doskaRouteWrite:
		if r.Method != "POST" && r.Method != "PUT" && r.Method != "PATCH" && r.Method != "DELETE" {
			return invalid
		}
		if strings.HasPrefix(path, "/doska/api/ws/") || r.Header.Get("Upgrade") != "" || !verified || subtle.ConstantTimeCompare([]byte(r.Header.Get("X-CSRF-Token")), []byte(derived)) != 1 {
			return invalid
		}
	case doskaRouteWebSocket:
		if r.Method != http.MethodGet || !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") || !doskaWebSocketURI(r.URL) || contentType != "" || idempotency != "" {
			return invalid
		}
	default:
		return invalid
	}
	if read && (size != 0 || verified) {
		return invalid
	}
	claims := gatewayIdentity{Version: 2, Audience: "doska", IssuedAt: now.Unix(), ExpiresAt: now.Unix() + 30,
		Nonce: nonce, Subject: sess.User.ID, Name: sess.User.Name, Admin: sess.User.Admin,
		Scopes: []string{"doska:read", "doska:realtime", "doska:write"}, Method: r.Method, URI: r.URL.RequestURI(),
		ContentType: contentType, BodySHA256: hex.EncodeToString(digest[:]), IdempotencyKey: idempotency,
		SourceIP: sourceIP, CSRFToken: derived, CSRFVerified: verified}
	if kind == doskaRouteEvents {
		claims.Scopes = []string{"doska:read"}
	}
	return writeGatewayIdentity(r, claims, key)
}

func doskaWebSocketURI(u *url.URL) bool {
	id := strings.TrimPrefix(u.Path, "/doska/api/ws/")
	if !strings.HasPrefix(u.Path, "/doska/api/ws/") || !gatewaySafeID.MatchString(id) {
		return false
	}
	query, err := url.ParseQuery(u.RawQuery)
	if err != nil || len(query) > 1 {
		return false
	}
	for key, values := range query {
		if key != "windowId" || len(values) != 1 || !gatewaySafeID.MatchString(values[0]) {
			return false
		}
	}
	return true
}

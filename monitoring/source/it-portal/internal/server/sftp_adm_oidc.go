package server

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"math/big"
	"mime"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	sftpAdminIssuerPath = "/auth/sftp-adm/oidc"
	sftpAdminFlowCookie = "pl_sftp_flow"
	sftpAdminPendingMax = 10000
	sftpAdminCodeTTL    = time.Minute
	sftpAdminFlowTTL    = 3 * time.Minute
	// Native AJAX cannot transparently repeat the browser authorization flow.
	// The gateway still checks the live Portal session for every native request;
	// this token never extends that original session or grants direct access.
	sftpAdminTokenTTL = 24 * time.Hour
)

var sftpAdminOpaque = regexp.MustCompile(`^[A-Za-z0-9._~+/-]{1,512}$`)
var sftpAdminClientID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
var sftpAdminPKCEVerifier = regexp.MustCompile(`^[A-Za-z0-9._~-]{43,128}$`)

// SFTPAdminOIDCConfig describes the only native SFTPGo OIDC client.
type SFTPAdminOIDCConfig struct {
	Issuer, ClientID, ClientSecretFile, SigningKeyFile, RedirectURL string
}

type sftpAdminGrant struct {
	sessionHash, subject, username, mode, nonce, challenge string
	expires                                                time.Time
}
type sftpAdminOIDC struct {
	server        *Server
	config        SFTPAdminOIDCConfig
	key           *rsa.PrivateKey
	keyID, secret string
	mu            sync.Mutex
	flows, codes  map[string]sftpAdminGrant
	now           func() time.Time
	lookup        func(context.Context, string) (session, error)
	audit         func(context.Context, sftpAdminGrant) error
}

func sftpAdminNativeUsername(subject string) string { return "pl-" + hash(subject) }
func newSFTPAdminOIDC(s *Server, c SFTPAdminOIDCConfig) (*sftpAdminOIDC, error) {
	if s == nil || c.Issuer != s.Config.PublicURL+sftpAdminIssuerPath || c.RedirectURL != s.Config.PublicURL+"/sftp-adm/web/oidc/redirect" || !sftpAdminClientID.MatchString(c.ClientID) {
		return nil, errors.New("invalid SFTP administration OIDC configuration")
	}
	secret, err := sftpAdminReadPrivateFile(c.ClientSecretFile, 4096)
	if err != nil {
		return nil, err
	}
	secret = []byte(strings.TrimSpace(string(secret)))
	if len(secret) < 32 || strings.ContainsAny(string(secret), "\x00\r\n\t ") {
		return nil, errors.New("invalid SFTP administration client secret")
	}
	keyBytes, err := sftpAdminReadPrivateFile(c.SigningKeyFile, 16384)
	if err != nil {
		return nil, err
	}
	block, trailing := pem.Decode(keyBytes)
	if block == nil || len(strings.TrimSpace(string(trailing))) != 0 {
		return nil, errors.New("invalid SFTP administration signing key")
	}
	var key *rsa.PrivateKey
	if block.Type == "RSA PRIVATE KEY" {
		key, err = x509.ParsePKCS1PrivateKey(block.Bytes)
	} else if block.Type == "PRIVATE KEY" {
		var parsed any
		parsed, err = x509.ParsePKCS8PrivateKey(block.Bytes)
		key, _ = parsed.(*rsa.PrivateKey)
	}
	if err != nil || key == nil || key.N.BitLen() < 2048 || key.Validate() != nil {
		return nil, errors.New("invalid SFTP administration RSA signing key")
	}
	key.Precompute()
	public, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		return nil, errors.New("invalid SFTP administration public key")
	}
	digest := sha256.Sum256(public)
	o := &sftpAdminOIDC{server: s, config: c, key: key, keyID: base64.RawURLEncoding.EncodeToString(digest[:]), secret: string(secret), flows: map[string]sftpAdminGrant{}, codes: map[string]sftpAdminGrant{}, now: time.Now}
	o.lookup = func(ctx context.Context, tokenHash string) (session, error) {
		var v session
		err := s.Store.Pool.QueryRow(ctx, "SELECT user_id,user_name,admin,csrf,expires_at FROM sessions WHERE token_hash=$1 AND expires_at>now()", tokenHash).Scan(&v.User.ID, &v.User.Name, &v.User.Admin, &v.CSRF, &v.ExpiresAt)
		return v, err
	}
	o.audit = func(ctx context.Context, g sftpAdminGrant) error {
		return s.Store.Event(ctx, "sftp.adm.login", "Вход в файловый сервер SFTP", "", g.subject, map[string]any{"mode": g.mode, "native_username": g.username}, true)
	}
	return o, nil
}
func sftpAdminReadPrivateFile(filename string, limit int64) ([]byte, error) {
	f, err := os.Open(filename)
	if err != nil {
		return nil, errors.New("SFTP administration credential unavailable")
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0007 != 0 || info.Mode().Perm()&0020 != 0 {
		return nil, errors.New("insecure SFTP administration credential file")
	}
	b, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil || len(b) == 0 || int64(len(b)) > limit {
		return nil, errors.New("invalid SFTP administration credential file")
	}
	return b, nil
}
func (o *sftpAdminOIDC) registerRoutes(m *http.ServeMux) {
	m.HandleFunc("GET "+sftpAdminIssuerPath+"/.well-known/openid-configuration", o.discovery)
	m.HandleFunc("GET "+sftpAdminIssuerPath+"/jwks", o.jwks)
	m.HandleFunc("GET "+sftpAdminIssuerPath+"/authorize", o.authorize)
	m.HandleFunc("POST "+sftpAdminIssuerPath+"/token", o.token)
}
func (o *sftpAdminOIDC) discovery(w http.ResponseWriter, r *http.Request) {
	respond(w, 200, map[string]any{"issuer": o.config.Issuer, "authorization_endpoint": o.config.Issuer + "/authorize", "token_endpoint": o.config.Issuer + "/token", "jwks_uri": o.config.Issuer + "/jwks", "response_types_supported": []string{"code"}, "grant_types_supported": []string{"authorization_code"}, "subject_types_supported": []string{"public"}, "id_token_signing_alg_values_supported": []string{"RS256"}, "token_endpoint_auth_methods_supported": []string{"client_secret_basic"}, "code_challenge_methods_supported": []string{"S256"}, "scopes_supported": []string{"openid", "profile"}, "claims_supported": []string{"iss", "sub", "aud", "iat", "exp", "nonce", "preferred_username", "name", "sftp_role"}})
}
func (o *sftpAdminOIDC) jwks(w http.ResponseWriter, r *http.Request) {
	respond(w, 200, map[string]any{"keys": []map[string]any{{"kty": "RSA", "use": "sig", "alg": "RS256", "kid": o.keyID, "n": base64.RawURLEncoding.EncodeToString(o.key.N.Bytes()), "e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(o.key.E)).Bytes())}}})
}
func (o *sftpAdminOIDC) readSession(r *http.Request) (session, string, error) {
	if _, ok := r.Header["Authorization"]; ok {
		return session{}, "", errors.New("browser session required")
	}
	var token string
	for _, c := range r.Cookies() {
		if c.Name == "portal_session" {
			if token != "" || c.Value == "" || len(c.Value) > 512 {
				return session{}, "", errors.New("ambiguous browser session")
			}
			token = c.Value
		}
	}
	if token == "" {
		return session{}, "", errors.New("browser session required")
	}
	tokenHash := hash(token)
	v, err := o.lookup(r.Context(), tokenHash)
	if err != nil || v.User.ID == "" || !v.ExpiresAt.After(o.now()) {
		return session{}, "", errors.New("browser session expired")
	}
	return v, tokenHash, nil
}
func (o *sftpAdminOIDC) pruneLocked() {
	now := o.now()
	for key, value := range o.flows {
		if !value.expires.After(now) {
			delete(o.flows, key)
		}
	}
	for key, value := range o.codes {
		if !value.expires.After(now) {
			delete(o.codes, key)
		}
	}
}

// beginFlow precedes native oidclogin after provisioning this exact native identity.
// Its cookie binds authorization to the original live Portal session and role.
func (o *sftpAdminOIDC) beginFlow(w http.ResponseWriter, r *http.Request, mode, username string) error {
	if r.Method != http.MethodGet || !o.server.sameOrigin(r) {
		return errors.New("invalid SFTP administration launch origin")
	}
	sess, sessionHash, err := o.readSession(r)
	if err != nil {
		return err
	}
	if mode != "admin" && mode != "files" || mode == "admin" && !sess.User.Admin || username != sftpAdminNativeUsername(sess.User.ID) {
		return errors.New("SFTP administration launch forbidden")
	}
	flow := randomToken()
	o.mu.Lock()
	defer o.mu.Unlock()
	o.pruneLocked()
	if len(o.flows)+len(o.codes) >= sftpAdminPendingMax {
		return errors.New("SFTP administration login capacity exhausted")
	}
	o.flows[hash(flow)] = sftpAdminGrant{sessionHash: sessionHash, subject: sess.User.ID, username: username, mode: mode, expires: o.now().Add(sftpAdminFlowTTL)}
	http.SetCookie(w, &http.Cookie{Name: sftpAdminFlowCookie, Value: flow, Path: sftpAdminIssuerPath, MaxAge: int(sftpAdminFlowTTL.Seconds()), HttpOnly: true, Secure: o.server.secure(), SameSite: http.SameSiteLaxMode})
	return nil
}
func sftpAdminUniqueValues(values url.Values, allowed map[string]bool) bool {
	for key, vals := range values {
		if !allowed[key] || len(vals) != 1 {
			return false
		}
	}
	return true
}
func (o *sftpAdminOIDC) authorize(w http.ResponseWriter, r *http.Request) {
	q, err := url.ParseQuery(r.URL.RawQuery)
	allowed := map[string]bool{"client_id": true, "redirect_uri": true, "response_type": true, "scope": true, "state": true, "nonce": true, "code_challenge": true, "code_challenge_method": true}
	if err != nil || len(r.URL.RawQuery) > 4096 || !sftpAdminUniqueValues(q, allowed) || q.Get("client_id") != o.config.ClientID || q.Get("redirect_uri") != o.config.RedirectURL || q.Get("response_type") != "code" || !sftpAdminOpaque.MatchString(q.Get("state")) || !sftpAdminOpaque.MatchString(q.Get("nonce")) {
		problem(w, 400, "invalid_request", "Недопустимый запрос входа SFTP")
		return
	}
	openid := false
	for _, scope := range strings.Fields(q.Get("scope")) {
		if scope == "openid" {
			openid = true
		} else if scope != "profile" {
			problem(w, 400, "invalid_scope", "Недопустимая область входа SFTP")
			return
		}
	}
	if !openid {
		problem(w, 400, "invalid_scope", "Требуется OpenID")
		return
	}
	challenge := q.Get("code_challenge")
	if challenge != "" || q.Get("code_challenge_method") != "" {
		b, e := base64.RawURLEncoding.DecodeString(challenge)
		if e != nil || len(b) != 32 || q.Get("code_challenge_method") != "S256" {
			problem(w, 400, "invalid_request", "Недопустимая проверка PKCE")
			return
		}
	}
	sess, sessionHash, err := o.readSession(r)
	if err != nil {
		problem(w, 401, "session_expired", "Войдите в Платформу")
		return
	}
	if !o.server.sameOrigin(r) {
		problem(w, 403, "csrf", "Недопустимый источник входа")
		return
	}
	var flow string
	for _, c := range r.Cookies() {
		if c.Name == sftpAdminFlowCookie {
			if flow != "" {
				problem(w, 400, "invalid_flow", "Повторите вход в SFTP")
				return
			}
			flow = c.Value
		}
	}
	if flow == "" || len(flow) > 512 {
		problem(w, 400, "invalid_flow", "Начните вход из Платформы")
		return
	}
	o.mu.Lock()
	o.pruneLocked()
	g, ok := o.flows[hash(flow)]
	if !ok || g.sessionHash != sessionHash || g.subject != sess.User.ID || g.mode == "admin" && !sess.User.Admin {
		o.mu.Unlock()
		problem(w, 403, "invalid_flow", "Повторите вход в SFTP")
		return
	}
	delete(o.flows, hash(flow))
	code := randomToken()
	g.expires = o.now().Add(sftpAdminCodeTTL)
	g.nonce = q.Get("nonce")
	g.challenge = challenge
	o.codes[hash(code)] = g
	o.mu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: sftpAdminFlowCookie, Value: "", Path: sftpAdminIssuerPath, MaxAge: -1, HttpOnly: true, Secure: o.server.secure(), SameSite: http.SameSiteLaxMode})
	redirect, _ := url.Parse(o.config.RedirectURL)
	values := redirect.Query()
	values.Set("code", code)
	values.Set("state", q.Get("state"))
	redirect.RawQuery = values.Encode()
	http.Redirect(w, r, redirect.String(), http.StatusFound)
}
func (o *sftpAdminOIDC) token(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	id, secret, ok := r.BasicAuth()
	// RFC 6749 client_secret_basic applies form encoding to each credential
	// before Basic encoding; native oauth2.Config follows that convention.
	id, idErr := url.QueryUnescape(id)
	secret, secretErr := url.QueryUnescape(secret)
	if !ok || idErr != nil || secretErr != nil || len(r.Header.Values("Authorization")) != 1 || subtle.ConstantTimeCompare([]byte(id), []byte(o.config.ClientID)) != 1 || subtle.ConstantTimeCompare([]byte(secret), []byte(o.secret)) != 1 {
		w.Header().Set("WWW-Authenticate", `Basic realm="sftp-adm-oidc"`)
		problem(w, 401, "invalid_client", "Клиент SFTP не подтверждён")
		return
	}
	mediaType, _, mediaErr := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if mediaErr != nil || mediaType != "application/x-www-form-urlencoded" {
		problem(w, 400, "invalid_request", "Требуется форма OAuth")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8192)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		problem(w, 400, "invalid_request", "Недопустимая форма OAuth")
		return
	}
	q, err := url.ParseQuery(string(body))
	if err != nil || r.URL.RawQuery != "" || !sftpAdminUniqueValues(q, map[string]bool{"grant_type": true, "code": true, "redirect_uri": true, "code_verifier": true}) || q.Get("grant_type") != "authorization_code" || q.Get("redirect_uri") != o.config.RedirectURL || !sftpAdminOpaque.MatchString(q.Get("code")) {
		problem(w, 400, "invalid_request", "Недопустимый обмен кода SFTP")
		return
	}
	o.mu.Lock()
	o.pruneLocked()
	g, ok := o.codes[hash(q.Get("code"))]
	delete(o.codes, hash(q.Get("code")))
	o.mu.Unlock()
	if !ok {
		problem(w, 400, "invalid_grant", "Код входа истёк или уже использован")
		return
	}
	if g.challenge != "" {
		verifier := q.Get("code_verifier")
		digest := sha256.Sum256([]byte(verifier))
		if !sftpAdminPKCEVerifier.MatchString(verifier) || subtle.ConstantTimeCompare([]byte(base64.RawURLEncoding.EncodeToString(digest[:])), []byte(g.challenge)) != 1 {
			problem(w, 400, "invalid_grant", "Проверка PKCE не пройдена")
			return
		}
	}
	sess, err := o.lookup(r.Context(), g.sessionHash)
	now := o.now()
	if err != nil || sess.User.ID != g.subject || !sess.ExpiresAt.After(now) || g.mode == "admin" && !sess.User.Admin {
		problem(w, 400, "invalid_grant", "Сессия Платформы завершена")
		return
	}
	expires := now.Add(sftpAdminTokenTTL)
	if sess.ExpiresAt.Before(expires) {
		expires = sess.ExpiresAt
	}
	role := "user"
	if g.mode == "admin" {
		role = "admin"
	}
	claims := map[string]any{"iss": o.config.Issuer, "sub": g.subject, "aud": o.config.ClientID, "iat": now.Unix(), "exp": expires.Unix(), "nonce": g.nonce, "preferred_username": g.username, "name": sess.User.Name, "sftp_role": role}
	idToken, err := o.sign(claims)
	if err != nil {
		problem(w, 500, "server_error", "Не удалось подтвердить вход SFTP")
		return
	}
	if err = o.audit(r.Context(), g); err != nil {
		problem(w, 503, "audit_unavailable", "Аудит входа SFTP недоступен")
		return
	}
	respond(w, 200, map[string]any{"access_token": randomToken(), "token_type": "Bearer", "expires_in": int64(expires.Sub(now).Seconds()), "id_token": idToken})
}
func (o *sftpAdminOIDC) sign(claims map[string]any) (string, error) {
	header, err := json.Marshal(map[string]string{"typ": "JWT", "alg": "RS256", "kid": o.keyID})
	if err != nil {
		return "", err
	}
	body, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	unsigned := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(body)
	digest := sha256.Sum256([]byte(unsigned))
	signature, err := rsa.SignPKCS1v15(rand.Reader, o.key, crypto.SHA256, digest[:])
	if err != nil {
		return "", errors.New("SFTP administration token signing failed")
	}
	return unsigned + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

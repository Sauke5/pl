package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
	"pl/portal/internal/model"
	"pl/portal/internal/store"
)

type session struct {
	User      model.User
	CSRF      string
	ExpiresAt time.Time
}
type contextKey int

const sessionKey contextKey = 1

func randomToken() string {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func hash(s string) string            { v := sha256.Sum256([]byte(s)); return hex.EncodeToString(v[:]) }
func current(r *http.Request) session { s, _ := r.Context().Value(sessionKey).(session); return s }
func (s *Server) secure() bool        { return strings.HasPrefix(s.Config.PublicURL, "https://") }
func (s *Server) cookie(w http.ResponseWriter, name, value string, maxAge int) {
	http.SetCookie(w, &http.Cookie{Name: name, Value: value, Path: "/", MaxAge: maxAge, HttpOnly: true, Secure: s.secure(), SameSite: http.SameSiteLaxMode})
}
func (s *Server) readSession(r *http.Request) (session, error) {
	var v session
	if _, present := r.Header["Authorization"]; present {
		return v, errors.New("machine credentials cannot authenticate a browser session")
	}
	c, e := r.Cookie("portal_session")
	if e != nil {
		return v, e
	}
	// Read the session and current local-user permissions in one snapshot. Two
	// separate reads could combine a revoked session with a later role/reenable.
	e = s.Store.Pool.QueryRow(r.Context(), `SELECT se.user_id,
        CASE WHEN se.user_id LIKE 'local:%' THEN lu.name ELSE se.user_name END,
        CASE WHEN se.user_id LIKE 'local:%' THEN lu.admin ELSE se.admin END,
        se.csrf,se.expires_at
        FROM sessions se LEFT JOIN local_users lu ON lu.id=se.user_id
        WHERE se.token_hash=$1 AND se.expires_at>now()
          AND (se.user_id NOT LIKE 'local:%' OR ($2 AND lu.id IS NOT NULL AND NOT lu.disabled))`, hash(c.Value), s.Config.LocalUsersEnabled).Scan(&v.User.ID, &v.User.Name, &v.User.Admin, &v.CSRF, &v.ExpiresAt)
	if e == nil && strings.HasPrefix(v.User.ID, "ad:") {
		cfg, managed, err := s.adConfiguration(r.Context())
		if err != nil {
			return v, errADUnavailable
		}
		if managed != nil {
			v.User, e = s.revalidateADSession(r.Context(), cfg, *managed, v.User)
			if e == nil {
				// LDAP is a remote operation. A logout, account change, AD settings
				// update or absolute session expiry during it must still revoke access.
				var alive bool
				e = s.Store.Pool.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>now())`, hash(c.Value), v.User.ID).Scan(&alive)
				if e == nil && !alive {
					e = errADCredentials
				}
			}
		}
	}
	return v, e
}
func (s *Server) newSession(w http.ResponseWriter, r *http.Request, u model.User, expires time.Time) error {
	lifetime, err := s.sessionLifetime(r.Context())
	if err != nil {
		return err
	}
	policyExpiry := time.Now().Add(lifetime)
	if expires.IsZero() || policyExpiry.Before(expires) {
		expires = policyExpiry
	}

	if c, e := r.Cookie("portal_session"); e == nil {
		_, _ = s.Store.Pool.Exec(r.Context(), "DELETE FROM sessions WHERE token_hash=$1", hash(c.Value))
	}
	token := randomToken()
	csrf := randomToken()
	_, e := s.Store.Pool.Exec(r.Context(), "INSERT INTO sessions(token_hash,user_id,user_name,admin,csrf,expires_at) VALUES($1,$2,$3,$4,$5,$6)", hash(token), u.ID, u.Name, u.Admin, csrf, expires)
	if e != nil {
		return e
	}
	s.cookie(w, "portal_session", token, int(time.Until(expires).Seconds()))
	return s.Store.Event(r.Context(), "auth.login", "Вход в портал", "", u.ID, nil, true)
}
func (s *Server) sessionAPI(w http.ResponseWriter, r *http.Request) {
	settings, e := store.Get[model.Settings](r.Context(), s.Store, "settings", "global")
	if e != nil {
		s.fail(w, e)
		return
	}
	adConfig, _, adErr := s.adConfiguration(r.Context())
	if adErr != nil {
		problem(w, 503, "ad_settings_unavailable", "Не удалось прочитать настройки входа")
		return
	}
	v, e := s.readSession(r)
	if errors.Is(e, errADUnavailable) {
		problem(w, 503, "ad_unavailable", "Не удалось проверить доступ через AD. Повторите позднее.")
		return
	}
	if e != nil {
		respond(w, 200, map[string]any{"authenticated": false, "demo": s.Config.Demo, "local_login_enabled": s.Config.LocalAdminHashFile != "", "ad_login_enabled": adConfig.adEnabled(), "oidc_login_enabled": s.Config.Issuer != "" && s.Config.ClientID != "" && s.Config.ClientSecret != "" && s.Config.AllowedGroup != "", "board_enabled": settings.BoardEnabled, "board_anonymous_enabled": settings.BoardEnabled && settings.BoardAnonymous, "timezone": settings.Timezone})
		return
	}
	features, featureErr := s.applicationFeatures(r.Context())
	if featureErr != nil {
		s.fail(w, featureErr)
		return
	}
	builtinChange := s.Config.LocalAdminPasswordChange && v.User.ID == "local-admin" && v.User.Admin
	changeEnabled := builtinChange || s.Config.LocalUsersEnabled && strings.HasPrefix(v.User.ID, "local:")
	respond(w, 200, map[string]any{"authenticated": true, "user": v.User, "csrf_token": v.CSRF, "demo": s.Config.Demo, "local_login_enabled": s.Config.LocalAdminHashFile != "", "ad_login_enabled": adConfig.adEnabled(), "oidc_login_enabled": s.Config.Issuer != "" && s.Config.ClientID != "" && s.Config.ClientSecret != "" && s.Config.AllowedGroup != "", "board_enabled": settings.BoardEnabled, "board_anonymous_enabled": settings.BoardEnabled && settings.BoardAnonymous, "timezone": settings.Timezone, "local_password_min_length": passwordMinimum(settings), "local_users_enabled": s.Config.LocalUsersEnabled && v.User.Admin, "local_password_change_enabled": changeEnabled, "local_password_change_required": builtinChange && s.localPasswordChangeRequired(), "features": features})
}

func bootstrapPasswordRequestAllowed(r *http.Request) bool {
	if r.URL.EscapedPath() != r.URL.Path {
		return false
	}
	switch r.URL.Path {
	case "/api/v1/session", "/health/live", "/health/ready":
		return r.Method == http.MethodGet || r.Method == http.MethodHead
	case "/api/v1/local-admin/password", "/auth/logout", "/internal/delivery/reconcile":
		return r.Method == http.MethodPost
	default:
		return false
	}
}

func (s *Server) bootstrapPasswordPending() bool {
	return s.Config.LocalAdminPasswordChange && s.Config.LocalAdminHashFile != "" && s.localPasswordChangeRequired()
}

func bootstrapPasswordProblem(w http.ResponseWriter) {
	problem(w, http.StatusForbidden, "password_change_required", "Задайте собственный пароль локального администратора перед работой с Платформой")
}

// The outer gate also covers gateways and public projections which intentionally
// authenticate without s.auth. It checks only the built-in local identity; AD
// revalidation and scoped machine authentication retain their existing paths.
func (s *Server) bootstrapPasswordGate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// This exact private control route owns its HMAC authentication. Reject
		// forged cookies and wrong methods there before any session/Store IO.
		if r.URL.Path == "/internal/delivery/reconcile" {
			next.ServeHTTP(w, r)
			return
		}
		if bootstrapPasswordRequestAllowed(r) || !s.bootstrapPasswordPending() {
			next.ServeHTTP(w, r)
			return
		}
		cookie, err := r.Cookie("portal_session")
		if err != nil {
			next.ServeHTTP(w, r)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		var required bool
		err = s.Store.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM sessions
			WHERE token_hash=$1 AND user_id='local-admin' AND admin AND expires_at>now())`, hash(cookie.Value)).Scan(&required)
		if err != nil {
			problem(w, http.StatusServiceUnavailable, "session_unavailable", "Не удалось проверить сессию. Повторите запрос позднее.")
			return
		}
		if required {
			bootstrapPasswordProblem(w)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) auth(next http.HandlerFunc, admin bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, present := r.Header["Authorization"]; present {
			s.machineAuth(next, w, r)
			return
		}
		v, e := s.readSession(r)
		if errors.Is(e, errADUnavailable) {
			problem(w, 503, "ad_unavailable", "Не удалось проверить доступ через AD. Повторите позднее.")
			return
		}
		if e != nil {
			problem(w, 401, "session_expired", "Войдите в портал")
			return
		}
		if admin && !v.User.Admin {
			problem(w, 403, "forbidden", "Доступ только для администратора")
			return
		}
		if v.User.ID == "local-admin" && v.User.Admin && s.bootstrapPasswordPending() && !bootstrapPasswordRequestAllowed(r) {
			bootstrapPasswordProblem(w)
			return
		}
		if r.Method != "GET" && r.Method != "HEAD" {
			if !s.sameOrigin(r) || subtle.ConstantTimeCompare([]byte(r.Header.Get("X-CSRF-Token")), []byte(v.CSRF)) != 1 {
				problem(w, 403, "csrf", "Запрос не прошёл проверку сессии")
				return
			}
		}
		next(w, r.WithContext(context.WithValue(r.Context(), sessionKey, v)))
	}
}
func (s *Server) sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin != "" && origin != s.Config.PublicURL {
		return false
	}
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" && site != "none" {
		return false
	}
	return true
}
func (s *Server) demoLogin(w http.ResponseWriter, r *http.Request) {
	if !s.Config.Demo {
		http.NotFound(w, r)
		return
	}
	if !s.sameOrigin(r) {
		problem(w, 403, "csrf", "Недопустимый источник запроса")
		return
	}
	var p struct {
		Role string `json:"role"`
	}
	if !decode(w, r, &p) {
		return
	}
	if p.Role != "admin" && p.Role != "viewer" {
		problem(w, 400, "invalid_role", "Неизвестный режим демо")
		return
	}
	u := model.User{ID: "demo-" + p.Role, Name: "Демо · IT", Admin: p.Role == "admin"}
	if !u.Admin {
		u.Name = "Демо · Наблюдатель"
	}
	if e := s.newSession(w, r, u, time.Time{}); e != nil {
		s.fail(w, e)
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}
func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if c, e := r.Cookie("portal_session"); e == nil {
		_, _ = s.Store.Pool.Exec(r.Context(), "DELETE FROM sessions WHERE token_hash=$1", hash(c.Value))
	}
	s.cookie(w, "portal_session", "", -1)
	w.WriteHeader(204)
}
func (s *Server) oidcProvider(ctx context.Context) (*oidc.Provider, error) {
	s.oidcMu.Lock()
	defer s.oidcMu.Unlock()
	if s.provider != nil {
		return s.provider, nil
	}
	p, e := oidc.NewProvider(oidc.ClientContext(ctx, s.oidcClient), s.Config.Issuer)
	if e == nil {
		s.provider = p
	}
	return p, e
}
func (s *Server) oauth(p *oidc.Provider) oauth2.Config {
	return oauth2.Config{ClientID: s.Config.ClientID, ClientSecret: s.Config.ClientSecret, Endpoint: p.Endpoint(), RedirectURL: s.Config.PublicURL + "/auth/callback", Scopes: []string{oidc.ScopeOpenID, "profile", "email"}}
}
func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	if s.Config.Demo {
		http.Redirect(w, r, "/", 303)
		return
	}
	if s.Config.Issuer == "" || s.Config.ClientID == "" || s.Config.ClientSecret == "" || s.Config.AllowedGroup == "" {
		problem(w, 503, "oidc_not_configured", "Вход через Keycloak ещё не настроен")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	p, e := s.oidcProvider(ctx)
	if e != nil {
		problem(w, 503, "oidc_unavailable", "Keycloak недоступен. Повторите вход позднее.")
		return
	}
	state, nonce, browser, verifier := randomToken(), randomToken(), randomToken(), oauth2.GenerateVerifier()
	_, e = s.Store.Pool.Exec(ctx, "INSERT INTO oidc_states(state_hash,verifier,nonce,browser_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '5 minutes')", hash(state), verifier, nonce, hash(browser))
	if e != nil {
		s.fail(w, e)
		return
	}
	s.cookie(w, "portal_login", browser, 300)
	o := s.oauth(p)
	http.Redirect(w, r, o.AuthCodeURL(state, oauth2.S256ChallengeOption(verifier), oidc.Nonce(nonce)), http.StatusFound)
}
func (s *Server) callback(w http.ResponseWriter, r *http.Request) {
	c, e := r.Cookie("portal_login")
	if e != nil {
		problem(w, 400, "invalid_login", "Начните вход заново")
		return
	}
	var verifier, nonce string
	e = s.Store.Pool.QueryRow(r.Context(), "DELETE FROM oidc_states WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>now() RETURNING verifier,nonce", hash(r.URL.Query().Get("state")), hash(c.Value)).Scan(&verifier, &nonce)
	s.cookie(w, "portal_login", "", -1)
	if e != nil {
		problem(w, 400, "invalid_login", "Ссылка входа устарела или уже использована")
		return
	}
	ctx, cancel := context.WithTimeout(oidc.ClientContext(r.Context(), s.oidcClient), 20*time.Second)
	defer cancel()
	p, e := s.oidcProvider(ctx)
	if e != nil {
		problem(w, 503, "oidc_unavailable", "Keycloak недоступен")
		return
	}
	o := s.oauth(p)
	token, e := o.Exchange(ctx, r.URL.Query().Get("code"), oauth2.VerifierOption(verifier))
	if e != nil {
		problem(w, 401, "invalid_login", "Не удалось подтвердить вход")
		return
	}
	raw, ok := token.Extra("id_token").(string)
	if !ok {
		problem(w, 401, "invalid_token", "Нет ID token")
		return
	}
	id, e := p.Verifier(&oidc.Config{ClientID: s.Config.ClientID}).Verify(ctx, raw)
	if e != nil || id.Nonce != nonce || id.Subject == "" {
		problem(w, 401, "invalid_token", "Недействительный ID token")
		return
	}
	var claims map[string]any
	if e = id.Claims(&claims); e != nil {
		problem(w, 401, "invalid_claims", "Некорректные claims")
		return
	}
	name, _ := claims["name"].(string)
	if name == "" {
		name, _ = claims["preferred_username"].(string)
	}
	if name == "" {
		name = id.Subject
	}
	u := model.User{ID: hash(id.Issuer + "\x00" + id.Subject), Name: name, Admin: HasGroup(claims, s.Config.GroupClaim, s.Config.AllowedGroup)}
	expires := id.Expiry
	if e = s.newSession(w, r, u, expires); e != nil {
		s.fail(w, e)
		return
	}
	http.Redirect(w, r, "/", 303)
}
func HasGroup(claims map[string]any, path, group string) bool {
	if group == "" || path == "" {
		return false
	}
	var v any = claims
	for _, part := range strings.Split(path, ".") {
		m, ok := v.(map[string]any)
		if !ok {
			return false
		}
		v = m[part]
	}
	values, ok := v.([]any)
	if !ok {
		return false
	}
	found := false
	for _, item := range values {
		s, ok := item.(string)
		if !ok {
			return false
		}
		if s == group {
			found = true
		}
	}
	return found
}
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		problem(w, 415, "content_type", "Ожидается application/json")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if e := d.Decode(v); e != nil {
		problem(w, 400, "invalid_json", "Некорректный JSON или неизвестные поля")
		return false
	}
	var extra any
	if e := d.Decode(&extra); errors.Is(e, io.EOF) {
		return true
	}
	problem(w, 400, "invalid_json", "Ожидается один JSON-документ")
	return false
}

package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const formsPrefix = "/forms"
const formsBodyLimit = 3 << 20
const formsAPILimit = 4 << 20
const formsAssetLimit = 16 << 20

var formsID = regexp.MustCompile(`^[a-z0-9]{1,32}$`)
var formsIdempotency = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

type formsRoute struct{ scope, media string }

// The finite manifest is shared by authorization and the signer. No native
// engine endpoints, OPTIONS, query strings or uploads are exposed.
func formsMatchRoute(r *http.Request) (formsRoute, bool) {
	if r.URL.RawPath != "" || r.URL.RawQuery != "" || r.URL.ForceQuery || r.URL.Fragment != "" || strings.ContainsAny(r.URL.EscapedPath(), "%\\") || !gatewayString(r.URL.RequestURI(), 4096, true) {
		return formsRoute{}, false
	}
	p := r.URL.Path
	read := r.Method == "GET" || r.Method == "HEAD"
	if read {
		media := ""
		switch p {
		case "/forms/", "/forms/index.html":
			media = "text/html"
		case "/forms/app.js", "/forms/theme.js":
			media = "application/javascript"
		case "/forms/styles.css":
			media = "text/css"
		}
		if media != "" {
			return formsRoute{"forms:read", media}, true
		}
	}
	if r.Method == "GET" && (p == "/forms/api/v1/context" || p == "/forms/api/v1/surveys") {
		return formsRoute{"forms:read", "application/json"}, true
	}
	if r.Method == "POST" && p == "/forms/api/v1/surveys" {
		return formsRoute{"forms:admin", "application/json"}, true
	}
	tail, found := strings.CutPrefix(p, "/forms/api/v1/surveys/")
	if !found {
		return formsRoute{}, false
	}
	parts := strings.Split(tail, "/")
	if len(parts) > 2 || !formsID.MatchString(parts[0]) {
		return formsRoute{}, false
	}
	if len(parts) == 1 {
		if r.Method == "GET" {
			return formsRoute{"forms:read", "application/json"}, true
		}
		if r.Method == "PUT" {
			return formsRoute{"forms:admin", "application/json"}, true
		}
	} else {
		if parts[1] == "responses" && r.Method == "POST" {
			return formsRoute{"forms:respond", "application/json"}, true
		}
		if (parts[1] == "publish" || parts[1] == "close") && r.Method == "POST" || parts[1] == "results" && (r.Method == "GET" || r.Method == "POST") {
			return formsRoute{"forms:admin", "application/json"}, true
		}
	}
	return formsRoute{}, false
}

func signFormsRequest(r *http.Request, body []byte, sess session, key []byte, now time.Time, verified bool, sourceIP string) error {
	route, allowed := formsMatchRoute(r)
	unsafe := r.Method != "GET" && r.Method != "HEAD"
	if !allowed || len(body) > formsBodyLimit || len(key) != 32 || sess.User.ID == "" || sess.User.Name == "" || sess.CSRF == "" || !gatewayString(sess.User.ID, 256, false) || !gatewayString(sess.User.Name, 512, false) || net.ParseIP(sourceIP) == nil || !gatewayString(r.Header.Get("Content-Type"), 256, true) || route.scope == "forms:admin" && !sess.User.Admin || unsafe && (!verified || !formsIdempotency.MatchString(r.Header.Get("Idempotency-Key"))) || !unsafe && (len(body) != 0 || verified) {
		return errors.New("invalid Forms gateway identity or request")
	}
	digest := sha256.Sum256(body)
	claims := gatewayIdentity{Version: 2, Audience: "forms", IssuedAt: now.Unix(), ExpiresAt: now.Unix() + 30, Nonce: randomToken(), Subject: sess.User.ID, Name: sess.User.Name, Admin: sess.User.Admin, Scopes: []string{route.scope}, Method: r.Method, URI: r.URL.RequestURI(), ContentType: r.Header.Get("Content-Type"), BodySHA256: hex.EncodeToString(digest[:]), IdempotencyKey: r.Header.Get("Idempotency-Key"), SourceIP: sourceIP, CSRFToken: gatewayServiceCSRF(sess.CSRF, "forms"), CSRFVerified: verified}
	return writeGatewayIdentity(r, claims, key)
}

type formsGateway struct {
	server    *Server
	key       []byte
	upstream  string
	transport http.RoundTripper
	slots     chan struct{}
	static    *gatewayCapacity
	reads     *gatewayCapacity
	timeout   time.Duration
}

func (s *Server) newFormsGateway(c *FormsGatewayConfig) (*formsGateway, error) {
	g := &formsGateway{server: s, slots: make(chan struct{}, 4), static: newGatewayStaticCapacity(), timeout: 30 * time.Second}
	g.reads = newGatewayReadCapacity(g.slots)
	if c == nil {
		return g, nil
	}
	if len(c.Key) != 32 {
		return nil, errors.New("invalid Forms gateway configuration")
	}
	public, err := url.Parse(s.Config.PublicURL)
	if err != nil || public.Host == "" || public.User != nil || public.Path != "" || public.RawQuery != "" || public.ForceQuery || public.Fragment != "" || (public.Scheme != "http" && public.Scheme != "https") {
		return nil, errors.New("invalid Forms public origin")
	}
	if c.Transport != nil {
		g.transport = c.Transport
	} else {
		guard, err := formsGuard(c)
		if err != nil {
			return nil, err
		}
		g.transport = &http.Transport{Proxy: nil, DialContext: guard.DialContext, TLSClientConfig: guard.TLSConfig(), TLSHandshakeTimeout: 5 * time.Second, ResponseHeaderTimeout: 15 * time.Second, MaxResponseHeaderBytes: 64 << 10, MaxConnsPerHost: 12, MaxIdleConnsPerHost: 12, IdleConnTimeout: 30 * time.Second, DisableCompression: true}
	}
	g.key = append([]byte(nil), c.Key...)
	g.upstream = c.Upstream
	return g, nil
}

func formsJSONType(value string) bool {
	media, params, err := mime.ParseMediaType(value)
	return err == nil && media == "application/json" && (len(params) == 0 || len(params) == 1 && strings.EqualFold(params["charset"], "utf-8"))
}

func (g *formsGateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	sess, err := g.server.readSession(r)
	if err != nil {
		if gatewayDocumentRequest(r) && (r.URL.Path == "/forms" || r.URL.Path == "/forms/" || r.URL.Path == "/forms/index.html") {
			http.Redirect(w, r, "/401?return_to=%2Fforms%2F", http.StatusSeeOther)
		} else {
			problem(w, 401, "session_expired", "Войдите в Платформу")
		}
		return
	}
	if g.transport == nil {
		problem(w, 503, "gateway_unavailable", "Опросы пока не подключены к Платформе")
		return
	}
	if r.URL.Path == "/forms" && (r.Method == "GET" || r.Method == "HEAD") && r.URL.RawPath == "" && r.URL.RawQuery == "" && !r.URL.ForceQuery {
		http.Redirect(w, r, "/forms/", http.StatusTemporaryRedirect)
		return
	}
	route, allowed := formsMatchRoute(r)
	if !allowed || len(r.Header.Values("Upgrade")) != 0 {
		problem(w, 404, "gateway_route", "Этот адрес недоступен через Платформу")
		return
	}
	if route.scope == "forms:admin" && !sess.User.Admin {
		problem(w, 403, "forbidden", "Недостаточно прав для выполнения операции")
		return
	}
	if route.media == "application/javascript" || route.media == "text/css" {
		if !g.static.acquire(r.Context()) {
			problem(w, 503, "gateway_busy", "Опросы заняты. Повторите запрос позднее")
			return
		}
		defer func() { <-g.static.slots }()
	} else if r.Method == http.MethodGet || r.Method == http.MethodHead {
		if !g.reads.acquire(r.Context()) {
			problem(w, 503, "gateway_busy", "Опросы заняты. Повторите запрос позднее")
			return
		}
		defer func() { <-g.slots }()
	} else {
		select {
		case g.slots <- struct{}{}:
			defer func() { <-g.slots }()
		default:
			problem(w, 503, "gateway_busy", "Опросы заняты. Повторите запрос позднее")
			return
		}
	}
	if len(r.Header.Values("Content-Type")) > 1 || len(r.Header.Values("Content-Encoding")) > 1 {
		problem(w, 400, "gateway_headers", "Некорректные заголовки запроса")
		return
	}
	if enc := r.Header.Get("Content-Encoding"); enc != "" && enc != "identity" {
		problem(w, 415, "gateway_encoding", "Кодирование тела запроса не поддерживается")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, formsBodyLimit))
	if err != nil {
		problem(w, 413, "gateway_body_limit", "JSON-запрос превышает 3 МиБ")
		return
	}
	unsafe := r.Method != "GET" && r.Method != "HEAD"
	derived := gatewayServiceCSRF(sess.CSRF, "forms")
	if unsafe {
		if !g.server.gatewayOrigin(r) || !gatewayCSRF(r, body, sess.CSRF, derived) {
			problem(w, 403, "csrf", "Запрос не прошёл проверку сессии")
			return
		}
		if !formsJSONType(r.Header.Get("Content-Type")) {
			problem(w, 415, "gateway_content_type", "Ожидается application/json")
			return
		}
		if !json.Valid(body) {
			problem(w, 400, "gateway_json", "Некорректный JSON")
			return
		}
		if len(r.Header.Values("Idempotency-Key")) != 1 || !formsIdempotency.MatchString(r.Header.Get("Idempotency-Key")) {
			problem(w, 400, "gateway_idempotency", "Ожидается Idempotency-Key в формате UUID")
			return
		}
	} else if len(body) != 0 {
		problem(w, 400, "gateway_body", "Для чтения тело запроса не поддерживается")
		return
	}
	sourceIP := g.server.loginPeer(r)
	if net.ParseIP(sourceIP) == nil {
		problem(w, 400, "gateway_peer", "Не удалось определить адрес клиента")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), g.timeout)
	defer cancel()
	out, err := http.NewRequestWithContext(ctx, r.Method, g.upstream+r.URL.Path, bytes.NewReader(body))
	if err != nil {
		problem(w, 502, "gateway_request", "Не удалось выполнить запрос")
		return
	}
	if unsafe {
		// Idempotency-Key must not make Transport silently replay a mutation on
		// a reused connection after a lost response. Business retry is explicit.
		out.Body = io.NopCloser(bytes.NewReader(body))
		out.GetBody = nil
		out.ContentLength = int64(len(body))
	}
	// Default deny: client cookies, identity, Authorization, CSRF and forwarding
	// metadata cannot reach the backend. Only this server writes trust headers.
	hop := map[string]bool{}
	for _, line := range r.Header.Values("Connection") {
		for _, name := range strings.Split(line, ",") {
			hop[http.CanonicalHeaderKey(strings.TrimSpace(name))] = true
		}
	}
	for _, name := range []string{"Accept", "Accept-Language"} {
		if !hop[name] && len(r.Header.Values(name)) == 1 {
			out.Header.Set(name, r.Header.Get(name))
		}
	}
	if unsafe {
		out.Header.Set("Content-Type", r.Header.Get("Content-Type"))
		out.Header.Set("X-CSRF-Token", derived)
		out.Header.Set("Idempotency-Key", r.Header.Get("Idempotency-Key"))
	}
	public, _ := url.Parse(g.server.Config.PublicURL)
	out.Host = public.Host
	out.Header.Set("X-Forwarded-Host", public.Host)
	out.Header.Set("X-Forwarded-Proto", public.Scheme)
	out.Header.Set("X-Forwarded-Prefix", formsPrefix)
	out.Header.Set("X-Forwarded-For", sourceIP)
	out.Header.Set("X-Real-IP", sourceIP)
	if unsafe {
		out.Header.Set("Origin", g.server.Config.PublicURL)
	}
	if err = signFormsRequest(out, body, sess, g.key, time.Now(), unsafe, sourceIP); err != nil {
		problem(w, 503, "gateway_identity", "Не удалось проверить доступ")
		return
	}
	response, err := g.transport.RoundTrip(out)
	if err != nil {
		message := "Опросы временно недоступны"
		if unsafe {
			message = "Сервис не ответил. Проверьте результат операции перед повтором"
		}
		problem(w, 502, "gateway_source", message)
		return
	}
	defer response.Body.Close()
	if len(response.Header.Values("Set-Cookie")) != 0 || len(response.Header.Values("WWW-Authenticate")) != 0 || len(response.Header.Values("Proxy-Authenticate")) != 0 || response.StatusCode < 200 || response.StatusCode > 599 {
		problem(w, 502, "gateway_auth_response", "Сервис вернул неподдерживаемую авторизацию")
		return
	}
	// API never redirects; page redirects must lead to another exact read route.
	location := response.Header.Get("Location")
	redirect := response.StatusCode >= 300 && response.StatusCode < 400
	if len(response.Header.Values("Location")) > 1 || len(response.Header.Values("HX-Redirect")) != 0 || len(response.Header.Values("Refresh")) != 0 || (redirect || location != "") && (route.media == "application/json" || !redirect || location == "" || !g.validRedirect(out.URL, public, location)) {
		problem(w, 502, "gateway_redirect", "Сервис вернул неподдерживаемый переход")
		return
	}
	limit := formsAssetLimit
	if route.media == "application/json" {
		limit = formsAPILimit
	}
	if len(response.Header.Values("Content-Type")) > 1 || len(response.Header.Values("Content-Encoding")) != 0 {
		problem(w, 502, "gateway_response_type", "Сервис вернул неподдерживаемый тип ответа")
		return
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, int64(limit)+1))
	if err != nil || len(data) > limit {
		problem(w, 502, "gateway_response", "Не удалось получить ответ сервиса")
		return
	}
	if !redirect && response.StatusCode != http.StatusNoContent {
		media, _, e := mime.ParseMediaType(response.Header.Get("Content-Type"))
		valid := e == nil && media == route.media
		if route.media == "application/javascript" && media == "text/javascript" {
			valid = true
		}
		if route.media == "application/json" {
			valid = formsJSONType(response.Header.Get("Content-Type")) && (r.Method == "HEAD" || json.Valid(data))
		}
		if !valid {
			problem(w, 502, "gateway_response_type", "Сервис вернул неподдерживаемый тип ответа")
			return
		}
	}
	latest, err := g.server.readSession(r.Clone(ctx))
	if err != nil || latest.User.ID != sess.User.ID || latest.User.Admin != sess.User.Admin || latest.CSRF != sess.CSRF {
		problem(w, 401, "session_expired", "Сессия завершена. Войдите в Платформу и проверьте результат операции")
		return
	}
	if location != "" {
		parsed, _ := url.Parse(location)
		base := out.URL
		if parsed != nil && parsed.Host == public.Host && parsed.Scheme == public.Scheme {
			copyBase := *base
			copyBase.Host = public.Host
			copyBase.Scheme = public.Scheme
			base = &copyBase
		}
		next, _ := gatewayRedirect(base, formsPrefix, location)
		w.Header().Set("Location", next)
	}
	for _, name := range []string{"Content-Type", "Content-Security-Policy", "Referrer-Policy"} {
		if value := response.Header.Get(name); value != "" {
			w.Header().Set(name, value)
		}
	}
	w.WriteHeader(response.StatusCode)
	if r.Method != "HEAD" {
		_, _ = w.Write(data)
	}
}

func (g *formsGateway) validRedirect(base, public *url.URL, location string) bool {
	parsed, err := url.Parse(location)
	if err != nil || parsed.Fragment != "" {
		return false
	}
	if parsed.Scheme == public.Scheme && parsed.Host == public.Host {
		copyBase := *base
		copyBase.Scheme = public.Scheme
		copyBase.Host = public.Host
		base = &copyBase
	}
	next, ok := gatewayRedirect(base, formsPrefix, location)
	if !ok {
		return false
	}
	u, err := url.Parse(next)
	if err != nil {
		return false
	}
	route, ok := formsMatchRoute(&http.Request{Method: "GET", URL: u})
	return ok && route.media != "application/json"
}

package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"pl/portal/internal/netguard"
	"pl/portal/internal/organization"
)

// Configuration is resolved once by the owner. Upstream is an origin without
// path; the manifest determines exact external paths and fixed prefix rewrite.
type DoskaGatewayConfig struct {
	APIUpstream string
	WebUpstream string
	Key         []byte
	Manifest    DoskaGatewayManifest
	Guard       *netguard.Guard
	Events      bool // Explicit opt-in; manifest alone cannot enable streams.
	Attachments *DoskaAttachmentConfig
	Transport   http.RoundTripper // Optional dependency injection; production uses Guard.
}

type doskaGateway struct {
	server          *Server
	config          DoskaGatewayConfig
	apiUpstream     *url.URL
	webUpstream     *url.URL
	routes          []doskaCompiledRoute
	transport       http.RoundTripper
	importTransport http.RoundTripper
	slots           chan struct{}
	static          *gatewayCapacity
	pending         chan struct{}
	queueTimeout    time.Duration
	events          doskaEventAdmission
	files           *doskaFileTransport
}

var errDoskaIdentityDenied = errors.New("doska identity not eligible")

func doskaGatewayIdentityProblem(w http.ResponseWriter, err error) {
	if errors.Is(err, organization.ErrNotFound) || errors.Is(err, errDoskaIdentityDenied) {
		problem(w, 403, "doska_identity", "Нет подтверждённого доступа к Doska")
		return
	}
	problem(w, 503, "doska_identity_unavailable", "Нет подтверждённых свежих данных для Doska")
}

func (s *Server) DoskaGateway(c DoskaGatewayConfig) (http.Handler, error) {
	g, err := s.newDoskaGateway(c)
	if err != nil {
		return nil, err
	}
	return g, nil
}
func (s *Server) newDoskaGateway(c DoskaGatewayConfig) (*doskaGateway, error) {
	parse := func(raw string) (*url.URL, error) {
		u, e := url.Parse(raw)
		if e != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.Path != "" && u.Path != "/" || u.RawPath != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
			return nil, errors.New("invalid doska upstream origin")
		}
		return u, nil
	}
	api, e := parse(c.APIUpstream)
	if e != nil {
		return nil, e
	}
	web, e := parse(c.WebUpstream)
	if e != nil {
		return nil, e
	}
	if len(c.Key) != 32 || s.Config.PublicURL == "" {
		return nil, errors.New("invalid doska gateway configuration")
	}
	routes, e := compileDoskaManifest(c.Manifest)
	if e != nil {
		return nil, e
	}
	tr := c.Transport
	if tr == nil {
		if c.Guard == nil {
			return nil, errors.New("doska gateway destination guard required")
		}
		for _, u := range []*url.URL{api, web} {
			if e = c.Guard.ValidateURL(u); e != nil {
				return nil, e
			}
		}
		tr = &http.Transport{Proxy: nil, DialContext: c.Guard.DialContext, TLSClientConfig: c.Guard.TLSConfig(), TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 30 * time.Second, MaxResponseHeaderBytes: 64 << 10}
	}
	importTransport := tr
	if base, ok := tr.(*http.Transport); ok {
		clone := base.Clone()
		clone.ResponseHeaderTimeout = doskaTaskImportTimeout
		importTransport = clone
	}
	var files *doskaFileTransport
	if c.Attachments != nil {
		files, e = newDoskaFileTransport(*c.Attachments)
		if e != nil {
			return nil, e
		}
	}
	c.Key = append([]byte(nil), c.Key...)
	return &doskaGateway{server: s, config: c, apiUpstream: api, webUpstream: web, routes: routes, transport: tr, importTransport: importTransport, files: files,
		slots: make(chan struct{}, 4), static: newGatewayStaticCapacity(), pending: make(chan struct{}, 16), queueTimeout: 5 * time.Second}, nil
}

// acquireSlot keeps four active requests while allowing a bounded browser
// fan-out to wait briefly. Queued cancellation never reaches the upstream.
func (g *doskaGateway) acquireSlot(ctx context.Context) bool {
	return acquireGatewayCapacity(ctx, g.slots, g.pending, g.queueTimeout)
}

func (g *doskaGateway) identity(ctx context.Context, subject string, now time.Time) (organization.Projection, error) {
	if g.server.Store == nil || g.server.Store.Pool == nil {
		return organization.Projection{}, errors.New("organization unavailable")
	}
	var p organization.Projection
	var e error
	if subject == "local-admin" || strings.HasPrefix(subject, "local:") {
		p, e = g.server.localDoskaIdentity(ctx, subject, now)
	} else {
		p, e = organization.NewStore(g.server.Store.Pool).Lookup(ctx, subject, now)
	}
	if e != nil {
		return p, e
	}
	if !p.AccessAllowed {
		return p, errDoskaIdentityDenied
	}
	return p, nil
}

// Login return targets are configured document pages, never API/asset lanes.
// Drop the query rather than carrying credentials into the login URL.
func (g *doskaGateway) documentLoginTarget(r *http.Request) (string, bool) {
	if !gatewayDocumentRequest(r) || len(r.Header.Values("Upgrade")) != 0 {
		return "", false
	}
	check := r.Clone(r.Context())
	check.Method = http.MethodGet
	check.URL.RawQuery = ""
	check.URL.ForceQuery = false
	if check.URL.Path == "/doska" {
		check.URL.Path = "/doska/"
	}
	route, ok := doskaMatchRoute(g.routes, check)
	if !ok || route.Kind != "page" {
		return "", false
	}
	return check.URL.Path, true
}

func (g *doskaGateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	checkedAt := time.Now()
	checkRequest := r
	if r.URL.Path == doskaEventsPath {
		checkCtx, stop := context.WithTimeout(r.Context(), 2*time.Second)
		defer stop()
		checkRequest = r.Clone(checkCtx)
	}
	sess, e := g.server.readSession(checkRequest)
	if e != nil {
		if target, ok := g.documentLoginTarget(r); ok {
			http.Redirect(w, r, "/401?return_to="+url.QueryEscape(target), http.StatusSeeOther)
		} else {
			problem(w, 401, "session_expired", "Войдите в Платформу")
		}
		return
	}
	p, e := g.identity(checkRequest.Context(), sess.User.ID, checkedAt)
	if e != nil {
		doskaGatewayIdentityProblem(w, e)
		return
	}
	if r.URL.Path == "/doska" && r.URL.RawQuery == "" && r.URL.RawPath == "" && r.Method == "GET" {
		http.Redirect(w, r, "/doska/", http.StatusTemporaryRedirect)
		return
	}
	if g.serveCatalog(w, r, sess, p.ValidUntil) {
		return
	}
	resourceSearch, e := doskaResourceSearchInput(r)
	if e != nil {
		catalogProblem(w, 404, "unavailable")
		return
	}
	route, ok := doskaMatchRoute(g.routes, r)
	if !ok {
		if resourceSearch != nil {
			catalogProblem(w, 404, "unavailable")
		} else {
			problem(w, 404, "gateway_route", "Этот адрес недоступен через Платформу")
		}
		return
	}
	if r.Header.Get("Upgrade") != "" || len(r.Header.Values("Upgrade")) > 1 {
		problem(w, 404, "gateway_route", "Этот адрес недоступен через Платформу")
		return
	}
	if r.URL.Path == doskaEventsPath || route.Kind == "events" {
		if !g.config.Events || route.Kind != "events" {
			problem(w, 404, "gateway_route", "Канал недоступен")
			return
		}
		g.serveEvents(w, r, sess, p, checkedAt)
		return
	}
	importRoute := doskaTaskImportRoute(route.DoskaGatewayRoute)
	attachment, attachmentOK := false, false
	if !importRoute {
		attachment, attachmentOK = doskaAttachmentRoute(route.DoskaGatewayRoute)
	}
	// A generic ID template must not accidentally open the reserved file API.
	if doskaAttachmentRequestPath.MatchString(r.URL.Path) && !attachmentOK {
		problem(w, 404, "gateway_route", "Этот адрес недоступен через Платформу")
		return
	}
	if attachment {
		if g.files == nil {
			problem(w, 404, "gateway_route", "Вложения недоступны")
			return
		}
		if route.Kind == "upload" || route.Kind == "download" {
			g.serveFile(w, r, sess, p, route.Kind)
			return
		}
	}
	if doskaTaskImportRequestPath.MatchString(r.URL.Path) && !importRoute {
		problem(w, 404, "gateway_route", "Канал импорта недоступен")
		return
	}
	if route.Kind == "asset" && (r.Method == http.MethodGet || r.Method == http.MethodHead) {
		if !g.static.acquire(r.Context()) {
			problem(w, 503, "gateway_busy", "Doska занята. Повторите запрос позднее")
			return
		}
		defer func() { <-g.static.slots }()
	} else {
		if !g.acquireSlot(r.Context()) {
			problem(w, 503, "gateway_busy", "Doska занята. Повторите запрос позднее")
			return
		}
		defer func() { <-g.slots }()
	}

	if len(r.Header.Values("Content-Type")) > 1 || len(r.Header.Values("Content-Encoding")) > 1 {
		problem(w, 400, "gateway_headers", "Некорректные заголовки")
		return
	}
	if enc := r.Header.Get("Content-Encoding"); enc != "" && enc != "identity" {
		problem(w, 415, "gateway_encoding", "Кодирование запроса не поддерживается")
		return
	}
	bodyLimit := int64(128 << 10)
	if importRoute {
		bodyLimit = doskaTaskImportLimit
	}
	body, e := io.ReadAll(http.MaxBytesReader(w, r.Body, bodyLimit))
	if e != nil {
		problem(w, 413, "gateway_body_limit", "Запрос слишком большой")
		return
	}
	if !importRoute && route.Schema != "" && !doskaAttachmentJSON(route.Schema, body) {
		problem(w, 400, "gateway_body", "Некорректное тело операции с вложением")
		return
	}
	importCount := 0
	if importRoute {
		var valid bool
		importCount, valid = doskaTaskImportRequest(body)
		if !valid {
			problem(w, 400, "gateway_body", "Некорректное тело импорта")
			return
		}
	}
	unsafe := route.Kind == "write"
	if !unsafe && len(body) != 0 {
		problem(w, 400, "gateway_body", "Тело запроса не поддерживается")
		return
	}
	derived := gatewayServiceCSRF(sess.CSRF, "doska")
	if unsafe {
		media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if len(body) > 0 && (err != nil || media != "application/json" || !json.Valid(body)) {
			problem(w, 415, "gateway_content_type", "Ожидается JSON")
			return
		}
		if !g.server.gatewayOrigin(r) || !gatewayCSRF(r, body, sess.CSRF, derived) {
			problem(w, 403, "csrf", "Запрос не прошёл проверку сессии")
			return
		}
	}
	idem, err := gatewayIdempotency(r, body, "doska")
	if err != nil {
		problem(w, 400, "gateway_idempotency", "Некорректный ключ операции")
		return
	}
	sourceIP := g.server.loginPeer(r)
	if net.ParseIP(sourceIP) == nil {
		problem(w, 400, "gateway_peer", "Некорректный адрес клиента")
		return
	}
	timeout := 130 * time.Second
	if importRoute {
		timeout = doskaTaskImportTimeout
	}
	deadline := time.Now().Add(timeout)
	if sess.ExpiresAt.Before(deadline) {
		deadline = sess.ExpiresAt
	}
	if p.ValidUntil.Before(deadline) {
		deadline = p.ValidUntil
	}
	ctx, cancel := context.WithDeadline(r.Context(), deadline)
	defer cancel()
	out := r.Clone(ctx)
	out.Body = io.NopCloser(bytes.NewReader(body))
	out.ContentLength = int64(len(body))
	out.GetBody = nil
	if resourceSearch != nil {
		if e = g.prepareResourceSearch(r.Clone(ctx), sess, resourceSearch); e != nil {
			catalogFail(w, e)
			return
		}
		resourceSearch.rewrite(out)
	}
	out.Header = make(http.Header)
	for _, name := range []string{"Accept", "Accept-Language", "Content-Type", "If-None-Match", "If-Modified-Since"} {
		if v := r.Header.Get(name); v != "" {
			out.Header.Set(name, v)
		}
	}
	if idem != "" {
		out.Header.Set("Idempotency-Key", idem)
	}
	if unsafe {
		out.Header.Set("X-CSRF-Token", derived)
		out.Header.Set("Origin", g.server.Config.PublicURL)
	}
	public, _ := url.Parse(g.server.Config.PublicURL)
	out.Host = public.Host
	out.Header.Set("X-Forwarded-Host", public.Host)
	out.Header.Set("X-Forwarded-Proto", public.Scheme)
	out.Header.Set("X-Forwarded-Prefix", "/doska")
	out.Header.Set("X-Forwarded-For", sourceIP)
	kind := doskaRouteRead
	if unsafe {
		kind = doskaRouteWrite
	}
	if strings.HasPrefix(out.URL.Path, "/doska/api/") {
		sign := signDoskaRequest
		if importRoute {
			sign = signDoskaTaskImport
		}
		if e := sign(out, body, sess, kind, g.config.Key, time.Now(), unsafe, sourceIP); e != nil {
			problem(w, 400, "gateway_identity", "Некорректный запрос Doska")
			return
		}
		out.URL.Path = strings.TrimPrefix(out.URL.Path, "/doska")
	}
	target := g.webUpstream
	if strings.HasPrefix(r.URL.Path, "/doska/api/") {
		target = g.apiUpstream
	}
	out.URL.Scheme = target.Scheme
	out.URL.Host = target.Host
	out.RequestURI = ""
	transport := g.transport
	if importRoute {
		transport = g.importTransport
	}
	response, e := transport.RoundTrip(out)
	if e != nil {
		problem(w, 502, "gateway_source", "Doska не ответила. Проверьте результат операции перед повтором")
		return
	}
	defer response.Body.Close()
	if response.StatusCode == 101 || len(response.Header.Values("Location")) > 1 {
		problem(w, 502, "gateway_response", "Неподдерживаемый ответ Doska")
		return
	}
	// Resource search never exposes redirects or upstream error bodies.
	if resourceSearch != nil && response.StatusCode != http.StatusOK {
		catalogFail(w, resourceSearchResponse(response, nil))
		return
	}
	g.filterResponse(response, route.Kind == "asset" && (r.Method == http.MethodGet || r.Method == http.MethodHead))
	if location := response.Header.Get("Location"); location != "" {
		loc, e := g.redirect(out.URL, location)
		if e != nil {
			problem(w, 502, "gateway_redirect", "Неподдерживаемый переход Doska")
			return
		}
		response.Header.Set("Location", loc)
	}
	data, e := io.ReadAll(io.LimitReader(response.Body, (16<<20)+1))
	if e != nil || len(data) > 16<<20 {
		problem(w, 502, "gateway_response", "Не удалось получить ответ Doska")
		return
	}
	if strings.HasPrefix(r.URL.Path, "/doska/api/") && response.StatusCode != 204 && response.StatusCode != 304 && !(response.StatusCode >= 300 && response.StatusCode < 400) {
		media, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
		if media != "application/json" && !strings.HasSuffix(media, "+json") {
			problem(w, 502, "gateway_response_type", "Doska вернула неподдерживаемый ответ API")
			return
		}
	}
	if importRoute && !doskaTaskImportResponse(response.StatusCode, importCount, data) {
		problem(w, 502, "gateway_response", "Некорректный ответ импорта Doska")
		return
	}
	latest, e := g.server.readSession(r.Clone(ctx))
	if e != nil || latest.User.ID != sess.User.ID {
		problem(w, 401, "session_expired", "Сессия завершена")
		return
	}
	if _, e = g.identity(ctx, sess.User.ID, time.Now()); e != nil {
		doskaGatewayIdentityProblem(w, e)
		return
	}
	if resourceSearch != nil {
		if e = g.recheckResourceSearch(r.Clone(ctx), sess, latest, resourceSearch); e != nil {
			catalogFail(w, e)
			return
		}
		if e = resourceSearchResponse(response, data); e != nil {
			catalogFail(w, e)
			return
		}
	}
	for name, values := range response.Header {
		for _, value := range values {
			w.Header().Add(name, value)
		}
	}
	w.WriteHeader(response.StatusCode)
	if r.Method != "HEAD" {
		_, _ = w.Write(data)
	}
}
func (g *doskaGateway) filterResponse(response *http.Response, asset bool) {
	h := make(http.Header)
	for _, name := range []string{"Content-Type", "Content-Disposition", "Content-Security-Policy", "Location"} {
		if values := response.Header.Values(name); len(values) == 1 {
			h.Set(name, values[0])
		}
	}
	if asset {
		if values := response.Header.Values("ETag"); len(values) == 1 && doskaAssetETag(values[0]) {
			h.Set("ETag", values[0])
		}
		if values := response.Header.Values("Last-Modified"); len(values) == 1 && len(values[0]) <= 128 {
			if _, err := http.ParseTime(values[0]); err == nil {
				h.Set("Last-Modified", values[0])
			}
		}
	}
	response.Header = h
}

// RFC 9110 entity-tag: optional W/ followed by a quoted opaque tag.
func doskaAssetETag(value string) bool {
	if len(value) > 256 {
		return false
	}
	tag := strings.TrimPrefix(value, "W/")
	if len(tag) < 2 || tag[0] != '"' || tag[len(tag)-1] != '"' {
		return false
	}
	for i := 1; i < len(tag)-1; i++ {
		if tag[i] == '"' || tag[i] < 0x21 || tag[i] == 0x7f {
			return false
		}
	}
	return true
}
func (g *doskaGateway) redirect(base *url.URL, location string) (string, error) {
	u, e := url.Parse(location)
	if e != nil || u.User != nil || u.RawPath != "" || strings.ContainsAny(u.EscapedPath(), "%\\") || strings.Contains(u.Path, "..") || strings.Contains(u.Path, "//") {
		return "", errors.New("invalid redirect")
	}
	next := base.ResolveReference(u)
	public, _ := url.Parse(g.server.Config.PublicURL)
	if !((next.Scheme == base.Scheme && next.Host == base.Host) || (next.Scheme == public.Scheme && next.Host == public.Host)) {
		return "", errors.New("foreign redirect")
	}
	if strings.HasPrefix(next.Path, "/api/") {
		next.Path = "/doska" + next.Path
	}
	check := *next
	check.Fragment = ""
	req := &http.Request{Method: "GET", URL: &check}
	if _, ok := doskaMatchRoute(g.routes, req); !ok {
		return "", errors.New("unregistered redirect")
	}
	result := next.RequestURI()
	if next.Fragment != "" {
		result += "#" + next.EscapedFragment()
	}
	return result, nil
}

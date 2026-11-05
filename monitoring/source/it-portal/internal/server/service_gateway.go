package server

import (
	"bytes"
	"context"
	"crypto/subtle"
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

// ServiceGatewayConfig is selected at server startup, never from request parameters.
type ServiceGatewayConfig struct {
	AssertionVersion int
	Audience         string
	Prefix           string
	Upstream         string
	Key              []byte
	Transport        http.RoundTripper
}

var gatewaySafeID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var gatewayStatic = regexp.MustCompile(`^/static/[A-Za-z0-9_./-]+$`)
var auditorAsset = regexp.MustCompile(`^/assets/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{6,}\.(?:js|css)$`)
var auditorDepartment = regexp.MustCompile(`^/(?:departments|api/departments|api/intelligence/departments)/[1-9][0-9]*$`)
var auditorSimulation = regexp.MustCompile(`^/api/intelligence/departments/[1-9][0-9]*/simulate$`)

// gatewayStaticRequest is used only after the route and session checks.
// Directory retains its existing shared operation limit.
func gatewayStaticRequest(audience, method, path string) bool {
	if method != http.MethodGet && method != http.MethodHead {
		return false
	}
	switch audience {
	case "monitoring-admin", "websites-admin":
		return gatewayStatic.MatchString(path)
	case "auditor":
		return auditorAsset.MatchString(path)
	}
	return false
}

func gatewayRoute(audience, method, path string) bool {
	if strings.Contains(path, "..") || strings.Contains(path, "//") || strings.ContainsAny(path, "\\%") {
		return false
	}
	if audience == "directory" {
		switch method {
		case "GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE":
			return strings.HasPrefix(path, "/")
		default:
			return false
		}
	}
	if audience == "auditor" {
		if method == "POST" {
			return path == "/api/scans"
		}
		if method != "GET" && method != "HEAD" {
			return false
		}
		if auditorAsset.MatchString(path) || auditorDepartment.MatchString(path) || auditorSimulation.MatchString(path) {
			return true
		}
		switch path {
		case "/", "/departments", "/documents", "/scans", "/service", "/favicon.svg", "/api/instance", "/api/findings", "/api/departments", "/api/scans", "/api/scans/current", "/api/dashboard", "/api/intelligence/overview", "/api/scans/latest":
			return true
		}
		return false
	}
	if audience != "monitoring-admin" && audience != "websites-admin" {
		return false
	}
	read := method == "GET" || method == "HEAD"
	if read && gatewayStatic.MatchString(path) {
		return true
	}
	if audience == "monitoring-admin" {
		if read {
			for _, p := range []string{"/", "/containers", "/telegram", "/diagnostics", "/operations", "/api/v1/session", "/api/v1/overview", "/api/v1/containers", "/api/v1/deliveries", "/api/v1/diagnostics", "/api/v1/audit"} {
				if path == p {
					return true
				}
			}
			if !strings.HasPrefix(path, "/api/v1/") {
				return false
			}
			pieces := strings.Split(strings.TrimPrefix(path, "/api/v1/"), "/")
			return len(pieces) == 2 && pieces[0] == "jobs" && gatewaySafeID.MatchString(pieces[1]) || len(pieces) == 3 && pieces[0] == "containers" && gatewaySafeID.MatchString(pieces[1]) && pieces[2] == "logs"
		}
		if !strings.HasPrefix(path, "/api/v1/") {
			return false
		}
		pieces := strings.Split(strings.TrimPrefix(path, "/api/v1/"), "/")
		return method == "POST" && len(pieces) == 3 && pieces[0] == "containers" && gatewaySafeID.MatchString(pieces[1]) && pieces[2] == "restart"
	}
	if audience == "websites-admin" {
		if read && (path == "/" || path == "/history" || path == "/rollback" || path == "/add") {
			return true
		}
		if method == "POST" && (path == "/add/preview" || path == "/add/apply" || path == "/rollback") {
			return true
		}
		pieces := strings.Split(strings.TrimPrefix(path, "/"), "/")
		if len(pieces) < 2 || pieces[0] != "targets" || !gatewaySafeID.MatchString(pieces[1]) {
			return false
		}
		if read {
			return len(pieces) == 2 || len(pieces) == 3 && (pieces[2] == "update" || pieces[2] == "delete")
		}
		return method == "POST" && len(pieces) == 3 && (pieces[2] == "update" || pieces[2] == "disable-content" || pieces[2] == "delete")
	}
	return false
}

func gatewayPrefix(audience string) string {
	if audience == "directory" {
		return "/directory"
	}
	if audience == "monitoring-admin" {
		return "/admin"
	}
	if audience == "websites-admin" {
		return "/websites"
	}
	return ""
}

func gatewayConfigPrefix(c ServiceGatewayConfig) string {
	if c.Audience == "auditor" {
		if c.Prefix == "/audit" || c.Prefix == "/audit-arch" {
			return c.Prefix
		}
		return ""
	}
	return gatewayPrefix(c.Audience)
}

func (s *Server) gatewayOrigin(r *http.Request) bool {
	if len(r.Header.Values("Origin")) > 1 || len(r.Header.Values("Referer")) > 1 || !s.sameOrigin(r) {
		return false
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		return origin == s.Config.PublicURL
	}
	return s.gatewayReferer(r.Header.Get("Referer"))
}
func (s *Server) gatewayReferer(value string) bool {
	ref, err := url.Parse(value)
	return err == nil && ref.User == nil && ref.Scheme+"://"+ref.Host == s.Config.PublicURL
}
func gatewayCSRF(r *http.Request, body []byte, sessionCSRF, derived string) bool {
	headers := r.Header.Values("X-CSRF-Token")
	if len(headers) > 1 {
		return false
	}
	submitted := r.Header.Get("X-CSRF-Token")
	headerValid := submitted != "" && (subtle.ConstantTimeCompare([]byte(submitted), []byte(sessionCSRF)) == 1 || subtle.ConstantTimeCompare([]byte(submitted), []byte(derived)) == 1)
	if len(headers) > 0 && !headerValid {
		return false
	}
	formValid := false
	media, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if media == "application/x-www-form-urlencoded" {
		form, err := url.ParseQuery(string(body))
		if err != nil {
			return false
		}
		values, exists := form["csrf_token"]
		if exists {
			if len(values) != 1 || subtle.ConstantTimeCompare([]byte(values[0]), []byte(derived)) != 1 {
				return false
			}
			formValid = true
		}
	}
	return headerValid || formValid
}
func gatewayIdempotency(r *http.Request, body []byte, audience string) (string, error) {
	values := r.Header.Values("Idempotency-Key")
	if len(values) > 1 {
		return "", errors.New("duplicate idempotency header")
	}
	key := r.Header.Get("Idempotency-Key")
	valid := func(v string) bool { return v != "" && strings.TrimSpace(v) == v && gatewayString(v, 128, true) }
	if len(values) > 0 && !valid(key) {
		return "", errors.New("invalid idempotency key")
	}
	if gatewayRestart(r, audience) && len(body) > 0 {
		decoder := json.NewDecoder(bytes.NewReader(body))
		tok, err := decoder.Token()
		if err != nil || tok != json.Delim('{') {
			return "", errors.New("invalid restart body")
		}
		seen := map[string]bool{}
		for decoder.More() {
			tok, err = decoder.Token()
			if err != nil {
				return "", err
			}
			name, ok := tok.(string)
			if !ok || seen[name] {
				return "", errors.New("duplicate restart field")
			}
			seen[name] = true
			var value json.RawMessage
			if err = decoder.Decode(&value); err != nil {
				return "", err
			}
			if name == "idempotency_key" {
				var bodyKey string
				if json.Unmarshal(value, &bodyKey) != nil || !valid(bodyKey) || key != "" && key != bodyKey {
					return "", errors.New("conflicting idempotency key")
				}
				key = bodyKey
			}
		}
		if _, err = decoder.Token(); err != nil {
			return "", err
		}
		var trailing any
		if decoder.Decode(&trailing) != io.EOF {
			return "", errors.New("trailing restart JSON")
		}
	}
	return key, nil
}
func gatewayRedirect(base *url.URL, prefix, location string) (string, bool) {
	raw, err := url.Parse(location)
	if err != nil || raw.RawPath != "" || strings.ContainsAny(raw.EscapedPath(), "%\\") {
		return "", false
	}
	for _, part := range strings.Split(raw.Path, "/") {
		if part == "." || part == ".." {
			return "", false
		}
	}
	next, err := base.Parse(location)
	if err != nil || next.Scheme != base.Scheme || next.Host != base.Host || next.User != nil || !strings.HasPrefix(next.Path, prefix+"/") || next.RawPath != "" || strings.ContainsAny(next.EscapedPath(), "%\\") || strings.Contains(next.Path, "//") {
		return "", false
	}
	for _, part := range strings.Split(next.Path, "/") {
		if part == "." || part == ".." {
			return "", false
		}
	}
	redirect := next.RequestURI()
	if next.Fragment != "" {
		redirect += "#" + next.EscapedFragment()
	}
	if !gatewayString(redirect, 4096, true) {
		return "", false
	}
	return redirect, true
}

func gatewayDocumentRequest(r *http.Request) bool {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	if _, machine := r.Header["Authorization"]; machine || strings.Contains(r.URL.Path, "/api/") {
		return false
	}
	return strings.Contains(strings.ToLower(r.Header.Get("Accept")), "text/html")
}

func gatewayLoginTarget(r *http.Request, audience, prefix string) string {
	if r.URL.Path == prefix {
		return prefix + "/"
	}
	path := strings.TrimPrefix(r.URL.Path, prefix)
	if !strings.HasPrefix(r.URL.Path, prefix+"/") || r.URL.RawPath != "" || strings.ContainsAny(r.URL.EscapedPath(), "%\\") || strings.Contains(path, "//") || strings.HasPrefix(path, "/api/") || !gatewayRoute(audience, http.MethodGet, path) {
		return prefix + "/"
	}
	return r.URL.Path // Never copy a query containing credentials into the login URL.
}

// ServiceGateway validates the live portal session before producing a short-lived
// assertion for one exact request. Upstream cannot receive the portal credentials.
func (s *Server) ServiceGateway(c ServiceGatewayConfig) http.Handler {
	prefix := gatewayConfigPrefix(c)
	directory := c.Audience == "directory"
	auditor := c.Audience == "auditor"
	if c.AssertionVersion == 0 && !directory && !auditor {
		c.AssertionVersion = 1
	}
	upstream, err := url.Parse(c.Upstream)
	if err == nil && directory && upstream.Path == "" {
		upstream.Path = prefix
	}
	configured := ((directory || auditor) && c.AssertionVersion == 2 || !directory && !auditor && c.AssertionVersion == 1) && err == nil && upstream.Host != "" && (upstream.Scheme == "http" || upstream.Scheme == "https") && upstream.User == nil && upstream.RawQuery == "" && upstream.Fragment == "" && strings.TrimRight(upstream.Path, "/") == prefix && prefix != "" && len(c.Key) == 32 && c.Transport != nil && upstream.RawPath == "" && !strings.ContainsAny(upstream.EscapedPath(), "%\\")
	slots := make(chan struct{}, 4)
	static := newGatewayStaticCapacity()
	reads := newGatewayReadCapacity(slots)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if !configured && !directory {
			problem(w, 503, "gateway_unavailable", "Сервис пока не подключён к Платформе")
			return
		}
		sess, e := s.readSession(r)
		if e != nil {
			if gatewayDocumentRequest(r) {
				target := gatewayLoginTarget(r, c.Audience, prefix)
				http.Redirect(w, r, "/401?return_to="+url.QueryEscape(target), http.StatusSeeOther)
			} else {
				problem(w, 401, "session_expired", "Войдите в Платформу")
			}
			return
		}
		if !sess.User.Admin && !directory && !auditor {
			if gatewayDocumentRequest(r) {
				http.Redirect(w, r, "/403", http.StatusSeeOther)
			} else {
				problem(w, 403, "forbidden", "Недостаточно прав для этого сервиса")
			}
			return
		}
		if !configured {
			if directoryUnavailable(w, r, 503) {
				return
			}
			problem(w, 503, "gateway_unavailable", "Сервис пока не подключён к Платформе")
			return
		}
		if r.URL.Path == prefix && r.Method == "GET" && r.URL.RawQuery == "" && r.URL.RawPath == "" {
			http.Redirect(w, r, prefix+"/", http.StatusTemporaryRedirect)
			return
		}
		path := strings.TrimPrefix(r.URL.Path, prefix)
		if !strings.HasPrefix(r.URL.Path, prefix+"/") || r.URL.RawPath != "" || strings.ContainsAny(r.URL.EscapedPath(), "%\\") || !gatewayRoute(c.Audience, r.Method, path) || r.Header.Get("Upgrade") != "" || !gatewayString(r.URL.RequestURI(), 4096, true) {
			if gatewayDocumentRequest(r) {
				http.Redirect(w, r, "/404", http.StatusSeeOther)
			} else {
				problem(w, 404, "gateway_route", "Этот адрес недоступен через Платформу")
			}
			return
		}
		if gatewayStaticRequest(c.Audience, r.Method, path) {
			if !static.acquire(r.Context()) {
				problem(w, 503, "gateway_busy", "Сервис занят. Повторите запрос позднее")
				return
			}
			defer func() { <-static.slots }()
		} else if !directory && (r.Method == http.MethodGet || r.Method == http.MethodHead) {
			if !reads.acquire(r.Context()) {
				problem(w, 503, "gateway_busy", "Сервис занят. Повторите запрос позднее")
				return
			}
			defer func() { <-slots }()
		} else {
			select {
			case slots <- struct{}{}:
				defer func() { <-slots }()
			default:
				problem(w, 503, "gateway_busy", "Сервис занят. Повторите запрос позднее")
				return
			}
		}
		if enc := r.Header.Get("Content-Encoding"); enc != "" && enc != "identity" {
			problem(w, 415, "gateway_encoding", "Кодирование тела запроса не поддерживается")
			return
		}
		if len(r.Header.Values("Content-Type")) > 1 || len(r.Header.Values("Content-Encoding")) > 1 {
			problem(w, 400, "gateway_headers", "Некорректные заголовки запроса")
			return
		}
		body, e := io.ReadAll(http.MaxBytesReader(w, r.Body, 2<<20))
		if e != nil {
			problem(w, 413, "gateway_body_limit", "Запрос слишком большой")
			return
		}
		unsafe := r.Method != "GET" && r.Method != "HEAD" && !(directory && r.Method == "OPTIONS")
		if (directory || auditor) && unsafe && !sess.User.Admin {
			problem(w, 403, "forbidden", "Недостаточно прав для выполнения операции")
			return
		}
		derived := gatewayServiceCSRF(sess.CSRF, c.Audience)
		if unsafe {
			if !s.gatewayOrigin(r) || !gatewayCSRF(r, body, sess.CSRF, derived) {
				problem(w, 403, "csrf", "Запрос не прошёл проверку сессии")
				return
			}
		} else if len(body) != 0 {
			problem(w, 400, "gateway_body", "Для чтения тело запроса не поддерживается")
			return
		}
		idempotency, err := gatewayIdempotency(r, body, c.Audience)
		if err != nil {
			problem(w, 400, "gateway_idempotency", "Некорректный или противоречивый ключ операции")
			return
		}
		sourceIP := s.loginPeer(r)
		if net.ParseIP(sourceIP) == nil {
			problem(w, 400, "gateway_peer", "Не удалось определить адрес клиента")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 130*time.Second)
		defer cancel()
		target := *upstream
		target.Path = r.URL.Path
		target.RawPath = ""
		target.RawQuery = r.URL.RawQuery
		out, e := http.NewRequestWithContext(ctx, r.Method, target.String(), bytes.NewReader(body))
		if e != nil {
			problem(w, 502, "gateway_request", "Не удалось выполнить запрос")
			return
		}
		hop := map[string]bool{}
		for _, line := range r.Header.Values("Connection") {
			for _, name := range strings.Split(line, ",") {
				hop[http.CanonicalHeaderKey(strings.TrimSpace(name))] = true
			}
		}
		for _, h := range []string{"Accept", "Accept-Language", "Content-Type", "If-None-Match", "If-Modified-Since", "HX-Request", "HX-Target", "HX-Trigger", "HX-Trigger-Name", "HX-Current-URL", "HX-Boosted", "HX-History-Restore-Request"} {
			if v := r.Header.Get(h); v != "" && !hop[http.CanonicalHeaderKey(h)] {
				out.Header.Set(h, v)
			}
		}
		if !hop["Origin"] && r.Header.Get("Origin") == s.Config.PublicURL {
			out.Header.Set("Origin", s.Config.PublicURL)
		}
		if !hop["Referer"] && s.gatewayReferer(r.Header.Get("Referer")) {
			out.Header.Set("Referer", r.Header.Get("Referer"))
		}
		public, _ := url.Parse(s.Config.PublicURL)
		out.Host = public.Host
		out.Header.Set("X-Forwarded-Host", public.Host)
		out.Header.Set("X-Forwarded-Proto", public.Scheme)
		out.Header.Set("X-Forwarded-Prefix", prefix)
		out.Header.Set("X-Forwarded-For", sourceIP)
		out.Header.Set("X-Real-IP", sourceIP)
		if idempotency != "" {
			out.Header.Set("Idempotency-Key", idempotency)
		}
		if unsafe {
			out.Header.Set("X-CSRF-Token", derived)
		}
		scopes := []string{"monitoring:read", "containers:restart", "audit:read"}
		if c.Audience == "websites-admin" {
			scopes = []string{"websites:read", "websites:write"}
		}
		if directory {
			e = signDirectoryRequest(out, body, sess, c.Key, time.Now(), unsafe, sourceIP)
		} else if auditor {
			e = signAuditorRequest(out, body, sess, prefix, c.Key, time.Now(), unsafe, sourceIP)
		} else {
			e = signGatewayRequest(out, body, sess, c.Audience, scopes, c.Key, time.Now(), unsafe, sourceIP)
		}
		if e != nil {
			problem(w, 503, "gateway_identity", "Не удалось проверить доступ")
			return
		}
		response, e := c.Transport.RoundTrip(out)
		if e != nil {
			if directory && directoryUnavailable(w, r, 502) {
				return
			}
			message := "Сервис временно недоступен"
			if unsafe {
				message = "Сервис не ответил. Проверьте результат операции перед повтором"
			}
			problem(w, 502, "gateway_source", message)
			return
		}
		defer response.Body.Close()
		for _, header := range []string{"Location", "HX-Redirect"} {
			if len(response.Header.Values(header)) > 1 {
				problem(w, 502, "gateway_redirect", "Сервис вернул неподдерживаемый переход")
				return
			}
			if loc := response.Header.Get(header); loc != "" {
				// With the forwarded public Host, apps may return a public absolute URL;
				// accept that same portal origin as well as the fixed upstream origin.
				redirectBase := out.URL
				parsed, _ := url.Parse(loc)
				if parsed != nil && parsed.Scheme == public.Scheme && parsed.Host == public.Host {
					copyBase := *out.URL
					copyBase.Scheme = public.Scheme
					copyBase.Host = public.Host
					redirectBase = &copyBase
				}
				next, ok := gatewayRedirect(redirectBase, prefix, loc)
				if !ok {
					problem(w, 502, "gateway_redirect", "Сервис вернул неподдерживаемый переход")
					return
				}
				response.Header.Set(header, next)
			}
		}
		data, e := io.ReadAll(io.LimitReader(response.Body, (16<<20)+1))
		if e != nil || len(data) > 16<<20 {
			problem(w, 502, "gateway_response", "Не удалось получить ответ сервиса")
			return
		}
		latest, err := s.readSession(r)
		if err != nil || latest.User.ID != sess.User.ID || latest.User.Admin != sess.User.Admin || (!directory && !auditor && !latest.User.Admin) {
			problem(w, 401, "session_expired", "Сессия завершена. Войдите в Платформу и проверьте результат операции")
			return
		}
		for _, h := range []string{"Content-Type", "Content-Disposition", "Location", "HX-Redirect", "HX-Refresh", "Content-Security-Policy"} {
			if v := response.Header.Get(h); v != "" {
				w.Header().Set(h, v)
			}
		}
		// Upstream cookies, identity headers and WWW-Authenticate never escape to browser.
		w.WriteHeader(response.StatusCode)
		if r.Method != "HEAD" {
			_, _ = w.Write(data)
		}
	})
}

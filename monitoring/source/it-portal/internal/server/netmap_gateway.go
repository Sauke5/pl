package server

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
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

	"pl/portal/internal/model"
	"pl/portal/internal/modules"
)

const netmapBodyLimit = 3 << 20
const netmapResponseLimit = 32 << 20

var netmapSlots = make(chan struct{}, 2)
var netmapWaiting = make(chan struct{}, 16)
var netmapScopeID = regexp.MustCompile(`^(network|network-[a-f0-9]{16})$`)
var netmapPollRoute = regexp.MustCompile(`^/netmap/api/networks/[a-f0-9]{16}/(poll|remove|observations)$`)

type netmapRoute struct{ scope, media, native string }
type netmapBackend interface {
	FindApplication(context.Context, string) (model.ModuleInstance, error)
	ApplicationKey(context.Context, string) ([]byte, error)
	NetMapRequest(context.Context, string, string, string, string, string, http.Header, []byte) (*http.Response, error)
}
type netmapHandler struct {
	server      *Server
	backend     netmapBackend
	session     func(*http.Request) (session, error)
	slots       chan struct{}
	waiting     chan struct{}
	waitTimeout time.Duration
}

func netmapMatchRoute(r *http.Request) (netmapRoute, bool) {
	if strings.Contains(r.URL.RawQuery, " ") || r.URL.RawPath != "" || r.URL.ForceQuery || r.URL.Fragment != "" || strings.ContainsAny(r.URL.Path, "%\\?# ") || strings.Contains(r.URL.Path, "//") || !gatewayString(r.URL.RequestURI(), 4096, true) {
		return netmapRoute{}, false
	}
	for _, part := range strings.Split(r.URL.Path, "/") {
		if part == "." || part == ".." {
			return netmapRoute{}, false
		}
	}
	read := r.Method == "GET" || r.Method == "HEAD"
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return netmapRoute{}, false
	}
	for key, values := range query {
		if key == "" || len(values) == 0 || !gatewayString(key, 256, true) {
			return netmapRoute{}, false
		}
		for _, value := range values {
			if !gatewayString(value, 4096, false) {
				return netmapRoute{}, false
			}
		}
	}
	for _, native := range []string{"netbox", "gitea", "oxidized"} {
		if strings.HasPrefix(r.URL.Path, "/netmap/"+native+"/") && (read || r.Method == "POST" || r.Method == "PUT" || r.Method == "PATCH" || r.Method == "DELETE") {
			return netmapRoute{"netmap:admin", "", native}, true
		}
	}
	if read {
		media := ""
		switch r.URL.Path {
		case "/netmap/", "/netmap/index.html":
			media = "text/html"
		case "/netmap/app.js", "/netmap/theme-init.js", "/netmap/office-view.js", "/netmap/config.js":
			media = "application/javascript"
		case "/netmap/style.css":
			media = "text/css"
		}
		if media != "" {
			for key, values := range query {
				if len(values) != 1 || key != "scope" || (r.URL.Path != "/netmap/" && r.URL.Path != "/netmap/index.html") || !netmapScopeID.MatchString(values[0]) {
					return netmapRoute{}, false
				}
			}
			return netmapRoute{"netmap:read", media, ""}, true
		}
		if len(query) != 0 {
			return netmapRoute{}, false
		}
		switch r.URL.Path {
		case "/netmap/api/networks", "/netmap/api/profiles", "/netmap/api/polls":
			return netmapRoute{"netmap:admin", "application/json", ""}, true
		case "/netmap/api/instance", "/netmap/api/topology", "/netmap/api/health", "/netmap/api/wan", "/netmap/api/wan/health", "/netmap/api/sites/health":
			return netmapRoute{"netmap:read", "application/json", ""}, true
		}
		if tail, ok := strings.CutPrefix(r.URL.Path, "/netmap/api/sites/"); ok && netmapScopeID.MatchString(tail) {
			return netmapRoute{"netmap:read", "application/json", ""}, true
		}
	}
	if r.Method == "POST" && len(query) == 0 && (r.URL.Path == "/netmap/api/networks" || r.URL.Path == "/netmap/api/profiles" || netmapPollRoute.MatchString(r.URL.Path)) {
		return netmapRoute{"netmap:admin", "application/json", ""}, true
	}
	return netmapRoute{}, false
}

func signNetmapRequest(r *http.Request, body []byte, sess session, key []byte, now time.Time, verified bool, sourceIP string) error {
	route, allowed := netmapMatchRoute(r)
	unsafe := r.Method != "GET" && r.Method != "HEAD"
	if !allowed || !sess.User.Admin || sess.User.ID == "" || sess.User.Name == "" || sess.CSRF == "" || len(key) != 32 || len(body) > netmapBodyLimit || net.ParseIP(sourceIP) == nil || !gatewayString(sess.User.ID, 256, false) || !gatewayString(sess.User.Name, 512, false) || !gatewayString(r.Header.Get("Content-Type"), 256, true) || (unsafe && (!verified || !formsIdempotency.MatchString(r.Header.Get("Idempotency-Key")))) || (!unsafe && (verified || len(body) != 0)) {
		return errors.New("invalid NetMap gateway request")
	}
	digest := sha256.Sum256(body)
	claims := gatewayIdentity{Version: 2, Audience: "netmap", IssuedAt: now.Unix(), ExpiresAt: now.Unix() + 30, Nonce: randomToken(), Subject: sess.User.ID, Name: sess.User.Name, Admin: true, Scopes: []string{route.scope}, Method: r.Method, URI: r.URL.RequestURI(), ContentType: r.Header.Get("Content-Type"), BodySHA256: hex.EncodeToString(digest[:]), IdempotencyKey: r.Header.Get("Idempotency-Key"), SourceIP: sourceIP, CSRFToken: gatewayServiceCSRF(sess.CSRF, "netmap"), CSRFVerified: verified}
	return writeGatewayIdentity(r, claims, key)
}

func (s *Server) netmapGateway(w http.ResponseWriter, r *http.Request) {
	if s.Modules == nil {
		problem(w, 503, "netmap_unavailable", "Сетевой модуль не подключён")
		return
	}
	(&netmapHandler{server: s, backend: s.Modules, session: s.readSession, slots: netmapSlots, waiting: netmapWaiting}).serve(w, r, "", false)
}
func (s *Server) netmapModuleAPI(w http.ResponseWriter, r *http.Request) {
	if s.Modules == nil {
		problem(w, 503, "netmap_unavailable", "Сетевой модуль не подключён")
		return
	}
	(&netmapHandler{server: s, backend: s.Modules, session: s.readSession, slots: netmapSlots, waiting: netmapWaiting}).serve(w, r, r.PathValue("id"), true)
}

func netmapRequestHeaders(r *http.Request, route netmapRoute, derived string, unsafe bool, public string) (http.Header, bool) {
	// Reconstruct a small header set. Browser identity/assertion/Authorization and
	// forwarding metadata are never copied, even when nominated by Connection.
	selected := http.Header{}
	for name, values := range r.Header {
		if len(values) > 1 || !gatewayString(name, 256, true) {
			return nil, false
		}
		for _, value := range values {
			if !gatewayString(value, 16384, true) {
				return nil, false
			}
		}
	}
	hop := map[string]bool{}
	for _, value := range strings.Split(r.Header.Get("Connection"), ",") {
		hop[http.CanonicalHeaderKey(strings.TrimSpace(value))] = true
	}
	for _, name := range []string{"Accept", "Accept-Language", "If-None-Match"} {
		if !hop[name] && r.Header.Get(name) != "" {
			selected.Set(name, r.Header.Get(name))
		}
	}
	if route.native != "" {
		allowed := map[string]bool{}
		if route.native == "netbox" {
			allowed = map[string]bool{"pl_netbox_sessionid": true, "pl_netbox_csrftoken": true, "pl_netbox_messages": true}
		} else if route.native == "gitea" {
			allowed = map[string]bool{"pl_gitea_session": true, "_csrf": true, "i_like_gitea": true, "redirect_to": true}
		}
		var cookies []string
		seen := map[string]bool{}
		for _, cookie := range r.Cookies() {
			if allowed[cookie.Name] {
				if seen[cookie.Name] || cookie.Valid() != nil {
					return nil, false
				}
				seen[cookie.Name] = true
				if route.native == "netbox" && cookie.Name == "pl_netbox_messages" {
					// Django signs the flash value, so preserve it and restore only
					// its native name after the browser namespace was checked.
					native := *cookie
					native.Name = "messages"
					cookie = &native
				}
				cookies = append(cookies, cookie.String())
			}
		}
		if len(cookies) > 0 && !hop["Cookie"] {
			selected.Set("Cookie", strings.Join(cookies, "; "))
		}
		if value := r.Header.Get("X-CSRFToken"); value != "" && !hop["X-Csrftoken"] {
			selected.Set("X-CSRFToken", value)
		}
		if value := r.Header.Get("X-CSRF-Token"); value != "" && !hop["X-Csrf-Token"] {
			selected.Set("X-Pl-Native-CSRF-Token", value)
		}
		if value := r.Header.Get("Referer"); value != "" && !hop["Referer"] {
			parsed, err := url.Parse(value)
			if err != nil || parsed.User != nil || parsed.Scheme+"://"+parsed.Host != public {
				return nil, false
			}
			selected.Set("Referer", value)
		}
	}
	if unsafe {
		selected.Set("X-CSRF-Token", derived)
		selected.Set("Origin", public)
		selected.Set("Idempotency-Key", r.Header.Get("Idempotency-Key"))
	}
	return selected, true
}

func netmapResponsePolicy(response *http.Response, route netmapRoute, public string) (http.Header, bool) {
	selected := http.Header{}
	if response.StatusCode < 200 || response.StatusCode > 599 || len(response.Header.Values("Content-Type")) != 1 || len(response.Header.Values("Content-Encoding")) != 0 || len(response.Header.Values("Refresh")) != 0 || len(response.Header.Values("WWW-Authenticate")) != 0 {
		return nil, false
	}
	media, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil {
		return nil, false
	}
	if route.native == "" && response.StatusCode != 204 && response.StatusCode != 304 && (media != route.media && !(route.media == "application/javascript" && media == "text/javascript")) {
		return nil, false
	}
	for name, values := range response.Header {
		if !gatewayString(name, 256, true) {
			return nil, false
		}
		for _, value := range values {
			if !gatewayString(value, 8192, true) {
				return nil, false
			}
		}
	}
	for _, name := range []string{"Content-Type", "Cache-Control", "ETag", "Last-Modified", "Content-Disposition", "Vary"} {
		if values := response.Header.Values(name); len(values) > 1 {
			return nil, false
		} else if len(values) == 1 {
			selected.Set(name, values[0])
		}
	}
	locations := response.Header.Values("Location")
	if len(locations) > 1 {
		return nil, false
	}
	if len(locations) == 1 {
		if route.native == "" || response.StatusCode < 300 || response.StatusCode >= 400 {
			return nil, false
		}
		location, err := url.Parse(locations[0])
		origin, _ := url.Parse(public)
		prefix := "/netmap/" + route.native + "/"
		if err != nil || location.User != nil || location.Fragment != "" || location.Opaque != "" || (location.IsAbs() && (location.Scheme != origin.Scheme || location.Host != origin.Host)) || (!location.IsAbs() && location.Host != "") || !strings.HasPrefix(location.Path, prefix) {
			return nil, false
		}
		candidate := &http.Request{Method: "GET", URL: location}
		if _, ok := netmapMatchRoute(candidate); !ok {
			return nil, false
		}
		selected.Set("Location", location.RequestURI())
	} else if response.StatusCode >= 300 && response.StatusCode < 400 && response.StatusCode != 304 {
		return nil, false
	}
	if len(response.Header.Values("Set-Cookie")) > 0 {
		if route.native == "" {
			return nil, false
		}
		prefix := "/netmap/" + route.native + "/"
		cookies := response.Cookies()
		if len(cookies) != len(response.Header.Values("Set-Cookie")) {
			return nil, false
		}
		messageSeen := false
		for _, cookie := range cookies {
			// Django's fallback message storage emits Path=/ even when its
			// session is scoped. Isolate only this known NetBox flash cookie.
			if route.native == "netbox" && cookie.Name == "messages" && cookie.Domain == "" &&
				(cookie.Path == "/" || cookie.Path == prefix || cookie.Path == strings.TrimSuffix(prefix, "/")) {
				cookie.Name, cookie.Path = "pl_netbox_messages", prefix
			}
			if route.native == "netbox" && cookie.Name == "pl_netbox_messages" {
				if messageSeen {
					return nil, false
				}
				messageSeen = true
			}
			if cookie.Name == "portal_session" || cookie.Domain != "" || (cookie.Path != prefix && cookie.Path != strings.TrimSuffix(prefix, "/")) || cookie.Valid() != nil || cookie.RawExpires != "" && cookie.Expires.IsZero() {
				return nil, false
			}
			if strings.HasPrefix(public, "https://") {
				cookie.Secure = true
			}
			selected.Add("Set-Cookie", cookie.String())
		}
	}
	return selected, true
}

// Admission precedes body buffering: at most two requests hold payloads and
// up to sixteen wait without reading their body. Cancellation and the finite
// wait timeout release queue capacity before any application request starts.
func (g *netmapHandler) acquire(ctx context.Context) (func(), bool) {
	if ctx.Err() != nil {
		return nil, false
	}
	select {
	case g.slots <- struct{}{}:
		return func() { <-g.slots }, true
	default:
	}
	waiting := g.waiting
	if waiting == nil {
		waiting = netmapWaiting
	}
	select {
	case waiting <- struct{}{}:
		defer func() { <-waiting }()
	default:
		return nil, false
	}
	timeout := g.waitTimeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	wait, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	select {
	case g.slots <- struct{}{}:
		if wait.Err() != nil {
			<-g.slots
			return nil, false
		}
		return func() { <-g.slots }, true
	case <-wait.Done():
		return nil, false
	}
}

func (g *netmapHandler) serve(w http.ResponseWriter, r *http.Request, id string, mapped bool) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	sess, err := g.session(r)
	if err != nil {
		route, allowed := netmapMatchRoute(r)
		if !mapped && allowed && gatewayDocumentRequest(r) && (route.media == "text/html" || route.native != "") {
			http.Redirect(w, r, "/401?return_to=%2Fnetmap%2F", http.StatusSeeOther)
		} else {
			problem(w, 401, "session_expired", "Войдите в Платформу")
		}
		return
	}
	if !sess.User.Admin {
		problem(w, 403, "forbidden", "Доступ только для администратора")
		return
	}
	original := r
	for name, values := range r.Header {
		if len(values) > 1 || !gatewayString(name, 256, true) {
			problem(w, 400, "netmap_headers", "Некорректные заголовки запроса")
			return
		}
		for _, value := range values {
			if !gatewayString(value, 16384, true) {
				problem(w, 400, "netmap_headers", "Некорректные заголовки запроса")
				return
			}
		}
	}
	if mapped {
		tail := r.PathValue("path")
		if !formsIdempotency.MatchString(id) || tail == "" || strings.ContainsAny(tail, "%\\?#") || strings.HasPrefix(tail, "/") || r.URL.RawPath != "" {
			problem(w, 404, "netmap_route", "Маршрут сетевого модуля недоступен")
			return
		}
		r = r.Clone(r.Context())
		u := *r.URL
		u.Path = "/netmap/api/" + tail
		r.URL = &u
		r.RequestURI = u.RequestURI()
	} else if r.URL.Path == "/netmap" && (r.Method == "GET" || r.Method == "HEAD") && r.URL.RawPath == "" && r.URL.RawQuery == "" && !r.URL.ForceQuery && r.URL.Fragment == "" {
		http.Redirect(w, r, "/netmap/", http.StatusTemporaryRedirect)
		return
	}
	route, ok := netmapMatchRoute(r)
	if !ok || mapped && (route.native != "" || route.scope != "netmap:admin") || r.Header.Get("Upgrade") != "" || r.Header.Get("Content-Encoding") != "" || len(r.TransferEncoding) > 0 {
		problem(w, 404, "netmap_route", "Маршрут сетевого модуля недоступен")
		return
	}
	release, admitted := g.acquire(r.Context())
	if !admitted {
		problem(w, 503, "netmap_busy", "Сетевой модуль занят. Повторите запрос позднее")
		return
	}
	defer release()
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, netmapBodyLimit))
	if err != nil {
		problem(w, 413, "netmap_body_limit", "Запрос превышает 3 МиБ")
		return
	}
	unsafe := r.Method != "GET" && r.Method != "HEAD"
	if !unsafe && len(body) > 0 {
		problem(w, 400, "netmap_body", "Для чтения тело не поддерживается")
		return
	}
	if unsafe {
		if r.Header.Get("Origin") != g.server.Config.PublicURL || len(r.Header.Values("Origin")) != 1 || !g.server.gatewayOrigin(r) {
			problem(w, 403, "csrf", "Запрос не прошёл проверку origin")
			return
		}
		if route.native == "" {
			tokens := r.Header.Values("X-CSRF-Token")
			if len(tokens) != 1 || subtle.ConstantTimeCompare([]byte(tokens[0]), []byte(sess.CSRF)) != 1 {
				problem(w, 403, "csrf", "Запрос не прошёл проверку сессии")
				return
			}
			if !formsJSONType(r.Header.Get("Content-Type")) {
				problem(w, 415, "netmap_content_type", "Ожидается application/json")
				return
			}
			var object map[string]json.RawMessage
			if json.Unmarshal(body, &object) != nil || object == nil {
				problem(w, 400, "netmap_json", "Ожидается JSON object")
				return
			}
			if !formsIdempotency.MatchString(r.Header.Get("Idempotency-Key")) {
				problem(w, 400, "netmap_idempotency", "Ожидается Idempotency-Key в формате UUID")
				return
			}
		} else {
			r = r.Clone(r.Context())
			r.Header = r.Header.Clone()
			r.Header.Set("Idempotency-Key", netmapUUID())
		}
	}
	derived := gatewayServiceCSRF(sess.CSRF, "netmap")
	headers, ok := netmapRequestHeaders(r, route, derived, unsafe, g.server.Config.PublicURL)
	if !ok {
		problem(w, 400, "netmap_headers", "Некорректные заголовки запроса")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	instance, err := g.backend.FindApplication(ctx, "netmap")
	if err != nil || id != "" && id != instance.ID {
		problem(w, 503, "netmap_unavailable", "Сетевой модуль не готов или отключён")
		return
	}
	key, err := g.backend.ApplicationKey(ctx, instance.ID)
	if err != nil {
		problem(w, 503, "netmap_identity", "Не удалось подтвердить модуль")
		return
	}
	defer clear(key)
	out := r.Clone(ctx)
	out.Header = headers
	if !unsafe {
		out.Header.Del("Content-Type")
	} else {
		out.Header.Set("Content-Type", r.Header.Get("Content-Type"))
	}
	if err = signNetmapRequest(out, body, sess, key, time.Now(), unsafe, g.server.loginPeer(original)); err != nil {
		problem(w, 400, "netmap_identity", "Не удалось подписать запрос")
		return
	}
	contentType := out.Header.Get("Content-Type")
	out.Header.Del("Content-Type")
	response, err := g.backend.NetMapRequest(ctx, instance.ID, out.Method, out.URL.Path, out.URL.RawQuery, contentType, out.Header, body)
	if err != nil {
		problem(w, 502, "netmap_source", "Сервис не ответил. Проверьте результат операции перед повтором")
		return
	}
	defer response.Body.Close()
	responseHeaders, ok := netmapResponsePolicy(response, route, g.server.Config.PublicURL)
	if !ok {
		problem(w, 502, "netmap_response_policy", "Сервис вернул неподдерживаемый ответ")
		return
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, netmapResponseLimit+1))
	if err != nil || len(data) > netmapResponseLimit || (route.media == "application/json" && r.Method != "HEAD" && response.StatusCode != 204 && response.StatusCode != 304 && !json.Valid(data)) {
		problem(w, 502, "netmap_response", "Не удалось получить ответ сервиса")
		return
	}
	latest, err := g.session(original.Clone(ctx))
	if err != nil || latest.User.ID != sess.User.ID || !latest.User.Admin || latest.CSRF != sess.CSRF {
		problem(w, 401, "session_expired", "Сессия завершена. Войдите в Платформу и проверьте результат операции")
		return
	}
	current, err := g.backend.FindApplication(ctx, "netmap")
	if err != nil || current.ID != instance.ID || current.Version != instance.Version {
		problem(w, 503, "netmap_unavailable", "Сетевой модуль отключён или изменён")
		return
	}
	if r.Method != http.MethodHead && route.native == "" && route.media == "application/json" {
		if code := modules.NetMapRequestErrorCode(response.StatusCode, data); code != "" {
			problem(w, response.StatusCode, code, netmapRequestErrorMessage(code))
			return
		}
	}
	for name, values := range responseHeaders {
		w.Header().Del(name)
		for _, value := range values {
			w.Header().Add(name, value)
		}
	}
	w.WriteHeader(response.StatusCode)
	if r.Method != "HEAD" {
		_, _ = w.Write(data)
	}
}

func netmapRequestErrorMessage(code string) string {
	switch code {
	case "netmap_snmp_required":
		return "Для опроса сети укажите SNMP community в выбранном профиле. Сохранение SSH-доступа само по себе не запускает поиск устройств."
	case "netmap_network_missing":
		return "Сеть не найдена. Обновите список сетей и повторите действие."
	case "netmap_profile_missing":
		return "Для сети не найден профиль доступа. Выберите профиль и сохраните сеть."
	case "netmap_invalid_network":
		return "Проверьте название сети, CIDR и выбранный профиль. Нужен точный CIDR не более чем на 4096 адресов."
	case "netmap_invalid_profile":
		return "Проверьте поля профиля доступа."
	case "netmap_invalid_observations":
		return "Проверьте источник и записи наблюдений: адреса должны принадлежать выбранной сети, время и MAC должны быть корректными."
	case "netmap_invalid_ssh_trust":
		return "Укажите SSH host key в формате: IP, алгоритм и публичный ключ."
	case "netmap_invalid_model":
		return "Проверьте имя модели Oxidized."
	case "netmap_invalid_snmp_community":
		return "SNMP community содержит недопустимые для конфигурации символы."
	case "netmap_network_limit":
		return "Достигнут лимит: не более 128 сетей."
	case "netmap_profile_limit":
		return "Достигнут лимит: не более 128 профилей доступа."
	case "netmap_poll_running":
		return "Уже выполняется опрос сети. Дождитесь его завершения."
	case "netmap_idempotency_conflict":
		return "Эта операция уже использована с другими параметрами. Обновите данные и повторите действие."
	case "netmap_conflict":
		return "Операция конфликтует с текущим состоянием NetMap. Обновите данные и повторите действие."
	case "netmap_request_failed":
		return "Результат операции NetMap не подтверждён. Проверьте состояние сети и опросов перед повтором."
	default:
		return "NetMap отклонил запрос. Проверьте настройки сети и профиля."
	}
}

func netmapUUID() string {
	raw := sha256.Sum256([]byte(randomToken()))
	raw[6] = (raw[6] & 15) | 64
	raw[8] = (raw[8] & 63) | 128
	v := hex.EncodeToString(raw[:16])
	return v[:8] + "-" + v[8:12] + "-" + v[12:16] + "-" + v[16:20] + "-" + v[20:]
}

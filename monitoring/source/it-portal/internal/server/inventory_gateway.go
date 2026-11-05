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

	"github.com/google/uuid"
)

const inventoryPrefix = "/inventory"
const inventoryUploadLimit = 64 << 20

var inventoryObjectID = regexp.MustCompile(`^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$`)
var inventoryIdempotency = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

func inventoryMatchRoute(r *http.Request) (string, bool) {
	if r.URL.RawPath != "" || r.URL.Fragment != "" || r.URL.ForceQuery || len(r.URL.RawQuery) > 4096 || strings.ContainsAny(r.URL.EscapedPath(), "%\\") || !gatewayString(r.URL.RequestURI(), 4096, true) {
		return "", false
	}
	p := r.URL.Path
	if r.Method == "GET" || r.Method == "HEAD" {
		media := ""
		switch p {
		case "/inventory/":
			media = "text/html"
		case "/inventory/static/platform.css":
			media = "text/css"
		case "/inventory/static/theme-init.js", "/inventory/static/report.js", "/inventory/static/bootstrap.js", "/inventory/static/shared-shell.js":
			media = "application/javascript"
		case "/inventory/api/session", "/inventory/api/imports":
			media = "application/json"
		case "/inventory/api/data", "/inventory/api/software":
			values, err := url.ParseQuery(r.URL.RawQuery)
			if err != nil {
				return "", false
			}
			allowed := map[string]bool{"page": true, "revision": true}
			if strings.HasSuffix(p, "/software") {
				allowed = map[string]bool{"page": true, "limit": true, "search": true, "branch": true, "category": true, "machine": true, "version": true, "evidence": true, "answer": true, "sort": true, "direction": true}
			}
			for key, val := range values {
				if !allowed[key] || len(val) != 1 || !gatewayString(val[0], 512, true) {
					return "", false
				}
			}
			return "application/json", true
		default:
			if tail, found := strings.CutPrefix(p, "/inventory/api/jobs/"); found && inventoryObjectID.MatchString(tail) {
				media = "application/json"
			}
		}
		return media, media != "" && r.URL.RawQuery == ""
	}
	if r.Method != "POST" || r.URL.RawQuery != "" {
		return "", false
	}
	if p == "/inventory/api/imports/preview" {
		return "application/json", true
	}
	if tail, found := strings.CutPrefix(p, "/inventory/api/imports/"); found {
		id, commit := strings.CutSuffix(tail, "/commit")
		if commit && inventoryObjectID.MatchString(id) {
			return "application/json", true
		}
	}
	return "", false
}

type inventoryGateway struct {
	server                *Server
	key                   []byte
	transport             http.RoundTripper
	static, reads         *gatewayCapacity
	readSlots, writeSlots chan struct{}
}

func (s *Server) newInventoryGateway(key []byte, tr http.RoundTripper) http.Handler {
	slots := make(chan struct{}, 4)
	return &inventoryGateway{server: s, key: append([]byte(nil), key...), transport: tr, static: newGatewayStaticCapacity(), reads: newGatewayReadCapacity(slots), readSlots: slots, writeSlots: make(chan struct{}, 1)}
}

func (s *Server) RegisterInventoryRoutes(m *http.ServeMux) {
	if !s.Config.PortableRelease {
		return
	}
	fallback := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		problem(w, 503, "inventory_unavailable", "Inventory не установлен или отключён")
	})
	handler := s.managedApplication("inventory", fallback)
	m.Handle("/inventory", handler)
	m.Handle("/inventory/", handler)
	m.HandleFunc("GET /api/v1/modules/{id}/inventory/settings", s.moduleAuth(s.inventorySettings))
	m.HandleFunc("PUT /api/v1/modules/{id}/inventory/settings", s.moduleAuth(s.inventorySettings))
}

func (s *Server) inventorySettings(w http.ResponseWriter, r *http.Request) {
	password, operation := "", ""
	if r.Method == http.MethodPut {
		var input struct {
			Password    string `json:"archive_password"`
			OperationID string `json:"operation_id"`
		}
		if !decode(w, r, &input) {
			return
		}
		id, err := uuid.Parse(input.OperationID)
		if err != nil || id.String() != input.OperationID || len(input.Password) < 1 || len(input.Password) > 4096 || strings.ContainsRune(input.Password, 0) {
			problem(w, 400, "invalid_inventory_password", "Укажите пароль архива и идентификатор операции")
			return
		}
		password, operation = input.Password, input.OperationID
	}
	status, err := s.Modules.InventorySettings(r.Context(), r.PathValue("id"), password, operation)
	if err != nil {
		problem(w, 503, "inventory_unavailable", "Не удалось подтвердить настройки Inventory")
		return
	}
	respond(w, 200, status)
}

func signInventoryRequest(r *http.Request, body []byte, sess session, key []byte, now time.Time, verified bool, sourceIP string) error {
	unsafe := r.Method == http.MethodPost
	if len(key) != 32 || len(body) > inventoryUploadLimit || !sess.User.Admin || !gatewayString(sess.User.ID, 256, false) || !gatewayString(sess.User.Name, 512, false) || sess.CSRF == "" || net.ParseIP(sourceIP) == nil || !gatewayString(r.Header.Get("Content-Type"), 256, true) || unsafe && (!verified || !inventoryIdempotency.MatchString(r.Header.Get("Idempotency-Key"))) || !unsafe && (len(body) != 0 || verified) {
		return http.ErrNoCookie
	}
	if _, allowed := inventoryMatchRoute(r); !allowed {
		return http.ErrNotSupported
	}
	scope := "inventory:read"
	if unsafe {
		scope = "inventory:write"
	}
	digest := sha256.Sum256(body)
	claims := gatewayIdentity{Version: 2, Audience: "inventory", IssuedAt: now.Unix(), ExpiresAt: now.Unix() + 30, Nonce: randomToken(), Subject: sess.User.ID, Name: sess.User.Name, Admin: true, Scopes: []string{scope}, Method: r.Method, URI: r.URL.RequestURI(), ContentType: r.Header.Get("Content-Type"), BodySHA256: hex.EncodeToString(digest[:]), IdempotencyKey: r.Header.Get("Idempotency-Key"), SourceIP: sourceIP, CSRFToken: gatewayServiceCSRF(sess.CSRF, "inventory"), CSRFVerified: unsafe}
	return writeGatewayIdentity(r, claims, key)
}

func (g *inventoryGateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if _, present := r.Header["Authorization"]; present {
		problem(w, 403, "forbidden", "Inventory доступен через сессию администратора")
		return
	}
	sess, err := g.server.readSession(r)
	if err != nil {
		if errors.Is(err, errADUnavailable) {
			problem(w, 503, "ad_unavailable", "Не удалось проверить доступ через AD. Повторите позднее")
			return
		}
		if gatewayDocumentRequest(r) && (r.URL.Path == "/inventory" || r.URL.Path == "/inventory/") {
			http.Redirect(w, r, "/401?return_to=%2Finventory%2F", http.StatusSeeOther)
		} else {
			problem(w, 401, "session_expired", "Войдите в Платформу")
		}
		return
	}
	if !sess.User.Admin {
		problem(w, 403, "forbidden", "Inventory доступен администратору")
		return
	}
	if r.URL.Path == "/inventory" && (r.Method == "GET" || r.Method == "HEAD") && r.URL.RawPath == "" && r.URL.RawQuery == "" && !r.URL.ForceQuery {
		http.Redirect(w, r, "/inventory/", http.StatusTemporaryRedirect)
		return
	}
	media, allowed := inventoryMatchRoute(r)
	if !allowed || len(r.Header.Values("Upgrade")) > 0 {
		problem(w, 404, "gateway_route", "Этот адрес недоступен через PL")
		return
	}
	unsafe := r.Method == http.MethodPost
	if unsafe {
		select {
		case g.writeSlots <- struct{}{}:
			defer func() { <-g.writeSlots }()
		default:
			problem(w, 503, "inventory_busy", "Другая запись Inventory ещё выполняется")
			return
		}
	} else if strings.HasPrefix(r.URL.Path, "/inventory/static/") {
		if !g.static.acquire(r.Context()) {
			problem(w, 503, "inventory_busy", "Inventory занят. Повторите запрос")
			return
		}
		defer func() { <-g.static.slots }()
	} else {
		if !g.reads.acquire(r.Context()) {
			problem(w, 503, "inventory_busy", "Inventory занят. Повторите запрос")
			return
		}
		defer func() { <-g.readSlots }()
	}
	if len(r.Header.Values("Content-Type")) > 1 || len(r.Header.Values("Content-Encoding")) > 1 || (r.Header.Get("Content-Encoding") != "" && r.Header.Get("Content-Encoding") != "identity") {
		problem(w, 415, "gateway_encoding", "Неподдерживаемые заголовки запроса")
		return
	}
	limit := int64(0)
	if unsafe {
		limit = 4096
		if r.URL.Path == "/inventory/api/imports/preview" {
			// Only an authenticated, admitted Inventory upload receives the larger
			// body-read budget; the core server keeps its short default elsewhere.
			_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(90 * time.Second))
			limit = inventoryUploadLimit
		}
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		problem(w, 413, "inventory_upload_limit", "Запрос превышает допустимый размер")
		return
	}
	derived := gatewayServiceCSRF(sess.CSRF, "inventory")
	if unsafe {
		if !g.server.gatewayOrigin(r) || !gatewayCSRF(r, body, sess.CSRF, derived) {
			problem(w, 403, "csrf", "Запрос не прошёл проверку сессии")
			return
		}
		if len(r.Header.Values("Idempotency-Key")) != 1 || !inventoryIdempotency.MatchString(r.Header.Get("Idempotency-Key")) {
			problem(w, 400, "inventory_idempotency", "Нужен ключ операции")
			return
		}
		kind, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if strings.HasSuffix(r.URL.Path, "/preview") {
			if err != nil || kind != "multipart/form-data" || params["boundary"] == "" || len(params["boundary"]) > 70 {
				problem(w, 415, "inventory_upload_type", "Выберите Excel и ZIP для загрузки")
				return
			}
		} else if err != nil || kind != "application/json" || !json.Valid(body) {
			problem(w, 415, "inventory_commit_type", "Ожидается JSON подтверждения")
			return
		}
		// A large multipart body can arrive after the original permission check.
		// Revalidate before submitting any native mutation, then again on reply.
		current, authErr := g.server.readSession(r)
		if errors.Is(authErr, errADUnavailable) {
			problem(w, 503, "ad_unavailable", "Не удалось проверить доступ через AD. Повторите позднее")
			return
		}
		if authErr != nil || current.User.ID != sess.User.ID || !current.User.Admin || current.CSRF != sess.CSRF {
			problem(w, 401, "session_expired", "Сессия завершена во время загрузки. Войдите в PL")
			return
		}
	}
	sourceIP := g.server.loginPeer(r)
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	out, err := http.NewRequestWithContext(ctx, r.Method, "http://module-inventory"+r.URL.RequestURI(), bytes.NewReader(body))
	if err != nil {
		problem(w, 502, "inventory_request", "Не удалось подготовить запрос")
		return
	}
	out.GetBody = nil
	out.ContentLength = int64(len(body))
	if unsafe {
		out.Header.Set("Content-Type", r.Header.Get("Content-Type"))
		out.Header.Set("Idempotency-Key", r.Header.Get("Idempotency-Key"))
		out.Header.Set("X-CSRF-Token", derived)
	}
	if err = signInventoryRequest(out, body, sess, g.key, time.Now(), unsafe, sourceIP); err != nil {
		problem(w, 503, "inventory_identity", "Не удалось подтвердить доступ")
		return
	}
	response, err := g.transport.RoundTrip(out)
	if err != nil {
		problem(w, 502, "inventory_source", "Inventory не подтвердил результат. Проверьте состояние операции перед повтором")
		return
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 599 || response.StatusCode >= 300 && response.StatusCode < 400 || response.Header.Get("Set-Cookie") != "" || response.Header.Get("WWW-Authenticate") != "" || response.Header.Get("Location") != "" {
		problem(w, 502, "inventory_response", "Неподдерживаемый ответ Inventory")
		return
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, (8<<20)+1))
	kind, _, typeErr := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || len(data) > 8<<20 || typeErr != nil || (kind != media && !(media == "application/javascript" && kind == "text/javascript")) || (media == "application/json" && r.Method != "HEAD" && !json.Valid(data)) {
		problem(w, 502, "inventory_response", "Некорректный ответ Inventory")
		return
	}
	latest, err := g.server.readSession(r.Clone(ctx))
	if errors.Is(err, errADUnavailable) {
		problem(w, 503, "ad_unavailable", "Не удалось проверить доступ через AD. Повторите позднее")
		return
	}
	if err != nil || latest.User.ID != sess.User.ID || !latest.User.Admin || latest.CSRF != sess.CSRF {
		problem(w, 401, "session_expired", "Сессия завершена. Проверьте результат операции после входа")
		return
	}
	w.Header().Set("Content-Type", response.Header.Get("Content-Type"))
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'")
	w.Header().Set("Referrer-Policy", "same-origin")
	w.WriteHeader(response.StatusCode)
	if r.Method != "HEAD" {
		_, _ = w.Write(data)
	}
}

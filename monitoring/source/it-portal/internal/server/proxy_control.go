package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// The origin and key are server configuration. Routes are never client supplied.
type ProxyControlConfig struct {
	Origin    string
	Key       []byte
	Transport http.RoundTripper
}

type proxyModeRequest struct {
	Mode             string `json:"mode"`
	ExpectedRevision *int64 `json:"expected_revision"`
	Reason           string `json:"reason,omitempty"`
}

func proxyModeValid(mode string) bool {
	return mode == "auto" || mode == "relay" || mode == "final185" || mode == "final2"
}

func proxyControlURI(r *http.Request) (string, bool) {
	if r.URL.RawPath != "" || r.Header.Get("Upgrade") != "" {
		return "", false
	}
	switch r.Method + " " + r.URL.Path {
	case "GET /api/v1/proxy-control/status", "POST /api/v1/proxy-control/mode":
		if r.URL.RawQuery != "" {
			return "", false
		}
		return strings.Replace(r.URL.Path, "/proxy-control", "", 1), true
	case "GET /api/v1/proxy-control/history":
		q, err := url.ParseQuery(r.URL.RawQuery)
		if err != nil || len(q) > 1 || len(q["limit"]) > 1 {
			return "", false
		}
		limit := 20
		if value, ok := q["limit"]; ok {
			limit, err = strconv.Atoi(value[0])
			if err != nil || limit < 1 || limit > 50 {
				return "", false
			}
		}
		for k := range q {
			if k != "limit" {
				return "", false
			}
		}
		return "/api/v1/history?limit=" + strconv.Itoa(limit), true
	}
	return "", false
}

func (s *Server) proxyControlHandler() http.HandlerFunc {
	transport := s.Config.ProxyControl.Transport
	if transport == nil {
		transport = &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 2 * time.Second}).DialContext, MaxConnsPerHost: 4, MaxIdleConnsPerHost: 4, IdleConnTimeout: 30 * time.Second, ResponseHeaderTimeout: 5 * time.Second}
	}
	client := &http.Client{Transport: transport, Timeout: 6 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	slots := make(chan struct{}, 4)
	return func(w http.ResponseWriter, r *http.Request) {
		// Defense in depth: this adapter never accepts catalog machine credentials.
		sess := current(r)
		if !sess.User.Admin || sess.User.ID == "" || strings.HasPrefix(sess.User.ID, "machine:") {
			problem(w, 403, "forbidden", "Доступ только администратору")
			return
		}
		uri, ok := proxyControlURI(r)
		if !ok {
			problem(w, 400, "proxy_route", "Некорректный запрос контроллеру")
			return
		}
		if len(s.Config.ProxyControl.Key) != 32 || !validProxyControlOrigin(s.Config.ProxyControl.Origin) {
			problem(w, 503, "proxy_unconfigured", "Контроллер прокси пока не подключён")
			return
		}
		select {
		case slots <- struct{}{}:
			defer func() { <-slots }()
		default:
			problem(w, 503, "proxy_busy", "Контроллер занят. Повторите запрос позднее")
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 8192))
		if err != nil {
			problem(w, 413, "proxy_body_limit", "Запрос слишком большой")
			return
		}
		write := r.Method == http.MethodPost
		if !write && len(body) != 0 {
			problem(w, 400, "proxy_body", "Тело GET запроса не допускается")
			return
		}
		if r.Header.Get("Content-Encoding") != "" && r.Header.Get("Content-Encoding") != "identity" {
			problem(w, 415, "proxy_encoding", "Кодирование запроса не поддерживается")
			return
		}
		if write {
			media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
			if err != nil || media != "application/json" || len(r.Header.Values("Content-Type")) != 1 {
				problem(w, 415, "proxy_content_type", "Ожидается JSON")
				return
			}
			key := r.Header.Get("Idempotency-Key")
			if key == "" || strings.TrimSpace(key) != key || !gatewayString(key, 128, true) || len(r.Header.Values("Idempotency-Key")) != 1 {
				problem(w, 400, "idempotency_required", "Укажите Idempotency-Key")
				return
			}
			var mode proxyModeRequest
			decoder := json.NewDecoder(bytes.NewReader(body))
			decoder.DisallowUnknownFields()
			if decoder.Decode(&mode) != nil || decoder.Decode(new(any)) != io.EOF || !proxyModeValid(mode.Mode) || mode.ExpectedRevision == nil || *mode.ExpectedRevision < 0 || !gatewayString(mode.Reason, 256, false) {
				problem(w, 400, "proxy_mode", "Некорректный режим или revision")
				return
			}
			body, _ = json.Marshal(mode)
		}
		ctx, cancel := context.WithTimeout(r.Context(), 6*time.Second)
		defer cancel()
		out, err := http.NewRequestWithContext(ctx, r.Method, s.Config.ProxyControl.Origin+uri, bytes.NewReader(body))
		if err != nil {
			problem(w, 500, "proxy_request", "Не удалось подготовить запрос")
			return
		}
		out.Header.Set("Accept", "application/json")
		if write {
			out.Header.Set("Content-Type", "application/json")
			out.Header.Set("Idempotency-Key", r.Header.Get("Idempotency-Key"))
			out.Header.Set("X-CSRF-Token", gatewayServiceCSRF(sess.CSRF, "proxy-control"))
		}
		scopes := []string{"proxy:read"}
		if write {
			scopes = []string{"proxy:mode"}
		}
		if err := signGatewayRequest(out, body, sess, "proxy-control", scopes, s.Config.ProxyControl.Key, time.Now(), write, s.loginPeer(r)); err != nil {
			problem(w, 502, "proxy_identity", "Не удалось подписать запрос контроллеру")
			return
		}
		response, err := client.Do(out)
		if err != nil {
			message := "Контроллер прокси недоступен"
			if write {
				message = "Результат переключения неизвестен. Обновите состояние перед повторением."
			}
			code := "proxy_unavailable"
			status := 502
			if errors.Is(err, context.DeadlineExceeded) {
				code = "proxy_timeout"
				status = 504
			}
			problem(w, status, code, message)
			return
		}
		defer response.Body.Close()
		payload, err := io.ReadAll(io.LimitReader(response.Body, (256<<10)+1))
		if err != nil || len(payload) > 256<<10 || !json.Valid(payload) {
			problem(w, 502, "proxy_response", "Контроллер вернул некорректный ответ")
			return
		}
		if response.StatusCode != 200 {
			switch response.StatusCode {
			case 409:
				problem(w, 409, "revision_conflict", "Состояние изменилось. Обновите данные перед повторением.")
			case 400, 422:
				problem(w, 400, "proxy_rejected", "Контроллер отклонил параметры запроса")
			case 503:
				problem(w, 503, "proxy_unavailable", "Контроллер прокси временно недоступен")
			default:
				problem(w, 502, "proxy_upstream", "Не удалось выполнить запрос контроллеру")
			}
			return
		}
		projection, err := proxyControlProjection(uri, payload)
		if err != nil {
			problem(w, 502, "proxy_schema", "Контроллер вернул несовместимые данные")
			return
		}
		if history, ok := projection.(proxyHistory); ok {
			actors := make([]string, 0, len(history.History))
			for _, event := range history.History {
				actors = append(actors, event.Actor)
			}
			names := map[string]string{}
			if s.Store != nil {
				nameCtx, nameCancel := context.WithTimeout(r.Context(), time.Second)
				resolved, err := s.Store.ActorNames(nameCtx, actors)
				nameCancel()
				if err != nil {
					slog.Warn("proxy_history_actor_names_unavailable")
				} else {
					names = resolved
				}
			}
			if sess.User.Name != "" {
				names[sess.User.ID] = sess.User.Name
			}
			for index := range history.History {
				history.History[index].ActorName = names[history.History[index].Actor]
			}
			projection = history
		}
		respond(w, 200, projection)
	}
}

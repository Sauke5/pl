package server

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"regexp"
	"strings"
	"time"
)

type edgeStatus struct {
	Configured bool      `json:"configured"`
	State      string    `json:"state"`
	Version    string    `json:"version,omitempty"`
	ObservedAt time.Time `json:"observed_at"`
}

var edgeVersion = regexp.MustCompile(`^v?[0-9]{1,4}(\.[0-9]{1,4}){1,3}$`)

func (s *Server) edgeStatusHandler(config EdgeConfig) http.HandlerFunc {
	transport := config.transport
	if transport == nil {
		transport = &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 5 * time.Second}).DialContext, TLSHandshakeTimeout: 5 * time.Second, ResponseHeaderTimeout: 5 * time.Second, MaxIdleConnsPerHost: 2, IdleConnTimeout: 30 * time.Second}
	}
	client := &http.Client{Transport: transport, Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		user := current(r).User
		if !user.Admin || user.ID == "" || strings.HasPrefix(user.ID, "machine:") {
			problem(w, 403, "forbidden", "Доступ только администратору")
			return
		}
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			problem(w, 405, "method_not_allowed", "Поддерживается только чтение")
			return
		}
		if r.URL.RawQuery != "" {
			problem(w, 400, "edge_parameters", "Параметры запроса не поддерживаются")
			return
		}
		if config.endpoint == "" || config.token == "" {
			problem(w, 503, "edge_disabled", "Edge не подключён")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, config.endpoint, nil)
		if err != nil {
			problem(w, 503, "edge_unavailable", "Не удалось получить состояние Edge")
			return
		}
		req.Header.Set("Authorization", "Bearer "+config.token)
		req.Header.Set("Accept", "application/json")
		response, err := client.Do(req)
		if err != nil {
			problem(w, 502, "edge_unavailable", "Не удалось получить состояние Edge")
			return
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			problem(w, 502, "edge_unavailable", "Не удалось получить состояние Edge")
			return
		}
		raw, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
		if err != nil || len(raw) > 1<<20 {
			problem(w, 502, "edge_unavailable", "Не удалось получить состояние Edge")
			return
		}
		var payload struct {
			Success bool `json:"success"`
			Obj     *struct {
				Xray *struct {
					State   string `json:"state"`
					Version string `json:"version"`
				} `json:"xray"`
			} `json:"obj"`
		}
		if json.Unmarshal(raw, &payload) != nil || !payload.Success || payload.Obj == nil || payload.Obj.Xray == nil {
			problem(w, 502, "edge_unavailable", "Не удалось получить состояние Edge")
			return
		}
		xray := payload.Obj.Xray
		switch xray.State {
		case "running", "stop", "error":
		default:
			problem(w, 502, "edge_unavailable", "Не удалось получить состояние Edge")
			return
		}
		version := ""
		if edgeVersion.MatchString(xray.Version) {
			version = xray.Version
		}
		respond(w, 200, edgeStatus{Configured: true, State: xray.State, Version: version, ObservedAt: time.Now().UTC()})
	}
}

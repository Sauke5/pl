package server

import (
	"crypto/subtle"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

var reportArchivePath = regexp.MustCompile(`^/reports/infrastructure-(?:\d{4}-\d{2}-\d{2}|weekly-\d{4}-W\d{2})-run-\d+\.html$`)
var silencePath = regexp.MustCompile(`^/alertmanager/api/v2/silence/[0-9a-fA-F-]{36}$`)

// Only nginx's fixed monitoring upstreams use this gate. Internal Docker DNS
// traffic, including scrape, ingestion, delivery, and reload, bypasses nginx.
func monitoringProxyRoute(method, originalURI string) bool {
	if !gatewayString(originalURI, 4096, true) || !strings.HasPrefix(originalURI, "/") || strings.HasPrefix(originalURI, "//") {
		return false
	}
	u, err := url.ParseRequestURI(originalURI)
	if err != nil || u.IsAbs() || u.Host != "" || u.Fragment != "" || u.RawPath != "" || strings.ContainsAny(u.Path, "\\%") || strings.Contains(u.Path, "//") {
		return false
	}
	for _, part := range strings.Split(u.Path, "/") {
		if part == "." || part == ".." {
			return false
		}
	}
	read := method == http.MethodGet || method == http.MethodHead
	if read {
		for _, prefix := range []string{"/grafana/", "/prometheus/", "/alertmanager/", "/snmp-exporter/", "/blackbox/", "/cadvisor/"} {
			if strings.HasPrefix(u.Path, prefix) {
				return true
			}
		}
		if u.Path == "/loki/ready" || u.Path == "/loki/metrics" || u.Path == "/reports/reports.json" || reportArchivePath.MatchString(u.Path) {
			return true
		}
		if strings.HasPrefix(u.Path, "/health/") {
			switch u.Path {
			case "/health/prometheus", "/health/grafana", "/health/alertmanager", "/health/loki", "/health/report-runner", "/health/websites-admin", "/health/monitoring-admin", "/health/dozzle", "/health/cadvisor", "/health/alloy", "/health/proxy-relay", "/health/proxy-final-212", "/health/proxy-final-185", "/health/proxy-final-2":
				return true
			}
		}
	}
	if method == http.MethodPost && u.Path == "/api/reports/run" && u.RawQuery == "" {
		return true
	}
	// Native Grafana still checks its own user and permissions. Portal checks
	// the outer session and request origin before forwarding browser writes.
	if strings.HasPrefix(u.Path, "/grafana/") {
		return method == http.MethodPost || method == http.MethodPut || method == http.MethodPatch || method == http.MethodDelete
	}
	if method == http.MethodPost && strings.HasPrefix(u.Path, "/prometheus/api/v1/") {
		switch u.Path {
		case "/prometheus/api/v1/query", "/prometheus/api/v1/query_range", "/prometheus/api/v1/series", "/prometheus/api/v1/labels":
			return true
		}
	}
	if method == http.MethodPost && u.Path == "/alertmanager/api/v2/silences" {
		return true
	}
	return method == http.MethodDelete && silencePath.MatchString(u.Path)
}

func (s *Server) monitoringProxyAuth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	for _, name := range []string{"X-Original-Method", "X-Original-URI"} {
		if len(r.Header.Values(name)) != 1 {
			w.WriteHeader(http.StatusForbidden)
			return
		}
	}
	if len(r.Header.Values("X-Original-Upgrade")) > 1 {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	method, uri := r.Header.Get("X-Original-Method"), r.Header.Get("X-Original-URI")
	if !monitoringProxyRoute(method, uri) {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	if values := r.Header.Values("Authorization"); len(values) > 0 {
		if len(values) != 1 || r.Header.Get("Cookie") != "" || !strings.HasPrefix(uri, "/grafana/api/") || !s.grafanaBearerValid(r, values[0]) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	sess, err := s.readSession(r)
	if err != nil || !sess.User.Admin {
		if status := s.grafanaNativeProxyAuth(w, r, method, uri); status != 0 {
			w.WriteHeader(status)
			return
		}
	}
	if err != nil {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	if !sess.User.Admin {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	upgrade := r.Header.Get("X-Original-Upgrade")
	if upgrade != "" && (!strings.EqualFold(upgrade, "websocket") || method != http.MethodGet || !strings.HasPrefix(uri, "/grafana/") || !s.gatewayOrigin(r)) {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	if method != http.MethodGet && method != http.MethodHead {
		if !s.gatewayOrigin(r) {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		if uri == "/api/reports/run" {
			tokens := r.Header.Values("X-CSRF-Token")
			if len(tokens) != 1 || sess.CSRF == "" || subtle.ConstantTimeCompare([]byte(tokens[0]), []byte(sess.CSRF)) != 1 {
				w.WriteHeader(http.StatusForbidden)
				return
			}
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) grafanaBearerValid(r *http.Request, authorization string) bool {
	if s.Config.GrafanaTokenVerifyURL == "" || len(authorization) > 8192 || !strings.HasPrefix(authorization, "Bearer ") || len(authorization) <= len("Bearer ") {
		return false
	}
	verify, err := http.NewRequestWithContext(r.Context(), http.MethodGet, s.Config.GrafanaTokenVerifyURL, nil)
	if err != nil {
		return false
	}
	verify.Header.Set("Authorization", authorization)
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DisableKeepAlives = true
	client := &http.Client{
		Timeout:       3 * time.Second,
		Transport:     transport,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	response, err := client.Do(verify)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return false
	}
	var identity struct {
		OrgID int64  `json:"orgId"`
		Login string `json:"login"`
		UID   string `json:"uid"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 8192)).Decode(&identity) != nil {
		return false
	}
	return identity.OrgID > 0 && strings.HasPrefix(identity.Login, "sa-") && identity.UID != ""
}

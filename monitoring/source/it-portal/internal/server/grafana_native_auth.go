package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var grafanaPublicAsset = regexp.MustCompile(`^/grafana/public/[A-Za-z0-9_./-]+\.(?:js|css|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|eot|json|wasm)$`)

func (c Config) grafanaNativeConfigured() bool {
	return c.GrafanaTokenVerifyURL != "" && c.GrafanaNative.Login != "" && c.GrafanaNative.UserID > 0 && c.GrafanaNative.OrgID > 0
}

// The outer monitoring route validator has already rejected escaped/traversal paths.
func grafanaPublicLoginRoute(method string, u *url.URL) bool {
	if method == http.MethodGet || method == http.MethodHead {
		if grafanaPublicAsset.MatchString(u.Path) {
			return true
		}
		if u.Path == "/grafana/login" {
			for key, values := range u.Query() {
				if key != "redirectTo" || len(values) != 1 || !strings.HasPrefix(values[0], "/grafana/") || strings.ContainsAny(values[0], "\r\n\\") {
					return false
				}
			}
			return true
		}
	}
	return method == http.MethodPost && u.Path == "/grafana/login" && u.RawQuery == ""
}

func grafanaSessionCookie(r *http.Request) string {
	var session *http.Cookie
	for _, cookie := range r.Cookies() {
		if cookie.Name != "grafana_session" {
			continue
		}
		if session != nil || cookie.Value == "" || len(cookie.Value) > 4096 || cookie.Valid() != nil {
			return ""
		}
		session = cookie
	}
	if session == nil {
		return ""
	}
	return session.String()
}

// Returns zero when this separately configured Grafana-only fallback does not apply.
// Authentication is performed by fixed Grafana endpoints, never by client identity headers.
func (s *Server) grafanaNativeProxyAuth(w http.ResponseWriter, r *http.Request, method, uri string) int {
	if !s.Config.grafanaNativeConfigured() || !strings.HasPrefix(uri, "/grafana/") {
		return 0
	}
	u, err := url.ParseRequestURI(uri)
	if err != nil {
		return http.StatusForbidden
	}
	public := grafanaPublicLoginRoute(method, u)
	upgrade := r.Header.Get("X-Original-Upgrade")
	if public {
		if upgrade != "" || (method != http.MethodGet && method != http.MethodHead && !s.gatewayOrigin(r)) {
			return http.StatusForbidden
		}
		w.Header().Set("X-PL-Grafana-Mode", "public")
		w.Header().Set("X-PL-Grafana-Org", strconv.FormatInt(s.Config.GrafanaNative.OrgID, 10))
		return http.StatusNoContent
	}
	cookie := grafanaSessionCookie(r)
	if cookie == "" {
		return 0
	}
	if method != http.MethodGet && method != http.MethodHead {
		// Viewer dashboards query through this POST endpoint; administrative writes stay closed.
		if method != http.MethodPost || u.Path != "/grafana/api/ds/query" || !s.gatewayOrigin(r) {
			return http.StatusForbidden
		}
	}
	if upgrade != "" && (!strings.EqualFold(upgrade, "websocket") || method != http.MethodGet || u.Path != "/grafana/api/live/ws" || !s.gatewayOrigin(r)) {
		return http.StatusForbidden
	}
	if !s.grafanaNativeSessionValid(r, cookie) {
		return http.StatusUnauthorized
	}
	w.Header().Set("X-PL-Grafana-Mode", "native")
	w.Header().Set("X-PL-Grafana-Org", strconv.FormatInt(s.Config.GrafanaNative.OrgID, 10))
	w.Header().Set("X-PL-Grafana-Cookie", cookie)
	return http.StatusNoContent
}

func (s *Server) grafanaNativeSessionValid(r *http.Request, cookie string) bool {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DisableKeepAlives = true
	client := &http.Client{Timeout: 3 * time.Second, Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	get := func(endpoint string, out any) bool {
		request, err := http.NewRequestWithContext(r.Context(), http.MethodGet, endpoint, nil)
		if err != nil {
			return false
		}
		request.Header.Set("Cookie", cookie)
		request.Header.Set("Accept", "application/json")
		// Do not pass incoming Authorization, org selection or identity headers.
		response, err := client.Do(request)
		if err != nil {
			return false
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			return false
		}
		body, err := io.ReadAll(io.LimitReader(response.Body, 8193))
		if err != nil || len(body) > 8192 {
			return false
		}
		return json.Unmarshal(body, out) == nil
	}
	// Explicit JSON names preserve Grafana's numeric id/orgId contract.
	var identity struct {
		ID             int64  `json:"id"`
		OrgID          int64  `json:"orgId"`
		Login          string `json:"login"`
		IsGrafanaAdmin *bool  `json:"isGrafanaAdmin"`
	}
	if !get(s.Config.GrafanaTokenVerifyURL, &identity) {
		return false
	}
	expected := s.Config.GrafanaNative
	if identity.ID != expected.UserID || identity.OrgID != expected.OrgID || identity.Login != expected.Login || identity.IsGrafanaAdmin == nil || *identity.IsGrafanaAdmin {
		return false
	}
	var orgs []struct {
		OrgID int64  `json:"orgId"`
		Role  string `json:"role"`
	}
	return get(strings.TrimRight(s.Config.GrafanaTokenVerifyURL, "/")+"/orgs", &orgs) && len(orgs) == 1 && orgs[0].OrgID == expected.OrgID && orgs[0].Role == "Viewer"
}

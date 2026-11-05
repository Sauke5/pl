package modules

import (
	"context"
	"encoding/json"
	"errors"
	"html"
	"io"
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"time"

	"pl/portal/internal/connectorcredentials"
	"pl/portal/internal/model"
	"pl/portal/internal/netguard"
)

var ErrBookStackConnection = errors.New("Wiki недоступна; проверьте адрес, разрешённые IP, TLS и APP_URL BookStack")

var bookstackLoginForm = regexp.MustCompile(`(?is)<form\b[^>]*\baction\s*=\s*["']([^"']*)["']`)

// BookStackConnector is a native HTTP connection, not a remote controller.
// Approval persists only its origin and IPs; no BookStack credentials are used.
type BookStackConnector struct{ guard *netguard.Guard }

func NewBookStackConnector(guard *netguard.Guard) *BookStackConnector {
	return &BookStackConnector{guard: guard}
}

func (c *BookStackConnector) Approve(ctx context.Context, endpoint, publicURL string) (string, map[string]string, error) {
	if c == nil || c.guard == nil {
		return "", nil, ErrBookStackConnection
	}
	publicOrigin, err := connectorcredentials.CanonicalOrigin(publicURL)
	if err != nil || publicOrigin != publicURL {
		return "", nil, ErrBookStackConnection
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	origin, ips, err := c.guard.ApproveConnector(ctx, endpoint)
	if err != nil {
		return "", nil, ErrBookStackConnection
	}
	bound, err := c.guard.BoundOrigin(origin, ips)
	if err != nil {
		return "", nil, ErrBookStackConnection
	}
	u, _ := url.Parse(origin)
	if _, err = bound.Resolve(ctx, u.Hostname()); err != nil {
		return "", nil, ErrBookStackConnection
	}
	encoded, _ := json.Marshal(ips)
	return origin, map[string]string{"connection_origin": origin, "connection_ips": string(encoded), "app_url": publicURL + "/wiki"}, nil
}

// Client validates the saved binding on each use. BoundOrigin re-resolves every
// dial and connects only to the approved numeric addresses. The original URL
// hostname remains the TLS/SNI authority, including with a private trusted CA.
func (c *BookStackConnector) Client(i model.Integration, publicURL string) (*http.Client, error) {
	if c == nil || c.guard == nil || i.Kind != "bookstack" || !i.Enabled || !canonicalID(i.ManagedModuleID) || i.SecretRef != "" || i.Config["module_mode"] != "external" || i.Config["app_url"] != publicURL+"/wiki" {
		return nil, ErrBookStackConnection
	}
	origin, err := connectorcredentials.CanonicalOrigin(i.URL)
	if err != nil || origin != i.URL || origin != i.Config["connection_origin"] {
		return nil, ErrBookStackConnection
	}
	var ips []string
	if json.Unmarshal([]byte(i.Config["connection_ips"]), &ips) != nil {
		return nil, ErrBookStackConnection
	}
	bound, err := c.guard.BoundOrigin(origin, ips)
	if err != nil {
		return nil, ErrBookStackConnection
	}
	client := bound.Client(60 * time.Second)
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return client, nil
}

func (c *BookStackConnector) Probe(ctx context.Context, i model.Integration, publicURL string) (Observation, error) {
	out := Observation{Endpoint: i.URL}
	client, err := c.Client(i, publicURL)
	if err != nil {
		return out, err
	}
	defer client.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, i.URL+"/status", nil)
	if err != nil {
		return out, ErrBookStackConnection
	}
	public, err := url.Parse(publicURL)
	if err != nil {
		return out, ErrBookStackConnection
	}
	request.Host = public.Host
	request.Header.Set("Accept", "application/json")
	request.Header.Set("X-Forwarded-Host", public.Host)
	request.Header.Set("X-Forwarded-Proto", public.Scheme)
	response, err := client.Do(request)
	if err != nil {
		return out, ErrBookStackConnection
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	var health struct {
		Database bool `json:"database"`
		Cache    bool `json:"cache"`
		Session  bool `json:"session"`
	}
	if err != nil || response.StatusCode != http.StatusOK || len(body) > 65536 || json.Unmarshal(body, &health) != nil || !health.Database || !health.Cache || !health.Session {
		return out, ErrBookStackConnection
	}
	response.Body.Close()
	// /status cannot confirm APP_URL. The native login form must target Pl's
	// exact /wiki/login route before the connection is advertised as running.
	login := request.Clone(ctx)
	login.URL, _ = url.Parse(i.URL + "/login")
	login.Header.Set("Accept", "text/html")
	page, err := client.Do(login)
	if err != nil {
		return out, ErrBookStackConnection
	}
	defer page.Body.Close()
	loginBody, err := io.ReadAll(io.LimitReader(page.Body, (2<<20)+1))
	contentType, _, typeErr := mime.ParseMediaType(page.Header.Get("Content-Type"))
	if err != nil || page.StatusCode != http.StatusOK || len(loginBody) > 2<<20 || typeErr != nil || contentType != "text/html" {
		return out, ErrBookStackConnection
	}
	confirmed := false
	for _, match := range bookstackLoginForm.FindAllSubmatch(loginBody, -1) {
		if html.UnescapeString(string(match[1])) == publicURL+"/wiki/login" {
			confirmed = true
		}
	}
	if !confirmed {
		return out, ErrBookStackConnection
	}
	out.State = "running"
	return out, nil
}

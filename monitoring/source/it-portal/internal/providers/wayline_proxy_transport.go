package providers

import (
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/netguard"
)

// WaylineProxyTransport is a dedicated, bounded transport for the portal's fixed
// Wayline route allowlist. It deliberately supports the manual 210-second check
// contract; ordinary provider clients retain their shorter header timeout.
func (r *Registry) WaylineProxyTransport(i model.Integration) (http.RoundTripper, error) {
	if i.Enabled && i.Kind == "wayline" && i.ManagedModuleID != "" && i.Config["module_mode"] == "local" && r.ManagedRequest != nil {
		return managedWaylineTransport{registry: r, integration: i}, nil
	}
	if r.guard == nil || !i.Enabled || i.Kind != "wayline" {
		return nil, errors.New("Wayline is unavailable")
	}
	base, err := url.Parse(i.URL)
	if err != nil || base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return nil, errors.New("invalid Wayline URL")
	}
	if err = r.guard.ValidateURL(base); err != nil {
		return nil, err
	}
	password, err := secret(i.SecretRef)
	if err != nil {
		return nil, err
	}
	username := i.Config["basic_username"]
	if (username == "") != (password == "") || strings.ContainsAny(username, ":\r\n") {
		return nil, errors.New("invalid Wayline credentials")
	}
	t := &http.Transport{Proxy: nil, DialContext: r.guard.DialContext, TLSClientConfig: r.guard.TLSConfig(), TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 220 * time.Second, MaxResponseHeaderBytes: 64 << 10, DisableKeepAlives: true}
	return waylineProxyTransport{guard: r.guard, transport: t, origin: *base, username: username, password: password}, nil
}

type waylineProxyTransport struct {
	guard              *netguard.Guard
	transport          *http.Transport
	origin             url.URL
	username, password string
}

func (t waylineProxyTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Scheme != t.origin.Scheme || r.URL.Host != t.origin.Host || !strings.HasPrefix(r.URL.Path, strings.TrimRight(t.origin.Path, "/")+"/") {
		return nil, netguard.ErrPolicyDenied
	}
	if err := t.guard.ValidateURL(r.URL); err != nil {
		return nil, err
	}
	out := r.Clone(r.Context())
	// Defense in depth: credentials can never come from the browser.
	out.Header.Del("Authorization")
	out.Header.Del("Cookie")
	out.Header.Del("X-CSRF-Token")
	out.Header.Del("Proxy-Authorization")
	if t.username != "" {
		out.SetBasicAuth(t.username, t.password)
	}
	return t.transport.RoundTrip(out)
}

type managedWaylineTransport struct {
	registry    *Registry
	integration model.Integration
}

func (t managedWaylineTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	var body []byte
	if req.Body != nil {
		var err error
		body, err = io.ReadAll(io.LimitReader(req.Body, (256<<10)+1))
		if err != nil || len(body) > 256<<10 {
			return nil, errors.New("Wayline request too large")
		}
	}
	return t.registry.ManagedRequest(req.Context(), t.integration, req.Method, req.URL.Path, req.URL.RawQuery, req.Header.Get("Content-Type"), body)
}

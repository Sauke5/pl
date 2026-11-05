package providers

import (
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"pl/portal/internal/netguard"
)

// ServiceGatewayTransport is bound to one configured origin and path prefix.
// No browser input can select another destination or extend the request budget.
func (r *Registry) ServiceGatewayTransport(upstream string) (http.RoundTripper, error) {
	if r.guard == nil {
		return nil, errors.New("gateway transport unavailable")
	}
	base, err := url.Parse(upstream)
	if err != nil || base.User != nil || base.RawQuery != "" || base.Fragment != "" || base.RawPath != "" || (strings.TrimRight(base.Path, "/") != "/admin" && strings.TrimRight(base.Path, "/") != "/websites" && strings.TrimRight(base.Path, "/") != "/directory" && strings.TrimRight(base.Path, "/") != "/audit" && strings.TrimRight(base.Path, "/") != "/audit-arch") {
		return nil, errors.New("invalid gateway upstream")
	}
	if err = r.guard.ValidateURL(base); err != nil {
		return nil, err
	}
	return serviceGatewayTransport{guard: r.guard, origin: *base, transport: &http.Transport{Proxy: nil, DialContext: r.guard.DialContext, TLSClientConfig: r.guard.TLSConfig(), TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 130 * time.Second, MaxResponseHeaderBytes: 64 << 10, DisableKeepAlives: true}}, nil
}

type serviceGatewayTransport struct {
	guard     *netguard.Guard
	origin    url.URL
	transport *http.Transport
}

func (t serviceGatewayTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Scheme != t.origin.Scheme || r.URL.Host != t.origin.Host || !strings.HasPrefix(r.URL.Path, strings.TrimRight(t.origin.Path, "/")+"/") || r.URL.RawPath != "" || strings.ContainsAny(r.URL.EscapedPath(), "%\\") || strings.Contains(r.URL.Path, "//") {
		return nil, netguard.ErrPolicyDenied
	}
	for _, part := range strings.Split(r.URL.Path, "/") {
		if part == "." || part == ".." {
			return nil, netguard.ErrPolicyDenied
		}
	}
	if err := t.guard.ValidateURL(r.URL); err != nil {
		return nil, err
	}
	return t.transport.RoundTrip(r)
}

package modules

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"pl/portal/internal/connectorcredentials"
	"pl/portal/internal/model"
	"pl/portal/internal/netguard"
	"pl/portal/internal/store"
)

var ErrNetMapConnection = errors.New("NetMap недоступен; проверьте URL, gateway key, разрешённые IP, TLS и публичный origin Pl")
var netMapVersion = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)

type NetMapCredentialResolver func(context.Context, model.Integration) ([]byte, *netguard.Guard, error)

// NetMapConnector transports only signed adapter requests; it has no remote
// lifecycle, Docker, SSH, global bearer or fallback to an unsigned native API.
type NetMapConnector struct {
	guard      *netguard.Guard
	credential NetMapCredentialResolver
}

func NewNetMapConnector(guard *netguard.Guard, credential NetMapCredentialResolver) *NetMapConnector {
	if guard == nil || credential == nil {
		return nil
	}
	return &NetMapConnector{guard: guard, credential: credential}
}

func NetMapGatewayKey(value string) ([]byte, error) {
	if len(value) != 64 {
		return nil, ErrNetMapConnection
	}
	key, err := hex.DecodeString(value)
	if err != nil || len(key) != 32 {
		return nil, ErrNetMapConnection
	}
	return key, nil
}

func netMapHTTPSOrigin(value string) (string, error) {
	origin, err := connectorcredentials.CanonicalOrigin(value)
	if err != nil || !strings.HasPrefix(origin, "https://") {
		return "", ErrNetMapConnection
	}
	return origin, nil
}

func (c *NetMapConnector) Approve(ctx context.Context, endpoint, publicURL string, key []byte) (string, []string, error) {
	if c == nil || c.guard == nil || c.credential == nil || len(key) != 32 {
		return "", nil, ErrNetMapConnection
	}
	public, err := netMapHTTPSOrigin(publicURL)
	if err != nil || public != publicURL {
		return "", nil, ErrNetMapConnection
	}
	origin, err := netMapHTTPSOrigin(endpoint)
	if err != nil || origin == public {
		return "", nil, ErrNetMapConnection
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	origin, ips, err := c.guard.ApproveConnector(ctx, origin)
	if err != nil {
		return "", nil, ErrNetMapConnection
	}
	bound, err := c.guard.BoundOrigin(origin, ips)
	if err != nil {
		return "", nil, ErrNetMapConnection
	}
	if _, err = netMapProbe(ctx, bound, origin, public, key); err != nil {
		return "", nil, err
	}
	return origin, ips, nil
}

func (c *NetMapConnector) connection(ctx context.Context, i model.Integration, publicURL string) ([]byte, *netguard.Guard, error) {
	if c == nil || c.credential == nil || i.Kind != "netmap" || !i.Enabled || !canonicalID(i.ID) || !canonicalID(i.ManagedModuleID) || i.SecretRef != "managed:"+i.ID || i.Config["module_mode"] != "external" || i.Config["platform_origin"] != publicURL {
		return nil, nil, ErrNetMapConnection
	}
	origin, err := netMapHTTPSOrigin(i.URL)
	if err != nil || origin != i.URL {
		return nil, nil, ErrNetMapConnection
	}
	public, err := netMapHTTPSOrigin(publicURL)
	if err != nil || public != publicURL || origin == public {
		return nil, nil, ErrNetMapConnection
	}
	key, bound, err := c.credential(ctx, i)
	if err != nil || len(key) != 32 || bound == nil {
		clear(key)
		return nil, nil, ErrNetMapConnection
	}
	return key, bound, nil
}

func (c *NetMapConnector) Key(ctx context.Context, i model.Integration, publicURL string) ([]byte, error) {
	key, _, err := c.connection(ctx, i, publicURL)
	return key, err
}

func (c *NetMapConnector) Probe(ctx context.Context, i model.Integration, publicURL string) (Observation, error) {
	key, bound, err := c.connection(ctx, i, publicURL)
	if err != nil {
		return Observation{}, err
	}
	defer clear(key)
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	return netMapProbe(ctx, bound, i.URL, publicURL, key)
}

// A service identity may read only these two routes. Browser identities/scopes
// continue to be signed by netmap_gateway.go, after Pl session/CSRF validation.
func netMapProbeHeaders(path string, key []byte) (http.Header, error) {
	if len(key) != 32 || (path != "/netmap/api/instance" && path != "/netmap/api/health") {
		return nil, ErrNetMapConnection
	}
	nonce, csrf := make([]byte, 24), make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		return nil, ErrNetMapConnection
	}
	if _, err := rand.Read(csrf); err != nil {
		return nil, ErrNetMapConnection
	}
	now := time.Now().Unix()
	body := sha256.Sum256(nil)
	claims := map[string]any{"v": 2, "aud": "netmap", "iat": now, "exp": now + 30,
		"nonce": base64.RawURLEncoding.EncodeToString(nonce), "sub": "service:netmap-probe", "name": "Pl NetMap readiness",
		"admin": false, "scopes": []string{"netmap:read"}, "method": "GET", "uri": path, "content_type": "",
		"body_sha256": hex.EncodeToString(body[:]), "idempotency_key": "", "source_ip": "127.0.0.1",
		"csrf_token": base64.RawURLEncoding.EncodeToString(csrf), "csrf_verified": false}
	raw, err := json.Marshal(claims)
	if err != nil {
		return nil, ErrNetMapConnection
	}
	assertion := base64.RawURLEncoding.EncodeToString(raw)
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte("pl-gateway-v2\n" + assertion))
	return http.Header{"X-Pl-Gateway-Assertion": {assertion}, "X-Pl-Gateway-Signature": {base64.RawURLEncoding.EncodeToString(mac.Sum(nil))}, "Accept": {"application/json"}}, nil
}

func netMapProbe(ctx context.Context, bound *netguard.Guard, origin, publicURL string, key []byte) (Observation, error) {
	out := Observation{Endpoint: origin}
	client := bound.Client(20 * time.Second)
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	defer client.CloseIdleConnections()
	var descriptor struct {
		Module         string `json:"module"`
		Protocol       string `json:"protocol"`
		Version        string `json:"version"`
		PlatformOrigin string `json:"platform_origin"`
	}
	for _, path := range []string{"/netmap/api/instance", "/netmap/api/health"} {
		headers, err := netMapProbeHeaders(path, key)
		if err != nil {
			return out, err
		}
		request, _ := http.NewRequestWithContext(ctx, http.MethodGet, origin+path, nil)
		request.Header = headers
		response, err := client.Do(request)
		if err != nil {
			return out, ErrNetMapConnection
		}
		raw, readErr := io.ReadAll(io.LimitReader(response.Body, 8193))
		response.Body.Close()
		if readErr != nil || response.StatusCode != http.StatusOK || len(raw) > 8192 || !strings.HasPrefix(response.Header.Get("Content-Type"), "application/json") {
			return out, ErrNetMapConnection
		}
		if path == "/netmap/api/instance" {
			decoder := json.NewDecoder(bytes.NewReader(raw))
			decoder.DisallowUnknownFields()
			if decoder.Decode(&descriptor) != nil || decoder.Decode(new(any)) != io.EOF || descriptor.Module != "netmap" || descriptor.Protocol != "pl-gateway-v2" || !netMapVersion.MatchString(descriptor.Version) || descriptor.PlatformOrigin != publicURL {
				return out, ErrNetMapConnection
			}
		} else {
			var health struct {
				Status       string `json:"status"`
				SourcesOK    int    `json:"sources_ok"`
				SourcesTotal int    `json:"sources_total"`
			}
			if json.Unmarshal(raw, &health) != nil || health.Status != "ok" || health.SourcesOK != 1 || health.SourcesTotal != 1 {
				return out, ErrNetMapConnection
			}
		}
	}
	out.State, out.Version = "running", descriptor.Version
	return out, nil
}

func (m *Manager) externalNetMapIntegration(ctx context.Context, v model.ModuleInstance) (model.Integration, error) {
	if m == nil || m.Store == nil || m.NetMap == nil || v.ModuleID != "netmap" || v.Mode != "external" || v.DesiredState != "enabled" || !canonicalID(v.IntegrationID) {
		return model.Integration{}, ErrApplicationUnavailable
	}
	i, err := store.Get[model.Integration](ctx, m.Store, "integration", v.IntegrationID)
	if err != nil || i.ManagedModuleID != v.ID || i.Kind != "netmap" || !i.Enabled || i.URL != v.Endpoint || i.SecretRef != "managed:"+i.ID || i.Config["module_mode"] != "external" {
		return model.Integration{}, ErrApplicationUnavailable
	}
	return i, nil
}

func (c *NetMapConnector) Request(ctx context.Context, i model.Integration, publicURL, method, path, query, contentType string, headers http.Header, body []byte) (*http.Response, error) {
	selected, err := netMapWireRequest(i.ManagedModuleID, method, path, query, contentType, headers, body)
	if err != nil {
		return nil, err
	}
	key, bound, err := c.connection(ctx, i, publicURL)
	if err != nil {
		return nil, err
	}
	validSignature := netMapSignedWire(key, method, path, query, contentType, selected, body)
	clear(key)
	if !validSignature {
		return nil, ErrApplicationUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	uri := i.URL + path
	if query != "" {
		uri += "?" + query
	}
	request, err := http.NewRequestWithContext(ctx, method, uri, bytes.NewReader(body))
	if err != nil {
		return nil, ErrApplicationUnavailable
	}
	request.GetBody = nil // Mutations are never replayed by an HTTP client.
	for name, value := range selected {
		request.Header.Set(name, value)
	}
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	request.Header.Set("Accept-Encoding", "identity")
	client := bound.Client(45 * time.Second)
	defer client.CloseIdleConnections()
	// RoundTrip returns redirects unchanged; signed requests never follow them.
	response, err := client.Transport.RoundTrip(request)
	if err != nil {
		return nil, ErrNetMapConnection
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, netMapResponseLimit+1))
	responseContentType := "application/octet-stream"
	if values := response.Header.Values("Content-Type"); len(values) != 0 {
		if len(values) != 1 || !readContentType(values[0]) {
			return nil, ErrApplicationUnavailable
		}
		responseContentType = values[0]
	}
	if err != nil || len(raw) > netMapResponseLimit || response.StatusCode < 200 || response.StatusCode > 599 || method == "HEAD" && len(raw) != 0 {
		return nil, ErrApplicationUnavailable
	}
	out := bufferedResponse(response.StatusCode, responseContentType, raw)
	for name, values := range response.Header {
		canonical := http.CanonicalHeaderKey(name)
		if !netMapResponseHeaders[canonical] {
			continue
		}
		if canonical != "Set-Cookie" && len(values) != 1 {
			return nil, ErrApplicationUnavailable
		}
		for _, value := range values {
			if !netMapWireString(value, 8192) {
				return nil, ErrApplicationUnavailable
			}
			out.Header.Add(canonical, value)
		}
	}
	return out, nil
}

// The transport may forward an already authorized browser signature, never
// repurpose it for another method, URI, body or idempotency key.
func netMapSignedWire(key []byte, method, path, query, contentType string, headers map[string]string, body []byte) bool {
	assertion := headers["X-Pl-Gateway-Assertion"]
	if len(assertion) == 0 || len(assertion) > 8192 || len(key) != 32 {
		return false
	}
	signature, err := base64.RawURLEncoding.Strict().DecodeString(headers["X-Pl-Gateway-Signature"])
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte("pl-gateway-v2\n" + assertion))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return false
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(assertion)
	if err != nil {
		return false
	}
	var claims struct {
		Version        int    `json:"v"`
		Audience       string `json:"aud"`
		Method         string `json:"method"`
		URI            string `json:"uri"`
		ContentType    string `json:"content_type"`
		BodySHA256     string `json:"body_sha256"`
		IdempotencyKey string `json:"idempotency_key"`
	}
	if json.Unmarshal(raw, &claims) != nil {
		return false
	}
	uri := path
	if query != "" {
		uri += "?" + query
	}
	digest := sha256.Sum256(body)
	return claims.Version == 2 && claims.Audience == "netmap" && claims.Method == method && claims.URI == uri && claims.ContentType == contentType && claims.BodySHA256 == hex.EncodeToString(digest[:]) && claims.IdempotencyKey == headers["Idempotency-Key"]
}

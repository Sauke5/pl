package modules

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type Resolver interface {
	LookupIPAddr(context.Context, string) ([]net.IPAddr, error)
}
type PrometheusProbe struct {
	resolver Resolver
	dial     func(context.Context, string, string) (net.Conn, error)
}

func NewPrometheusProbe() *PrometheusProbe {
	return &PrometheusProbe{resolver: net.DefaultResolver, dial: (&net.Dialer{Timeout: 5 * time.Second}).DialContext}
}

// ValidateEndpoint accepts a base URL only. The caller cannot select methods,
// API routes, query strings, credentials, redirects or a proxy environment.
func ValidateEndpoint(raw string) (string, error) {
	if len(raw) > 2048 || strings.TrimSpace(raw) != raw {
		return "", errors.New("Укажите HTTP(S) адрес Prometheus")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", errors.New("Некорректный адрес Prometheus")
	}
	if (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" {
		return "", errors.New("Нужен HTTP(S) адрес без логина, параметров и фрагмента")
	}
	if strings.ContainsAny(u.Hostname(), "/%@\\\x00") || strings.Contains(u.Path, "..") || strings.Contains(u.EscapedPath(), "%") {
		return "", errors.New("Некорректный базовый путь Prometheus")
	}
	if u.Port() != "" {
		p, e := strconv.Atoi(u.Port())
		if e != nil || p < 1 || p > 65535 {
			return "", errors.New("Некорректный порт")
		}
	}
	if ip := net.ParseIP(u.Hostname()); ip != nil && !allowedIP(ip) {
		return "", errors.New("Loopback, metadata и служебные адреса недопустимы")
	}
	u.Path = strings.TrimRight(u.Path, "/")
	return u.String(), nil
}
func allowedIP(ip net.IP) bool {
	if !ip.IsGlobalUnicast() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	for _, v := range []string{"100.100.100.200", "168.63.129.16"} {
		if ip.Equal(net.ParseIP(v)) {
			return false
		}
	}
	// IPv4 0/8 and IPv4-compatible IPv6 are not valid application destinations.
	if v := ip.To4(); v != nil && v[0] == 0 {
		return false
	}
	return true
}
func (p *PrometheusProbe) client(ctx context.Context, endpoint string) (string, *http.Client, func(), error) {
	normalized, err := ValidateEndpoint(endpoint)
	if err != nil {
		return "", nil, nil, err
	}
	u, _ := url.Parse(normalized)
	addrs, err := p.resolver.LookupIPAddr(ctx, u.Hostname())
	if err != nil || len(addrs) == 0 {
		return "", nil, nil, errors.New("Не удалось разрешить адрес Prometheus")
	}
	for _, a := range addrs {
		if !allowedIP(a.IP) {
			return "", nil, nil, errors.New("DNS вернул запрещённый служебный адрес")
		}
	}
	port := u.Port()
	if port == "" {
		port = "80"
		if u.Scheme == "https" {
			port = "443"
		}
	}
	tr := &http.Transport{Proxy: nil, DisableKeepAlives: true, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}, TLSHandshakeTimeout: 5 * time.Second, ResponseHeaderTimeout: 8 * time.Second, MaxResponseHeaderBytes: 32768, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		// Resolve exactly once per probe; TLS still verifies the original hostname.
		var last error
		for _, a := range addrs {
			conn, e := p.dial(ctx, "tcp", net.JoinHostPort(a.IP.String(), port))
			if e == nil {
				return conn, nil
			}
			last = e
		}
		return nil, last
	}}
	client := &http.Client{Transport: tr, Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect denied") }}
	return normalized, client, tr.CloseIdleConnections, nil
}

func (p *PrometheusProbe) Probe(ctx context.Context, endpoint string) (Observation, error) {
	out := Observation{Endpoint: endpoint}
	normalized, client, closeClient, err := p.client(ctx, endpoint)
	if err != nil {
		return out, err
	}
	defer closeClient()
	get := func(path string) ([]byte, error) {
		req, e := http.NewRequestWithContext(ctx, "GET", normalized+path, nil)
		if e != nil {
			return nil, e
		}
		res, e := client.Do(req)
		if e != nil {
			return nil, errors.New("Prometheus недоступен; проверьте адрес, TLS и сетевой доступ")
		}
		defer res.Body.Close()
		if res.StatusCode != 200 {
			return nil, fmt.Errorf("Prometheus вернул HTTP %d; поддерживается API без аутентификации", res.StatusCode)
		}
		data, e := io.ReadAll(io.LimitReader(res.Body, 2<<20+1))
		if e != nil || len(data) > 2<<20 {
			return nil, errors.New("Ответ Prometheus превышает допустимый размер")
		}
		return data, nil
	}
	if _, err = get("/-/ready"); err != nil {
		return out, err
	}
	b, err := get("/api/v1/status/buildinfo")
	if err != nil {
		return out, err
	}
	var build struct {
		Status string `json:"status"`
		Data   struct {
			Version string `json:"version"`
		} `json:"data"`
	}
	if json.Unmarshal(b, &build) != nil || build.Status != "success" || build.Data.Version == "" || len(build.Data.Version) > 128 {
		return out, errors.New("Источник не подтвердил Prometheus buildinfo")
	}
	b, err = get("/api/v1/targets")
	if err != nil {
		return out, err
	}
	var targets struct {
		Status string `json:"status"`
		Data   struct {
			ActiveTargets *[]struct {
				Health string `json:"health"`
			} `json:"activeTargets"`
		} `json:"data"`
	}
	if json.Unmarshal(b, &targets) != nil || targets.Status != "success" || targets.Data.ActiveTargets == nil {
		return out, errors.New("Источник не подтвердил список целей Prometheus")
	}
	out.Version = build.Data.Version
	out.State = "running"
	out.TargetsTotal = len(*targets.Data.ActiveTargets)
	for _, target := range *targets.Data.ActiveTargets {
		if target.Health == "up" {
			out.TargetsUp++
		}
	}
	return out, nil
}

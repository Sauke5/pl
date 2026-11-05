package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"pl/portal/internal/netguard"
	"regexp"
	"strings"
	"time"
)

var icmpHost = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,252}$`)
var (
	ErrICMPBusy        = errors.New("icmp_busy")
	ErrICMPUnavailable = errors.New("icmp_unavailable")
	ErrICMPIncomplete  = errors.New("icmp_incomplete")
)

func ValidateICMPTarget(target string) error {
	target = strings.TrimSpace(target)
	if ip := net.ParseIP(target); ip != nil {
		if ip.To4() != nil {
			return nil
		}
	} else if icmpHost.MatchString(target) {
		return nil
	}
	return errors.New("Укажите один IPv4-адрес или hostname, без URL, порта и параметров")
}

func (r *Registry) SetICMPExecutor(endpoint string)    { r.icmpExecutorURL = endpoint }
func (r *Registry) SetICMPGuard(guard *netguard.Guard) { r.icmpGuard = guard }

func (r *Registry) icmpCheck(ctx context.Context, target string) (map[string]any, error) {
	target = strings.TrimSpace(target)
	if err := ValidateICMPTarget(target); err != nil {
		return nil, err
	}
	u, err := url.Parse(r.icmpExecutorURL)
	if err != nil || u.Scheme != "unix" || u.Host != "" || !filepath.IsAbs(u.Path) || u.RawQuery != "" || u.Fragment != "" {
		return nil, ErrICMPUnavailable
	}
	if r.icmpGuard == nil {
		return nil, ErrICMPUnavailable
	}
	ips, err := r.icmpGuard.ResolveNetworkTarget(ctx, target)
	if err != nil {
		return nil, classifyEndpointError(err)
	}
	var address string
	for _, ip := range ips {
		if ip.To4() != nil {
			address = ip.String()
			break
		}
	}
	if address == "" {
		return nil, ErrPolicyDenied
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	body, _ := json.Marshal(map[string]string{"target": address})
	req, err := http.NewRequestWithContext(ctx, "POST", "http://icmp/v1/icmp", bytes.NewReader(body))
	if err != nil {
		return nil, ErrICMPUnavailable
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{DisableKeepAlives: true, DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", u.Path)
	}}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		return nil, ErrICMPUnavailable
	}
	code := resp.StatusCode
	// Preserve bounded partial output from an interrupted probe in the job details.
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, (4<<20)+1))
	out := map[string]any{}
	if err != nil || len(data) > 4<<20 || json.Unmarshal(data, &out) != nil {
		return nil, ErrICMPIncomplete
	}
	if raw, exists := out["raw_output"]; exists {
		if value, ok := raw.(string); !ok || len(value) > 1<<20 {
			return nil, ErrICMPIncomplete
		}
	}
	out["target"] = target
	out["observed_at"] = time.Now().UTC().Format(time.RFC3339Nano)
	if code == 429 {
		return out, ErrICMPBusy
	}
	if code == 403 {
		return out, ErrPolicyDenied
	}
	if code == 503 {
		return out, ErrICMPUnavailable
	}
	if code != 200 {
		return out, ErrICMPIncomplete
	}
	raw, ok := out["raw_output"].(string)
	if !ok || len(raw) == 0 || len(raw) > 1<<20 || out["scanned_address"] != address || out["count"] != float64(2000) || out["interval_us"] != float64(2000) || out["transmitted"] != float64(2000) {
		return nil, ErrICMPIncomplete
	}
	received, ok := out["received"].(float64)
	loss, valid := out["loss_percent"].(float64)
	if !ok || received < 0 || received > 2000 || math.Trunc(received) != received || !valid || math.Abs(loss-(2000-received)/20) > 0.001 {
		return nil, ErrICMPIncomplete
	}
	return out, nil
}

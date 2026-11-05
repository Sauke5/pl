package providers

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"net/url"
	"pl/portal/internal/model"
	"pl/portal/internal/netguard"
	"regexp"
	"strconv"
	"strings"
	"time"
)

func param(j model.Job, k string) string { v, _ := j.Parameters[k].(string); return v }
func (r *Registry) Execute(ctx context.Context, j model.Job, resource *model.Resource, integration *model.Integration) (map[string]any, error) {
	switch j.Kind {
	case "check", "enrich":
		target := param(j, "target")
		if strings.TrimSpace(target) == "" && resource != nil {
			target = ResourceCheckTarget(*resource)
			if j.Kind == "enrich" {
				target = resource.URL
			}
		}
		if j.Kind == "enrich" {
			out, err := r.enrich(ctx, target)
			return out, classifyEndpointError(err)
		}
		kind := param(j, "kind")
		if kind == "" && resource != nil {
			kind = resource.Check.Kind
		}
		if kind == "" {
			kind = "http"
		}
		if err := ValidateCheckTarget(kind, target); err != nil {
			return nil, err
		}
		if kind == "icmp" {
			return r.icmpCheck(ctx, target)
		}
		if kind == "iperf" {
			out, err := r.iperfCheck(ctx, target, j.Parameters)
			return out, classifyEndpointError(err)
		}
		out, err := r.check(ctx, kind, target)
		return out, classifyEndpointError(err)
	case "report":
		if integration == nil || integration.Kind != "reports" || !integration.Enabled {
			return nil, errors.New("enabled report integration required")
		}
		date := param(j, "target_date")
		if date != "" {
			t, e := time.Parse("2006-01-02", date)
			if e != nil || t.Format("2006-01-02") != date {
				return nil, errors.New("invalid report date")
			}
		}
		resp, e := r.request(ctx, *integration, "POST", "/api/reports/run", map[string]string{"target_date": date})
		if e != nil {
			return nil, fmt.Errorf("%w: report request interrupted", ErrUnknown)
		}
		if resp.StatusCode == 400 || resp.StatusCode == 403 || resp.StatusCode == 404 || resp.StatusCode == 409 {
			resp.Body.Close()
			return nil, fmt.Errorf("report request rejected HTTP %d", resp.StatusCode)
		}
		var v struct {
			OK     bool `json:"ok"`
			Report *struct {
				URL  string `json:"url"`
				File string `json:"file"`
				Date string `json:"date"`
				Run  int    `json:"run"`
			} `json:"report"`
			Created bool `json:"created"`
		}
		if e = decode(resp, &v); e != nil {
			return nil, fmt.Errorf("%w: report service did not confirm completion", ErrUnknown)
		}
		if !v.OK || v.Report == nil || v.Report.URL == "" {
			return nil, errors.New("report service returned no successful report")
		}
		if _, e := time.Parse("2006-01-02", v.Report.Date); e != nil || (date != "" && date != v.Report.Date) {
			return nil, errors.New("report source returned a different or invalid period")
		}
		base := integration.URL
		if b := integration.Config["reports_base_url"]; b != "" {
			base = b
		}
		u, e := url.Parse(base)
		if e != nil {
			return nil, errors.New("invalid report public URL")
		}
		ref, e := url.Parse(v.Report.URL)
		if e != nil || ref.IsAbs() || ref.Host != "" || !strings.HasPrefix(ref.Path, "/reports/") || strings.Contains(ref.Path, "..") {
			return nil, errors.New("unsafe report result URL")
		}
		u = u.ResolveReference(ref)
		if e = r.guard.ValidateURL(u); e != nil {
			return nil, errors.New("invalid report result URL")
		}
		return map[string]any{"url": u.String(), "period": v.Report.Date, "title": "Отчёт мониторинга", "created": v.Created, "source": "reports", "run": v.Report.Run, "report_type": "daily"}, nil
	case "restart":
		if resource == nil || !j.Confirmed || resource.ExecutorTarget == "" {
			return nil, errors.New("explicit confirmation and executor target required")
		}
		allowed := false
		for _, op := range resource.Operations {
			if op == "restart" {
				allowed = true
			}
		}
		if !allowed {
			return nil, errors.New("restart not enabled for this resource")
		}
		if j.ID == "" {
			return nil, errors.New("durable job ID required")
		}
		resp, e := r.executorRequest(ctx, "POST", "/v1/restart", map[string]string{"request_id": j.ID, "target": resource.ExecutorTarget})
		if e != nil {
			return nil, ErrUnknown
		}
		var out map[string]any
		if e = decode(resp, &out); e != nil {
			return nil, fmt.Errorf("%w: executor did not confirm completion", ErrUnknown)
		}
		switch out["status"] {
		case "succeeded":
			return out, nil
		case "unknown", "started":
			return out, ErrUnknown
		default:
			return out, errors.New("executor rejected or failed restart")
		}
	default:
		return nil, errors.New("unsupported operation")
	}
}
func (r *Registry) check(ctx context.Context, kind, target string) (map[string]any, error) {
	if kind == "nmap" {
		return r.nmapCheck(ctx, strings.TrimSpace(target))
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	start := time.Now()
	target = strings.TrimSpace(target)
	records := r.records
	if records == nil {
		records = net.DefaultResolver
	}
	guard := r.interactiveGuard()
	if guard == nil {
		return nil, errors.New("check policy is unavailable")
	}
	out := map[string]any{"kind": kind, "target": target, "source": "portal_check", "observed_at": start.UTC(), "scope": "endpoint_only", "origin": "portal backend"}
	switch kind {
	case "dns":
		host := checkTargetHost(target)
		ips, e := guard.Resolve(ctx, host)
		if e != nil {
			return nil, e
		}
		a := []string{}
		for _, ip := range ips {
			a = append(a, ip.String())
		}
		out["addresses"] = a
	case "reverse_dns":
		ip := net.ParseIP(checkTargetHost(target))
		if ip == nil {
			return nil, errors.New("reverse DNS requires an IPv4 or IPv6 address")
		}
		if _, e := guard.Resolve(ctx, ip.String()); e != nil {
			return nil, e
		}
		names, e := records.LookupAddr(ctx, ip.String())
		if e != nil {
			var de *net.DNSError
			if !errors.As(e, &de) || !de.IsNotFound {
				return nil, e
			}
		}
		if len(names) > 32 {
			names = names[:32]
		}
		if names == nil {
			names = []string{}
		}
		out["names"], out["addresses"] = names, []string{ip.String()}
	case "dns_records":
		host := checkTargetHost(target)
		if host == "" || net.ParseIP(host) != nil || strings.ContainsAny(host, "/:@%\\ \t\n") {
			return nil, errors.New("enter a domain name")
		}
		_, e := guard.Resolve(ctx, host)
		if e != nil && !errors.Is(e, netguard.ErrDNS) {
			return nil, e
		}
		warnings := []string{}
		mx, e := records.LookupMX(ctx, host)
		mxRecords := []map[string]any{}
		if e != nil {
			warnings = append(warnings, "Не удалось получить MX-записи")
		} else {
			for _, v := range mx {
				if len(mxRecords) >= 32 {
					break
				}
				mxRecords = append(mxRecords, map[string]any{"host": v.Host, "priority": v.Pref})
			}
		}
		txt, e := records.LookupTXT(ctx, host)
		if e != nil {
			warnings = append(warnings, "Не удалось получить TXT-записи домена")
		}
		spf := []string{}
		for _, v := range txt {
			if strings.HasPrefix(strings.ToLower(v), "v=spf1") && len(spf) < 16 {
				if len(v) > 2048 {
					v = v[:2048]
				}
				spf = append(spf, v)
			}
		}
		txt, e = records.LookupTXT(ctx, "_dmarc."+host)
		if e != nil {
			warnings = append(warnings, "Не удалось получить DMARC-запись")
		}
		dmarc := []string{}
		for _, v := range txt {
			if strings.HasPrefix(strings.ToLower(v), "v=dmarc1") && len(dmarc) < 16 {
				if len(v) > 2048 {
					v = v[:2048]
				}
				dmarc = append(dmarc, v)
			}
		}
		out["mx"], out["spf"], out["dmarc"], out["warnings"] = mxRecords, spf, dmarc, warnings
	case "tcp", "tls":
		if kind == "tls" && (net.ParseIP(target) != nil || !strings.ContainsAny(target, "/: ")) {
			target = net.JoinHostPort(target, "443")
		}
		address, host, e := checkAddress(target, kind)
		if e != nil {
			return nil, e
		}
		c, e := guard.DialContext(ctx, "tcp", address)
		if e != nil {
			return nil, e
		}
		defer c.Close()
		out["remote_address"] = c.RemoteAddr().String()
		_ = c.SetDeadline(time.Now().Add(15 * time.Second))
		if kind == "tls" {
			conf := guard.TLSConfig()
			conf.ServerName = host
			tc := tls.Client(c, conf)
			if e = tc.HandshakeContext(ctx); e != nil {
				return nil, e
			}
			state := tc.ConnectionState()
			out["tls_version"] = state.Version
			out["tls_version_name"] = tls.VersionName(state.Version)
			if len(state.PeerCertificates) > 0 {
				cert := state.PeerCertificates[0]
				out["not_after"] = cert.NotAfter
				out["not_before"] = cert.NotBefore
				out["subject"] = cert.Subject.String()
				out["days_remaining"] = int(time.Until(cert.NotAfter).Hours() / 24)
				out["issuer"] = cert.Issuer.String()
				out["dns_names"] = cert.DNSNames
			}
		}
	case "http":
		if !strings.Contains(target, "://") {
			target = "https://" + target
		}
		req, e := http.NewRequestWithContext(ctx, "GET", target, nil)
		if e != nil {
			return nil, errors.New("invalid HTTP target")
		}
		resp, e := guard.Client(20 * time.Second).Do(req)
		if e != nil {
			return nil, e
		}
		defer resp.Body.Close()
		out["http_status"] = resp.StatusCode
		out["final_url"] = resp.Request.URL.String()
		out["content_type"] = resp.Header.Get("Content-Type")
		out["reachable"] = true
		out["http_success"] = resp.StatusCode >= 200 && resp.StatusCode < 400
		out["application_health"] = "not_assessed"
	default:
		return nil, errors.New("unsupported check kind")
	}
	out["duration_ms"] = time.Since(start).Milliseconds()
	return out, nil
}
func checkAddress(target, kind string) (string, string, error) {
	if strings.Contains(target, "://") {
		u, e := url.Parse(target)
		if e != nil || u.User != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") {
			return "", "", errors.New("invalid target URL")
		}
		p := u.Port()
		if p == "" {
			p = "80"
			if u.Scheme == "https" || kind == "tls" {
				p = "443"
			}
		}
		return net.JoinHostPort(u.Hostname(), p), u.Hostname(), nil
	}
	host, p, e := net.SplitHostPort(target)
	if e != nil {
		return "", "", errors.New("TCP/TLS target requires host:port or HTTP(S) URL")
	}
	n, e := strconv.Atoi(p)
	if e != nil || n < 1 || n > 65535 {
		return "", "", errors.New("invalid target port")
	}
	return target, host, nil
}

var titleRE = regexp.MustCompile(`(?is)<title\b[^>]*>(.*?)</title\s*>`)
var tagRE = regexp.MustCompile(`<[^>]*>`)

func (r *Registry) enrich(ctx context.Context, target string) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, e := http.NewRequestWithContext(ctx, "GET", target, nil)
	if e != nil {
		return nil, errors.New("invalid enrichment URL")
	}
	guard := r.endpointGuard()
	if guard == nil {
		return nil, errors.New("check policy is unavailable")
	}
	resp, e := guard.Client(15 * time.Second).Do(req)
	if e != nil {
		return nil, e
	}
	defer resp.Body.Close()
	body, e := io.ReadAll(io.LimitReader(resp.Body, 256<<10))
	if e != nil {
		return nil, e
	}
	suggestions := map[string]any{"type": "application", "icon": "globe", "check": map[string]any{"kind": "http", "target": target, "interval_seconds": 300}}
	if strings.Contains(strings.ToLower(resp.Header.Get("Content-Type")), "text/html") {
		if m := titleRE.FindSubmatch(body); len(m) == 2 {
			title := strings.Join(strings.Fields(html.UnescapeString(tagRE.ReplaceAllString(string(m[1]), ""))), " ")
			rr := []rune(title)
			if len(rr) > 180 {
				title = string(rr[:180])
			}
			if title != "" {
				suggestions["name"] = title
			}
		}
	}
	return map[string]any{"suggestions": suggestions, "observations": map[string]any{"http_status": resp.StatusCode, "content_type": resp.Header.Get("Content-Type"), "observed_at": time.Now().UTC(), "source": "http_response", "application_health": "not_assessed"}, "requires_confirmation": true}, nil
}

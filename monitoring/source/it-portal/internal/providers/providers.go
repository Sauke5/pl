// Package providers implements read adapters and bounded, explicit operations.
package providers

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"pl/portal/internal/model"
	"pl/portal/internal/netguard"
	"regexp"
	"strings"
	"time"
)

var ErrUnknown = errors.New("operation outcome is unknown; inspect source before retrying")

type recordResolver interface {
	LookupAddr(context.Context, string) ([]string, error)
	LookupMX(context.Context, string) ([]*net.MX, error)
	LookupTXT(context.Context, string) ([]string, error)
}

type Registry struct {
	MailcowCredential func(context.Context, model.Integration) (string, *netguard.Guard, error)
	ManagedHealth     func(context.Context, model.Integration) error
	FileAuditorProbe  func(context.Context, model.Integration) error
	ManagedRequest    func(context.Context, model.Integration, string, string, string, string, []byte) (*http.Response, error)
	ManagedRead       func(context.Context, model.Integration, string, string) (*http.Response, error)
	records           recordResolver
	guard             *netguard.Guard
	checkGuard        *netguard.Guard
	manualGuard       *netguard.Guard
	icmpGuard         *netguard.Guard
	icmpExecutorURL   string
	executorURL       string
}

func New(g *netguard.Guard, executorURL string) *Registry {
	return &Registry{guard: g, executorURL: executorURL}
}

// SetCheckGuard configures the legacy endpoint and metadata-enrichment policy.
// Integration clients and an explicitly enabled interactive policy stay separate.
func (r *Registry) SetCheckGuard(g *netguard.Guard) { r.checkGuard = g }

func (r *Registry) endpointGuard() *netguard.Guard {
	if r.checkGuard != nil {
		return r.checkGuard
	}
	return r.guard
}

func (r *Registry) EnablePublicWebChecks() {
	if g := r.endpointGuard(); g != nil {
		r.checkGuard = g.PublicWebChecks()
	}
}

// EnableInteractiveChecks separates user-triggered checks from integration and
// enrichment policy. It never grants provider clients broader network access.
func (r *Registry) EnableInteractiveChecks() {
	if g := r.endpointGuard(); g != nil {
		r.manualGuard = g.InteractiveChecks()
	}
}

func (r *Registry) interactiveGuard() *netguard.Guard {
	if r.manualGuard != nil {
		return r.manualGuard
	}
	return r.endpointGuard()
}

func Capabilities(kind string) []string {
	switch kind {
	case "mailcow":
		return []string{"mail_monitoring"}
	case "fileauditor":
		return []string{"file_audit", "health"}
	case "netbox":
		return []string{"discovery", "inventory"}
	case "oxidized":
		return []string{"configuration_history"}
	case "wayline":
		return []string{"network_checks", "health"}
	case "prometheus":
		return []string{"discovery"}
	case "alertmanager":
		return []string{"problems"}
	case "grafana":
		return []string{"links", "health"}
	case "reports":
		return []string{"report", "health"}
	case "docker":
		return []string{"restart", "health"}
	}
	return []string{}
}
func hash(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }
func timeout(i model.Integration) time.Duration {
	n := i.TimeoutSeconds
	if n <= 0 {
		n = 15
	}
	if n > 900 {
		n = 900
	}
	return time.Duration(n) * time.Second
}

var secretName = regexp.MustCompile(`^[A-Z0-9_]+$`)

func secret(ref string) (string, error) {
	if ref == "" {
		return "", nil
	}
	allowed := false
	for _, r := range strings.Split(os.Getenv("PORTAL_SECRET_REFS"), ",") {
		if strings.TrimSpace(r) == ref {
			allowed = true
		}
	}
	if !allowed {
		return "", errors.New("secret reference is not allowlisted")
	}
	var value string
	if strings.HasPrefix(ref, "env:PORTAL_SECRET_") {
		key := strings.TrimPrefix(ref, "env:")
		if !secretName.MatchString(key) {
			return "", errors.New("invalid secret reference")
		}
		value = os.Getenv(key)
	} else if strings.HasPrefix(ref, "file:") {
		name := strings.TrimPrefix(ref, "file:")
		if name == "" || name != filepath.Base(name) || name == "." || name == ".." {
			return "", errors.New("invalid secret filename")
		}
		dir := os.Getenv("PORTAL_SECRETS_DIR")
		if dir == "" {
			dir = "/run/secrets/portal"
		}
		base, e := filepath.EvalSymlinks(dir)
		if e != nil {
			return "", errors.New("secret directory unavailable")
		}
		path, e := filepath.EvalSymlinks(filepath.Join(base, name))
		if e != nil || filepath.Dir(path) != base {
			return "", errors.New("secret file unavailable or escapes secret directory")
		}
		f, e := os.Open(path)
		if e != nil {
			return "", errors.New("secret file unavailable")
		}
		defer f.Close()
		b, e := io.ReadAll(io.LimitReader(f, 16385))
		if e != nil || len(b) > 16384 {
			return "", errors.New("invalid secret file")
		}
		value = strings.TrimSpace(string(b))
	} else {
		return "", errors.New("unsupported secret reference")
	}
	if value == "" || strings.ContainsAny(value, "\r\n") {
		return "", errors.New("secret missing or invalid")
	}
	return value, nil
}
func endpoint(base, path string) (string, error) {
	u, e := url.Parse(base)
	if e != nil || u.Host == "" || u.User != nil {
		return "", errors.New("invalid integration URL")
	}
	u.Path = strings.TrimRight(u.Path, "/") + path
	u.RawPath = ""
	u.RawQuery = ""
	u.Fragment = ""
	return u.String(), nil
}
func decode(resp *http.Response, out any) error {
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("source returned HTTP %d", resp.StatusCode)
	}
	b, e := io.ReadAll(io.LimitReader(resp.Body, 4<<20+1))
	if e != nil {
		return errors.New("source response interrupted")
	}
	if len(b) > 4<<20 {
		return errors.New("source response too large")
	}
	if e = json.Unmarshal(b, out); e != nil {
		return errors.New("source returned malformed JSON")
	}
	return nil
}
func (r *Registry) request(ctx context.Context, i model.Integration, method, path string, payload any) (*http.Response, error) {
	if i.ManagedModuleID != "" {
		if method != http.MethodGet || payload != nil || r.ManagedRead == nil {
			return nil, errors.New("managed module supports bounded read operations only")
		}
		u, err := url.Parse(path)
		if err != nil || u.IsAbs() || u.Host != "" || u.Fragment != "" || u.RawPath != "" {
			return nil, errors.New("invalid managed module route")
		}
		return r.ManagedRead(ctx, i, u.Path, u.RawQuery)
	}
	u, e := endpoint(i.URL, path)
	if e != nil {
		return nil, e
	}
	var body io.Reader
	if payload != nil {
		b, e := json.Marshal(payload)
		if e != nil {
			return nil, e
		}
		body = bytes.NewReader(b)
	}
	req, e := http.NewRequestWithContext(ctx, method, u, body)
	if e != nil {
		return nil, errors.New("invalid request")
	}
	token, e := secret(i.SecretRef)
	if e != nil {
		return nil, e
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	client := r.guard.Client(timeout(i))
	if method != http.MethodGet && method != http.MethodHead {
		client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	}
	resp, e := client.Do(req)
	if e != nil {
		return nil, errors.New("source request failed (network, policy or TLS)")
	}
	return resp, nil
}
func (r *Registry) Poll(ctx context.Context, i model.Integration) (model.Snapshot, error) {
	s := model.Snapshot{Candidates: []model.Candidate{}, Problems: []model.Problem{}}
	switch i.Kind {
	case "fileauditor":
		if r.FileAuditorProbe == nil {
			return s, errors.New("File Auditor connector unavailable")
		}
		return s, r.FileAuditorProbe(ctx, i)
	case "netbox":
		return r.pollNetBox(ctx, i)
	case "oxidized":
		return r.pollOxidized(ctx, i)
	case "wayline":
		_, e := r.Wayline(ctx, i)
		return s, e
	case "prometheus":
		resp, e := r.request(ctx, i, "GET", "/api/v1/targets", nil)
		if e != nil {
			return s, e
		}
		var v struct {
			Status string `json:"status"`
			Data   *struct {
				ActiveTargets *[]struct {
					Labels     map[string]string `json:"labels"`
					ScrapeURL  string            `json:"scrapeUrl"`
					ScrapePool string            `json:"scrapePool"`
					Health     string            `json:"health"`
					LastScrape time.Time         `json:"lastScrape"`
				} `json:"activeTargets"`
			} `json:"data"`
		}
		if e = decode(resp, &v); e != nil {
			return s, e
		}
		if v.Status != "success" || v.Data == nil || v.Data.ActiveTargets == nil {
			return s, errors.New("incomplete Prometheus targets response")
		}
		seen := map[string]bool{}
		for _, t := range *v.Data.ActiveTargets {
			if !safeSourceURL(t.ScrapeURL) || len(t.Labels) == 0 {
				return s, errors.New("malformed Prometheus target")
			}
			// Identity is the technical scrape endpoint in its pool; mutable labels
			// are observations and must not duplicate an already reviewed target.
			canonical := t.ScrapePool + "\x00" + t.ScrapeURL
			id := hash(canonical)
			if seen[id] {
				continue
			}
			seen[id] = true
			instanceLabel := i.Config["instance_label"]
			if instanceLabel == "" {
				instanceLabel = "instance"
			}
			name := t.Labels[instanceLabel]
			if name == "" {
				name = t.Labels["job"]
			}
			if name == "" {
				u, _ := url.Parse(t.ScrapeURL)
				name = u.Hostname()
			}
			if rr := []rune(name); len(rr) > 160 {
				name = string(rr[:160])
			}
			if t.Health != "up" && t.Health != "down" && t.Health != "unknown" && t.Health != "" {
				return s, errors.New("unknown Prometheus target health")
			}
			s.Targets = append(s.Targets, model.MonitoringTarget{ExternalID: id, Name: name, Health: t.Health, Labels: safeLabels(t.Labels), LastScrape: t.LastScrape})
			if i.Config["discovery_enabled"] == "false" || !matchesDiscovery(i.Config, t.Labels) {
				continue
			}
			candidateURL := t.ScrapeURL
			if t.Labels["job"] == "windows" || t.Labels["job"] == "linux" {
				// Exporter endpoints observe hosts; they are not user-facing pages.
				candidateURL = ""
				host := strings.TrimSpace(t.Labels["instance"])
				if h, _, err := net.SplitHostPort(host); err == nil {
					host = h
				}
				if host != "" {
					name = host
				}
			}
			if rr := []rune(name); len(rr) > 160 {
				name = string(rr[:160])
			}
			s.Candidates = append(s.Candidates, model.Candidate{IntegrationID: i.ID, ExternalID: id, Name: name, URL: candidateURL, Observation: &model.TargetObservation{Health: t.Health, LastScrape: t.LastScrape, ScrapeURL: t.ScrapeURL, Job: t.Labels["job"], Instance: t.Labels["instance"]}, Labels: safeLabels(t.Labels), State: "pending", LastSeen: time.Now().UTC()})
		}
	case "alertmanager":
		// Default API returns active, silenced and inhibited alerts: none are recovery.
		resp, e := r.request(ctx, i, "GET", "/api/v2/alerts", nil)
		if e != nil {
			return s, e
		}
		var alerts []struct {
			Fingerprint  string            `json:"fingerprint"`
			Labels       map[string]string `json:"labels"`
			Annotations  map[string]string `json:"annotations"`
			StartsAt     time.Time         `json:"startsAt"`
			GeneratorURL string            `json:"generatorURL"`
			Status       *struct {
				State       string   `json:"state"`
				SilencedBy  []string `json:"silencedBy"`
				InhibitedBy []string `json:"inhibitedBy"`
			} `json:"status"`
		}
		if e = decode(resp, &alerts); e != nil {
			return s, e
		}
		if alerts == nil {
			return s, errors.New("incomplete Alertmanager response")
		}
		seen := map[string]bool{}
		for _, a := range alerts {
			if a.Fingerprint == "" || a.StartsAt.IsZero() || a.Status == nil || len(a.Labels) == 0 {
				return s, errors.New("malformed Alertmanager alert")
			}
			if seen[a.Fingerprint] {
				return s, errors.New("duplicate Alertmanager identity")
			}
			seen[a.Fingerprint] = true
			if a.Status.State != "active" && a.Status.State != "suppressed" && a.Status.State != "unprocessed" {
				return s, errors.New("unknown Alertmanager alert state")
			}
			labels := safeLabels(a.Labels)
			labels["portal_alert_state"] = a.Status.State
			labels["portal_silenced"] = fmt.Sprint(len(a.Status.SilencedBy) > 0)
			labels["portal_inhibited"] = fmt.Sprint(len(a.Status.InhibitedBy) > 0)
			title := a.Annotations["summary"]
			if title == "" {
				title = labels["alertname"]
			}
			sourceURL := a.GeneratorURL
			if !safeSourceURL(sourceURL) {
				sourceURL = ""
			}
			s.Problems = append(s.Problems, model.Problem{IntegrationID: i.ID, ExternalID: a.Fingerprint, Severity: labels["severity"], Title: title, Description: a.Annotations["description"], StartedAt: a.StartsAt, LastSeen: time.Now().UTC(), Status: "firing", SourceURL: sourceURL, Labels: labels})
		}
	case "grafana", "reports":
		path := "/api/health"
		if i.Kind == "reports" {
			path = "/health"
		}
		resp, e := r.request(ctx, i, "GET", path, nil)
		if e != nil {
			return s, e
		}
		var v map[string]any
		if e = decode(resp, &v); e != nil {
			return s, e
		}
		if i.Kind == "reports" && v["ok"] != true {
			return s, errors.New("report service unhealthy")
		}
		if i.Kind == "reports" {
			s.Reports, e = r.reportManifest(ctx, i)
			if e != nil {
				return s, e
			}
		}
		if i.Kind == "grafana" && v["database"] != "ok" {
			return s, errors.New("Grafana database unhealthy")
		}
	case "docker":
		resp, e := r.executorRequest(ctx, "GET", "/health", nil)
		if e != nil {
			return s, e
		}
		var v map[string]any
		if e = decode(resp, &v); e != nil {
			return s, e
		}
		if v["ok"] != true {
			return s, errors.New("executor unhealthy")
		}
	default:
		return s, errors.New("unsupported integration kind")
	}
	return s, nil
}
func (r *Registry) executorRequest(ctx context.Context, method, path string, payload any) (*http.Response, error) {
	u, e := url.Parse(r.executorURL)
	if e != nil || u.Scheme != "unix" || u.Host != "" || !filepath.IsAbs(u.Path) {
		return nil, errors.New("executor requires absolute unix socket URL")
	}
	var body io.Reader
	if payload != nil {
		b, _ := json.Marshal(payload)
		body = bytes.NewReader(b)
	}
	req, e := http.NewRequestWithContext(ctx, method, "http://executor"+path, body)
	if e != nil {
		return nil, e
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 75 * time.Second, Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", u.Path)
	}, DisableKeepAlives: true}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return client.Do(req)
}

// Filters are exact comma-separated job names and an optional exact label match.
func matchesDiscovery(config map[string]string, labels map[string]string) bool {
	contains := func(list, value string) bool {
		for _, v := range strings.Split(list, ",") {
			if strings.TrimSpace(v) == value {
				return true
			}
		}
		return false
	}
	if v := config["include_job"]; v != "" && !contains(v, labels["job"]) {
		return false
	}
	if v := config["exclude_job"]; v != "" && contains(v, labels["job"]) {
		return false
	}
	if k := config["match_label"]; k != "" {
		value, ok := labels[k]
		if !ok || value != config["match_value"] {
			return false
		}
	}
	return true
}

func sensitiveKey(k string) bool {
	k = strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(k, "-", "_"), ".", "_"))
	for _, v := range []string{"password", "passwd", "secret", "token", "api_key", "apikey", "authorization", "credential", "cookie"} {
		if strings.Contains(k, v) {
			return true
		}
	}
	return false
}

// Source metadata is untrusted; exclude secret-bearing labels from API snapshots.
func safeLabels(labels map[string]string) map[string]string {
	out := make(map[string]string, len(labels))
	for k, v := range labels {
		if !sensitiveKey(k) {
			out[k] = v
		}
	}
	return out
}
func safeSourceURL(raw string) bool {
	u, e := url.Parse(raw)
	if e != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || strings.ContainsAny(raw, "\r\n\x00") || len(raw) > 4096 {
		return false
	}
	q, e := url.ParseQuery(u.RawQuery)
	if e != nil {
		return false
	}
	for k := range q {
		if sensitiveKey(k) {
			return false
		}
	}
	return true
}

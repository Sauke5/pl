package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	"pl/portal/internal/model"
)

var (
	ErrBrowseAuth        = errors.New("source authentication required")
	ErrBrowseUnavailable = errors.New("source unavailable or invalid response")
	ErrBrowseInvalid     = errors.New("invalid browse parameters")
	ErrBrowseLimit       = errors.New("source response exceeds portal limits")
	ErrBrowseBusy        = errors.New("source query capacity reached")
	ErrPanelUnsupported  = errors.New("panel unsupported")
)
var browseSlots = make(chan struct{}, 4)
var browseWaiters = make(chan struct{}, 16)
var providerUID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var prometheusLabel = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]{0,127}$`)

func browseContext(ctx context.Context) (context.Context, func(), error) {
	select {
	case browseWaiters <- struct{}{}:
	default:
		return nil, nil, ErrBrowseBusy
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	select {
	case browseSlots <- struct{}{}:
		<-browseWaiters
		return ctx, func() { cancel(); <-browseSlots }, nil
	case <-ctx.Done():
		<-browseWaiters
		cancel()
		return nil, nil, ErrBrowseUnavailable
	}
}

// Only fixed provider paths and query keys constructed by this package reach
// this transport; source credentials and unfiltered source responses stay here.
func (r *Registry) browseJSON(ctx context.Context, i model.Integration, method, path string, query url.Values, payload, out any) error {
	if i.ManagedModuleID != "" {
		var resp *http.Response
		var err error
		switch {
		case method == http.MethodGet && payload == nil && r.ManagedRead != nil:
			resp, err = r.ManagedRead(ctx, i, path, query.Encode())
		case i.Kind == "grafana" && method == http.MethodPost && path == "/api/ds/query" && len(query) == 0 && payload != nil && r.ManagedRequest != nil:
			body, marshalErr := json.Marshal(payload)
			if marshalErr != nil || len(body) > 512<<10 {
				return ErrBrowseInvalid
			}
			resp, err = r.ManagedRequest(ctx, i, method, path, "", "application/json", body)
		default:
			return ErrBrowseInvalid
		}
		if err != nil || resp == nil || resp.Body == nil {
			return ErrBrowseUnavailable
		}
		defer resp.Body.Close()
		if resp.StatusCode == 401 || resp.StatusCode == 403 {
			return ErrBrowseAuth
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return ErrBrowseUnavailable
		}
		body, err := io.ReadAll(io.LimitReader(resp.Body, (4<<20)+1))
		if err != nil {
			return ErrBrowseUnavailable
		}
		if len(body) > 4<<20 {
			return ErrBrowseLimit
		}
		if json.Unmarshal(body, out) != nil {
			return ErrBrowseUnavailable
		}
		return nil
	}
	address, e := endpoint(i.URL, path)
	if e != nil {
		return ErrBrowseInvalid
	}
	u, e := url.Parse(address)
	if e != nil {
		return ErrBrowseInvalid
	}
	u.RawQuery = query.Encode()
	var body io.Reader
	if payload != nil {
		b, err := json.Marshal(payload)
		if err != nil {
			return ErrBrowseInvalid
		}
		body = bytes.NewReader(b)
	}
	req, e := http.NewRequestWithContext(ctx, method, u.String(), body)
	if e != nil {
		return ErrBrowseInvalid
	}
	token, e := secret(i.SecretRef)
	if e != nil {
		return ErrBrowseAuth
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Accept", "application/json")
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	client := r.guard.Client(15 * time.Second)
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, e := client.Do(req)
	if e != nil {
		return ErrBrowseUnavailable
	}
	defer resp.Body.Close()
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		return ErrBrowseAuth
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return ErrBrowseUnavailable
	}
	b, e := io.ReadAll(io.LimitReader(resp.Body, (4<<20)+1))
	if e != nil {
		return ErrBrowseUnavailable
	}
	if len(b) > 4<<20 {
		return ErrBrowseLimit
	}
	if e = json.Unmarshal(b, out); e != nil {
		return ErrBrowseUnavailable
	}
	return nil
}

type PrometheusOptions struct {
	Jobs        []string  `json:"jobs"`
	Labels      []string  `json:"labels"`
	Values      []string  `json:"values"`
	TargetCount int       `json:"target_count"`
	Truncated   bool      `json:"truncated"`
	ObservedAt  time.Time `json:"observed_at"`
}

func (r *Registry) PrometheusOptions(ctx context.Context, i model.Integration, job, label string) (PrometheusOptions, error) {
	out := PrometheusOptions{Jobs: []string{}, Labels: []string{}, Values: []string{}}
	if !i.Enabled || i.Kind != "prometheus" || len(job) > 512 || (label != "" && !prometheusLabel.MatchString(label)) {
		return out, ErrBrowseInvalid
	}
	ctx, done, e := browseContext(ctx)
	if e != nil {
		return out, e
	}
	defer done()
	var response struct {
		Status string `json:"status"`
		Data   *struct {
			ActiveTargets *[]struct {
				Labels map[string]string `json:"labels"`
			} `json:"activeTargets"`
		} `json:"data"`
	}
	if e = r.browseJSON(ctx, i, "GET", "/api/v1/targets", nil, nil, &response); e != nil {
		return out, e
	}
	if response.Status != "success" || response.Data == nil || response.Data.ActiveTargets == nil {
		return out, ErrBrowseUnavailable
	}
	jobs, labels, values := map[string]bool{}, map[string]bool{}, map[string]bool{}
	targets := *response.Data.ActiveTargets
	out.TargetCount = len(targets)
	if len(targets) > 10000 {
		return out, ErrBrowseLimit
	}
	for _, target := range targets {
		safe := safeLabels(target.Labels)
		if v := safe["job"]; v != "" && len(v) <= 512 {
			jobs[v] = true
		}
		if job != "" && safe["job"] != job {
			continue
		}
		for k, v := range safe {
			if prometheusLabel.MatchString(k) {
				labels[k] = true
			}
			if k == label && len(v) <= 512 {
				values[v] = true
			}
		}
	}
	out.Jobs, out.Truncated = sortedOptions(jobs, 200, false)
	out.Labels, out.Truncated = sortedOptions(labels, 128, out.Truncated)
	out.Values, out.Truncated = sortedOptions(values, 500, out.Truncated)
	out.ObservedAt = time.Now().UTC()
	return out, nil
}
func sortedOptions(m map[string]bool, max int, truncated bool) ([]string, bool) {
	values := make([]string, 0, len(m))
	for v := range m {
		if !strings.ContainsRune(v, 0) {
			values = append(values, v)
		}
	}
	sort.Strings(values)
	if len(values) > max {
		values = values[:max]
		truncated = true
	}
	return values, truncated
}

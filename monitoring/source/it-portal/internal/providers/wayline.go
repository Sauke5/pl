package providers

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"pl/portal/internal/model"
	"strconv"
	"time"
)

type WaylineResult struct {
	ID            int64     `json:"id"`
	TargetID      int64     `json:"target_id"`
	Kind          string    `json:"kind"`
	Status        string    `json:"status"`
	StartedAt     time.Time `json:"started_at"`
	FinishedAt    time.Time `json:"finished_at"`
	Stale         bool      `json:"stale"`
	LossPercent   *float64  `json:"loss_percent,omitempty"`
	AvgLatencyMS  *float64  `json:"avg_latency_ms,omitempty"`
	JitterMS      *float64  `json:"jitter_ms,omitempty"`
	ThroughputBPS *float64  `json:"throughput_bps,omitempty"`
	Direction     string    `json:"direction"`
	ErrorMessage  string    `json:"error_message,omitempty"`
}
type WaylineTarget struct {
	ID              int64          `json:"id"`
	Name            string         `json:"name"`
	Host            string         `json:"host"`
	Enabled         bool           `json:"enabled"`
	IperfEnabled    bool           `json:"iperf_enabled"`
	IntervalSeconds int            `json:"interval_seconds"`
	Path            *WaylineResult `json:"path"`
	Iperf           *WaylineResult `json:"iperf"`
}
type WaylineSource struct {
	IntegrationID string          `json:"integration_id"`
	Name          string          `json:"name"`
	URL           string          `json:"url"`
	Status        string          `json:"status"`
	Error         string          `json:"error"`
	FetchedAt     time.Time       `json:"fetched_at"`
	Targets       []WaylineTarget `json:"targets"`
}

// Wayline fetches a complete bounded snapshot. An incomplete source never supplies
// healthy cards; the caller retains the selected identities in preferences.
func (r *Registry) Wayline(ctx context.Context, i model.Integration) ([]WaylineTarget, error) {
	budget := timeout(i)
	if budget > 30*time.Second {
		budget = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	managed := i.ManagedModuleID != "" && i.Config["module_mode"] == "local"
	var password, username string
	var client *http.Client
	var err error
	if !managed {
		password, err = secret(i.SecretRef)
		if err != nil {
			return nil, err
		}
		username = i.Config["basic_username"]
		if (username == "") != (password == "") {
			return nil, errors.New("Wayline authentication configuration incomplete")
		}
		if r.guard == nil {
			return nil, errors.New("Wayline connection policy unavailable")
		}
		client = r.guard.Client(budget)
		// Credentials must not follow redirects, including same-origin redirects.
		client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	}
	get := func(path, kind string, out any) error {
		if managed {
			if r.ManagedRequest == nil {
				return errors.New("managed Wayline reader unavailable")
			}
			query := url.Values{}
			if kind != "" {
				query.Set("kind", kind)
			}
			resp, err := r.ManagedRequest(ctx, i, http.MethodGet, path, query.Encode(), "", nil)
			if err != nil {
				return errors.New("managed Wayline request failed")
			}
			return decode(resp, out)
		}
		raw, e := endpoint(i.URL, path)
		if e != nil {
			return e
		}
		u, _ := url.Parse(raw)
		if kind != "" {
			q := u.Query()
			q.Set("kind", kind)
			u.RawQuery = q.Encode()
		}
		req, e := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
		if e != nil {
			return errors.New("invalid Wayline request")
		}
		if username != "" {
			req.SetBasicAuth(username, password)
		}
		resp, e := client.Do(req)
		if e != nil {
			return errors.New("Wayline request failed (network, timeout, policy or TLS)")
		}
		return decode(resp, out)
	}
	var targets struct {
		Targets *[]WaylineTarget `json:"targets"`
	}
	if err = get("/api/v1/targets", "", &targets); err != nil {
		return nil, err
	}
	if targets.Targets == nil || len(*targets.Targets) > 10000 {
		return nil, errors.New("invalid Wayline targets response")
	}
	out := *targets.Targets
	index := map[int64]int{}
	for n, t := range out {
		if _, exists := index[t.ID]; exists || t.ID < 1 || t.Name == "" || t.Host == "" || t.IntervalSeconds < 1 || t.IntervalSeconds > 86400 {
			return nil, errors.New("invalid Wayline target")
		}
		out[n].Path = nil
		out[n].Iperf = nil
		index[t.ID] = n
	}
	now := time.Now().UTC()
	for _, kind := range []string{"path", "iperf"} {
		var runs struct {
			Checks *[]WaylineResult `json:"checks"`
		}
		if err = get("/api/v1/checks/latest", kind, &runs); err != nil {
			return nil, err
		}
		if runs.Checks == nil || len(*runs.Checks) > 10000 {
			return nil, errors.New("invalid Wayline checks response")
		}
		seen := map[int64]bool{}
		for _, run := range *runs.Checks {
			if run.Kind != kind || run.ID < 1 || run.TargetID < 1 || seen[run.TargetID] {
				return nil, errors.New("invalid Wayline check identity")
			}
			seen[run.TargetID] = true
			n, exists := index[run.TargetID]
			if !exists {
				continue
			}
			age := 300
			if out[n].IntervalSeconds*3 > age {
				age = out[n].IntervalSeconds * 3
			}
			if kind == "iperf" {
				age = 86400
			}
			if v, e := strconv.Atoi(i.Config["stale_after_seconds"]); e == nil && v >= 30 && v <= 86400 {
				age = v
			}
			run.Stale = run.FinishedAt.IsZero() || run.FinishedAt.After(now.Add(time.Minute)) || now.Sub(run.FinishedAt) > time.Duration(age)*time.Second
			switch run.Status {
			case "success", "degraded", "failed":
			default:
				run.Status = "unknown"
			}
			if run.FinishedAt.IsZero() || run.StartedAt.IsZero() || run.FinishedAt.Before(run.StartedAt) {
				run.Status = "unknown"
				run.Stale = true
			}
			// A success without the measurement cannot establish a healthy result.
			if run.Status == "success" && ((kind == "path" && (run.LossPercent == nil || run.AvgLatencyMS == nil)) || (kind == "iperf" && run.ThroughputBPS == nil)) {
				run.Status = "unknown"
			}
			if (run.LossPercent != nil && (*run.LossPercent < 0 || *run.LossPercent > 100)) || (run.AvgLatencyMS != nil && *run.AvgLatencyMS < 0) || (run.JitterMS != nil && *run.JitterMS < 0) || (run.ThroughputBPS != nil && *run.ThroughputBPS < 0) {
				return nil, errors.New("invalid Wayline measurement")
			}
			if kind == "path" {
				out[n].Path = &run
			} else {
				out[n].Iperf = &run
			}
		}
	}
	return out, nil
}

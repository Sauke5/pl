package providers

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"time"

	"pl/portal/internal/model"
)

const proxyMetricsQuery = `{__name__=~"up|pl_proxy_probe_success|pl_proxy_probe_timestamp_seconds|pl_proxy_probe_control_success|pl_proxy_stage_success|pl_proxy_probe_healthy|pl_proxy_probe_cycle_timestamp_seconds|pl_proxy_probe_test_active",job="proxy-external",source=~"external185|external2"}[30m]`

var proxySources = []string{"external185", "external2"}
var proxyInbounds = []string{"443", "31241", "46926", "17180", "8443", "8081"}

type ProxyExternalProbe struct {
	Source           string     `json:"source"`
	Inbound          string     `json:"inbound"`
	State            string     `json:"state"`
	ObservedAt       *time.Time `json:"observed_at"`
	LastSuccess      *time.Time `json:"last_success"`
	SuccessRatio     *float64   `json:"success_ratio"`
	SuccessfulCycles int        `json:"successful_cycles"`
	HistoryCycles    int        `json:"history_cycles"`
	ObservedCycles   int        `json:"observed_cycles"`
	FailedStages     []string   `json:"failed_stages"`
	AcceptanceTest   bool       `json:"acceptance_test"`
}
type ProxyExternalObservation struct {
	ObservedAt        time.Time            `json:"observed_at"`
	WindowSeconds     int                  `json:"window_seconds"`
	HistorySeconds    int                  `json:"history_seconds"`
	StaleAfterSeconds int                  `json:"stale_after_seconds"`
	Error             string               `json:"error,omitempty"`
	Probes            []ProxyExternalProbe `json:"probes"`
}

type proxyMetric struct {
	Metric map[string]string   `json:"metric"`
	Values [][]json.RawMessage `json:"values"`
}
type proxyMetricValues map[string]map[float64]float64

func EmptyProxyExternal(now time.Time, code string) ProxyExternalObservation {
	out := ProxyExternalObservation{ObservedAt: now.UTC(), WindowSeconds: 300, HistorySeconds: 1800, StaleAfterSeconds: 180, Error: code, Probes: []ProxyExternalProbe{}}
	for _, source := range proxySources {
		for _, inbound := range proxyInbounds {
			out.Probes = append(out.Probes, ProxyExternalProbe{Source: source, Inbound: inbound, State: "unknown", FailedStages: []string{}})
		}
	}
	return out
}
func proxyMetricKey(source, inbound, name, detail string) string {
	return source + "/" + inbound + "/" + name + "/" + detail
}
func metricValue(values proxyMetricValues, source, inbound, name, detail string, at float64) (float64, bool) {
	v, ok := values[proxyMetricKey(source, inbound, name, detail)][at]
	return v, ok && !math.IsNaN(v) && !math.IsInf(v, 0)
}
func proxyTimestamp(value float64) *time.Time {
	if value <= 0 || math.IsNaN(value) || math.IsInf(value, 0) {
		return nil
	}
	t := time.Unix(int64(value), int64((value-math.Floor(value))*1e9)).UTC()
	return &t
}
func parseProxyMetrics(series []proxyMetric, now time.Time) ProxyExternalObservation {
	out := EmptyProxyExternal(now, "")
	values := proxyMetricValues{}
	for _, row := range series {
		source, inbound, name := row.Metric["source"], row.Metric["inbound"], row.Metric["__name__"]
		if source != "external185" && source != "external2" {
			continue
		}
		detail := row.Metric["control"] + row.Metric["stage"]
		key := proxyMetricKey(source, inbound, name, detail)
		// Multiple exporters for one expected identity are ambiguous, never healthy.
		if _, exists := values[key]; exists {
			values[key] = nil
			continue
		}
		samples := map[float64]float64{}
		for _, sample := range row.Values {
			if len(sample) != 2 {
				continue
			}
			var at float64
			var encoded string
			if json.Unmarshal(sample[0], &at) != nil || json.Unmarshal(sample[1], &encoded) != nil {
				continue
			}
			v, err := strconv.ParseFloat(encoded, 64)
			if err == nil {
				samples[at] = v
			}
		}
		values[key] = samples
	}
	for index := range out.Probes {
		p := &out.Probes[index]
		timestamps := values[proxyMetricKey(p.Source, p.Inbound, "pl_proxy_probe_timestamp_seconds", "")]
		var latestScrape float64
		cycles := map[float64]bool{}
		for scrape, resultAt := range timestamps {
			if scrape > latestScrape {
				latestScrape = scrape
			}
			if resultAt <= 0 || resultAt > scrape+30 || scrape-resultAt > 180 {
				continue
			}
			success, ok := metricValue(values, p.Source, p.Inbound, "pl_proxy_probe_success", "", scrape)
			worker, wok := metricValue(values, p.Source, "", "pl_proxy_probe_healthy", "", scrape)
			cycle, cok := metricValue(values, p.Source, "", "pl_proxy_probe_cycle_timestamp_seconds", "", scrape)
			up, uok := metricValue(values, p.Source, "", "up", "", scrape)
			debian, dok := metricValue(values, p.Source, p.Inbound, "pl_proxy_probe_control_success", "debian", scrape)
			cloudflare, fok := metricValue(values, p.Source, p.Inbound, "pl_proxy_probe_control_success", "cloudflare", scrape)
			binary := func(v float64) bool { return v == 0 || v == 1 }
			if !ok || !wok || !cok || !uok || !dok || !fok || !binary(success) || !binary(debian) || !binary(cloudflare) || worker != 1 || up != 1 || cycle <= 0 || cycle > scrape+30 || scrape-cycle > 180 {
				continue
			}
			good := success == 1 && (debian == 1 || cloudflare == 1)
			if success == 1 && !good {
				continue
			}
			if prior, exists := cycles[resultAt]; exists {
				cycles[resultAt] = prior && good
			} else {
				cycles[resultAt] = good
			}
		}
		for resultAt, good := range cycles {
			if resultAt < float64(now.Unix())-1800 {
				continue
			}
			p.HistoryCycles++
			if resultAt > float64(now.Unix())+30 {
				continue
			}
			if good && (p.LastSuccess == nil || resultAt > float64(p.LastSuccess.UnixNano())/1e9) {
				p.LastSuccess = proxyTimestamp(resultAt)
			}
			if resultAt >= float64(now.Unix())-300 {
				p.ObservedCycles++
				if good {
					p.SuccessfulCycles++
				}
			}
		}
		if p.ObservedCycles > 0 {
			ratio := float64(p.SuccessfulCycles) / float64(p.ObservedCycles)
			p.SuccessRatio = &ratio
		}
		resultAt, hasTimestamp := timestamps[latestScrape]
		if !hasTimestamp || latestScrape == 0 {
			continue
		}
		p.ObservedAt = proxyTimestamp(resultAt)
		if p.ObservedAt == nil || resultAt > float64(now.Unix())+30 {
			continue
		}
		if now.Sub(*p.ObservedAt) > 180*time.Second || float64(now.Unix())-latestScrape > 90 {
			p.State = "stale"
			continue
		}
		// A current sample must itself be complete, not merely a previously good
		// duplicate of this timestamp while the exporter/worker is now unavailable.
		upSamples := values[proxyMetricKey(p.Source, "", "up", "")]
		var latestUp float64
		for at := range upSamples {
			if at > latestUp {
				latestUp = at
			}
		}
		currentUp, uok := metricValue(values, p.Source, "", "up", "", latestUp)
		if float64(now.Unix())-latestUp > 90 {
			continue
		}
		worker, wok := metricValue(values, p.Source, "", "pl_proxy_probe_healthy", "", latestScrape)
		cycle, cok := metricValue(values, p.Source, "", "pl_proxy_probe_cycle_timestamp_seconds", "", latestScrape)
		if !uok || currentUp != 1 || !wok || worker != 1 || !cok || cycle > float64(now.Unix())+30 || float64(now.Unix())-cycle > 180 {
			continue
		}
		success, sok := metricValue(values, p.Source, p.Inbound, "pl_proxy_probe_success", "", latestScrape)
		debian, dok := metricValue(values, p.Source, p.Inbound, "pl_proxy_probe_control_success", "debian", latestScrape)
		cloudflare, fok := metricValue(values, p.Source, p.Inbound, "pl_proxy_probe_control_success", "cloudflare", latestScrape)
		if !sok || !dok || !fok || (success != 0 && success != 1) || (debian != 0 && debian != 1) || (cloudflare != 0 && cloudflare != 1) {
			continue
		}
		if success == 1 && (debian == 1 || cloudflare == 1) {
			p.State = "healthy"
		} else if success == 0 && debian == 0 && cloudflare == 0 {
			p.State = "unhealthy"
		}
		test, _ := metricValue(values, p.Source, p.Inbound, "pl_proxy_probe_test_active", "", latestScrape)
		p.AcceptanceTest = test == 1
		if p.State == "unhealthy" {
			for _, stage := range []string{"dns", "tcp", "tunnel", "https"} {
				value, ok := metricValue(values, p.Source, p.Inbound, "pl_proxy_stage_success", stage, latestScrape)
				if ok && value == 0 {
					p.FailedStages = append(p.FailedStages, stage)
				}
			}
		}
	}
	return out
}

// ProxyExternal uses the existing integration secret/netguard transport. The
// browser cannot select a query, target, source, window or provider credential.
func (r *Registry) ProxyExternal(ctx context.Context, i model.Integration) (ProxyExternalObservation, error) {
	now := time.Now().UTC()
	out := EmptyProxyExternal(now, "")
	if !i.Enabled || i.Kind != "prometheus" {
		return out, ErrBrowseInvalid
	}
	ctx, done, err := browseContext(ctx)
	if err != nil {
		return out, err
	}
	defer done()
	var response struct {
		Status string `json:"status"`
		Data   struct {
			ResultType string        `json:"resultType"`
			Result     []proxyMetric `json:"result"`
		} `json:"data"`
	}
	err = r.browseJSON(ctx, i, http.MethodGet, "/api/v1/query", url.Values{"query": {proxyMetricsQuery}, "time": {strconv.FormatInt(now.Unix(), 10)}}, nil, &response)
	if err != nil {
		return out, err
	}
	if response.Status != "success" || response.Data.ResultType != "matrix" || len(response.Data.Result) > 160 {
		return out, ErrBrowseUnavailable
	}
	// Deterministic order also makes equal-time aggregation independent of JSON.
	sort.SliceStable(response.Data.Result, func(a, b int) bool {
		return response.Data.Result[a].Metric["__name__"] < response.Data.Result[b].Metric["__name__"]
	})
	return parseProxyMetrics(response.Data.Result, now), nil
}

package server

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"pl/portal/internal/providers"
)

type proxyObservationLoader func(context.Context) (providers.ProxyExternalObservation, error)

// One bounded read belongs to the shared cache, not to the browser request that
// happened to start it. SSE invalidation/unmount can cancel that request without
// cancelling everyone else's source observation or publishing a false failure.
type proxyObservationCache struct {
	mu          sync.Mutex
	load        proxyObservationLoader
	now         func() time.Time
	inFlight    chan struct{}
	attempted   bool
	lastAttempt time.Time
	lastError   string
	lastGood    providers.ProxyExternalObservation
}

func proxyObservationErrorCode(err error) string {
	switch {
	case errors.Is(err, context.Canceled):
		return "refresh_canceled"
	case errors.Is(err, context.DeadlineExceeded):
		return "refresh_timeout"
	case errors.Is(err, providers.ErrBrowseLimit):
		return "source_body_limit"
	case errors.Is(err, providers.ErrBrowseAuth):
		return "source_auth"
	case errors.Is(err, providers.ErrBrowseBusy):
		return "source_capacity"
	case errors.Is(err, errProxySourceAmbiguous):
		return "source_ambiguous"
	case errors.Is(err, errProxySourceMissing):
		return "source_missing"
	default:
		return "source_unavailable"
	}
}
func (c *proxyObservationCache) resultLocked(now time.Time) providers.ProxyExternalObservation {
	if c.lastError == "" {
		return c.lastGood
	}
	if c.lastGood.ObservedAt.IsZero() || now.Sub(c.lastGood.ObservedAt) > 180*time.Second {
		return providers.EmptyProxyExternal(c.lastAttempt, c.lastError)
	}
	out := c.lastGood
	out.Error = c.lastError
	// Never mutate the last successful observation or report it as current.
	out.Probes = append([]providers.ProxyExternalProbe(nil), out.Probes...)
	for index := range out.Probes {
		if out.Probes[index].State != "unknown" {
			out.Probes[index].State = "stale"
		}
	}
	return out
}
func (c *proxyObservationCache) get(ctx context.Context) (providers.ProxyExternalObservation, error) {
	c.mu.Lock()
	ttl := 20 * time.Second
	if c.lastError != "" {
		ttl = 5 * time.Second
	}
	if c.attempted && c.now().Sub(c.lastAttempt) < ttl {
		out := c.resultLocked(c.now())
		c.mu.Unlock()
		return out, nil
	}
	done := c.inFlight
	if done == nil {
		done = make(chan struct{})
		c.inFlight = done
		go func() {
			started := time.Now()
			// Store lookup, queue wait and provider read share this total budget.
			refreshCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			out, err := c.load(refreshCtx)
			if refreshCtx.Err() != nil {
				err = refreshCtx.Err()
			}
			cancel()
			c.mu.Lock()
			c.lastAttempt = c.now()
			c.attempted = true
			if err != nil {
				c.lastError = proxyObservationErrorCode(err)
				slog.Warn("proxy_observation_refresh_failed", "class", c.lastError)
			} else {
				c.lastGood = out
				c.lastError = ""
				known := 0
				for _, probe := range out.Probes {
					if probe.State == "healthy" || probe.State == "unhealthy" {
						known++
					}
				}
				slog.Info("proxy_observation_refresh_completed", "known_probes", known, "total_probes", len(out.Probes), "duration_ms", time.Since(started).Milliseconds())
			}
			c.inFlight = nil
			close(done)
			c.mu.Unlock()
		}()
	}
	c.mu.Unlock()
	select {
	case <-ctx.Done():
		return providers.ProxyExternalObservation{}, ctx.Err()
	case <-done:
		c.mu.Lock()
		out := c.resultLocked(c.now())
		c.mu.Unlock()
		return out, nil
	}
}

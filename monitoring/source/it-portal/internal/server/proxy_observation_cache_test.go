package server

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"pl/portal/internal/providers"
)

func cachedProxySample(at time.Time) providers.ProxyExternalObservation {
	out := providers.EmptyProxyExternal(at, "")
	out.Probes[0].State = "healthy"
	out.Probes[0].ObservedAt = &at
	out.Probes[0].LastSuccess = &at
	ratio := 1.0
	out.Probes[0].SuccessRatio = &ratio
	out.Probes[0].ObservedCycles = 5
	out.Probes[0].SuccessfulCycles = 5
	return out
}
func TestProxyObservationCanceledCallerCannotPoisonSharedRefresh(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	load := func(ctx context.Context) (providers.ProxyExternalObservation, error) {
		calls.Add(1)
		close(started)
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) > 15*time.Second {
			t.Error("shared refresh lacks bounded deadline")
		}
		select {
		case <-release:
			return cachedProxySample(time.Now()), nil
		case <-ctx.Done():
			return providers.ProxyExternalObservation{}, ctx.Err()
		}
	}
	cache := proxyObservationCache{load: load, now: time.Now}
	ctx, cancel := context.WithCancel(context.Background())
	canceled := make(chan error, 1)
	go func() { _, err := cache.get(ctx); canceled <- err }()
	<-started
	cancel()
	if err := <-canceled; !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	follower := make(chan providers.ProxyExternalObservation, 1)
	go func() { out, _ := cache.get(context.Background()); follower <- out }()
	close(release)
	out := <-follower
	if calls.Load() != 1 || out.Error != "" || out.Probes[0].State != "healthy" {
		t.Fatal(calls.Load(), out)
	}
	out, _ = cache.get(context.Background())
	if calls.Load() != 1 || out.Error != "" {
		t.Fatal("cancellation published a shared error", out)
	}
}
func TestProxyObservationFailureRetainsStaleSnapshotThenRecovers(t *testing.T) {
	var seconds atomic.Int64
	seconds.Store(1000)
	now := func() time.Time { return time.Unix(seconds.Load(), 0) }
	var failing atomic.Bool
	var calls atomic.Int32
	cache := proxyObservationCache{now: now, load: func(context.Context) (providers.ProxyExternalObservation, error) {
		calls.Add(1)
		if failing.Load() {
			return providers.ProxyExternalObservation{}, providers.ErrBrowseUnavailable
		}
		return cachedProxySample(now()), nil
	}}
	good, err := cache.get(context.Background())
	if err != nil || good.Error != "" {
		t.Fatal(good, err)
	}
	failing.Store(true)
	seconds.Store(1021)
	stale, _ := cache.get(context.Background())
	if stale.Error != "source_unavailable" || stale.Probes[0].State != "stale" || stale.Probes[0].LastSuccess == nil || stale.ObservedAt != good.ObservedAt || stale.Probes[0].SuccessRatio == nil {
		t.Fatal(stale)
	}
	if good.Probes[0].State != "healthy" {
		t.Fatal("last-good slice mutated")
	}
	_, _ = cache.get(context.Background())
	if calls.Load() != 2 {
		t.Fatal("failure retry is not bounded")
	}
	failing.Store(false)
	seconds.Store(1027)
	recovered, _ := cache.get(context.Background())
	if recovered.Error != "" || recovered.Probes[0].State != "healthy" || recovered.ObservedAt.Unix() != 1027 || calls.Load() != 3 {
		t.Fatal(recovered)
	}
}
func TestProxyObservationRetainedSnapshotExpiresWithoutAnotherFetch(t *testing.T) {
	var seconds atomic.Int64
	seconds.Store(1000)
	now := func() time.Time { return time.Unix(seconds.Load(), 0) }
	cache := proxyObservationCache{now: now, load: func(context.Context) (providers.ProxyExternalObservation, error) {
		if seconds.Load() > 1000 {
			return providers.ProxyExternalObservation{}, context.DeadlineExceeded
		}
		return cachedProxySample(now()), nil
	}}
	_, _ = cache.get(context.Background())
	seconds.Store(1179)
	out, _ := cache.get(context.Background())
	if out.Error != "refresh_timeout" || out.Probes[0].State != "stale" {
		t.Fatal(out)
	}
	// The error cache is still younger than 5s, but the last-good data is >180s.
	seconds.Store(1181)
	out, _ = cache.get(context.Background())
	if out.Probes[0].State != "unknown" || out.Probes[0].ObservedAt != nil || out.Probes[0].LastSuccess != nil || out.Probes[0].SuccessRatio != nil {
		t.Fatal("expired last-good still presented", out)
	}
}

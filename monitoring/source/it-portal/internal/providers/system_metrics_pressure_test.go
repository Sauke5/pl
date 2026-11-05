package providers

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"pl/portal/internal/model"
)

// Exercise the released nine-system workspace and the same four workers per
// snapshot as the API. Holding the first source wave makes overload deterministic.
func TestSystemMetricNineSystemsShareBrowseCapacity(t *testing.T) {
	// Keep the production workload shape (nine systems, five bindings each)
	// without importing site inventory or depending on a release deployment file.
	var systems []model.System
	for n := 0; n < 9; n++ {
		system := model.System{Name: fmt.Sprintf("System %d", n)}
		for _, key := range []string{"target.up", "rds.cpu", "rds.memory", "windows.disk_free", "disk.available"} {
			system.Metrics = append(system.Metrics, model.SystemMetricBinding{ID: key, Metric: key, Labels: map[string]string{"instance": fmt.Sprintf("host-%d", n)}})
		}
		systems = append(systems, system)
	}
	now := time.Now().UTC()
	var calls, active, peak atomic.Int32
	firstWave := make(chan struct{})
	release := make(chan struct{})
	var once, releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	r := registry(t, func(w http.ResponseWriter, q *http.Request) {
		n := active.Add(1)
		defer active.Add(-1)
		for old := peak.Load(); n > old && !peak.CompareAndSwap(old, n); old = peak.Load() {
		}
		count := calls.Add(1)
		if count <= 4 {
			if count == 4 {
				once.Do(func() { close(firstWave) })
			}
			<-release
		}
		time.Sleep(5 * time.Millisecond)
		if q.URL.Path == "/api/v1/targets" {
			fmt.Fprint(w, `{"status":"success","data":{"activeTargets":[]}}`)
			return
		}
		value := "1"
		if strings.HasPrefix(q.URL.Query().Get("query"), "min(timestamp(") {
			value = fmt.Sprint(now.Unix())
		}
		fmt.Fprintf(w, `{"status":"success","data":{"resultType":"vector","result":[{"metric":{},"value":[%d,%q]}]}}`, now.Unix(), value)
	})
	t.Cleanup(unblock)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	i := model.Integration{ID: "monitoring", Kind: "prometheus", Enabled: true, URL: "http://source"}
	var pending sync.WaitGroup
	var metrics atomic.Int32
	start := make(chan struct{})
	for _, system := range systems {
		pending.Add(1)
		go func() {
			defer pending.Done()
			<-start
			workers := make(chan struct{}, 4)
			var bindings sync.WaitGroup
			for _, binding := range system.Metrics {
				bindings.Add(1)
				go func() {
					defer bindings.Done()
					workers <- struct{}{}
					defer func() { <-workers }()
					out := r.SystemMetric(ctx, i, binding, now)
					metrics.Add(1)
					if out.State != "fresh" {
						t.Errorf("%s/%s: %s %s", system.Name, binding.Metric, out.State, out.Error)
					}
				}()
			}
			bindings.Wait()
		}()
	}
	close(start)
	select {
	case <-firstWave:
	case <-time.After(3 * time.Second):
		t.Fatal("first wave did not start")
	}
	// Concurrent ordinary browsing still uses the original shared cap.
	pending.Add(1)
	go func() {
		defer pending.Done()
		if _, err := r.PrometheusOptions(ctx, i, "", ""); err != nil {
			t.Error(err)
		}
	}()
	// Allow the 25 snapshot workers to reach admission before completing sources.
	deadline := time.Now().Add(time.Second)
	for len(systemMetricWaiters) < 20 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	unblock()
	pending.Wait()
	if metrics.Load() != 45 || calls.Load() != 91 {
		t.Fatalf("metrics=%d requests=%d (45 x 2 + browse)", metrics.Load(), calls.Load())
	}
	if peak.Load() > 4 {
		t.Fatalf("transport cap exceeded: %d", peak.Load())
	}
	if len(systemMetricWaiters) != 0 || len(systemMetricSlots) != 0 || len(browseSlots) != 0 || len(browseWaiters) != 0 {
		t.Fatal("admission leaked")
	}
}

func TestSystemMetricQueueCancellationAndLimits(t *testing.T) {
	for range cap(systemMetricSlots) {
		systemMetricSlots <- struct{}{}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, _, err := systemMetricContext(ctx)
	if !errors.Is(err, ErrBrowseUnavailable) {
		t.Fatal(err)
	}
	if len(systemMetricWaiters) != 0 {
		t.Fatal("cancelled waiter leaked")
	}
	for range cap(systemMetricSlots) {
		<-systemMetricSlots
	}
	for range cap(systemMetricWaiters) {
		systemMetricWaiters <- struct{}{}
	}
	_, _, err = systemMetricContext(context.Background())
	for range cap(systemMetricWaiters) {
		<-systemMetricWaiters
	}
	if !errors.Is(err, ErrBrowseBusy) {
		t.Fatal("unbounded admission", err)
	}
}

func TestSystemMetricSourceFailureAndCancellationRemainErrors(t *testing.T) {
	now := time.Now()
	i := model.Integration{Kind: "prometheus", Enabled: true, URL: "http://source"}
	b := model.SystemMetricBinding{Metric: "rds.memory", Labels: map[string]string{"instance": "host"}}
	for _, status := range []int{http.StatusServiceUnavailable, http.StatusTooManyRequests} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			var calls atomic.Int32
			r := registry(t, func(w http.ResponseWriter, q *http.Request) {
				if calls.Add(1) == 1 {
					w.WriteHeader(status)
					return
				}
				fmt.Fprint(w, `{"status":"success","data":{"resultType":"vector","result":[]}}`)
			})
			out := r.SystemMetric(context.Background(), i, b, now)
			if out.State != "error" || len(out.Samples) != 0 {
				t.Fatal(out)
			}
			// Transient failure is not cached; the next request reaches the source.
			out = r.SystemMetric(context.Background(), i, b, now)
			if out.State != "no_data" || calls.Load() != 2 {
				t.Fatal(out, calls.Load())
			}
		})
	}
	var calls atomic.Int32
	r := registry(t, func(w http.ResponseWriter, q *http.Request) { calls.Add(1); <-q.Context().Done() })
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	out := r.SystemMetric(ctx, i, b, now)
	if out.State != "error" || len(out.Samples) != 0 {
		t.Fatal(out)
	}
	cancelled, stop := context.WithCancel(context.Background())
	stop()
	out = r.SystemMetric(cancelled, i, b, now)
	if out.State != "error" || calls.Load() != 1 {
		t.Fatal(out, calls.Load())
	}
	if len(systemMetricWaiters) != 0 || len(systemMetricSlots) != 0 || len(browseSlots) != 0 || len(browseWaiters) != 0 {
		t.Fatal("timeout/cancellation leaked admission")
	}
}

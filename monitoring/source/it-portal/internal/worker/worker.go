package worker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/providers"
	"pl/portal/internal/store"
)

type Worker struct {
	pollLocks sync.Map
	pollSlots chan struct{}
	pollWG    sync.WaitGroup
	Modules   interface {
		Execute(context.Context, model.Job) (map[string]any, error)
	}
	Store     *store.Store
	Providers *providers.Registry
	Notify    func(string)
	mu        sync.Mutex
	failures  map[string]int
	next      map[string]time.Time
	running   map[string]bool
}

func New(s *store.Store, p *providers.Registry, notify func(string)) *Worker {
	return &Worker{pollSlots: make(chan struct{}, 4), Store: s, Providers: p, Notify: notify, failures: map[string]int{}, next: map[string]time.Time{}, running: map[string]bool{}}
}
func (w *Worker) Run(ctx context.Context) {
	// One scheduler/recovery owner per database, held for the lifetime of a dedicated connection.
	for ctx.Err() == nil {
		conn, e := w.Store.Pool.Acquire(ctx)
		if e != nil {
			return
		}
		var owner bool
		e = conn.QueryRow(ctx, "SELECT pg_try_advisory_lock(7398216)").Scan(&owner)
		if e != nil || !owner {
			conn.Release()
			select {
			case <-ctx.Done():
				return
			case <-time.After(3 * time.Second):
				continue
			}
		}
		if e = w.Store.Recover(ctx); e != nil {
			slog.Error("worker_recovery_failed")
			_, _ = conn.Exec(context.Background(), "SELECT pg_advisory_unlock(7398216)")
			conn.Release()
			return
		}
		leaderCtx, cancelLeader := context.WithCancel(ctx)
		tick := time.NewTicker(time.Second)
		var wg sync.WaitGroup
		// Health slots cannot be consumed by installs or other durable work.
		// Keep the total execution limit at four, including when one lane is idle.
		lanes := []struct {
			health bool
			slots  chan struct{}
		}{
			{true, make(chan struct{}, 2)},
			{false, make(chan struct{}, 2)},
		}
	loop:
		for {
			select {
			case <-ctx.Done():
				break loop
			case <-tick.C:
				if e = conn.Ping(ctx); e != nil {
					break loop
				}
				w.schedule(leaderCtx)
				for _, lane := range lanes {
				dispatch:
					for n := 0; n < cap(lane.slots); n++ {
						select {
						case lane.slots <- struct{}{}:
							j, err := w.Store.ClaimLane(leaderCtx, lane.health)
							if err != nil {
								<-lane.slots
								if !errors.Is(err, store.ErrNotFound) && leaderCtx.Err() == nil {
									slog.Error("job_claim_failed", "module_health", lane.health)
								}
								break dispatch
							}
							wg.Add(1)
							go func(slots chan struct{}, job model.Job) {
								defer wg.Done()
								defer func() { <-slots }()
								w.execute(leaderCtx, job)
							}(lane.slots, j)
						default:
							break dispatch
						}
					}
				}
			}
		}
		tick.Stop()
		cancelLeader()
		wg.Wait()
		w.pollWG.Wait()
		_, _ = conn.Exec(context.Background(), "SELECT pg_advisory_unlock(7398216)")
		conn.Release()
	}
}
func (w *Worker) schedule(ctx context.Context) {
	if scheduler, ok := w.Modules.(interface{ Schedule(context.Context) }); ok {
		scheduler.Schedule(ctx)
	}
	integrations, e := store.List[model.Integration](ctx, w.Store, "integration")
	if e != nil {
		return
	}
	now := time.Now()
	for _, i := range integrations {
		if i.Kind == "mailcow" {
			w.scheduleMailcow(ctx, i)
			continue
		}
		// Managed modules own their serialized refresh jobs and snapshots. A second
		// integration poller could race a disable/remove or publish older data.
		if !i.Enabled || i.ManagedModuleID != "" {
			continue
		}
		w.mu.Lock()
		due := !w.running[i.ID] && !now.Before(w.next[i.ID])
		if due {
			w.running[i.ID] = true
		}
		w.mu.Unlock()
		if !due {
			continue
		}
		release, ok := w.acquirePoll(ctx, i.ID, false)
		if !ok {
			w.mu.Lock()
			w.running[i.ID] = false
			w.mu.Unlock()
			continue
		}
		w.pollWG.Add(1)
		go func(i model.Integration) {
			defer w.pollWG.Done()
			defer release()
			defer func() { w.mu.Lock(); w.running[i.ID] = false; w.mu.Unlock() }()
			_ = w.pollAcquired(ctx, i)
		}(i)
	}
	resources, e := store.List[model.Resource](ctx, w.Store, "resource")
	if e != nil {
		return
	}
	for _, r := range resources {
		if r.Lifecycle != "active" || !store.Contains([]string{"dns", "tcp", "http", "tls"}, r.Check.Kind) || r.Check.IntervalSeconds < 30 {
			continue
		}
		target := providers.ResourceCheckTarget(r)
		if providers.ValidateCheckTarget(r.Check.Kind, target) != nil {
			continue
		}
		key := "check:" + r.ID
		w.mu.Lock()
		due := !now.Before(w.next[key])
		if due {
			w.next[key] = now.Add(time.Duration(r.Check.IntervalSeconds) * time.Second)
		}
		w.mu.Unlock()
		if due {
			_, e = w.Store.Enqueue(ctx, model.Job{Kind: "check", ResourceID: r.ID, Parameters: map[string]any{"kind": r.Check.Kind, "target": target}, IdempotencyKey: key + ":" + now.UTC().Format("20060102150405"), Actor: "system"})
			if e == nil {
				w.Notify("jobs")
			}
		}
	}
}

// At most four integration polls globally and exactly one snapshot per source.
// Snapshot APIs do not benefit from intra-source concurrency: older responses
// must never overwrite newer snapshots. Manual refresh uses the same limits.
func (w *Worker) acquirePoll(ctx context.Context, id string, wait bool) (func(), bool) {
	value, _ := w.pollLocks.LoadOrStore(id, make(chan struct{}, 1))
	source := value.(chan struct{})
	acquire := func(ch chan struct{}) bool {
		if ctx.Err() != nil {
			return false
		}
		if wait {
			select {
			case ch <- struct{}{}:
				return true
			case <-ctx.Done():
				return false
			}
		}
		select {
		case ch <- struct{}{}:
			return true
		default:
			return false
		}
	}
	if !acquire(source) {
		return nil, false
	}
	if !acquire(w.pollSlots) {
		<-source
		return nil, false
	}
	return func() { <-w.pollSlots; <-source }, true
}
func (w *Worker) poll(ctx context.Context, i model.Integration) error {
	release, ok := w.acquirePoll(ctx, i.ID, true)
	if !ok {
		return ctx.Err()
	}
	defer release()
	return w.pollAcquired(ctx, i)
}
func (w *Worker) pollAcquired(parent context.Context, i model.Integration) error {
	if i.ManagedModuleID != "" {
		return errors.New("module_refresh_required")
	}
	if !i.Enabled {
		return errors.New("integration_disabled")
	}
	ctx := parent
	timeout := time.Duration(i.TimeoutSeconds) * time.Second
	if timeout < time.Second {
		timeout = 10 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	snapshot, e := w.Providers.Poll(ctx, i)
	// A source timeout is persisted; shutdown/lease loss cancellation is not a source outage.
	if parent.Err() != nil {
		return parent.Err()
	}
	persistCtx, persistCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer persistCancel()
	if applyErr := w.Store.ApplySnapshot(persistCtx, i, snapshot, e); applyErr != nil {
		if !errors.Is(applyErr, store.ErrConflict) {
			slog.Error("snapshot_save_failed")
		}
		return applyErr
	}
	w.mu.Lock()
	delay := time.Duration(i.PollSeconds) * time.Second
	if e != nil {
		w.failures[i.ID]++
		n := min(w.failures[i.ID], 6)
		// Cap error backoff, never the administrator's successful poll interval.
		// Long base intervals still back off once rather than accelerating on error.
		capDelay := max(30*time.Minute, 2*delay)
		delay = min(delay*time.Duration(1<<n), capDelay)
	} else {
		w.failures[i.ID] = 0
	}
	w.next[i.ID] = time.Now().Add(delay)
	w.mu.Unlock()
	w.Notify("all")
	return e
}
func (w *Worker) execute(ctx context.Context, j model.Job) {
	parent := ctx
	timeout := 60 * time.Second
	if j.Kind == "module" {
		timeout = w.moduleJobTimeout(ctx, j)
	}
	if j.Kind == "report" {
		timeout = 300 * time.Second
	}
	if j.Kind == "restart" {
		timeout = 120 * time.Second
	}
	taskCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var resource *model.Resource
	var integration *model.Integration
	var err error
	if j.ResourceID != "" {
		v, e := store.Get[model.Resource](taskCtx, w.Store, "resource", j.ResourceID)
		err = e
		resource = &v
	}
	if j.IntegrationID != "" {
		v, e := store.Get[model.Integration](taskCtx, w.Store, "integration", j.IntegrationID)
		if e != nil {
			err = e
		}
		integration = &v
		if !v.Enabled {
			err = errors.New("integration_disabled")
		}
	}
	if j.Kind == "restart" && (resource == nil || resource.Lifecycle != "active" || !store.Contains(resource.Operations, "restart") || resource.ExecutorTarget != j.Parameters["executor_target"]) {
		err = errors.New("restart_permission_changed")
	}
	if err == nil {
		if j.Kind == "module" {
			if w.Modules == nil {
				err = errors.New("module_controller_unavailable")
			} else {
				j.Result, err = w.Modules.Execute(taskCtx, j)
			}
		} else if j.Kind == "refresh" && integration != nil {
			err = w.poll(taskCtx, *integration)
			j.Result = map[string]any{"refreshed": err == nil}
		} else {
			j.Result, err = w.Providers.Execute(taskCtx, j, resource, integration)
		}
	}
	if j.Kind == "enrich" && err == nil {
		target, _ := j.Parameters["target"].(string)
		resources, e := store.List[model.Resource](taskCtx, w.Store, "resource")
		if e == nil {
			duplicates := []map[string]string{}
			for _, r := range resources {
				if r.URL == target && r.ID != j.ResourceID {
					duplicates = append(duplicates, map[string]string{"id": r.ID, "name": r.Name})
				}
			}
			j.Result["possible_duplicates"] = duplicates
		}
	}
	j.Status = "succeeded"
	if err != nil {
		j.Status = "failed"
		j.Error = "Операция не выполнена. Проверьте цель, настройки и доступность источника."
		if j.Kind == "module" {
			j.Error = "Модуль не подтвердил выполнение операции; подробности в состоянии экземпляра."
		}
		if j.Kind == "check" || j.Kind == "enrich" {
			j.Error = providers.CheckErrorMessage(err)
		}
		if errors.Is(err, providers.ErrUnknown) || ((j.Kind == "restart" || j.Kind == "report" || j.Kind == "module") && (errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled))) {
			j.Status = "unknown"
			j.Error = "Результат операции неизвестен. Автоматический повтор запрещён; проверьте состояние в источнике."
		}
	}
	if j.Result == nil {
		j.Result = map[string]any{}
	}
	if j.Kind == "restart" && err == nil && resource != nil && store.Contains([]string{"dns", "tcp", "http", "tls"}, resource.Check.Kind) {
		// The Docker result and endpoint verification are independent durable jobs.
		// A failed check must never rewrite the result of the completed restart.
		target := providers.ResourceCheckTarget(*resource)
		if providers.ValidateCheckTarget(resource.Check.Kind, target) != nil {
			j.Result["post_check_warning"] = "Последующая проверка не поставлена в очередь: укажите корректную цель проверки."
		} else {
			checkCtx, checkCancel := context.WithTimeout(context.Background(), 5*time.Second)
			check, checkErr := w.Store.Enqueue(checkCtx, model.Job{
				Kind: "check", ResourceID: resource.ID, Actor: j.Actor,
				IdempotencyKey: "post-restart:" + j.ID,
				Parameters:     map[string]any{"kind": resource.Check.Kind, "target": target},
			})
			checkCancel()
			if checkErr != nil {
				j.Result["post_check_warning"] = "Последующая проверка не поставлена в очередь. Запустите её вручную."
				slog.Error("post_restart_check_enqueue_failed", "job_id", j.ID)
			} else {
				j.Result["post_check_job_id"] = check.ID
			}
		}
	}
	_ = w.finishJob(parent, j)
	w.Notify("all")
}

// Retry only this already-computed result. A provider/controller must never be
// executed again because its terminal transaction lost a connection or timed out.
func (w *Worker) finishJob(parent context.Context, j model.Job) error {
	delay := 2 * time.Second
	for attempt := 1; ; attempt++ {
		if attempt > 1 && parent.Err() != nil {
			return parent.Err()
		}
		// Preserve the first shutdown flush even if service cancellation arrived
		// during execution. Later attempts stop with the service, not the job timeout.
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		stop := func() bool { return false }
		if attempt > 1 {
			stop = context.AfterFunc(parent, cancel)
		}
		err := w.Store.Finish(ctx, j)
		stop()
		cancel()
		if err == nil {
			return nil
		}
		retry := parent.Err() == nil && !errors.Is(err, store.ErrNotFound) && !errors.Is(err, store.ErrConflict) && !errors.Is(err, store.ErrInvalid)
		state, errorType := finishErrorInfo(err)
		slog.Error("job_finish_failed", "job_id", j.ID, "attempt", attempt, "sqlstate", state, "error_type", errorType, "retry", retry)
		if !retry {
			return err
		}
		wait := time.NewTimer(delay)
		select {
		case <-parent.Done():
			wait.Stop()
			return parent.Err()
		case <-wait.C:
		}
		delay = min(2*delay, 30*time.Second)
	}
}

func finishErrorInfo(err error) (string, string) {
	state := ""
	var sqlError interface{ SQLState() string }
	if errors.As(err, &sqlError) {
		code := sqlError.SQLState()
		if len(code) == 5 {
			valid := true
			for _, c := range code {
				valid = valid && (c >= 'A' && c <= 'Z' || c >= '0' && c <= '9')
			}
			if valid {
				state = code
			}
		}
	}
	return state, fmt.Sprintf("%T", err)
}

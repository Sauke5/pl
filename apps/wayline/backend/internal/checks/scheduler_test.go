package checks

import (
	"context"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"wayline.local/backend/internal/targets"
)

type targetListerStub struct{ items []targets.Target }

func (s targetListerStub) List(context.Context) ([]targets.Target, error) { return s.items, nil }

type scheduleRepositoryStub struct {
	runRepositoryStub
	last map[int64]*time.Time
}

func (s *scheduleRepositoryStub) LastFinishedAt(_ context.Context, id int64, _ string) (*time.Time, error) {
	return s.last[id], nil
}

type scheduleRunnerStub struct {
	mu      sync.Mutex
	ids     []int64
	release chan struct{}
}

func (s *scheduleRunnerStub) Run(ctx context.Context, id int64, _ string) (Run, error) {
	s.mu.Lock()
	s.ids = append(s.ids, id)
	s.mu.Unlock()
	if s.release != nil {
		select {
		case <-s.release:
		case <-ctx.Done():
			return Run{}, ctx.Err()
		}
	}
	return Run{}, nil
}

func TestSchedulerSkipsDisabledAndNotDueTargets(t *testing.T) {
	now := time.Now()
	later := now.Add(-10 * time.Second)
	lister := targetListerStub{[]targets.Target{{ID: 1, Enabled: false, IntervalSeconds: 30}, {ID: 2, Enabled: true, IntervalSeconds: 60}, {ID: 3, Enabled: true, IntervalSeconds: 60}}}
	repository := &scheduleRepositoryStub{last: map[int64]*time.Time{2: &later}}
	runner := &scheduleRunnerStub{}
	scheduler := NewScheduler(lister, repository, runner, slog.New(slog.NewTextHandler(io.Discard, nil)), 2)
	scheduler.now = func() time.Time { return now }
	scheduler.tick(context.Background())
	scheduler.wg.Wait()
	runner.mu.Lock()
	defer runner.mu.Unlock()
	if len(runner.ids) != 1 || runner.ids[0] != 3 {
		t.Fatalf("run IDs = %#v", runner.ids)
	}
}

func TestSchedulerMeasuresIntervalFromLongRunFinish(t *testing.T) {
	now := time.Now()
	// Проверка с 50 пакетами могла начаться заметно раньше, но завершилась
	// только 10 секунд назад. Новый интервал начинается именно с завершения.
	finished := now.Add(-10 * time.Second)
	repository := &scheduleRepositoryStub{last: map[int64]*time.Time{1: &finished}}
	runner := &scheduleRunnerStub{}
	scheduler := NewScheduler(targetListerStub{[]targets.Target{{ID: 1, Enabled: true, IntervalSeconds: 30, PacketCount: 50}}}, repository, runner, nil, 1)
	scheduler.now = func() time.Time { return now }
	scheduler.tick(context.Background())
	scheduler.wg.Wait()
	if len(runner.ids) != 0 {
		t.Fatalf("runs = %#v, want no immediate rerun after finish", runner.ids)
	}
}

func TestSchedulerConcurrencyIsBoundedWithoutBlockingTick(t *testing.T) {
	release := make(chan struct{})
	runner := &scheduleRunnerStub{release: release}
	scheduler := NewScheduler(targetListerStub{[]targets.Target{{ID: 1, Enabled: true}, {ID: 2, Enabled: true}}}, &scheduleRepositoryStub{last: map[int64]*time.Time{}}, runner, nil, 1)
	completed := make(chan struct{})
	go func() { scheduler.tick(context.Background()); close(completed) }()
	select {
	case <-completed:
	case <-time.After(time.Second):
		t.Fatal("tick заблокирован занятым worker")
	}
	close(release)
	scheduler.wg.Wait()
	runner.mu.Lock()
	defer runner.mu.Unlock()
	if len(runner.ids) != 1 {
		t.Fatalf("runs = %#v, want one bounded run", runner.ids)
	}
}

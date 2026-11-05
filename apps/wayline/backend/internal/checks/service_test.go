package checks

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"wayline.local/backend/internal/targets"
)

type targetReaderStub struct{ items map[int64]targets.Target }

func (s targetReaderStub) Get(_ context.Context, id int64) (targets.Target, error) {
	item, ok := s.items[id]
	if !ok {
		return targets.Target{}, targets.ErrNotFound
	}
	return item, nil
}

type runRepositoryStub struct {
	mu   sync.Mutex
	runs []Run
}

func (s *runRepositoryStub) Save(_ context.Context, run Run) (Run, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	run.ID = int64(len(s.runs) + 1)
	s.runs = append(s.runs, run)
	return run, nil
}
func (*runRepositoryStub) List(context.Context, *int64, *string, int) ([]Run, error) { return nil, nil }
func (*runRepositoryStub) Latest(context.Context, *string) ([]Run, error)            { return nil, nil }
func (*runRepositoryStub) Get(context.Context, int64) (Run, error)                   { return Run{}, ErrNotFound }
func (*runRepositoryStub) LastFinishedAt(context.Context, int64, string) (*time.Time, error) {
	return nil, nil
}
func (*runRepositoryStub) CleanupBefore(context.Context, time.Time) (int64, error) { return 0, nil }
func (*runRepositoryStub) Metrics(context.Context) (Metrics, error)                { return Metrics{}, nil }

type executorStub struct {
	path         Result
	pathErr      error
	iperfStarted chan struct{}
	release      chan struct{}
	lastIperf    ProbeTarget
}

func testFloat(value float64) *float64 { return &value }

func (s *executorStub) Path(context.Context, ProbeTarget) (Result, error) {
	return s.path, s.pathErr
}
func (s *executorStub) Iperf(ctx context.Context, target ProbeTarget) (Result, error) {
	s.lastIperf = target
	if s.iperfStarted != nil {
		s.iperfStarted <- struct{}{}
	}
	if s.release != nil {
		select {
		case <-s.release:
		case <-ctx.Done():
			return Result{}, ctx.Err()
		}
	}
	return Result{ThroughputBPS: testFloat(1)}, nil
}

func TestServiceIperfDirectionAndBackwardCompatibleDefault(t *testing.T) {
	executor := &executorStub{}
	reader := targetReaderStub{map[int64]targets.Target{1: {ID: 1, Enabled: true, IperfEnabled: true, IperfDurationSeconds: 5}}}
	service := NewService(reader, &runRepositoryStub{}, NewLocalDispatcher(executor))
	run, err := service.RunDirection(context.Background(), 1, KindIperf, DirectionDownload)
	if err != nil || run.Direction != DirectionDownload || executor.lastIperf.IperfDirection != DirectionDownload {
		t.Fatalf("download Run() = %#v, target=%#v, error=%v", run, executor.lastIperf, err)
	}
	run, err = service.Run(context.Background(), 1, KindIperf)
	if err != nil || run.Direction != DirectionUpload || executor.lastIperf.IperfDirection != DirectionUpload {
		t.Fatalf("legacy Run() = %#v, target=%#v, error=%v", run, executor.lastIperf, err)
	}
	if _, err := service.RunDirection(context.Background(), 1, KindIperf, "sideways"); !errors.Is(err, ErrInvalidDirection) {
		t.Fatalf("invalid direction error = %v", err)
	}
}

func TestServiceClassifiesAndPersistsDegradedPath(t *testing.T) {
	loss := 5.0
	repository := &runRepositoryStub{}
	service := NewService(targetReaderStub{map[int64]targets.Target{1: {ID: 1, Enabled: true, ExecutionType: "local", LossThresholdPercent: 2}}}, repository, NewLocalDispatcher(&executorStub{path: Result{LossPercent: &loss}}))
	run, err := service.Run(context.Background(), 1, KindPath)
	if err != nil || run.Status != StatusDegraded || run.ID != 1 {
		t.Fatalf("Run() = %#v, %v", run, err)
	}
}

func TestServicePersistsSafeFailedRun(t *testing.T) {
	repository := &runRepositoryStub{}
	service := NewService(targetReaderStub{map[int64]targets.Target{1: {ID: 1, Enabled: true, ExecutionType: "local"}}}, repository, NewLocalDispatcher(&executorStub{pathErr: errors.New("MTR временно недоступен")}))
	run, err := service.Run(context.Background(), 1, KindPath)
	if err != nil || run.Status != StatusFailed || run.ErrorMessage != "MTR временно недоступен" {
		t.Fatalf("Run() = %#v, %v", run, err)
	}
}

func TestServiceAllowsOnlyOneGlobalIperf(t *testing.T) {
	started, release := make(chan struct{}, 2), make(chan struct{})
	executor := &executorStub{iperfStarted: started, release: release}
	reader := targetReaderStub{map[int64]targets.Target{1: {ID: 1, Enabled: true, IperfEnabled: true, IperfDurationSeconds: 5}, 2: {ID: 2, Enabled: true, IperfEnabled: true, IperfDurationSeconds: 5}}}
	service := NewService(reader, &runRepositoryStub{}, NewLocalDispatcher(executor))
	done := make(chan error, 1)
	go func() { _, err := service.Run(context.Background(), 1, KindIperf); done <- err }()
	<-started
	if _, err := service.Run(context.Background(), 2, KindIperf); !errors.Is(err, ErrAlreadyRunning) {
		t.Fatalf("second Run() error = %v", err)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatalf("first Run() error = %v", err)
	}
}

func TestServiceRejectsManualRunForDisabledTarget(t *testing.T) {
	service := NewService(targetReaderStub{map[int64]targets.Target{1: {ID: 1, Enabled: false}}}, &runRepositoryStub{}, NewLocalDispatcher(&executorStub{}))
	if _, err := service.Run(context.Background(), 1, KindPath); !errors.Is(err, ErrTargetDisabled) {
		t.Fatalf("Run() error = %v, want ErrTargetDisabled", err)
	}
}

package checks

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"sync"
	"time"

	"wayline.local/backend/internal/targets"
)

var (
	ErrInvalidKind      = errors.New("доступные виды проверок: path или iperf")
	ErrInvalidDirection = errors.New("доступные направления iperf3: download или upload")
	ErrIperfDisabled    = errors.New("проверка iperf3 для цели выключена")
	ErrTargetDisabled   = errors.New("цель выключена")
	ErrAlreadyRunning   = errors.New("проверка этого вида уже выполняется")
)

type TargetReader interface {
	Get(context.Context, int64) (targets.Target, error)
}

type ProbeExecutor interface {
	Path(context.Context, ProbeTarget) (Result, error)
	Iperf(context.Context, ProbeTarget) (Result, error)
}

type DispatchResult struct {
	Result        Result
	ExecutionType string
	ExecutionID   *string
}

type Dispatcher interface {
	Dispatch(context.Context, ProbeTarget, string) (DispatchResult, error)
}

// LocalDispatcher — текущая реализация execution abstraction. Remote agent
// позже сможет реализовать Dispatcher без изменения Service и Scheduler.
type LocalDispatcher struct{ executor ProbeExecutor }

func NewLocalDispatcher(executor ProbeExecutor) *LocalDispatcher {
	return &LocalDispatcher{executor: executor}
}

func (d *LocalDispatcher) Dispatch(ctx context.Context, target ProbeTarget, kind string) (DispatchResult, error) {
	var result Result
	var err error
	if kind == KindPath {
		result, err = d.executor.Path(ctx, target)
	} else {
		result, err = d.executor.Iperf(ctx, target)
	}
	return DispatchResult{Result: result, ExecutionType: "local"}, err
}

type Service struct {
	targets    TargetReader
	runs       Repository
	dispatcher Dispatcher
	mu         sync.Mutex
	active     map[string]struct{}
}

func NewService(targets TargetReader, runs Repository, dispatcher Dispatcher) *Service {
	return &Service{targets: targets, runs: runs, dispatcher: dispatcher, active: make(map[string]struct{})}
}

func (s *Service) Run(ctx context.Context, targetID int64, kind string) (Run, error) {
	return s.RunDirection(ctx, targetID, kind, "")
}

// RunDirection выполняет проверку с явным направлением iperf3. Пустое
// направление сохраняет поведение старых клиентов: обычный upload-тест.
func (s *Service) RunDirection(ctx context.Context, targetID int64, kind, direction string) (Run, error) {
	if kind != KindPath && kind != KindIperf {
		return Run{}, ErrInvalidKind
	}
	if kind == KindPath {
		if direction != "" {
			return Run{}, ErrInvalidDirection
		}
	} else {
		if direction == "" {
			direction = DirectionUpload
		}
		if direction != DirectionDownload && direction != DirectionUpload {
			return Run{}, ErrInvalidDirection
		}
	}
	target, err := s.targets.Get(ctx, targetID)
	if err != nil {
		return Run{}, err
	}
	if !target.Enabled {
		return Run{}, ErrTargetDisabled
	}
	if kind == KindIperf && !target.IperfEnabled {
		return Run{}, ErrIperfDisabled
	}
	key := stringKey(targetID, kind)
	if kind == KindIperf {
		// Один сервер iperf3 обслуживает один тест за раз. Глобальная блокировка
		// исключает взаимное искажение ручных измерений разных целей.
		key = "iperf:global"
	}
	if !s.acquire(key) {
		return Run{}, ErrAlreadyRunning
	}
	defer s.release(key)

	timeout := pathTimeout(target)
	if kind == KindIperf {
		timeout = time.Duration(target.IperfDurationSeconds+10) * time.Second
	}
	probeCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	started := time.Now().UTC()
	probeTarget := ProbeTarget{Host: target.Host, ProbeMode: target.ProbeMode, ProbePort: target.ProbePort,
		PacketCount: target.PacketCount, IperfEnabled: target.IperfEnabled, IperfHost: target.IperfHost,
		IperfPort: target.IperfPort, IperfDurationSeconds: target.IperfDurationSeconds, IperfDirection: direction}
	dispatched, err := s.dispatcher.Dispatch(probeCtx, probeTarget, kind)
	result := dispatched.Result
	finished := time.Now().UTC()
	executionType := dispatched.ExecutionType
	if executionType == "" {
		executionType = target.ExecutionType
	}
	run := Run{TargetID: targetID, Kind: kind, Direction: direction, ExecutionType: executionType, ExecutionID: dispatched.ExecutionID,
		Status: StatusSuccess, StartedAt: started, FinishedAt: finished,
		DurationMS: finished.Sub(started).Milliseconds(), Hops: result.Hops, LossPercent: result.LossPercent,
		AvgLatencyMS: result.AvgLatencyMS, JitterMS: result.JitterMS, ThroughputBPS: result.ThroughputBPS}
	if run.Hops == nil {
		run.Hops = []Hop{}
	}
	if err != nil {
		run.Status = StatusFailed
		run.ErrorMessage = sanitizeError(err)
	} else if kind == KindPath && result.LossPercent != nil {
		if *result.LossPercent >= 100 {
			run.Status = StatusFailed
		} else if *result.LossPercent > target.LossThresholdPercent {
			run.Status = StatusDegraded
		}
	}
	saveCtx, saveCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer saveCancel()
	saved, saveErr := s.runs.Save(saveCtx, run)
	if saveErr != nil {
		return Run{}, saveErr
	}
	return saved, nil
}

func (s *Service) List(ctx context.Context, targetID *int64, kind *string, limit int) ([]Run, error) {
	if limit < 1 || limit > 500 {
		return nil, errors.New("limit должен быть от 1 до 500")
	}
	if kind != nil && *kind != KindPath && *kind != KindIperf {
		return nil, ErrInvalidKind
	}
	return s.runs.List(ctx, targetID, kind, limit)
}
func (s *Service) Get(ctx context.Context, id int64) (Run, error) { return s.runs.Get(ctx, id) }
func (s *Service) Latest(ctx context.Context, kind *string) ([]Run, error) {
	if kind != nil && *kind != KindPath && *kind != KindIperf {
		return nil, ErrInvalidKind
	}
	return s.runs.Latest(ctx, kind)
}
func (s *Service) Metrics(ctx context.Context) (Metrics, error) { return s.runs.Metrics(ctx) }
func (s *Service) CleanupBefore(ctx context.Context, cutoff time.Time) (int64, error) {
	return s.runs.CleanupBefore(ctx, cutoff)
}
func (s *Service) acquire(key string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.active[key]; ok {
		return false
	}
	s.active[key] = struct{}{}
	return true
}
func (s *Service) release(key string)        { s.mu.Lock(); delete(s.active, key); s.mu.Unlock() }
func stringKey(id int64, kind string) string { return kind + ":" + strconv.FormatInt(id, 10) }
func pathTimeout(target targets.Target) time.Duration {
	seconds := target.PacketCount*3 + 10
	if seconds > 180 {
		seconds = 180
	}
	return time.Duration(seconds) * time.Second
}

func sanitizeError(err error) string {
	if err == nil {
		return ""
	}
	return strings.TrimSpace(err.Error())
}

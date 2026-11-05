package checks

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"wayline.local/backend/internal/targets"
)

type TargetLister interface {
	List(context.Context) ([]targets.Target, error)
}
type CheckRunner interface {
	Run(context.Context, int64, string) (Run, error)
}

type Scheduler struct {
	targets      TargetLister
	runs         Repository
	runner       CheckRunner
	logger       *slog.Logger
	concurrency  int
	semaphore    chan struct{}
	pollInterval time.Duration
	now          func() time.Time
	wg           sync.WaitGroup
}

func NewScheduler(targets TargetLister, runs Repository, runner CheckRunner, logger *slog.Logger, concurrency int) *Scheduler {
	if logger == nil {
		logger = slog.Default()
	}
	if concurrency < 1 {
		concurrency = 1
	}
	if concurrency > 32 {
		concurrency = 32
	}
	return &Scheduler{targets: targets, runs: runs, runner: runner, logger: logger,
		concurrency: concurrency, semaphore: make(chan struct{}, concurrency), pollInterval: 5 * time.Second, now: time.Now}
}

func (s *Scheduler) Run(ctx context.Context) {
	s.tick(ctx)
	ticker := time.NewTicker(s.pollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			s.wg.Wait()
			return
		case <-ticker.C:
			s.tick(ctx)
		}
	}
}

func (s *Scheduler) tick(ctx context.Context) {
	items, err := s.targets.List(ctx)
	if err != nil {
		s.logger.Error("не удалось получить цели планировщика", "error", err)
		return
	}
	for _, target := range items {
		if !target.Enabled {
			continue
		}
		last, err := s.runs.LastFinishedAt(ctx, target.ID, KindPath)
		if err != nil {
			s.logger.Error("не удалось прочитать историю цели", "target_id", target.ID, "error", err)
			continue
		}
		if last != nil && s.now().Before(last.Add(time.Duration(target.IntervalSeconds)*time.Second)) {
			continue
		}
		select {
		case s.semaphore <- struct{}{}:
		case <-ctx.Done():
			return
		default:
			// Занятые слоты не должны задерживать обход остальных целей и
			// остановку планировщика. Цель будет повторно рассмотрена на следующем tick.
			continue
		}
		s.wg.Add(1)
		go func(id int64) {
			defer s.wg.Done()
			defer func() { <-s.semaphore }()
			_, err := s.runner.Run(ctx, id, KindPath)
			if err != nil && !errors.Is(err, ErrAlreadyRunning) && ctx.Err() == nil {
				s.logger.Error("не удалось выполнить проверку по расписанию", "target_id", id, "error", err)
			}
		}(target.ID)
	}
}

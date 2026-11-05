package checks

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"wayline.local/backend/internal/targets"
)

func TestSQLiteHistorySaveListGetMetricsAndCascade(t *testing.T) {
	targetRepository, err := targets.OpenSQLite(filepath.Join(t.TempDir(), "wayline.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer targetRepository.Close()
	enabled := true
	target, err := targets.NewService(targetRepository).Create(context.Background(), targets.Input{Enabled: &enabled, Name: "SERVER-A", Host: "server-a.example.invalid", ProbeMode: "icmp", IntervalSeconds: 60, PacketCount: 5, LossThresholdPercent: 1})
	if err != nil {
		t.Fatal(err)
	}
	repository := NewSQLiteRepository(targetRepository.DB())
	loss, latency := 2.5, 4.2
	now := time.Now().UTC().Truncate(time.Microsecond)
	saved, err := repository.Save(context.Background(), Run{TargetID: target.ID, Kind: KindPath, Status: StatusDegraded, StartedAt: now, FinishedAt: now.Add(time.Second), DurationMS: 1000, LossPercent: &loss, AvgLatencyMS: &latency, Hops: []Hop{{HopNumber: 1, Host: "10.0.0.1", IP: "10.0.0.1", LossPercent: &loss}}})
	if err != nil {
		t.Fatal(err)
	}
	lastFinished, err := repository.LastFinishedAt(context.Background(), target.ID, KindPath)
	if err != nil || lastFinished == nil || !lastFinished.Equal(now.Add(time.Second)) {
		t.Fatalf("LastFinishedAt() = %v, %v", lastFinished, err)
	}
	pathKind := KindPath
	items, err := repository.List(context.Background(), &target.ID, &pathKind, 10)
	if err != nil || len(items) != 1 || items[0].ID != saved.ID || items[0].Hops == nil {
		t.Fatalf("List() = %#v, %v", items, err)
	}
	detail, err := repository.Get(context.Background(), saved.ID)
	if err != nil || len(detail.Hops) != 1 || detail.Hops[0].Host != "10.0.0.1" {
		t.Fatalf("Get() = %#v, %v", detail, err)
	}
	throughput := 10_000_000.0
	speedRun, err := repository.Save(context.Background(), Run{TargetID: target.ID, Kind: KindIperf, Direction: DirectionDownload, ExecutionType: "local", Status: StatusSuccess, StartedAt: now.Add(2 * time.Second), FinishedAt: now.Add(3 * time.Second), DurationMS: 1000, ThroughputBPS: &throughput})
	if err != nil {
		t.Fatal(err)
	}
	speedDetail, err := repository.Get(context.Background(), speedRun.ID)
	if err != nil || speedDetail.Direction != DirectionDownload {
		t.Fatalf("speed detail = %#v, %v", speedDetail, err)
	}
	metrics, err := repository.Metrics(context.Background())
	if err != nil || len(metrics.Counts) != 2 || len(metrics.Latest) != 1 || metrics.Latest[0].Status != StatusDegraded {
		t.Fatalf("Metrics() = %#v, %v", metrics, err)
	}
	latest, err := repository.Latest(context.Background(), &pathKind)
	if err != nil || len(latest) != 1 || latest[0].ID != saved.ID {
		t.Fatalf("Latest() = %#v, %v", latest, err)
	}
	newPath, err := repository.Save(context.Background(), Run{TargetID: target.ID, Kind: KindPath, Status: StatusSuccess, StartedAt: now.Add(4 * time.Second), FinishedAt: now.Add(5 * time.Second), DurationMS: 1000})
	if err != nil {
		t.Fatal(err)
	}
	latest, err = repository.Latest(context.Background(), nil)
	if err != nil || len(latest) != 2 || latest[0].Kind != KindIperf || latest[1].ID != newPath.ID || latest[1].Kind != KindPath {
		t.Fatalf("Latest(all) = %#v, %v", latest, err)
	}

	old := now.AddDate(0, 0, -100)
	oldRun, err := repository.Save(context.Background(), Run{TargetID: target.ID, Kind: KindPath, Status: StatusSuccess, StartedAt: old, FinishedAt: old.Add(time.Second), DurationMS: 1000, Hops: []Hop{{HopNumber: 1}}})
	if err != nil {
		t.Fatal(err)
	}
	deleted, err := repository.CleanupBefore(context.Background(), now.AddDate(0, 0, -90))
	if err != nil || deleted != 1 {
		t.Fatalf("CleanupBefore() = %d, %v", deleted, err)
	}
	if _, err := repository.Get(context.Background(), oldRun.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("old run after cleanup error = %v", err)
	}
	var orphanHops int
	if err := targetRepository.DB().QueryRowContext(context.Background(), `SELECT COUNT(*) FROM hop_results WHERE check_run_id = ?`, oldRun.ID).Scan(&orphanHops); err != nil || orphanHops != 0 {
		t.Fatalf("orphan hops = %d, %v", orphanHops, err)
	}
	if err := targetRepository.Delete(context.Background(), target.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.Get(context.Background(), saved.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get() after cascade error = %v", err)
	}
}

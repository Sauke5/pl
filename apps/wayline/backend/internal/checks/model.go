package checks

import (
	"time"

	"wayline.local/backend/internal/probes"
)

const (
	KindPath  = "path"
	KindIperf = "iperf"

	DirectionDownload = "download"
	DirectionUpload   = "upload"

	StatusSuccess  = "success"
	StatusDegraded = "degraded"
	StatusFailed   = "failed"
)

type Hop = probes.Hop

type Run struct {
	ID            int64     `json:"id"`
	TargetID      int64     `json:"target_id"`
	Kind          string    `json:"kind"`
	Direction     string    `json:"direction"`
	ExecutionType string    `json:"execution_type"`
	ExecutionID   *string   `json:"execution_id"`
	Status        string    `json:"status"`
	StartedAt     time.Time `json:"started_at"`
	FinishedAt    time.Time `json:"finished_at"`
	DurationMS    int64     `json:"duration_ms"`
	LossPercent   *float64  `json:"loss_percent,omitempty"`
	AvgLatencyMS  *float64  `json:"avg_latency_ms,omitempty"`
	JitterMS      *float64  `json:"jitter_ms,omitempty"`
	ThroughputBPS *float64  `json:"throughput_bps,omitempty"`
	ErrorMessage  string    `json:"error_message,omitempty"`
	Hops          []Hop     `json:"hops"`
}

type Result = probes.Result

// Request задаёт единственный поддерживаемый тип ручной проверки.
type Request struct {
	Kind      string `json:"kind"`
	Direction string `json:"direction,omitempty"`
}

// ProbeTarget — минимальный transport-neutral контракт executor. Он намеренно
// не зависит от SQLite, HTTP и central-модели, чтобы тот же executor мог
// использовать lightweight wayline-agent.
type ProbeTarget = probes.Target

type Metrics struct {
	Counts []MetricCount
	Latest []LatestStatus
}

type MetricCount struct {
	Kind   string
	Status string
	Count  int64
}

type LatestStatus struct {
	TargetID int64
	Name     string
	Status   string
}

package targets

import "time"

type Target struct {
	ID                   int64     `json:"id"`
	Enabled              bool      `json:"enabled"`
	Name                 string    `json:"name"`
	Host                 string    `json:"host"`
	ProbeMode            string    `json:"probe_mode"`
	ProbePort            int       `json:"probe_port"`
	ExecutionType        string    `json:"execution_type"`
	ExecutionID          string    `json:"execution_id"`
	IntervalSeconds      int       `json:"interval_seconds"`
	PacketCount          int       `json:"packet_count"`
	LossThresholdPercent float64   `json:"loss_threshold_percent"`
	IperfEnabled         bool      `json:"iperf_enabled"`
	IperfHost            string    `json:"iperf_host"`
	IperfPort            int       `json:"iperf_port"`
	IperfDurationSeconds int       `json:"iperf_duration_seconds"`
	CreatedAt            time.Time `json:"created_at"`
	UpdatedAt            time.Time `json:"updated_at"`
}

type Input struct {
	Enabled              *bool   `json:"enabled"`
	Name                 string  `json:"name"`
	Host                 string  `json:"host"`
	ProbeMode            string  `json:"probe_mode"`
	ProbePort            int     `json:"probe_port"`
	ExecutionType        string  `json:"execution_type"`
	ExecutionID          string  `json:"execution_id"`
	IntervalSeconds      int     `json:"interval_seconds"`
	PacketCount          int     `json:"packet_count"`
	LossThresholdPercent float64 `json:"loss_threshold_percent"`
	IperfEnabled         bool    `json:"iperf_enabled"`
	IperfHost            string  `json:"iperf_host"`
	IperfPort            int     `json:"iperf_port"`
	IperfDurationSeconds int     `json:"iperf_duration_seconds"`
}

package probes

type Hop struct {
	HopNumber   int      `json:"hop_number"`
	Host        string   `json:"host"`
	IP          string   `json:"ip"`
	LossPercent *float64 `json:"loss_percent,omitempty"`
	PacketsSent *int     `json:"packets_sent,omitempty"`
	LastMS      *float64 `json:"last_ms,omitempty"`
	AvgMS       *float64 `json:"avg_ms,omitempty"`
	BestMS      *float64 `json:"best_ms,omitempty"`
	WorstMS     *float64 `json:"worst_ms,omitempty"`
	StdDevMS    *float64 `json:"stddev_ms,omitempty"`
}

type Result struct {
	LossPercent   *float64
	AvgLatencyMS  *float64
	JitterMS      *float64
	ThroughputBPS *float64
	Hops          []Hop
}

// Target — минимальный transport-neutral контракт executor.
type Target struct {
	Host                 string
	ProbeMode            string
	ProbePort            int
	PacketCount          int
	IperfEnabled         bool
	IperfHost            string
	IperfPort            int
	IperfDurationSeconds int
	IperfDirection       string
}

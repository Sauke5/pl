package providers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Only one throughput test may consume this monitoring host's link at a time.
var iperfActive sync.Mutex

func iperfOptions(target string, parameters map[string]any) (string, int, string, int, error) {
	host, ports, err := parseNmapTarget(target)
	if err != nil || len(ports) != 1 || strings.Contains(target, ",") {
		return "", 0, "", 0, errors.New("iperf requires one host and one TCP port")
	}
	direction := "upload"
	if v, exists := parameters["direction"]; exists {
		var ok bool
		direction, ok = v.(string)
		if !ok || (direction != "upload" && direction != "download") {
			return "", 0, "", 0, errors.New("invalid iperf direction")
		}
	}
	duration := 10
	if v, exists := parameters["duration_seconds"]; exists {
		switch n := v.(type) {
		case float64:
			if n != 5 && n != 10 && n != 15 {
				return "", 0, "", 0, errors.New("iperf duration must be 5, 10 or 15 seconds")
			}
			duration = int(n)
		case int:
			duration = n
		default:
			return "", 0, "", 0, errors.New("invalid iperf duration")
		}
	}
	if duration != 5 && duration != 10 && duration != 15 {
		return "", 0, "", 0, errors.New("iperf duration must be 5, 10 or 15 seconds")
	}
	return host, ports[0], direction, duration, nil
}

// ValidateIperfParameters rejects unsupported options before creating a job.
func ValidateIperfParameters(target string, parameters map[string]any) error {
	_, _, _, _, err := iperfOptions(target, parameters)
	return err
}

type iperfSummary struct {
	Seconds       float64 `json:"seconds"`
	Bytes         int64   `json:"bytes"`
	BitsPerSecond float64 `json:"bits_per_second"`
}

func parseIperfOutput(data []byte) (*iperfSummary, error) {
	var doc struct {
		Error string `json:"error"`
		Start struct {
			Test struct {
				Protocol string `json:"protocol"`
			} `json:"test_start"`
		} `json:"start"`
		End struct {
			Received *iperfSummary `json:"sum_received"`
		} `json:"end"`
	}
	if len(data) > nmapOutputLimit || json.Unmarshal(data, &doc) != nil || doc.Error != "" || doc.Start.Test.Protocol != "TCP" || doc.End.Received == nil {
		return nil, ErrThroughputIncomplete
	}
	s := doc.End.Received
	if s.Seconds <= 0 || s.Bytes < 0 || s.BitsPerSecond < 0 || math.IsInf(s.BitsPerSecond, 0) || math.IsNaN(s.BitsPerSecond) {
		return nil, ErrThroughputIncomplete
	}
	// Missing numeric fields must not silently become a successful zero result.
	var raw struct {
		End struct {
			Received map[string]json.RawMessage `json:"sum_received"`
		} `json:"end"`
	}
	_ = json.Unmarshal(data, &raw)
	for _, key := range []string{"seconds", "bytes", "bits_per_second"} {
		if v, ok := raw.End.Received[key]; !ok || string(v) == "null" {
			return nil, ErrThroughputIncomplete
		}
	}
	return s, nil
}

func runIperf(ctx context.Context, path string, args []string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.WaitDelay = time.Second
	var stdout, stderr nmapLimitedBuffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if stdout.exceeded || stderr.exceeded {
			return nil, errors.New("iperf3 output limit exceeded")
		}
		return nil, ErrThroughputUnavailable
	}
	return stdout.Bytes(), nil
}

func (r *Registry) iperfCheck(ctx context.Context, target string, parameters map[string]any) (map[string]any, error) {
	host, port, direction, duration, err := iperfOptions(target, parameters)
	if err != nil {
		return nil, err
	}
	if r.interactiveGuard() == nil {
		return nil, errors.New("check policy is unavailable")
	}
	if !iperfActive.TryLock() {
		return nil, ErrThroughputBusy
	}
	defer iperfActive.Unlock()
	// Allow control-channel finalization after data transfer; older iperf3
	// servers can spend another 10 seconds completing the receiver summary.
	ctx, cancel := context.WithTimeout(ctx, time.Duration(duration+20)*time.Second)
	defer cancel()
	started := time.Now()
	guard := r.interactiveGuard().IperfChecks()
	ips, err := guard.Resolve(ctx, host)
	if err != nil {
		return nil, err
	}
	if len(ips) == 0 {
		return nil, errors.New("host has no addresses")
	}
	if err = guard.ValidatePortIPs(ips, port); err != nil {
		return nil, err
	}
	ip := ips[0]
	args := []string{"-c", ip.String(), "-p", strconv.Itoa(port), "-t", strconv.Itoa(duration), "-J", "--connect-timeout", "3000"}
	if direction == "download" {
		args = append(args, "-R")
	}
	if ip.To4() == nil {
		args = append(args, "-6")
	}
	path := os.Getenv("PORTAL_IPERF3_PATH")
	if path == "" {
		path = "/usr/bin/iperf3"
	}
	data, err := runIperf(ctx, path, args)
	if err != nil {
		return nil, err
	}
	summary, err := parseIperfOutput(data)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"kind": "iperf", "target": net.JoinHostPort(host, strconv.Itoa(port)), "scanned_address": ip.String(),
		"origin": "monitoring", "source": "portal_check", "scope": "host_to_host", "direction": direction,
		"throughput_mbps": summary.BitsPerSecond / 1e6, "bytes_received": summary.Bytes, "test_seconds": summary.Seconds,
		"duration_seconds": duration, "duration_ms": time.Since(started).Milliseconds(), "observed_at": started.UTC(),
		"description": fmt.Sprintf("TCP %s, %d seconds", direction, duration),
	}, nil
}

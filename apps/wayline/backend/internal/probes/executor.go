package probes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os/exec"
	"regexp"
	"strconv"
	"time"
)

// CommandRunner существует отдельно от Executor, чтобы тесты никогда не
// запускали реальные сетевые утилиты.
type CommandRunner interface {
	Run(context.Context, string, ...string) ([]byte, error)
}

type OSCommandRunner struct{}

func (OSCommandRunner) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	// Команда и каждый аргумент передаются напрямую, без shell-интерпретации.
	command := exec.CommandContext(ctx, name, args...)
	output := &boundedOutput{limit: 1 << 20}
	command.Stdout, command.Stderr = output, output
	command.WaitDelay = 2 * time.Second
	err := command.Run()
	if output.overflow {
		return nil, errors.New("вывод сетевой утилиты превышает допустимый размер")
	}
	return output.buffer.Bytes(), err
}

// stdout and stderr share one writer; os/exec serializes writes to this instance.
type boundedOutput struct {
	buffer   bytes.Buffer
	limit    int
	overflow bool
}

func (b *boundedOutput) Write(data []byte) (int, error) {
	remaining := b.limit - b.buffer.Len()
	if len(data) > remaining {
		_, _ = b.buffer.Write(data[:remaining])
		b.overflow = true
		return remaining, errors.New("output limit")
	}
	return b.buffer.Write(data)
}

type Dialer interface {
	DialContext(context.Context, string, string) (net.Conn, error)
}

type Executor struct {
	commands  CommandRunner
	dialer    Dialer
	mtrPath   string
	pingPath  string
	iperfPath string
}

func NewExecutor(commands CommandRunner, dialer Dialer) *Executor {
	if commands == nil {
		commands = OSCommandRunner{}
	}
	if dialer == nil {
		dialer = &net.Dialer{Timeout: 3 * time.Second}
	}
	return &Executor{commands: commands, dialer: dialer, mtrPath: "mtr", pingPath: "ping", iperfPath: "iperf3"}
}

func (e *Executor) Path(ctx context.Context, target Target) (Result, error) {
	switch target.ProbeMode {
	case "mtr":
		return e.mtr(ctx, target)
	case "icmp":
		return e.ping(ctx, target)
	case "tcp":
		return e.tcp(ctx, target)
	default:
		return Result{}, errors.New("режим проверки цели не поддерживается")
	}
}

func (e *Executor) Iperf(ctx context.Context, target Target) (Result, error) {
	if !target.IperfEnabled {
		return Result{}, errors.New("проверка iperf3 для цели выключена")
	}
	if target.IperfDirection != "" && target.IperfDirection != "upload" && target.IperfDirection != "download" {
		return Result{}, errors.New("направление проверки iperf3 не поддерживается")
	}
	args := []string{"-c", target.IperfHost, "-p", strconv.Itoa(target.IperfPort),
		"-t", strconv.Itoa(target.IperfDurationSeconds), "-J", "--connect-timeout", "3000"}
	if target.IperfDirection == "download" {
		args = append(args, "-R")
	}
	out, err := e.commands.Run(ctx, e.iperfPath, args...)
	if err != nil {
		return Result{}, commandError(ctx, "iperf3", err)
	}
	var payload struct {
		Error string `json:"error"`
		End   struct {
			SumReceived struct {
				BitsPerSecond float64 `json:"bits_per_second"`
				JitterMS      float64 `json:"jitter_ms"`
			} `json:"sum_received"`
			Sum struct {
				BitsPerSecond float64 `json:"bits_per_second"`
				JitterMS      float64 `json:"jitter_ms"`
			} `json:"sum"`
		} `json:"end"`
	}
	if err := json.Unmarshal(out, &payload); err != nil {
		return Result{}, errors.New("iperf3 вернул некорректный результат")
	}
	if payload.Error != "" {
		return Result{}, errors.New("сервер iperf3 не завершил проверку")
	}
	throughput, jitter := payload.End.SumReceived.BitsPerSecond, payload.End.SumReceived.JitterMS
	if throughput == 0 {
		throughput, jitter = payload.End.Sum.BitsPerSecond, payload.End.Sum.JitterMS
	}
	if throughput <= 0 {
		return Result{}, errors.New("iperf3 не вернул пропускную способность")
	}
	return Result{ThroughputBPS: floatPointer(throughput), JitterMS: optionalPositive(jitter)}, nil
}

func (e *Executor) mtr(ctx context.Context, target Target) (Result, error) {
	out, err := e.commands.Run(ctx, e.mtrPath, "--report", "--json", "--no-dns", "--report-cycles", strconv.Itoa(target.PacketCount), "--", target.Host)
	if err != nil {
		return Result{}, commandError(ctx, "MTR", err)
	}
	var payload struct {
		Report struct {
			Hubs []struct {
				Count int     `json:"count"`
				Host  string  `json:"host"`
				Loss  float64 `json:"Loss%"`
				Snt   int     `json:"Snt"`
				Last  float64 `json:"Last"`
				Avg   float64 `json:"Avg"`
				Best  float64 `json:"Best"`
				Wrst  float64 `json:"Wrst"`
				StDev float64 `json:"StDev"`
			} `json:"hubs"`
		} `json:"report"`
	}
	if err := json.Unmarshal(out, &payload); err != nil || len(payload.Report.Hubs) == 0 {
		return Result{}, errors.New("MTR вернул некорректный результат")
	}
	result := Result{Hops: make([]Hop, 0, len(payload.Report.Hubs))}
	for _, item := range payload.Report.Hubs {
		host, ip := item.Host, ""
		if net.ParseIP(host) != nil {
			ip = host
		}
		result.Hops = append(result.Hops, Hop{HopNumber: item.Count, Host: host, IP: ip,
			LossPercent: floatPointer(item.Loss), PacketsSent: intPointer(item.Snt), LastMS: floatPointer(item.Last),
			AvgMS: floatPointer(item.Avg), BestMS: floatPointer(item.Best), WorstMS: floatPointer(item.Wrst), StdDevMS: floatPointer(item.StDev)})
	}
	last := result.Hops[len(result.Hops)-1]
	result.LossPercent, result.AvgLatencyMS, result.JitterMS = last.LossPercent, last.AvgMS, last.StdDevMS
	return result, nil
}

var (
	pingLossPattern = regexp.MustCompile(`(?m)([0-9]+(?:\.[0-9]+)?)% packet loss`)
	pingRTTPattern  = regexp.MustCompile(`(?m)(?:round-trip|rtt) min/avg/max/(?:stddev|mdev) = [0-9.]+/([0-9.]+)/[0-9.]+/([0-9.]+)`)
)

func (e *Executor) ping(ctx context.Context, target Target) (Result, error) {
	out, err := e.commands.Run(ctx, e.pingPath, "-n", "-c", strconv.Itoa(target.PacketCount), "-W", "2", "--", target.Host)
	if err != nil && ctx.Err() != nil {
		return Result{}, errors.New("проверка ICMP превысила допустимое время")
	}
	lossMatch := pingLossPattern.FindStringSubmatch(string(out))
	if len(lossMatch) != 2 {
		return Result{}, errors.New("ping не вернул статистику потерь")
	}
	loss, _ := strconv.ParseFloat(lossMatch[1], 64)
	result := Result{LossPercent: floatPointer(loss)}
	if rtt := pingRTTPattern.FindStringSubmatch(string(out)); len(rtt) == 3 {
		avg, _ := strconv.ParseFloat(rtt[1], 64)
		jitter, _ := strconv.ParseFloat(rtt[2], 64)
		result.AvgLatencyMS, result.JitterMS = floatPointer(avg), floatPointer(jitter)
	}
	if err != nil && loss < 100 {
		return Result{}, errors.New("ping завершился с ошибкой")
	}
	return result, nil
}

func (e *Executor) tcp(ctx context.Context, target Target) (Result, error) {
	address := net.JoinHostPort(target.Host, strconv.Itoa(target.ProbePort))
	var success int
	var total time.Duration
	for i := 0; i < target.PacketCount; i++ {
		attemptCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		started := time.Now()
		connection, err := e.dialer.DialContext(attemptCtx, "tcp", address)
		elapsed := time.Since(started)
		cancel()
		if err == nil {
			success++
			total += elapsed
			_ = connection.Close()
		}
		if ctx.Err() != nil {
			return Result{}, errors.New("проверка TCP превысила допустимое время")
		}
	}
	loss := float64(target.PacketCount-success) * 100 / float64(target.PacketCount)
	result := Result{LossPercent: floatPointer(loss)}
	if success > 0 {
		avg := float64(total.Microseconds()) / 1000 / float64(success)
		result.AvgLatencyMS = floatPointer(avg)
	}
	return result, nil
}

func commandError(ctx context.Context, tool string, _ error) error {
	if ctx.Err() != nil {
		return fmt.Errorf("проверка %s превысила допустимое время", tool)
	}
	return fmt.Errorf("не удалось выполнить проверку %s", tool)
}

func floatPointer(value float64) *float64 { return &value }
func intPointer(value int) *int           { return &value }
func optionalPositive(value float64) *float64 {
	if value <= 0 {
		return nil
	}
	return floatPointer(value)
}

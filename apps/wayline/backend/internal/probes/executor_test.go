package probes

import (
	"context"
	"errors"
	"net"
	"reflect"
	"testing"
	"time"
)

type commandStub struct {
	output []byte
	err    error
	name   string
	args   []string
}

func (s *commandStub) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	s.name = name
	s.args = append([]string(nil), args...)
	return s.output, s.err
}

func TestExecutorMTRParsesJSONAndUsesSafeArguments(t *testing.T) {
	command := &commandStub{output: []byte(`{"report":{"hubs":[{"count":1,"host":"10.0.0.1","Loss%":0,"Snt":10,"Last":1.2,"Avg":1.1,"Best":0.8,"Wrst":1.5,"StDev":0.2},{"count":2,"host":"10.0.0.2","Loss%":2.5,"Snt":10,"Last":4,"Avg":3.5,"Best":3,"Wrst":5,"StDev":0.5}]}}`)}
	executor := NewExecutor(command, nil)
	result, err := executor.Path(context.Background(), Target{ProbeMode: "mtr", Host: "server-a.example.invalid", PacketCount: 10})
	if err != nil {
		t.Fatalf("Path() error = %v", err)
	}
	wantArgs := []string{"--report", "--json", "--no-dns", "--report-cycles", "10", "--", "server-a.example.invalid"}
	if command.name != "mtr" || !reflect.DeepEqual(command.args, wantArgs) {
		t.Fatalf("command = %s %#v", command.name, command.args)
	}
	if len(result.Hops) != 2 || result.LossPercent == nil || *result.LossPercent != 2.5 || result.AvgLatencyMS == nil || *result.AvgLatencyMS != 3.5 {
		t.Fatalf("result = %#v", result)
	}
}

func TestExecutorPingKeepsFullLossAsResult(t *testing.T) {
	command := &commandStub{output: []byte("5 packets transmitted, 0 received, 100% packet loss\n"), err: errors.New("exit status 1")}
	result, err := NewExecutor(command, nil).Path(context.Background(), Target{ProbeMode: "icmp", Host: "server-a.example.invalid", PacketCount: 5})
	if err != nil || result.LossPercent == nil || *result.LossPercent != 100 {
		t.Fatalf("Path() = %#v, %v", result, err)
	}
}

func TestExecutorIperfParsesReceivedThroughput(t *testing.T) {
	command := &commandStub{output: []byte(`{"end":{"sum_received":{"bits_per_second":9876543,"jitter_ms":1.25}}}`)}
	result, err := NewExecutor(command, nil).Iperf(context.Background(), Target{IperfEnabled: true, IperfHost: "server-a.example.invalid", IperfPort: 5201, IperfDurationSeconds: 10})
	if err != nil || result.ThroughputBPS == nil || *result.ThroughputBPS != 9876543 {
		t.Fatalf("Iperf() = %#v, %v", result, err)
	}
	wantArgs := []string{"-c", "server-a.example.invalid", "-p", "5201", "-t", "10", "-J", "--connect-timeout", "3000"}
	if command.name != "iperf3" || !reflect.DeepEqual(command.args, wantArgs) {
		t.Fatalf("upload command = %s %#v", command.name, command.args)
	}
}

func TestExecutorIperfDownloadUsesReverseMode(t *testing.T) {
	command := &commandStub{output: []byte(`{"end":{"sum_received":{"bits_per_second":1234567}}}`)}
	_, err := NewExecutor(command, nil).Iperf(context.Background(), Target{IperfEnabled: true, IperfHost: "public.example", IperfPort: 5202, IperfDurationSeconds: 15, IperfDirection: "download"})
	if err != nil {
		t.Fatalf("Iperf() error = %v", err)
	}
	wantArgs := []string{"-c", "public.example", "-p", "5202", "-t", "15", "-J", "--connect-timeout", "3000", "-R"}
	if !reflect.DeepEqual(command.args, wantArgs) {
		t.Fatalf("download args = %#v, want %#v", command.args, wantArgs)
	}
}

type dialerStub struct{ calls int }

func (d *dialerStub) DialContext(_ context.Context, _, _ string) (net.Conn, error) {
	d.calls++
	if d.calls == 2 {
		return nil, errors.New("closed")
	}
	return &connectionStub{}, nil
}

type connectionStub struct{}

func (*connectionStub) Read([]byte) (int, error)         { return 0, errors.New("unused") }
func (*connectionStub) Write([]byte) (int, error)        { return 0, errors.New("unused") }
func (*connectionStub) Close() error                     { return nil }
func (*connectionStub) LocalAddr() net.Addr              { return nil }
func (*connectionStub) RemoteAddr() net.Addr             { return nil }
func (*connectionStub) SetDeadline(time.Time) error      { return nil }
func (*connectionStub) SetReadDeadline(time.Time) error  { return nil }
func (*connectionStub) SetWriteDeadline(time.Time) error { return nil }

func TestExecutorTCPAggregatesAttempts(t *testing.T) {
	dialer := &dialerStub{}
	result, err := NewExecutor(nil, dialer).Path(context.Background(), Target{ProbeMode: "tcp", Host: "10.0.0.1", ProbePort: 443, PacketCount: 5})
	if err != nil || result.LossPercent == nil || *result.LossPercent != 20 {
		t.Fatalf("Path() = %#v, %v", result, err)
	}
}

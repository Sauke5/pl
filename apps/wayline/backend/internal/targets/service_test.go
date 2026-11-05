package targets

import (
	"context"
	"errors"
	"testing"
)

func validInput() Input {
	enabled := true
	return Input{
		Enabled:              &enabled,
		Name:                 "SERVER-A",
		Host:                 "server.example.invalid",
		ProbeMode:            "icmp",
		IntervalSeconds:      60,
		PacketCount:          10,
		LossThresholdPercent: 2.5,
		IperfEnabled:         true,
		IperfHost:            "server.example.invalid",
		IperfPort:            5201,
		IperfDurationSeconds: 10,
	}
}

func TestValidateNormalizesInput(t *testing.T) {
	input := validInput()
	input.Name = "  SERVER-A  "
	input.Host = "SERVER.EXAMPLE.INVALID."
	input.ProbeMode = " ICMP "

	got, err := Validate(input)
	if err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
	if got.Name != "SERVER-A" || got.Host != "server.example.invalid" || got.ProbeMode != "icmp" {
		t.Fatalf("unexpected normalized input: %#v", got)
	}
}

func TestValidateRejectsEveryRestrictedField(t *testing.T) {
	input := Input{
		Name:                 " ",
		Host:                 "https://server-a.example.invalid:443",
		ProbeMode:            "shell",
		ProbePort:            70000,
		IntervalSeconds:      42,
		PacketCount:          7,
		LossThresholdPercent: 3.14,
		IperfEnabled:         true,
		IperfHost:            "",
		IperfPort:            22,
		IperfDurationSeconds: 120,
	}

	_, err := Validate(input)
	var validationError *ValidationError
	if !errors.As(err, &validationError) {
		t.Fatalf("Validate() error = %v, want ValidationError", err)
	}
	for _, field := range []string{
		"name", "host", "probe_mode", "probe_port", "interval_seconds", "packet_count",
		"loss_threshold_percent", "iperf_host", "iperf_port", "iperf_duration_seconds",
	} {
		if validationError.Fields[field] == "" {
			t.Errorf("missing validation error for %s", field)
		}
	}
}

func TestValidateDefaults(t *testing.T) {
	input := validInput()
	input.Enabled = nil
	input.ProbeMode = "tcp"
	input.ProbePort = 0

	got, err := Validate(input)
	if err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
	if got.Enabled == nil || !*got.Enabled {
		t.Fatal("Enabled default is not true")
	}
	if got.ExecutionType != "local" || got.ExecutionID != "" {
		t.Fatalf("execution defaults = %q/%q", got.ExecutionType, got.ExecutionID)
	}
	if got.ProbePort != 443 {
		t.Fatalf("ProbePort default = %d, want 443", got.ProbePort)
	}
}

func TestValidateRejectsUnavailableRemoteExecution(t *testing.T) {
	input := validInput()
	input.ExecutionType = "agent"
	input.ExecutionID = "branch-01"
	_, err := Validate(input)
	var validationError *ValidationError
	if !errors.As(err, &validationError) || validationError.Fields["execution_type"] == "" || validationError.Fields["execution_id"] == "" {
		t.Fatalf("Validate() error = %#v", err)
	}
}

func TestValidateRejectsIperfParametersWhenDisabled(t *testing.T) {
	input := validInput()
	input.IperfEnabled = false

	_, err := Validate(input)
	var validationError *ValidationError
	if !errors.As(err, &validationError) || validationError.Fields["iperf_enabled"] == "" {
		t.Fatalf("Validate() error = %#v, want iperf_enabled field error", err)
	}
}

type repositoryStub struct {
	created Input
}

func (r *repositoryStub) Create(_ context.Context, input Input) (Target, error) {
	r.created = input
	return Target{Name: input.Name, Host: input.Host}, nil
}
func (*repositoryStub) List(context.Context) ([]Target, error)     { return nil, nil }
func (*repositoryStub) Get(context.Context, int64) (Target, error) { return Target{}, nil }
func (*repositoryStub) Update(context.Context, int64, Input) (Target, error) {
	return Target{}, nil
}
func (*repositoryStub) Delete(context.Context, int64) error { return nil }

func TestServiceValidatesBeforeRepository(t *testing.T) {
	repository := &repositoryStub{}
	service := NewService(repository)
	input := validInput()
	input.Host = "SERVER.EXAMPLE.INVALID"

	if _, err := service.Create(context.Background(), input); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if repository.created.Host != "server.example.invalid" {
		t.Fatalf("repository input host = %q", repository.created.Host)
	}
}

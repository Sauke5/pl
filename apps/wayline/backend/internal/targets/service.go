package targets

import (
	"context"
	"errors"
	"math"
	"net"
	"regexp"
	"strings"
	"unicode/utf8"
)

var (
	ErrNotFound = errors.New("цель не найдена")
	ErrConflict = errors.New("цель с таким именем уже существует")
)

type ValidationError struct {
	Fields map[string]string
}

func (e *ValidationError) Error() string { return "проверьте параметры цели" }

type Repository interface {
	Create(context.Context, Input) (Target, error)
	List(context.Context) ([]Target, error)
	Get(context.Context, int64) (Target, error)
	Update(context.Context, int64, Input) (Target, error)
	Delete(context.Context, int64) error
}

type Service struct {
	repository Repository
}

func NewService(repository Repository) *Service { return &Service{repository: repository} }

func (s *Service) Create(ctx context.Context, input Input) (Target, error) {
	normalized, err := Validate(input)
	if err != nil {
		return Target{}, err
	}
	return s.repository.Create(ctx, normalized)
}

func (s *Service) List(ctx context.Context) ([]Target, error) { return s.repository.List(ctx) }

func (s *Service) Get(ctx context.Context, id int64) (Target, error) {
	return s.repository.Get(ctx, id)
}

func (s *Service) Update(ctx context.Context, id int64, input Input) (Target, error) {
	normalized, err := Validate(input)
	if err != nil {
		return Target{}, err
	}
	return s.repository.Update(ctx, id, normalized)
}

func (s *Service) Delete(ctx context.Context, id int64) error { return s.repository.Delete(ctx, id) }

var hostnamePattern = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$`)

func Validate(input Input) (Input, error) {
	if input.Enabled == nil {
		input.Enabled = boolPointer(true)
	}
	input.Name = strings.TrimSpace(input.Name)
	input.Host = normalizeHost(input.Host)
	input.ProbeMode = strings.ToLower(strings.TrimSpace(input.ProbeMode))
	input.ExecutionType = strings.ToLower(strings.TrimSpace(input.ExecutionType))
	input.ExecutionID = strings.TrimSpace(input.ExecutionID)
	input.IperfHost = normalizeHost(input.IperfHost)

	fields := make(map[string]string)
	if length := utf8.RuneCountInString(input.Name); length < 1 || length > 80 {
		fields["name"] = "укажите название длиной от 1 до 80 символов"
	}
	if !validHost(input.Host) {
		fields["host"] = "укажите IP-адрес или DNS-имя без протокола и порта"
	}
	if !oneOf(input.ProbeMode, "mtr", "icmp", "tcp") {
		fields["probe_mode"] = "доступные режимы: mtr, icmp, tcp"
	}
	if input.ExecutionType == "" {
		input.ExecutionType = "local"
	}
	if input.ExecutionType != "local" {
		fields["execution_type"] = "сейчас доступен только тип исполнения local"
	}
	if input.ExecutionID != "" {
		fields["execution_id"] = "для локального исполнения идентификатор должен быть пустым"
	}
	if input.ProbeMode == "tcp" {
		if input.ProbePort == 0 {
			input.ProbePort = 443
		}
		if input.ProbePort < 1 || input.ProbePort > 65535 {
			fields["probe_port"] = "укажите TCP-порт от 1 до 65535"
		}
	} else if input.ProbePort != 0 {
		fields["probe_port"] = "для режима mtr или icmp порт должен быть равен 0"
	}
	if !oneOf(input.IntervalSeconds, 30, 60, 300, 600, 900, 1800, 3600) {
		fields["interval_seconds"] = "доступные интервалы: 30, 60, 300, 600, 900, 1800 или 3600 секунд"
	}
	if !oneOf(input.PacketCount, 5, 10, 20, 50) {
		fields["packet_count"] = "доступное количество пакетов: 5, 10, 20 или 50"
	}
	if math.IsNaN(input.LossThresholdPercent) || math.IsInf(input.LossThresholdPercent, 0) ||
		input.LossThresholdPercent < 0 || input.LossThresholdPercent > 100 ||
		math.Abs(input.LossThresholdPercent*10-math.Round(input.LossThresholdPercent*10)) > 1e-9 {
		fields["loss_threshold_percent"] = "укажите порог от 0 до 100 процентов с точностью до одной десятой"
	}

	if input.IperfEnabled {
		if !validHost(input.IperfHost) {
			fields["iperf_host"] = "укажите IP-адрес или DNS-имя сервера iperf3"
		}
		if !oneOf(input.IperfPort, 5201, 5202, 5203, 5204, 5205) {
			fields["iperf_port"] = "доступные порты: 5201, 5202, 5203, 5204 или 5205"
		}
		if !oneOf(input.IperfDurationSeconds, 5, 10, 15, 30, 60) {
			fields["iperf_duration_seconds"] = "доступная длительность: 5, 10, 15, 30 или 60 секунд"
		}
	} else if input.IperfHost != "" || input.IperfPort != 0 || input.IperfDurationSeconds != 0 {
		fields["iperf_enabled"] = "включите iperf3 или очистите его параметры"
	}

	if len(fields) > 0 {
		return Input{}, &ValidationError{Fields: fields}
	}
	return input, nil
}

func boolPointer(value bool) *bool { return &value }

func normalizeHost(value string) string {
	value = strings.TrimSpace(value)
	if strings.HasSuffix(value, ".") {
		value = strings.TrimSuffix(value, ".")
	}
	return strings.ToLower(value)
}

func validHost(value string) bool {
	if value == "" || len(value) > 253 || strings.ContainsAny(value, "/\\@?#%") {
		return false
	}
	if ip := net.ParseIP(value); ip != nil {
		return !ip.IsUnspecified() && !ip.IsMulticast()
	}
	return hostnamePattern.MatchString(value)
}

func oneOf[T comparable](value T, allowed ...T) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}

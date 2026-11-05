package probes

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"wayline.local/backend/internal/targets"
)

const maxRunnerBody = 1 << 20

type ProbeExecutor interface {
	Path(context.Context, Target) (Result, error)
	Iperf(context.Context, Target) (Result, error)
}

type runnerRequest struct {
	Kind   string `json:"kind"`
	Target Target `json:"target"`
}
type runnerResponse struct {
	Result *Result `json:"result"`
	Error  string  `json:"error,omitempty"`
}

// RunnerHandler is a bounded private transport, never a command execution API.
func RunnerHandler(executor ProbeExecutor, token string, concurrency int) http.Handler {
	if concurrency < 1 || concurrency > 16 {
		concurrency = 4
	}
	slots := make(chan struct{}, concurrency)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) })
	mux.HandleFunc("POST /v1/probes", func(w http.ResponseWriter, r *http.Request) {
		if token != "" && subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+token)) != 1 {
			http.Error(w, "доступ запрещён", http.StatusUnauthorized)
			return
		}
		var input runnerRequest
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&input); err != nil {
			http.Error(w, "некорректный запрос", 400)
			return
		}
		if err := decoder.Decode(new(any)); err != io.EOF {
			http.Error(w, "некорректный запрос", 400)
			return
		}
		target, err := validateRunnerTarget(input.Kind, input.Target)
		if err != nil {
			http.Error(w, "недопустимые параметры проверки", 400)
			return
		}
		select {
		case slots <- struct{}{}:
			defer func() { <-slots }()
		default:
			http.Error(w, "runner занят", http.StatusTooManyRequests)
			return
		}
		timeout := time.Duration(target.PacketCount*3+10) * time.Second
		if input.Kind == "iperf" {
			timeout = time.Duration(target.IperfDurationSeconds+10) * time.Second
		}
		ctx, cancel := context.WithTimeout(r.Context(), timeout)
		defer cancel()
		var result Result
		if input.Kind == "path" {
			result, err = executor.Path(ctx, target)
		} else {
			result, err = executor.Iperf(ctx, target)
		}
		response := runnerResponse{Result: &result}
		if err != nil {
			response.Error = "runner не завершил сетевую проверку"
		}
		encoded, err := json.Marshal(response)
		if err != nil || len(encoded) > maxRunnerBody {
			http.Error(w, "некорректный результат runner", 502)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(encoded)
	})
	return mux
}

func validateRunnerTarget(kind string, target Target) (Target, error) {
	if kind != "path" && kind != "iperf" {
		return Target{}, errors.New("неизвестный вид проверки")
	}
	if kind == "iperf" && (!target.IperfEnabled || (target.IperfDirection != "upload" && target.IperfDirection != "download")) {
		return Target{}, errors.New("недопустимые параметры iperf3")
	}
	input, err := targets.Validate(targets.Input{Name: "runner", Host: target.Host, ProbeMode: target.ProbeMode, ProbePort: target.ProbePort, PacketCount: target.PacketCount, IntervalSeconds: 60, IperfEnabled: target.IperfEnabled, IperfHost: target.IperfHost, IperfPort: target.IperfPort, IperfDurationSeconds: target.IperfDurationSeconds})
	if err != nil {
		return Target{}, err
	}
	target.Host, target.ProbeMode, target.ProbePort = input.Host, input.ProbeMode, input.ProbePort
	target.IperfHost = input.IperfHost
	return target, nil
}

type RemoteExecutor struct {
	endpoint, token string
	client          *http.Client
}

func NewRemoteExecutor(endpoint, token string) (*RemoteExecutor, error) {
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Scheme != "http" || parsed.Hostname() == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return nil, errors.New("WAYLINE_RUNNER_URL должен быть HTTP-адресом изолированного runner")
	}
	return &RemoteExecutor{endpoint: strings.TrimRight(endpoint, "/") + "/v1/probes", token: token, client: &http.Client{Transport: &http.Transport{Proxy: nil, MaxIdleConns: 16, MaxConnsPerHost: 16, IdleConnTimeout: 60 * time.Second}, Timeout: 190 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}
func (e *RemoteExecutor) Path(ctx context.Context, t Target) (Result, error) {
	return e.run(ctx, "path", t)
}
func (e *RemoteExecutor) Iperf(ctx context.Context, t Target) (Result, error) {
	return e.run(ctx, "iperf", t)
}
func (e *RemoteExecutor) run(ctx context.Context, kind string, target Target) (Result, error) {
	data, err := json.Marshal(runnerRequest{Kind: kind, Target: target})
	if err != nil {
		return Result{}, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, e.endpoint, bytes.NewReader(data))
	if err != nil {
		return Result{}, errors.New("некорректный запрос runner")
	}
	request.Header.Set("Content-Type", "application/json")
	if e.token != "" {
		request.Header.Set("Authorization", "Bearer "+e.token)
	}
	response, err := e.client.Do(request)
	if err != nil {
		return Result{}, errors.New("изолированный runner недоступен")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return Result{}, errors.New("изолированный runner отклонил проверку")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxRunnerBody+1))
	if err != nil || len(body) > maxRunnerBody {
		return Result{}, errors.New("некорректный результат runner")
	}
	var output runnerResponse
	if err := json.Unmarshal(body, &output); err != nil {
		return Result{}, errors.New("некорректный результат runner")
	}
	if output.Error != "" {
		return Result{}, errors.New("runner не завершил сетевую проверку")
	}
	if output.Result == nil {
		return Result{}, errors.New("runner не вернул результат проверки")
	}
	return *output.Result, nil
}

func ReadRunnerToken(path string) (string, error) {
	if path == "" {
		return "", nil
	}
	file, err := os.Open(path)
	if err != nil {
		return "", errors.New("не удалось прочитать токен runner")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 4096 || info.Mode().Perm()&0007 != 0 {
		return "", errors.New("недопустимый файл токена runner")
	}
	data, err := io.ReadAll(io.LimitReader(file, 4097))
	token := strings.TrimSpace(string(data))
	if err != nil || len(token) < 32 || len(token) > 4096 || strings.ContainsAny(token, "\r\n\t ") {
		return "", errors.New("недопустимый токен runner")
	}
	return token, nil
}

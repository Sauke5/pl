package probes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type runnerStub struct {
	calls   atomic.Int32
	block   chan struct{}
	entered chan struct{}
	fail    bool
}

func (s *runnerStub) Path(ctx context.Context, target Target) (Result, error) {
	s.calls.Add(1)
	if s.entered != nil {
		s.entered <- struct{}{}
	}
	if s.block != nil {
		select {
		case <-s.block:
		case <-ctx.Done():
			return Result{}, ctx.Err()
		}
	}
	if s.fail {
		return Result{}, errors.New("private executor output")
	}
	return Result{LossPercent: floatPointer(0)}, nil
}
func (s *runnerStub) Iperf(ctx context.Context, target Target) (Result, error) {
	return s.Path(ctx, target)
}
func runnerTarget() Target { return Target{Host: "example.invalid", ProbeMode: "icmp", PacketCount: 5} }

const testRunnerToken = "0123456789abcdef0123456789abcdef"

func TestRunnerRoundTripAndErrorRedaction(t *testing.T) {
	executor := &runnerStub{}
	server := httptest.NewServer(RunnerHandler(executor, testRunnerToken, 1))
	defer server.Close()
	remote, err := NewRemoteExecutor(server.URL, testRunnerToken)
	if err != nil {
		t.Fatal(err)
	}
	result, err := remote.Path(context.Background(), runnerTarget())
	if err != nil || result.LossPercent == nil || *result.LossPercent != 0 {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	executor.fail = true
	_, err = remote.Path(context.Background(), runnerTarget())
	if err == nil || strings.Contains(err.Error(), "private") {
		t.Fatalf("unsafe error: %v", err)
	}
}

func TestRunnerRejectsInvalidInputBeforeExecutor(t *testing.T) {
	for _, test := range []struct {
		name, body, token string
		status            int
	}{
		{"auth", `{"kind":"path","target":{"Host":"example.invalid","ProbeMode":"icmp","PacketCount":5}}`, "", 401},
		{"shell-host", `{"kind":"path","target":{"Host":";touch /tmp/no","ProbeMode":"icmp","PacketCount":5}}`, testRunnerToken, 400},
		{"packets", `{"kind":"path","target":{"Host":"example.invalid","ProbeMode":"icmp","PacketCount":1000000}}`, testRunnerToken, 400},
		{"unknown", `{"kind":"path","command":"whoami"}`, testRunnerToken, 400},
		{"trailing", `{"kind":"path"} {}`, testRunnerToken, 400},
		{"oversize", strings.Repeat("x", 17000), testRunnerToken, 400},
		{"iperf-port", `{"kind":"iperf","target":{"Host":"example.invalid","ProbeMode":"icmp","PacketCount":5,"IperfEnabled":true,"IperfHost":"example.invalid","IperfPort":22,"IperfDurationSeconds":10,"IperfDirection":"upload"}}`, testRunnerToken, 400},
	} {
		t.Run(test.name, func(t *testing.T) {
			executor := &runnerStub{}
			request := httptest.NewRequest("POST", "/v1/probes", strings.NewReader(test.body))
			request.Header.Set("Authorization", "Bearer "+test.token)
			response := httptest.NewRecorder()
			RunnerHandler(executor, testRunnerToken, 1).ServeHTTP(response, request)
			if response.Code != test.status || executor.calls.Load() != 0 {
				t.Fatalf("status=%d calls=%d", response.Code, executor.calls.Load())
			}
		})
	}
}

func TestRunnerConcurrencyRejectsRatherThanQueues(t *testing.T) {
	executor := &runnerStub{block: make(chan struct{}), entered: make(chan struct{}, 1)}
	server := httptest.NewServer(RunnerHandler(executor, testRunnerToken, 1))
	defer server.Close()
	remote, _ := NewRemoteExecutor(server.URL, testRunnerToken)
	done := make(chan error, 1)
	go func() { _, err := remote.Path(context.Background(), runnerTarget()); done <- err }()
	select {
	case <-executor.entered:
	case <-time.After(time.Second):
		t.Fatal("executor not entered")
	}
	body, _ := json.Marshal(runnerRequest{Kind: "path", Target: runnerTarget()})
	request, _ := http.NewRequest("POST", server.URL+"/v1/probes", strings.NewReader(string(body)))
	request.Header.Set("Authorization", "Bearer "+testRunnerToken)
	response, err := http.DefaultClient.Do(request)
	close(executor.block)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 429 {
		t.Fatalf("status=%d", response.StatusCode)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestRemoteRunnerDoesNotFollowRedirectOrForwardToken(t *testing.T) {
	var leaked atomic.Bool
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked.Store(true) }))
	defer destination.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, destination.URL, 307) }))
	defer server.Close()
	remote, _ := NewRemoteExecutor(server.URL, testRunnerToken)
	if _, err := remote.Path(context.Background(), runnerTarget()); err == nil || leaked.Load() {
		t.Fatal("redirect followed or accepted")
	}
}
func TestRunnerTokenFilePermissionsAndBounds(t *testing.T) {
	path := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(path, []byte(testRunnerToken), 0600); err != nil {
		t.Fatal(err)
	}
	if token, err := ReadRunnerToken(path); err != nil || token != testRunnerToken {
		t.Fatal("valid token rejected")
	}
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadRunnerToken(path); err == nil {
		t.Fatal("public token accepted")
	}
	if err := os.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("short"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadRunnerToken(path); err == nil {
		t.Fatal("short token accepted")
	}
}
func TestRemoteRunnerRejectsAmbiguousEndpoints(t *testing.T) {
	for _, endpoint := range []string{"https://runner:8081", "http://user:pass@runner:8081", "http://runner:8081/private", "http://runner:8081?token=x", "http://runner:8081#x"} {
		if _, err := NewRemoteExecutor(endpoint, testRunnerToken); err == nil {
			t.Fatalf("accepted endpoint %q", endpoint)
		}
	}
}

func TestRunnerDeadlineAndCancellationReachExecutor(t *testing.T) {
	executor := &runnerStub{block: make(chan struct{}), entered: make(chan struct{}, 1)}
	server := httptest.NewServer(RunnerHandler(executor, testRunnerToken, 1))
	defer server.Close()
	remote, _ := NewRemoteExecutor(server.URL, testRunnerToken)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := remote.Path(ctx, runnerTarget()); done <- err }()
	select {
	case <-executor.entered:
	case <-time.After(time.Second):
		t.Fatal("executor not entered")
	}
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancellation ignored")
		}
	case <-time.After(time.Second):
		t.Fatal("remote cancellation blocked")
	}
}
func TestBoundedCommandOutputRejectsOverflow(t *testing.T) {
	output := &boundedOutput{limit: 4}
	if _, err := output.Write([]byte("abc")); err != nil {
		t.Fatal(err)
	}
	if _, err := output.Write([]byte("de")); err == nil || !output.overflow || output.buffer.Len() != 4 {
		t.Fatal("output limit not enforced")
	}
}

package httpapi

import (
	"context"
	"errors"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"wayline.local/backend/internal/checks"
	"wayline.local/backend/internal/targets"
)

type probeStub struct{}

func (probeStub) Path(context.Context, checks.ProbeTarget) (checks.Result, error) {
	loss := 0.0
	latency := 1.5
	return checks.Result{LossPercent: &loss, AvgLatencyMS: &latency, Hops: []checks.Hop{}}, nil
}
func (probeStub) Iperf(context.Context, checks.ProbeTarget) (checks.Result, error) {
	throughput := 1000000.0
	return checks.Result{ThroughputBPS: &throughput}, nil
}

func checkTestHandler(t *testing.T) http.Handler {
	t.Helper()
	repository, err := targets.OpenSQLite(filepath.Join(t.TempDir(), "wayline.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = repository.Close() })
	targetService := targets.NewService(repository)
	checkService := checks.NewService(targetService, checks.NewSQLiteRepository(repository.DB()), checks.NewLocalDispatcher(probeStub{}))
	return New("test", targetService, checkService, repository).Handler()
}

func TestChecksAPIWorkflowAndMetrics(t *testing.T) {
	handler := checkTestHandler(t)
	created := request(t, handler, http.MethodPost, "/api/v1/targets", validTargetJSON)
	if created.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", created.Code, created.Body.String())
	}
	run := request(t, handler, http.MethodPost, "/api/v1/targets/1/checks", `{"kind":"path"}`)
	if run.Code != http.StatusCreated || !strings.Contains(run.Body.String(), `"status":"success"`) || !strings.Contains(run.Body.String(), `"execution_type":"local"`) || !strings.Contains(run.Body.String(), `"execution_id":null`) {
		t.Fatalf("run = %d %s", run.Code, run.Body.String())
	}
	list := request(t, handler, http.MethodGet, "/api/v1/checks?target_id=1&kind=path&limit=10", "")
	if list.Code != http.StatusOK || !strings.Contains(list.Body.String(), `"checks":[`) {
		t.Fatalf("list = %d %s", list.Code, list.Body.String())
	}
	detail := request(t, handler, http.MethodGet, "/api/v1/checks/1", "")
	if detail.Code != http.StatusOK || !strings.Contains(detail.Body.String(), `"target_id":1`) {
		t.Fatalf("detail = %d %s", detail.Code, detail.Body.String())
	}
	iperf := request(t, handler, http.MethodPost, "/api/v1/targets/1/checks", `{"kind":"iperf"}`)
	if iperf.Code != http.StatusCreated || !strings.Contains(iperf.Body.String(), `"direction":"upload"`) {
		t.Fatalf("iperf = %d %s", iperf.Code, iperf.Body.String())
	}
	download := request(t, handler, http.MethodPost, "/api/v1/targets/1/checks", `{"kind":"iperf","direction":"download"}`)
	if download.Code != http.StatusCreated || !strings.Contains(download.Body.String(), `"direction":"download"`) {
		t.Fatalf("download = %d %s", download.Code, download.Body.String())
	}
	latest := request(t, handler, http.MethodGet, "/api/v1/checks/latest?kind=path", "")
	if latest.Code != http.StatusOK || !strings.Contains(latest.Body.String(), `"kind":"path"`) || strings.Contains(latest.Body.String(), `"kind":"iperf"`) {
		t.Fatalf("latest = %d %s", latest.Code, latest.Body.String())
	}
	metrics := request(t, handler, http.MethodGet, "/metrics", "")
	if metrics.Code != http.StatusOK || !strings.Contains(metrics.Body.String(), `wayline_checks_total{kind="path",status="success"} 1`) || !strings.Contains(metrics.Body.String(), `wayline_target_status{target_id="1",target="SERVER-A",status="success"} 1`) {
		t.Fatalf("metrics = %d %s", metrics.Code, metrics.Body.String())
	}
}

func TestChecksAPIRejectsInvalidInput(t *testing.T) {
	handler := checkTestHandler(t)
	invalid := request(t, handler, http.MethodPost, "/api/v1/targets/1/checks", `{"kind":"speedtest"}`)
	if invalid.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid missing target = %d %s", invalid.Code, invalid.Body.String())
	}
	badLimit := request(t, handler, http.MethodGet, "/api/v1/checks?limit=501", "")
	if badLimit.Code != http.StatusBadRequest {
		t.Fatalf("bad limit = %d %s", badLimit.Code, badLimit.Body.String())
	}
	badKind := request(t, handler, http.MethodGet, "/api/v1/checks?kind=speedtest", "")
	if badKind.Code != http.StatusBadRequest {
		t.Fatalf("bad kind = %d %s", badKind.Code, badKind.Body.String())
	}
	created := request(t, handler, http.MethodPost, "/api/v1/targets", validTargetJSON)
	if created.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", created.Code, created.Body.String())
	}
	badDirection := request(t, handler, http.MethodPost, "/api/v1/targets/1/checks", `{"kind":"iperf","direction":"sideways"}`)
	if badDirection.Code != http.StatusUnprocessableEntity || !strings.Contains(badDirection.Body.String(), `"code":"invalid_check_direction"`) {
		t.Fatalf("bad direction = %d %s", badDirection.Code, badDirection.Body.String())
	}
	pathDirection := request(t, handler, http.MethodPost, "/api/v1/targets/1/checks", `{"kind":"path","direction":"download"}`)
	if pathDirection.Code != http.StatusUnprocessableEntity {
		t.Fatalf("path direction = %d %s", pathDirection.Code, pathDirection.Body.String())
	}
}

func TestChecksAPIRejectsManualRunForDisabledTarget(t *testing.T) {
	handler := checkTestHandler(t)
	disabled := strings.Replace(validTargetJSON, `"enabled":true`, `"enabled":false`, 1)
	created := request(t, handler, http.MethodPost, "/api/v1/targets", disabled)
	if created.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", created.Code, created.Body.String())
	}
	run := request(t, handler, http.MethodPost, "/api/v1/targets/1/checks", `{"kind":"path"}`)
	if run.Code != http.StatusConflict || !strings.Contains(run.Body.String(), `"code":"target_disabled"`) {
		t.Fatalf("run = %d %s", run.Code, run.Body.String())
	}
}

func TestMetricsReportsDatabaseFailureBeforeWritingPayload(t *testing.T) {
	repository, err := targets.OpenSQLite(filepath.Join(t.TempDir(), "wayline.db"))
	if err != nil {
		t.Fatal(err)
	}
	targetService := targets.NewService(repository)
	checkService := checks.NewService(targetService, checks.NewSQLiteRepository(repository.DB()), checks.NewLocalDispatcher(probeStub{}))
	handler := New("test", targetService, checkService, repository).Handler()
	if err := repository.Close(); err != nil {
		t.Fatal(err)
	}
	metrics := request(t, handler, http.MethodGet, "/metrics", "")
	if metrics.Code != http.StatusInternalServerError || strings.Contains(metrics.Body.String(), "wayline_build_info") {
		t.Fatalf("metrics = %d %s", metrics.Code, metrics.Body.String())
	}
}

type readinessStub struct{ err error }

func (s readinessStub) Ping(context.Context) error { return s.err }
func TestReadinessReportsDatabaseFailure(t *testing.T) {
	recorder := request(t, New("test", readinessStub{err: errors.New("closed")}).Handler(), http.MethodGet, "/api/v1/ready", "")
	if recorder.Code != http.StatusServiceUnavailable || !strings.Contains(recorder.Body.String(), "база Wayline временно недоступна") {
		t.Fatalf("ready = %d %s", recorder.Code, recorder.Body.String())
	}
}

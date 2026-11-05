package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"wayline.local/backend/internal/targets"
)

func targetTestHandler(t *testing.T) http.Handler {
	t.Helper()
	repository, err := targets.OpenSQLite(filepath.Join(t.TempDir(), "wayline.db"))
	if err != nil {
		t.Fatalf("OpenSQLite() error = %v", err)
	}
	t.Cleanup(func() { _ = repository.Close() })
	return New("test", targets.NewService(repository)).Handler()
}

const validTargetJSON = `{
	"enabled":true,
  "name":"SERVER-A",
  "host":"server.example.invalid",
  "probe_mode":"icmp",
	"probe_port":0,
  "interval_seconds":60,
  "packet_count":10,
  "loss_threshold_percent":2.5,
  "iperf_enabled":true,
  "iperf_host":"server.example.invalid",
  "iperf_port":5201,
  "iperf_duration_seconds":10
}`

func TestTargetsAPIWorkflow(t *testing.T) {
	handler := targetTestHandler(t)

	create := request(t, handler, http.MethodPost, "/api/v1/targets", validTargetJSON)
	if create.Code != http.StatusCreated {
		t.Fatalf("POST status = %d, body = %s", create.Code, create.Body.String())
	}
	var created targets.Target
	if err := json.Unmarshal(create.Body.Bytes(), &created); err != nil || created.ID < 1 {
		t.Fatalf("POST response = %s, error = %v", create.Body.String(), err)
	}

	list := request(t, handler, http.MethodGet, "/api/v1/targets", "")
	if list.Code != http.StatusOK || !strings.Contains(list.Body.String(), `"name":"SERVER-A"`) {
		t.Fatalf("GET collection status = %d, body = %s", list.Code, list.Body.String())
	}

	itemPath := "/api/v1/targets/" + jsonNumber(created.ID)
	get := request(t, handler, http.MethodGet, itemPath, "")
	if get.Code != http.StatusOK || !strings.Contains(get.Body.String(), `"host":"server.example.invalid"`) {
		t.Fatalf("GET item status = %d, body = %s", get.Code, get.Body.String())
	}

	updatedJSON := strings.ReplaceAll(validTargetJSON, "SERVER-A", "SERVER-B")
	update := request(t, handler, http.MethodPut, itemPath, updatedJSON)
	if update.Code != http.StatusOK || !strings.Contains(update.Body.String(), `"name":"SERVER-B"`) {
		t.Fatalf("PUT status = %d, body = %s", update.Code, update.Body.String())
	}

	deleted := request(t, handler, http.MethodDelete, itemPath, "")
	if deleted.Code != http.StatusNoContent || deleted.Body.Len() != 0 {
		t.Fatalf("DELETE status = %d, body = %s", deleted.Code, deleted.Body.String())
	}
	notFound := request(t, handler, http.MethodGet, itemPath, "")
	if notFound.Code != http.StatusNotFound || !strings.Contains(notFound.Body.String(), "цель не найдена") {
		t.Fatalf("GET deleted status = %d, body = %s", notFound.Code, notFound.Body.String())
	}
}

func TestTargetsAPIValidationAndJSONErrors(t *testing.T) {
	handler := targetTestHandler(t)

	invalid := request(t, handler, http.MethodPost, "/api/v1/targets", `{}`)
	if invalid.Code != http.StatusUnprocessableEntity || !strings.Contains(invalid.Body.String(), `"host"`) || !strings.Contains(invalid.Body.String(), "проверьте параметры цели") {
		t.Fatalf("validation status = %d, body = %s", invalid.Code, invalid.Body.String())
	}

	unknown := request(t, handler, http.MethodPost, "/api/v1/targets", `{"unknown":true}`)
	if unknown.Code != http.StatusBadRequest || !strings.Contains(unknown.Body.String(), "неизвестное поле") {
		t.Fatalf("unknown field status = %d, body = %s", unknown.Code, unknown.Body.String())
	}

	badID := request(t, handler, http.MethodGet, "/api/v1/targets/nope", "")
	if badID.Code != http.StatusBadRequest || !strings.Contains(badID.Body.String(), "неверный идентификатор") {
		t.Fatalf("bad ID status = %d, body = %s", badID.Code, badID.Body.String())
	}
}

func request(t *testing.T, handler http.Handler, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	handler.ServeHTTP(recorder, request)
	return recorder
}

func jsonNumber(value int64) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

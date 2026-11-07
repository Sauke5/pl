package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRequestLoggingCorrelatesSafeFailureCodes(t *testing.T) {
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	mux := http.NewServeMux()
	mux.HandleFunc("POST /items/{id}", func(w http.ResponseWriter, r *http.Request) {
		if r.PathValue("id") == "csrf" {
			problem(w, http.StatusForbidden, "csrf", "private response text")
			return
		}
		(&Server{}).fail(w, errors.New("private error text"))
	})
	mux.HandleFunc("GET /health/ready", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	handler := logHTTPRequests(mux)
	const proxyID = "d335dbac37fa40129d706bd68fa57fb3"
	for _, spec := range []struct {
		path, id, code string
		status         int
	}{
		{"csrf", proxyID, "csrf", http.StatusForbidden},
		{"private-path", "private-header", "internal_error", http.StatusInternalServerError},
	} {
		req := httptest.NewRequest("POST", "/items/"+spec.path+"?token=private-query", strings.NewReader("private-body"))
		req.Header.Set("X-Request-ID", spec.id)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		id := w.Header().Get("X-Request-ID")
		if w.Code != spec.status || !requestIDPattern.MatchString(id) || (spec.id == proxyID && id != proxyID) {
			t.Fatalf("unexpected response %d, request ID %s", w.Code, id)
		}
		line, err := logs.ReadString('\n')
		if err != nil || strings.Contains(line, "private") {
			t.Fatalf("missing or sensitive request log %q: %v", line, err)
		}
		var entry map[string]any
		if err = json.Unmarshal([]byte(line), &entry); err != nil || entry["request_id"] != id || entry["route"] != "POST /items/{id}" ||
			entry["status"] != float64(spec.status) || entry["error_code"] != spec.code || entry["duration_ms"] == nil {
			t.Fatalf("invalid request log: %s", line)
		}
	}
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/health/ready", nil))
	if logs.Len() != 0 {
		t.Fatalf("routine probe logged: %s", &logs)
	}
}

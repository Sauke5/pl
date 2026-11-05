package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"wayline.local/backend/internal/checks"
	"wayline.local/backend/internal/targets"
)

type TargetService interface {
	Create(context.Context, targets.Input) (targets.Target, error)
	List(context.Context) ([]targets.Target, error)
	Get(context.Context, int64) (targets.Target, error)
	Update(context.Context, int64, targets.Input) (targets.Target, error)
	Delete(context.Context, int64) error
}

type CheckService interface {
	Run(context.Context, int64, string) (checks.Run, error)
	RunDirection(context.Context, int64, string, string) (checks.Run, error)
	List(context.Context, *int64, *string, int) ([]checks.Run, error)
	Get(context.Context, int64) (checks.Run, error)
	Latest(context.Context, *string) ([]checks.Run, error)
	Metrics(context.Context) (checks.Metrics, error)
}

type ReadinessChecker interface{ Ping(context.Context) error }

type Server struct {
	version   string
	startedAt time.Time
	targets   TargetService
	checks    CheckService
	readiness ReadinessChecker
}

func New(version string, dependencies ...any) *Server {
	server := &Server{version: version, startedAt: time.Now().UTC()}
	for _, dependency := range dependencies {
		if value, ok := dependency.(TargetService); ok && server.targets == nil {
			server.targets = value
		}
		if value, ok := dependency.(CheckService); ok {
			server.checks = value
		}
		if value, ok := dependency.(ReadinessChecker); ok {
			server.readiness = value
		}
	}
	return server
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/health", s.health)
	mux.HandleFunc("GET /api/v1/ready", s.ready)
	mux.HandleFunc("POST /api/v1/targets", s.createTarget)
	mux.HandleFunc("GET /api/v1/targets", s.listTargets)
	mux.HandleFunc("GET /api/v1/targets/{id}", s.getTarget)
	mux.HandleFunc("PUT /api/v1/targets/{id}", s.updateTarget)
	mux.HandleFunc("DELETE /api/v1/targets/{id}", s.deleteTarget)
	mux.HandleFunc("POST /api/v1/targets/{id}/checks", s.runCheck)
	mux.HandleFunc("GET /api/v1/checks", s.listChecks)
	mux.HandleFunc("GET /api/v1/checks/latest", s.latestChecks)
	mux.HandleFunc("GET /api/v1/checks/{id}", s.getCheck)
	mux.HandleFunc("GET /metrics", s.metrics)
	return mux
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status":     "ok",
		"service":    "wayline-api",
		"version":    s.version,
		"started_at": s.startedAt.Format(time.RFC3339),
	})
}

func (s *Server) ready(w http.ResponseWriter, r *http.Request) {
	if s.readiness != nil {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := s.readiness.Ping(ctx); err != nil {
			writeAPIError(w, http.StatusServiceUnavailable, "not_ready", "база Wayline временно недоступна", nil)
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

func (s *Server) metrics(w http.ResponseWriter, r *http.Request) {
	var metrics checks.Metrics
	if s.checks != nil {
		var err error
		metrics, err = s.checks.Metrics(r.Context())
		if err != nil {
			http.Error(w, "не удалось получить метрики", http.StatusInternalServerError)
			return
		}
	}
	var body bytes.Buffer
	fmt.Fprintln(&body, "# HELP wayline_build_info Static build information for Wayline.")
	fmt.Fprintln(&body, "# TYPE wayline_build_info gauge")
	fmt.Fprintf(&body, "wayline_build_info{version=%q} 1\n", s.version)
	fmt.Fprintln(&body, "# HELP wayline_checks_total Current number of saved Wayline checks; retention and target deletion can decrease it.")
	fmt.Fprintln(&body, "# TYPE wayline_checks_total gauge")
	for _, item := range metrics.Counts {
		fmt.Fprintf(&body, "wayline_checks_total{kind=%q,status=%q} %d\n", item.Kind, item.Status, item.Count)
	}
	fmt.Fprintln(&body, "# HELP wayline_target_status Latest target status (1 for current status).")
	fmt.Fprintln(&body, "# TYPE wayline_target_status gauge")
	for _, item := range metrics.Latest {
		if item.Status != "" {
			fmt.Fprintf(&body, "wayline_target_status{target_id=%q,target=%q,status=%q} 1\n", strconv.FormatInt(item.TargetID, 10), item.Name, item.Status)
		}
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body.Bytes())
}

func (s *Server) runCheck(w http.ResponseWriter, r *http.Request) {
	if !s.checksAvailable(w) {
		return
	}
	id, ok := targetID(w, r)
	if !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var input checks.Request
	if err := decoder.Decode(&input); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid_json", "тело запроса должно содержать корректный JSON", nil)
		return
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeAPIError(w, http.StatusBadRequest, "invalid_json", "после JSON-объекта обнаружены лишние данные", nil)
		return
	}
	run, err := s.checks.RunDirection(r.Context(), id, strings.ToLower(strings.TrimSpace(input.Kind)), strings.ToLower(strings.TrimSpace(input.Direction)))
	if err != nil {
		writeCheckError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, run)
}

func (s *Server) listChecks(w http.ResponseWriter, r *http.Request) {
	if !s.checksAvailable(w) {
		return
	}
	limit := 100
	if raw := r.URL.Query().Get("limit"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > 500 {
			writeAPIError(w, http.StatusBadRequest, "invalid_limit", "limit должен быть от 1 до 500", nil)
			return
		}
		limit = value
	}
	var targetID *int64
	if raw := r.URL.Query().Get("target_id"); raw != "" {
		value, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || value < 1 {
			writeAPIError(w, http.StatusBadRequest, "invalid_target_id", "неверный идентификатор цели", nil)
			return
		}
		targetID = &value
	}
	kind, ok := checkKindQuery(w, r)
	if !ok {
		return
	}
	items, err := s.checks.List(r.Context(), targetID, kind, limit)
	if err != nil {
		writeCheckError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"checks": items})
}

func (s *Server) getCheck(w http.ResponseWriter, r *http.Request) {
	if !s.checksAvailable(w) {
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id < 1 {
		writeAPIError(w, http.StatusBadRequest, "invalid_id", "неверный идентификатор проверки", nil)
		return
	}
	run, err := s.checks.Get(r.Context(), id)
	if err != nil {
		writeCheckError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, run)
}

func (s *Server) latestChecks(w http.ResponseWriter, r *http.Request) {
	if !s.checksAvailable(w) {
		return
	}
	kind, ok := checkKindQuery(w, r)
	if !ok {
		return
	}
	items, err := s.checks.Latest(r.Context(), kind)
	if err != nil {
		writeCheckError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"checks": items})
}

func checkKindQuery(w http.ResponseWriter, r *http.Request) (*string, bool) {
	raw := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("kind")))
	if raw == "" {
		return nil, true
	}
	if raw != checks.KindPath && raw != checks.KindIperf {
		writeAPIError(w, http.StatusBadRequest, "invalid_check_kind", checks.ErrInvalidKind.Error(), map[string]string{"kind": checks.ErrInvalidKind.Error()})
		return nil, false
	}
	return &raw, true
}

func (s *Server) checksAvailable(w http.ResponseWriter) bool {
	if s.checks == nil {
		writeAPIError(w, http.StatusServiceUnavailable, "service_unavailable", "служба проверок временно недоступна", nil)
		return false
	}
	return true
}

func writeCheckError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, checks.ErrInvalidKind):
		writeAPIError(w, http.StatusUnprocessableEntity, "invalid_check_kind", err.Error(), map[string]string{"kind": err.Error()})
	case errors.Is(err, checks.ErrInvalidDirection):
		writeAPIError(w, http.StatusUnprocessableEntity, "invalid_check_direction", err.Error(), map[string]string{"direction": err.Error()})
	case errors.Is(err, checks.ErrIperfDisabled):
		writeAPIError(w, http.StatusConflict, "iperf_disabled", err.Error(), nil)
	case errors.Is(err, checks.ErrTargetDisabled):
		writeAPIError(w, http.StatusConflict, "target_disabled", err.Error(), nil)
	case errors.Is(err, checks.ErrAlreadyRunning):
		writeAPIError(w, http.StatusConflict, "check_already_running", err.Error(), nil)
	case errors.Is(err, checks.ErrNotFound):
		writeAPIError(w, http.StatusNotFound, "check_not_found", checks.ErrNotFound.Error(), nil)
	case errors.Is(err, targets.ErrNotFound):
		writeAPIError(w, http.StatusNotFound, "target_not_found", targets.ErrNotFound.Error(), nil)
	default:
		writeAPIError(w, http.StatusInternalServerError, "internal_error", "не удалось выполнить операцию с проверкой", nil)
	}
}

func (s *Server) createTarget(w http.ResponseWriter, r *http.Request) {
	if !s.targetsAvailable(w) {
		return
	}
	input, ok := decodeTargetInput(w, r)
	if !ok {
		return
	}
	target, err := s.targets.Create(r.Context(), input)
	if err != nil {
		writeTargetError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, target)
}

func (s *Server) listTargets(w http.ResponseWriter, r *http.Request) {
	if !s.targetsAvailable(w) {
		return
	}
	items, err := s.targets.List(r.Context())
	if err != nil {
		writeTargetError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"targets": items})
}

func (s *Server) getTarget(w http.ResponseWriter, r *http.Request) {
	if !s.targetsAvailable(w) {
		return
	}
	id, ok := targetID(w, r)
	if !ok {
		return
	}
	target, err := s.targets.Get(r.Context(), id)
	if err != nil {
		writeTargetError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, target)
}

func (s *Server) updateTarget(w http.ResponseWriter, r *http.Request) {
	if !s.targetsAvailable(w) {
		return
	}
	id, ok := targetID(w, r)
	if !ok {
		return
	}
	input, ok := decodeTargetInput(w, r)
	if !ok {
		return
	}
	target, err := s.targets.Update(r.Context(), id, input)
	if err != nil {
		writeTargetError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, target)
}

func (s *Server) deleteTarget(w http.ResponseWriter, r *http.Request) {
	if !s.targetsAvailable(w) {
		return
	}
	id, ok := targetID(w, r)
	if !ok {
		return
	}
	if err := s.targets.Delete(r.Context(), id); err != nil {
		writeTargetError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) targetsAvailable(w http.ResponseWriter) bool {
	if s.targets == nil {
		writeAPIError(w, http.StatusServiceUnavailable, "service_unavailable", "хранилище целей временно недоступно", nil)
		return false
	}
	return true
}

func targetID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id < 1 {
		writeAPIError(w, http.StatusBadRequest, "invalid_id", "неверный идентификатор цели", nil)
		return 0, false
	}
	return id, true
}

func decodeTargetInput(w http.ResponseWriter, r *http.Request) (targets.Input, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var input targets.Input
	if err := decoder.Decode(&input); err != nil {
		message := "тело запроса должно содержать корректный JSON"
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			message = "тело запроса слишком большое"
		} else if stringsHasPrefix(err.Error(), "json: unknown field ") {
			message = "запрос содержит неизвестное поле"
		}
		writeAPIError(w, http.StatusBadRequest, "invalid_json", message, nil)
		return targets.Input{}, false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeAPIError(w, http.StatusBadRequest, "invalid_json", "после JSON-объекта обнаружены лишние данные", nil)
		return targets.Input{}, false
	}
	return input, true
}

func writeTargetError(w http.ResponseWriter, err error) {
	var validationError *targets.ValidationError
	switch {
	case errors.As(err, &validationError):
		writeAPIError(w, http.StatusUnprocessableEntity, "validation_error", validationError.Error(), validationError.Fields)
	case errors.Is(err, targets.ErrNotFound):
		writeAPIError(w, http.StatusNotFound, "target_not_found", targets.ErrNotFound.Error(), nil)
	case errors.Is(err, targets.ErrConflict):
		writeAPIError(w, http.StatusConflict, "target_conflict", targets.ErrConflict.Error(), nil)
	default:
		writeAPIError(w, http.StatusInternalServerError, "internal_error", "не удалось выполнить операцию с целью", nil)
	}
}

func writeAPIError(w http.ResponseWriter, status int, code, message string, fields map[string]string) {
	payload := map[string]any{"code": code, "message": message}
	if len(fields) > 0 {
		payload["fields"] = fields
	}
	writeJSON(w, status, map[string]any{"error": payload})
}

func stringsHasPrefix(value, prefix string) bool {
	return len(value) >= len(prefix) && value[:len(prefix)] == prefix
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

package server

import (
	"bufio"
	"context"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"regexp"
	"time"

	"github.com/google/uuid"
)

var requestIDPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)
var problemCodePattern = regexp.MustCompile(`^[a-zA-Z0-9_.-]{1,80}$`)

type requestLogKey struct{}

func requestID(ctx context.Context) string {
	id, _ := ctx.Value(requestLogKey{}).(string)
	return id
}

type requestLogWriter struct {
	http.ResponseWriter
	status    int
	code      string
	errorType string
}

func (w *requestLogWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *requestLogWriter) WriteHeader(status int) {
	if w.status == 0 && (status >= 200 || status == http.StatusSwitchingProtocols) {
		w.status = status
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *requestLogWriter) wroteBody() {
	if w.status == 0 {
		w.status = http.StatusOK
	}
}

func (w *requestLogWriter) Write(p []byte) (int, error) {
	w.wroteBody()
	return w.ResponseWriter.Write(p)
}

func (w *requestLogWriter) ReadFrom(r io.Reader) (int64, error) {
	w.wroteBody()
	return io.Copy(w.ResponseWriter, r)
}

func (w *requestLogWriter) Flush() { _ = w.FlushError() }

func (w *requestLogWriter) FlushError() error {
	err := http.NewResponseController(w.ResponseWriter).Flush()
	if err == nil {
		w.wroteBody()
	}
	return err
}

func (w *requestLogWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	conn, buf, err := http.NewResponseController(w.ResponseWriter).Hijack()
	if err == nil && w.status == 0 {
		w.status = http.StatusSwitchingProtocols
	}
	return conn, buf, err
}

func logHTTPRequests(next http.Handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-ID")
		if !requestIDPattern.MatchString(id) {
			generated := uuid.New()
			id = hex.EncodeToString(generated[:])
		}
		w.Header().Set("X-Request-ID", id)
		r = r.WithContext(context.WithValue(r.Context(), requestLogKey{}, id))
		started := time.Now()
		logged := &requestLogWriter{ResponseWriter: w}
		completed := false
		defer func() {
			if completed {
				logged.wroteBody()
				if logged.status < 400 && (r.Pattern == "GET /health/live" || r.Pattern == "GET /health/ready") {
					return
				}
			}
			level := slog.LevelInfo
			switch {
			case !completed || logged.status >= 500:
				level = slog.LevelError
			case logged.status >= 400:
				level = slog.LevelWarn
			}
			attrs := []slog.Attr{
				slog.String("request_id", id),
				slog.String("method", r.Method),
				slog.String("route", r.Pattern),
				slog.Int("status", logged.status),
				slog.Int64("duration_ms", time.Since(started).Milliseconds()),
			}
			if logged.code != "" {
				attrs = append(attrs, slog.String("error_code", logged.code))
			}
			if logged.errorType != "" {
				attrs = append(attrs, slog.String("error_type", logged.errorType))
			}
			if !completed {
				attrs = append(attrs, slog.Bool("aborted", true))
			}
			slog.LogAttrs(r.Context(), level, "http_request", attrs...)
		}()
		next.ServeHTTP(logged, r)
		completed = true
	}
}

func recordProblemCode(w http.ResponseWriter, code string) {
	if logged, ok := w.(*requestLogWriter); ok && problemCodePattern.MatchString(code) {
		logged.code = code
	}
}

func recordRequestError(w http.ResponseWriter, err error) {
	errorType := fmt.Sprintf("%T", err)
	if logged, ok := w.(*requestLogWriter); ok {
		logged.errorType = errorType
		return
	}
	slog.Error("request_failed", "error_type", errorType)
}

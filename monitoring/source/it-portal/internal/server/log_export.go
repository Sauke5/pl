package server

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path"
	"regexp"
	"slices"
	"strconv"
	"time"

	"pl/portal/internal/modules"
	"pl/portal/internal/store"
)

var logExportHours = [...]int{1, 6, 24, 72, 168}
var hostLogArchivePath = regexp.MustCompile(`^host/[a-zA-Z0-9._/-]{1,240}$`)

type logExportSource struct {
	Name   string `json:"name"`
	File   string `json:"file,omitempty"`
	Status string `json:"status"`
	Reason string `json:"reason,omitempty"`
	Rows   int    `json:"rows,omitempty"`
}

type logExportManifest struct {
	Schema     int               `json:"schema"`
	Since      time.Time         `json:"since"`
	Until      time.Time         `json:"until"`
	RequestID  string            `json:"request_id"`
	Partial    bool              `json:"partial"`
	RowLimit   int               `json:"platform_rows_per_source_limit"`
	BytesLimit int               `json:"platform_bytes_per_source_limit"`
	Sources    []logExportSource `json:"sources"`
}

func (s *Server) runtimeLogExport(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Hours int `json:"hours"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 256)
	if !decode(w, r, &input) {
		return
	}
	if !slices.Contains(logExportHours[:], input.Hours) {
		problem(w, 400, "log_export_period", "Выберите доступный период экспорта")
		return
	}
	if !s.logExportMu.TryLock() {
		w.Header().Set("Retry-After", "5")
		problem(w, 429, "log_export_busy", "Другой экспорт логов уже выполняется. Повторите запрос после его завершения.")
		return
	}
	defer s.logExportMu.Unlock()

	ctx, cancel := context.WithTimeout(r.Context(), 48*time.Second)
	defer cancel()
	// Docker and the host RPC accept whole seconds. Round up to keep records
	// from the second in which the administrator starts the export.
	until := time.Now().UTC().Truncate(time.Second).Add(time.Second)
	since := until.Add(-time.Duration(input.Hours) * time.Hour)
	manifest := logExportManifest{Schema: 1, Since: since, Until: until, RequestID: requestID(ctx),
		RowLimit: store.LogExportMaxRows, BytesLimit: store.LogExportMaxBytes}
	file, err := os.CreateTemp("", "pl-log-export-*.zip")
	if err != nil {
		s.fail(w, err)
		return
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if err = s.writeLogArchive(ctx, file, &manifest); err != nil {
		s.fail(w, err)
		return
	}
	size, err := file.Seek(0, io.SeekCurrent)
	if err == nil {
		_, err = file.Seek(0, io.SeekStart)
	}
	if err != nil {
		s.fail(w, err)
		return
	}
	if ctx.Err() != nil {
		problem(w, 504, "log_export_timeout", "Подготовка архива заняла слишком много времени. Выберите меньший период.")
		return
	}
	// The export may outlive a session that was valid when assembly began.
	sess, err := s.readSession(r.WithContext(ctx))
	if errors.Is(err, errADUnavailable) {
		problem(w, 503, "ad_unavailable", "Не удалось проверить доступ через AD. Повторите позднее.")
		return
	}
	if err != nil || !sess.User.Admin || sess.User.ID != current(r).User.ID {
		problem(w, 403, "log_export_session", "Для скачивания архива нужна действующая сессия администратора")
		return
	}
	err = s.Store.Event(ctx, "runtime.logs_exported", "Подготовлен архив логов", "", sess.User.ID,
		map[string]any{"request_id": manifest.RequestID, "since": since, "until": until, "bytes": size, "partial": manifest.Partial}, true)
	if err != nil {
		s.fail(w, err)
		return
	}

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="pl-diagnostics-`+until.Format("20060102T150405Z")+`.zip"`)
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	w.Header().Set("X-Accel-Buffering", "no")
	if manifest.Partial {
		w.Header().Set("X-PL-Log-Export-Partial", "true")
	}
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(time.Minute))
	if _, err = io.Copy(w, file); err != nil {
		slog.Warn("log_export_interrupted", "request_id", manifest.RequestID)
	}
}

func (s *Server) writeLogArchive(ctx context.Context, dst io.Writer, manifest *logExportManifest) error {
	archive := zip.NewWriter(dst)
	for _, channel := range []string{"events", "audit", "operations"} {
		var data bytes.Buffer
		sourceCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		rows, truncated, err := s.Store.ExportLog(sourceCtx, channel, manifest.Since, manifest.Until, &data)
		cancel()
		source := logExportSource{Name: channel, Status: "unavailable", Reason: "database_read_failed"}
		if err == nil {
			source = logExportSource{Name: channel, File: "platform/" + channel + ".ndjson", Status: "collected", Rows: rows}
			switch {
			case truncated:
				source.Status = "truncated"
				manifest.Partial = true
			case rows == 0:
				source.Status = "empty"
			}
			entry, err := archive.Create(source.File)
			if err != nil {
				return err
			}
			if _, err = data.WriteTo(entry); err != nil {
				return err
			}
		} else {
			manifest.Partial = true
		}
		manifest.Sources = append(manifest.Sources, source)
	}
	host, err := s.appendHostLogs(ctx, archive, manifest.Since, manifest.Until)
	if err != nil {
		return err
	}
	manifest.Sources = append(manifest.Sources, host)
	manifest.Partial = manifest.Partial || host.Status != "collected"
	entry, err := archive.Create("manifest.json")
	if err != nil {
		return err
	}
	encoder := json.NewEncoder(entry)
	encoder.SetIndent("", "  ")
	if err = encoder.Encode(manifest); err != nil {
		return err
	}
	return archive.Close()
}

func (s *Server) appendHostLogs(ctx context.Context, dst *zip.Writer, since, until time.Time) (logExportSource, error) {
	result := logExportSource{Name: "host", Status: "unavailable", Reason: "controller_unavailable"}
	file, err := os.CreateTemp("", "pl-host-logs-*.zip")
	if err != nil {
		return result, err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	size, err := s.Modules.CopyHostLogArchive(ctx, since, until, file)
	if errors.Is(err, modules.ErrHostLogExportBusy) {
		result.Reason = "controller_busy"
	}
	if err != nil {
		return result, nil
	}
	archive, partial, err := readHostLogArchive(file, size)
	if err != nil {
		result.Reason = "invalid_host_archive"
		return result, nil
	}
	for _, entry := range archive.File {
		if err = dst.Copy(entry); err != nil {
			return result, err
		}
	}
	result = logExportSource{Name: "host", File: "host/manifest.json", Status: "collected"}
	if partial {
		result.Status = "partial"
	}
	return result, nil
}

func readHostLogArchive(file io.ReaderAt, size int64) (*zip.Reader, bool, error) {
	invalid := errors.New("invalid host log archive")
	if size <= 0 || size > modules.MaxHostLogArchiveBytes {
		return nil, false, invalid
	}
	archive, err := zip.NewReader(file, size)
	if err != nil || len(archive.File) > 128 {
		return nil, false, invalid
	}
	seen := make(map[string]bool, len(archive.File))
	var manifest *zip.File
	var remaining uint64 = modules.MaxHostLogArchiveBytes
	for _, entry := range archive.File {
		name := entry.Name
		if !hostLogArchivePath.MatchString(name) || path.Clean(name) != name || seen[name] ||
			!entry.Mode().IsRegular() || entry.Flags&1 != 0 || (entry.Method != zip.Store && entry.Method != zip.Deflate) || entry.UncompressedSize64 > remaining {
			return nil, false, invalid
		}
		seen[name] = true
		remaining -= entry.UncompressedSize64
		if name == "host/manifest.json" {
			manifest = entry
		}
	}
	if manifest == nil || manifest.UncompressedSize64 > 128<<10 {
		return nil, false, invalid
	}
	stream, err := manifest.Open()
	if err != nil {
		return nil, false, invalid
	}
	defer stream.Close()
	data, err := io.ReadAll(io.LimitReader(stream, (128<<10)+1))
	var host struct {
		Partial *bool `json:"partial"`
	}
	if err != nil || len(data) > 128<<10 || json.Unmarshal(data, &host) != nil || host.Partial == nil {
		return nil, false, invalid
	}
	return archive, *host.Partial, nil
}

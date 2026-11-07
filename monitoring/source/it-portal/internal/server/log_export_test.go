package server

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/modules"
)

type logExportFixture struct {
	modules.Controller
	collect func(context.Context, time.Time, time.Time, io.Writer) (int64, error)
}

func (f logExportFixture) CopyHostLogArchive(ctx context.Context, since, until time.Time, dst io.Writer) (int64, error) {
	return f.collect(ctx, since, until, dst)
}

func diagnosticZip(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var out bytes.Buffer
	archive := zip.NewWriter(&out)
	for name, contents := range files {
		entry, err := archive.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = io.WriteString(entry, contents); err != nil {
			t.Fatal(err)
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func diagnosticZipContents(t *testing.T, data []byte) map[string]string {
	t.Helper()
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	out := make(map[string]string, len(archive.File))
	for _, entry := range archive.File {
		reader, err := entry.Open()
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(reader)
		_ = reader.Close()
		if err != nil {
			t.Fatal(err)
		}
		out[entry.Name] = string(data)
	}
	return out
}

func TestRuntimeLogExportAuthorizationWindowAndSources(t *testing.T) {
	s := apiFixture(t)
	s.Config.PortableRelease = true
	admin := apiUser(t, s, "export-admin", true)
	viewer := apiUser(t, s, "export-viewer", false)
	const route = "/api/v1/runtime/log-export"
	const sensitive = "fixture-secret-content"
	ctx := context.Background()
	for _, sample := range []struct {
		kind string
		at   time.Time
	}{
		{"problem.firing", time.Now().Add(-5 * time.Minute)},
		{"problem.old_fixture", time.Now().Add(-2 * time.Hour)},
	} {
		details := map[string]any{"occurred_at": sample.at.UTC(), "time_basis": "source", "source_kind": "alertmanager", "configuration": sensitive}
		if err := s.Store.Event(ctx, sample.kind, sensitive, "res-1", "system", details, false); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Store.Event(ctx, "settings.saved", sensitive, "global", "export-admin", map[string]any{"changes": sensitive}, true); err != nil {
		t.Fatal(err)
	}
	job, err := s.Store.Enqueue(ctx, model.Job{Kind: "check", Actor: "export-admin", IdempotencyKey: "fixture-job",
		Parameters: map[string]any{"kind": "icmp", "target": sensitive}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Store.Pool.Exec(ctx, `UPDATE jobs SET created_at=now()-interval '1 min',body=jsonb_set(body,'{result}',jsonb_build_object('raw_output',$2::text)) WHERE id=$1`, job.ID, sensitive); err != nil {
		t.Fatal(err)
	}
	// Put test audit records before the archive's second-precision upper bound.
	if _, err = s.Store.Pool.Exec(ctx, `UPDATE audit_events SET occurred_at=now()-interval '1 min' WHERE body->>'kind'='settings.saved'`); err != nil {
		t.Fatal(err)
	}
	var calls int
	host := diagnosticZip(t, map[string]string{"host/manifest.json": `{"partial":false}`, "host/docker/fixture.log": "fixture-api\n"})
	s.Modules = modules.New(s.Store, logExportFixture{collect: func(_ context.Context, since, until time.Time, dst io.Writer) (int64, error) {
		calls++
		if until.Sub(since) != time.Hour || until.Nanosecond() != 0 {
			t.Errorf("unexpected host export window %v %v", since, until)
		}
		n, err := dst.Write(host)
		return int64(n), err
	}})
	runtime := apiDecode[struct {
		Hours []int `json:"log_export_hours"`
	}](t, apiCall(s, admin, "GET", "/api/v1/runtime", nil, nil), 200)
	if len(runtime.Hours) != 5 || runtime.Hours[0] != 1 || runtime.Hours[4] != 168 {
		t.Fatalf("periods unavailable: %v", runtime.Hours)
	}
	valid := map[string]any{"hours": 1}
	for _, attempt := range []struct {
		who     apiIdentity
		headers map[string]string
		body    map[string]any
		code    int
	}{
		{apiIdentity{}, nil, valid, 401},
		{viewer, nil, valid, 403},
		{admin, map[string]string{"X-CSRF-Token": "wrong"}, valid, 403},
		{admin, nil, map[string]any{"hours": 169}, 400},
		{admin, nil, map[string]any{"hours": 1, "unit": "ssh.service"}, 400},
	} {
		if w := apiCall(s, attempt.who, "POST", route, attempt.body, attempt.headers); w.Code != attempt.code || calls != 0 {
			t.Fatalf("expected %d before collection, got %d (%d calls)", attempt.code, w.Code, calls)
		}
	}
	s.logExportMu.Lock()
	busy := apiCall(s, admin, "POST", route, valid, nil)
	s.logExportMu.Unlock()
	if busy.Code != 429 || calls != 0 {
		t.Fatalf("overlapping export admitted: %d (%d calls)", busy.Code, calls)
	}
	w := apiCall(s, admin, "POST", route, valid, nil)
	if w.Code != http.StatusOK || w.Header().Get("Content-Type") != "application/zip" || w.Header().Get("X-PL-Log-Export-Partial") != "" ||
		w.Header().Get("Cache-Control") != "no-store" || !strings.HasPrefix(w.Header().Get("Content-Disposition"), `attachment; filename="pl-diagnostics-`) || calls != 1 {
		t.Fatalf("wrong archive response %d %v (%d calls)", w.Code, w.Header(), calls)
	}
	files := diagnosticZipContents(t, w.Body.Bytes())
	if len(files) != 6 || files["host/docker/fixture.log"] != "fixture-api\n" ||
		!strings.Contains(files["platform/events.ndjson"], "problem.firing") || strings.Contains(files["platform/events.ndjson"], "problem.old_fixture") ||
		!strings.Contains(files["platform/operations.ndjson"], job.ID) || !strings.Contains(files["platform/audit.ndjson"], "settings.saved") {
		t.Fatalf("unexpected archive contents: %v", files)
	}
	for name, contents := range files {
		if strings.Contains(contents, sensitive) {
			t.Fatalf("private value exported in %s", name)
		}
	}
	var manifest logExportManifest
	if err = json.Unmarshal([]byte(files["manifest.json"]), &manifest); err != nil || manifest.Partial || manifest.RequestID != w.Header().Get("X-Request-ID") {
		t.Fatalf("invalid export manifest: %+v %v", manifest, err)
	}
	var auditID string
	if err = s.Store.Pool.QueryRow(ctx, `SELECT body#>>'{details,request_id}' FROM audit_events WHERE body->>'kind'='runtime.logs_exported' AND body->>'actor'='export-admin'`).Scan(&auditID); err != nil || auditID != manifest.RequestID {
		t.Fatalf("export audit was not persisted: %v", err)
	}
}

func TestRuntimeLogExportKeepsPlatformLogsWithUnavailableHost(t *testing.T) {
	s := apiFixture(t)
	s.Config.PortableRelease = true
	admin := apiUser(t, s, "partial-admin", true)
	for _, unsafe := range []bool{false, true} {
		if unsafe {
			archive := diagnosticZip(t, map[string]string{"host/manifest.json": `{"partial":false}`, "host/../outside.log": "bad"})
			s.Modules = modules.New(s.Store, logExportFixture{collect: func(_ context.Context, _, _ time.Time, dst io.Writer) (int64, error) {
				n, err := dst.Write(archive)
				return int64(n), err
			}})
		}
		w := apiCall(s, admin, "POST", "/api/v1/runtime/log-export", map[string]any{"hours": 6}, nil)
		if w.Code != http.StatusOK || w.Header().Get("X-PL-Log-Export-Partial") != "true" {
			t.Fatalf("missing partial response: %d %s", w.Code, w.Body)
		}
		files := diagnosticZipContents(t, w.Body.Bytes())
		if len(files) != 4 || !strings.Contains(files["manifest.json"], `"status": "unavailable"`) {
			t.Fatalf("unsafe host output or missing reason in archive: %v", files)
		}
	}
}

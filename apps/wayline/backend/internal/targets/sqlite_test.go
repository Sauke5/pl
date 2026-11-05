package targets

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
)

func TestOpenSQLiteMigratesExecutionProvenanceColumns(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`
		CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
		CREATE TABLE targets (
			id INTEGER PRIMARY KEY AUTOINCREMENT, enabled INTEGER NOT NULL DEFAULT 1,
			name TEXT NOT NULL COLLATE NOCASE UNIQUE, host TEXT NOT NULL, probe_mode TEXT NOT NULL,
			probe_port INTEGER NOT NULL DEFAULT 0, interval_seconds INTEGER NOT NULL, packet_count INTEGER NOT NULL,
			loss_threshold_percent INTEGER NOT NULL, iperf_enabled INTEGER NOT NULL, iperf_host TEXT NOT NULL DEFAULT '',
			iperf_port INTEGER NOT NULL DEFAULT 0, iperf_duration_seconds INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL, updated_at TEXT NOT NULL
		);
		CREATE TABLE check_runs (
			id INTEGER PRIMARY KEY AUTOINCREMENT, target_id INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
			kind TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT NOT NULL,
			duration_ms INTEGER NOT NULL, loss_percent REAL, avg_latency_ms REAL, jitter_ms REAL,
			throughput_bps REAL, error_message TEXT NOT NULL DEFAULT ''
		);
		INSERT INTO targets (id,enabled,name,host,probe_mode,probe_port,interval_seconds,packet_count,loss_threshold_percent,iperf_enabled,created_at,updated_at)
		VALUES (1,1,'legacy','10.0.0.1','icmp',0,60,5,2,0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
		INSERT INTO check_runs (id,target_id,kind,status,started_at,finished_at,duration_ms)
		VALUES (1,1,'path','success','2026-01-01T00:00:00Z','2026-01-01T00:00:01Z',1000);
	`)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	repository, err := OpenSQLite(path)
	if err != nil {
		t.Fatalf("OpenSQLite() migration error = %v", err)
	}
	defer repository.Close()
	for table, columns := range map[string][]string{"targets": {"execution_type", "execution_id"}, "check_runs": {"execution_type", "execution_id", "direction"}} {
		for _, column := range columns {
			exists, err := columnExists(context.Background(), repository.DB(), table, column)
			if err != nil || !exists {
				t.Fatalf("column %s.%s exists=%v error=%v", table, column, exists, err)
			}
		}
	}
	var historyCount int
	if err := repository.DB().QueryRow("SELECT COUNT(*) FROM check_runs WHERE target_id = 1").Scan(&historyCount); err != nil || historyCount != 1 {
		t.Fatalf("history after targets rebuild = %d, error=%v", historyCount, err)
	}
	var direction string
	if err := repository.DB().QueryRow("SELECT direction FROM check_runs WHERE id = 1").Scan(&direction); err != nil || direction != "" {
		t.Fatalf("legacy direction = %q, error=%v", direction, err)
	}
	var migrationCount int
	if err := repository.DB().QueryRow("SELECT COUNT(*) FROM schema_migrations WHERE version = 4").Scan(&migrationCount); err != nil || migrationCount != 1 {
		t.Fatalf("direction migration count = %d, error=%v", migrationCount, err)
	}
}

func TestSQLiteRepositoryCRUDAndPersistence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "data", "wayline.db")
	repository, err := OpenSQLite(path)
	if err != nil {
		t.Fatalf("OpenSQLite() error = %v", err)
	}
	service := NewService(repository)
	ctx := context.Background()

	created, err := service.Create(ctx, validInput())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if created.ID < 1 || created.CreatedAt.IsZero() || created.UpdatedAt.IsZero() {
		t.Fatalf("created target has incomplete metadata: %#v", created)
	}

	items, err := service.List(ctx)
	if err != nil || len(items) != 1 || items[0].ID != created.ID {
		t.Fatalf("List() = %#v, %v", items, err)
	}

	updatedInput := validInput()
	updatedInput.Name = "SERVER-B"
	updatedInput.Host = "10.20.30.40"
	updatedInput.IperfHost = "10.20.30.40"
	stopped := false
	updatedInput.Enabled = &stopped
	updated, err := service.Update(ctx, created.ID, updatedInput)
	if err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	if updated.Name != updatedInput.Name || updated.Host != updatedInput.Host || updated.Enabled {
		t.Fatalf("updated target = %#v", updated)
	}

	if err := repository.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	repository, err = OpenSQLite(path)
	if err != nil {
		t.Fatalf("reopen SQLite error = %v", err)
	}
	defer repository.Close()
	service = NewService(repository)
	persisted, err := service.Get(ctx, created.ID)
	if err != nil || persisted.Name != updatedInput.Name {
		t.Fatalf("persisted target = %#v, %v", persisted, err)
	}

	if err := service.Delete(ctx, created.ID); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	if _, err := service.Get(ctx, created.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get() after delete error = %v, want ErrNotFound", err)
	}
}

func TestSQLiteRepositoryRejectsDuplicateNameIgnoringCase(t *testing.T) {
	repository, err := OpenSQLite(filepath.Join(t.TempDir(), "wayline.db"))
	if err != nil {
		t.Fatalf("OpenSQLite() error = %v", err)
	}
	defer repository.Close()
	service := NewService(repository)
	ctx := context.Background()

	if _, err := service.Create(ctx, validInput()); err != nil {
		t.Fatalf("first Create() error = %v", err)
	}
	duplicate := validInput()
	duplicate.Name = "server-a"
	if _, err := service.Create(ctx, duplicate); !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate Create() error = %v, want ErrConflict", err)
	}
}

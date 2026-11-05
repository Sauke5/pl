package targets

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

const schema = `
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
	 enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    host TEXT NOT NULL,
	 probe_mode TEXT NOT NULL CHECK (probe_mode IN ('mtr', 'icmp', 'tcp')),
	 probe_port INTEGER NOT NULL DEFAULT 0,
	 execution_type TEXT NOT NULL DEFAULT 'local' CHECK (execution_type IN ('local')),
	 execution_id TEXT NOT NULL DEFAULT '',
    interval_seconds INTEGER NOT NULL,
    packet_count INTEGER NOT NULL,
	loss_threshold_percent REAL NOT NULL,
    iperf_enabled INTEGER NOT NULL CHECK (iperf_enabled IN (0, 1)),
    iperf_host TEXT NOT NULL DEFAULT '',
    iperf_port INTEGER NOT NULL DEFAULT 0,
    iperf_duration_seconds INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
`

type SQLiteRepository struct {
	db *sql.DB
}

func OpenSQLite(path string) (*SQLiteRepository, error) {
	if path == "" {
		return nil, errors.New("путь к базе Wayline не задан")
	}
	if path != ":memory:" {
		directory := filepath.Dir(path)
		if directory != "." {
			if err := os.MkdirAll(directory, 0o750); err != nil {
				return nil, fmt.Errorf("создать каталог базы Wayline: %w", err)
			}
		}
	}

	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("открыть базу Wayline: %w", err)
	}
	db.SetMaxOpenConns(1)

	repository := &SQLiteRepository{db: db}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := repository.initialize(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return repository, nil
}

func (r *SQLiteRepository) initialize(ctx context.Context) error {
	for _, pragma := range []string{
		"PRAGMA foreign_keys = ON",
		"PRAGMA journal_mode = WAL",
		"PRAGMA busy_timeout = 5000",
	} {
		if _, err := r.db.ExecContext(ctx, pragma); err != nil {
			return fmt.Errorf("настроить SQLite: %w", err)
		}
	}
	if _, err := r.db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("применить миграцию SQLite: %w", err)
	}
	if err := r.migrateLossThresholdToReal(ctx); err != nil {
		return err
	}
	if err := r.ensureExecutionColumns(ctx); err != nil {
		return err
	}
	if _, err := r.db.ExecContext(ctx, checkHistorySchema); err != nil {
		return fmt.Errorf("применить миграцию истории проверок: %w", err)
	}
	if err := r.ensureCheckExecutionColumns(ctx); err != nil {
		return err
	}
	if err := r.ensureCheckDirectionColumn(ctx); err != nil {
		return err
	}
	if _, err := r.db.ExecContext(ctx, `INSERT OR IGNORE INTO schema_migrations(version, applied_at)
		VALUES (3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`); err != nil {
		return fmt.Errorf("записать версию миграции исполнения: %w", err)
	}
	if _, err := r.db.ExecContext(ctx, `INSERT OR IGNORE INTO schema_migrations(version, applied_at)
		VALUES (4, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`); err != nil {
		return fmt.Errorf("записать версию миграции направления iperf3: %w", err)
	}
	return nil
}

func (r *SQLiteRepository) ensureCheckDirectionColumn(ctx context.Context) error {
	exists, err := columnExists(ctx, r.db, "check_runs", "direction")
	if err != nil {
		return err
	}
	if exists {
		return nil
	}
	if _, err := r.db.ExecContext(ctx, `ALTER TABLE check_runs ADD COLUMN direction TEXT NOT NULL DEFAULT '' CHECK (direction IN ('', 'download', 'upload'))`); err != nil {
		return fmt.Errorf("добавить направление проверки iperf3: %w", err)
	}
	return nil
}

func (r *SQLiteRepository) ensureExecutionColumns(ctx context.Context) error {
	for _, column := range []struct{ name, definition string }{
		{"execution_type", `execution_type TEXT NOT NULL DEFAULT 'local' CHECK (execution_type IN ('local'))`},
		{"execution_id", `execution_id TEXT NOT NULL DEFAULT ''`},
	} {
		exists, err := columnExists(ctx, r.db, "targets", column.name)
		if err != nil {
			return err
		}
		if !exists {
			if _, err := r.db.ExecContext(ctx, "ALTER TABLE targets ADD COLUMN "+column.definition); err != nil {
				return fmt.Errorf("добавить поле исполнения цели %s: %w", column.name, err)
			}
		}
	}
	return nil
}

func (r *SQLiteRepository) ensureCheckExecutionColumns(ctx context.Context) error {
	for _, column := range []struct{ name, definition string }{
		{"execution_type", `execution_type TEXT NOT NULL DEFAULT 'local'`},
		{"execution_id", `execution_id TEXT`},
	} {
		exists, err := columnExists(ctx, r.db, "check_runs", column.name)
		if err != nil {
			return err
		}
		if !exists {
			if _, err := r.db.ExecContext(ctx, "ALTER TABLE check_runs ADD COLUMN "+column.definition); err != nil {
				return fmt.Errorf("добавить provenance проверки %s: %w", column.name, err)
			}
		}
	}
	return nil
}

func columnExists(ctx context.Context, db *sql.DB, table, column string) (bool, error) {
	rows, err := db.QueryContext(ctx, "PRAGMA table_info("+table+")")
	if err != nil {
		return false, fmt.Errorf("прочитать схему %s: %w", table, err)
	}
	defer rows.Close()
	for rows.Next() {
		var cid, notNull, primaryKey int
		var name, dataType string
		var defaultValue any
		if err := rows.Scan(&cid, &name, &dataType, &notNull, &defaultValue, &primaryKey); err != nil {
			return false, err
		}
		if name == column {
			return true, nil
		}
	}
	return false, rows.Err()
}

func (r *SQLiteRepository) Close() error { return r.db.Close() }

func (r *SQLiteRepository) Ping(ctx context.Context) error { return r.db.PingContext(ctx) }

// DB предоставляет общий пул внутренним репозиториям Wayline. Внешний код не
// должен закрывать его: жизненным циклом соединения владеет SQLiteRepository.
func (r *SQLiteRepository) DB() *sql.DB { return r.db }

const checkHistorySchema = `
CREATE TABLE IF NOT EXISTS check_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('path', 'iperf')),
	 direction TEXT NOT NULL DEFAULT '' CHECK (direction IN ('', 'download', 'upload')),
	 execution_type TEXT NOT NULL DEFAULT 'local',
	 execution_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('success', 'degraded', 'failed')),
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
    loss_percent REAL,
    avg_latency_ms REAL,
    jitter_ms REAL,
    throughput_bps REAL,
    error_message TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_check_runs_target_started
    ON check_runs(target_id, started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_check_runs_target_kind_finished
    ON check_runs(target_id, kind, finished_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_check_runs_kind_status
    ON check_runs(kind, status);

CREATE TABLE IF NOT EXISTS hop_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    check_run_id INTEGER NOT NULL REFERENCES check_runs(id) ON DELETE CASCADE,
    hop_number INTEGER NOT NULL CHECK (hop_number > 0),
    host TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT '',
    loss_percent REAL,
    packets_sent INTEGER,
    last_ms REAL,
    avg_ms REAL,
    best_ms REAL,
    worst_ms REAL,
    stddev_ms REAL,
    UNIQUE(check_run_id, hop_number)
);

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
`

func (r *SQLiteRepository) migrateLossThresholdToReal(ctx context.Context) error {
	rows, err := r.db.QueryContext(ctx, "PRAGMA table_info(targets)")
	if err != nil {
		return fmt.Errorf("прочитать схему целей: %w", err)
	}
	defer rows.Close()

	columnType := ""
	for rows.Next() {
		var cid, notNull, primaryKey int
		var name, dataType string
		var defaultValue any
		if err := rows.Scan(&cid, &name, &dataType, &notNull, &defaultValue, &primaryKey); err != nil {
			return fmt.Errorf("прочитать столбец схемы целей: %w", err)
		}
		if name == "loss_threshold_percent" {
			columnType = strings.ToUpper(dataType)
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("прочитать схему целей: %w", err)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("закрыть чтение схемы целей: %w", err)
	}
	if columnType == "REAL" {
		return nil
	}
	if columnType == "" {
		return errors.New("в схеме targets отсутствует loss_threshold_percent")
	}

	if _, err := r.db.ExecContext(ctx, "PRAGMA foreign_keys = OFF"); err != nil {
		return fmt.Errorf("приостановить проверку внешних ключей: %w", err)
	}
	if _, err := r.db.ExecContext(ctx, "PRAGMA legacy_alter_table = ON"); err != nil {
		_, _ = r.db.ExecContext(context.Background(), "PRAGMA foreign_keys = ON")
		return fmt.Errorf("защитить ссылки при миграции targets: %w", err)
	}
	defer func() {
		_, _ = r.db.ExecContext(context.Background(), "PRAGMA legacy_alter_table = OFF")
		_, _ = r.db.ExecContext(context.Background(), "PRAGMA foreign_keys = ON")
	}()
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("начать исправление типа порога потерь: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	statements := []string{
		`ALTER TABLE targets RENAME TO targets_v1`,
		`CREATE TABLE targets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
            name TEXT NOT NULL COLLATE NOCASE UNIQUE,
            host TEXT NOT NULL,
            probe_mode TEXT NOT NULL CHECK (probe_mode IN ('mtr', 'icmp', 'tcp')),
            probe_port INTEGER NOT NULL DEFAULT 0,
			execution_type TEXT NOT NULL DEFAULT 'local' CHECK (execution_type IN ('local')),
			execution_id TEXT NOT NULL DEFAULT '',
            interval_seconds INTEGER NOT NULL,
            packet_count INTEGER NOT NULL,
            loss_threshold_percent REAL NOT NULL,
            iperf_enabled INTEGER NOT NULL CHECK (iperf_enabled IN (0, 1)),
            iperf_host TEXT NOT NULL DEFAULT '',
            iperf_port INTEGER NOT NULL DEFAULT 0,
            iperf_duration_seconds INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )`,
		`INSERT INTO targets (id, enabled, name, host, probe_mode, probe_port, execution_type, execution_id,
			interval_seconds, packet_count, loss_threshold_percent, iperf_enabled, iperf_host, iperf_port,
			iperf_duration_seconds, created_at, updated_at)
			SELECT id, enabled, name, host, probe_mode, probe_port, 'local', '',
            interval_seconds, packet_count, CAST(loss_threshold_percent AS REAL),
            iperf_enabled, iperf_host, iperf_port, iperf_duration_seconds,
            created_at, updated_at FROM targets_v1`,
		`DROP TABLE targets_v1`,
	}
	for _, statement := range statements {
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("исправить тип порога потерь: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("завершить исправление типа порога потерь: %w", err)
	}
	if _, err := r.db.ExecContext(ctx, "PRAGMA legacy_alter_table = OFF"); err != nil {
		return fmt.Errorf("завершить защиту ссылок: %w", err)
	}
	if _, err := r.db.ExecContext(ctx, "PRAGMA foreign_keys = ON"); err != nil {
		return fmt.Errorf("включить проверку внешних ключей: %w", err)
	}
	checkRows, err := r.db.QueryContext(ctx, "PRAGMA foreign_key_check")
	if err != nil {
		return fmt.Errorf("проверить внешние ключи после миграции: %w", err)
	}
	defer checkRows.Close()
	if checkRows.Next() {
		return errors.New("после миграции targets нарушена целостность внешних ключей")
	}
	return nil
}

func (r *SQLiteRepository) Create(ctx context.Context, input Input) (Target, error) {
	now := time.Now().UTC().Truncate(time.Microsecond)
	result, err := r.db.ExecContext(ctx, `
INSERT INTO targets (
	 enabled, name, host, probe_mode, probe_port, execution_type, execution_id, interval_seconds, packet_count, loss_threshold_percent,
    iperf_enabled, iperf_host, iperf_port, iperf_duration_seconds, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		*input.Enabled, input.Name, input.Host, input.ProbeMode, input.ProbePort, input.ExecutionType, input.ExecutionID, input.IntervalSeconds, input.PacketCount,
		input.LossThresholdPercent, input.IperfEnabled, input.IperfHost, input.IperfPort,
		input.IperfDurationSeconds, now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano),
	)
	if err != nil {
		return Target{}, mapSQLiteError(err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		return Target{}, fmt.Errorf("получить идентификатор цели: %w", err)
	}
	return r.Get(ctx, id)
}

func (r *SQLiteRepository) List(ctx context.Context) ([]Target, error) {
	rows, err := r.db.QueryContext(ctx, selectTargets+" ORDER BY name COLLATE NOCASE, id")
	if err != nil {
		return nil, fmt.Errorf("получить список целей: %w", err)
	}
	defer rows.Close()

	result := make([]Target, 0)
	for rows.Next() {
		target, err := scanTarget(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, target)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("прочитать список целей: %w", err)
	}
	return result, nil
}

func (r *SQLiteRepository) Get(ctx context.Context, id int64) (Target, error) {
	target, err := scanTarget(r.db.QueryRowContext(ctx, selectTargets+" WHERE id = ?", id))
	if errors.Is(err, sql.ErrNoRows) {
		return Target{}, ErrNotFound
	}
	return target, err
}

func (r *SQLiteRepository) Update(ctx context.Context, id int64, input Input) (Target, error) {
	now := time.Now().UTC().Truncate(time.Microsecond)
	result, err := r.db.ExecContext(ctx, `
UPDATE targets SET
	 enabled = ?, name = ?, host = ?, probe_mode = ?, probe_port = ?, execution_type = ?, execution_id = ?, interval_seconds = ?, packet_count = ?,
    loss_threshold_percent = ?, iperf_enabled = ?, iperf_host = ?, iperf_port = ?,
    iperf_duration_seconds = ?, updated_at = ?
WHERE id = ?`, *input.Enabled, input.Name, input.Host, input.ProbeMode, input.ProbePort, input.ExecutionType, input.ExecutionID, input.IntervalSeconds,
		input.PacketCount, input.LossThresholdPercent, input.IperfEnabled, input.IperfHost,
		input.IperfPort, input.IperfDurationSeconds, now.Format(time.RFC3339Nano), id)
	if err != nil {
		return Target{}, mapSQLiteError(err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return Target{}, fmt.Errorf("проверить обновление цели: %w", err)
	}
	if affected == 0 {
		return Target{}, ErrNotFound
	}
	return r.Get(ctx, id)
}

func (r *SQLiteRepository) Delete(ctx context.Context, id int64) error {
	result, err := r.db.ExecContext(ctx, "DELETE FROM targets WHERE id = ?", id)
	if err != nil {
		return fmt.Errorf("удалить цель: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("проверить удаление цели: %w", err)
	}
	if affected == 0 {
		return ErrNotFound
	}
	return nil
}

const selectTargets = `SELECT
	 id, enabled, name, host, probe_mode, probe_port, execution_type, execution_id, interval_seconds, packet_count, loss_threshold_percent,
    iperf_enabled, iperf_host, iperf_port, iperf_duration_seconds, created_at, updated_at
FROM targets`

type scanner interface {
	Scan(...any) error
}

func scanTarget(row scanner) (Target, error) {
	var target Target
	var createdAt, updatedAt string
	if err := row.Scan(
		&target.ID, &target.Enabled, &target.Name, &target.Host, &target.ProbeMode, &target.ProbePort, &target.ExecutionType, &target.ExecutionID, &target.IntervalSeconds,
		&target.PacketCount, &target.LossThresholdPercent, &target.IperfEnabled,
		&target.IperfHost, &target.IperfPort, &target.IperfDurationSeconds, &createdAt, &updatedAt,
	); err != nil {
		return Target{}, err
	}
	var err error
	target.CreatedAt, err = time.Parse(time.RFC3339Nano, createdAt)
	if err != nil {
		return Target{}, fmt.Errorf("прочитать время создания цели: %w", err)
	}
	target.UpdatedAt, err = time.Parse(time.RFC3339Nano, updatedAt)
	if err != nil {
		return Target{}, fmt.Errorf("прочитать время изменения цели: %w", err)
	}
	return target, nil
}

func mapSQLiteError(err error) error {
	if err != nil && (strings.Contains(err.Error(), "UNIQUE constraint failed: targets.name") || strings.Contains(err.Error(), "constraint failed: UNIQUE")) {
		return ErrConflict
	}
	return fmt.Errorf("сохранить цель: %w", err)
}
